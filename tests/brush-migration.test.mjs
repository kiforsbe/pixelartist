import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorState, migrateDrawingSettings } from '../js/host/editor-store.js';

test('a stored brushSize migrates to a square brush of that size', () => {
  const d = migrateDrawingSettings({ brushSize: 5 });
  assert.equal(d.brush.mask.kind, 'square');
  assert.equal(d.brush.mask.size, 5);
  assert.equal(d.brush.ink.kind, 'solid');
  assert.equal(d.brushSize, undefined, 'the legacy field is gone');
});

test('fresh state gets the default single-pixel brush', () => {
  const s = createEditorState();
  assert.equal(s.workspace.drawing.brush.mask.size, 1);
  assert.equal(s.workspace.drawing.brush.ink.kind, 'solid');
});

test('an already-migrated brush is preserved', () => {
  const brush = { mask: { kind: 'circle', size: 7 }, ink: { kind: 'dither' } };
  assert.equal(migrateDrawingSettings({ brush }).brush.mask.kind, 'circle');
  assert.equal(migrateDrawingSettings({ brush }).brush.ink.kind, 'dither');
});

test('mask size accepts the widened 1..16 range', () => {
  assert.equal(migrateDrawingSettings({ brushSize: 16 }).brush.mask.size, 16);
  assert.equal(migrateDrawingSettings({ brushSize: 99 }).brush.mask.size, 16);
});

test('primary and secondary colors survive migration', () => {
  const d = migrateDrawingSettings({ brushSize: 2, primary: [1, 2, 3, 255] });
  assert.deepEqual(d.primary, [1, 2, 3, 255]);
  assert.deepEqual(d.secondary, [255, 255, 255, 255]);
});
