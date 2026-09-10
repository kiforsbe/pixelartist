import test from 'node:test';
import assert from 'node:assert/strict';
import { strokeBounds, strokeStamps } from '../js/core/brush-stroke.js';
import { normalizeBrush } from '../js/core/brushes.js';

test('strokeBounds covers a centered mask with no scatter', () => {
  assert.deepEqual(strokeBounds(10, 10, 3, 3, 0), { x0: 9, y0: 9, x1: 11, y1: 11 });
});

test('strokeBounds widens in BOTH directions for scatter -- not just right and down', () => {
  const b = strokeBounds(10, 10, 3, 3, 4);
  assert.equal(b.x0, 5, 'left edge must account for negative scatter');
  assert.equal(b.y0, 5, 'top edge must account for negative scatter');
  assert.equal(b.x1, 15);
  assert.equal(b.y1, 15);
});

test('a size-1 mask with no scatter bounds exactly one pixel', () => {
  assert.deepEqual(strokeBounds(7, 9, 1, 1, 0), { x0: 7, y0: 9, x1: 7, y1: 9 });
});

test('every scattered stamp stays within the scatter radius of its path point', () => {
  const mask = normalizeBrush({ mask: { kind: 'square', size: 3, scatter: 5 } }).mask;
  const points = Array.from({ length: 50 }, (_, i) => ({ x: 20 + i, y: 20 }));
  for (const s of strokeStamps(points, mask, 1234)) {
    assert.ok(Math.abs(s.y - 20) <= 5, `stamp escaped scatter radius: ${s.y}`);
  }
});

test('bounds computed from strokeBounds contain every stamped mask pixel', () => {
  const mask = normalizeBrush({ mask: { kind: 'square', size: 3, scatter: 4 } }).mask;
  const points = [{ x: 30, y: 30 }];
  for (const s of strokeStamps(points, mask, 99)) {
    const b = strokeBounds(points[0].x, points[0].y, 3, 3, 4);
    const stampBox = strokeBounds(s.x, s.y, 3, 3, 0);
    assert.ok(stampBox.x0 >= b.x0 && stampBox.x1 <= b.x1, 'x outside declared bounds');
    assert.ok(stampBox.y0 >= b.y0 && stampBox.y1 <= b.y1, 'y outside declared bounds');
  }
});
