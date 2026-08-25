import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { mountStorePanel } from '../js/components/panel-mount.js';

test('mountStorePanel renders once immediately and again per selector change, debounced', async () => {
  const store = new EditorStore();
  let renders = 0;
  const panel = mountStorePanel(store, [state => state.session.activeModeId], () => { renders++; });
  assert.equal(renders, 1);
  store.transaction('mode', state => { state.session.activeModeId = 'sprites'; });
  await Promise.resolve();
  assert.equal(renders, 2);
  panel.dispose();
  store.transaction('mode', state => { state.session.activeModeId = 'tiles'; });
  await Promise.resolve();
  assert.equal(renders, 2);
});

test('mountStorePanel runs a paired handler synchronously before the debounced render', async () => {
  const store = new EditorStore();
  const seen = [];
  mountStorePanel(store, [[state => state.session.activeToolId, () => seen.push('handler')]], () => seen.push('render'));
  store.transaction('tool', state => { state.session.activeToolId = 'pencil'; });
  await Promise.resolve();
  assert.deepEqual(seen, ['render', 'handler', 'render']);
});
