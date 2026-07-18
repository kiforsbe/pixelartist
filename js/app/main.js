import { state, on, emit, activeSheet, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty } from './state.js';
import * as io from './io.js';
import { decodePng } from './pngcodec.js';
import { flattenSheet, createSheet, sheetLayers } from '../core/model.js';
import { buildFramesJson, buildTilesJson } from './exports.js';
import { CanvasView } from '../ui/canvasview.js';
import { mountToolPalette, bindDrawing } from '../ui/tools.js';
import { mountColorPanel, mountLayersPanel } from '../ui/panels.js';
import { registerFrameTool, bindFrameTool, mountFramesPanel, drawStripChrome } from '../ui/frames.js';
import { registerTileTool, bindTileTool, mountTilePanel, mountAutotilesPanel, mountTileLayersPanel, drawTileChrome } from '../ui/tilemode.js';
import { drawSheetOverlays } from '../ui/overlays.js';
import { mountTimeline } from '../ui/timeline.js';
import { mountFrameEditor } from '../ui/frameeditor.js';
import { mountTileEditor } from '../ui/tileeditor.js';
import { initFloatSession, commitFloatIfAny } from '../ui/floatsession.js';

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

// ---- element refs ----
const tabSprites = document.getElementById('tab-sprites');
const tabTiles = document.getElementById('tab-tiles');
const btnNew = document.getElementById('btn-new');
const btnOpen = document.getElementById('btn-open');
const btnSave = document.getElementById('btn-save');
const btnSaveAs = document.getElementById('btn-save-as');
const btnExport = document.getElementById('btn-export');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const ovlLabels = document.getElementById('ovl-labels');
const ovlSeq = document.getElementById('ovl-seq');
const statusTool = document.getElementById('status-tool');
const statusPos = document.getElementById('status-pos');
const statusZoom = document.getElementById('status-zoom');
const canvasHost = document.getElementById('canvas-host');

const dlgOpen = document.getElementById('dlg-open');
const btnOpenPacked = document.getElementById('open-packed');
const btnOpenUnpacked = document.getElementById('open-unpacked');
const btnOpenCancel = document.getElementById('open-cancel');

const dlgSaveAs = document.getElementById('dlg-saveas');
const btnSaveAsPacked = document.getElementById('saveas-packed');
const btnSaveAsUnpacked = document.getElementById('saveas-unpacked');
const btnSaveAsCancel = document.getElementById('saveas-cancel');

const dlgExport = document.getElementById('dlg-export');
const btnExportPng = document.getElementById('export-png');
const btnExportFrames = document.getElementById('export-frames');
const btnExportTiles = document.getElementById('export-tiles');
const btnExportCancel = document.getElementById('export-cancel');

const sheetSelect = document.getElementById('sheet-select');
const btnNewSheet = document.getElementById('btn-new-sheet');
const btnImportSheet = document.getElementById('btn-import-sheet');
const dlgNewSheet = document.getElementById('dlg-newsheet');
const nsName = document.getElementById('ns-name');
const nsW = document.getElementById('ns-w');
const nsH = document.getElementById('ns-h');
const nsCreate = document.getElementById('ns-create');
const nsCancel = document.getElementById('ns-cancel');

const dlgNewProject = document.getElementById('dlg-newproject');
const npSpriteW = document.getElementById('np-sprite-w');
const npSpriteH = document.getElementById('np-sprite-h');
const npTileSheetW = document.getElementById('np-tile-sheet-w');
const npTileSheetH = document.getElementById('np-tile-sheet-h');
const npTileW = document.getElementById('np-tile-w');
const npTileH = document.getElementById('np-tile-h');
const npFrameW = document.getElementById('np-frame-w');
const npFrameH = document.getElementById('np-frame-h');
const npDuration = document.getElementById('np-duration');
const npCreate = document.getElementById('np-create');
const npCancel = document.getElementById('np-cancel');

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
btnNewSheet.addEventListener('click', () => {
  if (!state.project) return;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const settings = state.project.settings;
  const n = state.project.sheets.filter(s => s.kind === kind).length + 1;
  nsName.value = `sheet_${n}`;
  nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
  nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
  dlgNewSheet.showModal();
});
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
btnImportSheet.addEventListener('click', async () => {
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
  const project = state.project;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const name = file.name.replace(/\.[^.]+$/, '') || 'imported';
  const sheet = createSheet(project, {
    name, width: bitmap.width, height: bitmap.height, kind,
  });
  sheetLayers(sheet)[0].bitmap = bitmap;
  commitAddSheet(sheet);
});

