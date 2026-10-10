// js/components/canvas/frame-canvas.js
// A focused, zoomed-in canvas on one frame of the active sprite sheet, with
// onion-skinning against an animation's neighbours. Shared by the Frame
// Editor (sprites.frame) and the Animations canvas (animations.canvas).
//
// Owns its own CanvasView, created once and kept for the app's lifetime --
// CanvasView has no teardown and installs window-level key listeners.
//
// Coordinate mapping: the view's content space is frame-local (0..f.w,
// 0..f.h), so zoom/pan/centerFit work in frame-sized units, but the layer
// bitmaps being edited are sheet-global. Two things bridge that gap:
//   1. `mapPoint(x, y)` passed to bindDrawing() shifts every pointer event
//      from frame-local to sheet-global (+f.x, +f.y) before any tool logic
//      runs, so strokes/fills/selection are computed in sheet space exactly
//      like the sheet view (getTargetRect() is sheet-global too).
//   2. Selection/marquee state is therefore sheet-global, so this view's
//      `imageToScreen` subtracts the frame offset before zoom/pan, and
//      overlays drawn through it land in the right place. `screenToImage` is
//      left untouched (the translation happens once, in mapPoint).
// onPaint works in frame-local space: it translates by -f.x,-f.y only around
// the flattened-sheet drawImage, then draws pivot-aligned onion ghosts.
import { CanvasView } from './canvas-view.js';
import { bindDrawing } from './drawing-engine.js';
import { activeFloating } from './float-session.js';
import { createRasterCache } from './raster-cache.js';
import { flattenSheetLayers } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';
import { computeOnionGhosts, resolveStepColor, traceOutline } from '../../domain/sprites/onion-skin.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, currentContextLayers } from '../../host/document-helpers.js';

function onionSettings() { return getEditorHost().projects.project?.settings?.onion ?? null; }

