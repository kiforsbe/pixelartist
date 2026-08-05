import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { tileMode } from '../js/modes/tiles/index.js';
import { mapMode } from '../js/modes/maps/index.js';

test('built-in modes provide documents, tools, panels, and views through registries', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode);
  host.registerMode(tileMode);
  host.registerMode(mapMode);

  assert.deepEqual(host.registries.modes.list().map(mode => mode.id), ['sprites', 'tiles', 'maps']);
  assert.deepEqual(host.registries.tools.list().map(tool => tool.id), [
    'sprites.frame-tools', 'tiles.edit-tools', 'maps.placement-tools',
  ]);
  assert.deepEqual(host.registries.panels.list().map(panel => panel.id), [
    'sprites.frames', 'sprites.timeline', 'sprites.animations',
    'tiles.tiles', 'tiles.autotiles', 'tiles.layers', 'maps.properties', 'maps.assets',
  ]);
  assert.deepEqual(host.registries.views.list().map(view => view.id), [
    'sprites.sheet', 'sprites.frame', 'tiles.sheet', 'tiles.tile', 'maps.canvas',
  ]);

  assert.deepEqual(host.registries.panels.list({ modeId: 'sprites' }).map(panel => panel.id), [
    'sprites.frames', 'sprites.timeline', 'sprites.animations',
  ]);
  assert.deepEqual(host.registries.panels.list({ modeId: 'tiles' }).map(panel => panel.id), [
    'tiles.tiles', 'tiles.autotiles', 'tiles.layers',
  ]);
  assert.deepEqual(host.registries.panels.list({ modeId: 'maps' }).map(panel => panel.id), [
    'maps.properties', 'maps.assets',
  ]);
});
