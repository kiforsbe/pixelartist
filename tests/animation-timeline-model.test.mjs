import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineColumns, tagSpans, selectedColumn, celFilled, entryDurationLabel, directionGlyph, columnInRange, edgeDragPlan } from '../js/modes/animations/application/timeline-model.js';

const sheet = {
  animations: [
    { id: 'run', name: 'Run', frames: [{ frameId: 'a' }, { frameId: 'b' }, { frameId: 'a' }] },
    { id: 'none', name: 'Empty', frames: [] },
    { id: 'idle', name: 'Idle', frames: [{ frameId: 'c' }] },
  ],
};

test('columns run animation after animation and mark repeated frames as linked', () => {
  assert.deepEqual(timelineColumns(sheet), [
    { animationId: 'run', index: 0, frameId: 'a', linked: false },
    { animationId: 'run', index: 1, frameId: 'b', linked: false },
    { animationId: 'run', index: 2, frameId: 'a', linked: true },
    { animationId: 'idle', index: 0, frameId: 'c', linked: false },
  ]);
});

test('tags span their animation and skip empty ones', () => {
  assert.deepEqual(tagSpans(sheet), [
    { animationId: 'run', name: 'Run', start: 0, length: 3 },
    { animationId: 'idle', name: 'Idle', start: 3, length: 1 },
  ]);
});

test('selectedColumn uses entryIndex when it still holds the selected frame', () => {
  assert.equal(selectedColumn(timelineColumns(sheet), { animationId: 'run', frameId: 'a', entryIndex: 2 }), 2);
});

test('selectedColumn falls back to frameId when entryIndex is stale', () => {
  assert.equal(selectedColumn(timelineColumns(sheet), { animationId: 'run', frameId: 'b', entryIndex: 2 }), 1);
  assert.equal(selectedColumn(timelineColumns(sheet), { animationId: 'idle', frameId: 'zzz' }), -1);
});

test('no sheet means no columns or tags', () => {
  assert.deepEqual(timelineColumns(null), []);
  assert.deepEqual(tagSpans(null), []);
});

test('celFilled reads the layer bitmap inside the frame rect', () => {
  const layer = { bitmap: { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) } };
  layer.bitmap.data[(0 * 4 + 3) * 4 + 3] = 255; // pixel (3,0)
  const sheet = { frames: [{ id: 'l', x: 0, y: 0, w: 2, h: 2 }, { id: 'r', x: 2, y: 0, w: 2, h: 2 }] };
  assert.equal(celFilled(sheet, layer, 'l'), false);
  assert.equal(celFilled(sheet, layer, 'r'), true);
  assert.equal(celFilled(sheet, layer, 'nope'), false);
});

test('entryDurationLabel shows ms, or the held step of an fps-based animation', () => {
  assert.equal(entryDurationLabel({ baseDuration: 100 }, { duration: null }), '100ms');
  assert.equal(entryDurationLabel({ baseDuration: 100 }, { duration: 250 }), '250ms');
  assert.equal(entryDurationLabel({ baseFps: 10, baseStep: 1 }, { step: 2 }), '×2');
  assert.equal(entryDurationLabel({ baseFps: 10, baseStep: 3 }, {}), '×3');
});

test('directionGlyph names each playback direction, forward by default', () => {
  assert.equal(directionGlyph('forward'), '→');
  assert.equal(directionGlyph('reverse'), '←');
  assert.equal(directionGlyph('pingpong'), '⇄');
  assert.equal(directionGlyph('pingpong-reverse'), '⇆');
  assert.equal(directionGlyph(undefined), '→');
});

test('columnInRange matches the range animation and its inclusive entries', () => {
  const range = { animationId: 'run', from: 1, to: 2 };
  assert.equal(columnInRange({ animationId: 'run', index: 1 }, range), true);
  assert.equal(columnInRange({ animationId: 'run', index: 2 }, range), true);
  assert.equal(columnInRange({ animationId: 'run', index: 0 }, range), false);
  assert.equal(columnInRange({ animationId: 'idle', index: 1 }, range), false);
  assert.equal(columnInRange({ animationId: 'run', index: 1 }, null), false);
});
test('dragging a tag end out adds frames there; in, cuts them, never below one frame', () => {
  assert.deepEqual(edgeDragPlan(4, 'end', 2), { op: 'add', at: 4, count: 2 });
  assert.deepEqual(edgeDragPlan(4, 'end', -2), { op: 'cut', from: 2, to: 3 });
  assert.deepEqual(edgeDragPlan(4, 'end', -9), { op: 'cut', from: 1, to: 3 });
  assert.deepEqual(edgeDragPlan(4, 'start', -3), { op: 'add', at: 0, count: 3 });
  assert.deepEqual(edgeDragPlan(4, 'start', 1), { op: 'cut', from: 0, to: 0 });
  assert.deepEqual(edgeDragPlan(4, 'start', 9), { op: 'cut', from: 0, to: 2 });
  assert.equal(edgeDragPlan(4, 'end', 0), null);
  assert.equal(edgeDragPlan(1, 'end', -1), null, 'a single frame cannot be cut');
});
