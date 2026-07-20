import { state, on, emit, activeSheet, activeLayer, activeLayerScope, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty, maybeSnapPixels } from './state.js';
import * as io from './io.js';
import { decodePng } from './pngcodec.js';
import { flattenSheet, createSheet, removeSheet, sheetLayers, layerAnimationContext, DEFAULT_SETTINGS } from '../core/model.js';
import { MAX_PALETTE_COLORS } from '../core/pixelSnapper.js';
import { segmentsOf, segmentOfFrame, segmentOfPoint, segmentBounds } from '../core/strips.js';
import { buildFramesJson, buildTilesJson } from './exports.js';
import { buildTiledTsx } from './tiledExport.js';
import { buildC99, MAX_COLORS } from './c99Export.js';
import {
  buildGbaBinary, buildNesChr, buildSnesBinary, buildGbBinary, buildGbcBinary, buildC64Binary,
  checkGbaCompatibility, checkNesCompatibility, checkSnesCompatibility,
  checkGbCompatibility, checkGbcCompatibility, checkC64Compatibility,
} from './platformExport.js';
import { selectAnimations, buildAnimationSpritesheet, buildAnimationImageSequence, buildAnimationGifFrames } from './animationExport.js';
import { encodeGif } from '../core/gif.js';
import { buildPalette, quantizeBitmap, colorFrequency, medianCutPalette, resolveAlphaForQuantize } from '../core/quantize.js';
import { PLATFORMS, checkItemAgainstPlatform, NES_PALETTE, C64_PALETTE, GB_PALETTE, snapPaletteToHardware } from '../core/platforms.js';
import { encodePng } from './pngcodec.js';
import { zipWrite } from '../core/zip.js';
import { copyRegion, cloneBitmap, blitRegion } from '../core/pixels.js';
import { quantizeBitmapToPalette } from '../core/palettes.js';
import { SYSTEM_PALETTES } from '../core/systempalettes.js';
import { collectProjectExportEntries } from './projectExport.js';
import { CanvasView } from '../ui/canvasview.js';
import { mountToolPalette, bindDrawing } from '../ui/tools.js';
import { mountColorPanel, mountLayersPanel } from '../ui/panels.js';
import { registerFrameTool, bindFrameTool, mountFramesPanel, drawStripChrome } from '../ui/frames.js';
import { registerTileTool, bindTileTool, mountTilePanel, mountAutotilesPanel, mountTileLayersPanel, drawTileChrome } from '../ui/tilemode.js';
import { drawSheetOverlays } from '../ui/overlays.js';
import { mountTimeline } from '../ui/timeline.js';
import { mountPreviewPanel } from '../ui/previewpanel.js';
import { mountAnimationsPanel } from '../ui/animpanel.js';
import { buildBaseDurationControl } from '../ui/baseDurationControl.js';
import { mountFrameEditor } from '../ui/frameeditor.js';
import { mountTileEditor } from '../ui/tileeditor.js';
import { initFloatSession, commitFloatIfAny, cutSelection, copySelection, paste, hasSelection, currentEditRegion } from '../ui/floatsession.js';
import { defineAction, runAction, bindAction } from './actions.js';
import { mountMenuBar } from '../ui/menubar.js';
import { markDefaultAction } from '../ui/dialogs.js';

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

// Shared field coercion for the New Project / Project Settings dialogs.
function sheetDimField(el) {
  const v = parseInt(el.value, 10);
  return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
}
function positiveIntField(el) {
  const v = parseInt(el.value, 10);
  return (Number.isNaN(v) || v < 1) ? null : v;
}

// ---- element refs ----
const tabSprites = document.getElementById('tab-sprites');
const tabTiles = document.getElementById('tab-tiles');
const statusTool = document.getElementById('status-tool');
const statusPlatform = document.getElementById('status-platform');
const statusPos = document.getElementById('status-pos');
const statusZoom = document.getElementById('status-zoom');
const canvasHost = document.getElementById('canvas-host');

const dlgExportProject = document.getElementById('dlg-export-project');
const epSheets = document.getElementById('ep-sheets');
const epDestFolderRow = document.getElementById('ep-dest-folder-row');
const epExport = document.getElementById('ep-export');
const epCancel = document.getElementById('ep-cancel');
markDefaultAction(dlgExportProject, epExport);
epCancel.addEventListener('click', () => dlgExportProject.close());

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

const dlgNewProject = document.getElementById('dlg-newproject');
const npSpriteW = document.getElementById('np-sprite-w');
const npSpriteH = document.getElementById('np-sprite-h');
const npTileSheetW = document.getElementById('np-tile-sheet-w');
const npTileSheetH = document.getElementById('np-tile-sheet-h');
const npTileW = document.getElementById('np-tile-w');
const npTileH = document.getElementById('np-tile-h');
const npFrameW = document.getElementById('np-frame-w');
const npFrameH = document.getElementById('np-frame-h');
const npDurationMount = document.getElementById('np-duration-control');
let npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
const npDurationControl = buildBaseDurationControl({
  getValue: () => npDurationValue,
  setValue: (v) => { npDurationValue = v; },
});
npDurationMount.appendChild(npDurationControl.el);
const npCreate = document.getElementById('np-create');
const npCancel = document.getElementById('np-cancel');
markDefaultAction(dlgNewProject, npCreate);

// ---- mode tabs ----
function switchMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  tabSprites.classList.toggle('active', mode === 'sprites');
  tabTiles.classList.toggle('active', mode === 'tiles');
  const kind = mode === 'sprites' ? 'sprite' : 'tile';
  const sheet = state.project?.sheets.find(s => s.kind === kind) ?? null;
  state.activeSheetId = sheet ? sheet.id : null;
  state.activeLayerId = sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null;
  // Selections (frame/animation/tile) are per-sheet; a stale id surviving an
  // active-sheet change lets e.g. timeline's "Add selected frame" insert one
  // sheet's frameId into another sheet's animation (blank timeline cell,
  // `"frame": null` on export). Clear on every path that reassigns activeSheetId.
  state.selectedFrameId = null;
  state.selectedAnimationId = null;
  state.selectedTileId = null;
  state.view = 'sheet';
  // frame/tile tools are mode-exclusive (their palette buttons hide via
  // isAvailable()); fall back to pencil so leaving their mode doesn't strand
  // pointer routing on a tool with nothing to dispatch to.
  if (mode !== 'sprites' && state.tool === 'frametool') { state.tool = 'pencil'; emit('tool'); }
  if (mode !== 'tiles' && state.tool === 'tiletool') { state.tool = 'pencil'; emit('tool'); }
  emit('view');
}
tabSprites.addEventListener('click', () => switchMode('sprites'));
tabTiles.addEventListener('click', () => switchMode('tiles'));

