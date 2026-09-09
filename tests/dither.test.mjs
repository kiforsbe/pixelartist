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

// Fraction of a pattern's own tile where the cell is 0 (primary). checker
// and lines are exact 50/50 splits, so this reads the same as secondary
// coverage for them; dots25's whole point is that it is NOT 50/50 -- its
// sparse "dots" are the 0 cells, at a genuine quarter density, not the 12.5%
// or 87.5% an earlier, wrongly-sized cells array once produced.
function primaryCoverage(name) {
  const p = PATTERNS[name];
  const zeros = p.cells.filter(c => c === 0).length;
  return zeros / p.cells.length;
}

test('dots25 marks a quarter of its tile; checker and lines split theirs evenly', () => {
  assert.equal(primaryCoverage('dots25'), 0.25);
  assert.equal(primaryCoverage('checker'), 0.5);
  assert.equal(primaryCoverage('lines'), 0.5);
});

function lcm(a, b) {
  const gcd = (x, y) => (y === 0 ? x : gcd(y, x % y));
  return (a / gcd(a, b)) * b;
}

// The defect this catches: two named patterns that look different on paper
// (different dimensions, different cells arrays) but produce the exact same
// picksSecondary output everywhere -- which is exactly what happened when
// `bayer4` (a median split of BAYER4) turned out to be pixel-identical to
// `checker`. Comparing over the LCM of every pattern's width/height, rather
// than one pattern's own tile, means a future pattern with a different
// period still gets checked honestly against the others.
test('no two named patterns produce identical output across their combined tile period', () => {
  const names = Object.keys(PATTERNS);
  const periodW = names.reduce((acc, n) => lcm(acc, PATTERNS[n].width), 1);
  const periodH = names.reduce((acc, n) => lcm(acc, PATTERNS[n].height), 1);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      let identical = true;
      for (let y = 0; y < periodH && identical; y++) {
        for (let x = 0; x < periodW; x++) {
          if (patternPicksSecondary(names[i], x, y) !== patternPicksSecondary(names[j], x, y)) {
            identical = false;
            break;
          }
        }
      }
      assert.equal(identical, false, `${names[i]} and ${names[j]} are identical across their combined tile period`);
    }
  }
});
