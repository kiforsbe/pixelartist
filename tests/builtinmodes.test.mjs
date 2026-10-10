import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { tileMode } from '../js/modes/tiles/index.js';
import { mapMode } from '../js/modes/maps/index.js';
import { animationsMode } from '../js/modes/animations/index.js';

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
  assert.deepEqual(host.registries.previews.list().map(preview => preview.id), [
    'sprites.preview', 'tiles.preview', 'maps.preview',
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

// Locks the registered sprites.* command ids to the exact set contributions.js
// registers, so a typo or rename on either the registration side or a
// dispatch call site (Presenter, panel, dialog) doesn't silently no-op --
// CommandRegistry.execute() only console.warns and returns undefined for an
// unknown id, so nothing else would catch that at runtime.
test('sprites mode registers exactly the expected sprites.* command ids', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode);

  assert.deepEqual(
    host.registries.commands.list().map(command => command.id).filter(id => id.startsWith('sprites.')),
    [
      'sprites.addAnimationFrame', 'sprites.addGroup', 'sprites.addLayer', 'sprites.createFrame',
      'sprites.deleteAnimation', 'sprites.deleteFrame', 'sprites.deleteNode', 'sprites.dragMoveNode',
      'sprites.mergeDown', 'sprites.moveFrames', 'sprites.moveNode', 'sprites.newAnimation',
      'sprites.removeAnimationFrame', 'sprites.renameAnimation', 'sprites.renameNode',
      'sprites.reorderAnimationFrame', 'sprites.resizeFrame', 'sprites.setAnimationBaseDuration',
      'sprites.setAnimationFrameDuration', 'sprites.setAnimationFrameStep', 'sprites.setFrameField', 'sprites.setFramePivot',
      'sprites.setLayerOpacity', 'sprites.sliceGrid', 'sprites.toggleAnimationLoop', 'sprites.toggleLayerLocked', 'sprites.toggleLayerVisible',
    ],
  );
});

test('sprites mode registers the animations.* layout commands for both workbenches', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode);
  assert.deepEqual(
    host.registries.commands.list().map(command => command.id).filter(id => id.startsWith('animations.')),
    [
      'animations.addFrame', 'animations.autoLayout', 'animations.delete', 'animations.deleteFrame',
      'animations.duplicate', 'animations.linkFrame', 'animations.makeManual', 'animations.moveFrame',
      'animations.new', 'animations.reorderAnimations', 'animations.resizeCanvas', 'animations.setPivot',
    ],
  );
  const when = host.registries.commands.get('animations.new').when;
  assert.deepEqual([when({ modeId: 'sprites' }), when({ modeId: 'animations' }), when({ modeId: 'tiles' })], [true, true, false]);
});

test('sprites commands run in the animations workbench too', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode); host.registerMode(animationsMode);
  const ids = host.registries.commands.list({ modeId: 'animations' }).map(c => c.id);
  for (const id of ['sprites.renameAnimation', 'sprites.toggleLayerLocked', 'animations.addFrame']) assert.ok(ids.includes(id), id);
  assert.deepEqual(host.registries.modes.list().map(m => m.id), ['sprites', 'animations']);
});

test('the animations mode contributes its canvas, panels and preview', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode); host.registerMode(animationsMode);
  assert.deepEqual(host.registries.panels.list({ modeId: 'animations' }).map(panel => panel.id), ['animations.timeline', 'animations.list']);
  assert.deepEqual(host.registries.previews.list({ modeId: 'animations' }).map(preview => preview.id), ['animations.preview']);
  assert.deepEqual(host.registries.views.list().map(view => view.id).filter(id => id.startsWith('animations.')), ['animations.canvas']);
});
