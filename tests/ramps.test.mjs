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
  // Two close-hued oranges (hue ~24 deg, ~26 deg) followed by a saturated
  // cyan-green (hue ~173 deg). Luminance rises at every step (69.9 -> 112.7
  // -> 180.3) and neither achromatic entry is involved, so only the hue
  // check -- not luminance direction -- can be what breaks the run.
  const ramps = detectRamps(paletteOf([[120, 60, 20], [180, 100, 40], [40, 220, 200]]));
  assert.deepEqual(ramps, [[0, 1]]);
});

test('a hue-drift anchor stops small adjacent steps from compounding into a full hue rotation', () => {
  // The real NES palette, indices 30-36: seven entries with rising luminance
  // and consecutive hue deltas of ~26/40/32/29/21/21 degrees -- every
  // adjacent pair is within the 45 degree tolerance, but the run drifts
  // ~168 degrees end to end, magenta through pink/salmon/orange/olive to
  // green. Measuring each entry only against its predecessor would fold
  // this into one 7-entry ramp and shade magenta into green.
  const NES_MAGENTA_TO_GREEN = [
    [228, 84, 236], [236, 88, 180], [236, 106, 100], [212, 136, 32],
    [160, 170, 0], [116, 196, 0], [76, 208, 32],
  ];
  const ramps = detectRamps(paletteOf(NES_MAGENTA_TO_GREEN));
  assert.deepEqual(ramps, [[0, 1], [2, 3], [4, 5, 6]]);
});

test('a grey-hue pair is not a ramp -- shading it would erase the hue', () => {
  // The real CGA palette's brown and neutral grey: [170,85,0] -> [170,170,170].
  // Adjacent-hue-only detection accepts this (grey matches any hue), but a
  // ramp with exactly one chromatic entry has nowhere to shade the hue TO --
  // the next step is colorless. Requires >=2 chromatic entries, or all-grey.
  const ramps = detectRamps(paletteOf([[170, 85, 0], [170, 170, 170]]));
  assert.deepEqual(ramps, []);
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

test('rampContaining returns null when the color is not actually in the named ramp', () => {
  // Index 1's color ([70,70,70]) is a real palette entry but not a member of
  // the named ramp [0, 4, 6] -- a caller must not get an unrelated ramp back.
  const p = paletteOf(GREYS_THEN_REDS, { ramps: [{ name: 'custom', indices: [0, 4, 6] }] });
  assert.equal(rampContaining(p, [70, 70, 70, 255], 'custom'), null);
});

test('normalizePalette drops named-ramp indices that are out of range for this palette', () => {
  const p = normalizePalette({
    id: 'p', name: 'P', colors: [[10, 10, 10, 255], [200, 200, 200, 255]],
    ramps: [{ name: 'corrupt', indices: [0, 999, 1] }],
  });
  assert.deepEqual(p.ramps, [{ name: 'corrupt', indices: [0, 1] }]);
});

test('stepAlongRamp returns null rather than throwing when a named ramp outlives a deleted swatch', () => {
  // Simulate a Task-13-style bug: the ramp was valid when created, but a
  // swatch it references was later removed from `colors` without the ramp
  // being re-normalized. The stale index must degrade to null, not throw.
  const p = paletteOf([[10, 10, 10], [200, 200, 200]], { ramps: [{ name: 'corrupt', indices: [0, 1] }] });
  p.colors.pop();
  assert.equal(stepAlongRamp(p, [10, 10, 10, 255], 1, 'corrupt'), null);
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
