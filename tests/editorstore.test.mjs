import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore, documentKey } from '../js/application/editor-store.js';

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
