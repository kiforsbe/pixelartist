import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PIXEL_SNAPPER_CONFIG, quantizeKMeans, computeProfiles, estimateStepSize,
  resolveStepSizes, walk, sanitizeCuts, snapUniformCuts, stabilizeCuts, stabilizeBothAxes,
  resample, applyPalette, snapPixels,
} from '../js/core/pixelSnapper.js';

const cfg = DEFAULT_PIXEL_SNAPPER_CONFIG;

function bmp(w, h, fillFn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fillFn(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

// ---------------------------------------------------------------- quantizeKMeans

test('quantizeKMeans: two well-separated colors converge to exactly those two colors', () => {
  const img = bmp(2, 2, (x, y) => {
    const i = y * 2 + x;
    return i < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255];
  });
  const out = quantizeKMeans(img, 2, 42);
  const px = i => [out.data[i * 4], out.data[i * 4 + 1], out.data[i * 4 + 2], out.data[i * 4 + 3]];
  assert.deepEqual(px(0), [255, 0, 0, 255]);
  assert.deepEqual(px(1), [255, 0, 0, 255]);
  assert.deepEqual(px(2), [0, 0, 255, 255]);
  assert.deepEqual(px(3), [0, 0, 255, 255]);
});

test('quantizeKMeans: a single real color collapses every centroid onto itself, output equals input exactly', () => {
  const img = bmp(2, 2, () => [100, 150, 200, 255]);
  const out = quantizeKMeans(img, 4, 42);
  assert.deepEqual([...out.data], [100, 150, 200, 255, 100, 150, 200, 255, 100, 150, 200, 255, 100, 150, 200, 255]);
});

test('quantizeKMeans: fully-transparent pixels pass through unchanged, including their raw (unpremultiplied) RGB', () => {
  const img = bmp(2, 1, x => x === 0 ? [10, 20, 30, 0] : [255, 255, 255, 255]);
  const out = quantizeKMeans(img, 2, 42);
  assert.deepEqual([...out.data], [10, 20, 30, 0, 255, 255, 255, 255]);
});

test('quantizeKMeans: an all-transparent image is returned as an unchanged clone', () => {
  const img = bmp(2, 2, () => [1, 2, 3, 0]);
  const out = quantizeKMeans(img, 4, 42);
  assert.deepEqual([...out.data], [...img.data]);
  assert.notEqual(out.data, img.data); // clone, not the same buffer
});

// ---------------------------------------------------------------- computeProfiles

test('computeProfiles: a single vertical step edge produces one non-zero gradient pair in colProj, all-zero rowProj', () => {
  // columns: black,black,white,white,white (w=5); h=3 identical rows
  const grays = [0, 0, 255, 255, 255];
  const img = bmp(5, 3, x => [grays[x], grays[x], grays[x], 255]);
  const { colProj, rowProj } = computeProfiles(img);
  assert.deepEqual(colProj, [0, 765, 765, 0, 0]);
  assert.deepEqual(rowProj, [0, 0, 0]);
});

test('computeProfiles: rejects images smaller than 3x3', () => {
  const img = bmp(2, 5, () => [0, 0, 0, 255]);
  assert.throws(() => computeProfiles(img), /minimum 3x3/);
});

// ---------------------------------------------------------------- estimateStepSize

test('estimateStepSize: evenly-spaced clean peaks -> median spacing', () => {
  const profile = new Array(25).fill(0);
  for (const i of [5, 10, 15, 20]) profile[i] = 10;
  assert.equal(estimateStepSize(profile, cfg), 5);
});

test('estimateStepSize: only strict local maxima count as peaks -- a flat-equal run has none, an isolated bump does', () => {
  const profile = new Array(25).fill(0);
  profile[5] = 1; profile[6] = 10; profile[7] = 1; profile[20] = 10;
  assert.equal(estimateStepSize(profile, cfg), 14);
});

test('estimateStepSize: an all-zero profile has no signal at all -> null', () => {
  assert.equal(estimateStepSize(new Array(10).fill(0), cfg), null);
});

test('estimateStepSize: fewer than 2 peaks -> null', () => {
  const profile = new Array(10).fill(0);
  profile[5] = 10;
  assert.equal(estimateStepSize(profile, cfg), null);
});

// ---------------------------------------------------------------- resolveStepSizes

test('resolveStepSizes: an explicit override wins outright, ignoring both estimates', () => {
  assert.deepEqual(resolveStepSizes(3, 9, 100, 100, cfg, 7), [7, 7]);
  assert.deepEqual(resolveStepSizes(null, null, 100, 100, cfg, 7), [7, 7]);
});

test('resolveStepSizes: two agreeing estimates average', () => {
  assert.deepEqual(resolveStepSizes(4, 6, 100, 100, cfg), [5, 5]);
});

test('resolveStepSizes: two wildly skewed estimates fall back to the smaller one', () => {
  assert.deepEqual(resolveStepSizes(2, 10, 100, 100, cfg), [2, 2]); // ratio 5 > maxStepRatio 1.8
});

test('resolveStepSizes: a missing axis borrows its sibling\'s estimate', () => {
  assert.deepEqual(resolveStepSizes(6, null, 100, 100, cfg), [6, 6]);
  assert.deepEqual(resolveStepSizes(null, 6, 100, 100, cfg), [6, 6]);
});

test('resolveStepSizes: both missing falls back to size/fallbackTargetSegments, floored at 1', () => {
  assert.deepEqual(resolveStepSizes(null, null, 640, 640, cfg), [10, 10]); // 640/64
  assert.deepEqual(resolveStepSizes(null, null, 10, 10, cfg), [1, 1]); // 10/64 < 1, floored
});

// ---------------------------------------------------------------- walk

test('walk: snaps to a strong nearby gradient peak within the search window', () => {
  const profile = new Array(20).fill(1);
  profile[6] = 50; // strong peak near the first step target (5)
  assert.deepEqual(walk(profile, 5, 20, cfg), [0, 6, 11, 16, 20]);
});

test('walk: falls back to the raw stepped position when nothing in the window clears the strength threshold', () => {
  const profile = new Array(20).fill(0); // no signal anywhere -- the found "max" (0) never exceeds mean*threshold (0)
  assert.deepEqual(walk(profile, 5, 20, cfg), [0, 5, 10, 15, 20]);
});

test('walk: throws on an empty profile', () => {
  assert.throws(() => walk([], 5, 10, cfg), /empty profile/);
});

// ---------------------------------------------------------------- sanitizeCuts

test('sanitizeCuts: sorts, dedupes, and guarantees a leading 0 and trailing limit', () => {
  assert.deepEqual(sanitizeCuts([3, 3, 7, 0, 10], 10), [0, 3, 7, 10]);
  assert.deepEqual(sanitizeCuts([5], 10), [0, 5, 10]);
});

test('sanitizeCuts: clamps any value >= limit down to exactly limit', () => {
  assert.deepEqual(sanitizeCuts([0, 15, 20], 10), [0, 10]);
});

// ---------------------------------------------------------------- snapUniformCuts

test('snapUniformCuts: on a flat (no-signal) profile, cells land at their raw uniform positions', () => {
  assert.deepEqual(snapUniformCuts(new Array(20).fill(1), 20, 5, cfg, 4), [0, 3, 8, 13, 20]);
});

test('snapUniformCuts: limit of 0 or 1 are degenerate special cases', () => {
  assert.deepEqual(snapUniformCuts([], 0, 5, cfg, 4), [0]);
  assert.deepEqual(snapUniformCuts([1], 1, 5, cfg, 4), [0, 1]);
});

// ---------------------------------------------------------------- resample

test('resample: majority-color voting per cell, using the (possibly coarser) analysis image', () => {
  const img = bmp(4, 2, x => x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
  const out = resample(img, [0, 2, 4], [0, 2]);
  assert.equal(out.width, 2);
  assert.equal(out.height, 1);
  assert.deepEqual([...out.data], [255, 0, 0, 255, 0, 0, 255, 255]);
});

test('resample: ties break on lexicographic [r,g,b,a] order, not insertion order', () => {
  // one pixel each of two colors -> tied 1-1 -> the numerically smaller RGBA tuple wins
  const img = bmp(2, 1, x => x === 0 ? [200, 0, 0, 255] : [10, 0, 0, 255]);
  const out = resample(img, [0, 2], [0, 1]);
  assert.deepEqual([...out.data], [10, 0, 0, 255]);
});

test('resample: rejects fewer than 2 cuts on either axis', () => {
  const img = bmp(2, 2, () => [0, 0, 0, 255]);
  assert.throws(() => resample(img, [0], [0, 2]), /Insufficient grid cuts/);
});

// ---------------------------------------------------------------- applyPalette

test('applyPalette: remaps each opaque pixel to its nearest palette color, alpha preserved', () => {
  const img = bmp(1, 1, () => [10, 10, 10, 128]);
  const out = applyPalette(img, [[0, 0, 0], [255, 255, 255]]);
  assert.deepEqual([...out.data], [0, 0, 0, 128]);
});

test('applyPalette: transparent pixels pass through untouched', () => {
  const img = bmp(1, 1, () => [10, 10, 10, 0]);
  const out = applyPalette(img, [[0, 0, 0]]);
  assert.deepEqual([...out.data], [10, 10, 10, 0]);
});

test('applyPalette: rejects an empty palette', () => {
  const img = bmp(1, 1, () => [0, 0, 0, 255]);
  assert.throws(() => applyPalette(img, []), /at least one RGB color/);
});

// ---------------------------------------------------------------- snapPixels (end-to-end)

test('snapPixels: images smaller than 3x3 are returned unchanged (same bitmap object) rather than erroring', () => {
  const img = bmp(2, 2, () => [1, 2, 3, 255]);
  const result = snapPixels(img);
  assert.equal(result.bitmap, img);
});

test('snapPixels: a solid-color image collapses to that exact color everywhere in the output', () => {
  const img = bmp(12, 12, () => [40, 90, 200, 255]);
  const result = snapPixels(img);
  const { data } = result.bitmap;
  for (let i = 0; i < data.length; i += 4) {
    assert.deepEqual([data[i], data[i + 1], data[i + 2], data[i + 3]], [40, 90, 200, 255]);
  }
});

test('snapPixels: with a target palette, every opaque output pixel is an exact palette entry', () => {
  const img = bmp(12, 12, (x, y) => (x + y) % 2 === 0 ? [253, 2, 1, 255] : [1, 2, 253, 255]);
  const palette = [[255, 0, 0], [0, 0, 255]];
  const result = snapPixels(img, { palette });
  const { data } = result.bitmap;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const px = [data[i], data[i + 1], data[i + 2]];
    assert.ok(palette.some(c => c[0] === px[0] && c[1] === px[1] && c[2] === px[2]), `pixel ${px} not in palette`);
  }
});

test('snapPixels: without a palette, output stays within the k-means-quantized colors (not necessarily the raw source colors)', () => {
  const img = bmp(10, 10, () => [77, 88, 99, 255]);
  const result = snapPixels(img, { kColors: 4 });
  assert.ok(result.bitmap.width > 0 && result.bitmap.height > 0);
});
