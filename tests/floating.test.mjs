import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTransform, isIdentity, floatBounds, rasterizeFloat, compositeFloatOnLayer,
  solveScaleTransform,
} from '../js/core/floating.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

function makeFloat({ w = 4, h = 4, x = 2, y = 3, paint }) {
  const buffer = createBitmap(w, h);
  if (paint) paint(buffer);
  return {
    sheetId: 'sh1', srcRect: { x, y, w, h }, cut: true,
    layers: [{ layerId: 'ly1', buffer }], transform: makeTransform(),
  };
}

test('identity: bounds equal srcRect, raster round-trips the buffer', () => {
  const f = makeFloat({ paint: (b) => { setPixel(b, 1, 2, RED); } });
  assert.deepEqual(floatBounds(f), { x: 2, y: 3, w: 4, h: 4 });
  const [r] = rasterizeFloat(f);
  assert.equal(r.layerId, 'ly1');
  assert.deepEqual({ x: r.x, y: r.y }, { x: 2, y: 3 });
  assert.deepEqual(getPixel(r.bitmap, 1, 2), RED);
  assert.deepEqual(getPixel(r.bitmap, 0, 0), CLEAR);
});

test('translate: bounds and raster shift by (tx, ty)', () => {
  const f = makeFloat({ paint: (b) => setPixel(b, 0, 0, RED) });
  f.transform = { ...makeTransform(), tx: 5, ty: -2 };
  assert.deepEqual(floatBounds(f), { x: 7, y: 1, w: 4, h: 4 });
  const [r] = rasterizeFloat(f);
  assert.deepEqual(getPixel(r.bitmap, 0, 0), RED);
});

test('rotate 90°: asymmetric pattern lands rotated, bounds swap dimensions', () => {
  // 4x2 buffer, red at (0,0) (top-left)
  const buffer = createBitmap(4, 2);
  setPixel(buffer, 0, 0, RED);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 4, h: 2 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: { ...makeTransform(), rot: Math.PI / 2 } };
  const b = floatBounds(f);
  assert.deepEqual({ w: b.w, h: b.h }, { w: 2, h: 4 }); // 4x2 → 2x4
  const [r] = rasterizeFloat(f);
  // top-left of the buffer rotates to the top-right of the rotated raster
  assert.deepEqual(getPixel(r.bitmap, r.bitmap.width - 1, 0), RED);
});

test('scale 2x: nearest-neighbor duplicates each pixel into a 2x2 block', () => {
  const buffer = createBitmap(2, 2);
  setPixel(buffer, 0, 0, RED);
  setPixel(buffer, 1, 1, BLUE);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 2, h: 2 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: { ...makeTransform(), sx: 2, sy: 2 } };
  const b = floatBounds(f);
  assert.deepEqual({ w: b.w, h: b.h }, { w: 4, h: 4 });
  const [r] = rasterizeFloat(f);
  for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]])
    assert.deepEqual(getPixel(r.bitmap, px, py), RED, `red block at ${px},${py}`);
  for (const [px, py] of [[2, 2], [3, 3]])
    assert.deepEqual(getPixel(r.bitmap, px, py), BLUE, `blue block at ${px},${py}`);
});

test('negative scale flips (pull-through)', () => {
  const buffer = createBitmap(2, 1);
  setPixel(buffer, 0, 0, RED);
  setPixel(buffer, 1, 0, BLUE);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 2, h: 1 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: { ...makeTransform(), sx: -1 } };
  const [r] = rasterizeFloat(f);
  assert.deepEqual(getPixel(r.bitmap, 0, 0), BLUE);
  assert.deepEqual(getPixel(r.bitmap, 1, 0), RED);
});

test('raster always resamples from the original buffer (no cumulative loss)', () => {
  const buffer = createBitmap(3, 3);
  setPixel(buffer, 1, 1, RED);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 3, h: 3 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: makeTransform() };
  f.transform = { ...f.transform, sx: 0.4, sy: 0.4 }; // shrink (lossy if baked)
  rasterizeFloat(f);
  f.transform = { ...f.transform, sx: 1, sy: 1 };      // back to identity
  const [r] = rasterizeFloat(f);
  assert.deepEqual(getPixel(r.bitmap, 1, 1), RED);     // undamaged
});

test('isIdentity + memo returns same result object for unchanged transform', () => {
  const f = makeFloat({});
  assert.equal(isIdentity(f.transform), true);
  f.transform = { ...f.transform, tx: 1 };
  assert.equal(isIdentity(f.transform), false);
  const a = rasterizeFloat(f);
  const b = rasterizeFloat(f);
  assert.equal(a, b); // memoized
});

