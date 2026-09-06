import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorFrequency, buildPalette, quantizeBitmap, medianCutPalette, resolveAlphaForQuantize, findMinimalColorCount } from '../js/core/quantize.js';

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

test('medianCutPalette: weightExponent changes which colors get merged when slots are scarce', () => {
  // 4 genuinely distinct, evenly-populous sprite hues (40px each) plus two
  // noisy bands -- 10 slightly-different near-black shades and 10
  // slightly-different near-white shades (6px each, the shape of
  // dithering/anti-aliasing) -- squeezed into only 5 palette slots. There
  // aren't enough slots to keep every hue AND both noise bands distinct, so
  // which two hues get merged together (and how much budget the noisy
  // bands get) depends on how population is weighted.
  const pixels = [];
  for (let i = 0; i < 10; i++) { const v = i * 4; for (let k = 0; k < 6; k++) pixels.push([v, v, v, 255]); }
  for (let i = 0; i < 10; i++) { const v = 216 + i * 4; for (let k = 0; k < 6; k++) pixels.push([v, v, v, 255]); }
  for (let i = 0; i < 40; i++) pixels.push([200, 40, 40, 255]);   // red
  for (let i = 0; i < 40; i++) pixels.push([40, 180, 60, 255]);   // green
  for (let i = 0; i < 40; i++) pixels.push([40, 60, 200, 255]);   // blue
  for (let i = 0; i < 40; i++) pixels.push([210, 200, 40, 255]);  // yellow
  const b = bmp(pixels.length, 1, pixels);
  const sorted = (colors) => [...colors].sort((a, c) => a[0] - c[0] || a[1] - c[1] || a[2] - c[2]);
  // Default (exponent 1): boxes are weighted by raw pixel count, so the
  // 4 evenly-populous hues (40px each) outweigh any single noise shade
  // (6px each) -- red and yellow (the closest pair) merge, blue and green
  // each keep their own slot, and the noise bands collapse to one
  // representative shade apiece.
  assert.deepEqual(sorted(medianCutPalette([b], 5, 1)), [
    [18, 18, 18], [40, 60, 200], [40, 180, 60], [205, 120, 40], [234, 234, 234],
  ]);
  // weightExponent 0: every distinct shade counts as 1 vote regardless of
  // population, so the 20 distinct noise shades (10 black + 10 white)
  // collectively outvote the 4 hues -- one extra slot shifts to splitting
  // the near-white band into two shades, leaving only 2 slots for hues,
  // which forces blue and green (rather than red and yellow) to merge.
  assert.deepEqual(sorted(medianCutPalette([b], 5, 0)), [
    [18, 18, 18], [40, 120, 130], [205, 120, 40], [224, 224, 224], [244, 244, 244],
  ]);
});

test('medianCutPalette: perceptual refinement (default) rescues a slot contaminated by a few off-cluster pixels; refine=false leaves it contaminated', () => {
  // A big black cluster and a big white cluster, plus a small contaminating
  // shade (150) that the box split's weighted median happens to lump in with
  // black -- the same shape as a checkerboard's true black squares coming
  // out as e.g. (39,39,39) because a handful of unrelated pixels landed in
  // the same box. 150 is actually closer to the white cluster than to black,
  // so a perceptual reassignment pass pulls it out.
  const pixels = [
    ...Array(1000).fill([0, 0, 0, 255]),
    ...Array(50).fill([150, 150, 150, 255]),
    ...Array(1000).fill([255, 255, 255, 255]),
  ];
  const b = bmp(pixels.length, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 2, 1, false), [[7, 7, 7], [255, 255, 255]]);
  assert.deepEqual(medianCutPalette([b], 2, 1, true), [[0, 0, 0], [250, 250, 250]]);
  // refine defaults to true.
  assert.deepEqual(medianCutPalette([b], 2, 1), [[0, 0, 0], [250, 250, 250]]);
});

test('findMinimalColorCount: returns the smallest count that reaches a 100% match, not the ceiling', () => {
  const pixels = [
    ...Array(5).fill([255, 0, 0, 255]),
    ...Array(5).fill([0, 255, 0, 255]),
    ...Array(5).fill([0, 0, 255, 255]),
  ];
  const b = bmp(pixels.length, 1, pixels);
  // 3 genuinely distinct colors -- fewer than 3 slots forces some blending
  // (< 100% match), so 3 is the minimum that hits a 100% target, even
  // though the search is allowed up to 5.
  assert.equal(findMinimalColorCount([b], 5, 1, 100), 3);
});

test('findMinimalColorCount: a trivially low target is satisfied by a single color', () => {
  const pixels = [
    ...Array(5).fill([255, 0, 0, 255]),
    ...Array(5).fill([0, 255, 0, 255]),
    ...Array(5).fill([0, 0, 255, 255]),
  ];
  const b = bmp(pixels.length, 1, pixels);
  assert.equal(findMinimalColorCount([b], 5, 1, 1), 1);
});

test('findMinimalColorCount: falls back to the ceiling when the target is unreachable within budget', () => {
  const pixels = [
    ...Array(5).fill([255, 0, 0, 255]),
    ...Array(5).fill([0, 255, 0, 255]),
    ...Array(5).fill([0, 0, 255, 255]),
  ];
  const b = bmp(pixels.length, 1, pixels);
  // 3 distinct colors need 3 slots for a perfect match; capped at 2, the
  // best the search can do is return the ceiling itself.
  assert.equal(findMinimalColorCount([b], 2, 1, 100), 2);
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