// ---- sheet selector ----
function refreshSheetSelect() {
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
  const sheet = state.project?.sheets.find(s => s.id === sheetSelect.value);
  if (!sheet) return;
  state.activeSheetId = sheet.id;
  state.activeLayerId = sheetLayers(sheet)[0]?.id ?? null;
  // See switchMode's comment above: selections are per-sheet, clear them here too.
  state.selectedFrameId = null;
  state.selectedAnimationId = null;
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
  const prevActiveLayerId = state.activeLayerId;
  const insertIndex = project.sheets.indexOf(sheet);
  const cmd = {
    label: 'new sheet',
    do() {
      if (!project.sheets.includes(sheet)) project.sheets.splice(insertIndex, 0, sheet);
      state.activeSheetId = sheet.id;
      state.activeLayerId = sheetLayers(sheet)[0]?.id ?? null;
      // See switchMode's comment above: selections are per-sheet, clear them too.
      state.selectedFrameId = null;
      state.selectedAnimationId = null;
      state.selectedTileId = null;
      state.view = 'sheet';
      emit('view');
    },
    undo() {
      const i = project.sheets.indexOf(sheet);
      if (i !== -1) project.sheets.splice(i, 1);
      state.activeSheetId = prevActiveSheetId;
      state.activeLayerId = prevActiveLayerId;
      state.selectedFrameId = null;
      state.selectedAnimationId = null;
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
    if (!state.project) return;
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
  isEnabled: () => !!state.project,
});
bindAction(btnImportSheet, 'document.importSheet');

// ---- rename sheet ----
const btnRenameSheet = document.getElementById('btn-rename-sheet');
const dlgRenameSheet = document.getElementById('dlg-renamesheet');
const rsName = document.getElementById('rs-name');
const rsOk = document.getElementById('rs-ok');
const rsCancel = document.getElementById('rs-cancel');
markDefaultAction(dlgRenameSheet, rsOk);
defineAction('document.renameSheet', {
  label: 'Rename Sheet',
  run: () => {
    const sheet = activeSheet();
    if (!sheet) return;
    rsName.value = sheet.name;
    dlgRenameSheet.showModal();
  },
  isEnabled: () => !!activeSheet(),
});
bindAction(btnRenameSheet, 'document.renameSheet');
rsCancel.addEventListener('click', () => dlgRenameSheet.close());
rsOk.addEventListener('click', () => {
  const sheet = activeSheet();
  if (!sheet) { dlgRenameSheet.close(); return; }
  const v = rsName.value.trim();
  if (!v) { alert('Name cannot be empty.'); return; }
  const old = sheet.name;
  // markDirty() in both directions: its 'project' emit refreshes the sheet
  // selector, which undo/redo would otherwise leave showing the stale name.
  state.commands.push({
    label: 'rename sheet',
    do() { sheet.name = v; markDirty(); },
    undo() { sheet.name = old; markDirty(); },
  });
  dlgRenameSheet.close();
});

// ---- delete sheet ----
// A sheet owns its layerTree/frames/animations/tiles/terrainSets inline (see
// removeSheet's comment in core/model.js), so the only other cleanup is app
// state that points at the sheet being removed: active sheet/layer,
// per-sheet selections, any open frame/tile editor, and an in-progress
// floating selection.
const btnDeleteSheet = document.getElementById('btn-delete-sheet');
function commitDeleteSheet(sheet) {
  const project = state.project;
  const index = project.sheets.indexOf(sheet);
  if (index === -1) return;
  const wasActive = state.activeSheetId === sheet.id;
  const prev = {
    activeSheetId: state.activeSheetId, activeLayerId: state.activeLayerId,
    selectedFrameId: state.selectedFrameId, selectedAnimationId: state.selectedAnimationId,
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
        state.activeLayerId = next ? (sheetLayers(next)[0]?.id ?? null) : null;
        state.selectedFrameId = null;
        state.selectedAnimationId = null;
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
  label: 'Delete Sheet',
  run: () => {
    const sheet = activeSheet();
    if (!sheet) return;
    if (!confirmOrAuto(`Delete sheet "${sheet.name}" and everything in it (layers, frames, animations${sheet.kind === 'tile' ? ', tiles, autotile sets' : ''})?`)) return;
    commitDeleteSheet(sheet);
  },
  isEnabled: () => !!activeSheet(),
});
bindAction(btnDeleteSheet, 'document.deleteSheet');

// ---- undo/redo ----
state.commands.onChange = () => emit('history');
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

// ---- quantize to palette ----
function bitmapsEqual(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function quantizeToPalette(mode, param, allLayers, preferOpaque = false) {
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet) return;
  const rr = currentEditRegion();
  if (!rr) return;
  const { region } = rr;
  const layers = allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []);
  if (!layers.length) return;
  const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
  const quantizeSource = (mode === 'count' && preferOpaque) ? resolveAlphaForQuantize(befores, param) : befores;
  const colors = mode === 'count'
    ? medianCutPalette(quantizeSource, param).map(c => [c[0], c[1], c[2], 255])
    : param;
  if (!colors.length) return;
  const palette = { colors };
  const patches = layers.map((l, i) => {
    const before = befores[i];
    const after = cloneBitmap(quantizeSource[i]);
    quantizeBitmapToPalette(after, palette);
    return { layer: l, before, after };
  }).filter(p => !bitmapsEqual(p.before, p.after));
  if (!patches.length) return;
  state.commands.push({
    label: 'quantize to palette',
    do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); emit('pixels'); },
    undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); emit('pixels'); },
  });
  markDirty();
}

const dlgQuantize = document.getElementById('dlg-quantize');
const qzModePalette = document.getElementById('qz-mode-palette');
const qzModeCount = document.getElementById('qz-mode-count');
const qzPaletteRow = document.getElementById('qz-palette-row');
const qzCountRow = document.getElementById('qz-count-row');
const qzPreferOpaqueRow = document.getElementById('qz-prefer-opaque-row');
const qzPalette = document.getElementById('qz-palette');
const qzCount = document.getElementById('qz-count');
const qzPreferOpaque = document.getElementById('qz-prefer-opaque');
const qzAllLayers = document.getElementById('qz-alllayers');
const qzOk = document.getElementById('qz-ok');
const qzCancel = document.getElementById('qz-cancel');
markDefaultAction(dlgQuantize, qzOk);

function updateQuantizeModeUI() {
  const isCount = qzModeCount.checked;
  qzPaletteRow.hidden = isCount;
  qzCountRow.hidden = !isCount;
  qzPreferOpaqueRow.hidden = !isCount;
}
qzModePalette.addEventListener('change', updateQuantizeModeUI);
qzModeCount.addEventListener('change', updateQuantizeModeUI);

