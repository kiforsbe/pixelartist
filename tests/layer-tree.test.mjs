import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, sheetLayers, findNode } from '../js/core/model.js';
import { layerTreeRows, buildLayerRow, selectTreeNode, selectedNodeId, addSheetLayer } from '../js/components/panels/layer-tree.js';

installSpriteContextDom();
globalThis.alert = () => {};
const host = new EditorHost(); setEditorHost(host);
for (const mode of [spriteMode, animationsMode]) host.registerMode(mode);
host.start('sprites');

function setup() {
  const project = createProject('Tree');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  host.setProject(project);
  host.history.clear();
  const bottom = sheetLayers(sheet)[0];
  const groupId = host.registries.commands.execute('sprites.addGroup', { modeId: 'sprites' }, { sheetId: sheet.id, targetGroupId: null });
  const innerId = host.registries.commands.execute('sprites.addLayer', { modeId: 'sprites' }, { sheetId: sheet.id, targetGroupId: groupId });
  return { sheet, bottom, group: findNode(sheet.layerTree, groupId), inner: findNode(sheet.layerTree, innerId) };
}

test('layerTreeRows lists the top node first and skips a collapsed folder', () => {
  const { sheet, bottom, group, inner } = setup();
  assert.deepEqual(layerTreeRows(sheet.layerTree).map(r => [r.node.id, r.depth]), [[group.id, 0], [inner.id, 1], [bottom.id, 0]]);
  group.open = false;
  assert.deepEqual(layerTreeRows(sheet.layerTree).map(r => r.node.id), [group.id, bottom.id]);
});

test('a folder selected in one tree is where the next layer is added', () => {
  const { sheet, group } = setup();
  selectTreeNode(sheet, group);
  assert.equal(selectedNodeId(), group.id);
  assert.equal(host.selections.get().layerId ?? null, null);
  const before = group.children.length;
  addSheetLayer();
  assert.equal(group.children.length, before + 1);
});

test('a row visibility button toggles the layer as one undoable step', () => {
  const { bottom } = setup();
  const row = buildLayerRow(bottom, 0, { onChange() {} });
  row.querySelectorAll('button').find(b => b.title === 'Toggle visibility').fire('click');
  assert.equal(bottom.visible, false);
  host.history.undo();
  assert.equal(bottom.visible, true);
});
