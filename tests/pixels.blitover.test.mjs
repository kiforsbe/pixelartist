import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel, blitOver } from '../js/core/pixels.js';

test('opaque source pixel replaces destination', () => {
  const dst = createBitmap(4, 4), src = createBitmap(2, 2);
  setPixel(dst, 1, 1, [0, 0, 255, 255]);
  setPixel(src, 0, 0, [255, 0, 0, 255]);
  blitOver(dst, src, 1, 1);
  assert.deepEqual(getPixel(dst, 1, 1), [255, 0, 0, 255]);
});

test('transparent source pixel leaves destination untouched (unlike blitRegion)', () => {
  const dst = createBitmap(4, 4), src = createBitmap(2, 2);
  setPixel(dst, 2, 2, [0, 0, 255, 255]);
  blitOver(dst, src, 1, 1); // src all transparent
  assert.deepEqual(getPixel(dst, 2, 2), [0, 0, 255, 255]);
});

test('semi-transparent source blends source-over', () => {
  const dst = createBitmap(1, 1), src = createBitmap(1, 1);
  setPixel(dst, 0, 0, [0, 0, 0, 255]);
  setPixel(src, 0, 0, [255, 255, 255, 128]);
  blitOver(dst, src, 0, 0);
  const p = getPixel(dst, 0, 0);
  assert.equal(p[3], 255);
  assert.ok(p[0] > 120 && p[0] < 136, `blended red ${p[0]}`); // ~128
});

test('negative offsets and overflow are clipped safely', () => {
  const dst = createBitmap(2, 2), src = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(src, x, y, [9, 9, 9, 255]);
  blitOver(dst, src, -1, -1);
  assert.deepEqual(getPixel(dst, 0, 0), [9, 9, 9, 255]);
});
