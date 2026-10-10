import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineColumns, tagSpans, selectedColumn, celFilled } from '../js/modes/animations/application/timeline-model.js';

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
