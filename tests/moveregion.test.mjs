import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftRegion } from '../js/core/moveregion.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], CLEAR = [0, 0, 0, 0];

test('in-bounds move: pixels arrive, vacated area transparent, union rect returned', () => {
  const b = createBitmap(8, 8);
  setPixel(b, 1, 1, RED);
  const dirty = shiftRegion(b, { x: 0, y: 0, w: 3, h: 3 }, 4, 2);
  assert.deepEqual(getPixel(b, 5, 3), RED);   // 1+4, 1+2
  assert.deepEqual(getPixel(b, 1, 1), CLEAR); // vacated
  assert.deepEqual(dirty, { x: 0, y: 0, w: 7, h: 5 }); // union of (0,0,3,3) and (4,2,3,3)
});

test('edge cropping: pixels shifted past the boundary are lost', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 3, 0, RED);
  const dirty = shiftRegion(b, { x: 0, y: 0, w: 4, h: 4 }, 2, 0);
  assert.deepEqual(getPixel(b, 3, 0), CLEAR); // moved to x=5, cropped
  assert.equal(dirty.w, 4); // union clamped to bitmap
});

test('zero delta and degenerate rect are no-ops returning null', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 1, 1, RED);
  assert.equal(shiftRegion(b, { x: 0, y: 0, w: 4, h: 4 }, 0, 0), null);
  assert.equal(shiftRegion(b, { x: 0, y: 0, w: 0, h: 4 }, 1, 0), null);
  assert.deepEqual(getPixel(b, 1, 1), RED); // untouched
});

test('rect partially outside bitmap is clamped before moving', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 0, 0, RED);
  const dirty = shiftRegion(b, { x: -2, y: -2, w: 4, h: 4 }, 1, 1);
  assert.deepEqual(getPixel(b, 1, 1), RED);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
  assert.deepEqual(dirty, { x: 0, y: 0, w: 3, h: 3 }); // clamped rect (0,0,2,2) ∪ (1,1,2,2)
});
