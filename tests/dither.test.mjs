// tests/dither.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BAYER4, PATTERNS, opacityLevel, passesOpacity, patternPicksSecondary } from '../js/core/dither.js';

test('BAYER4 holds every value 0..15 exactly once', () => {
  const seen = BAYER4.flat().sort((a, b) => a - b);
  assert.deepEqual(seen, Array.from({ length: 16 }, (_, i) => i));
});

test('opacity 100 always passes and opacity 0 never does', () => {
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.equal(passesOpacity(x, y, 100), true);
    assert.equal(passesOpacity(x, y, 0), false);
  }
});

test('opacity 50 passes for exactly half of a 4x4 cell', () => {
  let n = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (passesOpacity(x, y, 50)) n++;
  assert.equal(n, 8);
});

test('opacity 25 passes for a quarter of a 4x4 cell', () => {
  let n = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (passesOpacity(x, y, 25)) n++;
  assert.equal(n, 4);
});

test('opacity snaps to 17 levels -- 30 and 31 are indistinguishable', () => {
  assert.equal(opacityLevel(30), opacityLevel(31));
  assert.equal(opacityLevel(0), 0);
  assert.equal(opacityLevel(100), 16);
});

test('the pattern is anchored to bitmap coordinates, so it tiles globally', () => {
  // Same result at (x, y) and (x+4, y+4): two strokes over one region align.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.equal(passesOpacity(x, y, 50), passesOpacity(x + 4, y + 4, 50));
    assert.equal(passesOpacity(x, y, 50), passesOpacity(x + 40, y + 80, 50));
  }
});

test('negative coordinates still tile correctly', () => {
  assert.equal(passesOpacity(-4, -4, 50), passesOpacity(0, 0, 50));
  assert.equal(passesOpacity(-1, -1, 50), passesOpacity(3, 3, 50));
});

test('checker pattern alternates every pixel', () => {
  assert.notEqual(patternPicksSecondary('checker', 0, 0), patternPicksSecondary('checker', 1, 0));
  assert.equal(patternPicksSecondary('checker', 0, 0), patternPicksSecondary('checker', 2, 0));
});

test('every named pattern exists and has non-zero dimensions', () => {
  for (const [name, p] of Object.entries(PATTERNS)) {
    assert.ok(p.width > 0 && p.height > 0, name);
    assert.equal(p.cells.length, p.width * p.height, name);
  }
});