// ---- rename sheet ----
const btnRenameSheet = document.getElementById('btn-rename-sheet');
const dlgRenameSheet = document.getElementById('dlg-renamesheet');
const rsName = document.getElementById('rs-name');
const rsOk = document.getElementById('rs-ok');
const rsCancel = document.getElementById('rs-cancel');
btnRenameSheet.addEventListener('click', () => {
  const sheet = activeSheet();
  if (!sheet) return;
  rsName.value = sheet.name;
  dlgRenameSheet.showModal();
});
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

// ---- undo/redo ----
function updateHistoryButtons() {
  btnUndo.disabled = !state.commands.canUndo();
  btnRedo.disabled = !state.commands.canRedo();
}
state.commands.onChange = () => { updateHistoryButtons(); emit('history'); };
btnUndo.addEventListener('click', () => state.commands.undo());
btnRedo.addEventListener('click', () => state.commands.redo());
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); state.commands.undo(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); state.commands.redo(); }
  else if (key === 's') {
    // Gated (unlike undo/redo above): Ctrl+S is a global browser shortcut
    // users may also press while a text field or dialog has focus, where we
    // want the browser/native field behavior, not a project save.
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    e.preventDefault();
    doSave();
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
ovlLabels.addEventListener('change', () => {
  state.overlays.labels = ovlLabels.checked;
  emit('view');
});
ovlSeq.addEventListener('change', () => {
  state.overlays.sequences = ovlSeq.checked;
  emit('view');
});

// ---- status bar ----
function updateStatusTool() { statusTool.textContent = `Tool: ${state.tool}`; }
on('tool', updateStatusTool);
updateStatusTool();

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

// ---- drawing tools + panels ----
mountToolPalette(document.getElementById('tool-panel'));
bindDrawing(canvasView, () => {
  const sheet = activeSheet();
  return sheet ? { x: 0, y: 0, w: sheet.width, h: sheet.height } : { x: 0, y: 0, w: 0, h: 0 };
});
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
mountTilePanel(document.getElementById('panel-context'));
mountAutotilesPanel(document.getElementById('panel-autotiles'));
mountTileLayersPanel(document.getElementById('panel-tilelayers'));
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
btnNew.addEventListener('click', () => {
  if (state.dirty && !confirmOrAuto('Discard unsaved changes and start a new project?')) return;
  dlgNewProject.showModal();
});
npCancel.addEventListener('click', () => dlgNewProject.close());
npCreate.addEventListener('click', () => {
  // Sheet dims (sprite/tile sheet W/H) are clamped to the 1..4096 range;
  // everything else (tile size, frame size, duration) just needs to be a
  // positive integer. Any NaN or sub-1 value aborts with an alert rather
  // than silently coercing, so e.g. a blank or 0 sprite width is rejected.
  const sheetDim = (el) => {
    const v = parseInt(el.value, 10);
    return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
  };
  const positiveInt = (el) => {
    const v = parseInt(el.value, 10);
    return (Number.isNaN(v) || v < 1) ? null : v;
  };
  const spriteSheetW = sheetDim(npSpriteW);
  const spriteSheetH = sheetDim(npSpriteH);
  const tileSheetW = sheetDim(npTileSheetW);
  const tileSheetH = sheetDim(npTileSheetH);
  const tileW = positiveInt(npTileW);
  const tileH = positiveInt(npTileH);
  const frameW = positiveInt(npFrameW);
  const frameH = positiveInt(npFrameH);
  const durationMs = positiveInt(npDuration);
  const settings = { spriteSheetW, spriteSheetH, tileSheetW, tileSheetH, tileW, tileH, frameW, frameH, durationMs };
  if (Object.values(settings).some(v => v == null)) {
    alert('Please enter valid positive numbers for all fields.');
    return;
  }
  state.fileHandle = null; state.dirHandle = null; state.saveMode = null;
  setProject(newDefaultProject(settings));
  dlgNewProject.close();
});

// ---- file: Open ----
if (!io.supportsFS()) btnOpenUnpacked.hidden = true;
btnOpen.addEventListener('click', () => {
  if (state.dirty && !confirmOrAuto('Discard unsaved changes and open another project?')) return;
  dlgOpen.showModal();
});
btnOpenCancel.addEventListener('click', () => dlgOpen.close());
btnOpenPacked.addEventListener('click', async () => {
  dlgOpen.close();
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
});
btnOpenUnpacked.addEventListener('click', async () => {
  dlgOpen.close();
  try {
    const { project, dirHandle } = await io.openUnpacked();
    state.dirHandle = dirHandle;
    state.fileHandle = null;
    state.saveMode = 'unpacked';
    setProject(project);
  } catch (e) {
    if (isCancel(e)) return;
    alert(e.message);
  }
});

// ---- file: Save ----
async function doSave() {
  commitFloatIfAny();
  if (!state.saveMode) { dlgSaveAs.showModal(); return; }
  try {
    if (state.saveMode === 'unpacked') {
      state.dirHandle = await io.saveUnpacked(state.project, state.dirHandle);
    } else {
      state.fileHandle = await io.savePacked(state.project, state.fileHandle);
      state.saveMode = 'packed';
    }
    state.dirty = false;
    await io.clearAutosave().catch(() => {});
    emit('project');
  } catch (e) {
    if (!isCancel(e)) alert(`Save failed: ${e.message}`);
  }
}
btnSave.addEventListener('click', doSave);

// ---- file: Save As ----
if (!io.supportsFS()) btnSaveAsUnpacked.hidden = true;
btnSaveAs.addEventListener('click', () => dlgSaveAs.showModal());
btnSaveAsCancel.addEventListener('click', () => dlgSaveAs.close());
btnSaveAsPacked.addEventListener('click', async () => {
  dlgSaveAs.close();
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
});
btnSaveAsUnpacked.addEventListener('click', async () => {
  dlgSaveAs.close();
  commitFloatIfAny();
  try {
    state.dirHandle = await io.saveUnpacked(state.project, null);
    state.fileHandle = null;
    state.saveMode = 'unpacked';
    state.dirty = false;
    await io.clearAutosave().catch(() => {});
    emit('project');
  } catch (e) {
    if (!isCancel(e)) alert(`Save failed: ${e.message}`);
  }
});

// ---- export ----
function updateExportButtons() {
  const sheet = activeSheet();
  const isSprite = sheet?.kind === 'sprite';
  const isTile = sheet?.kind === 'tile';
  btnExportFrames.disabled = !isSprite;
  btnExportFrames.title = isSprite ? '' : 'Only available for sprite sheets';
  btnExportTiles.disabled = !isTile;
  btnExportTiles.title = isTile ? '' : 'Only available for tile sheets';
}
btnExport.addEventListener('click', () => { updateExportButtons(); dlgExport.showModal(); });
btnExportCancel.addEventListener('click', () => dlgExport.close());
btnExportPng.addEventListener('click', async () => {
  dlgExport.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet || !state.project) return;
  const bitmap = flattenSheet(sheet);
  const blob = await io.exportPngBlob(bitmap);
  io.downloadBlob(blob, `${state.project.name}-${sheet.name}.png`);
});
btnExportFrames.addEventListener('click', () => {
  dlgExport.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet || sheet.kind !== 'sprite') return;
  const json = buildFramesJson(sheet);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  io.downloadBlob(blob, `${sheet.name}.frames.json`);
});
btnExportTiles.addEventListener('click', () => {
  dlgExport.close();
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet || sheet.kind !== 'tile') return;
  const json = buildTilesJson(sheet);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  io.downloadBlob(blob, `${sheet.name}.tiles.json`);
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
  updateHistoryButtons();
})();
