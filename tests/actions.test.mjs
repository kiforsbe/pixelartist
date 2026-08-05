import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineAction, getAction, runAction, bindAction } from '../js/app/actions.js';
import { emit } from '../js/app/state.js';

test('defineAction fills in defaults; getAction returns them', () => {
  defineAction('t1.plain', { label: 'Plain', run: () => {} });
  const a = getAction('t1.plain');
  assert.equal(a.label, 'Plain');
  assert.equal(a.shortcut, null);
  assert.equal(a.isEnabled(), true);
  assert.equal(a.isChecked, null);
  assert.equal(a.isAvailable(), true);
});

test('runAction calls run() when enabled and available', () => {
  let ran = 0;
  defineAction('t1.run', { label: 'Run', run: () => { ran++; } });
  runAction('t1.run');
  assert.equal(ran, 1);
});

test('runAction is a no-op when isEnabled() is false', () => {
  let ran = 0;
  defineAction('t1.disabled', { label: 'Disabled', run: () => { ran++; }, isEnabled: () => false });
  runAction('t1.disabled');
  assert.equal(ran, 0);
});

test('runAction is a no-op when isAvailable() is false', () => {
  let ran = 0;
  defineAction('t1.unavailable', { label: 'Unavailable', run: () => { ran++; }, isAvailable: () => false });
  runAction('t1.unavailable');
  assert.equal(ran, 0);
});

test('runAction on an unknown id is a silent no-op', () => {
  assert.doesNotThrow(() => runAction('t1.nope'));
});

test('submenu-only actions register as non-running host commands', () => {
  defineAction('t1.submenu', { label: 'More', submenu: [] });
  assert.deepEqual(getAction('t1.submenu').submenu, []);
  assert.doesNotThrow(() => runAction('t1.submenu'));
});

function fakeElement() {
  const listeners = {};
  return {
    disabled: false, hidden: false, checked: false, title: '',
    classList: {
      _set: new Set(),
      toggle(cls, on) { on ? this._set.add(cls) : this._set.delete(cls); },
      contains(cls) { return this._set.has(cls); },
    },
    addEventListener(evt, fn) { (listeners[evt] ??= []).push(fn); },
    click() { for (const fn of listeners.click ?? []) fn(); },
  };
}

test('bindAction wires click to runAction and sets the title', () => {
  let ran = 0;
  defineAction('t2.run', { label: 'Run', shortcut: 'Ctrl+R', run: () => { ran++; } });
  const el = fakeElement();
  bindAction(el, 't2.run');
  assert.equal(el.title, 'Run (Ctrl+R)');
  el.click();
  assert.equal(ran, 1);
});

test('bound elements refresh disabled/hidden on any app event', () => {
  let enabled = false, available = true;
  defineAction('t2.state', { label: 'State', run: () => {}, isEnabled: () => enabled, isAvailable: () => available });
  const el = fakeElement();
  bindAction(el, 't2.state');
  assert.equal(el.disabled, true);
  assert.equal(el.hidden, false);
  enabled = true;
  emit('project');
  assert.equal(el.disabled, false);
  available = false;
  emit('selection');
  assert.equal(el.hidden, true);
});

test('toggle-bound checkbox mirrors isChecked and updates via events', () => {
  let checked = false;
  defineAction('t2.toggle', { label: 'Toggle', run: () => {}, isChecked: () => checked });
  const el = fakeElement();
  bindAction(el, 't2.toggle', { toggle: true });
  assert.equal(el.checked, false);
  checked = true;
  emit('view');
  assert.equal(el.checked, true);
});
