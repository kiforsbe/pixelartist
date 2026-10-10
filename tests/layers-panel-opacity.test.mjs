import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { createProject, createSheet, createMap, sheetLayers } from '../js/core/model.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { tileMode } from '../js/modes/tiles/index.js';
import { mapMode } from '../js/modes/maps/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { mountLayersPanel } from '../js/components/panels/layers-panel.js';

const { Element } = installSpriteContextDom();
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode, tileMode, mapMode]) host.registerMode(mode);
host.start('sprites');
const panel = new Element();
mountLayersPanel(panel);

for (const [mode, kind] of [['sprites', 'sprite'], ['animations', 'sprite'], ['tiles', 'tile'], ['maps', 'map']]) {
  test(`${mode} opacity input/change without pointerdown creates an undoable dirty edit`, async () => {
    const project = createProject('opacity');
    const doc = kind === 'map' ? createMap(project, { name: 'Map' })
      : createSheet(project, { name: 'Sheet', kind, width: 1, height: 1 });
    const layer = kind === 'map' ? doc.layers[0] : sheetLayers(doc)[0];
    host.activateMode(mode);
    host.setProject(project);
    host.history.clear();
    await Promise.resolve();
    const range = () => panel.querySelectorAll('input').find(input => input.type === 'range');
    const input = range();
    assert.ok(input);
    assert.equal(layer.opacity, 1);
    input.value = '50';
    input.fire('input');
    assert.equal(layer.opacity, 0.5, 'input previews opacity immediately');
    input.fire('change');
    assert.equal(host.store.getState().project.dirty, true);
    assert.equal(host.history.canUndo(), true);
    host.history.undo();
    assert.equal(layer.opacity, 1);
    assert.equal(host.history.canUndo(), false, 'one committed edit has one history entry');
    host.history.redo();
    assert.equal(layer.opacity, 0.5);

    const second = range();
    second.value = '25';
    second.fire('input');
    second.fire('change');
    host.history.undo();
    assert.equal(layer.opacity, 0.5, 'subsequent keyboard edits capture a fresh baseline');
    host.history.redo();
    assert.equal(layer.opacity, 0.25);

    const unchanged = range();
    unchanged.value = '25';
    unchanged.fire('input');
    unchanged.fire('change');
    host.history.undo();
    assert.equal(layer.opacity, 0.5, 'unchanged input does not add a history entry');
  });
}

test('the lock button works in the Animations workbench', async () => {
  const project = createProject('lock');
  const sheet = createSheet(project, { name: 'Sheet', kind: 'sprite', width: 1, height: 1 });
  host.activateMode('animations');
  host.setProject(project);
  await Promise.resolve();
  const lock = panel.querySelectorAll('button').find(button => button.title === 'Lock layer');
  assert.equal(lock.hidden, false);
  lock.fire('click');
  assert.equal(sheetLayers(sheet)[0].locked, true);
});

test('the Layers panel is hidden in the Animations workbench', async () => {
  host.activateMode('animations'); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(panel.hidden, true);
  host.activateMode('sprites'); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(panel.hidden, false);
});

test('the hidden Layers panel does not redraw thumbnails while painting in Animations', async () => {
  const project = createProject('thumbs');
  createSheet(project, { name: 'Sheet', kind: 'sprite', width: 4, height: 4 });
  host.activateMode('sprites');
  host.setProject(project);
  await new Promise(resolve => setTimeout(resolve, 0));
  const draws = () => panel.querySelectorAll('canvas').reduce((n, c) => n + c.getContext('2d').drawImages.length, 0);
  let before = draws();
  host.store.notifyPixelsChanged(); await Promise.resolve(); await Promise.resolve();
  assert.ok(draws() > before, 'visible: a pixel change redraws thumbnails');
  host.activateMode('animations'); await new Promise(resolve => setTimeout(resolve, 0));
  before = draws();
  host.store.notifyPixelsChanged(); await Promise.resolve(); await Promise.resolve();
  assert.equal(draws(), before, 'hidden: no thumbnail work');
  host.activateMode('sprites'); await new Promise(resolve => setTimeout(resolve, 0));
});
