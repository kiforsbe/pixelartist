// General-purpose Preview panel: a single canvas in the right-hand side-panel
// column that shows whatever is contextually relevant -- the selected/edited
// frame, the selected tile, the active map's complete bounded scene, or (while
// an animation is selected) the timeline's current playhead frame. It doesn't
// know about sprite-sheet animation playback itself:
// timeline.js owns the play/scrub loop and pushes frames here via
// setPreviewBitmap() at rAF rate, since it already tracks position/timing in
// its own closure and re-deriving that here on every event would just be
// redundant work. This module's own render() only handles the non-animation
// cases and explicitly steps aside (see the selected-animation check)
// whenever timeline.js is the one driving the canvas.
//
// Zoom mirrors CanvasView's table-stepped scheme (js/core/zoom.js): wheel or
// the +/- overlay buttons step through ZOOM_STEPS, "Fit" snaps to the largest
// step that still contains the bitmap. Dragging pans (no Space/middle-click
// gate needed like CanvasView -- there's no drawing tool here to conflict
// with a plain click-drag); the first drag while in "fit" mode freezes the
// current fit zoom into a manual one so the drag has room to move the
// content off-center.

import { state, on } from '../../app/state.js';
import { stepZoom, snapFitZoom } from '../../core/zoom.js';
import { getEditorHost } from '../../host/runtime.js';

// Module-level scratch canvas, mirroring timeline.js/panels.js's own copies
// of this pattern -- reused across draws, resized only when the source
// bitmap's dimensions change.
let scratchCanvas = null;
let scratchCtx = null;

function getScratchCanvas(width, height) {
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
    scratchCtx = scratchCanvas.getContext('2d');
  }
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
    scratchCtx.imageSmoothingEnabled = false;
  }
  return scratchCanvas;
}

let canvas = null;
let zoomLabel = null;
let btnFit = null;

let lastBmp = null;
let zoomMode = 'fit'; // 'fit' | 'manual'
let manualZoom = 1;
let panX = 0, panY = 0; // manual offset from centered, screen px
let exactFit = false;
let previewContextKey = null;
let mapRefreshQueued = false;
let mapRefreshGeneration = 0;
let editorHost = null;

// The zoom actually on screen right now, for both drawing and the readout.
function displayedZoom() {
  if (zoomMode !== 'fit') return manualZoom;
  if (!lastBmp || lastBmp.width === 0 || lastBmp.height === 0) return 1;
  const fit = Math.min(canvas.width / lastBmp.width, canvas.height / lastBmp.height);
  // Maps can be far larger than the preview panel. Unlike sprite/tile
  // previews, Fit must be allowed below the zoom table's 25% floor so the
  // complete bounded scene always remains visible.
  return exactFit ? fit : snapFitZoom(fit);
}

function draw() {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (lastBmp && lastBmp.width > 0 && lastBmp.height > 0) {
    const tmp = getScratchCanvas(lastBmp.width, lastBmp.height);
    tmp.getContext('2d').putImageData(new ImageData(lastBmp.data, lastBmp.width, lastBmp.height), 0, 0);
    const scale = displayedZoom();
    const dw = Math.max(1, Math.round(lastBmp.width * scale));
    const dh = Math.max(1, Math.round(lastBmp.height * scale));
    const dx = Math.floor((canvas.width - dw) / 2) + panX;
    const dy = Math.floor((canvas.height - dh) / 2) + panY;
    ctx.drawImage(tmp, 0, 0, lastBmp.width, lastBmp.height, dx, dy, dw, dh);
  }
  if (zoomLabel) zoomLabel.textContent = `${Math.round(displayedZoom() * 100)}%`;
  if (btnFit) btnFit.classList.toggle('active', zoomMode === 'fit');
}

