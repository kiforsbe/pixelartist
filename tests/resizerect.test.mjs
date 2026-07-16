import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeRect } from '../js/core/resizerect.js';

const TARGET = { x: 0, y: 0, w: 32, h: 32 };
const ORIG = { x: 8, y: 8, w: 8, h: 8 }; // edges at 8..16

test('corner se: both axes follow the pointer (inclusive pixel)', () => {
  // pointer on pixel (19, 21) → east edge 20, south edge 22
  assert.deepEqual(resizeRect(ORIG, 'se', 19, 21, TARGET), { x: 8, y: 8, w: 12, h: 14 });
});

test('corner nw: opposite corner anchored', () => {
  // pointer on pixel (4, 6) → west edge 4, north edge 6, east/south stay 16
  assert.deepEqual(resizeRect(ORIG, 'nw', 4, 6, TARGET), { x: 4, y: 6, w: 12, h: 10 });
});

test('edge handles move one axis only', () => {
  assert.deepEqual(resizeRect(ORIG, 'e', 25, 0, TARGET), { x: 8, y: 8, w: 18, h: 8 });
  assert.deepEqual(resizeRect(ORIG, 'n', 0, 2, TARGET), { x: 8, y: 2, w: 8, h: 14 });
  assert.deepEqual(resizeRect(ORIG, 's', 31, 11, TARGET), { x: 8, y: 8, w: 8, h: 4 });
  assert.deepEqual(resizeRect(ORIG, 'w', 10, 31, TARGET), { x: 10, y: 8, w: 6, h: 8 });
});

test('drag through the anchor flips and normalizes', () => {
  // 'e' dragged left past the west edge (8): pointer pixel 3 → edge 4;
  // normalized rect spans 4..8
  assert.deepEqual(resizeRect(ORIG, 'e', 3, 8, TARGET), { x: 4, y: 8, w: 4, h: 8 });
  // 'nw' dragged past the se corner: west/north candidates land AT pixel 20,
  // fixed edges stay 16 → normalized 16..20
  assert.deepEqual(resizeRect(ORIG, 'nw', 20, 20, TARGET), { x: 16, y: 16, w: 4, h: 4 });
});

test('pointer clamped to target; result stays inside', () => {
  const r = resizeRect(ORIG, 'se', 99, 99, TARGET);
  assert.deepEqual(r, { x: 8, y: 8, w: 24, h: 24 }); // east/south edge at 32
  const r2 = resizeRect(ORIG, 'nw', -5, -5, TARGET);
  assert.deepEqual(r2, { x: 0, y: 0, w: 16, h: 16 });
});

test('min 1x1 when collapsed onto the anchor', () => {
  // 'w' dragged onto the east edge pixel (15 → edge 15, east edge 16)
  const r = resizeRect(ORIG, 'w', 15, 8, TARGET);
  assert.equal(r.w, 1);
  // 'e' dragged onto the west edge: pointer 8 → edge 9 → width 1
  assert.deepEqual(resizeRect(ORIG, 'e', 8, 8, TARGET).w, 1);
});

test('degenerate edge collision pins INSIDE the fixed edge, never past it', () => {
  // 'w' dragged exactly onto the fixed east edge coordinate (16):
  // the 1px rect sits at 15..16, not 16..17
  assert.deepEqual(resizeRect(ORIG, 'w', 16, 8, TARGET), { x: 15, y: 8, w: 1, h: 8 });
  // 'e' onto pixel 7 → edge 8 collides with the fixed west edge:
  // pin at 8..9, inside
  assert.deepEqual(resizeRect(ORIG, 'e', 7, 8, TARGET), { x: 8, y: 8, w: 1, h: 8 });
  // 'n' onto the fixed south edge coordinate (16): pin at 15..16
  assert.deepEqual(resizeRect(ORIG, 'n', 8, 16, TARGET), { x: 8, y: 15, w: 8, h: 1 });
  // 's' onto pixel 7 → edge 8 collides with the fixed north edge: pin 8..9
  assert.deepEqual(resizeRect(ORIG, 's', 8, 7, TARGET), { x: 8, y: 8, w: 8, h: 1 });
});
