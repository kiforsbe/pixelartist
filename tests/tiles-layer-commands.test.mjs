// tests/tiles-layer-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { createBitmap } from '../js/core/pixels.js';
import {
  toggleLayerVisible, addLayer, addGroup, deleteNode, mergeLayerDownCmd,
  moveNode, dragMoveNode, renameNode, setLayerOpacity,
} from '../js/modes/tiles/application/commands/layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makeLayer(overrides = {}) {
  return { id: 'l0', type: 'layer', name: 'Layer 1', visible: true, opacity: 1, bitmap: createBitmap(4, 4), ...overrides };
}

function makeGroup(overrides = {}) {
  return { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [], ...overrides };
}

function makeSheet(overrides = {}) {
  return {
    id: 'sheet1', width: 4, height: 4, kind: 'tile',
    layerTree: makeGroup({ children: [makeLayer()] }),
    animations: [],
    ...overrides,
  };
}

function makeProject(sheet) { return { sheets: [sheet], maps: [], palettes: [] }; }

test('toggleLayerVisible flips visibility and undoes', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  toggleLayerVisible(services, 'sheet1', 'l0');
  assert.equal(sheet.layerTree.children[0].visible, false);
  assert.equal(services.projects.dirty, true);

  services.history.undo();
  assert.equal(sheet.layerTree.children[0].visible, true);

  services.history.redo();
  assert.equal(sheet.layerTree.children[0].visible, false);
});

test('addLayer pushes a new layer into the target group, and undo removes it / redo restores the same id', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  const id = addLayer(services, 'sheet1', null);
  assert.equal(sheet.layerTree.children.length, 2);
  assert.equal(sheet.layerTree.children[1].id, id);
  assert.equal(sheet.layerTree.children[1].name, 'Layer 2');

  services.history.undo();
  assert.equal(sheet.layerTree.children.length, 1);

  services.history.redo();
  assert.equal(sheet.layerTree.children.length, 2);
  assert.equal(sheet.layerTree.children[1].id, id);
});

test('addLayer targets a specific group when given its id', () => {
  const inner = makeGroup({ id: 'g1', name: 'Inner', children: [] });
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer(), inner] }) });
  const services = makeServices(makeProject(sheet));

  addLayer(services, 'sheet1', 'g1');
  const group = sheet.layerTree.children.find(c => c.id === 'g1');
  assert.equal(group.children.length, 1);
  assert.equal(sheet.layerTree.children.length, 2); // root itself unchanged
});

test('addGroup pushes a new group and undo removes it', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  const id = addGroup(services, 'sheet1', null);
  assert.equal(sheet.layerTree.children.length, 2);
  assert.equal(sheet.layerTree.children[1].id, id);
  assert.equal(sheet.layerTree.children[1].type, 'group');

  services.history.undo();
  assert.equal(sheet.layerTree.children.length, 1);
});

test('deleteNode removes a layer and undo restores it at the same index', () => {
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'a' }), makeLayer({ id: 'b' }), makeLayer({ id: 'c' })] }) });
  const services = makeServices(makeProject(sheet));

  deleteNode(services, 'sheet1', 'b');
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'c']);

  services.history.undo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'b', 'c']);
});

test('deleteNode removes a non-animation group and undo restores it', () => {
  const g = makeGroup({ id: 'g1', name: 'G', children: [makeLayer({ id: 'inner' })] });
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'a' }), g] }) });
  const services = makeServices(makeProject(sheet));

  deleteNode(services, 'sheet1', 'g1');
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a']);

  services.history.undo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'g1']);
  assert.equal(sheet.layerTree.children[1].children[0].id, 'inner');
});

test('deleteNode refuses to delete the last layer in a group', () => {
  const sheet = makeSheet(); // single layer 'l0'
  const services = makeServices(makeProject(sheet));

  deleteNode(services, 'sheet1', 'l0');
  assert.equal(sheet.layerTree.children.length, 1);
  assert.equal(services.history.canUndo(), false);
});

test('deleteNode refuses to delete an animation-owned group (out of scope; handled by sprites.deleteAnimation elsewhere)', () => {
  const animGroup = makeGroup({ id: 'anim-g', animationId: 'anim1', children: [makeLayer({ id: 'af1' })] });
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'a' }), animGroup] }) });
  const services = makeServices(makeProject(sheet));

  deleteNode(services, 'sheet1', 'anim-g');
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'anim-g']);
  assert.equal(services.history.canUndo(), false);
});

