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

for (const persisted of [null, '"old"']) {
  test(`BrowserPreferences returns the newest quota-failed write over ${persisted ?? 'missing storage'}`, () => {
    const backing = storage();
    if (persisted !== null) backing.data.set('test.layout', persisted);
    backing.setItem = () => { throw new Error('QuotaExceededError'); };
    const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });

    preferences.set('layout', 'first');
    assert.equal(preferences.get('layout', 'missing'), 'first');
    preferences.set('layout', 'newest');
    assert.equal(preferences.get('layout', 'missing'), 'newest');
  });
}

test('BrowserPreferences successful writes supersede a failed-write fallback', () => {
  const backing = storage();
  const persist = backing.setItem;
  backing.setItem = () => { throw new Error('QuotaExceededError'); };
  const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });
  preferences.set('layout', 'temporary');
  assert.equal(preferences.get('layout'), 'temporary');

  backing.setItem = persist;
  preferences.set('layout', 'persisted');
  assert.equal(preferences.get('layout'), 'persisted');
  const reloaded = new BrowserPreferences({ namespace: 'test', storage: backing });
  assert.equal(reloaded.get('layout'), 'persisted');
  backing.getItem = () => { throw new Error('SecurityError'); };
  assert.notEqual(preferences.get('layout'), 'temporary');
});

test('BrowserPreferences failed removes hide stale storage until a subsequent write', () => {
  const backing = storage();
  backing.data.set('test.layout', '"old"');
  backing.removeItem = () => { throw new Error('SecurityError'); };
  const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });

  preferences.remove('layout');
  assert.equal(preferences.get('layout', 'missing'), 'missing');
  preferences.remove('layout');
  assert.equal(preferences.get('layout', 'missing'), 'missing');
  preferences.set('layout', 'new');
  assert.equal(preferences.get('layout'), 'new');
});

test('BrowserPreferences failed removes supersede a failed write and allow another failed write', () => {
  const backing = storage();
  backing.data.set('test.layout', '"old"');
  backing.setItem = () => { throw new Error('QuotaExceededError'); };
  backing.removeItem = () => { throw new Error('SecurityError'); };
  const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });

  preferences.set('layout', 'temporary');
  preferences.remove('layout');
  assert.equal(preferences.get('layout', 'missing'), 'missing');
  preferences.set('layout', 'newest');
  assert.equal(preferences.get('layout'), 'newest');
});

test('BrowserPreferences successful remove clears failed-write and failed-remove fallbacks', () => {
  for (const operation of ['set', 'remove']) {
    const backing = storage();
    backing.data.set('test.layout', '"old"');
    const remove = backing.removeItem;
    backing.setItem = backing.removeItem = () => { throw new Error('SecurityError'); };
    const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });
    preferences[operation]('layout', 'temporary');

    backing.removeItem = remove;
    preferences.remove('layout');
    assert.equal(preferences.get('layout', 'missing'), 'missing');
    assert.equal(new BrowserPreferences({ namespace: 'test', storage: backing }).get('layout', 'missing'), 'missing');
  }
});

test('BrowserPreferences set/get/remove round-trip when storage is entirely unavailable', () => {
  const backing = storage();
  backing.getItem = backing.setItem = backing.removeItem = () => { throw new Error('SecurityError'); };
  const preferences = new BrowserPreferences({ namespace: 'test', storage: backing });

  preferences.set('layout', { collapsed: false });
  assert.deepEqual(preferences.get('layout'), { collapsed: false });
  preferences.remove('layout');
  assert.equal(preferences.get('layout', 'missing'), 'missing');
});
