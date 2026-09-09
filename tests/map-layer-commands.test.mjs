import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { addMapLayer, deleteMapLayer, renameMapLayer, setMapLayerOpacity, moveMapLayer } from '../js/modes/maps/application/commands/map-layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makeProject() {
  return { sheets: [], maps: [{ id: 'map1', layers: [{ id: 'l0', type: 'tile', tiles: [], terrain: [] }], bounds: null }] };
}

test('addMapLayer creates a layer of the given type and marks the project dirty', () => {
  const project = makeProject();
  const services = makeServices(project);

  const layerId = addMapLayer(services, 'map1', 'sprite');
  const map = project.maps[0];
  assert.equal(map.layers.length, 2);
  assert.equal(map.layers[1].id, layerId);
  assert.equal(map.layers[1].type, 'sprite');
  assert.equal(services.store.getState().project.dirty, true);
});

test('addMapLayer is undoable, and redo restores the same layer object at the same id', () => {
  const project = makeProject();
  const services = makeServices(project);

  const layerId = addMapLayer(services, 'map1', 'sprite');
  assert.equal(services.history.canUndo(), true);

  services.history.undo();
  assert.equal(project.maps[0].layers.length, 1);

  services.history.redo();
  assert.equal(project.maps[0].layers.length, 2);
  assert.equal(project.maps[0].layers[1].id, layerId);
});

test('deleteMapLayer removes a layer and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  const layerId = addMapLayer(services, 'map1', 'sprite');

  deleteMapLayer(services, 'map1', layerId);
  assert.equal(project.maps[0].layers.length, 1);

  services.history.undo();
  assert.equal(project.maps[0].layers.length, 2);
  assert.equal(project.maps[0].layers[1].id, layerId);
});

test('setMapLayerOpacity sets opacity and is undoable', () => {
  const project = makeProject();
  project.maps[0].layers[0].opacity = 1;
  const services = makeServices(project);

  setMapLayerOpacity(services, 'map1', 'l0', 0.4);
  assert.equal(project.maps[0].layers[0].opacity, 0.4);

  services.history.undo();
  assert.equal(project.maps[0].layers[0].opacity, 1);

  services.history.redo();
  assert.equal(project.maps[0].layers[0].opacity, 0.4);
});

test('setMapLayerOpacity is a no-op when opacity is unchanged or the layer is missing', () => {
  const project = makeProject();
  project.maps[0].layers[0].opacity = 1;
  const services = makeServices(project);

  setMapLayerOpacity(services, 'map1', 'l0', 1);
  assert.equal(services.history.canUndo(), false);

  setMapLayerOpacity(services, 'map1', 'missing', 0.5);
  assert.equal(services.history.canUndo(), false);
});

test('renameMapLayer changes the requested map layer and supports undo and redo', () => {
  const project = makeProject();
  const services = makeServices(project);
  project.maps[0].layers[0].name = 'Ground';

  renameMapLayer(services, 'map1', 'l0', 'Roads');
  assert.equal(project.maps[0].layers[0].name, 'Roads');
  services.history.undo();
  assert.equal(project.maps[0].layers[0].name, 'Ground');
  services.history.redo();
  assert.equal(project.maps[0].layers[0].name, 'Roads');
});

// ---- moveMapLayer ----
// Map-layer reordering used to splice the array straight from the panel, so
// it silently skipped the undo stack: Ctrl+Z afterwards reverted whatever the
// user did BEFORE the reorder instead.
function makeOrderedProject() {
  return { sheets: [], maps: [{ id: 'map1', bounds: null, layers: ['l0', 'l1', 'l2'].map(id => ({ id, type: 'tile', tiles: [], terrain: [] })) }] };
}
const order = project => project.maps[0].layers.map(l => l.id);

test('moveMapLayer reorders the layer and is undoable in both directions', () => {
  const project = makeOrderedProject();
  const services = makeServices(project);

  moveMapLayer(services, 'map1', 'l0', 1);
  assert.deepEqual(order(project), ['l1', 'l0', 'l2']);
  assert.equal(services.store.getState().project.dirty, true);

  services.history.undo();
  assert.deepEqual(order(project), ['l0', 'l1', 'l2']);
  services.history.redo();
  assert.deepEqual(order(project), ['l1', 'l0', 'l2']);

  moveMapLayer(services, 'map1', 'l0', -1);
  assert.deepEqual(order(project), ['l0', 'l1', 'l2']);
});

test('moveMapLayer ignores moves off either end and unknown layers', () => {
  const project = makeOrderedProject();
  const services = makeServices(project);

  moveMapLayer(services, 'map1', 'l0', -1);
  moveMapLayer(services, 'map1', 'l2', 1);
  moveMapLayer(services, 'map1', 'nope', 1);
  assert.deepEqual(order(project), ['l0', 'l1', 'l2']);
  assert.equal(services.history.canUndo(), false, 'a rejected move leaves no history entry');
});
