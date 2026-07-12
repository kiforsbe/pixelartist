import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceGrid } from '../js/core/slicing.js';

test('slices full grid row-major', () => {
  const r = sliceGrid({ sheetWidth: 32, sheetHeight: 16, cellW: 16, cellH: 16 });
  assert.deepEqual(r, [
    { name: 'frame_0', x: 0, y: 0, w: 16, h: 16 },
    { name: 'frame_1', x: 16, y: 0, w: 16, h: 16 },
  ]);
});

test('margin and spacing respected; partial cells dropped', () => {
  const r = sliceGrid({ sheetWidth: 40, sheetHeight: 20, cellW: 16, cellH: 16,
    marginX: 2, marginY: 2, spacingX: 4, spacingY: 4, namePrefix: 's' });
  assert.deepEqual(r, [
    { name: 's_0', x: 2, y: 2, w: 16, h: 16 },
    { name: 's_1', x: 22, y: 2, w: 16, h: 16 },
  ]);
});

test('rejects nonpositive cells', () => {
  assert.throws(() => sliceGrid({ sheetWidth: 8, sheetHeight: 8, cellW: 0, cellH: 8 }));
});