function refreshQuantizePaletteOptions() {
  qzPalette.innerHTML = '';
  const projGroup = document.createElement('optgroup');
  projGroup.label = 'Project Palettes';
  for (const p of state.project?.palettes ?? []) {
    if (!p.colors.length) continue;
    const o = document.createElement('option');
    o.value = `proj:${p.id}`;
    o.textContent = p.indexed ? `${p.name} (${p.colors.length})` : p.name;
    projGroup.appendChild(o);
  }
  if (projGroup.children.length) qzPalette.appendChild(projGroup);

  const sysGroup = document.createElement('optgroup');
  sysGroup.label = 'System Palettes';
  for (const sys of SYSTEM_PALETTES) {
    const o = document.createElement('option');
    o.value = `sys:${sys.name}`;
    o.textContent = `${sys.name} (${sys.colors.length})`;
    sysGroup.appendChild(o);
  }
  qzPalette.appendChild(sysGroup);

  const activeOpt = state.project?.activePaletteId ? `proj:${state.project.activePaletteId}` : null;
  if (activeOpt && [...qzPalette.options].some(o => o.value === activeOpt)) qzPalette.value = activeOpt;
  else if (qzPalette.options.length) qzPalette.selectedIndex = 0;
}

function resolveQuantizePalette(value) {
  if (value.startsWith('proj:')) return state.project?.palettes.find(p => p.id === value.slice(5)) ?? null;
  if (value.startsWith('sys:')) return SYSTEM_PALETTES.find(s => s.name === value.slice(4)) ?? null;
  return null;
}

defineAction('edit.filters', {
  label: 'Filters',
  submenu: [
    { action: 'edit.filters.quantizeToPalette' },
  ],
  isEnabled: () => !!activeSheet(),
});
defineAction('edit.filters.quantizeToPalette', {
  label: 'Quantize to Palette…',
  run: () => {
    refreshQuantizePaletteOptions();
    qzModePalette.checked = true;
    updateQuantizeModeUI();
    qzAllLayers.checked = false;
    qzPreferOpaque.checked = false;
    dlgQuantize.showModal();
  },
  isEnabled: () => !!activeLayer(),
});
qzCancel.addEventListener('click', () => dlgQuantize.close());
qzOk.addEventListener('click', () => {
  if (qzModeCount.checked) {
    const n = Math.max(1, Math.min(256, parseInt(qzCount.value, 10) || 16));
    dlgQuantize.close();
    quantizeToPalette('count', n, qzAllLayers.checked, qzPreferOpaque.checked);
  } else {
    const pal = resolveQuantizePalette(qzPalette.value);
    dlgQuantize.close();
    if (!pal || !pal.colors.length) return;
    quantizeToPalette('palette', pal.colors, qzAllLayers.checked);
  }
});

// ---- shortcuts: brush size [ / ], swap colors X (Ctrl/Alt-free, gated) ----
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  if (e.key === '[') {
    e.preventDefault();
    state.brushSize = Math.max(1, state.brushSize - 1);
    emit('brushSize');
  } else if (e.key === ']') {
    e.preventDefault();
    state.brushSize = Math.min(8, state.brushSize + 1);
    emit('brushSize');
  } else if (e.key.toLowerCase() === 'x') {
    e.preventDefault();
    const p = state.primary; state.primary = state.secondary; state.secondary = p;
    emit('colors');
  }
});

// ---- overlay toggles ----
defineAction('view.toggleLabels', {
  label: 'Show Labels',
  run: () => { state.overlays.labels = !state.overlays.labels; emit('view'); },
  isChecked: () => state.overlays.labels,
});
defineAction('view.toggleSequences', {
  label: 'Show Sequences',
  run: () => { state.overlays.sequences = !state.overlays.sequences; emit('view'); },
  isChecked: () => state.overlays.sequences,
});

// ---- status bar ----
function updateStatusTool() { statusTool.textContent = `Tool: ${state.tool}`; }
on('tool', updateStatusTool);
updateStatusTool();

// Live per-item compatibility check against project.settings.targetPlatform
// (js/core/platforms.js) -- only while a specific frame/tile is open in its
// own editor (state.view 'frame'/'tile'), since that's the one item whose
// pixels/size are meaningful to check in isolation. Recomputed on every
// pixel/history/selection/project/view change; cheap enough at this app's
// sheet sizes to just redo the flatten+color-scan rather than cache it.
function updateStatusPlatform() {
  const project = state.project;
  const sheet = activeSheet();
  const platformId = project?.settings?.targetPlatform ?? 'none';
  const rect = platformId === 'none' || !sheet ? null
    : state.view === 'frame' ? sheet.frames?.find(f => f.id === state.editingFrameId)
    : state.view === 'tile' ? sheet.tiles?.find(t => t.id === state.editingTileId)
    : null;
  if (!rect) { statusPlatform.textContent = ''; statusPlatform.title = ''; return; }

  const bitmap = copyRegion(flattenSheet(sheet), rect.x, rect.y, rect.w, rect.h);
  const kind = state.view === 'tile' ? 'tile' : 'sprite';
  const warnings = checkItemAgainstPlatform(platformId, { colors: colorFrequency([bitmap]), w: rect.w, h: rect.h, kind });
  const label = PLATFORMS[platformId].label;
  statusPlatform.textContent = warnings.length ? `${label} ⚠ ${warnings.length}` : `${label} ✓`;
  statusPlatform.title = warnings.join('\n');
  statusPlatform.classList.toggle('status-platform-warn', warnings.length > 0);
}
on('pixels', updateStatusPlatform);
on('history', updateStatusPlatform);
on('selection', updateStatusPlatform);
on('project', updateStatusPlatform);
on('view', updateStatusPlatform);
updateStatusPlatform();

// ---- canvas view ----
const canvasView = new CanvasView(canvasHost);
canvasView.onStatus = ({ x, y, zoom }) => {
  statusPos.textContent = (x == null || y == null) ? '' : `${x},${y}`;
  statusZoom.textContent = `${zoom}x`;
};

// scratch OffscreenCanvas caching the active sheet's flattened bitmap; only
// re-flattened when the project changes, not on every paint (pan/zoom-driven).
let scratchCanvas = null;
let scratchDirty = true;
let scratchSheet = null; // sheet identity — mode switches swap sheets of equal size
function invalidateScratch() { scratchDirty = true; }
function getScratchCanvas() {
  const sheet = activeSheet();
  if (!sheet) return null;
  if (scratchDirty || scratchSheet !== sheet || !scratchCanvas || scratchCanvas.width !== sheet.width || scratchCanvas.height !== sheet.height) {
    const bitmap = flattenSheet(sheet, state.floating);
    if (!scratchCanvas || scratchCanvas.width !== bitmap.width || scratchCanvas.height !== bitmap.height) {
      scratchCanvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    }
    const sctx = scratchCanvas.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
    scratchDirty = false;
    scratchSheet = sheet;
  }
  return scratchCanvas;
}
canvasView.onPaint = (ctx) => {
  const canvas = getScratchCanvas();
  if (canvas) ctx.drawImage(canvas, 0, 0);
};

