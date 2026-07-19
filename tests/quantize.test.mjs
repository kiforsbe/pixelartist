import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFrequency, buildPalette, quantizeBitmap } from '../js/core/quantize.js';

function bmp(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((rgba, i) => data.set(rgba, i * 4));
  return { width, height, data };
}

test('colorFrequency: most-frequent first, transparent pixels excluded', () => {
  const b = bmp(2, 2, [
    [255, 0, 0, 255], [0, 255, 0, 255],
    [255, 0, 0, 255], [0, 0, 0, 0], // transparent, excluded
  ]);
  const freq = colorFrequency([b]);
  assert.deepEqual(freq, [[255, 0, 0, 255], [0, 255, 0, 255]]);
});

test('buildPalette: indexed source palette wins over pixel frequency', () => {
  const b = bmp(1, 1, [[255, 0, 0, 255]]);
  const pal = buildPalette([b], 256, { indexed: true, colors: [[1, 2, 3, 255], [4, 5, 6, 255]] });
  assert.deepEqual(pal, [[1, 2, 3, 255], [4, 5, 6, 255]]);
});

test('buildPalette: caps pixel-frequency palette at maxColors', () => {
  const b = bmp(3, 1, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
  const pal = buildPalette([b], 2, null);
  assert.equal(pal.length, 2);
  assert.deepEqual(pal, [[255, 0, 0, 255], [0, 255, 0, 255]]);
});

test('quantizeBitmap: each pixel maps to its nearest palette index', () => {
  const b = bmp(2, 1, [[250, 5, 5, 255], [5, 5, 250, 255]]);
  const palette = [[255, 0, 0, 255], [0, 0, 255, 255]];
  assert.deepEqual([...quantizeBitmap(b, palette)], [0, 1]);
});
