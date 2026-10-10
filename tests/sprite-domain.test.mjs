import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameBounds } from '../js/domain/sprites/frames.js';

test('frameBounds returns the union of frame rectangles', () => {
  assert.deepEqual(frameBounds([
    { x: 8, y: 5, w: 4, h: 7 },
    { x: 2, y: 9, w: 3, h: 2 },
    { x: 10, y: 1, w: 6, h: 3 },
  ]), { x: 2, y: 1, w: 14, h: 11 });
});