function refreshCanvasView() {
  const sheet = activeSheet();
  if (sheet) canvasView.setContent({ width: sheet.width, height: sheet.height });
  canvasView.requestRender();
}
on('project', () => { invalidateScratch(); refreshCanvasView(); });
on('view', refreshCanvasView);
// 'pixels': lightweight bitmap-changed-mid-stroke signal from tools.js/panels.js
// (in-progress drawing preview, live opacity drag) — just re-flatten + repaint,
// skip the heavier setContent/dirty-flag work that 'project' does.
on('pixels', () => { invalidateScratch(); canvasView.requestRender(); });
// undo/redo can touch pixels, layer structure, or both — repaint on every change.
on('history', () => { invalidateScratch(); refreshCanvasView(); });
// frame/tile selection changed (no pixel or structural change) — cheap repaint
// so the label-overlay highlight tracks state.selectedFrameId immediately.
on('selection', () => canvasView.requestRender());

// The sheet view's paint/float/paste target: normally the whole sheet, but
// narrowed to the current SEGMENT of an accepted strip's own frames when the
// active layer belongs to one (see docs/superpowers/specs/2026-07-18-strip-
// area-constraint-design.md) -- painting/copy/paste/move on a strip's own
// layer must never touch pixels outside the area its own frames occupy.
// `x, y` is the point of interest (a stroke's down-point, a marquee/frame-
// float's anchor corner, or a paste's original source position) -- when
// omitted (pasting from the OS clipboard, with no natural anchor), falls
// back to the segment of the currently selected frame, else the strip's
// first segment.
function sheetTargetRect(x, y) {
  const sheet = activeSheet();
  if (!sheet) return { x: 0, y: 0, w: 0, h: 0 };
  const whole = { x: 0, y: 0, w: sheet.width, h: sheet.height };
  const ctx = layerAnimationContext(sheet, activeLayer());
  if (!ctx?.anim.strip) return whole;
  const { anim } = ctx;
  let run = (x != null && y != null) ? segmentOfPoint(sheet, anim, x, y)
    : state.selectedFrameId ? segmentOfFrame(anim, state.selectedFrameId) : null;
  if (!run && x == null && y == null) run = segmentsOf(anim)[0] ?? null;
  return run ? segmentBounds(sheet, anim, run) : { x: 0, y: 0, w: 0, h: 0 };
}

// ---- drawing tools + panels ----
mountToolPalette(document.getElementById('tool-panel'));
bindDrawing(canvasView, sheetTargetRect);
// Frame tool: registerFrameTool() adds the palette button + its options row
// (must run after mountToolPalette so the button can be appended to the
// already-rendered palette — see tools.js's registerTool() hook). bindFrameTool
// wraps canvasView.onPointer/onOverlay and must run after bindDrawing so it
// captures bindDrawing's handlers to delegate back to for every other tool.
registerFrameTool();
bindFrameTool(canvasView);
// Tile tool: same shape as the frame tool above (registerTileTool() adds the
// palette button, bindTileTool() wraps onPointer/onOverlay); runs after
// bindFrameTool so its wrapper chains on top, though the two never both
// intercept at once (frametool is sprite-only, tiletool is tile-only).
registerTileTool();
bindTileTool(canvasView);
// Compose the sheet-view overlay chain: tools.js's marquee + frames.js's
// create/move/resize ghost + tilemode.js's swap/move ghost (already chained
// by bindFrameTool/bindTileTool above), then finally the frame/tile label
// overlays on top.
{
  const priorOverlay = canvasView.onOverlay;
  canvasView.onOverlay = (ctx) => { priorOverlay(ctx); drawSheetOverlays(canvasView, ctx); };
}
// Strip chrome (+/✂ call-outs, grips) chains last of all so it stays
// clickable-looking above the label overlays it is hit-tested above.
{
  const priorOverlay = canvasView.onOverlay;
  canvasView.onOverlay = (ctx) => { priorOverlay(ctx); drawStripChrome(ctx, canvasView); };
}
// Tile dimension chrome (idle selected-tile/grid dims) chains last too,
// same reasoning as strip chrome above.
{
  const priorOverlay = canvasView.onOverlay;
  canvasView.onOverlay = (ctx) => { priorOverlay(ctx); drawTileChrome(ctx, canvasView); };
}
initFloatSession();
mountColorPanel(document.getElementById('panel-colors'));
mountLayersPanel(document.getElementById('panel-layers'));
mountFramesPanel(document.getElementById('panel-context'));
mountAnimationsPanel(document.getElementById('panel-animation'));
mountTilePanel(document.getElementById('panel-context'));
mountAutotilesPanel(document.getElementById('panel-autotiles'));
mountTileLayersPanel(document.getElementById('panel-tilelayers'));
// Mounted before mountTimeline() so its own initial render() (below) runs
// last and wins over previewpanel's mount-time render() -- both fire
// synchronously in this init sequence, outside the event system.
mountPreviewPanel(document.getElementById('panel-preview'));
mountTimeline(document.getElementById('timeline-dock'));

// ---- frame editor (Task 16) ----
// A second CanvasView instance living in its own absolutely-positioned child
// of #canvas-host (see frameeditor.js's module comment), mounted once and
// kept for the app's lifetime — CanvasView has no teardown and installs
// window-level key listeners, so per-show churn would leak.
const frameEditor = mountFrameEditor(canvasHost);

// ---- tile editor (Task 18) ----
// Same shape as the frame editor above: a second CanvasView living in its
// own absolutely-positioned child of #canvas-host, mounted once and kept for
// the app's lifetime.
const tileEditor = mountTileEditor(canvasHost);

// ---- view: zoom ----
function activeCanvasView() {
  return state.view === 'frame' ? frameEditor.view : state.view === 'tile' ? tileEditor.view : canvasView;
}
defineAction('view.zoomIn', { label: 'Zoom In', run: () => activeCanvasView().zoomIn() });
defineAction('view.zoomOut', { label: 'Zoom Out', run: () => activeCanvasView().zoomOut() });
defineAction('view.actualSize', { label: 'Actual Size (100%)', run: () => activeCanvasView().actualSize() });
defineAction('view.zoomToFit', { label: 'Zoom to Fit', run: () => activeCanvasView().fitToView() });

// ---- help ----
const dlgAbout = document.getElementById('dlg-about');
const aboutOk = document.getElementById('about-ok');
aboutOk.addEventListener('click', () => dlgAbout.close());
markDefaultAction(dlgAbout, aboutOk);
defineAction('help.about', {
  label: 'About PixelArtist',
  run: () => {
    document.getElementById('about-version').textContent = 'Version 0.1.0';
    document.getElementById('about-license').textContent = '© 2026 Kim Forsberg. All rights reserved.';
    dlgAbout.showModal();
  },
});

