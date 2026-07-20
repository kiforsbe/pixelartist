import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFrequency, buildPalette, quantizeBitmap, medianCutPalette } from '../js/core/quantize.js';

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

test('medianCutPalette: without preferOpaque, equal pixel counts average evenly regardless of alpha', () => {
  const pixels = [...Array(5).fill([255, 0, 0, 255]), ...Array(5).fill([0, 0, 255, 128])];
  const b = bmp(10, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 1), [[128, 0, 128]]);
});

test('medianCutPalette: preferOpaque weights each pixel by alpha/255, skewing toward the opaque color', () => {
  const pixels = [...Array(5).fill([255, 0, 0, 255]), ...Array(5).fill([0, 0, 255, 128])];
  const b = bmp(10, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 1, true), [[170, 0, 85]]);
});
