import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNeighborFrame } from '../js/modes/sprites/application/frame-navigation.js';

function frame(id) { return { id, name: id }; }

test('computeNeighborFrame walks the animation order when the frame belongs to it', () => {
  const sheet = { frames: [frame('a'), frame('b'), frame('c')] };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }, { frameId: 'c' }] };
  assert.equal(computeNeighborFrame(sheet, frame('b'), anim, 1), sheet.frames[2]);
  assert.equal(computeNeighborFrame(sheet, frame('b'), anim, -1), sheet.frames[0]);
});

test('computeNeighborFrame clamps at the ends of the animation order (no wraparound)', () => {
  const sheet = { frames: [frame('a'), frame('b')] };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }] };
  assert.equal(computeNeighborFrame(sheet, sheet.frames[1], anim, 1), null);
  assert.equal(computeNeighborFrame(sheet, sheet.frames[0], anim, -1), null);
});

test('computeNeighborFrame falls back to sheet order when the frame is not in the animation', () => {
  const sheet = { frames: [frame('a'), frame('b'), frame('c')] };
  const anim = { frames: [{ frameId: 'z' }] };
  assert.equal(computeNeighborFrame(sheet, sheet.frames[1], anim, 1), sheet.frames[2]);
});

test('computeNeighborFrame falls back to sheet order when there is no animation', () => {
  const sheet = { frames: [frame('a'), frame('b'), frame('c')] };
  assert.equal(computeNeighborFrame(sheet, sheet.frames[0], null, 1), sheet.frames[1]);
  assert.equal(computeNeighborFrame(sheet, sheet.frames[2], null, 1), null);
});
