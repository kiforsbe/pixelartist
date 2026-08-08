import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { addMapLayer, deleteMapLayer } from '../js/modes/maps/application/commands/map-layer-commands.js';

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
  state.commands = new CommandStack(); state.dirty = false;

  const layerId = addMapLayer(services, 'map1', 'sprite');
  const map = project.maps[0];
  assert.equal(map.layers.length, 2);
  assert.equal(map.layers[1].id, layerId);
  assert.equal(map.layers[1].type, 'sprite');
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);
});

test('deleteMapLayer removes a layer and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;
  const layerId = addMapLayer(services, 'map1', 'sprite');

  deleteMapLayer(services, 'map1', layerId);
  assert.equal(project.maps[0].layers.length, 1);

  services.history.undo();
  assert.equal(project.maps[0].layers.length, 2);
  assert.equal(project.maps[0].layers[1].id, layerId);
});
