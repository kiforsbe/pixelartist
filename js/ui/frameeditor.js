// Frame editor: a focused, zoomed-in view of a single frame with configurable
// onion-skinning against its animation neighbors. Task 16.
//
// Owns a SECOND CanvasView instance (independent of the sheet view's), living
// in its own absolutely-positioned child of #canvas-host (see main.js's view
// switching). Mounted once at boot and kept for the app's lifetime — CanvasView
// has no teardown and installs window-level key listeners, so creating/
// destroying an instance per show() would leak listeners.
//
// Coordinate mapping: this CanvasView's content space is frame-local
// (0..f.w, 0..f.h) — set via setContent({width: f.w, height: f.h}) so zoom/
// pan/centerFit work in frame-sized units. But the layer bitmaps being edited
// are sheet-global (the SAME bitmaps the sheet view edits). Two things bridge
// that gap:
//   1. `mapPoint(x, y)` passed to tools.js's bindDrawing() shifts every
//      pointer event's (x, y) from frame-local to sheet-global (+f.x, +f.y)
//      BEFORE any tool logic runs, so strokes/fills/selection are computed in
//      sheet-global space exactly like the sheet view (getTargetRect() below
//      also returns a sheet-global rect, keeping the two consistent).
//   2. Because selection/marquee state built by tools.js is therefore stored
//      in sheet-global coordinates, this view's own `imageToScreen` is
//      overridden to subtract the frame offset before applying zoom/pan, so
//      overlays (the select-tool marquee) drawn via view.imageToScreen still
//      land in the right screen position. `screenToImage` is left untouched
//      (CanvasView's own pointer-event construction stays frame-local; the
//      translation to sheet-global happens once, via mapPoint, right before
//      tool logic — not twice).
// onPaint itself works directly in frame-local space (no override needed
// there): it translates by -f.x,-f.y only around the sheet-global-aligned
// flattened-sheet drawImage call, then restores back to frame-local space to
// draw onion ghosts (which are pivot-aligned in that same frame-local frame).

import { state, on, emit, activeSheet } from '../app/state.js';
import { CanvasView } from './canvasview.js';
import { bindDrawing } from './tools.js';
import { flattenSheet } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

function wrapIndex(idx, len) { return ((idx % len) + len) % len; }

