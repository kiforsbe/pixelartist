import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, stampRandom, strokeStamps } from '../js/core/brush-stroke.js';
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

test('spacing 1 stamps every point', () => {
  const mask = normalizeBrush({ mask: { spacing: 1 } }).mask;
  assert.equal(strokeStamps(line(10), mask, 1).length, 10);
});

test('spacing N stamps every Nth point and always includes the first', () => {
  const mask = normalizeBrush({ mask: { spacing: 3 } }).mask;
  const stamps = strokeStamps(line(10), mask, 1);
  assert.deepEqual(stamps.map(s => s.x), [0, 3, 6, 9]);
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