// External pushers (currently just timeline.js's playback/scrub loop) draw
// straight into the panel through here, bypassing this module's own
// context-driven render(). Zoom/pan state is left alone across bitmap swaps --
// same as CanvasView, whose zoom doesn't reset just because content changed.
export function setPreviewBitmap(bmp) {
  // A timeline playback callback may still arrive during a mode switch; it
  // must never overwrite the active map preview.
  if (state.mode !== 'sprites') return;
  exactFit = false;
  lastBmp = bmp;
  draw();
}

function applyProviderResult(result) {
  if (!result || result.managed) return;
  exactFit = !!result.exactFit;
  if (result.resetKey && previewContextKey !== result.resetKey) {
    zoomMode = 'fit'; panX = 0; panY = 0;
  } else if (!result.exactFit && previewContextKey?.startsWith('map:')) {
    zoomMode = 'fit'; panX = 0; panY = 0;
  }
  previewContextKey = result.resetKey ?? 'sheet';
  lastBmp = result.bitmap ?? null;
  draw();
}

// overrideLayers: when given, flattened instead of currentContextLayers() --
// lets a filter dialog preview a hypothetical edit without touching real
// layer data. Only the layer CONTENT being previewed is swappable; which
// frame/tile is shown is still resolved from real state either way.
function render(overrideLayers = null) {
  if (!canvas) return;
  const provider = editorHost?.registries.previews.list(editorHost.contextKeys.snapshot())[0];
  applyProviderResult(provider?.render({ overrideLayers }));
}

// Runs the normal frame/tile-rect selection + flatten + copyRegion +
// setPreviewBitmap pipeline against a caller-supplied layers array instead
// of the real ones -- the hook filter dialogs use to preview an edit that
// hasn't been committed yet.
export function previewWithOverride(overrideLayers) { render(overrideLayers); }

// Re-renders from real project state -- what a filter dialog calls on
// close (OK or Cancel) to drop any speculative preview and resume normal
// context-driven display.
export function refreshPreviewPanel() { render(); }

function setManualZoom(z) {
  zoomMode = 'manual';
  manualZoom = z;
  draw();
}

// Sizes the canvas to exactly fill the panel's own content area at 1:1 --
// explicit style.width/height locks the CSS size to the backing-store
// resolution, since relying on `max-width: 100%` alone lets the browser
// silently downscale a canvas whose attribute size exceeds its container
// (el.clientWidth includes the panel's own padding, which the canvas itself
// sits inside of, so that padding has to be subtracted here too).
function sizeCanvasToPanel(el) {
  const elStyle = getComputedStyle(el);
  const contentWidth = el.clientWidth - parseFloat(elStyle.paddingLeft) - parseFloat(elStyle.paddingRight);
  const canvasStyle = getComputedStyle(canvas);
  const borderW = parseFloat(canvasStyle.borderLeftWidth) + parseFloat(canvasStyle.borderRightWidth);
  const size = Math.max(64, Math.floor(contentWidth - borderW));
  canvas.width = size; canvas.height = size;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
}