export function createFrameCanvas(hostEl, { viewKind, getFrame, getOnionAnimation, onStateChange, keepViewAcrossFrames = false }) {
  const view = new CanvasView(hostEl);

  view.imageToScreen = (x, y) => {
    const f = getFrame();
    const fx = f ? f.x : 0, fy = f ? f.y : 0;
    return { x: (x - fx) * view.zoom + view.panX, y: (y - fy) * view.zoom + view.panY };
  };

  function getTargetRect() {
    const f = getFrame();
    return f ? { x: f.x, y: f.y, w: f.w, h: f.h } : { x: 0, y: 0, w: 0, h: 0 };
  }

  function mapPoint(x, y) {
    const f = getFrame();
    return f ? { x: x + f.x, y: y + f.y } : { x, y };
  }

  bindDrawing(view, getTargetRect, mapPoint, viewKind);

  // ---- flattened-sheet cache, invalidated on pixels/project/history/selection ----
  const flatCache = createRasterCache();
  function invalidateFlat() { flatCache.invalidate(); }
  function flattenCurrentSheet(sheet) { return flattenSheetLayers(currentContextLayers(), sheet.width, sheet.height, activeFloating(), sheet.id); }
  function getFlatBitmap(sheet) { return flatCache.getBitmap(sheet, flattenCurrentSheet); }
  function getFlatCanvas(sheet) { return flatCache.getCanvas(sheet, flattenCurrentSheet); }

  // ---- ghost scratch cache (onion skin) ----
  // Up to 16 ghosts repaint continuously during pan/zoom; cache each tinted
  // region canvas per (frameId, tint, mode), rebuilt only when the flat
  // bitmap changes. Alpha varies by ghost distance k, so it stays applied at
  // composite time via ctx.globalAlpha.
  const ghostCache = new Map(); // `${frameId}|${tintCss}|${mode}` -> canvas
  let ghostCacheSrc = null;     // flat bitmap this cache was built against

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

  // Draws frame `gf`'s ghost pivot-aligned against the edited frame `f`, at
  // distance `k` in direction `dir`. Mask (a soft tinted fill) draws first
  // and outline (a crisp edge trace) on top, each faded by that direction's
  // base alpha over distance (/k). Only ever draws to scratch canvases / the
  // view's ctx -- ghosts can never leak into saved pixels or export.
  function drawGhost(ctx, flatBmp, f, gf, tintRgb, k, dir) {
    if (!gf) return;
    const dx = f.pivotX - gf.pivotX;
    const dy = f.pivotY - gf.pivotY;
    for (const mode of ['mask', 'outline']) {
      const onion = onionSettings();
      if (!onion?.[mode]) continue;
      const baseAlpha = onion[dir + (mode === 'mask' ? 'MaskAlpha' : 'OutlineAlpha')];
      if (baseAlpha <= 0) continue;
      const scratch = getGhostCanvas(flatBmp, gf, tintRgb, mode);
      ctx.save();
      ctx.globalAlpha = baseAlpha / k;
      ctx.drawImage(scratch, -dx, -dy);
      ctx.restore();
    }
  }

  function paintOnion(ctx, sheet, f) {
    const onion = onionSettings();
    if (!onion) return;
    const ghosts = computeOnionGhosts(getOnionAnimation(), f.id, onion);
    if (!ghosts.length) return;
    const bmp = getFlatBitmap(sheet);
    for (const ghost of ghosts) {
      const gf = sheet.frames.find(fr => fr.id === ghost.frameId) ?? null;
      drawGhost(ctx, bmp, f, gf, resolveStepColor(onion, ghost.dir, ghost.k), ghost.k, ghost.dir);
    }
  }

  view.onPaint = (ctx) => {
    const sheet = activeSheet('sprite');
    const f = getFrame();
    if (!sheet || !f) return;
    // Own pixels: the sheet-aligned flattened canvas shifted so the frame's
    // top-left lands at (0,0), clipped to its rect, faded by currentAlpha
    // only while onion skin is on.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, f.w, f.h);
    ctx.clip();
    ctx.save();
    ctx.translate(-f.x, -f.y);
    const onion = onionSettings();
    ctx.globalAlpha = onion?.enabled ? onion.currentAlpha : 1;
    ctx.drawImage(getFlatCanvas(sheet), 0, 0);
    ctx.restore();
    ctx.restore();
    // Ghosts are unclipped: pivot offsets can shift one partly outside.
    paintOnion(ctx, sheet, f);
  };

  // ---- frame loading and visibility ----
  let loadedFrameId = null;
  let visible = false;
  // Host CSS size last seen while visible: reopening the same frame after
  // the host was resized while hidden must recenter.
  let lastCssW = 0, lastCssH = 0;

  // Sets content size + recenters. Only when the frame's identity or size
  // changed -- never on a pixel edit, so drawing never resets zoom/pan. A
  // different frame has a different raster, so the flat cache goes too.
  // With keepViewAcrossFrames (the Animations canvas, which plays frames
  // through it) a frame of the same size keeps the zoom/pan instead.
  function loadFrame(f) {
    invalidateFlat();
    view.setContent({ width: f.w, height: f.h });
    view.centerFit();
    loadedFrameId = f.id;
  }

  function sync() {
    const f = getFrame();
    if (!f) return null;
    const sameSize = view.width === f.w && view.height === f.h;
    if (keepViewAcrossFrames && sameSize && loadedFrameId != null) loadedFrameId = f.id;
    else if (loadedFrameId !== f.id || !sameSize) loadFrame(f);
    view.requestRender();
    return f;
  }

  // The host may have been display:none: CanvasView's cached css size is
  // stale (its ResizeObserver is async), so remeasure synchronously first.
  function shown() {
    const wasHidden = !visible;
    visible = true;
    if (wasHidden) {
      view._resize();
      if (loadedFrameId != null && (view.cssWidth !== lastCssW || view.cssHeight !== lastCssH)) view.centerFit();
    }
    return sync();
  }

  function hidden() {
    lastCssW = view.cssWidth;
    lastCssH = view.cssHeight;
    visible = false;
  }

  const editorHost = getEditorHost();
  const changed = () => { invalidateFlat(); if (visible) onStateChange(); };
  editorHost.store.subscribe(s => s.project.model, changed);
  editorHost.history.subscribe(changed);
  editorHost.store.subscribe(s => s.workspace.pixelRevision, () => { invalidateFlat(); if (visible) view.requestRender(); });
  editorHost.store.subscribe(
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
    changed,
  );

  return { view, sync, shown, hidden, isVisible: () => visible };
}
