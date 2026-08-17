// js/modes/sprites/presentation/frame-editor-presenter.js
// Frame editor: a focused, zoomed-in view of a single frame with configurable
// onion-skinning against its animation neighbors.
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

import { state, on, emit, activeSheet, currentContextLayers, markDirty } from '../../../app/state.js';
import { CanvasView } from '../../../components/canvas/canvas-view.js';
import { bindDrawing } from '../../../ui/tools.js';
import { commitFloatIfAny } from '../../../components/canvas/float-session.js';
import { flattenSheetLayers } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { runAction } from '../../../app/actions.js';
import { computeOnionGhosts, resolveStepColor, traceOutline } from '../application/onion-skin.js';
import { computeNeighborFrame } from '../application/frame-navigation.js';
import { getEditorHost } from '../../../host/runtime.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function mountFrameEditor(hostEl) {
  const container = document.createElement('div');
  container.className = 'frame-editor';
  hostEl.appendChild(container);

  // ---- top strip ----
  const strip = document.createElement('div');
  strip.className = 'frame-editor-strip';
  container.appendChild(strip);

  const btnBack = document.createElement('button');
  btnBack.type = 'button'; btnBack.className = 'btn-icon-md'; btnBack.textContent = '⬅'; btnBack.title = 'Back to sheet';

  const nameLabel = document.createElement('span');
  nameLabel.className = 'frame-editor-name';

  const btnPrev = document.createElement('button');
  btnPrev.type = 'button'; btnPrev.textContent = '◀ Prev';
  const btnNext = document.createElement('button');
  btnNext.type = 'button'; btnNext.textContent = 'Next ▶';

  // Bare 0..1 alpha slider -- no text label or numeric readout, just the
  // slider itself with a tooltip; reused for every onion opacity setting.
  // `input` fires live while dragging (no undo tracking needed for this
  // ephemeral display preference).
  function alphaSlider(title) {
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.05';
    input.className = 'frame-editor-alpha';
    input.title = title;
    return input;
  }

  // A bare alpha slider paired tightly with a small glyph identifying which
  // onion mode it controls (■ = Mask's filled silhouette, □ = Outline's edge
  // trace), so the Back/Ahead groups' two unlabeled sliders are
  // distinguishable at a glance. Returns the wrapper (append this into a
  // group) and the input (for binding).
  function iconSlider(glyph, title) {
    const icon = document.createElement('span');
    icon.className = 'frame-editor-onion-icon';
    icon.textContent = glyph;
    icon.title = title;
    const input = alphaSlider(title);
    const wrap = document.createElement('span');
    wrap.className = 'frame-editor-onion-icon-slider';
    wrap.append(icon, input);
    return { wrap, input };
  }

  const onionEnable = document.createElement('input');
  onionEnable.type = 'checkbox';
  const onionLabel = document.createElement('label');
  onionLabel.className = 'frame-editor-onion';
  onionLabel.append(onionEnable, document.createTextNode('Onion'));

  // Fades the CURRENTLY EDITED frame's own pixels (only while onion skin is
  // enabled) so ghosts -- especially the Outline trace -- read more clearly
  // against it. 1 = no fade (default), matching pre-existing behavior. Lives
  // in the main group since it isn't past/ahead-specific.
  const currentAlphaInput = alphaSlider("Opacity of the frame you're editing (fade it to make onion ghosts stand out)");

  // Mask and Outline are independent toggles (both, either, or neither can be
  // on) rather than a mode radio -- see paintOnion/drawGhost below. The
  // toggle itself is global (main group); each direction gets its OWN alpha
  // slider (below, in the Past/Ahead groups) so past and future ghosts can
  // be dialed independently -- the ghost-distance fade (baseAlpha/k, done in
  // drawGhost) then multiplies that direction's base value.
  const maskEnable = document.createElement('input');
  maskEnable.type = 'checkbox';
  const maskLabel = document.createElement('label');
  maskLabel.className = 'frame-editor-onion';
  maskLabel.title = 'Tint the ghost frame\'s whole silhouette';
  maskLabel.append(maskEnable, document.createTextNode('Mask'));

  const outlineEnable = document.createElement('input');
  outlineEnable.type = 'checkbox';
  const outlineLabel = document.createElement('label');
  outlineLabel.className = 'frame-editor-onion';
  outlineLabel.title = 'Trace just the ghost frame\'s edge';
  outlineLabel.append(outlineEnable, document.createTextNode('Outline'));

  const backInput = document.createElement('input');
  backInput.type = 'number'; backInput.min = '0'; backInput.max = '8'; backInput.title = 'Frames back';
  // Base color for every "back" (past) ghost step; a step's own color wins
  // when set via the ⚙ per-step dialog below (see resolveStepColor()).
  const backColorInput = document.createElement('input');
  backColorInput.type = 'color';
  backColorInput.title = 'Back (past) ghost color';
  const backMaskAlpha = iconSlider('■', 'Mask opacity for past ghosts');
  const backOutlineAlpha = iconSlider('□', 'Outline opacity for past ghosts');
  const backLabel = document.createElement('label');
  backLabel.className = 'frame-editor-onion';
  backLabel.append(document.createTextNode('Back'), backInput, backColorInput);

  const aheadInput = document.createElement('input');
  aheadInput.type = 'number'; aheadInput.min = '0'; aheadInput.max = '8'; aheadInput.title = 'Frames ahead';
  const aheadColorInput = document.createElement('input');
  aheadColorInput.type = 'color';
  aheadColorInput.title = 'Ahead (future) ghost color';
  const aheadMaskAlpha = iconSlider('■', 'Mask opacity for future ghosts');
  const aheadOutlineAlpha = iconSlider('□', 'Outline opacity for future ghosts');
  const aheadLabel = document.createElement('label');
  aheadLabel.className = 'frame-editor-onion';
  aheadLabel.append(document.createTextNode('Ahead'), aheadInput, aheadColorInput);

  // Opens the per-step (per-distance-k) color overrides on Project
  // Settings' Onion Steps page (see the click handler below). Applies to
  // both Back and Ahead steps, so it sits after both sub-groups rather than
  // inside either one.
  const btnStepColors = document.createElement('button');
  btnStepColors.type = 'button'; btnStepColors.className = 'btn-icon-md';
  btnStepColors.textContent = '⚙';
  btnStepColors.title = 'Per-step onion colors… (Project Settings)';

  // Everything onion-skin-related lives in one cluster (onionGroup), set off
  // from the navigation controls (back/prev/next) by a divider, and further
  // split into three sub-groups so related controls read together: overall
  // settings (mainGroup), then Back/past-only settings (pastGroup), then
  // Ahead/future-only settings (aheadGroup) -- each its own small visually
  // separated cluster rather than one long flat row.
  const onionGroup = document.createElement('div');
  onionGroup.className = 'frame-editor-onion-group';

  const mainGroup = document.createElement('div');
  mainGroup.className = 'frame-editor-onion-sub';
  mainGroup.append(onionLabel, currentAlphaInput, maskLabel, outlineLabel);

  const pastGroup = document.createElement('div');
  pastGroup.className = 'frame-editor-onion-sub frame-editor-onion-past';
  pastGroup.append(backLabel, backMaskAlpha.wrap, backOutlineAlpha.wrap);

  const aheadGroup = document.createElement('div');
  aheadGroup.className = 'frame-editor-onion-sub frame-editor-onion-ahead';
  aheadGroup.append(aheadLabel, aheadMaskAlpha.wrap, aheadOutlineAlpha.wrap);

  onionGroup.append(mainGroup, pastGroup, aheadGroup, btnStepColors);

  strip.append(btnBack, nameLabel, btnPrev, btnNext, onionGroup);

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

  bindDrawing(view, getTargetRect, mapPoint, 'frame');

  // ---- flattened-sheet cache (scratch canvas), shared via raster-cache.js.
  // Invalidated on 'pixels'/'project'/'history'; rebuilt lazily on next paint.
  const flatCache = createRasterCache();
  function invalidateFlat() { flatCache.invalidate(); }
  function flattenCurrentSheet(sheet) { return flattenSheetLayers(currentContextLayers(), sheet.width, sheet.height, state.floating, sheet.id); }
  function getFlatBitmap(sheet) { return flatCache.getBitmap(sheet, flattenCurrentSheet); }
  function getFlatCanvas(sheet) { return flatCache.getCanvas(sheet, flattenCurrentSheet); }

  // ---- ghost scratch cache (onion skin) ----
  // drawGhost() used to allocate + tint a fresh canvas on every call; with up
  // to 16 ghosts (8 back + 8 ahead) painted continuously during pan/zoom, that
  // was 16 canvas allocations + copyRegion + putImageData + fillRect per
  // frame. Cache the tinted region canvas per (frameId, tint, mode) triple,
  // rebuilt only when the flat bitmap cache is invalidated (same 'pixels'/
  // 'project'/'history' triggers as getFlatCanvas, via the shared flatDirty
  // flag). Alpha (0.35/k) is NOT baked in here — it varies by ghost distance
  // k, so it stays applied at composite time via ctx.globalAlpha in drawGhost.
  let ghostCache = new Map(); // key `${frameId}|${tintCss}|${mode}` -> canvas
  let ghostCacheSrc = null;   // flatBitmap this cache was built against

  function getGhostCanvas(flatBmp, gf, tintRgb, mode) {
    if (ghostCacheSrc !== flatBmp) {
      ghostCache.clear();
      ghostCacheSrc = flatBmp;
    }
    const tintCss = `rgb(${tintRgb[0]},${tintRgb[1]},${tintRgb[2]})`;
    const key = `${gf.id}|${tintCss}|${mode}`;
    let c = ghostCache.get(key);
    if (!c) {
      const region = copyRegion(flatBmp, gf.x, gf.y, gf.w, gf.h);
      c = document.createElement('canvas');
      c.width = Math.max(1, region.width);
      c.height = Math.max(1, region.height);
      const sctx = c.getContext('2d');
      sctx.imageSmoothingEnabled = false;
      if (mode === 'outline') {
        const traced = traceOutline(region, tintRgb);
        sctx.putImageData(new ImageData(traced.data, traced.width, traced.height), 0, 0);
      } else {
        sctx.putImageData(new ImageData(region.data, region.width, region.height), 0, 0);
        sctx.globalCompositeOperation = 'source-atop';
        sctx.fillStyle = tintCss;
        sctx.globalAlpha = 0.6;
        sctx.fillRect(0, 0, region.width, region.height);
      }
      ghostCache.set(key, c);
    }
    return c;
  }

  // ---- onion skin ----

  function frameById(sheet, id) { return sheet.frames.find(fr => fr.id === id) ?? null; }

  // Draws frame `gf`'s ghost into `ctx`, pivot-aligned against the edited
  // frame `f`, at distance `k` (1 = nearest neighbor) in direction `dir`
  // ('back' or 'ahead'). Mask and Outline are independent toggles (see the
  // checkboxes above, global to both directions) -- both, either, or
  // neither may draw; when both are on, mask (a soft tinted fill) draws
  // first and outline (a crisp edge trace) on top, each faded by that
  // DIRECTION's own base alpha (state.onion.{back,ahead}{Mask,Outline}Alpha)
  // over distance (/k), so past and future ghosts can be dialed
  // independently and raising one brightens ALL its ghosts, not just the
  // nearest. Only ever draws to scratch canvases / the view's screen-space
  // ctx — never touches layer bitmaps, so ghosts can never leak into saved
  // pixels/export.
  function drawGhost(ctx, flatBmp, f, gf, tintRgb, k, dir) {
    if (!gf) return;
    const dx = f.pivotX - gf.pivotX;
    const dy = f.pivotY - gf.pivotY;
    for (const mode of ['mask', 'outline']) {
      if (!state.onion[mode]) continue;
      const key = dir + (mode === 'mask' ? 'MaskAlpha' : 'OutlineAlpha');
      const baseAlpha = state.onion[key];
      if (baseAlpha <= 0) continue;
      const scratch = getGhostCanvas(flatBmp, gf, tintRgb, mode);
      ctx.save();
      ctx.globalAlpha = baseAlpha / k;
      ctx.drawImage(scratch, -dx, -dy);
      ctx.restore();
    }
  }

  function paintOnion(ctx, sheet, f) {
    const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
    const anim = sheet.animations.find(a => a.id === animationId);
    const ghosts = computeOnionGhosts(anim, f.id, state.onion);
    if (!ghosts.length) return;
    const bmp = getFlatBitmap(sheet);
    for (const ghost of ghosts) {
      drawGhost(ctx, bmp, f, frameById(sheet, ghost.frameId), resolveStepColor(state.onion, ghost.dir, ghost.k), ghost.k, ghost.dir);
    }
  }

  // ---- paint ----

  view.onPaint = (ctx) => {
    const sheet = activeSheet();
    const f = currentFrame();
    if (!sheet || !f) return;
    // own pixels: draw the sheet-global-aligned flattened canvas shifted so
    // the frame's top-left lands at frame-local (0,0), clipped to its rect.
    // Faded via onion.currentAlpha only while onion skin is on, so ghosts
    // (especially Outline) can read clearly against it; 1 (full) otherwise.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, f.w, f.h);
    ctx.clip();
    ctx.save();
    ctx.translate(-f.x, -f.y);
    ctx.globalAlpha = state.onion.enabled ? state.onion.currentAlpha : 1;
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
    const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
    const anim = sheet.animations.find(a => a.id === animationId) ?? null;
    return computeNeighborFrame(sheet, f, anim, dir);
  }

  let loadedFrameId = null;

  // Sets content size + recenters. Only called when the edited frame's
  // identity actually changes (initial open, prev/next, double-click a
  // different timeline cell) — NOT on every cosmetic 'view' event (overlay
  // toggles, etc.) or every pixel edit, so drawing never resets zoom/pan.
  // A different frame can belong to a different animation, i.e. a different
  // layer group (currentContextLayers() scopes to the selected animation)
  // -- the flat-bitmap cache below is keyed only on the SHEET reference and
  // a dirty flag toggled by project/history/pixels events, none of which
  // fire on a plain frame switch (double-click, Prev/Next), so without this
  // it kept showing/editing-through whatever animation's layers were
  // flattened for the PREVIOUSLY open frame.
  function loadFrame(f) {
    invalidateFlat();
    view.setContent({ width: f.w, height: f.h });
    view.centerFit();
    loadedFrameId = f.id;
  }

  function updateStrip() {
    const f = currentFrame();
    nameLabel.textContent = f ? f.name : '';
    onionEnable.checked = state.onion.enabled;
    currentAlphaInput.value = String(state.onion.currentAlpha);
    maskEnable.checked = state.onion.mask;
    outlineEnable.checked = state.onion.outline;
    backInput.value = String(state.onion.back);
    aheadInput.value = String(state.onion.ahead);
    backColorInput.value = state.onion.backColor;
    backMaskAlpha.input.value = String(state.onion.backMaskAlpha);
    backOutlineAlpha.input.value = String(state.onion.backOutlineAlpha);
    aheadColorInput.value = state.onion.aheadColor;
    aheadMaskAlpha.input.value = String(state.onion.aheadMaskAlpha);
    aheadOutlineAlpha.input.value = String(state.onion.aheadOutlineAlpha);
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
    // Prev/Next changes the editing frame without a 'view' emit, so the
    // floatsession auto-commit hook can't see it — commit here or a pending
    // float outlives its creation frame's frozen target rect.
    commitFloatIfAny();
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

  // Every onion control follows the codebase's live-preview/commit split
  // (see panels.js's layer-opacity slider): 'input' updates state + repaints
  // immediately while dragging/toggling (cheap -- alpha is applied at
  // composite time, never baked into the cached ghost canvases, see
  // getGhostCanvas), while 'change' (drag release / toggle settle) is the
  // only point that calls markDirty(), so the project's dirty flag doesn't
  // thrash on every drag tick but the final value still persists. Onion
  // prefs are a display setting, not editing history, so none of this is
  // pushed through state.commands (no undo entry), matching state.brushSize.
  function bindOnionField(input, apply, { eager = false } = {}) {
    const commit = () => { apply(); view.requestRender(); };
    input.addEventListener(eager ? 'input' : 'change', commit);
    input.addEventListener('change', () => markDirty());
  }
  bindOnionField(onionEnable, () => { state.onion.enabled = onionEnable.checked; });
  bindOnionField(maskEnable, () => { state.onion.mask = maskEnable.checked; });
  bindOnionField(outlineEnable, () => { state.onion.outline = outlineEnable.checked; });

  function bindOnionAlpha(input, key) {
    bindOnionField(input, () => {
      let v = parseFloat(input.value);
      if (!Number.isFinite(v)) v = 1;
      state.onion[key] = Math.max(0, Math.min(1, v));
    }, { eager: true });
  }
  bindOnionAlpha(currentAlphaInput, 'currentAlpha');
  bindOnionAlpha(backMaskAlpha.input, 'backMaskAlpha');
  bindOnionAlpha(backOutlineAlpha.input, 'backOutlineAlpha');
  bindOnionAlpha(aheadMaskAlpha.input, 'aheadMaskAlpha');
  bindOnionAlpha(aheadOutlineAlpha.input, 'aheadOutlineAlpha');

  function bindOnionCount(input, key) {
    bindOnionField(input, () => {
      let v = parseInt(input.value, 10);
      if (!Number.isFinite(v)) v = 1;
      v = Math.max(0, Math.min(8, v));
      input.value = String(v);
      state.onion[key] = v;
    });
  }
  bindOnionCount(backInput, 'back');
  bindOnionCount(aheadInput, 'ahead');

  bindOnionField(backColorInput, () => { state.onion.backColor = backColorInput.value; }, { eager: true });
  bindOnionField(aheadColorInput, () => { state.onion.aheadColor = aheadColorInput.value; }, { eager: true });

  // ---- per-step (per-distance-k) color overrides ----

  // Per-step overrides now live on the Onion Steps page of the Project
  // Settings dialog (main.js owns that dialog) rather than a dedicated
  // dialog here -- state.onion.stepColors is still exactly what gets read
  // (resolveStepColor() above) and written there; this button just opens Project
  // Settings pre-flipped to that page. main.js's 'project' listener above
  // (see refresh()) already re-syncs this toolbar and re-renders the view
  // whenever markDirty() fires, so no direct callback wiring is needed here.
  btnStepColors.addEventListener('click', () => runAction('edit.onionStepColors'));

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

  return { show, hide, view };
}
