// tests/timeline-playback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancePlayback } from '../js/domain/sprites/playback.js';

function makeAnim(overrides = {}) {
  return {
    baseDuration: 100, baseFps: undefined, baseStep: undefined,
    frames: [
      { frameId: 'a', duration: 100, step: null },
      { frameId: 'b', duration: 100, step: null },
      { frameId: 'c', duration: 100, step: null },
    ],
    ...overrides,
  };
}

test('advancePlayback holds position when elapsed time is under the current frame duration', () => {
  const result = advancePlayback(makeAnim(), 0, 0, 40, true);
  assert.deepEqual(result, { position: 0, acc: 40, stopped: false, cursor: 0 });
});

test('advancePlayback advances one frame and carries the remainder', () => {
  // 90ms already accumulated + 30ms elapsed = 120ms against a 100ms frame:
  // one boundary crossed, 20ms left over.
  const result = advancePlayback(makeAnim(), 0, 90, 30, true);
  assert.deepEqual(result, { position: 1, acc: 20, stopped: false, cursor: 1 });
});

test('advancePlayback can cross multiple frame boundaries in one call', () => {
  // 250ms / 100ms per frame: 0->1 (150 left), 1->2 (50 left), 50 < 100 so it stops there.
  const result = advancePlayback(makeAnim(), 0, 0, 250, true);
  assert.deepEqual(result, { position: 2, acc: 50, stopped: false, cursor: 2 });
});

test('advancePlayback loops back to frame 0 when loop is true and playback runs past the last frame', () => {
  const result = advancePlayback(makeAnim(), 2, 90, 30, true);
  assert.deepEqual(result, { position: 0, acc: 20, stopped: false, cursor: 0 });
});

test('advancePlayback clamps to the last frame and reports stopped when loop is false', () => {
  const result = advancePlayback(makeAnim(), 2, 90, 30, false);
  assert.deepEqual(result, { position: 2, acc: 20, stopped: true, cursor: 2 });
});

test('advancePlayback uses fps/step timing when the animation is fps-primary', () => {
  // baseFps 10, step 1 -> fpsStepToMs(10, 1) = 100ms/frame, same cadence as the ms-primary cases above.
  const anim = makeAnim({ baseDuration: undefined, baseFps: 10, baseStep: 1 });
  const result = advancePlayback(anim, 0, 90, 30, true);
  assert.deepEqual(result, { position: 1, acc: 20, stopped: false, cursor: 1 });
});