const dlgShortcuts = document.getElementById('dlg-shortcuts');
const shortcutsList = document.getElementById('shortcuts-list');
const shortcutsOk = document.getElementById('shortcuts-ok');
shortcutsOk.addEventListener('click', () => dlgShortcuts.close());
markDefaultAction(dlgShortcuts, shortcutsOk);
const SHORTCUTS = [
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'],
  ['Ctrl+S', 'Save'],
  ['[ / ]', 'Decrease / increase brush size'],
  ['X', 'Swap primary/secondary color'],
  ['B / E / G / L / U / O / I / M / V', 'Pencil / Eraser / Fill / Line / Rect / Ellipse / Eyedropper / Select / Move'],
  ['F', 'Frame tool (sprite sheets mode)'],
  ['T', 'Tile tool (tile sheets mode)'],
  ['Escape', 'Clear selection / cancel floating selection / back to sheet'],
  ['Space + drag', 'Pan'],
  ['Mouse wheel', 'Zoom'],
  ['Ctrl+X / Ctrl+C / Ctrl+V', 'Cut / copy / paste selection (hold Alt too = all layers)'],
  ['Enter (while floating)', 'Commit the floating selection'],
  ['Delete', 'Delete the selected frame or tile'],
  ['Arrow Up / Down', 'Reorder the selected layer in the Layers panel'],
];
defineAction('help.shortcuts', {
  label: 'Keyboard Shortcuts',
  run: () => {
    shortcutsList.innerHTML = '';
    for (const [keys, desc] of SHORTCUTS) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const k = document.createElement('span'); k.className = 'shortcut-keys'; k.textContent = keys;
      const d = document.createElement('span'); d.className = 'shortcut-desc'; d.textContent = desc;
      row.append(k, d);
      shortcutsList.appendChild(row);
    }
    dlgShortcuts.showModal();
  },
});

// ---- menu bar ----
// Later tasks extend this array (more items per menu, more menus) and add
// the defineAction calls those items reference — menubar.js skips any item
// whose action id isn't registered yet, so this can be built up incrementally.
const MENUS = [
  { label: 'File', items: [
    { action: 'file.new' }, { action: 'file.open' }, { separator: true },
    { action: 'file.save' }, { action: 'file.saveAs' }, { separator: true },
    { action: 'file.export' },
  ] },
  { label: 'Document', items: [
    { action: 'document.newSheet' }, { action: 'document.importSheet' }, { separator: true },
    { action: 'document.renameSheet' }, { action: 'document.deleteSheet' }, { separator: true },
    { action: 'document.exportSheet' }, { action: 'document.exportAnimation' },
  ] },
  { label: 'Layer', items: [
    { action: 'layer.add' }, { action: 'layer.addGroup' }, { separator: true },
    { action: 'layer.delete' }, { action: 'layer.mergeDown' },
  ] },
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
    { action: 'edit.filters' }, { separator: true },
    { action: 'edit.projectSettings' },
  ] },
  { label: 'View', items: [
    { action: 'view.toggleLabels' }, { action: 'view.toggleSequences' }, { separator: true },
    { action: 'view.zoomIn' }, { action: 'view.zoomOut' }, { action: 'view.actualSize' }, { action: 'view.zoomToFit' },
  ] },
  { label: 'Help', items: [
    { action: 'help.shortcuts' }, { action: 'help.about' },
  ] },
];
mountMenuBar(document.getElementById('menubar'), MENUS);

// ---- view switching: sheet canvas vs frame editor vs tile editor.
// Only one is visible at a time; each owns its own CanvasView. The sheet
// view's <canvas> is hidden directly (its host, #canvas-host, is shared with
// the frame/tile editors' own child containers) rather than tearing anything down.
function applyView() {
  if (state.view === 'sheet') {
    canvasView.canvas.style.display = '';
    frameEditor.hide();
    tileEditor.hide();
  } else if (state.view === 'frame') {
    canvasView.canvas.style.display = 'none';
    frameEditor.show();
    tileEditor.hide();
  } else {
    // 'tile'
    canvasView.canvas.style.display = 'none';
    frameEditor.hide();
    tileEditor.show();
  }
}
on('view', applyView);
applyView();

// ---- file: New ----
defineAction('file.new', {
  label: 'New',
  run: () => {
    if (state.dirty && !confirmOrAuto('Discard unsaved changes and start a new project?')) return;
    npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
    npDurationControl.refresh();
    dlgNewProject.showModal();
  },
});
npCancel.addEventListener('click', () => dlgNewProject.close());
npCreate.addEventListener('click', () => {
  // Sheet dims (sprite/tile sheet W/H) are clamped to the 1..4096 range;
  // everything else (tile size, frame size) just needs to be a positive
  // integer. Any NaN or sub-1 value aborts with an alert rather than
  // silently coercing, so e.g. a blank or 0 sprite width is rejected.
  // Frame time comes from npDurationControl, which always self-coerces to a
  // valid positive value -- it never needs this validation pass.
  const dims = {
    spriteSheetW: sheetDimField(npSpriteW), spriteSheetH: sheetDimField(npSpriteH),
    tileSheetW: sheetDimField(npTileSheetW), tileSheetH: sheetDimField(npTileSheetH),
    tileW: positiveIntField(npTileW), tileH: positiveIntField(npTileH),
    frameW: positiveIntField(npFrameW), frameH: positiveIntField(npFrameH),
  };
  if (Object.values(dims).some(v => v == null)) {
    alert('Please enter valid positive numbers for all fields.');
    return;
  }
  const settings = {
    ...dims, durationMs: npDurationValue.durationMs,
    ...(npDurationValue.baseFps != null ? { baseFps: npDurationValue.baseFps, baseStep: npDurationValue.baseStep } : {}),
  };
  state.fileHandle = null; state.dirHandle = null; state.saveMode = null;
  setProject(newDefaultProject(settings));
  dlgNewProject.close();
});