export function mountFrameEditor(hostEl) {
  const container = document.createElement('div');
  container.className = 'frame-editor';
  hostEl.appendChild(container);

  // ---- top strip ----
  const strip = document.createElement('div');
  strip.className = 'frame-editor-strip';
  container.appendChild(strip);

  const btnBack = document.createElement('button');
  btnBack.type = 'button'; btnBack.textContent = '← Back to sheet';

  const nameLabel = document.createElement('span');
  nameLabel.className = 'frame-editor-name';

  const btnPrev = document.createElement('button');
  btnPrev.type = 'button'; btnPrev.textContent = '◀ Prev';
  const btnNext = document.createElement('button');
  btnNext.type = 'button'; btnNext.textContent = 'Next ▶';

  const onionEnable = document.createElement('input');
  onionEnable.type = 'checkbox';
  const onionLabel = document.createElement('label');
  onionLabel.className = 'frame-editor-onion';
  onionLabel.append(onionEnable, document.createTextNode('Onion'));

  const backInput = document.createElement('input');
  backInput.type = 'number'; backInput.min = '0'; backInput.max = '8'; backInput.title = 'Frames back';
  const backLabel = document.createElement('label');
  backLabel.className = 'frame-editor-onion';
  backLabel.append(document.createTextNode('Back'), backInput);

  const aheadInput = document.createElement('input');
  aheadInput.type = 'number'; aheadInput.min = '0'; aheadInput.max = '8'; aheadInput.title = 'Frames ahead';
  const aheadLabel = document.createElement('label');
  aheadLabel.className = 'frame-editor-onion';
  aheadLabel.append(document.createTextNode('Ahead'), aheadInput);

  const legend = document.createElement('span');
  legend.className = 'frame-editor-legend';
  const dotPast = document.createElement('span');
  dotPast.className = 'swatch-dot'; dotPast.style.background = '#ff4040';
  const dotFuture = document.createElement('span');
  dotFuture.className = 'swatch-dot'; dotFuture.style.background = '#40ff40';
  legend.append(dotPast, document.createTextNode('past'), dotFuture, document.createTextNode('future'));

  strip.append(btnBack, nameLabel, btnPrev, btnNext, onionLabel, backLabel, aheadLabel, legend);

  // ---- canvas ----
  const canvasHostDiv = document.createElement('div');
  canvasHostDiv.className = 'frame-editor-canvas';
  container.appendChild(canvasHostDiv);

  const view = new CanvasView(canvasHostDiv);

  // See module comment: overlays (marquee selection) are stored in
  // sheet-global coordinates by tools.js because of mapPoint below, so
  // imageToScreen needs to subtract the frame offset before applying zoom/pan.
  view.imageToScreen = (x, y) => {
    const f = currentFrame();
    const fx = f ? f.x : 0, fy = f ? f.y : 0;
    return { x: (x - fx) * view.zoom + view.panX, y: (y - fy) * view.zoom + view.panY };
  };

  function currentFrame() {
    const sheet = activeSheet();
    if (!sheet) return null;
    return sheet.frames.find(f => f.id === state.editingFrameId) ?? null;
  }

  function getTargetRect() {
    const f = currentFrame();
    return f ? { x: f.x, y: f.y, w: f.w, h: f.h } : { x: 0, y: 0, w: 0, h: 0 };
  }

  function mapPoint(x, y) {
    const f = currentFrame();
    return f ? { x: x + f.x, y: y + f.y } : { x, y };
  }

  bindDrawing(view, getTargetRect, mapPoint);

  // ---- flattened-sheet cache (scratch canvas), mirrors main.js's pattern.
  // Invalidated on 'pixels'/'project'/'history'; rebuilt lazily on next paint.
  let flatSheetRef = null;
  let flatBitmap = null;
  let flatDirty = true;
  function invalidateFlat() { flatDirty = true; }
  function getFlatBitmap(sheet) {
    if (flatDirty || flatSheetRef !== sheet || !flatBitmap) {
      flatBitmap = flattenSheet(sheet);
      flatSheetRef = sheet;
      flatDirty = false;
    }
    return flatBitmap;
  }
  let flatCanvas = null;
  let flatCanvasSrc = null;
  function getFlatCanvas(sheet) {
    const bmp = getFlatBitmap(sheet);
    if (flatCanvasSrc !== bmp) {
      if (!flatCanvas || flatCanvas.width !== bmp.width || flatCanvas.height !== bmp.height) {
        flatCanvas = document.createElement('canvas');
        flatCanvas.width = bmp.width;
        flatCanvas.height = bmp.height;
      }
      const c = flatCanvas.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
      flatCanvasSrc = bmp;
    }
    return flatCanvas;
  }

  // ---- ghost scratch cache (onion skin) ----
  // drawGhost() used to allocate + tint a fresh canvas on every call; with up
  // to 16 ghosts (8 back + 8 ahead) painted continuously during pan/zoom, that
  // was 16 canvas allocations + copyRegion + putImageData + fillRect per
  // frame. Cache the tinted region canvas per (frameId, tint) pair, rebuilt
  // only when the flat bitmap cache is invalidated (same 'pixels'/'project'/
  // 'history' triggers as getFlatCanvas, via the shared flatDirty flag).
  // Alpha (0.35/k) is NOT baked in here — it varies by ghost distance k, so it
  // stays applied at composite time via ctx.globalAlpha in drawGhost.
  let ghostCache = new Map(); // key `${frameId}|${tintCss}` -> canvas
  let ghostCacheSrc = null;   // flatBitmap this cache was built against
  function getGhostCanvas(flatBmp, gf, tintCss) {
    if (ghostCacheSrc !== flatBmp) {
      ghostCache.clear();
      ghostCacheSrc = flatBmp;
    }
    const key = `${gf.id}|${tintCss}`;
    let c = ghostCache.get(key);
    if (!c) {
      const region = copyRegion(flatBmp, gf.x, gf.y, gf.w, gf.h);
      c = document.createElement('canvas');
      c.width = Math.max(1, region.width);
      c.height = Math.max(1, region.height);
      const sctx = c.getContext('2d');
      sctx.imageSmoothingEnabled = false;
      sctx.putImageData(new ImageData(region.data, region.width, region.height), 0, 0);
      sctx.globalCompositeOperation = 'source-atop';
      sctx.fillStyle = tintCss;
      sctx.globalAlpha = 0.6;
      sctx.fillRect(0, 0, region.width, region.height);
      ghostCache.set(key, c);
    }
    return c;
  }

  // ---- onion skin ----

  function frameById(sheet, id) { return sheet.frames.find(fr => fr.id === id) ?? null; }

  // Draws frame `gf`'s flattened, tinted pixels into `ctx` at the given
  // alpha, pivot-aligned against the edited frame `f`. Reads via copyRegion
  // (a fresh copy) and only ever draws to scratch canvases / the view's
  // screen-space ctx — never touches layer bitmaps, so ghosts can never leak
  // into saved pixels/export.
  function drawGhost(ctx, flatBmp, f, gf, tintCss, alpha) {
    if (!gf) return;
    const scratch = getGhostCanvas(flatBmp, gf, tintCss);

    const dx = f.pivotX - gf.pivotX;
    const dy = f.pivotY - gf.pivotY;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(scratch, -dx, -dy);
    ctx.restore();
  }

  function paintOnion(ctx, sheet, f) {
    if (!state.onion.enabled) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (!anim || !anim.frames.length) return;
    const pos = anim.frames.findIndex(af => af.frameId === f.id);
    if (pos === -1) return;
    const bmp = getFlatBitmap(sheet);
    const len = anim.frames.length;

    for (let k = 1; k <= state.onion.back; k++) {
      let idx = pos - k;
      if (idx < 0) { if (!anim.loop) break; idx = wrapIndex(idx, len); }
      drawGhost(ctx, bmp, f, frameById(sheet, anim.frames[idx].frameId), 'rgba(255,64,64,1)', 0.35 / k);
    }
    for (let k = 1; k <= state.onion.ahead; k++) {
      let idx = pos + k;
      if (idx >= len) { if (!anim.loop) break; idx = wrapIndex(idx, len); }
      drawGhost(ctx, bmp, f, frameById(sheet, anim.frames[idx].frameId), 'rgba(64,255,64,1)', 0.35 / k);
    }
  }

  // ---- paint ----

  view.onPaint = (ctx) => {
    const sheet = activeSheet();
    const f = currentFrame();
    if (!sheet || !f) return;
    // own pixels: draw the sheet-global-aligned flattened canvas shifted so
    // the frame's top-left lands at frame-local (0,0), clipped to its rect.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, f.w, f.h);
    ctx.clip();
    ctx.save();
    ctx.translate(-f.x, -f.y);
    ctx.drawImage(getFlatCanvas(sheet), 0, 0);
    ctx.restore();
    ctx.restore();
    // onion ghosts: back in plain frame-local space, unclipped (pivot offsets
    // can intentionally shift a ghost partly outside the base frame's rect).
    paintOnion(ctx, sheet, f);
  };

  // ---- navigation ----

  // Walks the selected animation's order if the current frame belongs to it,
  // else falls back to sheet frame order. Clamped (no wraparound) at the ends.
  function neighborFrame(dir) {
    const sheet = activeSheet();
    const f = currentFrame();
    if (!sheet || !f) return null;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim) {
      const pos = anim.frames.findIndex(af => af.frameId === f.id);
      if (pos !== -1) {
        const idx = Math.max(0, Math.min(anim.frames.length - 1, pos + dir));
        if (idx === pos) return null;
        return frameById(sheet, anim.frames[idx].frameId);
      }
    }
    const idx2 = sheet.frames.indexOf(f);
    const ni = Math.max(0, Math.min(sheet.frames.length - 1, idx2 + dir));
    if (ni === idx2) return null;
    return sheet.frames[ni] ?? null;
  }

  let loadedFrameId = null;

  // Sets content size + recenters. Only called when the edited frame's
  // identity actually changes (initial open, prev/next, double-click a
  // different timeline cell) — NOT on every cosmetic 'view' event (overlay
  // toggles, etc.) or every pixel edit, so drawing never resets zoom/pan.
  function loadFrame(f) {
    view.setContent({ width: f.w, height: f.h });
    view.centerFit();
    loadedFrameId = f.id;
  }

  function updateStrip() {
    const f = currentFrame();
    nameLabel.textContent = f ? f.name : '';
    onionEnable.checked = state.onion.enabled;
    backInput.value = String(state.onion.back);
    aheadInput.value = String(state.onion.ahead);
    btnPrev.disabled = !neighborFrame(-1);
    btnNext.disabled = !neighborFrame(1);
  }

  // Lightweight sync used for 'project'/'history' events and re-entry into
  // an already-open editor: reloads (recentering) only if the edited frame
  // changed identity or its on-sheet dimensions changed; otherwise just
  // repaints in place, keeping the user's zoom/pan.
  function refresh() {
    const f = currentFrame();
    if (!f) {
      hide();
      // The frame we were editing is gone (deleted, or a new/opened project
      // no longer has it) — fall back to the sheet view rather than leaving
      // both this editor and the sheet canvas hidden.
      if (state.view === 'frame') { state.view = 'sheet'; state.editingFrameId = null; emit('view'); }
      return;
    }
    if (loadedFrameId !== f.id || view.width !== f.w || view.height !== f.h) loadFrame(f);
    updateStrip();
    view.requestRender();
  }

  function goTo(dir) {
    const nf = neighborFrame(dir);
    if (!nf) return;
    state.editingFrameId = nf.id;
    loadFrame(nf);
    updateStrip();
    view.requestRender();
  }

  function backToSheet() {
    state.view = 'sheet';
    emit('view');
  }

  btnBack.addEventListener('click', backToSheet);
  btnPrev.addEventListener('click', () => goTo(-1));
  btnNext.addEventListener('click', () => goTo(1));

  onionEnable.addEventListener('change', () => {
    state.onion.enabled = onionEnable.checked;
    view.requestRender();
  });
  function bindOnionCount(input, key) {
    input.addEventListener('change', () => {
      let v = parseInt(input.value, 10);
      if (!Number.isFinite(v)) v = 1;
      v = Math.max(0, Math.min(8, v));
      input.value = String(v);
      state.onion[key] = v;
      view.requestRender();
    });
  }
  bindOnionCount(backInput, 'back');
  bindOnionCount(aheadInput, 'ahead');

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.view !== 'frame') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    backToSheet();
  });

  // ---- visibility ----

  let visible = false;
  // Host CSS size last seen while visible (captured on hide()). refresh()
  // only recenters (via loadFrame()) when the EDITED FRAME's identity or
  // on-sheet dimensions change — reopening the same frame after the host
  // (#canvas-host) was resized while this editor sat hidden (e.g. a window
  // resize, or a layout panel toggling) would otherwise silently keep the
  // stale pan/zoom from before, no longer centered in the new viewport.
  let lastCssW = 0, lastCssH = 0;

  function show() {
    const wasHidden = !visible;
    container.style.display = 'flex';
    visible = true;
    // The container may have been display:none, in which case CanvasView's
    // cached cssWidth/cssHeight (from construction time, or the last time it
    // was visible) are stale — its ResizeObserver callback is async and
    // won't have fired yet this tick. Force a synchronous remeasure now so
    // the centerFit() inside refresh()->loadFrame() uses correct dimensions
    // instead of a leftover 0x0/1x1 size.
    if (wasHidden) {
      view._resize();
      // Same frame being reopened (loadFrame() below will be skipped) but
      // the host's css size changed while hidden: recenter explicitly so pan/
      // zoom isn't stale relative to the new viewport. Cosmetic 'view' emits
      // that happen while already visible still don't recenter (unchanged).
      if (loadedFrameId != null && (view.cssWidth !== lastCssW || view.cssHeight !== lastCssH)) {
        view.centerFit();
      }
    }
    refresh();
  }
  function hide() {
    lastCssW = view.cssWidth;
    lastCssH = view.cssHeight;
    container.style.display = 'none';
    visible = false;
  }

  on('project', () => { invalidateFlat(); if (visible) refresh(); });
  on('history', () => { invalidateFlat(); if (visible) refresh(); });
  on('pixels', () => { invalidateFlat(); if (visible) view.requestRender(); });
  on('selection', () => { if (visible) view.requestRender(); });

  return { show, hide };
}
