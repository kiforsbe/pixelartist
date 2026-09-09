// tests/ramps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPalette, normalizePalette } from '../js/core/palettes.js';
import { detectRamps, rampContaining, stepAlongRamp } from '../js/core/ramps.js';

function paletteOf(colors, extra = {}) {
  return normalizePalette({
    id: 'p', name: 'P', indexed: true,
    colors: colors.map(c => [...c, 255]),
    empty: colors.map(() => false),
    ...extra,
  });
}

// A clean 4-step grey ramp followed by a 3-step red ramp.
const GREYS_THEN_REDS = [
  [20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200],
  [60, 10, 10], [140, 30, 30], [220, 60, 60],
];

test('normalizePalette adds an empty ramps array to an old palette', () => {
  const p = normalizePalette({ id: 'x', name: 'X', colors: [[0, 0, 0, 255]] });
  assert.deepEqual(p.ramps, []);
});

test('createPalette starts with no ramps', () => {
  assert.deepEqual(createPalette({ name: 'New' }).ramps, []);
});

test('detectRamps finds maximal monotonic runs', () => {
  const ramps = detectRamps(paletteOf(GREYS_THEN_REDS));
  assert.deepEqual(ramps, [[0, 1, 2, 3], [4, 5, 6]]);
});

test('a hue jump breaks a run even when luminance keeps rising', () => {
  // grey -> grey -> saturated blue: luminance rises throughout, hue does not.
  const ramps = detectRamps(paletteOf([[20, 20, 20], [80, 80, 80], [40, 40, 240]]));
  assert.deepEqual(ramps, [[0, 1]]);
});

test('a luminance reversal breaks a run', () => {
  const ramps = detectRamps(paletteOf([[20, 20, 20], [120, 120, 120], [60, 60, 60]]));
  assert.deepEqual(ramps, [[0, 1]]);
});

test('an empty slot breaks a run', () => {
  const p = paletteOf([[20, 20, 20], [70, 70, 70], [130, 130, 130]]);
  p.empty[1] = true;
  assert.deepEqual(detectRamps(p), []);
});

test('a single isolated entry is not a ramp', () => {
  assert.deepEqual(detectRamps(paletteOf([[10, 10, 10]])), []);
});

test('rampContaining finds the run holding a color', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.deepEqual(rampContaining(p, [130, 130, 130, 255]), [0, 1, 2, 3]);
  assert.deepEqual(rampContaining(p, [140, 30, 30, 255]), [4, 5, 6]);
});

test('rampContaining returns null for a color in no ramp', () => {
  assert.equal(rampContaining(paletteOf([[10, 10, 10]]), [10, 10, 10, 255]), null);
});

test('a named ramp overrides detection', () => {
  const p = paletteOf(GREYS_THEN_REDS, { ramps: [{ name: 'custom', indices: [0, 4, 6] }] });
  assert.deepEqual(rampContaining(p, [20, 20, 20, 255], 'custom'), [0, 4, 6]);
});

test('stepAlongRamp moves one entry toward light and never interpolates', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.deepEqual(stepAlongRamp(p, [70, 70, 70, 255], 1), [130, 130, 130, 255]);
  assert.deepEqual(stepAlongRamp(p, [130, 130, 130, 255], -1), [70, 70, 70, 255]);
});

test('stepAlongRamp clamps at both ends rather than wrapping', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.deepEqual(stepAlongRamp(p, [200, 200, 200, 255], 1), [200, 200, 200, 255]);
  assert.deepEqual(stepAlongRamp(p, [20, 20, 20, 255], -1), [20, 20, 20, 255]);
});

test('stepAlongRamp returns null for a color in no ramp -- it does not guess', () => {
  assert.equal(stepAlongRamp(paletteOf([[10, 10, 10]]), [10, 10, 10, 255], 1), null);
});

test('stepAlongRamp preserves the source alpha', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.equal(stepAlongRamp(p, [70, 70, 70, 128], 1)[3], 128);
});
