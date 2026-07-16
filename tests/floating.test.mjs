import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTransform, isIdentity, floatBounds, rasterizeFloat, compositeFloatOnLayer,
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