// ---- Project Settings ----
const dlgProjectSettings = document.getElementById('dlg-projectsettings');
const psName = document.getElementById('ps-name');
const psSpriteW = document.getElementById('ps-sprite-w');
const psSpriteH = document.getElementById('ps-sprite-h');
const psTileSheetW = document.getElementById('ps-tile-sheet-w');
const psTileSheetH = document.getElementById('ps-tile-sheet-h');
const psTileW = document.getElementById('ps-tile-w');
const psTileH = document.getElementById('ps-tile-h');
const psFrameW = document.getElementById('ps-frame-w');
const psFrameH = document.getElementById('ps-frame-h');
const psDurationMount = document.getElementById('ps-duration-control');
const psSmoothThumbnails = document.getElementById('ps-smooth-thumbnails');
const psPixelSnapper = document.getElementById('ps-pixel-snapper');
const psPixelSnapperPalette = document.getElementById('ps-pixel-snapper-palette');
const psPixelSnapperKColors = document.getElementById('ps-pixel-snapper-kcolors');
const psPixelSnapperPixelSize = document.getElementById('ps-pixel-snapper-pixelsize');
// Advanced pixel-snapper tuning fields (Project Settings > Import >
// Advanced): DOM id suffix, project.settings key, human label (used in the
// out-of-range alert below). All nine are plain numeric inputs sharing the
// exact same populate/save/validate shape, so they're driven from this
// table instead of nine repeats of the same few lines.
const PS_ADVANCED_FIELDS = [
  ['max-iterations', 'pixelSnapperMaxIterations', 'Max iterations'],
  ['peak-threshold', 'pixelSnapperPeakThreshold', 'Peak threshold'],
  ['peak-distance-filter', 'pixelSnapperPeakDistanceFilter', 'Peak distance filter'],
  ['search-window-ratio', 'pixelSnapperSearchWindowRatio', 'Search window ratio'],
  ['min-search-window', 'pixelSnapperMinSearchWindow', 'Min search window'],
  ['strength-threshold', 'pixelSnapperStrengthThreshold', 'Strength threshold'],
  ['min-cuts-per-axis', 'pixelSnapperMinCutsPerAxis', 'Min cuts per axis'],
  ['fallback-segments', 'pixelSnapperFallbackSegments', 'Fallback segments'],
  ['max-step-ratio', 'pixelSnapperMaxStepRatio', 'Max step ratio'],
];
const psAdvancedInputs = Object.fromEntries(
  PS_ADVANCED_FIELDS.map(([id, key]) => [key, document.getElementById(`ps-ps-${id}`)])
);
function psAdvancedValue(key) {
  const v = parseFloat(psAdvancedInputs[key].value);
  return Number.isFinite(v) ? v : DEFAULT_SETTINGS[key];
}
// Per-field "reset to default" buttons: hidden unless the field's current
// value differs from its default, click restores it (nothing is saved
// until OK, same as any other edit in this dialog). `sync()` re-checks
// visibility on every edit and is also called once after populating each
// field in openProjectSettings() below, so a freshly-opened dialog starts
// with the right buttons already hidden.
function wireFieldReset(input, resetBtn, defaultStr) {
  const sync = () => { resetBtn.style.display = input.value === defaultStr ? 'none' : ''; };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  resetBtn.addEventListener('click', () => { input.value = defaultStr; sync(); });
  sync();
  return sync;
}
const syncPaletteReset = wireFieldReset(psPixelSnapperPalette, document.getElementById('ps-pixel-snapper-palette-reset'), '');
const syncKColorsReset = wireFieldReset(psPixelSnapperKColors, document.getElementById('ps-pixel-snapper-kcolors-reset'), String(DEFAULT_SETTINGS.pixelSnapperKColors));
const syncPixelSizeReset = wireFieldReset(psPixelSnapperPixelSize, document.getElementById('ps-pixel-snapper-pixelsize-reset'), '');
const psAdvancedResetSyncs = Object.fromEntries(PS_ADVANCED_FIELDS.map(([id, key]) =>
  [key, wireFieldReset(psAdvancedInputs[key], document.getElementById(`ps-ps-${id}-reset`), String(DEFAULT_SETTINGS[key]))]));
// Every pixel-snapper numeric field's own min/max/step (native constraint
// validation) is the single source of truth for what's permissible --
// out-of-range values get a visible red outline (see app.css's
// `.dlg-grid input:invalid` rule) live as you type, via the browser's
// built-in :invalid styling, no JS needed for that part. Pixel size is
// exempt while blank (that's "auto", not a number to validate).
const PS_NUMERIC_FIELDS = [
  ['Colors (k)', psPixelSnapperKColors],
  ['Pixel size', psPixelSnapperPixelSize],
  ...PS_ADVANCED_FIELDS.map(([, key, label]) => [label, psAdvancedInputs[key]]),
];
// Returns the label of the first invalid field, or null if all pass. Used
// to block OK (see psOk below) instead of silently clamping an
// out-of-range value to its nearest bound -- a typo like 2048 in a
// 1-65536 field used to clamp to 256 with no feedback at all, which just
// looked like "my edit didn't save".
function firstInvalidPsField() {
  for (const [label, input] of PS_NUMERIC_FIELDS) {
    if (input === psPixelSnapperPixelSize && input.value.trim() === '') continue;
    if (!input.checkValidity()) return { label, input };
  }
  return null;
}
const psTargetPlatform = document.getElementById('ps-target-platform');
for (const [id, p] of Object.entries(PLATFORMS)) psTargetPlatform.appendChild(new Option(p.label, id));
const psExportColorMode = document.getElementById('ps-export-color-mode');
const psOk = document.getElementById('ps-ok');
const psCancel = document.getElementById('ps-cancel');
markDefaultAction(dlgProjectSettings, psOk);

let psDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
const psDurationControl = buildBaseDurationControl({
  getValue: () => psDurationValue,
  setValue: (v) => { psDurationValue = v; },
});
psDurationMount.appendChild(psDurationControl.el);

// Width/height ratio lock for each dimension pair -- locked (default) keeps
// the pair proportional as either field is edited; the ratio snapshots from
// whatever's currently in the fields whenever the lock is (re)established,
// so resnap() lets openProjectSettings() re-anchor it to the freshly loaded
// project values every time the dialog opens (otherwise editing W after
// opening would scale H against a stale ratio left over from a previous
// dialog session or the placeholder markup values).
function makeDimLock(wInput, hInput, lockBtn) {
  let locked = true;
  let ratio = 1; // H per W

  function resnap() {
    const w = parseFloat(wInput.value), h = parseFloat(hInput.value);
    if (w > 0 && h > 0) ratio = h / w;
  }
  function updateVisual() {
    lockBtn.classList.toggle('locked', locked);
    lockBtn.title = locked
      ? 'Width/height locked to this ratio (click to unlock)'
      : 'Width/height independent (click to lock)';
  }
  lockBtn.addEventListener('click', () => {
    locked = !locked;
    if (locked) resnap();
    updateVisual();
  });
  wInput.addEventListener('input', () => {
    if (!locked) return;
    const w = parseFloat(wInput.value);
    if (!Number.isFinite(w) || w <= 0) return;
    hInput.value = String(Math.max(1, Math.round(w * ratio)));
  });
  hInput.addEventListener('input', () => {
    if (!locked) return;
    const h = parseFloat(hInput.value);
    if (!Number.isFinite(h) || h <= 0) return;
    wInput.value = String(Math.max(1, Math.round(h / ratio)));
  });
  resnap();
  updateVisual();
  return { resnap };
}
const psSpriteLock = makeDimLock(psSpriteW, psSpriteH, document.getElementById('ps-sprite-lock'));
const psTileSheetLock = makeDimLock(psTileSheetW, psTileSheetH, document.getElementById('ps-tilesheet-lock'));
const psTileSizeLock = makeDimLock(psTileW, psTileH, document.getElementById('ps-tile-lock'));
const psFrameLock = makeDimLock(psFrameW, psFrameH, document.getElementById('ps-frame-lock'));

