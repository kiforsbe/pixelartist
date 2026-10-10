import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapValue, snapPoint, rectBetween, snapRect, frameAt, clampMoveDelta,
} from '../js/modes/sprites/application/frame-geometry.js';

test('snapValue passes values through when snapping is off and rounds when on', () => {
  assert.equal(snapValue(13, { snap: false, gridSize: 8 }), 13);
  assert.equal(snapValue(13, { snap: true, gridSize: 8 }), 16);
  assert.equal(snapValue(11, { snap: true, gridSize: 8 }), 8);
  // gridSize below 1 is clamped to 1 (a 0 grid would divide by zero)
  assert.equal(snapValue(13, { snap: true, gridSize: 0 }), 13);
  assert.equal(snapValue(13, undefined), 13);
});

test('snapPoint snaps both axes with the same options', () => {
  assert.deepEqual(snapPoint(13, 3, { snap: true, gridSize: 8 }), { x: 16, y: 0 });
});

test('rectBetween treats points as pixel indices when inclusive, as edges otherwise', () => {
  assert.deepEqual(rectBetween(2, 3, 5, 9, true), { x: 2, y: 3, w: 4, h: 7 });
  assert.deepEqual(rectBetween(5, 9, 2, 3, true), { x: 2, y: 3, w: 4, h: 7 });
  assert.deepEqual(rectBetween(2, 3, 5, 9, false), { x: 2, y: 3, w: 3, h: 6 });
  // degenerate non-inclusive rects are floored to 1x1, never 0
  assert.deepEqual(rectBetween(4, 4, 4, 4, false), { x: 4, y: 4, w: 1, h: 1 });
});

test('snapRect snaps both corners and keeps at least 1x1', () => {
  const rect = { x: 3, y: 3, w: 10, h: 10 };
  assert.equal(snapRect(rect, { snap: false, gridSize: 8 }), rect);
  assert.deepEqual(snapRect(rect, { snap: true, gridSize: 8 }), { x: 0, y: 0, w: 16, h: 16 });
  assert.deepEqual(snapRect({ x: 1, y: 1, w: 1, h: 1 }, { snap: true, gridSize: 8 }), { x: 0, y: 0, w: 1, h: 1 });
});

test('frameAt returns the topmost frame containing a point, else null', () => {
  const under = { id: 'a', x: 0, y: 0, w: 16, h: 16 };
  const over = { id: 'b', x: 8, y: 8, w: 16, h: 16 };
  const sheet = { frames: [under, over] };
  assert.equal(frameAt(sheet, 10, 10), over);
  assert.equal(frameAt(sheet, 2, 2), under);
  assert.equal(frameAt(sheet, 16, 0), null);
  assert.equal(frameAt(sheet, 100, 100), null);
});

test('clampMoveDelta keeps the whole bounding box on-sheet', () => {
  const sheet = { width: 64, height: 64 };
  const bbox = { x: 8, y: 8, w: 16, h: 16 };
  assert.deepEqual(clampMoveDelta(sheet, bbox, { dx: 4, dy: 4 }), { dx: 4, dy: 4 });
  assert.deepEqual(clampMoveDelta(sheet, bbox, { dx: -100, dy: -100 }), { dx: -8, dy: -8 });
  assert.deepEqual(clampMoveDelta(sheet, bbox, { dx: 100, dy: 100 }), { dx: 40, dy: 40 });
});

