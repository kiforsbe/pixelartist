import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, regionHasPixels } from '../js/core/pixels.js';

test('regionHasPixels sees a pixel inside the rect only', () => {
  const bmp = createBitmap(8, 8);
  setPixel(bmp, 5, 5, [1, 2, 3, 255]);
  assert.equal(regionHasPixels(bmp, 4, 4, 2, 2), true);
  assert.equal(regionHasPixels(bmp, 0, 0, 5, 5), false);
});

test('regionHasPixels clips a rect that leaves the bitmap', () => {
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 3, 0, [0, 0, 0, 1]);
  assert.equal(regionHasPixels(bmp, 2, -2, 10, 3), true);
  assert.equal(regionHasPixels(bmp, 10, 10, 2, 2), false);
});
