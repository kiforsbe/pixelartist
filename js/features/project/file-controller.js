import { state, on, emit, activeSheet, activeMap, newDefaultProject, AUTOTEST, confirmOrAuto } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';
import * as io from '../../app/io.js';
import { flattenSheet } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';
import { commitFloatIfAny } from '../../components/canvas/float-session.js';
import { buildFramesJson, buildTilesJson, buildMapJson } from '../../app/exports.js';
import { buildTiledTsx } from '../../app/tiledExport.js';
import { buildC99, MAX_COLORS } from '../../app/c99Export.js';
import {
  buildGbaBinary, buildNesChr, buildSnesBinary, buildGbBinary, buildGbcBinary, buildC64Binary,
  checkGbaCompatibility, checkNesCompatibility, checkSnesCompatibility,
  checkGbCompatibility, checkGbcCompatibility, checkC64Compatibility,
} from '../../app/platformExport.js';
import { selectAnimations, buildAnimationSpritesheet, buildAnimationImageSequence, buildAnimationGifFrames } from '../../app/animationExport.js';
import { encodeGif } from '../../core/gif.js';
import { buildPalette, quantizeBitmap, colorFrequency } from '../../core/quantize.js';
import { PLATFORMS, NES_PALETTE, C64_PALETTE, GB_PALETTE, snapPaletteToHardware } from '../../core/platforms.js';
import { encodePng } from '../../app/pngcodec.js';
import { zipWrite } from '../../core/zip.js';
import { collectProjectExportEntries } from '../../app/projectExport.js';
import { defineAction } from '../../app/actions.js';
import { markDefaultAction } from '../../components/dialogs.js';

