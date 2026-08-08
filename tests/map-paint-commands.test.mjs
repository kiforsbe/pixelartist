// tests/map-paint-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  paintMapTile, eraseMapTile, paintMapTerrain, paintMapSprite, eraseMapSprite,
  moveMapItem, deleteMapItem,
} from '../js/modes/maps/application/commands/map-paint-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const map = {
    id: 'map1',
    layers: [{ id: 'layer1', type: 'tile', tiles: [], terrain: [] }, { id: 'layer2', type: 'sprite', sprites: [] }],
    bounds: null,
  };
  const sheet = {
    id: 'sheet1', kind: 'tile',
    tiles: [{ id: 'tile1', w: 16, h: 16 }],
    terrainSets: [{ id: 'terrain1', tileW: 16, tileH: 16 }],
    frames: [{ id: 'frame1', w: 16, h: 16 }],
    animations: [],
  };
  return { sheets: [sheet], maps: [map] };
}

test('paintMapTile places a tile and is undoable/redoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapTile(services, 'map1', 'layer1', 'sheet1', 'tile1', { x: 0, y: 0 });
  const layer = project.maps[0].layers[0];
  assert.equal(layer.tiles.length, 1);
  assert.equal(layer.tiles[0].tileId, 'tile1');
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(layer.tiles.length, 0);
  services.history.redo();
  assert.equal(layer.tiles.length, 1);
});

test('eraseMapTile removes the tile at a point and undo restores it', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapTile(services, 'map1', 'layer1', 'sheet1', 'tile1', { x: 0, y: 0 });
  eraseMapTile(services, 'map1', 'layer1', { x: 0, y: 0 });
  const layer = project.maps[0].layers[0];
  assert.equal(layer.tiles.length, 0);

  services.history.undo();
  assert.equal(layer.tiles.length, 1);
});

test('paintMapTerrain adds a terrain entry once per cell', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapTerrain(services, 'map1', 'layer1', 'sheet1', 'terrain1', { x: 0, y: 0 });
  const layer = project.maps[0].layers[0];
  assert.equal(layer.terrain.length, 1);
  assert.equal(layer.terrain[0].terrainSetId, 'terrain1');
});

test('paintMapSprite places a sprite entry and eraseMapSprite removes by id', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;

  paintMapSprite(services, 'map1', 'layer2', 'sheet1', 'frame', 'frame1', { x: 4, y: 4 });
  const layer = project.maps[0].layers[1];
  assert.equal(layer.sprites.length, 1);
  const itemId = layer.sprites[0].id;

  eraseMapSprite(services, 'map1', 'layer2', itemId);
  assert.equal(layer.sprites.length, 0);

  services.history.undo();
  assert.equal(layer.sprites.length, 1);
});

test('moveMapItem repositions an item and undo restores the prior position', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;
  paintMapSprite(services, 'map1', 'layer2', 'sheet1', 'frame', 'frame1', { x: 0, y: 0 });
  const item = project.maps[0].layers[1].sprites[0];

  moveMapItem(services, 'map1', 'layer2', item.id, { x: 0, y: 0 }, { x: 32, y: 16 });
  assert.deepEqual({ x: item.x, y: item.y }, { x: 32, y: 16 });

  services.history.undo();
  assert.deepEqual({ x: item.x, y: item.y }, { x: 0, y: 0 });
});

test('deleteMapItem removes any item kind by id and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  state.commands = new CommandStack(); state.dirty = false;
  paintMapTile(services, 'map1', 'layer1', 'sheet1', 'tile1', { x: 0, y: 0 });
  const item = project.maps[0].layers[0].tiles[0];

  deleteMapItem(services, 'map1', 'layer1', item.id);
  assert.equal(project.maps[0].layers[0].tiles.length, 0);

  services.history.undo();
  assert.equal(project.maps[0].layers[0].tiles.length, 1);
});
