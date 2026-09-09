import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { addTileLayer, removeTileLayer } from '../js/modes/tiles/application/commands/tile-layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makeProject() {
  return { sheets: [{ id: 'sheet1', tileLayerNames: [], tiles: [] }] };
}

test('addTileLayer appends a layer name and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);

  addTileLayer(services, 'sheet1', 'terrain');
  assert.deepEqual(project.sheets[0].tileLayerNames, ['terrain']);

  services.history.undo();
  assert.deepEqual(project.sheets[0].tileLayerNames, []);

  services.history.redo();
  assert.deepEqual(project.sheets[0].tileLayerNames, ['terrain']);
});

test('removeTileLayer clears the layer name from every tile that used it, and undo restores both', () => {
  const project = makeProject();
  const sheet = project.sheets[0];
  sheet.tileLayerNames = ['terrain', 'decor'];
  sheet.tiles = [{ id: 't1', layer: 'terrain' }, { id: 't2', layer: 'decor' }];
  const services = makeServices(project);

  removeTileLayer(services, 'sheet1', 'terrain');
  assert.deepEqual(sheet.tileLayerNames, ['decor']);
  assert.equal(sheet.tiles[0].layer, undefined);
  assert.equal(sheet.tiles[1].layer, 'decor');

  services.history.undo();
  assert.deepEqual(sheet.tileLayerNames, ['terrain', 'decor']);
  assert.equal(sheet.tiles[0].layer, 'terrain');
  services.history.redo();
  assert.deepEqual(sheet.tileLayerNames, ['decor']);
  assert.equal(sheet.tiles[0].layer, undefined);
  assert.equal(sheet.tiles[1].layer, 'decor');
});

test('removing a tile layer clears terrain-set assignments and restores them on undo', () => {
  const project = makeProject(), sheet = project.sheets[0];
  sheet.tileLayerNames = ['Ground', 'Decor'];
  sheet.terrainSets = [{ id: 'ground', layer: 'Ground' }, { id: 'decor', layer: 'Decor' }, { id: 'empty' }];
  const services = makeServices(project);
  removeTileLayer(services, sheet.id, 'Ground');
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.deepEqual(sheet.tileLayerNames, ['Decor']);
    assert.equal(sheet.terrainSets[0].layer, undefined);
    assert.equal(sheet.terrainSets[1].layer, 'Decor');
    assert.equal(sheet.terrainSets[2].layer, undefined);
    services.history.undo();
    assert.deepEqual(sheet.tileLayerNames, ['Ground', 'Decor']);
    assert.equal(sheet.terrainSets[0].layer, 'Ground');
    services.history.redo();
  }
});
