import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOnionGhosts, hexToRgb, resolveStepColor, traceOutline } from '../js/modes/sprites/application/onion-skin.js';

function baseOnion(overrides = {}) {
  return {
    enabled: true, mask: true, outline: false, currentAlpha: 1,
    back: 2, ahead: 2, backColor: '#ff0000', aheadColor: '#00ff00',
    stepColors: { back: {}, ahead: {} },
    ...overrides,
  };
}

function anim({ loop = true, ids = ['a', 'b', 'c', 'd'] } = {}) {
  return { loop, frames: ids.map(id => ({ frameId: id, duration: 100 })) };
}

test('computeOnionGhosts returns [] when onion is disabled or both modes are off', () => {
  assert.deepEqual(computeOnionGhosts(anim(), 'b', baseOnion({ enabled: false })), []);
  assert.deepEqual(computeOnionGhosts(anim(), 'b', baseOnion({ mask: false, outline: false })), []);
});

test('computeOnionGhosts returns [] when the animation is missing, empty, or lacks the frame', () => {
  assert.deepEqual(computeOnionGhosts(null, 'b', baseOnion()), []);
  assert.deepEqual(computeOnionGhosts(anim({ ids: [] }), 'b', baseOnion()), []);
  assert.deepEqual(computeOnionGhosts(anim(), 'z', baseOnion()), []);
});

test('computeOnionGhosts walks back/ahead by onion.back/onion.ahead steps', () => {
  const ghosts = computeOnionGhosts(anim(), 'b', baseOnion({ back: 1, ahead: 1 }));
  assert.deepEqual(ghosts, [
    { frameId: 'a', k: 1, dir: 'back' },
    { frameId: 'c', k: 1, dir: 'ahead' },
  ]);
});

test('computeOnionGhosts clamps at the ends of a non-looping animation instead of wrapping', () => {
  const ghosts = computeOnionGhosts(anim({ loop: false }), 'a', baseOnion({ back: 2, ahead: 0 }));
  assert.deepEqual(ghosts, []);
});

test('computeOnionGhosts wraps around the ends of a looping animation', () => {
  const ghosts = computeOnionGhosts(anim({ loop: true }), 'a', baseOnion({ back: 1, ahead: 0 }));
  assert.deepEqual(ghosts, [{ frameId: 'd', k: 1, dir: 'back' }]);
});

test('hexToRgb converts a #rrggbb string to an [r,g,b] array', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
});

test('resolveStepColor prefers a per-step override over the direction base color', () => {
  const onion = baseOnion({ stepColors: { back: { 1: '#0000ff' }, ahead: {} } });
  assert.deepEqual(resolveStepColor(onion, 'back', 1), [0, 0, 255]);
  assert.deepEqual(resolveStepColor(onion, 'back', 2), hexToRgb('#ff0000'));
  assert.deepEqual(resolveStepColor(onion, 'ahead', 1), hexToRgb('#00ff00'));
});

test('traceOutline traces only opaque pixels with at least one transparent neighbor', () => {
  // 3x3 fully-opaque block: every pixel is on the border except the center.
  const w = 3, h = 3;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  const region = { width: w, height: h, data };
  const traced = traceOutline(region, [10, 20, 30]);
  assert.equal(traced.width, 3);
  assert.equal(traced.height, 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x === 1 && y === 1) {
        assert.equal(traced.data[i + 3], 0, `center pixel (${x},${y}) should be untouched`);
      } else {
        assert.deepEqual(
          [traced.data[i], traced.data[i + 1], traced.data[i + 2], traced.data[i + 3]],
          [10, 20, 30, 255],
        );
      }
    }
  }
});

test('traceOutline leaves fully transparent regions untouched', () => {
  const region = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
  const traced = traceOutline(region, [10, 20, 30]);
  assert.ok(traced.data.every(v => v === 0));
});
