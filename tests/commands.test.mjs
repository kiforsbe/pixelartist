import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandStack, makePixelPatch } from '../js/core/commands.js';
import { createBitmap, setPixel, getPixel, copyRegion } from '../js/core/pixels.js';

test('push executes, undo/redo restore state, flags update', () => {
  let v = 0;
  const s = new CommandStack();
  assert.equal(s.canUndo(), false);
  s.push({ label: 'inc', do: () => v++, undo: () => v-- });
  s.push({ label: 'inc', do: () => v++, undo: () => v-- });
  assert.equal(v, 2);
  s.undo(); assert.equal(v, 1);
  assert.equal(s.canRedo(), true);
  s.redo(); assert.equal(v, 2);
});

test('push clears redo branch; limit drops oldest', () => {
  let v = 0;
  const s = new CommandStack(2);
  const inc = () => ({ label: 'i', do: () => v++, undo: () => v-- });
  s.push(inc()); s.push(inc()); s.push(inc()); // limit 2: first dropped
  s.undo(); s.undo();
  assert.equal(s.canUndo(), false);
  assert.equal(v, 1); // one survives beyond history
  s.push(inc());
  assert.equal(s.canRedo(), false);
});

test('onChange fires on push/undo/redo', () => {
  let n = 0;
  const s = new CommandStack();
  s.onChange = () => n++;
  s.push({ label: 'x', do() {}, undo() {} });
  s.undo(); s.redo();
  assert.equal(n, 3);
});

test('makePixelPatch do/undo blits after/before', () => {
  const bmp = createBitmap(4, 4);
  const before = copyRegion(bmp, 1, 1, 2, 2);
  setPixel(bmp, 1, 1, [9, 9, 9, 255]);
  const after = copyRegion(bmp, 1, 1, 2, 2);
  const cmd = makePixelPatch(bmp, { x: 1, y: 1, w: 2, h: 2 }, before, after, 'paint');
  cmd.undo();
  assert.deepEqual(getPixel(bmp, 1, 1), [0, 0, 0, 0]);
  cmd.do();
  assert.deepEqual(getPixel(bmp, 1, 1), [9, 9, 9, 255]);
});
