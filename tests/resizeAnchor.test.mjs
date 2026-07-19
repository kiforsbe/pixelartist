import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDLES_CORNER, HANDLES_ALL, isCenterAnchorModifier, isProportionalModifier,
  handlePoint, resolveAnchor, isAspectLocked, dominantMagnitude, resizeRectFromHandle,
} from '../js/core/resizeAnchor.js';

// ---- modifier predicates ----

test('isCenterAnchorModifier reads altKey; isProportionalModifier reads shiftKey', () => {
  assert.equal(isCenterAnchorModifier({ altKey: true }), true);
  assert.equal(isCenterAnchorModifier({ altKey: false }), false);
  assert.equal(isCenterAnchorModifier({}), false);
  assert.equal(isProportionalModifier({ shiftKey: true }), true);
  assert.equal(isProportionalModifier({ shiftKey: false }), false);
  assert.equal(isProportionalModifier({}), false);
});

// ---- isAspectLocked ----

test('isAspectLocked: corner defaults locked, Shift frees it', () => {
  for (const h of HANDLES_CORNER) {
    assert.equal(isAspectLocked(h, false), true, `${h} unlocked by default`);
    assert.equal(isAspectLocked(h, true), false, `${h} Shift should free it`);
  }
});

test('isAspectLocked: edge defaults free, Shift locks it', () => {
  for (const h of ['n', 'e', 's', 'w']) {
    assert.equal(isAspectLocked(h, false), false, `${h} locked by default`);
    assert.equal(isAspectLocked(h, true), true, `${h} Shift should lock it`);
  }
});

// ---- dominantMagnitude ----

test('dominantMagnitude picks the larger absolute value', () => {
  assert.equal(dominantMagnitude(2, 5), 5);
  assert.equal(dominantMagnitude(-2, 5), 5);
  assert.equal(dominantMagnitude(-7, 5), 7);
  assert.equal(dominantMagnitude(3, 3), 3);
});

// ---- handlePoint / resolveAnchor ----

const RECT = { x: 10, y: 10, w: 20, h: 10 }; // edges 10..30, 10..20

test('handlePoint: literal position of each handle', () => {
  assert.deepEqual(handlePoint(RECT, 'nw'), { x: 10, y: 10 });
  assert.deepEqual(handlePoint(RECT, 'se'), { x: 30, y: 20 });
  assert.deepEqual(handlePoint(RECT, 'n'), { x: 20, y: 10 });
  assert.deepEqual(handlePoint(RECT, 'e'), { x: 30, y: 15 });
  assert.deepEqual(handlePoint(RECT, 'w'), { x: 10, y: 15 });
});

test('resolveAnchor: opposite corner/edge midpoint by default', () => {
  assert.deepEqual(resolveAnchor(RECT, 'se', false), { x: 10, y: 10 }); // nw
  assert.deepEqual(resolveAnchor(RECT, 'nw', false), { x: 30, y: 20 }); // se
  assert.deepEqual(resolveAnchor(RECT, 'e', false), { x: 10, y: 15 });  // w midpoint
  assert.deepEqual(resolveAnchor(RECT, 'n', false), { x: 20, y: 20 });  // s midpoint
});

test('resolveAnchor: rect center when useCenter is true, regardless of handle', () => {
  for (const h of HANDLES_ALL) assert.deepEqual(resolveAnchor(RECT, h, true), { x: 20, y: 15 });
});

// ---- resizeRectFromHandle: migrated from the old resizerect.js suite ----
// (corner-handle cases pass shiftHeld: true, since corner-drag is now
// proportional BY DEFAULT -- these tests specifically exercise the old
// "both axes independently follow the pointer" free behavior, which under
// the new default requires Shift.)

const TARGET = { x: 0, y: 0, w: 32, h: 32 };
const ORIG = { x: 8, y: 8, w: 8, h: 8 }; // edges at 8..16

