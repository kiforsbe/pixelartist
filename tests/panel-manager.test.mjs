import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelManager } from '../js/host/workbench/panel-manager.js';
import { PanelRegistry } from '../js/host/contributions/panels.js';
import { ContextKeys } from '../js/host/context-keys.js';

// Minimal DOM boundary: the real manager owns mounting and visibility.
class Element {
  hidden = false;
  children = [];
  dataset = {};
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}

function setup(t, preferences = null) {
  const mounts = new Map(['shared', 'tile-only', 'direct'].map(id => [id, new Element()]));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { createElement: () => new Element(), getElementById: id => mounts.get(id) };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  const registry = new PanelRegistry();
  const contextKeys = new ContextKeys({ modeId: 'sprites' });
  const manager = new PanelManager({ registry, contextKeys, preferences });
  manager.setRegions({ right: new Element() });
  t.after(() => manager.dispose());
  const register = (id, mode, mountPoint, options = {}) => registry.register({
    id, region: 'right', mountPoint, persistent: true,
    when: keys => keys.modeId === mode,
    create: body => { body.appendChild(new Element()); }, ...options,
  });
  const activate = modeId => { contextKeys.set('modeId', modeId); manager.reconcile({}); };
  return { mounts, register, activate };
}

test('inactive panel mount points are hidden before their first mount', t => {
  const { mounts, register, activate } = setup(t);
  register('tiles.layers', 'tiles', 'tile-only');
  activate('sprites');
  assert.equal(mounts.get('tile-only').hidden, true);
  assert.equal(mounts.get('tile-only').children.length, 0);
  activate('tiles');
  assert.equal(mounts.get('tile-only').hidden, false);
  assert.equal(mounts.get('tile-only').children.length, 1);
});

test('persistent panels hide their entire mount point and retain content on reactivation', t => {
  const { mounts, register, activate } = setup(t);
  register('tiles.layers', 'tiles', 'tile-only');
  activate('tiles');
  const content = mounts.get('tile-only').children[0];
  content.children[0].textContent = 'Ground';
  activate('sprites');
  assert.equal(mounts.get('tile-only').hidden, true);
  activate('tiles');
  assert.equal(mounts.get('tile-only').hidden, false);
  assert.equal(mounts.get('tile-only').children.length, 1);
  assert.equal(mounts.get('tile-only').children[0].children[0].textContent, 'Ground');
});

test('a shared mount point stays visible while any of its mode panels is active', t => {
  const { mounts, register, activate } = setup(t);
  register('sprites.frames', 'sprites', 'shared');
  register('tiles.tiles', 'tiles', 'shared');
  activate('sprites');
  const sprites = mounts.get('shared').children[0];
  activate('tiles');
  assert.equal(mounts.get('shared').hidden, false);
  assert.equal(sprites.hidden, true);
  assert.equal(mounts.get('shared').children[1].hidden, false);
  activate('maps');
  assert.equal(mounts.get('shared').hidden, true);
  activate('sprites');
  assert.equal(mounts.get('shared').hidden, false);
  assert.equal(sprites.hidden, false);
});

test('direct mount points unhide on first activation and preference-hidden panels leave no empty container', t => {
  const { mounts, register, activate } = setup(t, {
    get: key => ({ hidden: key === 'workspace.panels.tiles.layers' }),
  });
  register('sprites.timeline', 'sprites', 'direct', { useMountPointDirect: true });
  register('tiles.layers', 'tiles', 'tile-only');
  activate('tiles');
  assert.equal(mounts.get('direct').hidden, true);
  assert.equal(mounts.get('tile-only').hidden, true);
  activate('sprites');
  assert.equal(mounts.get('direct').hidden, false);
  assert.equal(mounts.get('direct').children.length, 1);
});
