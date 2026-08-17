import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDimension } from '../js/components/canvas/dim-labels.js';

const A = { x: 100, y: 200 }, B = { x: 180, y: 200 }; // 80px horizontal span

test('h/end level 0: line 14px below, ext gap 2 overshoot 4, pill centered', () => {
  const L = layoutDimension({ a: A, b: B, axis: 'h', pillW: 30 });
  assert.deepEqual(L.dim, [{ x: 100, y: 214 }, { x: 180, y: 214 }]);
  assert.deepEqual(L.ext[0], [{ x: 100, y: 202 }, { x: 100, y: 218 }]);
  assert.deepEqual(L.ext[1], [{ x: 180, y: 202 }, { x: 180, y: 218 }]);
  assert.equal(L.arrowsOutside, false);
  assert.deepEqual(L.pill, { x: 140, y: 214 });
});

test('level stacks 20px per row', () => {
  const L = layoutDimension({ a: A, b: B, axis: 'h', level: 1, pillW: 10 });
  assert.equal(L.dim[0].y, 234);
});

test("side 'start' flips above with mirrored gap/overshoot", () => {
  const L = layoutDimension({ a: { x: 100, y: 50 }, b: { x: 180, y: 50 }, axis: 'h', side: 'start', pillW: 10 });
  assert.deepEqual(L.dim[0], { x: 100, y: 36 });
  assert.deepEqual(L.ext[0], [{ x: 100, y: 48 }, { x: 100, y: 32 }]);
});

test('v/end: line 14px right of the edge, pill mid-span', () => {
  const L = layoutDimension({ a: { x: 300, y: 100 }, b: { x: 300, y: 160 }, axis: 'v', pillW: 20 });
  assert.deepEqual(L.dim, [{ x: 314, y: 100 }, { x: 314, y: 160 }]);
  assert.deepEqual(L.pill, { x: 314, y: 130 });
});

test('too-small span flips arrows outside and sticks the pill past an end', () => {
  const a = { x: 100, y: 200 }, b = { x: 110, y: 200 }; // 10px span
  const L = layoutDimension({ a, b, axis: 'h', pillW: 30 });
  assert.equal(L.arrowsOutside, true);
  assert.equal(L.pill.y, 214);
  assert.ok(L.pill.x > 110, `pill sticks out right (${L.pill.x})`);
  const L2 = layoutDimension({ a, b, axis: 'h', pillW: 30, stick: 'a' });
  assert.ok(L2.pill.x < 100, `stick 'a' places pill left (${L2.pill.x})`);
});

test('fits threshold is pillW + 2*arrow + 4 exactly', () => {
  // pillW 20 → threshold 36
  assert.equal(layoutDimension({ a: { x: 0, y: 0 }, b: { x: 36, y: 0 }, axis: 'h', pillW: 20 }).arrowsOutside, false);
  assert.equal(layoutDimension({ a: { x: 0, y: 0 }, b: { x: 35, y: 0 }, axis: 'h', pillW: 20 }).arrowsOutside, true);
});
