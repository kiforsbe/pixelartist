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
