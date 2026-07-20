import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFrequency, buildPalette, quantizeBitmap, medianCutPalette, resolveAlphaForQuantize } from '../js/core/quantize.js';

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

test('medianCutPalette: fewer distinct colors than maxColors returns them all unchanged', () => {
  const b = bmp(3, 1, [[10, 20, 30, 255], [10, 20, 30, 255], [40, 50, 60, 255]]);
  assert.deepEqual(medianCutPalette([b], 5), [[10, 20, 30], [40, 50, 60]]);
});

test('medianCutPalette: fully-transparent pixels excluded from the histogram', () => {
  const b = bmp(3, 1, [[255, 0, 0, 255], [0, 0, 0, 0], [0, 255, 0, 255]]);
  assert.deepEqual(medianCutPalette([b], 5), [[255, 0, 0], [0, 255, 0]]);
});

test('medianCutPalette: two color clusters reduced to 2 produce one average per cluster', () => {
  const pixels = [
    ...Array(5).fill([255, 0, 0, 255]),
    ...Array(5).fill([245, 5, 5, 255]),
    ...Array(5).fill([0, 0, 255, 255]),
    ...Array(5).fill([5, 5, 245, 255]),
  ];
  const b = bmp(20, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 2), [[3, 3, 250], [250, 3, 3]]);
});

test('medianCutPalette: a lopsided outlier color still gets its own palette entry', () => {
  const pixels = [
    [250, 0, 0, 255], [252, 0, 0, 255], [254, 0, 0, 255], [255, 0, 0, 255], [248, 0, 0, 255],
    [0, 0, 255, 255],
  ];
  const b = bmp(6, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 3), [[249, 0, 0], [0, 0, 255], [254, 0, 0]]);
});

test('resolveAlphaForQuantize: heavily transparent pixels (>=75% transparent) snap to fully transparent', () => {
  const b = bmp(1, 1, [[10, 20, 30, 32]]); // alpha 32 -> ~87.5% transparent
  const [out] = resolveAlphaForQuantize([b], 4);
  assert.deepEqual([...out.data], [10, 20, 30, 0]);
});

test('resolveAlphaForQuantize: near-opaque pixels (<7% transparent) snap to fully opaque', () => {
  const b = bmp(1, 1, [[10, 20, 30, 250]]); // ~1.96% transparent
  const [out] = resolveAlphaForQuantize([b], 4);
  assert.deepEqual([...out.data], [10, 20, 30, 255]);
});

test('resolveAlphaForQuantize: the bulk 25%-75% transparent range snaps to opaque even for a heavily-weighted color', () => {
  const pixels = [...Array(8).fill([50, 60, 70, 140]), ...Array(2).fill([1, 2, 3, 255])]; // 140/255 -> ~45.1% transparent
  const b = bmp(10, 1, pixels);
  const [out] = resolveAlphaForQuantize([b], 2);
  assert.equal(out.data[3], 255);
  assert.equal(out.data[7], 255);
});

test('resolveAlphaForQuantize: in the 7%-25% exception band, an important color keeps its real alpha', () => {
  // 8 pixels of color A + 2 of color B, both at alpha 210 (~17.6% transparent, in the exception band).
  // totalWeight=10, maxColors=2 -> threshold=5; A's weight (8) clears it, B's (2) doesn't.
  const pixels = [...Array(8).fill([100, 150, 200, 210]), ...Array(2).fill([10, 20, 30, 210])];
  const b = bmp(10, 1, pixels);
  const [out] = resolveAlphaForQuantize([b], 2);
  for (let i = 0; i < 8; i++) assert.equal(out.data[i * 4 + 3], 210);
  for (let i = 8; i < 10; i++) assert.equal(out.data[i * 4 + 3], 255);
});

test('resolveAlphaForQuantize: fully-transparent pixels pass through unchanged', () => {
  const b = bmp(1, 1, [[9, 9, 9, 0]]);
  const [out] = resolveAlphaForQuantize([b], 4);
  assert.deepEqual([...out.data], [9, 9, 9, 0]);
});
