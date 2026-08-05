import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRegistry } from '../js/host/contributions/commands.js';
import { PanelRegistry } from '../js/host/contributions/panels.js';
import { ContextKeys } from '../js/host/context-keys.js';
import { DisposableStore } from '../js/host/disposable.js';

test('contribution registries reject duplicates and remove an owner as a unit', () => {
  const commands = new CommandRegistry();
  commands.register({ id: 'demo.run', execute() {} }, { owner: 'demo' });
  assert.throws(() => commands.register({ id: 'demo.run', execute() {} }), /Duplicate/);
  commands.register({ id: 'demo.other', execute() {} }, { owner: 'demo' });
  commands.removeOwner('demo');
  assert.deepEqual(commands.list(), []);
});

test('command predicates gate invocation and receive context', () => {
  const commands = new CommandRegistry();
  let value = 0;
  commands.register({
    id: 'demo.run', when: context => context.modeId === 'demo',
    isEnabled: context => context.ready, execute: (_context, amount) => { value += amount; },
  });
  commands.execute('demo.run', { modeId: 'other', ready: true }, 2);
  commands.execute('demo.run', { modeId: 'demo', ready: false }, 2);
  commands.execute('demo.run', { modeId: 'demo', ready: true }, 3);
  assert.equal(value, 3);
});

test('panel registry validates fixed workbench regions', () => {
  const panels = new PanelRegistry();
  assert.throws(() => panels.register({ id: 'bad', region: 'center', create() {} }), /invalid region/);
  panels.register({ id: 'good', region: 'right', create() {} });
  assert.equal(panels.get('good').region, 'right');
});

test('ContextKeys publishes changed keys and supports predicates', () => {
  const keys = new ContextKeys({ modeId: 'sprites' });
  const seen = [];
  keys.subscribe((snapshot, changed) => seen.push([snapshot.modeId, [...changed]]));
  keys.set('modeId', 'maps');
  assert.deepEqual(seen, [['maps', ['modeId']]]);
  assert.equal(keys.matches(context => context.modeId === 'maps'), true);
});

test('DisposableStore disposes in reverse ownership order exactly once', () => {
  const store = new DisposableStore();
  const calls = [];
  store.add(() => calls.push('first'));
  store.add(() => calls.push('second'));
  store.dispose();
  store.dispose();
  assert.deepEqual(calls, ['second', 'first']);
});
