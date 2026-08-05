import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameBounds } from '../js/domain/sprites/frames.js';
import { stripForFrame } from '../js/domain/sprites/strips.js';

test('frameBounds returns the union of frame rectangles', () => {
  assert.deepEqual(frameBounds([
    { x: 8, y: 5, w: 4, h: 7 },
    { x: 2, y: 9, w: 3, h: 2 },
    { x: 10, y: 1, w: 6, h: 3 },
  ]), { x: 2, y: 1, w: 14, h: 11 });
});

test('stripForFrame returns only intact strip animations containing the frame', () => {
  const loose = { id: 'loose', strip: false, frames: [{ frameId: 'a' }] };
  const strip = { id: 'strip', strip: true, frames: [{ frameId: 'a' }, { frameId: 'b' }] };
  const sheet = { animations: [loose, strip] };
  assert.equal(stripForFrame(sheet, 'a'), strip);
  assert.equal(stripForFrame(sheet, 'missing'), null);
  assert.equal(stripForFrame(null, 'a'), null);
});
