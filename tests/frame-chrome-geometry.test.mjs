// tests/frame-chrome-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitHandle } from '../js/modes/sprites/application/frame-chrome-geometry.js';

// Identity projector: screen space === image space, so expected coordinates
// stay readable. Presentation passes (x, y) => view.imageToScreen(x, y).
const identity = (x, y) => ({ x, y });

test('hitHandle returns the corner handle under the pointer, else null', () => {
  const frame = { x: 10, y: 20, w: 30, h: 40 };
  assert.equal(hitHandle(identity, frame, 10, 20), 'nw');
  assert.equal(hitHandle(identity, frame, 40, 60), 'se');
  assert.equal(hitHandle(identity, frame, 43, 63), 'se'); // within 6px slop
  assert.equal(hitHandle(identity, frame, 25, 40), null);
  assert.equal(hitHandle(identity, null, 10, 20), null);
});
