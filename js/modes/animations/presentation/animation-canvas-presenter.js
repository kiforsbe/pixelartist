// js/modes/animations/presentation/animation-canvas-presenter.js
// The Animations workbench's canvas (view animations.canvas): the selected
// timeline column's frame at its own size, composited from every layer, with
// onion skin, every paint tool, and float/cut/paste clipped to the frame --
// all of that is the shared components/canvas/frame-canvas.js. This adds the
// strip (names, Show on sheet, Pivot, onion controls), the empty state, and
// the pivot crosshair, which is dragged while Pivot is on.
import { createFrameCanvas } from '../../../components/canvas/frame-canvas.js';
import { buildOnionControls } from '../../../components/canvas/onion-controls.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { pivotFromPoint, pivotCommand } from '../application/pivot.js';
import { timelineColumns, selectedColumn } from '../application/timeline-model.js';

const PIVOT_ARM = 6; // crosshair half-length, screen px

function selection(sheet) { return getEditorHost().selections.get({ kind: 'sprite-sheet', id: sheet.id }) ?? {}; }

export function mountAnimationCanvas(hostEl) {
  const container = document.createElement('div');
  container.className = 'frame-editor anim-canvas';
  hostEl.appendChild(container);

  const strip = document.createElement('div');
  strip.className = 'frame-editor-strip';
  const nameLabel = document.createElement('span');
  nameLabel.className = 'frame-editor-name';
  const btnShow = document.createElement('button');
  btnShow.type = 'button'; btnShow.textContent = 'Show on sheet';
  btnShow.title = 'Open this frame in the Sprite Sheets workbench';
  const btnPivot = document.createElement('button');
  btnPivot.type = 'button'; btnPivot.className = 'anim-pivot-toggle'; btnPivot.textContent = 'Pivot';
  btnPivot.title = 'Drag on the canvas to place the pivot';

  const empty = document.createElement('div');
  empty.className = 'anim-canvas-empty';
  empty.textContent = 'No frame selected — create an animation in the Animations panel.';

  const canvasDiv = document.createElement('div');
  canvasDiv.className = 'frame-editor-canvas';
  container.append(strip, canvasDiv, empty);

  // The timeline's selected column's frame (as in the timeline and the
  // Preview): a selected frame in no column of the selected animation -- a
  // stray frame picked in Sprite Sheets, say -- is not edited here.
  function currentFrame() {
    const sheet = activeSheet('sprite');
    if (!sheet) return null;
    const columns = timelineColumns(sheet);
    const frameId = columns[selectedColumn(columns, selection(sheet))]?.frameId;
    return sheet.frames.find(f => f.id === frameId) ?? null;
  }
  function currentAnimation() {
    const sheet = activeSheet('sprite');
    return sheet?.animations.find(a => a.id === selection(sheet).animationId) ?? null;
  }

  const frameCanvas = createFrameCanvas(canvasDiv, {
    viewKind: 'canvas', getFrame: currentFrame, getOnionAnimation: currentAnimation, onStateChange: () => refresh(),
  });
  const { view } = frameCanvas;
  const onionControls = buildOnionControls({ onChange: () => view.requestRender() });
  strip.append(nameLabel, btnShow, btnPivot, onionControls.element);

  // ---- pivot ----
  // An overlay above the canvas while Pivot is on, so pointer input places
  // the pivot instead of reaching the paint tools underneath.
  const pivotLayer = document.createElement('div');
  pivotLayer.className = 'anim-pivot-layer';
  pivotLayer.hidden = true;
  canvasDiv.appendChild(pivotLayer);
  let pivotMode = false;
  let dragPivot = null; // the pivot under the pointer while dragging

  function drawPivot(ctx) {
    const f = currentFrame();
    if (!f) return;
    const p = dragPivot ?? { pivotX: f.pivotX, pivotY: f.pivotY };
    // imageToScreen takes sheet coordinates (see frame-canvas.js).
    const s = view.imageToScreen(f.x + p.pivotX, f.y + p.pivotY);
    const x = Math.round(s.x) + 0.5, y = Math.round(s.y) + 0.5;
    ctx.save();
    ctx.strokeStyle = pivotMode ? '#4f8cff' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - PIVOT_ARM, y); ctx.lineTo(x + PIVOT_ARM, y);
    ctx.moveTo(x, y - PIVOT_ARM); ctx.lineTo(x, y + PIVOT_ARM);
    ctx.stroke();
    ctx.restore();
  }
  const priorOverlay = view.onOverlay;
  view.onOverlay = ctx => { priorOverlay(ctx); drawPivot(ctx); };

  function pivotAt(e, f) {
    const rect = pivotLayer.getBoundingClientRect();
    return pivotFromPoint(f, (e.clientX - rect.left - view.panX) / view.zoom, (e.clientY - rect.top - view.panY) / view.zoom);
  }
  pivotLayer.addEventListener('pointerdown', (e) => {
    const f = currentFrame();
    if (!f || e.button !== 0) return;
    pivotLayer.setPointerCapture(e.pointerId);
    dragPivot = pivotAt(e, f);
    view.requestRender();
  });
  pivotLayer.addEventListener('pointermove', (e) => {
    const f = currentFrame();
    if (!dragPivot || !f) return;
    dragPivot = pivotAt(e, f);
    view.requestRender();
  });
  pivotLayer.addEventListener('pointerup', (e) => {
    const f = currentFrame(), sheet = activeSheet('sprite');
    if (!dragPivot || !f || !sheet) { dragPivot = null; return; }
    const pivot = pivotAt(e, f);
    dragPivot = null;
    const { id, args } = pivotCommand(sheet, f, pivot);
    dispatchLayout(id, args);
    view.requestRender();
  });
  pivotLayer.addEventListener('pointercancel', () => { dragPivot = null; view.requestRender(); });

  // The view's wheel zoom and Space-pan still work while Pivot is on: the
  // wheel is handed to the view, and while Space is held pointer input
  // passes through the overlay to the canvas, which pans.
  pivotLayer.addEventListener('wheel', (e) => view.wheel(e), { passive: false });
  const passThrough = on => { pivotLayer.style.pointerEvents = on ? 'none' : ''; };
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTypingTarget(e.target)) passThrough(true); });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') passThrough(false); });
  window.addEventListener('blur', () => passThrough(false));

  function setPivotMode(on) {
    pivotMode = on;
    dragPivot = null;
    pivotLayer.hidden = !on;
    btnPivot.classList.toggle('active', on);
    view.requestRender();
  }
  btnPivot.addEventListener('click', () => setPivotMode(!pivotMode));

  btnShow.addEventListener('click', () => getEditorHost().activateMode('sprites'));

  // ---- state ----
  function refresh() {
    const f = frameCanvas.sync();
    empty.hidden = !!f;
    empty.textContent = !activeSheet('sprite') ? 'No sprite sheet — create one in the Sprite Sheets workbench.'
      : 'No frame selected — pick a frame in the timeline, or create an animation in the Animations panel.';
    const anim = currentAnimation();
    nameLabel.textContent = f ? (anim ? `${anim.name} · ${f.name}` : f.name) : '';
    btnShow.disabled = !f;
    btnPivot.disabled = !f;
    onionControls.sync();
  }

  function show() {
    container.style.display = 'flex';
    frameCanvas.shown();
    refresh();
  }
  function hide() {
    if (pivotMode) setPivotMode(false);
    frameCanvas.hidden();
    container.style.display = 'none';
  }

  return { show, hide, view };
}