export function mountPreviewPanel(el) {
  editorHost = getEditorHost();
  el.innerHTML = '';
  const h3 = document.createElement('h3');
  h3.textContent = 'Preview';

  const wrap = document.createElement('div');
  wrap.className = 'preview-panel-wrap';

  canvas = document.createElement('canvas');
  canvas.className = 'preview-panel-canvas';
  wrap.appendChild(canvas);
  el.append(h3, wrap);
  sizeCanvasToPanel(el);

  // Re-measure whenever #side-panels' own width changes -- most notably when
  // its vertical scrollbar appears/disappears as other panels grow/shrink
  // (e.g. a long Layers list), which narrows this panel's content width by
  // the scrollbar's own size after mount. Observes the PARENT (side-panels),
  // not `el`/canvas themselves, so resizing the canvas here can't feed back
  // into triggering another resize of the thing being observed (mirrors
  // CanvasView's own ResizeObserver, which watches its host, not its canvas).
  let sizeQueued = false;
  const ro = new ResizeObserver(() => {
    if (sizeQueued) return;
    sizeQueued = true;
    queueMicrotask(() => {
      sizeQueued = false;
      const prevSize = canvas.width;
      sizeCanvasToPanel(el);
      if (canvas.width !== prevSize) draw();
    });
  });
  ro.observe(el.parentElement);

  const zoomBar = document.createElement('div');
  zoomBar.className = 'preview-panel-zoombar';
  const btnOut = document.createElement('button');
  btnOut.type = 'button'; btnOut.className = 'preview-panel-zoom-btn'; btnOut.textContent = '−'; btnOut.title = 'Zoom out';
  zoomLabel = document.createElement('span');
  zoomLabel.className = 'preview-panel-zoom-label';
  const btnIn = document.createElement('button');
  btnIn.type = 'button'; btnIn.className = 'preview-panel-zoom-btn'; btnIn.textContent = '+'; btnIn.title = 'Zoom in';
  btnFit = document.createElement('button');
  btnFit.type = 'button'; btnFit.className = 'preview-panel-zoom-btn'; btnFit.textContent = 'Fit'; btnFit.title = 'Zoom to fit';
  zoomBar.append(btnOut, zoomLabel, btnIn, btnFit);
  wrap.appendChild(zoomBar);

  btnOut.addEventListener('click', () => setManualZoom(stepZoom(displayedZoom(), -1)));
  btnIn.addEventListener('click', () => setManualZoom(stepZoom(displayedZoom(), 1)));
  btnFit.addEventListener('click', () => { zoomMode = 'fit'; panX = 0; panY = 0; draw(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setManualZoom(stepZoom(displayedZoom(), e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  // ---- pan (plain drag -- no Space/middle-click gate needed, there's no
  // drawing tool competing for a click here) ----
  let dragStart = null; // { sx, sy, panX, panY, zoomAtStart }
  canvas.addEventListener('pointerdown', (e) => {
    dragStart = { sx: e.clientX, sy: e.clientY, panX, panY, zoomAtStart: displayedZoom() };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* no active pointer to capture */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    // First move of a drag started in "fit" mode freezes the current fit
    // zoom into a manual one, so there's actually room to pan.
    if (zoomMode === 'fit') { zoomMode = 'manual'; manualZoom = dragStart.zoomAtStart; }
    panX = dragStart.panX + (e.clientX - dragStart.sx);
    panY = dragStart.panY + (e.clientY - dragStart.sy);
    draw();
  });
  const endDrag = (e) => {
    if (!dragStart) return;
    dragStart = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const requestContextRender = () => {
    if (state.mode !== 'maps') {
      mapRefreshGeneration++; mapRefreshQueued = false;
      render(); return;
    }
    // A drag stroke can emit several project/history/view notifications in
    // one pointer event. Rasterize the bounded scene once, after all commands
    // and cache invalidations for that frame have completed.
    if (mapRefreshQueued) return;
    mapRefreshQueued = true;
    const generation = ++mapRefreshGeneration;
    queueMicrotask(() => {
      if (generation !== mapRefreshGeneration) return;
      mapRefreshQueued = false; render();
    });
  };
  const renderMapContentNow = () => {
    if (state.mode !== 'maps') return;
    // Map brush commands have finished mutating occupancy and recalculating
    // bounds before this event is emitted. In particular, an autotile stroke
    // can change the resolved artwork of every neighbouring terrain cell even
    // when the bounds stay identical. Do not let that content-only update get
    // folded into (or lost behind) the generic deferred UI refresh above.
    mapRefreshGeneration++;
    mapRefreshQueued = false;
    render();
  };
  on('project', requestContextRender);
  on('history', requestContextRender);
  on('view', requestContextRender);
  on('selection', requestContextRender);
  on('pixels', requestContextRender);
  getEditorHost()?.history.subscribe(() => { if (state.mode === 'maps') renderMapContentNow(); });
  render();
}