function isCancel(error) {
  return error?.name === 'AbortError' || error?.message === 'cancelled';
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function mountFileController() {
  const dlgExportProject = document.getElementById('dlg-export-project');
  const epSheets = document.getElementById('ep-sheets');
  const epDestFolderRow = document.getElementById('ep-dest-folder-row');
  const epExport = document.getElementById('ep-export');
  const epCancel = document.getElementById('ep-cancel');
  markDefaultAction(dlgExportProject, epExport);
  epCancel.addEventListener('click', () => dlgExportProject.close());

  // ---- host -> legacy mirror ----
  // EditorStore is authoritative, but a broad swath of still-legacy code
  // (js/modes/**/presentation/*.js, js/components/panels/*.js, drawing-
  // engine.js, sheet-overlays.js, and others -- roughly 29 files, out of
  // every completed task's scope) reads app/state.js's `state` object
  // directly and refreshes only through the legacy `on(event, fn)` bus, not
  // by observing the host store reactively. Every host field one of those
  // files still depends on is mirrored one-way (host -> legacy) below, each
  // mirror re-emitting whichever legacy bus event(s) that field's readers
  // expect so they actually repaint -- exactly what legacy setProject()/
  // switchMode() used to do as their own last step. All of this persists
  // until Group 3 (per-mode cleanup, scheduled after this plan) migrates
  // those files onto the host store/services directly, at which point
  // Group 3 deletes it.
  //
  // project.model, session.activeDocument and session.activeModeId are
  // watched as ONE tuple selector, not three independent subscribes:
  // EditorHost.setProject() writes project.model and activeDocument in two
  // separate store transactions, so two independent subscribes would fire
  // in two steps -- the first (project.model) would emit 'project' while
  // state.activeSheetId/activeMapId still held the PREVIOUS project's
  // value, resolving activeSheet()/activeMap() against the wrong id for
  // that one emit and leaving dependent panels (e.g. the Layers panel)
  // rendered empty with no later event to correct them. A single tuple
  // subscription fires exactly once, after both writes have landed.
  //
  // Fields covered by this tuple: state.project (the host is now the only
  // writer), state.activeSheetId/activeMapId (resolved from
  // session.activeDocument), state.onion (a live alias into
  // project.settings.onion -- frame-editor-presenter.js reads/writes it at
  // ~26 sites), and state.mode (40+ sites across tool-palette.js and nearly
  // every js/modes/*/presentation/*.js file gate tool availability, panel
  // visibility, and command modeId-tagging on it directly). Losing any one
  // of these leaves its readers silently stuck on a stale/previous-project
  // value after boot, New, Open, or a mode switch.
  //
  // The tuple's equals compares activeDocument by {kind,id} rather than
  // reference: DocumentService.resolve() allocates a fresh {kind,id} object
  // on every call, so reference equality would re-fire (and re-emit
  // 'project'/'view', forcing a full panel repaint) on every setActive()
  // call, even one that re-activates the document already active.
  getEditorHost().store.subscribe(
    s => [s.project.model, s.session.activeDocument, s.session.activeModeId],
    ([project, doc, mode]) => {
      state.project = project;
      state.activeSheetId = doc && doc.kind !== 'map' ? doc.id : null;
      state.activeMapId = doc && doc.kind === 'map' ? doc.id : null;
      state.onion = project?.settings?.onion ?? state.onion;
      state.mode = mode;
      emit('project');
      emit('view');
    },
    {
      equals: (a, b) => a[0] === b[0] && a[1]?.id === b[1]?.id && a[1]?.kind === b[1]?.kind && a[2] === b[2],
      fireImmediately: true,
    },
  );

  // History bridge: HistoryService now wraps the shared legacy CommandStack
  // (see bootstrap.js), but has zero legacy listeners of its own --
  // layers-panel.js, color-panel.js, preview-panel.js, frame-editor-
  // presenter.js and tile-editor-presenter.js still refresh exclusively on
  // the legacy `on('history', ...)` event. Until Group 3 moves them onto
  // host.history.subscribe() directly, this one-line re-emit is what makes
  // every undo/redo (from either stack) reach them.
  getEditorHost().history.subscribe(() => emit('history'));

  // Overlays mirror: the View menu's Show Labels/Show Sequences toggles
  // (editor-workbench.js) write workspace.overlays.{labels,sequences} on
  // the host store; the only reader, sheet-overlays.js, still reads legacy
  // state.overlays.{labels,sequences} and repaints only on `on('view', ...)`.
  // The store mutates `workspace.overlays` in place, so a selector
  // returning the object itself would never change identity under
  // Object.is -- select the two booleans as a tuple instead. state.overlays
  // stays the same mutable object app/state.js created at boot; only its
  // fields are reassigned, so any other holder of a reference to it keeps
  // working. Persists until Group 3 migrates sheet-overlays.js onto the
  // host store.
  getEditorHost().store.subscribe(
    s => [s.workspace.overlays.labels, s.workspace.overlays.sequences],
    ([labels, sequences]) => {
      state.overlays.labels = labels;
      state.overlays.sequences = sequences;
      emit('view');
    },
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1], fireImmediately: true },
  );

  // state.view <-> session.activeViewId mirror (bidirectional): frames-
  // panel.js, frame-tool-presenter.js and tile-tool-presenter.js still set
  // legacy state.view = 'frame'|'tile' (frame-editor-presenter.js/tile-
  // editor-presenter.js reset it to 'sheet') to open/close the frame/tile
  // sub-editor; editor-workbench.js's applyView() -- the only place that
  // actually shows/hides those sub-editors -- reads session.activeViewId
  // exclusively. Both directions have live writers (the legacy presenters
  // above write state.view; document-controller.js's switchMode() writes
  // activeViewId directly on every mode switch), so this mirror has to run
  // both ways, unlike the one-way mirrors above. The `syncingView` guard
  // stops each direction's own write from bouncing back through the other
  // and re-triggering itself -- without it, a host write would flow to
  // legacy, re-emit 'view', flow back to host, and so on (harmlessly, since
  // both sides already agree by the second pass, but pointlessly). Persists
  // until Group 3 migrates the frame/tile presenters onto
  // session.activeViewId directly.
  let syncingView = false;
  const legacyViewFor = viewId => (viewId === 'sprites.frame' ? 'frame' : viewId === 'tiles.tile' ? 'tile' : 'sheet');
  const hostViewFor = (view, mode) => {
    if (view === 'frame') return 'sprites.frame';
    if (view === 'tile') return 'tiles.tile';
    return mode === 'maps' ? 'maps.canvas' : `${mode}.sheet`;
  };
  getEditorHost().store.subscribe(
    s => s.session.activeViewId,
    (viewId) => {
      if (syncingView || viewId == null) return;
      const legacy = legacyViewFor(viewId);
      if (state.view === legacy) return;
      syncingView = true;
      try { state.view = legacy; emit('view'); } finally { syncingView = false; }
    },
    { fireImmediately: true },
  );
  on('view', () => {
    if (syncingView) return;
    const mode = getEditorHost().store.getState().session.activeModeId;
    if (!mode) return;
    const target = hostViewFor(state.view, mode);
    if (getEditorHost().store.getState().session.activeViewId === target) return;
    syncingView = true;
    try { getEditorHost().store.updateSession({ activeViewId: target }, 'view'); } finally { syncingView = false; }
  });

  // ---- file: Open ----
  // Folder ("unpacked") projects are disabled for now (see io.saveUnpacked/
  // openUnpacked, kept but unwired) -- Open always goes straight to the
  // packed (.pixelproj) file picker, no format-choice dialog.
  defineAction('file.open', {
    label: 'Open',
    run: async () => {
      if (getEditorHost().projects.dirty && !confirmOrAuto('Discard unsaved changes and open another project?')) return;
      try {
        const { project, handle } = await io.openPacked();
        state.fileHandle = handle;
        state.dirHandle = null;
        state.saveMode = handle ? 'packed' : null;
        getEditorHost().history.clear({ markDirty: false });
        getEditorHost().setProject(project, { dirty: false });
      } catch (e) {
        if (isCancel(e)) return;
        alert(e.message);
      }
    },
  });
  
  // ---- file: Save ----
  async function doSave() {
    commitFloatIfAny();
    try {
      state.fileHandle = await io.savePacked(state.project, state.fileHandle);
      state.saveMode = 'packed';
      getEditorHost().projects.markSaved();
      await io.clearAutosave().catch(() => {});
      emit('project');
    } catch (e) {
      if (!isCancel(e)) alert(`Save failed: ${e.message}`);
    }
  }
  defineAction('file.save', { label: 'Save', shortcut: 'Ctrl+S', run: doSave, isEnabled: () => !!state.project });

  // ---- file: Save As ----
  async function doSaveAs() {
    commitFloatIfAny();
    try {
      state.fileHandle = await io.savePacked(state.project, null);
      state.dirHandle = null;
      state.saveMode = 'packed';
      getEditorHost().projects.markSaved();
      await io.clearAutosave().catch(() => {});
      emit('project');
    } catch (e) {
      if (!isCancel(e)) alert(`Save failed: ${e.message}`);
    }
  }
  defineAction('file.saveAs', { label: 'Save As…', run: doSaveAs, isEnabled: () => !!state.project });
  
  // ---- export ----
  // Every export operation is a registered action (js/app/actions.js), never
  // an ad hoc closure inline in a menu structure -- Document > Export Sheet
  // and Document > Export Selected Animation are themselves actions whose
  // `submenu` is a fixed list of child action ids. Items that don't apply to
  // the current sheet kind (or, for the animation exports, when nothing is
  // selected) are disabled via isEnabled(), never hidden via isAvailable() --
  // menu items stay visible so their existence is discoverable, just inactive.
  async function exportSheetPng() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    const bitmap = flattenSheet(sheet);
    const blob = await io.exportPngBlob(bitmap);
    io.downloadBlob(blob, `${state.project.name}-${sheet.name}.png`);
  }
  function exportFramesJson() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || sheet.kind !== 'sprite') return;
    const json = buildFramesJson(sheet);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    io.downloadBlob(blob, `${sheet.name}.frames.json`);
  }
  
  function exportMapJson() {
    const map = activeMap();
    if (!map || !state.project) return;
    io.downloadBlob(new Blob([JSON.stringify(buildMapJson(map, state.project), null, 2)], { type: 'application/json' }), `${state.project.name}-${map.name}.map.json`);
  }
  function exportTilesJson() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || sheet.kind !== 'tile') return;
    const json = buildTilesJson(sheet);
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    io.downloadBlob(blob, `${sheet.name}.tiles.json`);
  }
  function exportTiledTsxFile() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || sheet.kind !== 'tile') return;
    const xml = buildTiledTsx(sheet);
    io.downloadBlob(new Blob([xml], { type: 'application/xml' }), `${sheet.name}.tsx`);
  }
  
  async function exportAnimationsAs(sheet, animId, format) {
    commitFloatIfAny();
    for (const anim of selectAnimations(sheet, animId)) {
      if (format === 'gif') {
        const bytes = encodeGif(buildAnimationGifFrames(sheet, anim), { loop: anim.loop });
        io.downloadBlob(new Blob([bytes], { type: 'image/gif' }), `${sheet.name}-${anim.name}.gif`);
      } else if (format === 'spritesheet') {
        const { bitmap, json } = buildAnimationSpritesheet(sheet, anim);
        io.downloadBlob(new Blob([await encodePng(bitmap)], { type: 'image/png' }), `${sheet.name}-${anim.name}.png`);
        io.downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), `${sheet.name}-${anim.name}.json`);
      } else if (format === 'sequence') {
        const entries = [];
        for (const f of buildAnimationImageSequence(sheet, anim)) entries.push({ path: `${f.name}.png`, data: await encodePng(f.bitmap) });
        io.downloadBlob(new Blob([await zipWrite(entries)]), `${sheet.name}-${anim.name}-sequence.zip`);
      }
    }
  }
  // Operates on the currently selected animation (via SelectionService,
  // the one selected in the Animation panel/timeline) -- not a picker, so these three formats
  // are static, registered once like every other export action here.
  function runOnSelectedAnimation(format) {
    const sheet = activeSheet();
    const animationId = sheet ? (getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null) : null;
    const anim = sheet?.animations.find(a => a.id === animationId);
    if (sheet && anim) exportAnimationsAs(sheet, anim.id, format);
  }
  defineAction('document.exportAnimation.gif', { label: 'GIF', run: () => runOnSelectedAnimation('gif') });
  defineAction('document.exportAnimation.spritesheet', { label: 'Spritesheet (PNG+JSON)', run: () => runOnSelectedAnimation('spritesheet') });
  defineAction('document.exportAnimation.sequence', { label: 'Image Sequence', run: () => runOnSelectedAnimation('sequence') });
  defineAction('document.exportAnimation', {
    label: 'Export Selected Animation',
    submenu: [
      { action: 'document.exportAnimation.gif' },
      { action: 'document.exportAnimation.spritesheet' },
      { action: 'document.exportAnimation.sequence' },
    ],
    isEnabled: () => {
      const sheet = activeSheet();
      return sheet?.kind === 'sprite' && !!getEditorHost().selections.get(sheetDocument(sheet))?.animationId;
    },
  });
  
  // project.settings.exportColorMode === 'total': cap export quantization at
  // a platform's whole system palette instead of one sprite/tile's hardware
  // budget (MAX_COLORS). The per-item INDEX COUNT limit itself is never
  // relaxed -- native binary exporters (buildNesChr etc.) still hard-cap at
  // MAX_COLORS regardless of this setting -- only which colors those indices
  // may be drawn from. 'total' is a no-op wherever the two already match
  // (gb2, generic8).
  const SYSTEM_TOTAL_COLORS = {
    generic8: MAX_COLORS.generic8,
    gba4: 256, // 16 OBJ palette banks x 16 colors -- GBA's total simultaneous sprite palette memory (Tonc/GBATEK)
    nes2: NES_PALETTE.length, // the PPU's entire fixed master palette, not just one tile's 4-color budget
    snes4: 256, // CGRAM total across all 8 OBJ palette slots (SNESdev PPU registers page)
    gb2: GB_PALETTE.length, // DMG only ever has these 4 shades -- identical to the per-tile cap
    gbc2: 32, // 8 OBJ palette banks x 4 colors -- GBC's total simultaneous sprite palette memory
    c64mc: C64_PALETTE.length, // VIC-II's entire fixed master palette, not just one cell's 4-color budget
  };
  // Targets whose hardware has a genuinely fixed, non-programmable color set
  // (mirrors js/core/platforms.js's PLATFORMS[x].palette) -- their exported
  // palette gets snapped to real hardware colors regardless of
  // exportColorMode, so "Generic C Header" output for these targets never
  // contains a color the real chip couldn't produce.
  const HARDWARE_PALETTE_BY_TARGET = { nes2: NES_PALETTE, c64mc: C64_PALETTE, gb2: GB_PALETTE };
  
  function resolveC99Items(sheet, target) {
    const flat = flattenSheet(sheet);
    const rects = sheet.kind === 'sprite' ? sheet.frames : sheet.tiles;
    const bitmaps = rects.map(r => copyRegion(flat, r.x, r.y, r.w, r.h));
    const colorMode = state.project.settings.exportColorMode ?? 'strict';
    const maxColors = colorMode === 'total' ? SYSTEM_TOTAL_COLORS[target] : MAX_COLORS[target];
    const sourcePalette = state.project.palettes.find(p => p.id === state.project.activePaletteId);
    const sourceColorCount = sourcePalette?.indexed ? sourcePalette.colors.length : colorFrequency(bitmaps).length;
    let palette = buildPalette(bitmaps, maxColors, sourcePalette).map(c => [c[0], c[1], c[2]]);
    const hwPalette = HARDWARE_PALETTE_BY_TARGET[target];
    if (hwPalette) palette = snapPaletteToHardware(palette, hwPalette);
    const items = rects.map((r, i) => ({ name: r.name || `item_${i}`, w: r.w, h: r.h, indices: quantizeBitmap(bitmaps[i], palette) }));
    return { palette, items, sourceColorCount, paletteBudget: maxColors };
  }
  // Runs the platform's hardware-compatibility check and surfaces any issues
  // before exporting: blocking errors (content structurally impossible to
  // pack, e.g. non-8x8-multiple dimensions) abort via alert; advisory
  // warnings (lossy color reduction, over tile budget) go through
  // confirmOrAuto so the user can proceed or cancel with full knowledge of
  // what changed -- never a silent, unexplained conversion.
  function confirmPlatformExport(platformLabel, check, sourceColorCount, items, paletteBudget) {
    const { errors, warnings } = check({ sourceColorCount, items, paletteBudget });
    if (errors.length) {
      alert(`${platformLabel} export blocked:\n\n${errors.join('\n')}`);
      return false;
    }
    if (warnings.length) {
      return confirmOrAuto(`${platformLabel} export has ${warnings.length} issue(s):\n\n${warnings.join('\n\n')}\n\nExport anyway?`);
    }
    return true;
  }
  function exportGenericC99() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { palette, items } = resolveC99Items(sheet, 'generic8');
      const { h, c } = buildC99({ projectName: sheet.name, target: 'generic8', palette, items });
      io.downloadBlob(new Blob([h], { type: 'text/plain' }), `${sheet.name}.h`);
      io.downloadBlob(new Blob([c], { type: 'text/plain' }), `${sheet.name}.c`);
    } catch (e) {
      alert(`C header export failed: ${e.message}`);
    }
  }
  function exportGbaNative() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'gba4');
      if (!confirmPlatformExport('Game Boy Advance', checkGbaCompatibility, sourceColorCount, items, paletteBudget)) return;
      const { pal, tiles } = buildGbaBinary({ palette, items });
      io.downloadBlob(new Blob([pal]), `${sheet.name}.pal.bin`);
      io.downloadBlob(new Blob([tiles]), `${sheet.name}.tiles.bin`);
    } catch (e) {
      alert(`Game Boy Advance export failed: ${e.message}`);
    }
  }
  function exportNesNative() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'nes2');
      if (!confirmPlatformExport('NES', checkNesCompatibility, sourceColorCount, items, paletteBudget)) return;
      const chr = buildNesChr({ items });
      io.downloadBlob(new Blob([chr]), `${sheet.name}.chr`);
    } catch (e) {
      alert(`NES export failed: ${e.message}`);
    }
  }
  function exportSnesNative() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'snes4');
      if (!confirmPlatformExport('SNES', checkSnesCompatibility, sourceColorCount, items, paletteBudget)) return;
      const { pal, tiles } = buildSnesBinary({ palette, items });
      io.downloadBlob(new Blob([pal]), `${sheet.name}.pal.bin`);
      io.downloadBlob(new Blob([tiles]), `${sheet.name}.tiles.bin`);
    } catch (e) {
      alert(`SNES export failed: ${e.message}`);
    }
  }
  function exportGbNative() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'gb2');
      if (!confirmPlatformExport('Game Boy', checkGbCompatibility, sourceColorCount, items, paletteBudget)) return;
      const tiles = buildGbBinary({ items });
      io.downloadBlob(new Blob([tiles]), `${sheet.name}.gb.bin`);
    } catch (e) {
      alert(`Game Boy export failed: ${e.message}`);
    }
  }
  function exportGbcNative() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'gbc2');
      if (!confirmPlatformExport('Game Boy Color', checkGbcCompatibility, sourceColorCount, items, paletteBudget)) return;
      const { pal, tiles } = buildGbcBinary({ palette, items });
      io.downloadBlob(new Blob([pal]), `${sheet.name}.pal.bin`);
      io.downloadBlob(new Blob([tiles]), `${sheet.name}.tiles.bin`);
    } catch (e) {
      alert(`Game Boy Color export failed: ${e.message}`);
    }
  }
  function exportC64Native() {
    commitFloatIfAny();
    const sheet = activeSheet();
    if (!sheet || !state.project) return;
    try {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'c64mc');
      if (!confirmPlatformExport('Commodore 64', checkC64Compatibility, sourceColorCount, items, paletteBudget)) return;
      const { background, screenRam, colorRam, bitmap } = buildC64Binary({ palette, items });
      io.downloadBlob(new Blob([bitmap]), `${sheet.name}.bitmap.bin`);
      io.downloadBlob(new Blob([screenRam]), `${sheet.name}.screen.bin`);
      io.downloadBlob(new Blob([colorRam]), `${sheet.name}.color.bin`);
      io.downloadBlob(new Blob([new Uint8Array([background])]), `${sheet.name}.bg.bin`);
    } catch (e) {
      alert(`Commodore 64 export failed: ${e.message}`);
    }
  }
  
  defineAction('document.exportSheet.png', { label: 'Sheet PNG (flattened)', run: exportSheetPng });
  defineAction('document.exportMap', { label: 'Map JSON', run: exportMapJson, isEnabled: () => !!activeMap() });
  defineAction('document.exportSheet.frames', { label: 'Frames JSON', run: exportFramesJson, isEnabled: () => activeSheet()?.kind === 'sprite' });
  defineAction('document.exportSheet.tiles', { label: 'Tiles JSON', run: exportTilesJson, isEnabled: () => activeSheet()?.kind === 'tile' });
  defineAction('document.exportSheet.tsx', { label: 'Tiled TSX', run: exportTiledTsxFile, isEnabled: () => activeSheet()?.kind === 'tile' });
  defineAction('document.exportSheet.gba', { label: 'Game Boy Advance', run: exportGbaNative });
  defineAction('document.exportSheet.nes', { label: 'NES', run: exportNesNative });
  defineAction('document.exportSheet.snes', { label: 'SNES', run: exportSnesNative });
  defineAction('document.exportSheet.gb', { label: 'Game Boy', run: exportGbNative });
  defineAction('document.exportSheet.gbc', { label: 'Game Boy Color', run: exportGbcNative });
  defineAction('document.exportSheet.c64', { label: 'Commodore 64', run: exportC64Native });
  defineAction('document.exportSheet.c99', { label: 'Generic C Header', run: exportGenericC99 });
  defineAction('document.exportSheet', {
    label: 'Export Sheet',
    submenu: [
      { action: 'document.exportSheet.png' },
      { action: 'document.exportSheet.frames' },
      { action: 'document.exportSheet.tiles' },
      { action: 'document.exportSheet.tsx' },
      { separator: true },
      { action: 'document.exportSheet.gba' },
      { action: 'document.exportSheet.nes' },
      { action: 'document.exportSheet.snes' },
      { action: 'document.exportSheet.gb' },
      { action: 'document.exportSheet.gbc' },
      { action: 'document.exportSheet.c64' },
      { action: 'document.exportSheet.c99' },
    ],
    isEnabled: () => !!state.project,
  });
  
  const SHEET_FORMATS = {
    sprite: [
      ['json', 'JSON + PNG'], ['gif', 'Animations (GIF, all)'],
      ['gba', 'Game Boy Advance'], ['nes', 'NES'], ['snes', 'SNES'],
      ['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['c64', 'Commodore 64'],
      ['c99', 'Generic C Header'],
    ],
    tile: [
      ['json', 'JSON + PNG'], ['tsx', 'Tiled TSX'],
      ['gba', 'Game Boy Advance'], ['nes', 'NES'], ['snes', 'SNES'],
      ['gb', 'Game Boy'], ['gbc', 'Game Boy Color'], ['c64', 'Commodore 64'],
      ['c99', 'Generic C Header'],
    ],
  };
  
  // `warnings`, if given, collects "<sheet> (<format>): <issue>" strings for
  // gba/nes/snes lossy-conversion/tile-budget issues instead of confirming
  // them one sheet at a time mid-batch -- the caller (epExport) shows one
  // combined confirmation after the whole batch is built, before anything
  // downloads. Blocking errors (content structurally impossible to pack)
  // still throw, same as the single-sheet Document > Export Sheet path.
  async function buildSheetExportEntries(sheet, format, warnings = null) {
    const flat = flattenSheet(sheet);
    if (format === 'json') {
      const isSprite = sheet.kind === 'sprite';
      const json = isSprite ? buildFramesJson(sheet) : buildTilesJson(sheet);
      return [
        { path: `${sheet.name}.png`, data: await encodePng(flat) },
        { path: `${sheet.name}.${isSprite ? 'frames' : 'tiles'}.json`, data: new TextEncoder().encode(JSON.stringify(json, null, 2)) },
      ];
    }
    if (format === 'tsx') {
      return [
        { path: `${sheet.name}.png`, data: await encodePng(flat) },
        { path: `${sheet.name}.tsx`, data: new TextEncoder().encode(buildTiledTsx(sheet)) },
      ];
    }
    if (format === 'gif') {
      return sheet.animations.map(anim => ({
        path: `${anim.name}.gif`,
        data: encodeGif(buildAnimationGifFrames(sheet, anim), { loop: anim.loop }),
      }));
    }
    if (format === 'c99') {
      const { palette, items } = resolveC99Items(sheet, 'generic8');
      const { h, c } = buildC99({ projectName: sheet.name, target: 'generic8', palette, items });
      return [
        { path: `${sheet.name}.h`, data: new TextEncoder().encode(h) },
        { path: `${sheet.name}.c`, data: new TextEncoder().encode(c) },
      ];
    }
    if (format === 'gba') {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'gba4');
      const { errors, warnings: w } = checkGbaCompatibility({ sourceColorCount, items, paletteBudget });
      if (errors.length) throw new Error(`${sheet.name} (Game Boy Advance): ${errors.join(' ')}`);
      warnings?.push(...w.map(msg => `${sheet.name} (Game Boy Advance): ${msg}`));
      const { pal, tiles } = buildGbaBinary({ palette, items });
      return [
        { path: `${sheet.name}.pal.bin`, data: pal },
        { path: `${sheet.name}.tiles.bin`, data: tiles },
      ];
    }
    if (format === 'nes') {
      const { items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'nes2');
      const { errors, warnings: w } = checkNesCompatibility({ sourceColorCount, items, paletteBudget });
      if (errors.length) throw new Error(`${sheet.name} (NES): ${errors.join(' ')}`);
      warnings?.push(...w.map(msg => `${sheet.name} (NES): ${msg}`));
      return [{ path: `${sheet.name}.chr`, data: buildNesChr({ items }) }];
    }
    if (format === 'snes') {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'snes4');
      const { errors, warnings: w } = checkSnesCompatibility({ sourceColorCount, items, paletteBudget });
      if (errors.length) throw new Error(`${sheet.name} (SNES): ${errors.join(' ')}`);
      warnings?.push(...w.map(msg => `${sheet.name} (SNES): ${msg}`));
      const { pal, tiles } = buildSnesBinary({ palette, items });
      return [
        { path: `${sheet.name}.pal.bin`, data: pal },
        { path: `${sheet.name}.tiles.bin`, data: tiles },
      ];
    }
    if (format === 'gb') {
      const { items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'gb2');
      const { errors, warnings: w } = checkGbCompatibility({ sourceColorCount, items, paletteBudget });
      if (errors.length) throw new Error(`${sheet.name} (Game Boy): ${errors.join(' ')}`);
      warnings?.push(...w.map(msg => `${sheet.name} (Game Boy): ${msg}`));
      return [{ path: `${sheet.name}.gb.bin`, data: buildGbBinary({ items }) }];
    }
    if (format === 'gbc') {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'gbc2');
      const { errors, warnings: w } = checkGbcCompatibility({ sourceColorCount, items, paletteBudget });
      if (errors.length) throw new Error(`${sheet.name} (Game Boy Color): ${errors.join(' ')}`);
      warnings?.push(...w.map(msg => `${sheet.name} (Game Boy Color): ${msg}`));
      const { pal, tiles } = buildGbcBinary({ palette, items });
      return [
        { path: `${sheet.name}.pal.bin`, data: pal },
        { path: `${sheet.name}.tiles.bin`, data: tiles },
      ];
    }
    if (format === 'c64') {
      const { palette, items, sourceColorCount, paletteBudget } = resolveC99Items(sheet, 'c64mc');
      const { errors, warnings: w } = checkC64Compatibility({ sourceColorCount, items, paletteBudget });
      if (errors.length) throw new Error(`${sheet.name} (Commodore 64): ${errors.join(' ')}`);
      warnings?.push(...w.map(msg => `${sheet.name} (Commodore 64): ${msg}`));
      const { background, screenRam, colorRam, bitmap } = buildC64Binary({ palette, items });
      return [
        { path: `${sheet.name}.bitmap.bin`, data: bitmap },
        { path: `${sheet.name}.screen.bin`, data: screenRam },
        { path: `${sheet.name}.color.bin`, data: colorRam },
        { path: `${sheet.name}.bg.bin`, data: new Uint8Array([background]) },
      ];
    }
    throw new Error(`unknown export format "${format}"`);
  }
  
  defineAction('file.export', {
    label: 'Export Project…',
    run: () => {
      if (!state.project) return;
      epSheets.innerHTML = '';
      for (const sheet of state.project.sheets) {
        const row = document.createElement('div');
        row.className = 'row';
        const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, id: `ep-sheet-${sheet.id}` });
        const label = Object.assign(document.createElement('label'), { htmlFor: cb.id, textContent: sheet.name, style: 'flex:1' });
        const select = document.createElement('select');
        select.id = `ep-format-${sheet.id}`;
        for (const [value, text] of SHEET_FORMATS[sheet.kind]) select.appendChild(new Option(text, value));
        row.append(cb, label, select);
        epSheets.appendChild(row);
      }
      epDestFolderRow.hidden = !io.supportsFS();
      dlgExportProject.showModal();
    },
    isEnabled: () => !!state.project,
  });
  
  epExport.addEventListener('click', async () => {
    dlgExportProject.close();
    commitFloatIfAny();
    const selections = state.project.sheets
      .filter(s => document.getElementById(`ep-sheet-${s.id}`).checked)
      .map(s => ({ sheetId: s.id, format: document.getElementById(`ep-format-${s.id}`).value }));
    const warnings = [];
    let entries;
    try {
      entries = await collectProjectExportEntries(state.project, selections,
        (sheet, format) => buildSheetExportEntries(sheet, format, warnings));
    } catch (e) {
      alert(`Export blocked: ${e.message}`);
      return;
    }
    if (warnings.length && !confirmOrAuto(`Export has ${warnings.length} issue(s):\n\n${warnings.join('\n\n')}\n\nExport anyway?`)) return;
    const dest = document.querySelector('input[name="ep-dest"]:checked').value;
    if (dest === 'folder') await io.saveEntriesToFolder(entries);
    else io.downloadBlob(new Blob([await zipWrite(entries)]), `${state.project.name}-export.zip`);
  });
  
  // ---- beforeunload guard ----
  window.addEventListener('beforeunload', (e) => {
    if (getEditorHost().projects.dirty && !AUTOTEST) { e.preventDefault(); e.returnValue = ''; }
  });
  
  // ---- autosave ----
  setInterval(() => {
    if (getEditorHost().projects.dirty && state.project && !state.floating) io.autosave(state.project).catch(() => {});
  }, 30000);
  
  // ---- boot ----
  (async function boot() {
    let restored = null;
    try {
      restored = AUTOTEST ? null : await io.loadAutosave();
    } catch (e) {
      restored = null;
    }
    getEditorHost().history.clear({ markDirty: false });
    if (restored && confirm('An autosaved project was found. Restore it?')) {
      getEditorHost().setProject(restored, { dirty: false });
    } else {
      getEditorHost().setProject(newDefaultProject(), { dirty: false });
    }
  })();
}

