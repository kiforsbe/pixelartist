// Floating selection model: pixels cut (or pasted) into per-layer buffers
// that hover over the sheet under a shared transform until committed.
//
// Float shape (held in state.floating, exactly 0 or 1 app-wide):
//   { sheetId, srcRect: {x,y,w,h}, cut, layers: [{layerId, buffer}],
//     transform: {tx, ty, sx, sy, rot} }
// `buffer` is a srcRect-sized bitmap snapshot treated as IMMUTABLE: every
// raster resamples nearest-neighbor from it via the inverse transform, so
// repeated transforms never degrade the pixels. The transform scales/rotates
// about the buffer center, then translates by (tx, ty) from srcRect.
import { createBitmap, cloneBitmap, blitOver } from './pixels.js';
import { resolveAnchor, handlePoint, isAspectLocked, dominantMagnitude, HANDLES_CORNER } from './resizeAnchor.js';

// Absorbs float-math noise (cos(PI/2) ≈ 6e-17) so exact-looking transforms
// (90° rotations, integer scales) rasterize deterministically.
const EPS = 1e-6;

export function makeTransform() { return { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 }; }

export function isIdentity(t) {
  return t.tx === 0 && t.ty === 0 && t.sx === 1 && t.sy === 1 && t.rot === 0;
}

export function forwardPoint(float, u, v) {
  const { srcRect, transform: t } = float;
  const cx = srcRect.w / 2, cy = srcRect.h / 2;
  const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
  const dx = (u - cx) * t.sx, dy = (v - cy) * t.sy;
  return {
    x: srcRect.x + t.tx + cx + dx * cos - dy * sin,
    y: srcRect.y + t.ty + cy + dx * sin + dy * cos,
  };
}

export function inversePoint(float, x, y) {
  const { srcRect, transform: t } = float;
  const cx = srcRect.w / 2, cy = srcRect.h / 2;
  const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
  const dx = x - (srcRect.x + t.tx + cx);
  const dy = y - (srcRect.y + t.ty + cy);
  const rx = dx * cos + dy * sin;   // un-rotate
  const ry = -dx * sin + dy * cos;
  return { u: rx / t.sx + cx, v: ry / t.sy + cy };
}

// Rotation-aware scale solve for the float Move-tool's handle drag. t0 is
// the transform BEFORE this drag started (an immutable snapshot -- never
// re-derive from the live/previous-frame transform, so live Alt/Shift
// toggling recomputes cleanly with no drift). mx, my: the live mouse
// position, sheet-space, already pixel-centered by the caller (+0.5,
// matching the convention the rotate-knob code already uses). Returns a
// full new transform {tx, ty, sx, sy, rot} -- rot is always carried over
// from t0 unchanged, since a scale drag never rotates.
export function solveScaleTransform({ srcRect, t0, handle, useCenter, shiftHeld, mx, my }) {
  const { w, h } = srcRect;
  const cx = w / 2, cy = h / 2;
  const localRect = { x: 0, y: 0, w, h };
  const pivot = resolveAnchor(localRect, handle, useCenter);
  const grabbed = handlePoint(localRect, handle);
  const pivotWorld = forwardPoint({ srcRect, transform: t0 }, pivot.x, pivot.y);

  const cos = Math.cos(t0.rot), sin = Math.sin(t0.rot);
  const dx = mx - pivotWorld.x, dy = my - pivotWorld.y;
  const px = dx * cos + dy * sin;   // un-rotate into local, unrotated units
  const py = -dx * sin + dy * cos;

  const hu = grabbed.x - pivot.x, hv = grabbed.y - pivot.y;
  const clampS = (s) => (s < 0 ? -1 : 1) * Math.max(0.01, Math.abs(s));
  let sx = t0.sx, sy = t0.sy;
  if (hu !== 0) sx = clampS(px / hu);
  if (hv !== 0) sy = clampS(py / hv);

  if (isAspectLocked(handle, shiftHeld)) {
    if (HANDLES_CORNER.includes(handle)) {
      const m = dominantMagnitude(sx, sy);
      sx = clampS(Math.sign(sx || 1) * m);
      sy = clampS(Math.sign(sy || 1) * m);
    } else if (hu !== 0) {
      sy = clampS(Math.sign(sy || 1) * Math.abs(sx));
    } else if (hv !== 0) {
      sx = clampS(Math.sign(sx || 1) * Math.abs(sy));
    }
  }

  // Solve tx, ty so the pivot's world position is reproduced exactly under
  // the new (sx, sy): forwardPoint maps the buffer CENTER via translation
  // alone (rotation/scale only offset from center), so back out what the
  // center's world position must be, then convert to tx/ty.
  const offX = pivot.x - cx, offY = pivot.y - cy;
  const rotX = offX * sx * cos - offY * sy * sin;
  const rotY = offX * sx * sin + offY * sy * cos;
  const centerWorldX = pivotWorld.x - rotX;
  const centerWorldY = pivotWorld.y - rotY;

  return {
    tx: centerWorldX - srcRect.x - cx,
    ty: centerWorldY - srcRect.y - cy,
    sx, sy, rot: t0.rot,
  };
}

export function floatBounds(float) {
  const { w, h } = float.srcRect;
  const pts = [
    forwardPoint(float, 0, 0), forwardPoint(float, w, 0),
    forwardPoint(float, 0, h), forwardPoint(float, w, h),
  ];
  const x0 = Math.floor(Math.min(...pts.map(p => p.x)) + EPS);
  const y0 = Math.floor(Math.min(...pts.map(p => p.y)) + EPS);
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x)) - EPS);
  const y1 = Math.ceil(Math.max(...pts.map(p => p.y)) - EPS);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Single-slot memo: repaints during pan/zoom re-request the same raster many
// times per transform value; drags invalidate it by changing the transform.
let memo = null;

export function rasterizeFloat(float) {
  const t = float.transform;
  const key = `${t.tx},${t.ty},${t.sx},${t.sy},${t.rot}`;
  if (memo && memo.float === float && memo.key === key) return memo.result;
  const b = floatBounds(float);
  const result = float.layers.map(({ layerId, buffer }) => {
    const out = createBitmap(Math.max(1, b.w), Math.max(1, b.h));
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const { u, v } = inversePoint(float, b.x + x + 0.5, b.y + y + 0.5);
        const su = Math.floor(u + EPS), sv = Math.floor(v + EPS);
        if (su < 0 || sv < 0 || su >= buffer.width || sv >= buffer.height) continue;
        const i = (sv * buffer.width + su) * 4, o = (y * out.width + x) * 4;
        out.data[o] = buffer.data[i]; out.data[o + 1] = buffer.data[i + 1];
        out.data[o + 2] = buffer.data[i + 2]; out.data[o + 3] = buffer.data[i + 3];
      }
    return { layerId, bitmap: out, x: b.x, y: b.y };
  });
  memo = { float, key, result };
  return result;
}

export function compositeFloatOnLayer(layerBitmap, floating, layerId) {
  if (!floating) return null;
  const r = rasterizeFloat(floating).find(e => e.layerId === layerId);
  if (!r) return null;
  const out = cloneBitmap(layerBitmap);
  blitOver(out, r.bitmap, r.x, r.y);
  return out;
}
