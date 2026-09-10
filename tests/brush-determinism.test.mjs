import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, pathSteps, stampRandom, strokeStamps } from '../js/core/brush-stroke.js';
import { normalizeBrush } from '../js/core/brushes.js';

const line = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }));

test('mulberry32 is deterministic for a given seed', () => {
  const a = mulberry32(12345), b = mulberry32(12345);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

test('mulberry32 differs across seeds', () => {
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('stampRandom depends only on (seed, index, salt), not call order', () => {
  const forward = [0, 1, 2, 3].map(i => stampRandom(99, i, 'x'));
  const backward = [3, 2, 1, 0].map(i => stampRandom(99, i, 'x')).reverse();
  assert.deepEqual(forward, backward);
});

test('spacing 1 stamps every pixel of travel, even across sparse waypoints', () => {
  const mask = normalizeBrush({ mask: { spacing: 1 } }).mask;
  const sparse = [{ x: 0, y: 0 }, { x: 30, y: 0 }];
  const stamps = strokeStamps(sparse, mask, 1);
  assert.deepEqual(stamps.map(s => s.x), Array.from({ length: 31 }, (_, i) => i));
});

test('spacing N stamps every N pixels of travel and always includes the first', () => {
  const mask = normalizeBrush({ mask: { spacing: 3 } }).mask;
  const sparse = [{ x: 0, y: 0 }, { x: 9, y: 0 }];
  const stamps = strokeStamps(sparse, mask, 1);
  assert.deepEqual(stamps.map(s => s.x), [0, 3, 6, 9]);
});

test('a sparse path and a dense path covering the same distance stamp identically', () => {
  // Regression case: a fast drag samples few, far-apart points; a slow drag
  // over the same distance samples many, close-together points. Spacing is
  // defined in pixels of travel, so both must produce the same stamps.
  const mask = normalizeBrush({ mask: { spacing: 5 } }).mask;
  const sparse = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
  const dense = line(31);
  assert.deepEqual(strokeStamps(sparse, mask, 42), strokeStamps(dense, mask, 42));
});

test('a single-point path yields exactly one stamp', () => {
  const mask = normalizeBrush({ mask: { spacing: 5 } }).mask;
  assert.deepEqual(strokeStamps([{ x: 7, y: 9 }], mask, 1), [{ x: 7, y: 9, rotate: 0 }]);
});

test('scatter 0 leaves positions exactly on the path', () => {
  const mask = normalizeBrush({ mask: { scatter: 0 } }).mask;
  for (const s of strokeStamps(line(5), mask, 7)) assert.equal(s.y, 0);
});

test('scatter offsets are integers within the radius', () => {
  const mask = normalizeBrush({ mask: { scatter: 3 } }).mask;
  for (const s of strokeStamps(line(40), mask, 7)) {
    assert.equal(Number.isInteger(s.x), true);
    assert.equal(Number.isInteger(s.y), true);
    assert.ok(Math.abs(s.y) <= 3, `y offset ${s.y} exceeds scatter`);
  }
});

test('the same seed reproduces a scattered stroke byte for byte', () => {
  const mask = normalizeBrush({ mask: { scatter: 4, rotateJitter: true } }).mask;
  assert.deepEqual(strokeStamps(line(30), mask, 555), strokeStamps(line(30), mask, 555));
});

test('a different seed produces a different scattered stroke', () => {
  const mask = normalizeBrush({ mask: { scatter: 4 } }).mask;
  assert.notDeepEqual(strokeStamps(line(30), mask, 1), strokeStamps(line(30), mask, 2));
});

test('re-rasterizing a prefix reproduces that prefix exactly -- shape previews depend on this', () => {
  const mask = normalizeBrush({ mask: { scatter: 4, rotateJitter: true } }).mask;
  const full = strokeStamps(line(20), mask, 42);
  const prefix = strokeStamps(line(8), mask, 42);
  assert.deepEqual(prefix, full.slice(0, prefix.length));
});

test('the prefix invariant holds across sparse, multi-segment waypoints too', () => {
  const mask = normalizeBrush({ mask: { scatter: 4, rotateJitter: true, spacing: 2 } }).mask;
  const full = [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 20 }, { x: 40, y: 20 }];
  const prefixPoints = full.slice(0, 2);
  const fullStamps = strokeStamps(full, mask, 42);
  const prefixStamps = strokeStamps(prefixPoints, mask, 42);
  assert.deepEqual(prefixStamps, fullStamps.slice(0, prefixStamps.length));
});

test('rotateJitter yields only quarter turns', () => {
  const mask = normalizeBrush({ mask: { rotateJitter: true } }).mask;
  for (const s of strokeStamps(line(40), mask, 3)) {
    assert.ok([0, 90, 180, 270].includes(s.rotate), `bad rotate ${s.rotate}`);
  }
});

test('rotateJitter off means every stamp is unrotated', () => {
  const mask = normalizeBrush({ mask: { rotateJitter: false } }).mask;
  for (const s of strokeStamps(line(10), mask, 3)) assert.equal(s.rotate, 0);
});

// --- stamping a stroke one pointer segment at a time -------------------------
//
// Freehand painting cannot hand strokeStamps the whole path: it learns the
// path one pointer-move at a time. It therefore calls strokeStamps per
// segment and passes the travel accumulated so far. These pin the equivalence
// that makes that legal.

// Stamps a path segment by segment, the way drawing-engine.js does. Adjacent
// segments share an endpoint, so the shared stamp is emitted by both -- drop
// the repeat, which is idempotent at the bitmap anyway.
function stampPerSegment(points, mask, seed) {
  const out = [];
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    for (const s of strokeStamps([points[i - 1], points[i]], mask, seed, travelled)) {
      const prev = out[out.length - 1];
      if (prev && prev.x === s.x && prev.y === s.y && prev.rotate === s.rotate) continue;
      out.push(s);
    }
    travelled += pathSteps(points[i - 1], points[i]);
  }
  return out;
}

test('pathSteps counts exactly the pixels of travel strokeStamps densifies to', () => {
  const mask = normalizeBrush({ mask: { spacing: 1 } }).mask;
  for (const [a, b] of [
    [{ x: 0, y: 0 }, { x: 9, y: 0 }],
    [{ x: 0, y: 0 }, { x: 0, y: 6 }],
    [{ x: 3, y: 3 }, { x: 8, y: 8 }],
    [{ x: 10, y: 2 }, { x: 1, y: 7 }],
    [{ x: 4, y: 4 }, { x: 4, y: 4 }],
  ]) {
    // At spacing 1 there is one stamp per densified pixel, endpoints included.
    assert.equal(pathSteps(a, b), strokeStamps([a, b], mask, 1).length - 1,
      `pathSteps disagrees with travel for ${JSON.stringify(a)}->${JSON.stringify(b)}`);
  }
});

test('segment-by-segment stamping equals whole-path stamping, for every spacing', () => {
  // Without startDistance each segment restarted the spacing phase, so stamp
  // count tracked the pointer event rate: spacing 4 over a 40px drag sampled
  // every 2px gave 20 stamps instead of 11.
  const whole = [{ x: 0, y: 20 }, { x: 40, y: 20 }];
  for (const spacing of [1, 2, 4, 7]) {
    const mask = normalizeBrush({ mask: { spacing } }).mask;
    const expected = strokeStamps(whole, mask, 1234);
    for (const sample of [1, 2, 5, 13]) {
      const pts = [];
      for (let x = 0; x <= 40; x += sample) pts.push({ x, y: 20 });
      if (pts[pts.length - 1].x !== 40) pts.push({ x: 40, y: 20 });
      assert.deepEqual(stampPerSegment(pts, mask, 1234), expected,
        `spacing ${spacing} diverges when sampled every ${sample}px`);
    }
  }
});

test('segment-by-segment scatter equals whole-path scatter', () => {
  // The ordinal restarting per segment gave every segment the same first
  // offset, printing the pointer sampling period into the stroke as a visible
  // repeating rhythm.
  const mask = normalizeBrush({ mask: { scatter: 6, rotateJitter: true } }).mask;
  const pts = [];
  for (let x = 0; x <= 40; x += 5) pts.push({ x, y: 20 });
  assert.deepEqual(stampPerSegment(pts, mask, 77), strokeStamps(pts, mask, 77));
});

test('a scattered stroke does not repeat itself at the sampling period', () => {
  // Guards the symptom directly: the first stamp of each segment must not be
  // the same offset every time.
  const mask = normalizeBrush({ mask: { scatter: 6 } }).mask;
  const firsts = [];
  let travelled = 0;
  for (let x = 0; x < 40; x += 5) {
    const a = { x, y: 20 }, b = { x: x + 5, y: 20 };
    firsts.push(strokeStamps([a, b], mask, 1234, travelled)[0].y - 20);
    travelled += pathSteps(a, b);
  }
  assert.ok(new Set(firsts).size > 1, `every segment scattered alike: ${firsts.join(',')}`);
});

test('startDistance defaults to 0, so whole-path callers are unaffected', () => {
  const mask = normalizeBrush({ mask: { spacing: 3, scatter: 4, rotateJitter: true } }).mask;
  const path = [{ x: 0, y: 0 }, { x: 20, y: 5 }];
  assert.deepEqual(strokeStamps(path, mask, 9), strokeStamps(path, mask, 9, 0));
});