test('compositeFloatOnLayer blends raster over a clone; null when no buffer for layer', () => {
  const layerBmp = createBitmap(8, 8);
  setPixel(layerBmp, 0, 0, BLUE);
  const f = makeFloat({ paint: (b) => setPixel(b, 0, 0, RED) }); // srcRect at (2,3)
  const out = compositeFloatOnLayer(layerBmp, f, 'ly1');
  assert.deepEqual(getPixel(out, 2, 3), RED);          // float pixel
  assert.deepEqual(getPixel(out, 0, 0), BLUE);         // untouched clone
  assert.deepEqual(getPixel(layerBmp, 2, 3), CLEAR);   // original NOT mutated
  assert.equal(compositeFloatOnLayer(layerBmp, f, 'nope'), null);
  assert.equal(compositeFloatOnLayer(layerBmp, null, 'ly1'), null);
});

// ---- solveScaleTransform ----

function closeTo(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(Math.abs(actual - expected) < eps, `${msg}: ${actual} !~ ${expected}`);
}

test('solveScaleTransform: unrotated corner drag, no modifiers, proportional by default', () => {
  const srcRect = { x: 0, y: 0, w: 20, h: 10 };
  const t0 = makeTransform();
  // grabbed 'se' local (20,10); pivot 'nw' local (0,0) -> world (0,0) at identity
  const r = solveScaleTransform({ srcRect, t0, handle: 'se', useCenter: false, shiftHeld: false, mx: 60, my: 25 });
  // kx = 60/20 = 3, ky = 25/10 = 2.5 -> dominant 3, both axes locked to 3
  closeTo(r.sx, 3, 1e-9, 'sx');
  closeTo(r.sy, 3, 1e-9, 'sy');
  closeTo(r.tx, 20, 1e-9, 'tx');
  closeTo(r.ty, 10, 1e-9, 'ty');
  assert.equal(r.rot, 0);
});

test('solveScaleTransform: Shift frees the corner drag (independent axes)', () => {
  const srcRect = { x: 0, y: 0, w: 20, h: 10 };
  const t0 = makeTransform();
  const r = solveScaleTransform({ srcRect, t0, handle: 'se', useCenter: false, shiftHeld: true, mx: 60, my: 25 });
  closeTo(r.sx, 3, 1e-9, 'sx');
  closeTo(r.sy, 2.5, 1e-9, 'sy');
});

test('solveScaleTransform: rotated 90°, edge drag along the shape\'s LOCAL axis stays fixed at center', () => {
  // Square float, rotated 90°, useCenter (Alt) so the pivot is the buffer
  // center -- world center never moves regardless of rotation, so tx/ty
  // should come back ~0 while sx captures the LOCAL x-axis scale even
  // though the drag reads as vertical on screen (since local +x maps to
  // world +y at a 90° rotation).
  const srcRect = { x: 0, y: 0, w: 20, h: 20 };
  const t0 = { ...makeTransform(), rot: Math.PI / 2 };
  const r = solveScaleTransform({ srcRect, t0, handle: 'e', useCenter: true, shiftHeld: false, mx: 10, my: 40 });
  closeTo(r.sx, 3, 1e-6, 'sx (local x-axis, driven by the visually-vertical drag)');
  assert.equal(r.sy, 1, 'sy untouched -- e handle never drives the local y-axis');
  closeTo(r.tx, 0, 1e-6, 'tx -- center-anchored scale never translates');
  closeTo(r.ty, 0, 1e-6, 'ty -- center-anchored scale never translates');
  assert.equal(r.rot, Math.PI / 2, 'rot carried over from t0 unchanged');
});

test('solveScaleTransform: preserves a pre-existing flip through an aspect-locked corner drag', () => {
  // Float already mirrored on x (sx negative) before this drag starts.
  // Corner, no Shift = aspect-locked by default (dominant magnitude wins),
  // and the sign of each axis must survive -- a naive "copy sx onto sy"
  // would silently un-flip it the moment a locked corner drag touches it.
  const srcRect = { x: 0, y: 0, w: 20, h: 10 };
  const t0 = { ...makeTransform(), sx: -1, sy: 1 };
  // pivot ('nw', local (0,0)) sits at world (20,0) under sx=-1 -- the flip
  // means the local nw corner is the one that renders on the RIGHT.
  // Chosen so px/hu = -2 and py/hv = 2 exactly (equal magnitude, opposite
  // sign), so aspect-lock's dominant-magnitude pass is a no-op and only
  // the sign-preservation step is actually exercised.
  const r = solveScaleTransform({ srcRect, t0, handle: 'se', useCenter: false, shiftHeld: false, mx: -20, my: 20 });
  assert.ok(r.sx < 0, 'sx stays negative -- the flip is not lost');
  assert.ok(r.sy > 0, 'sy stays positive');
  closeTo(r.sx, -2, 1e-9, 'sx');
  closeTo(r.sy, 2, 1e-9, 'sy');
  closeTo(r.tx, -10, 1e-9, 'tx');
  closeTo(r.ty, 5, 1e-9, 'ty');
});
