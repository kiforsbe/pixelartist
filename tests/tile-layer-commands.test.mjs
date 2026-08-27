import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { addTileLayer, removeTileLayer } from '../js/modes/tiles/application/commands/tile-layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  return { sheets: [{ id: 'sheet1', layers: [], tiles: [] }] };
}

test('addTileLayer appends a layer name and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);

  addTileLayer(services, 'sheet1', 'terrain');
  assert.deepEqual(project.sheets[0].layers, ['terrain']);

  services.history.undo();
  assert.deepEqual(project.sheets[0].layers, []);

  services.history.redo();
  assert.deepEqual(project.sheets[0].layers, ['terrain']);
});

test('removeTileLayer clears the layer name from every tile that used it, and undo restores both', () => {
  const project = makeProject();
  const sheet = project.sheets[0];
  sheet.layers = ['terrain', 'decor'];
  sheet.tiles = [{ id: 't1', layer: 'terrain' }, { id: 't2', layer: 'decor' }];
  const services = makeServices(project);

  removeTileLayer(services, 'sheet1', 'terrain');
  assert.deepEqual(sheet.layers, ['decor']);
  assert.equal(sheet.tiles[0].layer, undefined);
  assert.equal(sheet.tiles[1].layer, 'decor');

  services.history.undo();
  assert.deepEqual(sheet.layers, ['terrain', 'decor']);
  assert.equal(sheet.tiles[0].layer, 'terrain');
});
