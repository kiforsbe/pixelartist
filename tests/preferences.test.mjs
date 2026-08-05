import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPreferences } from '../js/platform/browser/preferences.js';

function storage() {
  const data = new Map();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
}

test('BrowserPreferences namespaces and round-trips layout values', () => {
  const backing = storage();
  const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });
  preferences.set('workspace.panels.layers', { collapsed: true });
  assert.deepEqual(preferences.get('workspace.panels.layers'), { collapsed: true });
  assert.ok(backing.data.has('test.workspace.panels.layers'));
});

test('BrowserPreferences falls back when persisted JSON is corrupt', () => {
  const backing = storage();
  backing.data.set('test.layout', '{bad json');
  const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });
  assert.deepEqual(preferences.get('layout', { version: 1 }), { version: 1 });
});
