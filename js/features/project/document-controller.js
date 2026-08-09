import { state, on, emit, activeSheet, activeMap, confirmOrAuto, markDirty, maybeSnapPixels } from '../../app/state.js';
import * as io from '../../app/io.js';
import { decodePng } from '../../app/pngcodec.js';
import { createSheet, createMap, removeSheet, sheetLayers } from '../../core/model.js';
import { commitFloatIfAny, cutSelection, copySelection, paste, hasSelection } from '../../ui/floatsession.js';
import { defineAction, runAction, bindAction } from '../../app/actions.js';
import { markDefaultAction } from '../../ui/dialogs.js';
import { syncLegacyStateToHost } from './legacy-state-adapter.js';

export function mountDocumentController({ editorHost, workbench }) {
  function isCancel(e) {
    return e?.name === 'AbortError' || e?.message === 'cancelled';
  }
  
  // Same gating pattern used by tools.js/frames.js/frameeditor.js/tileeditor.js:
  // ignore shortcuts while the user is typing in a field or a dialog is open.
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    return !!(el.closest && el.closest('dialog[open]'));
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
  function switchMode(mode, { fromHost = false } = {}) {
    if (!fromHost && editorHost && editorHost.activeModeId !== mode) {
      editorHost.activateMode(mode);
      return;
    }
    if (state.mode === mode) return;
    const previousMode = state.mode;
    state.mode = mode;
    tabSprites.classList.toggle('active', mode === 'sprites');
    tabTiles.classList.toggle('active', mode === 'tiles');
    tabMaps.classList.toggle('active', mode === 'maps');
    if (mode === 'maps') {
      const map = state.project?.maps?.[0] ?? null;
      state.activeMapId = map?.id ?? null;
      state.activeSheetId = null; state.view = 'map';
      if (!['select', 'move', 'maptile', 'mapsprite'].includes(state.tool)) { state.tool = 'select'; emit('tool'); }
      emit('view'); workbench.focusMap(); return;
    }
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheet = state.project?.sheets.find(s => s.kind === kind) ?? null;
    state.activeSheetId = sheet ? sheet.id : null;
    // Selections (layer/frame/animation/tile) are per-sheet; a stale id
    // surviving an active-sheet change lets e.g. timeline's "Add selected
    // frame" insert one sheet's frameId into another sheet's animation
    // (blank timeline cell, `"frame": null` on export). Reseed on every path
    // that reassigns activeSheetId.
    seedSheetSelection(sheet, sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null);
    state.selectedTileId = null;
    state.view = 'sheet';
    // frame/tile tools are mode-exclusive (their palette buttons hide via
    // isAvailable()); fall back to pencil so leaving their mode doesn't strand
    // pointer routing on a tool with nothing to dispatch to.
    if (mode !== 'sprites' && state.tool === 'frametool') { state.tool = 'pencil'; emit('tool'); }
    if (mode !== 'tiles' && state.tool === 'tiletool') { state.tool = 'pencil'; emit('tool'); }
    if (mode !== 'maps' && ['maptile', 'mapsprite'].includes(state.tool)) { state.tool = 'pencil'; emit('tool'); }
    emit('view');
    // Maps uses a deliberately distant, centred infinite-workspace camera.
    // Returning to a finite sheet must recenter it; otherwise the sheet is
    // still rendered but entirely outside the viewport (as in the reported
    // blank Tile Sheets canvas).
    if (previousMode === 'maps') workbench.fitSheet();
  }
  editorHost?.onDidChangeMode(({ modeId }) => switchMode(modeId, { fromHost: true }));
  tabSprites.addEventListener('click', () => switchMode('sprites'));
  tabTiles.addEventListener('click', () => switchMode('tiles'));
  tabMaps.addEventListener('click', () => switchMode('maps'));
  
  // Transitional bridge: the host is authoritative for mode activation while
  // legacy feature controllers still write the existing state object. Mirroring
  // the remaining state into the new service store lets features migrate one at
  // a time without maintaining two independent application states.
  const syncEditorHost = () => syncLegacyStateToHost(editorHost, state);
  on('project', syncEditorHost);
  on('view', syncEditorHost);
  on('selection', syncEditorHost);
  on('tool', syncEditorHost);
  on('history', syncEditorHost);
  syncEditorHost();
  
  // ---- sheet selector ----
  function refreshSheetSelect() {
    if (state.mode === 'maps') {
      const maps = state.project?.maps ?? [];
      sheetSelect.innerHTML = '';
      for (const m of maps) { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.name; sheetSelect.appendChild(opt); }
      sheetSelect.value = state.activeMapId ?? '';
      return;
    }
    const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
    const sheets = state.project?.sheets.filter(s => s.kind === kind) ?? [];
    sheetSelect.innerHTML = '';
    for (const s of sheets) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sheetSelect.appendChild(opt);
    }
    sheetSelect.value = state.activeSheetId ?? '';
  }
  let sheetSelectQueued = false;
  function scheduleSheetSelectRefresh() {
    if (sheetSelectQueued) return;
    sheetSelectQueued = true;
    queueMicrotask(() => { sheetSelectQueued = false; refreshSheetSelect(); });
  }
  on('project', scheduleSheetSelectRefresh);
  on('view', scheduleSheetSelectRefresh);
  refreshSheetSelect();
  
  sheetSelect.addEventListener('change', () => {
    if (state.mode === 'maps') { const map = state.project?.maps?.find(m => m.id === sheetSelect.value); if (!map) return; state.activeMapId = map.id; state.view = 'map'; emit('view'); workbench.focusMap(); return; }
    const sheet = state.project?.sheets.find(s => s.id === sheetSelect.value);
    if (!sheet) return;
    state.activeSheetId = sheet.id;
    // See switchMode's comment above: selections are per-sheet, reseed here too.
    seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
    state.selectedTileId = null;
    state.view = 'sheet';
    emit('view');
  });
  
  // ---- add-sheet command (shared by New Sheet dialog + Import) ----
  // Eager-mutate-then-snapshot idiom (see tilemode.js commitSwapTile): the caller
  // has already created `sheet` via createSheet, which pushes it into
  // project.sheets, so capture prior selection + insertion index here, then push
  // a command whose do()/undo() replay that structural change idempotently for
  // redo/undo.
  function commitAddSheet(sheet) {
    const project = state.project;
    const prevActiveSheetId = state.activeSheetId;
    const prevSheet = activeSheet();
    const prevActiveLayerId = prevSheet ? (editorHost.selections.get(sheetDocument(prevSheet))?.layerId ?? null) : null;
    const insertIndex = project.sheets.indexOf(sheet);
    const cmd = {
      label: 'new sheet',
      do() {
        if (!project.sheets.includes(sheet)) project.sheets.splice(insertIndex, 0, sheet);
        state.activeSheetId = sheet.id;
        // See switchMode's comment above: selections are per-sheet, reseed them too.
        seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
        state.selectedTileId = null;
        state.view = 'sheet';
        emit('view');
      },
      undo() {
        const i = project.sheets.indexOf(sheet);
        if (i !== -1) project.sheets.splice(i, 1);
        state.activeSheetId = prevActiveSheetId;
        if (prevSheet) seedSheetSelection(prevSheet, prevActiveLayerId);
        state.selectedTileId = null;
        state.view = 'sheet';
        emit('view');
      },
    };
    state.commands.push(cmd);
    markDirty();
    emit('view');
  }
  
  // ---- new sheet dialog ----
  defineAction('document.newSheet', {
    label: 'New Sheet',
    run: () => {
      if (!state.project) return;
      if (state.mode === 'maps') { const map = createMap(state.project, { name: `Map ${state.project.maps.length}`, gridW: state.project.settings.tileW, gridH: state.project.settings.tileH }); state.activeMapId = map.id; markDirty(); emit('view'); return; }
      const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
      const settings = state.project.settings;
      const n = state.project.sheets.filter(s => s.kind === kind).length + 1;
      nsName.value = `sheet_${n}`;
      nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
      nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
      dlgNewSheet.showModal();
    },
    isEnabled: () => !!state.project,
  });
  bindAction(btnNewSheet, 'document.newSheet');
  nsCancel.addEventListener('click', () => dlgNewSheet.close());
  nsCreate.addEventListener('click', () => {
    if (!state.project) return;
    const project = state.project;
    const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
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
      if (!state.project || state.mode === 'maps') return;
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
      bitmap = maybeSnapPixels(bitmap);
      const project = state.project;
      const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
      const name = file.name.replace(/\.[^.]+$/, '') || 'imported';
      const sheet = createSheet(project, {
        name, width: bitmap.width, height: bitmap.height, kind,
      });
      sheetLayers(sheet)[0].bitmap = bitmap;
      commitAddSheet(sheet);
    },
    isEnabled: () => !!state.project && state.mode !== 'maps',
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
      renameTargetKind = state.mode === 'maps' ? 'map' : 'sheet';
      renameTarget = renameTargetKind === 'map' ? activeMap() : activeSheet();
      if (!renameTarget) return;
      rsHeading.textContent = renameTargetKind === 'map' ? 'Rename Map' : 'Rename Sheet';
      rsName.value = renameTarget.name;
      dlgRenameSheet.showModal();
    },
    isEnabled: () => state.mode === 'maps' ? !!activeMap() : !!activeSheet(),
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
    // markDirty() in both directions: its 'project' emit refreshes the sheet
    // selector, which undo/redo would otherwise leave showing the stale name.
    state.commands.push({
      label: `rename ${kind}`,
      do() { target.name = v; markDirty(); },
      undo() { target.name = old; markDirty(); },
    });
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
    const project = state.project, index = project.maps.indexOf(map);
    if (index === -1) return;
    const wasActive = state.activeMapId === map.id;
    const prev = { activeMapId: state.activeMapId };
    state.commands.push({
      label: 'delete map',
      do() {
        const current = project.maps.indexOf(map); if (current !== -1) project.maps.splice(current, 1);
        if (wasActive) {
          const next = project.maps[Math.min(index, project.maps.length - 1)] ?? null;
          state.activeMapId = next?.id ?? null;
        }
        markDirty(); emit('view');
      },
      undo() {
        if (!project.maps.includes(map)) project.maps.splice(index, 0, map);
        Object.assign(state, prev);
        markDirty(); emit('view');
      },
    });
  }
  function commitDeleteSheet(sheet) {
    const project = state.project;
    const index = project.sheets.indexOf(sheet);
    if (index === -1) return;
    const wasActive = state.activeSheetId === sheet.id;
    const prev = {
      activeSheetId: state.activeSheetId,
      selectedTileId: state.selectedTileId, selectedTerrainSetId: state.selectedTerrainSetId,
      editingFrameId: state.editingFrameId, editingTileId: state.editingTileId,
      view: state.view, floating: state.floating,
    };
    const cmd = {
      label: 'delete sheet',
      do() {
        removeSheet(project, sheet.id);
        if (state.floating?.sheetId === sheet.id) state.floating = null;
        if (wasActive) {
          const siblings = project.sheets.filter(s => s.kind === sheet.kind);
          const next = siblings[Math.min(index, siblings.length - 1)] ?? null;
          state.activeSheetId = next ? next.id : null;
          seedSheetSelection(next, next ? (sheetLayers(next)[0]?.id ?? null) : null);
          state.selectedTileId = null;
          state.selectedTerrainSetId = null;
          state.editingFrameId = null;
          state.editingTileId = null;
          state.view = 'sheet';
        }
        markDirty();
        emit('view');
      },
      undo() {
        project.sheets.splice(index, 0, sheet);
        Object.assign(state, prev);
        markDirty();
        emit('view');
      },
    };
    state.commands.push(cmd);
  }
  defineAction('document.deleteSheet', {
    label: 'Delete',
    run: () => {
      if (state.mode === 'maps') {
        const map = activeMap(); if (!map) return;
        if (confirmOrAuto(`Delete map "${map.name}" and all of its layers and placements?`)) commitDeleteMap(map);
        return;
      }
      const sheet = activeSheet();
      if (!sheet) return;
      if (!confirmOrAuto(`Delete sheet "${sheet.name}" and everything in it (layers, frames, animations${sheet.kind === 'tile' ? ', tiles, autotile sets' : ''})?`)) return;
      commitDeleteSheet(sheet);
    },
    isEnabled: () => state.mode === 'maps' ? !!activeMap() : !!activeSheet(),
  });
  bindAction(btnDeleteSheet, 'document.deleteSheet');
  function refreshDocumentControlTitles() {
    const maps = state.mode === 'maps';
    btnNewSheet.title = maps ? 'New map' : 'New sheet';
    btnRenameSheet.title = maps ? 'Rename map' : 'Rename sheet';
    btnDeleteSheet.title = maps ? 'Delete map' : 'Delete sheet';
  }
  on('view', refreshDocumentControlTitles);
  on('project', refreshDocumentControlTitles);
  refreshDocumentControlTitles();
  
  // ---- undo/redo ----
  editorHost.history.subscribe(() => emit('history'));
  defineAction('edit.undo', {
    label: 'Undo', shortcut: 'Ctrl+Z',
    run: () => state.commands.undo(),
    isEnabled: () => state.commands.canUndo(),
  });
  defineAction('edit.redo', {
    label: 'Redo', shortcut: 'Ctrl+Y',
    run: () => state.commands.redo(),
    isEnabled: () => state.commands.canRedo(),
  });
  defineAction('edit.cut', { label: 'Cut', shortcut: 'Ctrl+X', run: () => cutSelection(false), isEnabled: hasSelection });
  defineAction('edit.copy', { label: 'Copy', shortcut: 'Ctrl+C', run: () => copySelection(false), isEnabled: hasSelection });
  defineAction('edit.paste', { label: 'Paste', shortcut: 'Ctrl+V', run: paste });
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); runAction('edit.undo'); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); runAction('edit.redo'); }
    else if (key === 's') {
      // Gated (unlike undo/redo above): Ctrl+S is a global browser shortcut
      // users may also press while a text field or dialog has focus, where we
      // want the browser/native field behavior, not a project save.
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      runAction('file.save');
    }
  });
}