// ---- Project Settings: tabs ----
// Two pages sharing one OK/Cancel: General (dims/name/duration, an undoable
// command) and Onion Steps (per-step onion-skin color overrides, moved here
// from a standalone dialog the frame editor used to own -- see
// frameeditor.js's btnStepColors). OK commits BOTH pages' current field
// values regardless of which page is on screen, so flipping tabs before
// saving never loses an edit made on the other one.
const psTabGeneral = document.getElementById('ps-tab-general');
const psTabImport = document.getElementById('ps-tab-import');
const psTabOnion = document.getElementById('ps-tab-onion');
const psPageGeneral = document.getElementById('ps-page-general');
const psPageImport = document.getElementById('ps-page-import');
const psPageOnion = document.getElementById('ps-page-onion');
const psOnionGrid = document.getElementById('ps-onion-grid');

function showProjectSettingsTab(tab) {
  psTabGeneral.classList.toggle('active', tab === 'general');
  psTabImport.classList.toggle('active', tab === 'import');
  psTabOnion.classList.toggle('active', tab === 'onion');
  psPageGeneral.hidden = tab !== 'general';
  psPageImport.hidden = tab !== 'import';
  psPageOnion.hidden = tab !== 'onion';
}
psTabGeneral.addEventListener('click', () => showProjectSettingsTab('general'));
psTabImport.addEventListener('click', () => showProjectSettingsTab('import'));
psTabOnion.addEventListener('click', () => showProjectSettingsTab('onion'));

// Dims a step's color swatch while its "Default" checkbox is checked, so
// it visibly reads as "not in effect" rather than just an unrelated pair of
// controls next to each other.
function syncOnionStepActive(defaultCb, colorInput) {
  colorInput.classList.toggle('onion-steps-color-inactive', defaultCb.checked);
}

// Builds the 8-row Back/Ahead step-color grid once; returns the per-row
// field refs used to populate on open and read back on OK. Two header rows
// (direction, then Default/Color) so it's unambiguous what each checkbox
// means: checked = "use the toolbar's Back/Ahead color for this step" (the
// Color swatch beside it is then just a disabled preview of that), unchecked
// = "use this step's own Color swatch".
function buildOnionStepsGrid(grid) {
  const backHeader = document.createElement('span');
  backHeader.className = 'onion-steps-header'; backHeader.textContent = 'Back';
  backHeader.style.gridColumn = 'span 2';
  const aheadHeader = document.createElement('span');
  aheadHeader.className = 'onion-steps-header'; aheadHeader.textContent = 'Ahead';
  aheadHeader.style.gridColumn = 'span 2';
  grid.append(document.createElement('span'), backHeader, aheadHeader);

  const subHeader = () => {
    const el = document.createElement('span');
    el.className = 'onion-steps-subheader';
    return el;
  };
  const backDefaultHeader = subHeader(); backDefaultHeader.textContent = 'Default';
  const backColorHeader = subHeader(); backColorHeader.textContent = 'Color';
  const aheadDefaultHeader = subHeader(); aheadDefaultHeader.textContent = 'Default';
  const aheadColorHeader = subHeader(); aheadColorHeader.textContent = 'Color';
  grid.append(subHeader(), backDefaultHeader, backColorHeader, aheadDefaultHeader, aheadColorHeader);

  const rows = [];
  for (let k = 1; k <= 8; k++) {
    const stepLabel = document.createElement('span');
    stepLabel.className = 'onion-steps-step'; stepLabel.textContent = String(k);

    const backDefault = document.createElement('input');
    backDefault.type = 'checkbox';
    backDefault.title = 'Checked: this step uses the Back toolbar color. Unchecked: it uses its own color swatch.';
    const backColor = document.createElement('input');
    backColor.type = 'color';
    backColor.title = "This step's own color (only used while Default is unchecked)";
    backColor.addEventListener('input', () => { backDefault.checked = false; syncOnionStepActive(backDefault, backColor); });
    backDefault.addEventListener('change', () => syncOnionStepActive(backDefault, backColor));

    const aheadDefault = document.createElement('input');
    aheadDefault.type = 'checkbox';
    aheadDefault.title = 'Checked: this step uses the Ahead toolbar color. Unchecked: it uses its own color swatch.';
    const aheadColor = document.createElement('input');
    aheadColor.type = 'color';
    aheadColor.title = "This step's own color (only used while Default is unchecked)";
    aheadColor.addEventListener('input', () => { aheadDefault.checked = false; syncOnionStepActive(aheadDefault, aheadColor); });
    aheadDefault.addEventListener('change', () => syncOnionStepActive(aheadDefault, aheadColor));

    grid.append(stepLabel, backDefault, backColor, aheadDefault, aheadColor);
    rows.push({ k, backDefault, backColor, aheadDefault, aheadColor });
  }
  return rows;
}
const onionStepRows = buildOnionStepsGrid(psOnionGrid);

function openProjectSettings(tab) {
  const project = state.project;
  if (!project) return;
  const settings = project.settings;
  psName.value = project.name;
  psSpriteW.value = String(settings.spriteSheetW);
  psSpriteH.value = String(settings.spriteSheetH);
  psTileSheetW.value = String(settings.tileSheetW);
  psTileSheetH.value = String(settings.tileSheetH);
  psTileW.value = String(settings.tileW);
  psTileH.value = String(settings.tileH);
  psFrameW.value = String(settings.frameW);
  psFrameH.value = String(settings.frameH);
  psSmoothThumbnails.checked = settings.smoothThumbnails !== false;
  psPixelSnapper.checked = settings.pixelSnapperEnabled === true;
  psPixelSnapperPalette.innerHTML = '';
  psPixelSnapperPalette.appendChild(new Option('(active palette)', ''));
  psPixelSnapperPalette.appendChild(new Option('(none — full RGB)', 'none'));
  for (const p of project.palettes) psPixelSnapperPalette.appendChild(new Option(p.name, p.id));
  psPixelSnapperPalette.value = settings.pixelSnapperPaletteId ?? '';
  syncPaletteReset();
  psPixelSnapperKColors.value = String(settings.pixelSnapperKColors ?? MAX_PALETTE_COLORS);
  syncKColorsReset();
  psPixelSnapperPixelSize.value = settings.pixelSnapperPixelSizeOverride != null ? String(settings.pixelSnapperPixelSizeOverride) : '';
  syncPixelSizeReset();
  for (const [, key] of PS_ADVANCED_FIELDS) {
    psAdvancedInputs[key].value = String(settings[key] ?? DEFAULT_SETTINGS[key]);
    psAdvancedResetSyncs[key]();
  }
  psTargetPlatform.value = settings.targetPlatform ?? 'none';
  psExportColorMode.value = settings.exportColorMode ?? 'strict';
  psSpriteLock.resnap();
  psTileSheetLock.resnap();
  psTileSizeLock.resnap();
  psFrameLock.resnap();
  psDurationValue = { durationMs: settings.durationMs, baseFps: settings.baseFps, baseStep: settings.baseStep };
  psDurationControl.refresh();
  for (const r of onionStepRows) {
    const backOverride = state.onion.stepColors.back[r.k];
    r.backDefault.checked = backOverride == null;
    r.backColor.value = backOverride ?? state.onion.backColor;
    syncOnionStepActive(r.backDefault, r.backColor);
    const aheadOverride = state.onion.stepColors.ahead[r.k];
    r.aheadDefault.checked = aheadOverride == null;
    r.aheadColor.value = aheadOverride ?? state.onion.aheadColor;
    syncOnionStepActive(r.aheadDefault, r.aheadColor);
  }
  showProjectSettingsTab(tab);
  dlgProjectSettings.showModal();
}

