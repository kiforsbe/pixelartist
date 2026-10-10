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
import { activeSheet, activeEditableLayer } from '../../host/document-helpers.js';
import {
  cloneBitmap, stamp, drawRect, drawEllipse, floodFill, softFloodFill,
  copyRegion, blitRegion, fillRegion, getPixel,
  rectOutlinePath, ellipseOutlinePath,
} from '../../core/pixels.js';
import { makePixelPatch } from '../../core/commands.js';
import { forwardPoint, inversePoint, floatBounds, solveScaleTransform } from '../../core/floating.js';
import { nearestColor } from '../../core/palettes.js';
import { maskGridFor, effectiveMaskSize } from '../../core/brushes.js';
import { strokeStamps, stampsAlongPath, newStrokeSeed, strokeBounds, pathSteps } from '../../core/brush-stroke.js';
import { makeInk } from '../../core/brush-ink.js';
import { flattenSheet } from '../../core/model.js';
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat, activeFloating, currentEditRegion } from './float-session.js';
import { frameAt } from '../../domain/sprites/frames.js';
import { isPinnedFrame } from '../../domain/sprites/auto-layout.js';
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

// The active brush. `drawing.brush` always exists now (editor-store.js's
// migrateDrawingSettings guarantees it), so there is no fallback to
// synthesise one from the retired `brushSize` scalar.
function activeBrush() {
  return drawingSettings().brush;
}

