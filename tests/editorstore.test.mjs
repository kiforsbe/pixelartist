import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore, documentKey } from '../js/host/editor-store.js';
import { DEFAULT_BRUSH, normalizeBrush } from '../js/core/brushes.js';

test('EditorStore batches selector notifications at transaction boundaries', () => {
  const store = new EditorStore();
  const seen = [];
  store.subscribe(state => state.session.activeModeId, (value, previous, reasons) => {
    seen.push({ value, previous, reasons: [...reasons] });
  });
  store.transaction('mode', state => {
    state.session.activeModeId = 'sprites';
    store.transaction('view', nested => { nested.session.activeViewId = 'sprites.sheet'; });
  });
  assert.deepEqual(seen, [{ value: 'sprites', previous: null, reasons: ['mode', 'view'] }]);
});

test('EditorStore stores selections independently per document', () => {
  const store = new EditorStore();
  const sprite = { kind: 'sprite-sheet', id: 'a' };
  const tile = { kind: 'tile-sheet', id: 'b' };
  store.setSelection(sprite, { frameId: 'f1' });
  store.setSelection(tile, { tileId: 't1' });
  assert.deepEqual(store.getSelection(sprite), { frameId: 'f1' });
  assert.deepEqual(store.getSelection(tile), { tileId: 't1' });
  assert.equal(documentKey(sprite), 'sprite-sheet:a');
});

test('EditorStore subscriptions can be owned by an AbortSignal', () => {
  const store = new EditorStore();
  const controller = new AbortController();
  let calls = 0;
  store.subscribe(state => state.project.dirty, () => { calls++; }, { signal: controller.signal });
  controller.abort();
  store.markDirty();
  assert.equal(calls, 0);
});

test('EditorStore owns reactive drawing settings outside project identity', () => {
  const store = new EditorStore();
  const seen = [];
  store.subscribe(state => state.workspace.drawing, drawing => { seen.push(drawing); });

  const defaultBrush = normalizeBrush({ ...DEFAULT_BRUSH, mask: { kind: 'square', size: 1 } });
  assert.deepEqual(store.getState().workspace.drawing, {
    primary: [0, 0, 0, 255],
    secondary: [255, 255, 255, 255],
    brush: defaultBrush,
  });

  // Patch the brush rather than the retired `brushSize` field. updateDrawingSettings
  // is a raw patch merge (not re-migrated), so this also proves a patch built from
  // the current brush round-trips exactly -- see editor-store.js's migrateDrawingSettings.
  const cur = store.getState().workspace.drawing.brush;
  store.updateDrawingSettings({ primary: [1, 2, 3, 255], brush: { ...cur, mask: { ...cur.mask, size: 4 } } });

  assert.deepEqual(store.getState().workspace.drawing, {
    primary: [1, 2, 3, 255],
    secondary: [255, 255, 255, 255],
    brush: { ...defaultBrush, mask: { ...defaultBrush.mask, size: 4 } },
  });
  assert.equal(seen.length, 1);

  const customized = new EditorStore({ workspace: { drawing: { brushSize: 3 } } });
  assert.deepEqual(customized.getState().workspace.drawing, {
    primary: [0, 0, 0, 255],
    secondary: [255, 255, 255, 255],
    brush: normalizeBrush({ ...DEFAULT_BRUSH, mask: { kind: 'square', size: 3 } }),
  });
});

test('notifyPixelsChanged advances a reactive workspace revision every time', () => {
  const store = new EditorStore();
  const seen = [];
  store.subscribe(state => state.workspace.pixelRevision, revision => { seen.push(revision); });

  store.notifyPixelsChanged();
  store.notifyPixelsChanged();

  assert.equal(store.getState().workspace.pixelRevision, 2);
  assert.deepEqual(seen, [1, 2]);
});
