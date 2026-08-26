import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { addMapLayer, deleteMapLayer, setMapLayerOpacity } from '../js/modes/maps/application/commands/map-layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
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
