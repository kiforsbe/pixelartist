// Drawing engine: the pointer-driven stroke lifecycle bound to a CanvasView.
//
// The tool palette (buttons + options + keyboard shortcuts) lives in
// components/tool-palette.js; this module owns bindDrawing, the shared
// pointer-drag engine every drawing tool in every mode (maps/sprites/tiles)
// runs through.
//
// Rendering note: pixel edits mutate layer bitmaps directly (in-place, for live
// preview) and main.js caches a flattened "scratch" composite that is normally
// only invalidated on project changes. To keep the canvas visually in sync
// during an in-progress stroke (before the undo command is committed) this
// module increments the store's lightweight pixel revision on every bitmap-affecting pointer
// step; main.js listens for it and just invalidates the scratch cache + repaints
// (no full setContent/dirty-flag work). The authoritative commit still goes
// through getEditorHost().history.execute() at stroke finalize -- HistoryService's
// own onChange wrapper marks the project dirty and fires 'project' -- and
// undo/redo is covered by main.js listening on 'history' the same way.

import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeLayer } from '../../host/document-helpers.js';
import {
  cloneBitmap, drawLine, drawRect, drawEllipse, floodFill, softFloodFill,
  copyRegion, blitRegion, fillRegion, getPixel,
} from '../../core/pixels.js';
import { makePixelPatch } from '../../core/commands.js';
import { forwardPoint, inversePoint, floatBounds, solveScaleTransform } from '../../core/floating.js';
import { nearestColor } from '../../core/palettes.js';
import { flattenSheet, animationGroup, flattenLayers } from '../../core/model.js';
import { segmentAt } from '../../core/strips.js';
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat, activeFloating, currentEditRegion } from './float-session.js';
import { commitAcceptAnimation } from '../../features/animations/commands.js';
import { stripForFrame as stripOf } from '../../domain/sprites/strips.js';
import { HANDLES_ALL, handlePoint, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../core/resizeAnchor.js';
import { drawRectDims, drawAngleLabel } from './dim-labels.js';
import { BRUSH_TOOLS, SHAPE_TOOLS, toolOptions } from '../tool-palette.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

// ---- one-shot canvas color sampling, for dialogs (not the main Eyedropper
// tool/drawing settings) --------------------------------------------------
//
// Filter dialogs (e.g. Remove Checkerboard's Color A/B) need to sample exact
// pixels straight off the sheet without forcing the user out to the main
// toolbar, switching to the Eyedropper tool, clicking, then coming back --
// that round trip through drawingSettings().primary/secondary was the whole
// point of moving this in-dialog instead. armColorSample arms every bound
// CanvasView (module-level, not per-view, since only one is ever visibly
// interactive at a time) to intercept its NEXT pointer-down -- ahead of
// mapPoint and the normal tool dispatch below, so it fires regardless of
// whichever tool happens to be selected and never reaches that tool -- reads
// the pixel there via the same flattenSheet/getPixel path handleEyedropper
// uses, and disarms itself. onCancel (Escape, or a second arm superseding
// this one) restores whatever affordance the caller showed while armed
// (e.g. a button's "click on canvas..." label) without a sample happening.
const sampleBoundCanvases = new Set();
let pendingColorSample = null; // { onSample, onCancel } | null
function setSampleCursor(cursor) { for (const c of sampleBoundCanvases) c.style.cursor = cursor; }
function sampleEscapeHandler(e) { if (e.key === 'Escape') cancelColorSample(); }
// onSample(rgba, { x, y }) -- the second argument is the sheet-space pixel
// that was clicked, for callers that care WHERE rather than what color (see
// checkerboardObjectHint's object hints). repeat:true keeps the arm live
// across clicks so the user can mark several things in a row without
// re-pressing the button; Escape (or another arm) still ends it via onCancel.
export function armColorSample(onSample, onCancel, { repeat = false } = {}) {
  cancelColorSample();
  pendingColorSample = { onSample, onCancel, repeat };
  setSampleCursor('crosshair');
  window.addEventListener('keydown', sampleEscapeHandler);
}
export function cancelColorSample() {
  if (!pendingColorSample) return;
  const { onCancel } = pendingColorSample;
  pendingColorSample = null;
  setSampleCursor('');
  window.removeEventListener('keydown', sampleEscapeHandler);
  onCancel?.();
}

function activeTool() {
  return getEditorHost().store.getState().session.activeToolId;
}

function activeViewKind() {
  return getEditorHost().store.getState().session.activeViewId?.split('.').at(-1) ?? null;
}

function drawingSettings() { return getEditorHost().store.getState().workspace.drawing; }
function notifyPixelsChanged() { getEditorHost().store.notifyPixelsChanged(); }

function activePalette() {
  const p = getEditorHost().projects.project;
  if (!p) return null;
  return p.palettes.find(pl => pl.id === p.activePaletteId) ?? null;
}

// -------------------------------------------------------------- stroke logic

// `mapPoint` is an optional (x, y) -> {x, y} hook applied to every pointer
// event BEFORE any tool logic runs. The sheet view passes nothing (its
// CanvasView's content space already IS sheet-global pixel space, so no
// translation is needed). The frame editor (Task 16) passes a hook that
// shifts its CanvasView's frame-local content coordinates (0..f.w, 0..f.h)
// into sheet-global bitmap coordinates (f.x..f.x+f.w, f.y..f.y+f.h) — the
// SAME layer bitmaps are edited either way, so everything downstream
// (clampPoint, maskOutsideTarget, finalize, flood fill, selection storage)
// stays sheet-global and unaware of which view produced the event.
export function bindDrawing(view, getTargetRect, mapPoint, viewKind = 'sheet') {
  sampleBoundCanvases.add(view.canvas);
  let stroke = null;   // pencil/eraser/line/rect/ellipse in-progress state
  let selStroke = null; // select tool in-progress state
  let moveStroke = null; // move tool in-progress state
  // Current marquee selection, image-space {x,y,w,h} or null. Instance state
  // (per bindDrawing() call) — bindDrawing() is invoked once per CanvasView
  // (sheet view in main.js, frame editor in frameeditor.js), and each view
  // must own its own selection: a marquee made on the sheet must not leak
  // into the frame editor (or vice versa) since both operate on the same
  // underlying layer bitmaps but represent different visible regions.
  let selection = null;

  function selectionContext(state = getEditorHost().store.getState()) {
    const doc = state.session.activeDocument;
    const selected = getEditorHost().selections.get(doc);
    const regionId = viewKind === 'frame' ? selected?.editingFrameId
      : viewKind === 'tile' ? selected?.editingTileId : null;
    return [state.project.model, doc?.kind, doc?.id, regionId];
  }

  function sameSelectionContext(a, b) {
    return a.every((value, index) => value === b[index]);
  }

  registerFloatView(viewKind, {
    getSelection: () => (selection ? { ...selection } : null),
    getSelectionContext: selectionContext,
    setSelection: (r, context) => {
      // Float commands may restore a marquee during undo/commit after the
      // user has moved to another document or frame/tile in the same view.
      if (context && !sameSelectionContext(context, selectionContext())) return;
      selection = r ? { ...r } : null;
      view.requestRender();
    },
    getTargetRect,
  });

  view.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // Marquees are sheet-global, but belong to one document/editing region.
  // Compare identities, not the whole mutable selection record: ordinary
  // selection patches, pixel notifications and dirty marks must not erase a
  // live marquee. Each view observes only its own frame/tile editing context.
  getEditorHost().store.subscribe(selectionContext, ([project], [previousProject]) => {
    selection = null;
    selStroke = null;
    if (project !== previousProject) {
      stroke = null;
      moveStroke = null;
    }
    view.requestRender();
  }, { equals: sameSelectionContext });

  // Clamp an image-space point into `target`; null when the target is empty
  // (no sheet, or outside any paintable segment). Live drawing pre-masks
  // coordinates with this so strokes cannot start or extend outside the
  // editable rect. `target` is resolved ONCE per stroke at handleDown and
  // threaded through explicitly (not re-queried via getTargetRect() on every
  // event) so a strip with multiple segments can't "flicker" mid-drag if the
  // pointer strays near another segment -- mirrors how the select tool
  // already freezes `selStroke.target` once at handleSelectDown.
  function clampPoint(x, y, target) {
    if (target.w <= 0 || target.h <= 0) return null;
    return {
      x: Math.max(target.x, Math.min(target.x + target.w - 1, x)),
      y: Math.max(target.y, Math.min(target.y + target.h - 1, y)),
    };
  }

  // Restore `before` pixels outside `target` within the given step bounds.
  // Catches writes that coordinate clamping alone cannot prevent (brush
  // stamps overflow up to brushSize-1 px past a clamped coordinate;
  // select-move can drag content past the target edge).
  function maskOutsideTarget(bitmap, before, x0, y0, x1, y1, target) {
    const t = target;
    const bx0 = Math.max(0, x0), by0 = Math.max(0, y0);
    const bx1 = Math.min(bitmap.width - 1, x1), by1 = Math.min(bitmap.height - 1, y1);
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) continue;
        const i = (y * bitmap.width + x) * 4;
        bitmap.data[i] = before.data[i];
        bitmap.data[i + 1] = before.data[i + 1];
        bitmap.data[i + 2] = before.data[i + 2];
        bitmap.data[i + 3] = before.data[i + 3];
      }
  }

  // swap=true returns the OTHER swatch for the pressed button (used as the
  // interior color of filled rect/ellipse shapes)
  function currentColor(ev, swap = false, forcePrimary = false) {
    if (activeTool() === 'eraser') return [0, 0, 0, 0];
    const useSecondary = !forcePrimary && (!!(ev.buttons & 2) !== swap);
    let c = useSecondary ? drawingSettings().secondary : drawingSettings().primary;
    const pal = activePalette();
    if (pal && pal.indexed && pal.colors.length) c = nearestColor(pal, c);
    return c;
  }

  function extend(dirty, x0, y0, x1, y1) {
    if (!dirty) return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
    return {
      minX: Math.min(dirty.minX, x0), minY: Math.min(dirty.minY, y0),
      maxX: Math.max(dirty.maxX, x1), maxY: Math.max(dirty.maxY, y1),
    };
  }

  function finalize(layer, before, dirty, label, target) {
    if (!dirty) return;
    const bmp = layer.bitmap;
    // full extent the stroke may have touched, clamped to bitmap bounds only
    const fx0 = Math.max(dirty.minX, 0), fy0 = Math.max(dirty.minY, 0);
    const fx1 = Math.min(dirty.maxX, bmp.width - 1), fy1 = Math.min(dirty.maxY, bmp.height - 1);
    if (fx1 < fx0 || fy1 < fy0) return;
    const x0 = Math.max(fx0, target.x);
    const y0 = Math.max(fy0, target.y);
    const x1 = Math.min(fx1, target.x + target.w - 1);
    const y1 = Math.min(fy1, target.y + target.h - 1);
    if (x1 < x0 || y1 < y0) {
      // nothing inside the target: discard any stray live edits, no command
      blitRegion(bmp, copyRegion(before, fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1), fx0, fy0);
      notifyPixelsChanged();
      return;
    }
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const beforeRegion = copyRegion(before, rect.x, rect.y, rect.w, rect.h);
    const afterRegion = copyRegion(bmp, rect.x, rect.y, rect.w, rect.h);
    // restore EVERYTHING the stroke touched (including any out-of-target
    // bleed), then let the command re-apply the target-clamped patch — undo
    // is exact and nothing outside the target can persist.
    blitRegion(bmp, copyRegion(before, fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1), fx0, fy0);
    // Routes directly through HistoryService.execute() rather than a
    // registered-by-id Command Handler: this command closes over the live
    // `bmp` reference already resolved above, so there is no id to
    // re-resolve later, and HistoryService.execute() is what a Command
    // Handler dispatch would end up calling anyway. It marks the project
    // dirty on every push, so no separate markDirty() call is needed here,
    // and it files the command under the active document's own history.
    getEditorHost().history.execute(makePixelPatch(bmp, rect, beforeRegion, afterRegion, label));
  }

  // If the currently selected animation is floating (no layer yet -- see
  // acceptAnimation in core/model.js), accept it before resolving the
  // active layer to write into, so drawing "just works" without the user
  // needing to explicitly accept first (Enter key, frames.js's
  // registerFrameTool). No-ops for read-only tools (eyedropper doesn't call
  // this), tile mode (animation selection isn't used there), or
  // when nothing is selected/already accepted.
  function acceptFloatingContextIfAny() {
    const sheet = activeSheet();
    if (!sheet) return;
    const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
    if (!animationId) return;
    const anim = sheet.animations.find(a => a.id === animationId);
    if (anim && !anim.layerGroupId) commitAcceptAnimation(sheet, anim);
  }

  // ---- pencil / eraser / fill / soft flood / line / rect / ellipse ----

  function handleDown(ev) {
    acceptFloatingContextIfAny();
    const layer = activeLayer();
    if (!layer) return;
    const tool = activeTool();
    const before = cloneBitmap(layer.bitmap);
    const color = currentColor(ev);

    if (tool === 'fill') {
      // only act when the seed is inside the target; flood a copy of the
      // target region so the fill cannot leak outside it
      const t = getTargetRect(ev.x, ev.y);
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const r = floodFill(sub, ev.x - t.x, ev.y - t.y, color, toolOptions.contiguous);
      let dirty = null;
      if (r) {
        blitRegion(layer.bitmap, sub, t.x, t.y);
        dirty = extend(null, t.x + r.x, t.y + r.y, t.x + r.x + r.w - 1, t.y + r.y + r.h - 1);
      }
      finalize(layer, before, dirty, 'fill', t);
      stroke = null;
      notifyPixelsChanged();
      return;
    }
    if (tool === 'softflood') {
      // Work on a target-sized copy, preserving the same strip/tile boundary
      // guarantees as hard fill while the core algorithm computes its region.
      const t = getTargetRect(ev.x, ev.y);
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const r = softFloodFill(sub, ev.x - t.x, ev.y - t.y, currentColor(ev, false, true), {
        ...toolOptions.softFlood,
        mode: ev.buttons & 2 ? 'erase' : 'fill',
      });
      let dirty = null;
      if (r) {
        blitRegion(layer.bitmap, sub, t.x, t.y);
        dirty = extend(null, t.x + r.x, t.y + r.y, t.x + r.x + r.w - 1, t.y + r.y + r.h - 1);
      }
      finalize(layer, before, dirty, 'soft flood', t);
      stroke = null;
      notifyPixelsChanged();
      return;
    }
    if (BRUSH_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      const brushSize = drawingSettings().brushSize;
      drawLine(layer.bitmap, p.x, p.y, p.x, p.y, color, brushSize);
      maskOutsideTarget(layer.bitmap, before, p.x, p.y, p.x + brushSize - 1, p.y + brushSize - 1, target);
      const dirty = extend(null, p.x, p.y, p.x + brushSize - 1, p.y + brushSize - 1);
      stroke = { tool, layer, before, color, dirty, last: p, target };
      notifyPixelsChanged();
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      // filled shapes: outline in the pressed button's color, interior in the
      // opposite swatch (left = primary outline / secondary fill, right = swapped)
      const fill = (tool !== 'line' && toolOptions.filled) ? currentColor(ev, true) : null;
      stroke = { tool, layer, before, color, fill, dirty: null, anchor: p, target };
      notifyPixelsChanged();
      return;
    }
  }

  function handleMove(ev) {
    if (!stroke) return;
    const { tool, layer, before, color } = stroke;
    if (BRUSH_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      const last = stroke.last;
      const brushSize = drawingSettings().brushSize;
      drawLine(layer.bitmap, last.x, last.y, p.x, p.y, color, brushSize);
      const sx0 = Math.min(last.x, p.x), sy0 = Math.min(last.y, p.y);
      const sx1 = Math.max(last.x, p.x) + brushSize - 1;
      const sy1 = Math.max(last.y, p.y) + brushSize - 1;
      maskOutsideTarget(layer.bitmap, before, sx0, sy0, sx1, sy1, stroke.target);
      stroke.dirty = extend(stroke.dirty, sx0, sy0, sx1, sy1);
      stroke.last = p;
      notifyPixelsChanged();
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      blitRegion(layer.bitmap, before, 0, 0);
      const a = stroke.anchor;
      if (tool === 'line') {
        const brushSize = drawingSettings().brushSize;
        drawLine(layer.bitmap, a.x, a.y, p.x, p.y, color, brushSize);
        const sx1 = Math.max(a.x, p.x) + brushSize - 1;
        const sy1 = Math.max(a.y, p.y) + brushSize - 1;
        maskOutsideTarget(layer.bitmap, before, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1, stroke.target);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1);
      } else if (tool === 'rect') {
        drawRect(layer.bitmap, a.x, a.y, p.x, p.y, color, stroke.fill);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y));
      } else if (tool === 'ellipse') {
        drawEllipse(layer.bitmap, a.x, a.y, p.x, p.y, color, stroke.fill);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y));
      }
      notifyPixelsChanged();
      return;
    }
  }

  function handleUp(ev) {
    if (!stroke) return;
    handleMove(ev); // commit final pointer position (handles click-without-move too)
    const { tool, layer, before, dirty, target } = stroke;
    finalize(layer, before, dirty, tool, target);
    stroke = null;
  }

  // ---- eyedropper ----

  function handleEyedropper(ev) {
    if (ev.type !== 'down') return;
    const sheet = activeSheet();
    if (!sheet) return;
    const flat = flattenSheet(sheet, activeFloating());
    const p = getPixel(flat, ev.x, ev.y);
    if (!p) return;
    getEditorHost().store.updateDrawingSettings(ev.buttons & 2 ? { secondary: p } : { primary: p });
  }

  // ---- select (marquee only — the move tool is the only content mover) ----

  function insideRect(px, py, r) {
    return !!r && px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h;
  }

  // Keeps a moved selection rect fully inside the target rect.
  function clampRectToTarget(r, t) {
    const maxX = Math.max(t.x, t.x + t.w - r.w);
    const maxY = Math.max(t.y, t.y + t.h - r.h);
    return { x: Math.max(t.x, Math.min(maxX, r.x)), y: Math.max(t.y, Math.min(maxY, r.y)), w: r.w, h: r.h };
  }

  // 8 handle anchor points on the marquee, image-space EDGE coords
  const SEL_HANDLES = HANDLES_ALL;
  function hitSelHandle(ev) {
    if (!selection) return null;
    for (const h of SEL_HANDLES) {
      const p = toScreen(handlePoint(selection, h));
      if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) return h;
    }
    return null;
  }

  function handleSelectDown(ev) {
    acceptFloatingContextIfAny();
    if (!activeLayer()) return;
    const target = getTargetRect(ev.x, ev.y);
    const handle = hitSelHandle(ev);
    if (handle) {
      selStroke = { mode: 'resize', target, handle, orig: { ...selection }, anchor: { x: ev.x, y: ev.y }, moved: false };
      view.requestRender();
      return;
    }
    if (insideRect(ev.x, ev.y, selection)) {
      // drag the marquee rect itself — shape preserved, contents untouched
      selStroke = { mode: 'moverect', target, anchor: { x: ev.x, y: ev.y }, orig: { x: selection.x, y: selection.y, w: selection.w, h: selection.h } };
    } else {
      selection = null;
      selStroke = { mode: 'new', target, anchor: { x: ev.x, y: ev.y } };
    }
    view.requestRender();
  }

  function handleSelectMove(ev) {
    if (!selStroke) return;
    const target = selStroke.target;
    if (selStroke.mode === 'new') {
      const a = selStroke.anchor;
      const cx = Math.max(target.x, Math.min(target.x + target.w - 1, ev.x));
      const cy = Math.max(target.y, Math.min(target.y + target.h - 1, ev.y));
      const ax = Math.max(target.x, Math.min(target.x + target.w - 1, a.x));
      const ay = Math.max(target.y, Math.min(target.y + target.h - 1, a.y));
      const x0 = Math.min(ax, cx), x1 = Math.max(ax, cx);
      const y0 = Math.min(ay, cy), y1 = Math.max(ay, cy);
      selection = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    } else if (selStroke.mode === 'resize') {
      // A plain click on a handle must not nudge the rect: the e/s handle
      // centers sit ON the edge coordinate, which resizeRectFromHandle's
      // `inclusive: true` reads as an inclusive pixel (a no-move click
      // would grow the rect by 1) — only recompute once the pointer has
      // left the pointer-down pixel.
      if (ev.x !== selStroke.anchor.x || ev.y !== selStroke.anchor.y) selStroke.moved = true;
      if (selStroke.moved) selection = resizeRectFromHandle(selStroke.orig, selStroke.handle, ev.x, ev.y, {
        useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev), target, inclusive: true,
      });
    } else if (selStroke.mode === 'moverect') {
      const dx = ev.x - selStroke.anchor.x, dy = ev.y - selStroke.anchor.y;
      selection = clampRectToTarget(
        { x: selStroke.orig.x + dx, y: selStroke.orig.y + dy, w: selStroke.orig.w, h: selStroke.orig.h },
        target,
      );
    }
    view.requestRender();
  }

  function handleSelectUp(ev) {
    if (!selStroke) return;
    handleSelectMove(ev);
    if (selStroke.mode === 'new' && (!selection || selection.w <= 0 || selection.h <= 0)) selection = null;
    selStroke = null;
    view.requestRender();
  }

  // ---- move (floating selection) ----
  //
  // The move tool never edits bitmaps directly: pointer-down cuts the region
  // into the floating-selection session, and every gesture only
  // mutates float.transform live, pushing one transform command per completed
  // drag. Enter/Escape/tool-switch commit or cancel via floatsession.

  const HANDLE_PX = 5;    // half-size of a scale handle hit box, screen px
  const KNOB_OFFSET = 20; // rotation knob distance beyond top-center, screen px
  const KNOB_R = 7;

  // sheet-global point -> screen px. Every view's imageToScreen accepts
  // sheet-global coords directly: the sheet view's content space already IS
  // sheet-global, and the frame/tile editors OVERRIDE imageToScreen to accept
  // sheet-global input and subtract their own offset internally (see their
  // module comments) — so no un-mapping is needed here.
  function toScreen(p) {
    return view.imageToScreen(p.x, p.y);
  }

  // 4 corners + 4 edge midpoints in buffer space, named so handleMoveDown
  // can identify which one was grabbed (needed by solveScaleTransform).
  function handleAnchors(float) {
    const { w, h } = float.srcRect;
    return [
      { handle: 'nw', u: 0, v: 0 }, { handle: 'ne', u: w, v: 0 },
      { handle: 'se', u: w, v: h }, { handle: 'sw', u: 0, v: h },
      { handle: 'n', u: w / 2, v: 0 }, { handle: 'e', u: w, v: h / 2 },
      { handle: 's', u: w / 2, v: h }, { handle: 'w', u: 0, v: h / 2 },
    ];
  }

  function floatCenter(float) {
    return forwardPoint(float, float.srcRect.w / 2, float.srcRect.h / 2);
  }

  function knobScreenPos(float) {
    const pTop = toScreen(forwardPoint(float, float.srcRect.w / 2, 0));
    const pC = toScreen(floatCenter(float));
    const dx = pTop.x - pC.x, dy = pTop.y - pC.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: pTop.x + (dx / len) * KNOB_OFFSET, y: pTop.y + (dy / len) * KNOB_OFFSET };
  }

  function handleMoveDown(ev) {
    const sheet = activeSheet();
    if (!sheet) return;
    const float = activeFloating();
    if (float && float.sheetId === sheet.id) {
      // Frame-floats are translate-only: no rotation knob, no scale handles.
      const knob = !float.frameIds && knobScreenPos(float);
      if (knob && Math.hypot(ev.sx - knob.x, ev.sy - knob.y) <= KNOB_R + 2) {
        const c = floatCenter(float);
        moveStroke = {
          kind: 'rotate', t0: { ...float.transform },
          center: c, angle0: Math.atan2(ev.y + 0.5 - c.y, ev.x + 0.5 - c.x),
        };
        return;
      }
      if (!float.frameIds) for (const a of handleAnchors(float)) {
        const p = toScreen(forwardPoint(float, a.u, a.v));
        if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) {
          moveStroke = { kind: 'scale', t0: { ...float.transform }, handle: a.handle };
          return;
        }
      }
      const { u, v } = inversePoint(float, ev.x + 0.5, ev.y + 0.5);
      if (u >= 0 && v >= 0 && u < float.srcRect.w && v < float.srcRect.h) {
        moveStroke = { kind: 'translate', t0: { ...float.transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
      commitFloatIfAny(); // pressed outside: commit; next press starts fresh
      return;
    }
    // No float yet. On the sheet view with no marquee, a down on a frame or
    // strip segment starts a FRAME-FLOAT: the region's pixels float exactly
    // like a selection — live preview, commit on Enter/outside click — but
    // translate-only, and on commit the frame rects move with the pixels.
    // Everything else keeps the classic behavior: cut the selection (or
    // whole target) and drag it.
    if (activeViewKind() === 'sheet' && !selection) {
      const seg = segmentAt(sheet, ev.x, ev.y);
      if (seg) {
        // An accepted strip's own segment carries only ITS OWN layer(s) --
        // resolved from the segment's owning strip, never from whatever's
        // ambiently selected in the timeline (see docs/superpowers/specs/
        // 2026-07-18-strip-area-constraint-design.md). A floating strip or a
        // plain frame has no strip-owned layer to resolve, so falls back to
        // today's ambient allLayers:true capture.
        const owner = stripOf(sheet, seg.frameIds[0]);
        const ownGroup = owner?.layerGroupId ? animationGroup(sheet, owner.id) : null;
        const layers = ownGroup ? flattenLayers(ownGroup) : null;
        if (!createFloat({ allLayers: true, region: seg.rect, frameIds: seg.frameIds, layers, x: ev.x, y: ev.y })) return;
        moveStroke = { kind: 'translate', t0: { ...activeFloating().transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
    }
    if (!createFloat({ allLayers: !!ev.altKey, x: ev.x, y: ev.y })) return;
    moveStroke = { kind: 'translate', t0: { ...activeFloating().transform }, anchor: { x: ev.x, y: ev.y } };
  }

  function handleMoveMove(ev) {
    if (!moveStroke || !activeFloating()) return;
    const float = activeFloating();
    const t0 = moveStroke.t0;
    if (moveStroke.kind === 'translate') {
      float.transform.tx = t0.tx + Math.round(ev.x - moveStroke.anchor.x);
      float.transform.ty = t0.ty + Math.round(ev.y - moveStroke.anchor.y);
      if (float.frameIds) {
        // Frame rects must stay on-sheet, so the frame-float clamps where a
        // plain float may overhang (commit crops overhang pixels anyway).
        const sheet = activeSheet();
        if (sheet) {
          float.transform.tx = Math.max(-float.srcRect.x,
            Math.min(sheet.width - float.srcRect.x - float.srcRect.w, float.transform.tx));
          float.transform.ty = Math.max(-float.srcRect.y,
            Math.min(sheet.height - float.srcRect.y - float.srcRect.h, float.transform.ty));
        }
        syncFrameFloat(); // rects follow live — the frame itself is moving
      }
    } else if (moveStroke.kind === 'rotate') {
      const c = moveStroke.center;
      float.transform.rot = t0.rot + (Math.atan2(ev.y + 0.5 - c.y, ev.x + 0.5 - c.x) - moveStroke.angle0);
    } else { // scale
      float.transform = solveScaleTransform({
        srcRect: float.srcRect, t0, handle: moveStroke.handle,
        useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
        mx: ev.x + 0.5, my: ev.y + 0.5,
      });
    }
    notifyPixelsChanged();
  }

  function handleMoveUp(ev) {
    if (!moveStroke) return;
    handleMoveMove(ev);
    const t0 = moveStroke.t0;
    moveStroke = null;
    if (activeFloating()) pushTransformCommand(t0, { ...activeFloating().transform });
  }

  // ---- dispatch ----

  view.onPointer = (ev) => {
    if (pendingColorSample) {
      if (ev.type === 'down') {
        const { onSample, onCancel, repeat } = pendingColorSample;
        if (!repeat) {
          pendingColorSample = null;
          setSampleCursor('');
          window.removeEventListener('keydown', sampleEscapeHandler);
        }
        const sheet = activeSheet();
        const flat = sheet ? flattenSheet(sheet, activeFloating()) : null;
        const p = flat ? getPixel(flat, ev.x, ev.y) : null;
        // A click that lands outside the sheet (or with nothing to sample)
        // still needs to resolve the armed state -- falling through to
        // onCancel keeps the caller's UI (e.g. a "Click on canvas..."
        // button) from getting stuck armed with nothing left listening. A
        // repeating arm has nothing to resolve: it stays live, so a stray
        // click off the sheet is simply ignored.
        if (p) onSample(p, { x: ev.x, y: ev.y });
        else if (!repeat) onCancel?.();
      }
      return;
    }
    if (mapPoint) {
      const p = mapPoint(ev.x, ev.y);
      ev = { ...ev, x: p.x, y: p.y };
    }
    const tool = activeTool();
    // The frame tool (registered by frames.js via registerTool()) and the tile
    // tool (registered by tilemode.js) own pointer routing on the sheet view
    // when active — each wraps view.onPointer around this function and
    // delegates back for every other tool, so this dispatcher must ignore
    // their events rather than fight over them.
    if (tool === 'frametool' || tool === 'tiletool') return;
    if (tool === 'select') {
      if (ev.type === 'down') handleSelectDown(ev);
      else if (ev.type === 'move') handleSelectMove(ev);
      else if (ev.type === 'up') handleSelectUp(ev);
      return;
    }
    if (tool === 'move') {
      if (ev.type === 'down') handleMoveDown(ev);
      else if (ev.type === 'move') handleMoveMove(ev);
      else if (ev.type === 'up') handleMoveUp(ev);
      return;
    }
    if (tool === 'eyedropper') { handleEyedropper(ev); return; }
    if (ev.type === 'down') handleDown(ev);
    else if (ev.type === 'move') handleMove(ev);
    else if (ev.type === 'up') handleUp(ev);
  };

  function drawHandleSquare(ctx, p) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.fillRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
    ctx.strokeRect(p.x - HANDLE_PX + 0.5, p.y - HANDLE_PX + 0.5, HANDLE_PX * 2 - 1, HANDLE_PX * 2 - 1);
  }

  view.onOverlay = (ctx) => {
    const float = activeFloating();
    const sheet = activeSheet();
    if (float && sheet && float.sheetId === sheet.id && activeTool() === 'move') {
      const { w, h } = float.srcRect;
      const corners = [[0, 0], [w, 0], [w, h], [0, h]]
        .map(([u, v]) => toScreen(forwardPoint(float, u, v)));
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      // Frame-floats use the frame tool's ghost style (plain white dashes),
      // not the selection's white/black marching ants.
      const dashes = float.frameIds ? [['#fff', 0]] : [['#fff', 0], ['#000', 4]];
      for (const [color, off] of dashes) {
        ctx.strokeStyle = color;
        ctx.lineDashOffset = off;
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(p.x + 0.5, p.y + 0.5) : ctx.moveTo(p.x + 0.5, p.y + 0.5)));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Frame-floats read as a moving frame, not a transformable selection:
      // outline + dimension chrome only — no scale handles, no rotation knob.
      let knob = null;
      if (!float.frameIds) {
        for (const a of handleAnchors(float)) {
          drawHandleSquare(ctx, toScreen(forwardPoint(float, a.u, a.v)));
        }
        knob = knobScreenPos(float);
        const top = toScreen(forwardPoint(float, w / 2, 0));
        ctx.strokeStyle = '#fff';
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(knob.x, knob.y); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
        ctx.beginPath(); ctx.arc(knob.x, knob.y, KNOB_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      const t = float.transform;
      const bounds = floatBounds(float);
      const scaledW = Math.round(float.srcRect.w * Math.abs(t.sx));
      const scaledH = Math.round(float.srcRect.h * Math.abs(t.sy));
      const opts = { wOverride: scaledW, hOverride: scaledH };
      if (moveStroke?.kind === 'translate') {
        opts.dx = t.tx - moveStroke.t0.tx;
        opts.dy = t.ty - moveStroke.t0.ty;
      } else if (moveStroke?.kind === 'scale') {
        opts.dw = scaledW - Math.round(float.srcRect.w * Math.abs(moveStroke.t0.sx));
        opts.dh = scaledH - Math.round(float.srcRect.h * Math.abs(moveStroke.t0.sy));
      } else if (!moveStroke) {
        opts.quiet = true;
      }
      drawRectDims(ctx, view, bounds, opts);
      if (knob && (moveStroke?.kind === 'rotate' || (!moveStroke && t.rot !== 0))) {
        drawAngleLabel(ctx, knob.x + KNOB_R + 4, knob.y, t.rot);
      }
      return;
    }
    if (!selection) return;
    const p0 = toScreen({ x: selection.x, y: selection.y });
    const p1 = toScreen({ x: selection.x + selection.w, y: selection.y + selection.h });
    ctx.save();
    ctx.lineWidth = 1;
    const rw = p1.x - p0.x, rh = p1.y - p0.y;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 0;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, rw - 1, rh - 1);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = 4;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, rw - 1, rh - 1);
    ctx.restore();
    if (activeTool() === 'select') {
      for (const h of SEL_HANDLES) drawHandleSquare(ctx, toScreen(handlePoint(selection, h)));
      if (selStroke?.mode === 'resize') {
        drawRectDims(ctx, view, selection, {
          dw: selection.w - selStroke.orig.w, dh: selection.h - selStroke.orig.h,
        });
      } else if (selStroke?.mode === 'moverect') {
        drawRectDims(ctx, view, selection, {
          dx: selection.x - selStroke.orig.x, dy: selection.y - selStroke.orig.y,
        });
      } else if (selStroke?.mode === 'new') {
        drawRectDims(ctx, view, selection);
      } else {
        drawRectDims(ctx, view, selection, { quiet: true });
      }
    }
  };

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey
      && activeTool() === 'select' && activeViewKind() === viewKind && selection && !activeFloating()) {
      const layer = activeLayer();
      if (!layer) return;
      // Geometry can change without changing the editing-region identity.
      // Use the same current-target intersection as cut and move.
      const region = currentEditRegion()?.region;
      if (!region) return;
      const before = copyRegion(layer.bitmap, region.x, region.y, region.w, region.h);
      const after = cloneBitmap(before);
      fillRegion(after, 0, 0, after.width, after.height, [0, 0, 0, 0]);
      // Avoid adding a no-op history entry for an already-empty selection.
      if (before.data.every((value, index) => value === after.data[index])) return;
      // Same reasoning as finalize() above: direct history.execute(), no
      // separate markDirty() (HistoryService's onChange already marks dirty).
      getEditorHost().history.execute(makePixelPatch(layer.bitmap, region, before, after, 'delete selection'));
      notifyPixelsChanged();
      view.requestRender();
      e.preventDefault();
      return;
    }
    if (e.key !== 'Escape') return;
    if (activeFloating()) return; // floatsession's capture handler owns Escape while floating
    if (selection) { selection = null; view.requestRender(); }
  });
}
