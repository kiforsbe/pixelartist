import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { createProject, createSheet, createMap, sheetLayers } from '../js/core/model.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { tileMode } from '../js/modes/tiles/index.js';
import { mapMode } from '../js/modes/maps/index.js';
import { mountLayersPanel } from '../js/components/panels/layers-panel.js';

const { Element } = installSpriteContextDom();
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, tileMode, mapMode]) host.registerMode(mode);
host.start('sprites');
const panel = new Element();
mountLayersPanel(panel);

for (const [mode, kind] of [['sprites', 'sprite'], ['tiles', 'tile'], ['maps', 'map']]) {
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
