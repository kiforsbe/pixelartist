import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBitmap, cloneBitmap, getPixel, setPixel, drawLine, drawRect,
  drawEllipse, floodFill, copyRegion, blitRegion, fillRegion, flipBitmap,
  colorsEqual,
} from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

test('createBitmap is transparent and sized', () => {
  const b = createBitmap(4, 3);
  assert.equal(b.width, 4); assert.equal(b.height, 3);
  assert.equal(b.data.length, 48);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
});

test('set/get pixel roundtrip; out of bounds safe', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 2, 1, RED);
  assert.deepEqual(getPixel(b, 2, 1), RED);
  assert.equal(getPixel(b, -1, 0), null);
  assert.equal(getPixel(b, 4, 0), null);
  setPixel(b, 99, 99, RED); // no throw
});

test('drawLine draws inclusive endpoints, brush size grows square', () => {
  const b = createBitmap(8, 8);
  drawLine(b, 1, 1, 5, 1, RED, 1);
  for (let x = 1; x <= 5; x++) assert.deepEqual(getPixel(b, x, 1), RED);
  assert.deepEqual(getPixel(b, 6, 1), CLEAR);
  const b2 = createBitmap(8, 8);
  drawLine(b2, 3, 3, 3, 3, RED, 2); // 2x2 brush anchored at pixel
  assert.deepEqual(getPixel(b2, 3, 3), RED);
  assert.deepEqual(getPixel(b2, 4, 4), RED);
});

test('drawRect outline vs filled', () => {
  const b = createBitmap(8, 8);
  drawRect(b, 1, 1, 4, 4, RED, false);
  assert.deepEqual(getPixel(b, 1, 1), RED);
  assert.deepEqual(getPixel(b, 4, 4), RED);
  assert.deepEqual(getPixel(b, 2, 2), CLEAR);
  drawRect(b, 1, 1, 4, 4, BLUE, true);
  assert.deepEqual(getPixel(b, 2, 2), BLUE);
});

test('drawEllipse filled covers center, stays in bbox', () => {
  const b = createBitmap(10, 10);
  drawEllipse(b, 1, 1, 8, 8, RED, true);
  assert.deepEqual(getPixel(b, 5, 5), RED);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
  assert.deepEqual(getPixel(b, 1, 1), CLEAR); // corner of bbox outside ellipse
});

test('floodFill contiguous fills connected region and reports dirty rect', () => {
  const b = createBitmap(6, 6);
  drawLine(b, 0, 3, 5, 3, RED, 1); // wall splits top/bottom
  const rect = floodFill(b, 0, 0, BLUE, true);
  assert.deepEqual(getPixel(b, 5, 2), BLUE);
  assert.deepEqual(getPixel(b, 0, 5), CLEAR); // below wall untouched
  assert.deepEqual(rect, { x: 0, y: 0, w: 6, h: 3 });
  assert.equal(floodFill(b, 0, 0, BLUE, true), null); // same color -> no-op
});

test('floodFill non-contiguous replaces color everywhere', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 0, 0, RED); setPixel(b, 3, 3, RED);
  floodFill(b, 0, 0, BLUE, false);
  assert.deepEqual(getPixel(b, 3, 3), BLUE);
});

test('copy/blit/fill region and flip', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 0, 0, RED); setPixel(b, 1, 0, BLUE);
  const cut = copyRegion(b, 0, 0, 2, 1);
  assert.deepEqual(getPixel(cut, 1, 0), BLUE);
  const dst = createBitmap(4, 4);
  blitRegion(dst, cut, 2, 3);
  assert.deepEqual(getPixel(dst, 3, 3), BLUE);
  fillRegion(b, 0, 0, 2, 2, CLEAR);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
  const f = flipBitmap(cut, true, false);
  assert.deepEqual(getPixel(f, 0, 0), BLUE);
  assert.ok(colorsEqual(getPixel(f, 1, 0), RED));
});