test('corner se, Shift held (free): both axes independently follow the pointer', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG, 'se', 19, 21, { shiftHeld: true, target: TARGET, inclusive: true }),
    { x: 8, y: 8, w: 12, h: 14 },
  );
});

test('corner nw, Shift held (free): opposite corner anchored', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG, 'nw', 4, 6, { shiftHeld: true, target: TARGET, inclusive: true }),
    { x: 4, y: 6, w: 12, h: 10 },
  );
});

test('edge handles move one axis only (default, no modifiers)', () => {
  assert.deepEqual(resizeRectFromHandle(ORIG, 'e', 25, 0, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 18, h: 8 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'n', 0, 2, { target: TARGET, inclusive: true }), { x: 8, y: 2, w: 8, h: 14 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 's', 31, 11, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 8, h: 4 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'w', 10, 31, { target: TARGET, inclusive: true }), { x: 10, y: 8, w: 6, h: 8 });
});

test('drag through the anchor flips and normalizes', () => {
  assert.deepEqual(resizeRectFromHandle(ORIG, 'e', 3, 8, { target: TARGET, inclusive: true }), { x: 4, y: 8, w: 4, h: 8 });
  assert.deepEqual(
    resizeRectFromHandle(ORIG, 'nw', 20, 20, { shiftHeld: true, target: TARGET, inclusive: true }),
    { x: 16, y: 16, w: 4, h: 4 },
  );
});

test('pointer clamped to target; result stays inside', () => {
  const r = resizeRectFromHandle(ORIG, 'se', 99, 99, { shiftHeld: true, target: TARGET, inclusive: true });
  assert.deepEqual(r, { x: 8, y: 8, w: 24, h: 24 });
  const r2 = resizeRectFromHandle(ORIG, 'nw', -5, -5, { shiftHeld: true, target: TARGET, inclusive: true });
  assert.deepEqual(r2, { x: 0, y: 0, w: 16, h: 16 });
});

test('min 1x1 when collapsed onto the anchor', () => {
  assert.equal(resizeRectFromHandle(ORIG, 'w', 15, 8, { target: TARGET, inclusive: true }).w, 1);
  assert.equal(resizeRectFromHandle(ORIG, 'e', 8, 8, { target: TARGET, inclusive: true }).w, 1);
});

test('degenerate edge collision pins INSIDE the fixed edge, never past it', () => {
  assert.deepEqual(resizeRectFromHandle(ORIG, 'w', 16, 8, { target: TARGET, inclusive: true }), { x: 15, y: 8, w: 1, h: 8 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'e', 7, 8, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 1, h: 8 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'n', 8, 16, { target: TARGET, inclusive: true }), { x: 8, y: 15, w: 8, h: 1 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 's', 8, 7, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 8, h: 1 });
});

// ---- resizeRectFromHandle: new modifier-behavior coverage ----

const ORIG2 = { x: 10, y: 10, w: 20, h: 10 }; // aspect 2:1

test('corner drag with no modifiers is proportional by default', () => {
  // orig aspect 2:1; pointer implies 40x15 (kx=2, ky=1.5) -> dominant kx=2 wins, both scale x2
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'se', 50, 25, { inclusive: false }),
    { x: 10, y: 10, w: 40, h: 20 },
  );
});

test('corner drag + Shift is free (independent axes)', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'se', 50, 25, { shiftHeld: true, inclusive: false }),
    { x: 10, y: 10, w: 40, h: 15 },
  );
});

test('corner drag + Alt anchors at center, still proportional', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'se', 50, 35, { useCenter: true, inclusive: false }),
    { x: -20, y: -5, w: 80, h: 40 },
  );
});

test('edge drag + Shift scales the other axis to match (aspect locked)', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'e', 50, 0, { shiftHeld: true, inclusive: false }),
    { x: 10, y: 5, w: 40, h: 20 },
  );
});

test('edge drag + Alt anchors that axis at center, other axis untouched', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'e', 50, 0, { useCenter: true, inclusive: false }),
    { x: -10, y: 10, w: 60, h: 10 },
  );
});
