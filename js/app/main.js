import { state, on, emit, activeSheet, setProject, newDemoProject } from './state.js';
import * as io from './io.js';
import { flattenSheet } from '../core/model.js';
import { CanvasView } from '../ui/canvasview.js';

function isCancel(e) {
  return e?.name === 'AbortError' || e?.message === 'cancelled';
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

const dlgSaveAs = document.getElementById('dlg-saveas');
const btnSaveAsPacked = document.getElementById('saveas-packed');
const btnSaveAsUnpacked = document.getElementById('saveas-unpacked');
const btnSaveAsCancel = document.getElementById('saveas-cancel');

const dlgExport = document.getElementById('dlg-export');
const btnExportPng = document.getElementById('export-png');
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

// ---- file: New ----
btnNew.addEventListener('click', () => {
  if (state.dirty && !confirm('Discard unsaved changes and start a new project?')) return;
  state.fileHandle = null; state.dirHandle = null; state.saveMode = null;
  setProject(newDemoProject());
});

// ---- file: Open ----
btnOpen.addEventListener('click', async () => {
  try {
    const { project, handle } = await io.openPacked();
    state.fileHandle = handle;
    state.dirHandle = null;
    state.saveMode = handle ? 'packed' : null;
    setProject(project);
  } catch (e) {
    if (!isCancel(e)) throw e;
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
btnExport.addEventListener('click', () => dlgExport.showModal());
btnExportCancel.addEventListener('click', () => dlgExport.close());
btnExportPng.addEventListener('click', async () => {
  dlgExport.close();
  const sheet = activeSheet();
  if (!sheet || !state.project) return;
  const bitmap = flattenSheet(sheet);
  const blob = await io.exportPngBlob(bitmap);
  io.downloadBlob(blob, `${state.project.name}-${sheet.name}.png`);
});

// ---- beforeunload guard ----
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ---- autosave ----
setInterval(() => {
  if (state.dirty && state.project) io.autosave(state.project).catch(() => {});
}, 30000);

// ---- boot ----
(async function boot() {
  let restored = null;
  try {
    restored = await io.loadAutosave();
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
