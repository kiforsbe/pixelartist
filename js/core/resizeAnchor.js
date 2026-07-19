// Shared resize/transform anchor logic: which point stays fixed when you
// drag a corner or edge handle, and how the Photoshop/Affinity-style Alt
// (center anchor) / Shift (aspect lock) modifiers change that. Pure
// geometry, no DOM/app-state imports (node-tested) -- mirrors dimlabels.js's
// convention. Used directly by frames.js, tilemode.js, and tools.js's
// selection marquee (all via resizeRectFromHandle); tools.js's float scale
// reuses resolveAnchor/handlePoint/isAspectLocked/dominantMagnitude but
// solves its own rotation-aware affine transform on top (see
// core/floating.js's solveScaleTransform), since a float can't be
// expressed as a plain {x,y,w,h} rect once it's rotated.
//
// See docs/superpowers/specs/2026-07-19-standardized-resize-design.md for
// the full modifier semantics table and worked math.

export const HANDLES_CORNER = ['nw', 'ne', 'sw', 'se'];
export const HANDLES_ALL = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function isCenterAnchorModifier(ev) { return !!ev.altKey; }
export function isProportionalModifier(ev) { return !!ev.shiftKey; }

// Fractional (fx, fy) position of each handle within a unit rect (0 = min
// edge, 1 = max edge, 0.5 = that axis's own midpoint) -- the single source
// of truth handlePoint and resolveAnchor both derive from.
const HANDLE_FRACTION = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0],
  w: [0, 0.5], e: [1, 0.5],
  sw: [0, 1], s: [0.5, 1], se: [1, 1],
};

function pointAtFraction(rect, fx, fy) {
  return { x: rect.x + fx * rect.w, y: rect.y + fy * rect.h };
}

// The literal point on the rect at this handle.
export function handlePoint(rect, handle) {
  const [fx, fy] = HANDLE_FRACTION[handle];
  return pointAtFraction(rect, fx, fy);
}

// The point that stays fixed during a drag on this handle: the opposite
// corner/edge midpoint by default, or the rect's center when useCenter.
// For an edge handle, "opposite edge midpoint" is already centered on the
// axis that handle doesn't drive -- see resizeRectFromHandle's secondary-
// axis handling below, which relies on this.
export function resolveAnchor(rect, handle, useCenter) {
  if (useCenter) return pointAtFraction(rect, 0.5, 0.5);
  const [fx, fy] = HANDLE_FRACTION[handle];
  return pointAtFraction(rect, 1 - fx, 1 - fy);
}

// Whether THIS drag is aspect-ratio-locked, given the raw Shift state.
// Corner handles default locked (Shift frees them); edge handles default
// free (Shift locks them) -- resolved once here so no caller restates the
// flip.
export function isAspectLocked(handle, shiftHeld) {
  return HANDLES_CORNER.includes(handle) ? !shiftHeld : shiftHeld;
}

// The larger-magnitude of two candidate scale ratios/deltas, sign
// discarded -- "whichever axis moved further drives the size" rule behind
// proportional-lock corner resizing. Callers needing a signed result
// (float scale, whose factor can go negative -- a flip) re-sign per axis
// afterward.
export function dominantMagnitude(a, b) {
  return Math.max(Math.abs(a), Math.abs(b));
}

// orig: the rect BEFORE this drag started (immutable snapshot -- never
// pass a live/previous-frame rect, so live Alt/Shift toggling recomputes
// cleanly with no drift). px, py: current raw pointer position, image-space
// (a pixel index, per canvasview.js's screenToImage). opts:
//   useCenter  - anchor at rect center instead of the opposite corner/edge
//   shiftHeld  - raw modifier state; isAspectLocked resolves what it means
//   target     - optional {x,y,w,h} to clamp the pointer into first
//   inclusive  - true: treat px/py as an INCLUDED pixel index, so the 'e'/
//                's' side gets +1 to become an edge coordinate (matches
//                the old resizerect.js's inclusive-pixel-selection
//                semantics). false (default): px/py ARE already edge
//                coordinates (matches frames.js/tilemode.js's existing
//                convention, where a shape's own x/x+w live in that space).
// Returns the new {x, y, w, h}.
export function resizeRectFromHandle(orig, handle, px, py, opts = {}) {
  const { useCenter = false, shiftHeld = false, target = null, inclusive = false } = opts;
  if (target) {
    const maxX = inclusive ? target.x + target.w - 1 : target.x + target.w;
    const maxY = inclusive ? target.y + target.h - 1 : target.y + target.h;
    px = Math.max(target.x, Math.min(maxX, px));
    py = Math.max(target.y, Math.min(maxY, py));
  }
  let ex = px, ey = py;
  if (inclusive) {
    if (handle.includes('e')) ex += 1;
    if (handle.includes('s')) ey += 1;
  }

  const anchor = resolveAnchor(orig, handle, useCenter);
  const drivesX = handle.includes('w') || handle.includes('e');
  const drivesY = handle.includes('n') || handle.includes('s');
  const reach = (a, t) => Math.max(1, (useCenter ? 2 : 1) * Math.abs(t - a));

  let newW = drivesX ? reach(anchor.x, ex) : orig.w;
  let newH = drivesY ? reach(anchor.y, ey) : orig.h;

  if (isAspectLocked(handle, shiftHeld)) {
    const aspectW = Math.max(1, orig.w), aspectH = Math.max(1, orig.h);
    if (HANDLES_CORNER.includes(handle)) {
      const k = dominantMagnitude(newW / aspectW, newH / aspectH);
      newW = aspectW * k;
      newH = aspectH * k;
    } else if (drivesX) {
      newH = aspectH * (newW / aspectW);
    } else if (drivesY) {
      newW = aspectW * (newH / aspectH);
    }
  }
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));

  // Degenerate collision (the dragged edge landed exactly ON the anchor):
  // t===a has no direction, so fall back to the handle's own low-side
  // membership to pin the sliver INSIDE the original bounds rather than
  // past the anchor.
  const dirFor = (a, t, lowChar) => (t > a ? 1 : t < a ? -1 : (handle.includes(lowChar) ? -1 : 1));
  const rangeFor = (a, t, size, driven, lowChar) => {
    // Secondary (non-driven) axis, or Alt/center-anchored: symmetric around the anchor.
    if (!driven || useCenter) return [a - size / 2, a + size / 2];
    const dir = dirFor(a, t, lowChar);
    return dir > 0 ? [a, a + size] : [a - size, a];
  };
  const [x0, x1] = rangeFor(anchor.x, ex, newW, drivesX, 'w');
  const [y0, y1] = rangeFor(anchor.y, ey, newH, drivesY, 'n');

  return {
    x: Math.round(x0), y: Math.round(y0),
    w: Math.max(1, Math.round(x1 - x0)), h: Math.max(1, Math.round(y1 - y0)),
  };
}