test('mergeLayerDownCmd composites into the layer below and undo restores its bitmap byte-for-byte', () => {
  const bottom = makeLayer({ id: 'bottom' });
  const top = makeLayer({ id: 'top' });
  // Fill top with a distinct opaque color so the merge visibly changes bottom's bitmap.
  for (let i = 0; i < top.bitmap.data.length; i += 4) {
    top.bitmap.data[i] = 200; top.bitmap.data[i + 1] = 10; top.bitmap.data[i + 2] = 10; top.bitmap.data[i + 3] = 255;
  }
  const bottomBefore = Uint8ClampedArray.from(bottom.bitmap.data);
  const sheet = makeSheet({ layerTree: makeGroup({ children: [bottom, top] }) });
  const services = makeServices(makeProject(sheet));

  const destId = mergeLayerDownCmd(services, 'sheet1', 'top');
  assert.equal(destId, 'bottom');
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['bottom']);
  assert.equal(bottom.bitmap.data[0], 200);

  services.history.undo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['bottom', 'top']);
  assert.deepEqual(Array.from(bottom.bitmap.data), Array.from(bottomBefore));

  services.history.redo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['bottom']);
  assert.equal(bottom.bitmap.data[0], 200);
});

test('mergeLayerDownCmd refuses to merge the bottom layer, and refuses to merge into a group', () => {
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'only' })] }) });
  const services = makeServices(makeProject(sheet));
  assert.equal(mergeLayerDownCmd(services, 'sheet1', 'only'), null);

  const groupBelow = makeGroup({ id: 'g', children: [] });
  const sheet2 = makeSheet({ layerTree: makeGroup({ children: [groupBelow, makeLayer({ id: 'top2' })] }) });
  const services2 = makeServices(makeProject(sheet2));
  assert.equal(mergeLayerDownCmd(services2, 'sheet1', 'top2'), null);
});

test('moveNode reorders within the parent and undo restores original order', () => {
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'a' }), makeLayer({ id: 'b' }), makeLayer({ id: 'c' })] }) });
  const services = makeServices(makeProject(sheet));

  // moveNode(node, delta) delegates to model.js's moveNode(sheet, id, parentId,
  // newIndex), which subtracts 1 from the target index when reordering
  // forward within the same parent -- so delta=-1 on the LAST child is the
  // single-step case that actually produces a visible swap.
  moveNode(services, 'sheet1', 'c', -1);
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'c', 'b']);

  services.history.undo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'b', 'c']);
});

test('dragMoveNode moves a node across parents and undo restores both sides', () => {
  const g1 = makeGroup({ id: 'g1', children: [makeLayer({ id: 'x' }), makeLayer({ id: 'y' })] });
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'a' }), g1] }) });
  const services = makeServices(makeProject(sheet));

  // Move 'x' out of g1 into root, at index 0.
  dragMoveNode(services, 'sheet1', 'x', null, 0);
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['x', 'a', 'g1']);
  assert.deepEqual(g1.children.map(c => c.id), ['y']);

  services.history.undo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['a', 'g1']);
  assert.deepEqual(g1.children.map(c => c.id), ['x', 'y']);

  services.history.redo();
  assert.deepEqual(sheet.layerTree.children.map(c => c.id), ['x', 'a', 'g1']);
  assert.deepEqual(g1.children.map(c => c.id), ['y']);
});

test('dragMoveNode is a no-op (no history entry) when the drop location does not change anything', () => {
  const sheet = makeSheet({ layerTree: makeGroup({ children: [makeLayer({ id: 'a' }), makeLayer({ id: 'b' })] }) });
  const services = makeServices(makeProject(sheet));

  dragMoveNode(services, 'sheet1', 'a', null, 0); // already at index 0 in root
  assert.equal(services.history.canUndo(), false);
});

test('renameNode renames a plain layer and undoes', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  renameNode(services, 'sheet1', 'l0', 'Background');
  assert.equal(sheet.layerTree.children[0].name, 'Background');

  services.history.undo();
  assert.equal(sheet.layerTree.children[0].name, 'Layer 1');
});

test('renameNode syncs the matching animations entry name for an animation-owned group, and undoes', () => {
  const animGroup = makeGroup({ id: 'anim-g', name: 'Walk', animationId: 'anim1', children: [] });
  const sheet = makeSheet({
    layerTree: makeGroup({ children: [makeLayer(), animGroup] }),
    animations: [{ id: 'anim1', name: 'Walk' }],
  });
  const services = makeServices(makeProject(sheet));

  renameNode(services, 'sheet1', 'anim-g', 'Run');
  assert.equal(animGroup.name, 'Run');
  assert.equal(sheet.animations[0].name, 'Run');

  services.history.undo();
  assert.equal(animGroup.name, 'Walk');
  assert.equal(sheet.animations[0].name, 'Walk');
});

test('renameNode is a no-op when the name is unchanged', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  renameNode(services, 'sheet1', 'l0', 'Layer 1');
  assert.equal(services.history.canUndo(), false);
});

test('setLayerOpacity sets opacity, undoes, and is a no-op when unchanged', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  setLayerOpacity(services, 'sheet1', 'l0', 0.5);
  assert.equal(sheet.layerTree.children[0].opacity, 0.5);

  services.history.undo();
  assert.equal(sheet.layerTree.children[0].opacity, 1);

  setLayerOpacity(services, 'sheet1', 'l0', 1);
  assert.equal(services.history.canUndo(), false);
});
