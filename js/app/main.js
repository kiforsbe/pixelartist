import { state, on, emit, activeSheet, setProject, newDemoProject, AUTOTEST, confirmOrAuto } from './state.js';
import * as io from './io.js';
import { flattenSheet } from '../core/model.js';
import { buildFramesJson, buildTilesJson } from './exports.js';
import { CanvasView } from '../ui/canvasview.js';
import { mountToolPalette, bindDrawing } from '../ui/tools.js';
import { mountColorPanel, mountLayersPanel } from '../ui/panels.js';
import { registerFrameTool, bindFrameTool, mountFramesPanel } from '../ui/frames.js';
import { registerTileTool, bindTileTool, mountTilePanel } from '../ui/tilemode.js';
import { drawSheetOverlays } from '../ui/overlays.js';
import { mountTimeline } from '../ui/timeline.js';
import { mountFrameEditor } from '../ui/frameeditor.js';
import { mountTileEditor } from '../ui/tileeditor.js';

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

// ---- mode tabs ----
function switchMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  tabSprites.classList.toggle('active', mode === 'sprites');
  tabTiles.classList.toggle('active', mode === 'tiles');
  const kind = mode === 'sprites' ? 'sprite' : 'tile';
  const sheet = state.project?.sheets.find(s => s.kind === kind) ?? null;
  state.activeSheetId = sheet ? sheet.id : null;
  state.activeLayerId = sheet ? (sheet.layers[0]?.id ?? null) : null;
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
function invalidateScratch() { scratchDirty = true; }
function getScratchCanvas() {
  const sheet = activeSheet();
  if (!sheet) return null;
  if (scratchDirty || !scratchCanvas || scratchCanvas.width !== sheet.width || scratchCanvas.height !== sheet.height) {
    const bitmap = flattenSheet(sheet);
    if (!scratchCanvas || scratchCanvas.width !== bitmap.width || scratchCanvas.height !== bitmap.height) {
      scratchCanvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    }
    const sctx = scratchCanvas.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.putImageData(new ImageData(bitmap.data, bitmap.width, bitmap.height), 0, 0);
    scratchDirty = false;
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
mountToolPalette(document.getElementById('tool-palette'));
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
mountColorPanel(document.getElementById('panel-colors'));
mountLayersPanel(document.getElementById('panel-layers'));
mountFramesPanel(document.getElementById('panel-context'));
mountTilePanel(document.getElementById('panel-context'));
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
  state.fileHandle = null; state.dirHandle = null; state.saveMode = null;
  setProject(newDemoProject());
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
    if (!isCancel(e)) throw e;
  }
}
btnSave.addEventListener('click', doSave);

// ---- file: Save As ----
if (!io.supportsFS()) btnSaveAsUnpacked.hidden = true;
btnSaveAs.addEventListener('click', () => dlgSaveAs.showModal());
btnSaveAsCancel.addEventListener('click', () => dlgSaveAs.close());
btnSaveAsPacked.addEventListener('click', async () => {
  dlgSaveAs.close();
  try {
    state.fileHandle = await io.savePacked(state.project, null);
    state.dirHandle = null;
    state.saveMode = 'packed';
    state.dirty = false;
    await io.clearAutosave().catch(() => {});
    emit('project');
  } catch (e) {
    if (!isCancel(e)) throw e;
  }
});
btnSaveAsUnpacked.addEventListener('click', async () => {
  dlgSaveAs.close();
  try {
    state.dirHandle = await io.saveUnpacked(state.project, null);
    state.fileHandle = null;
    state.saveMode = 'unpacked';
    state.dirty = false;
    await io.clearAutosave().catch(() => {});
    emit('project');
  } catch (e) {
    if (!isCancel(e)) throw e;
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
  const sheet = activeSheet();
  if (!sheet || !state.project) return;
  const bitmap = flattenSheet(sheet);
  const blob = await io.exportPngBlob(bitmap);
  io.downloadBlob(blob, `${state.project.name}-${sheet.name}.png`);
});
btnExportFrames.addEventListener('click', () => {
  dlgExport.close();
  const sheet = activeSheet();
  if (!sheet || sheet.kind !== 'sprite') return;
  const json = buildFramesJson(sheet);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  io.downloadBlob(blob, `${sheet.name}.frames.json`);
});
btnExportTiles.addEventListener('click', () => {
  dlgExport.close();
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
  if (state.dirty && state.project) io.autosave(state.project).catch(() => {});
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
    setProject(newDemoProject());
  }
  updateHistoryButtons();
})();
