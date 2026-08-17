import { state, on, emit, activeSheet, activeLayer } from '../../app/state.js';
import { flattenSheet, layerAnimationContext } from '../../core/model.js';
import { segmentsOf, segmentOfFrame, segmentOfPoint, segmentBounds } from '../../core/strips.js';
import { copyRegion } from '../../core/pixels.js';
import { colorFrequency } from '../../core/quantize.js';
import { PLATFORMS, checkItemAgainstPlatform } from '../../core/platforms.js';
import { CanvasView } from '../../components/canvas/canvas-view.js';
import { mountToolPalette } from '../../components/tool-palette.js';
import { bindDrawing } from '../../components/canvas/drawing-engine.js';
import { mountColorPanel } from '../../components/panels/color-panel.js';
import { mountLayersPanel } from '../../components/panels/layers-panel.js';
import { drawSheetOverlays } from '../../components/canvas/sheet-overlays.js';
import { mountPreviewPanel } from '../../components/panels/preview-panel.js';
import { initFloatSession } from '../../components/canvas/float-session.js';
import { defineAction } from '../../app/actions.js';
import { getEditorHost } from '../../host/runtime.js';
import { PanelManager } from '../../host/workbench/panel-manager.js';
import { findWorkbenchRegions } from '../../host/workbench/layout.js';
import { isTypingTarget } from '../../components/dom-utils.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function mountEditorWorkbench() {
  const editorHost = getEditorHost();
  const statusTool = document.getElementById('status-tool');
  const statusPlatform = document.getElementById('status-platform');
  const statusPos = document.getElementById('status-pos');
  const statusZoom = document.getElementById('status-zoom');
  const canvasHost = document.getElementById('canvas-host');

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
    run: () => editorHost.store.transaction('overlays', s => { s.workspace.overlays.labels = !s.workspace.overlays.labels; }),
    isChecked: () => editorHost.store.getState().workspace.overlays.labels,
  });
  defineAction('view.toggleSequences', {
    label: 'Show Sequences',
    run: () => editorHost.store.transaction('overlays', s => { s.workspace.overlays.sequences = !s.workspace.overlays.sequences; }),
    isChecked: () => editorHost.store.getState().workspace.overlays.sequences,
  });

  // ---- status bar ----
  function updateStatusTool() { statusTool.textContent = `Tool: ${editorHost.store.getState().session.activeToolId}`; }
  editorHost.store.subscribe(s => s.session.activeToolId, updateStatusTool, { fireImmediately: true });

  // Live per-item compatibility check against project.settings.targetPlatform
  // (js/core/platforms.js) -- only while a specific frame/tile is open in its
  // own editor (state.view 'frame'/'tile'), since that's the one item whose
  // pixels/size are meaningful to check in isolation. Recomputed on every
  // pixel/history/selection/project/view change; cheap enough at this app's
  // sheet sizes to just redo the flatten+color-scan rather than cache it.
  function updateStatusPlatform() {
    const project = editorHost.projects.project;
    const sheet = activeSheet();
    const platformId = project?.settings?.targetPlatform ?? 'none';
    const view = editorHost.store.getState().session.activeViewId;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    const selection = activeDoc ? editorHost.selections.get(activeDoc) : null;
    const rect = platformId === 'none' || !sheet ? null
      : view === 'sprites.frame' ? sheet.frames?.find(f => f.id === selection?.frameId)
      : view === 'tiles.tile' ? sheet.tiles?.find(t => t.id === selection?.tileId)
      : null;
    if (!rect) { statusPlatform.textContent = ''; statusPlatform.title = ''; return; }

    const bitmap = copyRegion(flattenSheet(sheet), rect.x, rect.y, rect.w, rect.h);
    const kind = view === 'tiles.tile' ? 'tile' : 'sprite';
    const warnings = checkItemAgainstPlatform(platformId, { colors: colorFrequency([bitmap]), w: rect.w, h: rect.h, kind });
    const label = PLATFORMS[platformId].label;
    statusPlatform.textContent = warnings.length ? `${label} ⚠ ${warnings.length}` : `${label} ✓`;
    statusPlatform.title = warnings.join('\n');
    statusPlatform.classList.toggle('status-platform-warn', warnings.length > 0);
  }
  on('pixels', updateStatusPlatform);
  on('selection', updateStatusPlatform);
  editorHost.history.subscribe(updateStatusPlatform);
  // tool-palette.js is not migrated yet (out of this task's scope) — it still
  // writes state.tool + emit('tool') only. Mirror that one-way into
  // session.activeToolId so switchMode's stale-tool fallback (document-
  // controller.js) and updateStatusTool above observe the real active tool.
  // Sync once immediately too: EditorStore's initial activeToolId (null)
  // doesn't match state.tool's legacy default ('pencil') until the first
  // 'tool' emit, which previously only happened via legacy-state-adapter's
  // one-time sync call that this task's Step 2 removed.
  const syncActiveTool = () => editorHost.store.updateSession({ activeToolId: state.tool }, 'tool');
  on('tool', syncActiveTool);
  syncActiveTool();
  editorHost.store.subscribe(
    s => [s.project.model, s.session.activeViewId, s.session.activeDocument],
    updateStatusPlatform,
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2], fireImmediately: true },
  );
  
  // ---- canvas view ----
  const canvasView = new CanvasView(canvasHost);
  canvasView.onStatus = ({ x, y, zoom }) => {
    statusPos.textContent = (x == null || y == null) ? '' : `${x},${y}`;
    statusZoom.textContent = `${zoom}x`;
  };
  const mapCanvasHost = document.createElement('div');
  mapCanvasHost.className = 'map-editor-host';
  mapCanvasHost.hidden = true;
  canvasHost.appendChild(mapCanvasHost);
  const mapCanvasView = new CanvasView(mapCanvasHost);
  mapCanvasView.onStatus = ({ x, y, zoom }) => {
    statusPos.textContent = (x == null || y == null) ? '' : `${x - 4096},${y - 4096}`;
    statusZoom.textContent = `${zoom}x`;
  };
  
  // scratch OffscreenCanvas caching the active sheet's flattened bitmap; only
  // re-flattened when the project changes, not on every paint (pan/zoom-driven).
  let scratchCanvas = null;
  let scratchDirty = true;
  let scratchSheet = null; // sheet identity — mode switches swap sheets of equal size
  function invalidateScratch() { scratchDirty = true; }
  // Set while a filter dialog's live preview is active: an overrideLayers
  // array (see model.js's flattenSheet) substituted into the main canvas's
  // own flatten pass, same mechanism previewpanel.js uses for the side
  // Preview panel -- real layer data is never touched by a preview.
  let canvasPreviewLayers = null;
  function pushCanvasPreview(layers) {
    canvasPreviewLayers = layers;
    invalidateScratch();
    canvasView.requestRender();
  }
  function clearCanvasPreview() {
    if (!canvasPreviewLayers) return;
    canvasPreviewLayers = null;
    invalidateScratch();
    canvasView.requestRender();
  }
  function getScratchCanvas() {
    const sheet = activeSheet();
    if (!sheet) return null;
    if (scratchDirty || scratchSheet !== sheet || !scratchCanvas || scratchCanvas.width !== sheet.width || scratchCanvas.height !== sheet.height) {
      const bitmap = flattenSheet(sheet, state.floating, canvasPreviewLayers);
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
    const maps = editorHost.store.getState().session.activeModeId === 'maps';
    canvasView.canvas.hidden = maps;
    mapCanvasHost.hidden = !maps;
    if (maps) { mapCanvasView.setContent({ width: 8192, height: 8192 }); mapCanvasView.requestRender(); return; }
    const sheet = activeSheet();
    if (sheet) canvasView.setContent({ width: sheet.width, height: sheet.height });
    canvasView.requestRender();
  }
  editorHost.store.subscribe(
    s => s.project.model,
    () => { invalidateScratch(); refreshCanvasView(); },
    { fireImmediately: true },
  );
  editorHost.store.subscribe(s => s.session.activeViewId, refreshCanvasView, { fireImmediately: true });
  // 'pixels': lightweight bitmap-changed-mid-stroke signal from drawing-engine.js/layers-panel.js
  // (in-progress drawing preview, live opacity drag) — just re-flatten + repaint,
  // skip the heavier setContent/dirty-flag work that a project-model change does.
  on('pixels', () => { invalidateScratch(); canvasView.requestRender(); });
  // undo/redo can touch pixels, layer structure, or both — repaint on every change.
  editorHost.history.subscribe(() => { invalidateScratch(); refreshCanvasView(); });
  // frame/tile selection changed (no pixel or structural change) — cheap repaint
  // so the label-overlay highlight tracks the selected frame immediately.
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
    const selectedFrameId = editorHost.selections.get(sheetDocument(sheet))?.frameId ?? null;
    let run = (x != null && y != null) ? segmentOfPoint(sheet, anim, x, y)
      : selectedFrameId ? segmentOfFrame(anim, selectedFrameId) : null;
    if (!run && x == null && y == null) run = segmentsOf(anim)[0] ?? null;
    return run ? segmentBounds(sheet, anim, run) : { x: 0, y: 0, w: 0, h: 0 };
  }
  
  // ---- registry-driven tools, panels, and views ----
  const contributionContext = Object.freeze({ editorHost, canvasHost, canvasView, mapCanvasView });
  mountToolPalette(document.getElementById('tool-panel'));
  bindDrawing(canvasView, sheetTargetRect);

  const toolControllers = editorHost.registries.tools.list()
    .map(definition => definition.createController(contributionContext) ?? {});
  {
    const priorOverlay = canvasView.onOverlay;
    canvasView.onOverlay = ctx => { priorOverlay(ctx); drawSheetOverlays(canvasView, ctx); };
  }
  for (const controller of toolControllers) controller.decorateOverlay?.();

  initFloatSession();
  mountColorPanel(document.getElementById('panel-colors'));
  mountLayersPanel(document.getElementById('panel-layers'));

  mountPreviewPanel(document.getElementById('panel-preview'));
  const panelManager = new PanelManager({
    registry: editorHost.registries.panels,
    contextKeys: editorHost.contextKeys,
    preferences: editorHost.preferences,
  });
  panelManager.setRegions(findWorkbenchRegions());
  panelManager.reconcile(contributionContext);
  editorHost.contextKeys.subscribe(() => panelManager.reconcile(contributionContext));

  const viewControllers = new Map();
  for (const definition of editorHost.registries.views.list()) {
    viewControllers.set(definition.id, definition.create(canvasHost, contributionContext) ?? {});
  }
  const frameEditor = viewControllers.get('sprites.frame');
  const tileEditor = viewControllers.get('tiles.tile');
  const mapEditor = viewControllers.get('maps.canvas');

  // ---- view: zoom ----
  function activeCanvasView() {
    const s = editorHost.store.getState().session;
    return s.activeModeId === 'maps' ? mapEditor.view : s.activeViewId === 'sprites.frame' ? frameEditor.view : s.activeViewId === 'tiles.tile' ? tileEditor.view : canvasView;
  }
  defineAction('view.zoomIn', { label: 'Zoom In', run: () => activeCanvasView().zoomIn() });
  defineAction('view.zoomOut', { label: 'Zoom Out', run: () => activeCanvasView().zoomOut() });
  defineAction('view.actualSize', { label: 'Actual Size (100%)', run: () => activeCanvasView().actualSize() });
  defineAction('view.zoomToFit', { label: 'Zoom to Fit', run: () => activeCanvasView().fitToView() });

  // ---- view switching: sheet canvas vs frame editor vs tile editor.
  // Only one is visible at a time; each owns its own CanvasView. The sheet
  // view's <canvas> is hidden directly (its host, #canvas-host, is shared with
  // the frame/tile editors' own child containers) rather than tearing anything down.
  function applyView() {
    const view = editorHost.store.getState().session.activeViewId;
    if (view === 'sprites.sheet' || view === 'tiles.sheet' || view === 'maps.canvas') {
      canvasView.canvas.style.display = '';
      frameEditor.hide();
      tileEditor.hide();
    } else if (view === 'sprites.frame') {
      canvasView.canvas.style.display = 'none';
      frameEditor.show();
      tileEditor.hide();
    } else {
      // 'tiles.tile'
      canvasView.canvas.style.display = 'none';
      frameEditor.hide();
      tileEditor.show();
    }
  }
  editorHost.store.subscribe(s => s.session.activeViewId, applyView, { fireImmediately: true });
  return Object.freeze({
    pushCanvasPreview,
    clearCanvasPreview,
    focusMap: () => mapEditor.focus(),
    fitSheet: () => canvasView.centerFit(),
    activeCanvasView,
  });
}
