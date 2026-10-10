import { flattenSheet } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';
import { MAX_MASK_SIZE } from '../../core/brushes.js';
import { colorFrequency } from '../../core/quantize.js';
import { PLATFORMS, checkItemAgainstPlatform } from '../../core/platforms.js';
import { CanvasView } from '../../components/canvas/canvas-view.js';
import { mountToolPalette } from '../../components/tool-palette.js';
import { bindDrawing } from '../../components/canvas/drawing-engine.js';
import { mountColorPanel } from '../../components/panels/color-panel.js';
import { mountLayersPanel } from '../../components/panels/layers-panel.js';
import { drawSheetOverlays } from '../../components/canvas/sheet-overlays.js';
import { mountPreviewPanel } from '../../components/panels/preview-panel.js';
import { activeFloating, initFloatSession } from '../../components/canvas/float-session.js';
import { defineAction } from '../shell/actions.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeSheet } from '../../host/document-helpers.js';
import { documentKey } from '../../host/editor-store.js';
import { PanelManager } from '../../host/workbench/panel-manager.js';
import { findWorkbenchRegions } from '../../host/workbench/layout.js';
import { isTypingTarget } from '../../components/dom-utils.js';
import { applyViewControllers } from './view-switching.js';

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
    const drawing = editorHost.store.getState().workspace.drawing;
    if (e.key === '[') {
      e.preventDefault();
      const cur = drawing.brush;
      editorHost.store.updateDrawingSettings({ brush: { ...cur, mask: { ...cur.mask, size: Math.max(1, cur.mask.size - 1) } } });
    } else if (e.key === ']') {
      e.preventDefault();
      const cur = drawing.brush;
      editorHost.store.updateDrawingSettings({ brush: { ...cur, mask: { ...cur.mask, size: Math.min(MAX_MASK_SIZE, cur.mask.size + 1) } } });
    } else if (e.key.toLowerCase() === 'x') {
      e.preventDefault();
      editorHost.store.updateDrawingSettings({ primary: drawing.secondary, secondary: drawing.primary });
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
  // own editor (active view 'frame'/'tile'), since that's the one item whose
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
      : view === 'sprites.frame' || view === 'animations.canvas' ? sheet.frames?.find(f => f.id === selection?.frameId)
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
  editorHost.history.subscribe(updateStatusPlatform);
  editorHost.store.subscribe(
    s => [
      s.project.model,
      s.session.activeViewId,
      s.session.activeDocument,
      s.session.selectionsByDocument[documentKey(s.session.activeDocument)],
      s.workspace.pixelRevision,
    ],
    updateStatusPlatform,
    // activeDocument compared by {kind,id}, not reference -- DocumentService
    // allocates a fresh object per call; reference equals would re-run this
    // (flattenSheet + colorFrequency) on every setActive(), even a no-op one.
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2]?.id === b[2]?.id && a[2]?.kind === b[2]?.kind && a[3] === b[3] && a[4] === b[4], fireImmediately: true },
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
      const bitmap = flattenSheet(sheet, activeFloating(), canvasPreviewLayers);
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
  // Project replacement activates its document after notifying project subscribers.
  // Also refresh when switching sheets within the same view; repaint alone leaves
  // CanvasView's logical dimensions at zero (startup) or at the previous sheet size.
  editorHost.store.subscribe(s => documentKey(s.session.activeDocument), refreshCanvasView);
  // Show Labels / Show Sequences: repaint directly off the host store rather than the
  // legacy 'view' bus — file-controller.js's overlays mirror still emits 'view' for the
  // benefit of not-yet-migrated files, but nothing in this file listens for it anymore.
  editorHost.store.subscribe(
    s => [s.workspace.overlays.labels, s.workspace.overlays.sequences],
    () => canvasView.requestRender(),
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  // pixelRevision: lightweight bitmap-changed-mid-stroke signal from drawing-engine.js/layers-panel.js
  // (in-progress drawing preview, live opacity drag) — just re-flatten + repaint,
  // skip the heavier setContent/dirty-flag work that a project-model change does.
  editorHost.store.subscribe(s => s.workspace.pixelRevision, () => {
    invalidateScratch();
    canvasView.requestRender();
    mapCanvasView.requestRender();
  });
  // undo/redo can touch pixels, layer structure, or both — repaint on every change.
  editorHost.history.subscribe(() => { invalidateScratch(); refreshCanvasView(); });
  // frame/tile selection changed (no pixel or structural change) — cheap repaint
  // so the label-overlay highlight tracks the selected frame immediately.
  editorHost.store.subscribe(
    s => s.session.selectionsByDocument[documentKey(s.session.activeDocument)],
    () => { canvasView.requestRender(); mapCanvasView.requestRender(); },
  );
  
  // The sheet view's paint/float/paste target: the whole sheet. (Accepted
  // strips used to narrow it to their own frames; v4 has no layer ownership.)
  function sheetTargetRect() {
    const sheet = activeSheet();
    return sheet ? { x: 0, y: 0, w: sheet.width, h: sheet.height } : { x: 0, y: 0, w: 0, h: 0 };
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
  const mapEditor = viewControllers.get('maps.canvas');

  // ---- view: zoom ----
  function activeCanvasView() {
    const s = editorHost.store.getState().session;
    return s.activeModeId === 'maps' ? mapEditor.view : (viewControllers.get(s.activeViewId)?.view ?? canvasView);
  }
  defineAction('view.zoomIn', { label: 'Zoom In', run: () => activeCanvasView().zoomIn() });
  defineAction('view.zoomOut', { label: 'Zoom Out', run: () => activeCanvasView().zoomOut() });
  defineAction('view.actualSize', { label: 'Actual Size (100%)', run: () => activeCanvasView().actualSize() });
  defineAction('view.zoomToFit', { label: 'Zoom to Fit', run: () => activeCanvasView().fitToView() });

  // ---- view switching (see view-switching.js): one view is visible at a
  // time; the Frame Editor, Tile Editor and Animations canvas each own a
  // CanvasView in their own child of #canvas-host, while the sheet views share
  // the sheet canvas.
  function applyView() {
    applyViewControllers(editorHost.store.getState().session.activeViewId, viewControllers, canvasView.canvas);
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
