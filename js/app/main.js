import { state, on, emit, activeSheet, activeLayer, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty } from './state.js';
import * as io from './io.js';
import { decodePng } from './pngcodec.js';
import { flattenSheet, createSheet, removeSheet, sheetLayers, layerAnimationContext, DEFAULT_SETTINGS } from '../core/model.js';
import { segmentsOf, segmentOfFrame, segmentOfPoint, segmentBounds } from '../core/strips.js';
import { buildFramesJson, buildTilesJson } from './exports.js';
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
import { initFloatSession, commitFloatIfAny, cutSelection, copySelection, paste, hasSelection } from '../ui/floatsession.js';
import { defineAction, runAction, bindAction } from './actions.js';
import { mountMenuBar } from '../ui/menubar.js';

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
const statusPos = document.getElementById('status-pos');
const statusZoom = document.getElementById('status-zoom');
const canvasHost = document.getElementById('canvas-host');

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
const npDurationMount = document.getElementById('np-duration-control');
let npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
const npDurationControl = buildBaseDurationControl({
  getValue: () => npDurationValue,
  setValue: (v) => { npDurationValue = v; },
});
npDurationMount.appendChild(npDurationControl.el);
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
document.getElementById('about-ok').addEventListener('click', () => dlgAbout.close());
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
document.getElementById('shortcuts-ok').addEventListener('click', () => dlgShortcuts.close());
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
    { action: 'document.renameSheet' }, { action: 'document.deleteSheet' },
  ] },
  { label: 'Layer', items: [
    { action: 'layer.add' }, { action: 'layer.addGroup' }, { separator: true },
    { action: 'layer.delete' }, { action: 'layer.mergeDown' },
  ] },
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
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
const psSpriteW = document.getElementById('ps-sprite-w');
const psSpriteH = document.getElementById('ps-sprite-h');
const psTileSheetW = document.getElementById('ps-tile-sheet-w');
const psTileSheetH = document.getElementById('ps-tile-sheet-h');
const psTileW = document.getElementById('ps-tile-w');
const psTileH = document.getElementById('ps-tile-h');
const psFrameW = document.getElementById('ps-frame-w');
const psFrameH = document.getElementById('ps-frame-h');
const psDurationMount = document.getElementById('ps-duration-control');
const psOk = document.getElementById('ps-ok');
const psCancel = document.getElementById('ps-cancel');

let psDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
const psDurationControl = buildBaseDurationControl({
  getValue: () => psDurationValue,
  setValue: (v) => { psDurationValue = v; },
});
psDurationMount.appendChild(psDurationControl.el);

defineAction('edit.projectSettings', {
  label: 'Project Settings…',
  run: () => {
    const settings = state.project?.settings;
    if (!settings) return;
    psSpriteW.value = String(settings.spriteSheetW);
    psSpriteH.value = String(settings.spriteSheetH);
    psTileSheetW.value = String(settings.tileSheetW);
    psTileSheetH.value = String(settings.tileSheetH);
    psTileW.value = String(settings.tileW);
    psTileH.value = String(settings.tileH);
    psFrameW.value = String(settings.frameW);
    psFrameH.value = String(settings.frameH);
    psDurationValue = { durationMs: settings.durationMs, baseFps: settings.baseFps, baseStep: settings.baseStep };
    psDurationControl.refresh();
    dlgProjectSettings.showModal();
  },
  isEnabled: () => !!state.project,
});
psCancel.addEventListener('click', () => dlgProjectSettings.close());
psOk.addEventListener('click', () => {
  const project = state.project;
  if (!project) { dlgProjectSettings.close(); return; }
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
  const before = { ...project.settings };
  const after = {
    ...dims, durationMs: psDurationValue.durationMs,
    ...(psDurationValue.baseFps != null ? { baseFps: psDurationValue.baseFps, baseStep: psDurationValue.baseStep } : {}),
  };
  state.commands.push({
    label: 'edit project settings',
    do() { project.settings = { ...after }; },
    undo() { project.settings = { ...before }; },
  });
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
function updateExportButtons() {
  const sheet = activeSheet();
  const isSprite = sheet?.kind === 'sprite';
  const isTile = sheet?.kind === 'tile';
  btnExportFrames.disabled = !isSprite;
  btnExportFrames.title = isSprite ? '' : 'Only available for sprite sheets';
  btnExportTiles.disabled = !isTile;
  btnExportTiles.title = isTile ? '' : 'Only available for tile sheets';
}
defineAction('file.export', {
  label: 'Export…',
  run: () => { updateExportButtons(); dlgExport.showModal(); },
  isEnabled: () => !!state.project,
});
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
})();