// Fill tools ink a single click, so they build their own ink with a fresh
// seed rather than borrowing a stroke's.
//
// `origin` is the sheet-space position of the bitmap this ink will paint
// into. It is (0,0) for anything painting straight onto a layer, but the fill
// tools flood a detached copy of the target region whose own origin is (0,0),
// and the ink's dither/jitter patterns must stay anchored to the SHEET or a
// bucket fill at an odd offset comes out in the opposite dither phase from a
// pencil stroke over the same pixels.
function strokeInk(ev, color, origin = null, seed = newStrokeSeed()) {
  return makeInk(activeBrush(), {
    primary: color, secondary: drawingSettings().secondary,
    palette: activePalette(), seed, alt: ev?.altKey,
    pressure: ev?.pressure, pointerType: ev?.pointerType,
    originX: origin?.x ?? 0, originY: origin?.y ?? 0,
  });
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
    // The Animations canvas ('canvas') edits the selected column's frame.
    const regionId = viewKind === 'frame' ? selected?.editingFrameId
      : viewKind === 'canvas' ? selected?.frameId
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
  // (no sheet, or outside the paintable rect). Live drawing pre-masks
  // coordinates with this so strokes cannot start or extend outside the
  // editable rect. `target` is resolved ONCE per stroke at handleDown and
  // threaded through explicitly (not re-queried via getTargetRect() on every
  // event) so the paintable rect can't change mid-drag if the selection
  // context moves under the pointer -- mirrors how the select tool
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
  // stamps overflow up to (maskSize - 1)/2 + scatter px in EVERY direction
  // past a clamped coordinate -- scatter reaches left and up as well as
  // right and down; select-move can drag content past the target edge).
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

  // ---- pencil / eraser / fill / soft flood / line / rect / ellipse ----

  function handleDown(ev) {
    const layer = activeEditableLayer();
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
      // `sub` is origin-(0,0), so the ink is told where it really sits.
      const r = floodFill(sub, ev.x - t.x, ev.y - t.y, color, toolOptions.contiguous, strokeInk(ev, color, t));
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
      // Work on a target-sized copy, preserving the same frame/tile boundary
      // guarantees as hard fill while the core algorithm computes its region.
      const t = getTargetRect(ev.x, ev.y);
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const sfColor = currentColor(ev, false, true);
      // `sub` is origin-(0,0), so the ink is told where it really sits.
      const r = softFloodFill(sub, ev.x - t.x, ev.y - t.y, sfColor, {
        ...toolOptions.softFlood,
        mode: ev.buttons & 2 ? 'erase' : 'fill',
      }, strokeInk(ev, sfColor, t));
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
      const brush = activeBrush();
      const seed = newStrokeSeed();
      const ink = makeInk(brush, {
        primary: color, secondary: drawingSettings().secondary,
        palette: activePalette(), seed, alt: ev.altKey,
        pressure: ev.pressure, pointerType: ev.pointerType,
      });
      const size = effectiveMaskSize(brush, ev.pressure, ev.pointerType);
      let dirty = null;
      for (const s of strokeStamps([p], brush.mask, seed)) {
        const g = maskGridFor({ ...brush.mask, size }, { rotate: s.rotate });
        stamp(layer.bitmap, s.x, s.y, color, size, ink, g);
        // Scatter is NOT re-applied here: `s.x, s.y` is the SCATTERED position
        // -- strokeStamps already moved it -- so widening again would double
        // the box and make maskOutsideTarget rescan ~(2*scatter)^2 extra
        // pixels per stamp for nothing.
        const b = strokeBounds(s.x, s.y, g.width, g.height, 0);
        maskOutsideTarget(layer.bitmap, before, b.x0, b.y0, b.x1, b.y1, target);
        dirty = extend(dirty, b.x0, b.y0, b.x1, b.y1);
      }
      // `travelled` is how many pixels of stroke this brush has already
      // covered. strokeStamps needs it because freehand stamps one pointer
      // segment at a time: without it each segment restarts the spacing phase
      // and the stamp ordinal, so density would follow the pointer event rate
      // and scatter would repeat at the sampling period.
      stroke = {
        tool, layer, before, color, dirty, last: p, target, brush, seed, ink, travelled: 0,
        pressure: ev.pressure, pointerType: ev.pointerType,
      };
      notifyPixelsChanged();
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      const brush = activeBrush();
      const seed = newStrokeSeed();
      const ink = makeInk(brush, {
        primary: color, secondary: drawingSettings().secondary,
        palette: activePalette(), seed, alt: ev.altKey,
        pressure: ev.pressure, pointerType: ev.pointerType,
      });
      // filled shapes: outline in the pressed button's color, interior in the
      // opposite swatch (left = primary outline / secondary fill, right = swapped)
      //
      // UNLESS the ink already claims the secondary as one of its own colours,
      // which it tells us via `usesSecondary` -- never by us inspecting its
      // kind, since ink taxonomy belongs to brush-ink.js. There are only two
      // swatches, so a dither brush and the two-colour shape convention are
      // asking to spend the same one, and something has to give: the interior
      // takes the OUTLINE colour, and the shape becomes one evenly dithered
      // region instead of a dithered border round a solid middle.
      //
      // The richer mechanism wins because picking a dither brush is a more
      // specific statement about how colour goes down than the shape tool's
      // fill convention, which is a cruder version of the same idea. And the
      // distinction being given up was not working anyway: handing a dither
      // ink the secondary as its source colour put the same colour in both of
      // its slots and painted a SOLID interior.
      //
      // Resolved once, at pointer-down: `usesSecondary` is a property of the
      // brush, and the brush cannot change mid-stroke even though handleMove
      // rebuilds the ink on every pointer move.
      const fill = (tool !== 'line' && toolOptions.filled)
        ? (ink.usesSecondary ? color : currentColor(ev, true))
        : null;
      stroke = {
        tool, layer, before, color, fill, dirty: null, anchor: p, target, brush, seed, ink,
        pressure: ev.pressure, pointerType: ev.pointerType,
      };
      notifyPixelsChanged();
      return;
    }
  }

  function handleMove(ev) {
    if (!stroke) return;
    // Remember the last REAL pressure/pointerType reading (from pointerdown
    // or a genuine pointermove) so handleUp can finalize the stroke with it
    // instead of a pointerup event's own -- see the comment there.
    stroke.pressure = ev.pressure;
    stroke.pointerType = ev.pointerType;
    const { tool, layer, before, color } = stroke;
    if (BRUSH_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      const last = stroke.last;
      const { brush, seed, ink } = stroke;
      // Pressure changes within a stroke, but the ink is NOT rebuilt per
      // pointer move -- its `touched` set is stroke-lifetime state (see
      // brush-ink.js:4-8). Live pressure reaches it through this setter.
      ink.setPressure(ev.pressure, ev.pointerType);
      const size = effectiveMaskSize(brush, ev.pressure, ev.pointerType);
      // The accumulated path (previous point through current), not just the
      // current point: strokeStamps densifies and indexes internally, so a
      // one-point call would freeze spacing/scatter/rotation jitter at
      // stampIndex 0 for every move (task-9-brief-amendment.md:C).
      for (const s of strokeStamps([last, p], brush.mask, seed, stroke.travelled)) {
        const g = maskGridFor({ ...brush.mask, size }, { rotate: s.rotate });
        stamp(layer.bitmap, s.x, s.y, color, size, ink, g);
        // Scatter is NOT re-applied here: `s.x, s.y` is the SCATTERED position
        // -- strokeStamps already moved it -- so widening again would double
        // the box and make maskOutsideTarget rescan ~(2*scatter)^2 extra
        // pixels per stamp for nothing.
        const b = strokeBounds(s.x, s.y, g.width, g.height, 0);
        maskOutsideTarget(layer.bitmap, before, b.x0, b.y0, b.x1, b.y1, stroke.target);
        stroke.dirty = extend(stroke.dirty, b.x0, b.y0, b.x1, b.y1);
      }
      // Advance by the segment's own length. `last` is shared with the previous
      // segment's end, so it is re-stamped at the same stroke position and
      // therefore lands identically -- the ink's `touched` set makes that a
      // no-op rather than a double ink.
      stroke.travelled += pathSteps(last, p);
      stroke.last = p;
      notifyPixelsChanged();
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      blitRegion(layer.bitmap, before, 0, 0);
      // Shape previews restore-then-fully-re-rasterize on every move, so a
      // fresh `touched` set is correct here -- but the SEED is not rebuilt,
      // which is what keeps the preview stable frame to frame.
      stroke.ink = makeInk(stroke.brush, {
        primary: color, secondary: drawingSettings().secondary,
        palette: activePalette(), seed: stroke.seed, alt: ev.altKey,
        pressure: ev.pressure, pointerType: ev.pointerType,
      });
      const a = stroke.anchor;
      if (tool === 'line') {
        // The line is STAMPED, exactly the way the freehand branch stamps a
        // pointer segment -- drawLine's own walk puts one stamp on every pixel
        // of the Bresenham path, which silently discards the brush's spacing,
        // scatter and rotate jitter and drew a solid straight line from a
        // brush that dots and scatters under the pencil.
        //
        // startDistance stays 0 because a shape tool re-rasterizes the WHOLE
        // line from its anchor on every pointer move. strokeStamps indexes a
        // stamp's randomness by its ordinal along the path and nothing else,
        // so recomputing from 0 makes a shorter preview byte-identical to the
        // same prefix of the final line -- the line does not reshuffle under
        // the cursor as it is dragged out (brush-stroke.js:3-12).
        const size = effectiveMaskSize(stroke.brush, ev.pressure, ev.pointerType);
        for (const s of strokeStamps([a, p], stroke.brush.mask, stroke.seed)) {
          const g = maskGridFor({ ...stroke.brush.mask, size }, { rotate: s.rotate });
          stamp(layer.bitmap, s.x, s.y, color, size, stroke.ink, g);
          // Per-stamp bounds, and no scatter widening: `s.x, s.y` is already
          // the scattered position. The endpoint-union box this replaced DID
          // need the widening -- it was centred on the unscattered anchor and
          // pointer, so scatter reach was the only thing accounting for where
          // stamps could actually land.
          const b = strokeBounds(s.x, s.y, g.width, g.height, 0);
          maskOutsideTarget(layer.bitmap, before, b.x0, b.y0, b.x1, b.y1, stroke.target);
          stroke.dirty = extend(stroke.dirty, b.x0, b.y0, b.x1, b.y1);
        }
      // Rect and ellipse are STAMPED too, the same way the line above is.
      // Their primitives draw a shape; the engine's job is to lay the active
      // brush along its border, so the border comes from an ordered perimeter
      // path (pixels.js) and the primitive is left to draw the interior only.
      //
      // Consequence worth knowing: an outline is now BRUSH-WIDTH, not always
      // 1px, which is what the line tool and every other paint program do.
      } else if (tool === 'rect' || tool === 'ellipse') {
        const box = [a.x, a.y, p.x, p.y];
        // Interior first, with `outline: false`. A fill is a region, not a
        // stroke -- scattering it would turn a filled shape into a cloud --
        // but leaving the primitive's own border in would put an unscattered
        // 1px outline underneath the stamped one, hiding the brush entirely
        // on exactly the shapes where it is most visible.
        if (stroke.fill) {
          const noOutline = { outline: false };
          if (tool === 'rect') drawRect(layer.bitmap, ...box, color, stroke.fill, stroke.ink, noOutline);
          else drawEllipse(layer.bitmap, ...box, color, stroke.fill, stroke.ink, noOutline);
          stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y));
        }
        // stampsAlongPath, not strokeStamps: these paths are already one
        // entry per border pixel, and densifying an ellipse's angle-ordered
        // path would bridge between points with pixels the ellipse does not
        // contain. See brush-stroke.js.
        //
        // As with the line, the whole shape re-rasterizes from its anchor on
        // every pointer move with startDistance left at 0, so a preview is
        // stable frame to frame rather than reshuffling under the cursor.
        const size = effectiveMaskSize(stroke.brush, ev.pressure, ev.pointerType);
        const path = tool === 'rect' ? rectOutlinePath(...box) : ellipseOutlinePath(...box);
        for (const s of stampsAlongPath(path, stroke.brush.mask, stroke.seed)) {
          const g = maskGridFor({ ...stroke.brush.mask, size }, { rotate: s.rotate });
          stamp(layer.bitmap, s.x, s.y, color, size, stroke.ink, g);
          // `clampPoint` keeps the BOX inside the target, but a stamp is
          // wider than its path point and scatter moves it further still, so
          // a shape now needs the same safety net the line tool has.
          const b = strokeBounds(s.x, s.y, g.width, g.height, 0);
          maskOutsideTarget(layer.bitmap, before, b.x0, b.y0, b.x1, b.y1, stroke.target);
          stroke.dirty = extend(stroke.dirty, b.x0, b.y0, b.x1, b.y1);
        }
      }
      notifyPixelsChanged();
      return;
    }
  }

  function handleUp(ev) {
    if (!stroke) return;
    // A pointerup event reports pressure 0 -- the pen has already left the
    // surface -- but handleMove is about to run once more to commit the
    // final pointer position. Trusting that 0 verbatim would stamp the
    // stroke's last segment at the bottom of the brush's pressure range
    // (minimum size, zero opacity, or the lowest shade step) even though the
    // pen was at real pressure a moment earlier. Reuse the last genuine
    // pressure/pointerType reading (tracked on `stroke` by handleDown/
    // handleMove) instead, so the final segment matches the one before it.
    const finalEv = { ...ev, pressure: stroke.pressure, pointerType: stroke.pointerType };
    handleMove(finalEv); // commit final pointer position (handles click-without-move too)
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
    if (!activeEditableLayer()) return;
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
    // No float yet. On the sheet view with no marquee, a down on a frame
    // starts a FRAME-FLOAT: its pixels float exactly like a selection --
    // live preview, commit on Enter/outside click -- but translate-only, and
    // on commit the frame rect moves with the pixels. A pinned frame's rect
    // belongs to its auto layout, so the move tool leaves it alone.
    // Everything else keeps the classic behavior: cut the selection (or
    // whole target) and drag it.
    if (activeViewKind() === 'sheet' && !selection) {
      const frame = frameAt(sheet, ev.x, ev.y);
      if (frame && isPinnedFrame(sheet, frame.id)) return;
      if (frame) {
        const region = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        if (!createFloat({ allLayers: true, region, frameIds: [frame.id], x: ev.x, y: ev.y })) return;
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
    if (e.defaultPrevented) return; // handled by a focused panel (e.g. the Animations timeline's Delete)
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey
      && activeTool() === 'select' && activeViewKind() === viewKind && selection && !activeFloating()) {
      const layer = activeEditableLayer();
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
