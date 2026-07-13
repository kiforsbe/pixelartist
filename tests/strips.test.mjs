import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFreeRect, buildStripFrames } from '../js/core/strips.js';

const sheet = (w, h, frames = []) => ({ width: w, height: h, frames });

test('empty sheet places at origin', () => {
  assert.deepEqual(findFreeRect(sheet(64, 64), 48, 16), { x: 0, y: 0 });
});

test('skips occupied space, places right of frames then next row', () => {
  const s = sheet(64, 64, [{ x: 0, y: 0, w: 32, h: 16 }]);
  assert.deepEqual(findFreeRect(s, 32, 16), { x: 32, y: 0 });
  assert.deepEqual(findFreeRect(s, 48, 16), { x: 0, y: 16 });
});

test('returns null when nothing fits', () => {
  assert.equal(findFreeRect(sheet(64, 64), 65, 16), null);
  const full = sheet(32, 16, [{ x: 0, y: 0, w: 32, h: 16 }]);
  assert.equal(findFreeRect(full, 16, 16), null);
});

test('buildStripFrames lays out a contiguous named row', () => {
  const fr = buildStripFrames('walk', 8, 4, 16, 16, 3);
  assert.deepEqual(fr.map(f => [f.name, f.x, f.y]), [
    ['walk_0', 8, 4], ['walk_1', 24, 4], ['walk_2', 40, 4],
  ]);
  assert.deepEqual(fr[0], { name: 'walk_0', x: 8, y: 4, w: 16, h: 16, pivotX: 0, pivotY: 0 });
});
