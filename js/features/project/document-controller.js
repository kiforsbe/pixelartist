import * as io from '../../platform/browser/project-io.js';
import { decodePng } from '../../core/pngcodec.js';
import { createSheet, createMap, removeSheet, sheetLayers } from '../../core/model.js';
import { snapProjectPixels } from '../../core/project-pixel-snapper.js';
import { commitFloatIfAny, cutSelection, copySelection, paste, hasSelection, discardFloatingForSheet } from '../../components/canvas/float-session.js';
import { defineAction, runAction, bindAction } from '../shell/actions.js';
import { markDefaultAction } from '../../components/dialogs.js';
import { isTextEntryTarget } from '../../components/dom-utils.js';
import { PROJECT_SCOPE } from '../../host/history-service.js';
import { activeSheet, activeMap } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';

export function mountDocumentController({ editorHost, workbench }) {
  function isCancel(e) {
    return e?.name === 'AbortError' || e?.message === 'cancelled';
  }
  function sheetDocument(sheet) {
    return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
  }
  function seedSheetSelection(sheet, layerId) {
    if (!sheet) return;
    editorHost.selections.set(sheet.kind === 'sprite' ? { layerId, frameId: null, animationId: null } : { layerId }, sheetDocument(sheet));
  }

  // ---- element refs ----
  const tabSprites = document.getElementById('tab-sprites');
  const tabTiles = document.getElementById('tab-tiles');
  const tabMaps = document.getElementById('tab-maps');
  
  const sheetSelect = document.getElementById('sheet-select');
  const btnNewSheet = document.getElementById('btn-new-sheet');
  const btnImportSheet = document.getElementById('btn-import-sheet');
  const dlgNewSheet = document.getElementById('dlg-newsheet');
  const nsName = document.getElementById('ns-name');
  const nsW = document.getElementById('ns-w');
  const nsH = document.getElementById('ns-h');
  const nsCreate = document.getElementById('ns-create');
  const nsCancel = document.getElementById('ns-cancel');
  markDefaultAction(dlgNewSheet, nsCreate);
  
  // ---- mode tabs ----
  // `previousMode` is only meaningful on the fromHost re-entry path: by the
  // time EditorHost.activateMode() fires onDidChangeMode, session.
  // activeModeId already holds the NEW mode (editor-host.js sets it before
  // notifying listeners), so re-reading the store here would always see
  // previousMode === mode and early-return -- permanently skipping tab
  // highlighting, seedSheetSelection, and focusMap()/fitSheet() on every
  // mode switch. The event carries its own previousModeId for exactly this
  // reason; the fromHost caller below passes it through as previousMode.
  function switchMode(mode, { fromHost = false, previousMode: previousModeArg } = {}) {
    if (!fromHost && editorHost && editorHost.activeModeId !== mode) {
      editorHost.activateMode(mode);
      return;
    }
    const previousMode = fromHost ? previousModeArg : editorHost.store.getState().session.activeModeId;
    if (previousMode === mode) return;
    tabSprites.classList.toggle('active', mode === 'sprites');
    tabTiles.classList.toggle('active', mode === 'tiles');
    tabMaps.classList.toggle('active', mode === 'maps');
    if (mode === 'maps') {
      // EditorHost has already resolved the remembered document (or fallback)
      // through DocumentService before this mode-change notification.
      editorHost.store.updateSession({ activeViewId: 'maps.canvas' }, 'view');
      const tool = editorHost.store.getState().session.activeToolId;
      if (!['select', 'move', 'maptile', 'mapsprite'].includes(tool)) editorHost.store.updateSession({ activeToolId: 'select' }, 'tool');
      workbench.focusMap();
      return;
    }
    // DocumentService also seeds missing per-document selections. Re-seeding
    // here would discard a remembered frame/tile/layer selection on return.
    editorHost.store.updateSession({ activeViewId: `${mode}.sheet` }, 'view');
    // frame/tile tools are mode-exclusive (their palette buttons hide via
    // isAvailable()); fall back to pencil so leaving their mode doesn't strand
    // pointer routing on a tool with nothing to dispatch to.
    const tool = editorHost.store.getState().session.activeToolId;
    if (mode !== 'sprites' && tool === 'frametool') editorHost.store.updateSession({ activeToolId: 'pencil' }, 'tool');
    if (mode !== 'tiles' && tool === 'tiletool') editorHost.store.updateSession({ activeToolId: 'pencil' }, 'tool');
    if (mode !== 'maps' && ['maptile', 'mapsprite'].includes(tool)) editorHost.store.updateSession({ activeToolId: 'pencil' }, 'tool');
    // Maps uses a deliberately distant, centred infinite-workspace camera.
    // Returning to a finite sheet must recenter it; otherwise the sheet is
    // still rendered but entirely outside the viewport (as in the reported
    // blank Tile Sheets canvas).
    if (previousMode === 'maps') workbench.fitSheet();
  }
  editorHost?.onDidChangeMode(({ modeId, previousModeId }) => switchMode(modeId, { fromHost: true, previousMode: previousModeId }));
  tabSprites.addEventListener('click', () => switchMode('sprites'));
  tabTiles.addEventListener('click', () => switchMode('tiles'));
  tabMaps.addEventListener('click', () => switchMode('maps'));
  
  // ---- sheet selector ----
  function refreshSheetSelect() {
    const mode = editorHost.store.getState().session.activeModeId;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    if (mode === 'maps') {
      const maps = editorHost.projects.project?.maps ?? [];
      sheetSelect.innerHTML = '';
      for (const m of maps) { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.name; sheetSelect.appendChild(opt); }
      sheetSelect.value = activeDoc?.kind === 'map' ? activeDoc.id : '';
      return;
    }
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheets = editorHost.projects.project?.sheets.filter(s => s.kind === kind) ?? [];
    sheetSelect.innerHTML = '';
    for (const s of sheets) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sheetSelect.appendChild(opt);
    }
    sheetSelect.value = activeDoc ? activeDoc.id : '';
  }
  editorHost.store.subscribe(
    state => [state.project.model, state.session.activeModeId, state.session.activeDocument],
    () => refreshSheetSelect(),
    // activeDocument compared by {kind,id}, not reference: DocumentService
    // resolve()/setActive() allocate a fresh object every call (see the
    // matching fix/comment in file-controller.js's host->legacy mirror).
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2]?.id === b[2]?.id && a[2]?.kind === b[2]?.kind, fireImmediately: true },
  );

  sheetSelect.addEventListener('change', () => {
    const mode = editorHost.store.getState().session.activeModeId;
    if (mode === 'maps') {
      const map = editorHost.projects.project?.maps?.find(m => m.id === sheetSelect.value);
      if (!map) return;
      editorHost.documents.setActive({ kind: 'map', id: map.id }, { modeId: mode });
      workbench.focusMap();
      return;
    }
    const sheet = editorHost.projects.project?.sheets.find(s => s.id === sheetSelect.value);
    if (!sheet) return;
    editorHost.documents.setActive(sheetDocument(sheet), { modeId: mode });
    // setActive seeds a new document's own selection and retains an existing one.
  });
  
  // ---- add-sheet command (shared by New Sheet dialog + Import) ----
  // Eager-mutate-then-snapshot idiom (see tilemode.js commitSwapTile): the caller
  // has already created `sheet` via createSheet, which pushes it into
  // project.sheets, so capture prior selection + insertion index here, then push
  // a command whose do()/undo() replay that structural change idempotently for
  // redo/undo.
  function selectCreationDocument(reference, modeId) {
    if (editorHost.activeModeId === modeId) {
      editorHost.documents.setActive(reference, { modeId, allowMissing: true });
    } else {
      // Global history can run while another mode owns the active surface.
      const remembered = editorHost.store.getState().session.activeDocumentByMode;
      editorHost.store.updateSession({ activeDocumentByMode: { ...remembered, [modeId]: reference } }, 'document');
    }
  }

  function commitAddSheet(sheet) {
    const project = editorHost.projects.project;
    const prevDoc = editorHost.store.getState().session.activeDocument;
    const prevSelection = prevDoc ? { ...editorHost.selections.get(prevDoc) } : null;
    const insertIndex = project.sheets.indexOf(sheet);
    const mode = editorHost.store.getState().session.activeModeId;
    const cmd = {
      label: 'new sheet',
      do() {
        if (!project.sheets.includes(sheet)) project.sheets.splice(insertIndex, 0, sheet);
        selectCreationDocument(sheetDocument(sheet), mode);
        seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
      },
      undo() {
        const i = project.sheets.indexOf(sheet);
        if (i !== -1) project.sheets.splice(i, 1);
        selectCreationDocument(prevDoc, mode);
        if (prevDoc) editorHost.selections.set(prevSelection, prevDoc);
      },
    };
    // Creating/renaming/deleting a document is project-level: it changes
    // WHICH documents exist, so it must stay undoable from whichever one is
    // active afterwards (creating a sheet activates it, deleting one moves
    // you to a sibling).
    editorHost.history.execute(cmd, { scope: PROJECT_SCOPE });
    editorHost.projects.markDirty();
  }

  function commitAddMap(map) {
    const project = editorHost.projects.project;
    const previousDocument = editorHost.store.getState().session.activeDocument;
    const previousSelection = previousDocument ? { ...editorHost.selections.get(previousDocument) } : null;
    const index = project.maps.indexOf(map);
    editorHost.history.execute({
      label: 'new map',
      do() {
        if (!project.maps.includes(map)) project.maps.splice(index, 0, map);
        selectCreationDocument({ kind: 'map', id: map.id }, 'maps');
      },
      undo() {
        const current = project.maps.indexOf(map);
        if (current !== -1) project.maps.splice(current, 1);
        selectCreationDocument(previousDocument, 'maps');
        if (previousDocument) editorHost.selections.set(previousSelection, previousDocument);
      },
    }, { scope: PROJECT_SCOPE });
  }
  
  // ---- new sheet dialog ----
  defineAction('document.newSheet', {
    label: 'New Sheet',
    run: () => {
      const project = editorHost.projects.project;
      if (!project) return;
      const mode = editorHost.store.getState().session.activeModeId;
      if (mode === 'maps') {
        const map = createMap(project, { name: `Map ${project.maps.length}`, gridW: project.settings.tileW, gridH: project.settings.tileH });
        commitAddMap(map);
        return;
      }
      const kind = mode === 'sprites' ? 'sprite' : 'tile';
      const settings = project.settings;
      const n = project.sheets.filter(s => s.kind === kind).length + 1;
      nsName.value = `sheet_${n}`;
      nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
      nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
      dlgNewSheet.showModal();
    },
    isEnabled: () => !!editorHost.projects.project,
  });
  bindAction(btnNewSheet, 'document.newSheet');
  nsCancel.addEventListener('click', () => dlgNewSheet.close());
  nsCreate.addEventListener('click', () => {
    const project = editorHost.projects.project;
    if (!project) return;
    const mode = editorHost.store.getState().session.activeModeId;
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheetDim = (el) => {
      const v = parseInt(el.value, 10);
      return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
    };
    const width = sheetDim(nsW);
    const height = sheetDim(nsH);
    if (width == null || height == null) {
      alert('Please enter valid positive numbers for all fields.');
      return;
    }
    const name = nsName.value.trim() || `sheet_${project.sheets.filter(s => s.kind === kind).length + 1}`;
  
    const sheet = createSheet(project, { name, width, height, kind });
    commitAddSheet(sheet);
    dlgNewSheet.close();
  });
  
  // ---- import sheet from image ----
  defineAction('document.importSheet', {
    label: 'Import Sheet from Image',
    run: async () => {
      const mode = editorHost.store.getState().session.activeModeId;
      if (!editorHost.projects.project || mode === 'maps') return;
      let file;
      try {
        file = await io.pickImageFile();
      } catch (e) {
        if (isCancel(e)) return;
        alert(`Import failed: ${e.message}`);
        return;
      }
      let bitmap;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        bitmap = await decodePng(bytes);
      } catch (e) {
        alert(`Import failed: ${e.message}`);
        return;
      }
      if (bitmap.width > 4096 || bitmap.height > 4096) {
        alert('Image is too large (max 4096×4096).');
        return;
      }
      const project = editorHost.projects.project;
      bitmap = snapProjectPixels(project, bitmap);
      const kind = mode === 'sprites' ? 'sprite' : 'tile';
      const name = file.name.replace(/\.[^.]+$/, '') || 'imported';
      const sheet = createSheet(project, {
        name, width: bitmap.width, height: bitmap.height, kind,
      });
      sheetLayers(sheet)[0].bitmap = bitmap;
      commitAddSheet(sheet);
    },
    isEnabled: () => !!editorHost.projects.project && editorHost.store.getState().session.activeModeId !== 'maps',
  });
  bindAction(btnImportSheet, 'document.importSheet');
  
  // ---- rename sheet ----
  const btnRenameSheet = document.getElementById('btn-rename-sheet');
  const dlgRenameSheet = document.getElementById('dlg-renamesheet');
  const rsName = document.getElementById('rs-name');
  const rsOk = document.getElementById('rs-ok');
  const rsCancel = document.getElementById('rs-cancel');
  const rsHeading = dlgRenameSheet.querySelector('h3');
  let renameTarget = null, renameTargetKind = 'sheet';
  markDefaultAction(dlgRenameSheet, rsOk);
  defineAction('document.renameSheet', {
    label: 'Rename',
    run: () => {
      renameTargetKind = editorHost.store.getState().session.activeModeId === 'maps' ? 'map' : 'sheet';
      renameTarget = renameTargetKind === 'map' ? activeMap() : activeSheet();
      if (!renameTarget) return;
      rsHeading.textContent = renameTargetKind === 'map' ? 'Rename Map' : 'Rename Sheet';
      rsName.value = renameTarget.name;
      dlgRenameSheet.showModal();
    },
    isEnabled: () => editorHost.store.getState().session.activeModeId === 'maps' ? !!activeMap() : !!activeSheet(),
  });
  bindAction(btnRenameSheet, 'document.renameSheet');
  rsCancel.addEventListener('click', () => { renameTarget = null; dlgRenameSheet.close(); });
  dlgRenameSheet.addEventListener('close', () => { renameTarget = null; });
  rsOk.addEventListener('click', () => {
    const target = renameTarget;
    if (!target) { dlgRenameSheet.close(); return; }
    const v = rsName.value.trim();
    if (!v) { alert('Name cannot be empty.'); return; }
    const old = target.name, kind = renameTargetKind;
    editorHost.history.execute({
      label: `rename ${kind}`,
      do() { target.name = v; editorHost.projects.markDirty(); refreshSheetSelect(); },
      undo() { target.name = old; editorHost.projects.markDirty(); refreshSheetSelect(); },
    }, { scope: PROJECT_SCOPE });
    renameTarget = null;
    dlgRenameSheet.close();
  });
  
  // ---- delete sheet ----
  // A sheet owns its layerTree/frames/animations/tiles/terrainSets inline (see
  // removeSheet's comment in core/model.js), so the only other cleanup is app
  // state that points at the sheet being removed: active sheet/layer,
  // per-sheet selections, any open frame/tile editor, and an in-progress
  // floating selection.
  const btnDeleteSheet = document.getElementById('btn-delete-sheet');
  function commitDeleteMap(map) {
    const project = editorHost.projects.project, index = project.maps.indexOf(map);
    if (index === -1) return;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    const wasActive = activeDoc?.kind === 'map' && activeDoc.id === map.id;
    const mode = editorHost.store.getState().session.activeModeId;
    editorHost.history.execute({
      label: 'delete map',
      do() {
        const current = project.maps.indexOf(map); if (current !== -1) project.maps.splice(current, 1);
        if (wasActive) {
          const next = project.maps[Math.min(index, project.maps.length - 1)] ?? null;
          editorHost.documents.setActive(next ? { kind: 'map', id: next.id } : null, { modeId: mode, allowMissing: true });
        }
        editorHost.projects.markDirty();
      },
      undo() {
        if (!project.maps.includes(map)) project.maps.splice(index, 0, map);
        if (wasActive) editorHost.documents.setActive({ kind: 'map', id: map.id }, { modeId: mode });
        editorHost.projects.markDirty();
      },
    }, { scope: PROJECT_SCOPE });
  }
  function commitDeleteSheet(sheet) {
    const project = editorHost.projects.project;
    const index = project.sheets.indexOf(sheet);
    if (index === -1) return;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    const wasActive = activeDoc?.kind === sheetDocument(sheet).kind && activeDoc.id === sheet.id;
    const mode = editorHost.store.getState().session.activeModeId;
    const cmd = {
      label: 'delete sheet',
      do() {
        removeSheet(project, sheet.id);
        discardFloatingForSheet(sheet.id);
        if (wasActive) {
          const siblings = project.sheets.filter(s => s.kind === sheet.kind);
          const next = siblings[Math.min(index, siblings.length - 1)] ?? null;
          editorHost.documents.setActive(next ? sheetDocument(next) : null, { modeId: mode, allowMissing: true });
          if (next) seedSheetSelection(next, next ? (sheetLayers(next)[0]?.id ?? null) : null);
        }
        editorHost.projects.markDirty();
      },
      undo() {
        project.sheets.splice(index, 0, sheet);
        if (wasActive) editorHost.documents.setActive(sheetDocument(sheet), { modeId: mode });
        editorHost.projects.markDirty();
      },
    };
    editorHost.history.execute(cmd, { scope: PROJECT_SCOPE });
  }
  defineAction('document.deleteSheet', {
    label: 'Delete',
    run: () => {
      const mode = editorHost.store.getState().session.activeModeId;
      if (mode === 'maps') {
        const map = activeMap(); if (!map) return;
        if (confirmOrAuto(`Delete map "${map.name}" and all of its layers and placements?`)) commitDeleteMap(map);
        return;
      }
      const sheet = activeSheet();
      if (!sheet) return;
      if (!confirmOrAuto(`Delete sheet "${sheet.name}" and everything in it (layers, frames, animations${sheet.kind === 'tile' ? ', tiles, autotile sets' : ''})?`)) return;
      commitDeleteSheet(sheet);
    },
    isEnabled: () => editorHost.store.getState().session.activeModeId === 'maps' ? !!activeMap() : !!activeSheet(),
  });
  bindAction(btnDeleteSheet, 'document.deleteSheet');
  function refreshDocumentControlTitles() {
    const maps = editorHost.store.getState().session.activeModeId === 'maps';
    btnNewSheet.title = maps ? 'New map' : 'New sheet';
    btnRenameSheet.title = maps ? 'Rename map' : 'Rename sheet';
    btnDeleteSheet.title = maps ? 'Delete map' : 'Delete sheet';
  }
  editorHost.store.subscribe(
    state => state.session.activeModeId,
    () => refreshDocumentControlTitles(),
    { fireImmediately: true },
  );

  // ---- undo/redo ----
  defineAction('edit.undo', {
    label: 'Undo', shortcut: 'Ctrl+Z',
    run: () => editorHost.history.undo(),
    isEnabled: () => editorHost.history.canUndo(),
  });
  defineAction('edit.redo', {
    label: 'Redo', shortcut: 'Ctrl+Y',
    run: () => editorHost.history.redo(),
    isEnabled: () => editorHost.history.canRedo(),
  });
  defineAction('edit.cut', { label: 'Cut', shortcut: 'Ctrl+X', run: () => cutSelection(false), isEnabled: hasSelection });
  defineAction('edit.copy', { label: 'Copy', shortcut: 'Ctrl+C', run: () => copySelection(false), isEnabled: hasSelection });
  defineAction('edit.paste', { label: 'Paste', shortcut: 'Ctrl+V', run: paste });
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return;
    // Deliberately narrower than the isTypingTarget/dialog[open] guard the
    // single-key shortcuts use. Undo/Redo/Save must survive two states that
    // guard was silently killing them in:
    //  - focus parked on a non-text control (the layer-opacity slider, a
    //    checkbox, a color swatch) -- those have no native undo to defer to;
    //  - a NON-modal dialog being open. The filter dialogs (Quantize, Chroma
    //    Key, Remove Checkerboard) are shown with .show(), movable, and meant
    //    to stay up while the user keeps painting/sampling on the canvas, so
    //    "a dialog is open" cannot mean "the app is frozen". Only a real
    //    modal (:modal, i.e. .showModal()) still blocks -- it owns the
    //    keyboard.
    if (isTextEntryTarget(e.target) || isTextEntryTarget(document.activeElement)) return;
    if (document.querySelector('dialog:modal')) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); runAction('edit.undo'); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); runAction('edit.redo'); }
    else if (key === 's') {
      e.preventDefault();
      runAction('file.save');
    }
  });
}