defineAction('edit.projectSettings', {
  label: 'Project Settings…',
  run: () => openProjectSettings('general'),
  isEnabled: () => !!state.project,
});
defineAction('edit.onionStepColors', {
  label: 'Onion Step Colors…',
  run: () => openProjectSettings('onion'),
  isEnabled: () => !!state.project,
});
psCancel.addEventListener('click', () => dlgProjectSettings.close());
psOk.addEventListener('click', () => {
  const project = state.project;
  if (!project) { dlgProjectSettings.close(); return; }
  const name = psName.value.trim();
  if (!name) {
    alert('Please enter a project name.');
    return;
  }
  const dims = {
    spriteSheetW: sheetDimField(psSpriteW), spriteSheetH: sheetDimField(psSpriteH),
    tileSheetW: sheetDimField(psTileSheetW), tileSheetH: sheetDimField(psTileSheetH),
    tileW: positiveIntField(psTileW), tileH: positiveIntField(psTileH),
    frameW: positiveIntField(psFrameW), frameH: positiveIntField(psFrameH),
  };
  if (Object.values(dims).some(v => v == null)) {
    alert('Please enter valid positive numbers for all fields.');
    return;
  }
  const invalidPs = firstInvalidPsField();
  if (invalidPs) {
    const step = invalidPs.input.step;
    const stepNote = (step && step !== '1' && step !== 'any') ? `, step ${step}` : '';
    alert(`"${invalidPs.label}" is ${invalidPs.input.validationMessage || 'not a valid value'} (allowed: ${invalidPs.input.min}–${invalidPs.input.max}${stepNote}).`);
    invalidPs.input.focus();
    return;
  }
  const beforeName = project.name;
  const beforeSettings = { ...project.settings };
  // Preserve every OTHER settings field (onion, etc.) verbatim -- this dialog
  // only edits dims/duration/name, so starting from a bare `{...dims, ...}`
  // object here would silently drop anything it doesn't know about (bit us
  // once already: onion-skin prefs got wiped on every Project Settings save).
  // baseFps/baseStep are the one exception: they need to be explicitly
  // dropped, not carried over, when switching back to plain ms mode, or a
  // stale fps-mode value would leak back in since the dims spread below
  // never overwrites them with anything absent.
  const { baseFps: _droppedBaseFps, baseStep: _droppedBaseStep, ...restSettings } = project.settings;
  const afterName = name;
  const afterSettings = {
    ...restSettings, ...dims, durationMs: psDurationValue.durationMs,
    ...(psDurationValue.baseFps != null ? { baseFps: psDurationValue.baseFps, baseStep: psDurationValue.baseStep } : {}),
    smoothThumbnails: psSmoothThumbnails.checked,
    pixelSnapperEnabled: psPixelSnapper.checked,
    pixelSnapperPaletteId: psPixelSnapperPalette.value,
    // firstInvalidPsField() already blocked save (above) if either of
    // these were out of range, so a plain parseInt here is exactly what
    // was typed/left -- no silent clamping.
    pixelSnapperKColors: parseInt(psPixelSnapperKColors.value, 10),
    pixelSnapperPixelSizeOverride: psPixelSnapperPixelSize.value.trim() === '' ? null : parseInt(psPixelSnapperPixelSize.value, 10),
    ...Object.fromEntries(PS_ADVANCED_FIELDS.map(([, key]) => [key, psAdvancedValue(key)])),
    targetPlatform: psTargetPlatform.value,
    exportColorMode: psExportColorMode.value,
  };
  state.commands.push({
    label: 'edit project settings',
    do() { project.name = afterName; project.settings = { ...afterSettings }; },
    undo() { project.name = beforeName; project.settings = { ...beforeSettings }; },
  });
  // Onion step colors are live-mutated state (never go through the undo
  // stack, same as every other onion field -- see state.js's state.onion
  // comment), applied here alongside the undoable dims/name command so one
  // OK commits everything the dialog showed, on whichever tab it's on.
  const stepColors = { back: {}, ahead: {} };
  for (const r of onionStepRows) {
    if (!r.backDefault.checked) stepColors.back[r.k] = r.backColor.value;
    if (!r.aheadDefault.checked) stepColors.ahead[r.k] = r.aheadColor.value;
  }
  state.onion.stepColors = stepColors;
  markDirty();
  dlgProjectSettings.close();
});

// ---- file: Open ----
// Folder ("unpacked") projects are disabled for now (see io.saveUnpacked/
// openUnpacked, kept but unwired) -- Open always goes straight to the
// packed (.pixelproj) file picker, no format-choice dialog.
defineAction('file.open', {
  label: 'Open',
  run: async () => {
    if (state.dirty && !confirmOrAuto('Discard unsaved changes and open another project?')) return;
    try {
      const { project, handle } = await io.openPacked();
      state.fileHandle = handle;
      state.dirHandle = null;
      state.saveMode = handle ? 'packed' : null;
      setProject(project);
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
    state.dirty = false;
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
    state.dirty = false;
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
// Operates on state.selectedAnimationId (the animation currently selected
// in the Animation panel/timeline) -- not a picker, so these three formats
// are static, registered once like every other export action here.
function runOnSelectedAnimation(format) {
  const sheet = activeSheet();
  const anim = sheet?.animations.find(a => a.id === state.selectedAnimationId);
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
  isEnabled: () => activeSheet()?.kind === 'sprite' && !!state.selectedAnimationId,
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
  if (state.dirty && !AUTOTEST) { e.preventDefault(); e.returnValue = ''; }
});

// ---- autosave ----
setInterval(() => {
  if (state.dirty && state.project && !state.floating) io.autosave(state.project).catch(() => {});
}, 30000);

// ---- boot ----
(async function boot() {
  let restored = null;
  try {
    restored = AUTOTEST ? null : await io.loadAutosave();
  } catch (e) {
    restored = null;
  }
  if (restored && confirm('An autosaved project was found. Restore it?')) {
    setProject(restored);
  } else {
    setProject(newDefaultProject());
  }
})();
