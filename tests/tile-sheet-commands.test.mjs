import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { createBitmap } from '../js/core/pixels.js';
import {
  swapTiles, moveTile, moveStandaloneTile, resizeTile, createTile, deleteTile,
  moveGrid, growTileIntoGrid, resizeGridAxis, addGrid, deleteGrid, setGridCellField,
  detachTile, setTileLayer, renameTile, setTileTags, setTileSize,
} from '../js/modes/tiles/application/commands/tile-sheet-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeTile(overrides = {}) {
  return { id: overrides.id ?? 't1', x: 0, y: 0, w: 8, h: 8, gridId: null, ...overrides };
}

function makeSheet(overrides = {}) {
  return {
    id: 'sheet1', width: 32, height: 32,
    layerTree: { type: 'group', id: 'root', children: [{ type: 'layer', id: 'l0', bitmap: createBitmap(32, 32), visible: true, opacity: 1 }] },
    tiles: [], tileGrids: [], terrainSets: [], layers: [],
    ...overrides,
  };
}

function makeProject(sheet) { return { sheets: [sheet] }; }

function resetLegacy() {
  state.commands = new CommandStack();
  state.dirty = false;
  state.selectedTileId = null;
  state.selectedTerrainSetId = null;
}

test('swapTiles swaps pixels and names between two same-size tiles, and undoes', () => {
  resetLegacy();
  const a = makeTile({ id: 'a', x: 0, y: 0, w: 8, h: 8, name: 'grass' });
  const b = makeTile({ id: 'b', x: 8, y: 0, w: 8, h: 8, name: 'water' });
  const sheet = makeSheet({ tiles: [a, b] });
  const layer = sheet.layerTree.children[0];
  layer.bitmap.data.fill(1, 0, 8 * 4);
  const services = makeServices(makeProject(sheet));

  swapTiles(services, 'sheet1', 'a', 'b');
  assert.equal(a.name, 'water');
  assert.equal(b.name, 'grass');
  assert.equal(layer.bitmap.data[0], 0);

  services.history.undo();
  assert.equal(a.name, 'grass');
  assert.equal(b.name, 'water');
  assert.equal(layer.bitmap.data[0], 1);
});

test('moveTile clears the source tile and moves name/pixels to the target, and undoes', () => {
  resetLegacy();
  const a = makeTile({ id: 'a', x: 0, y: 0, w: 8, h: 8, name: 'grass' });
  const b = makeTile({ id: 'b', x: 8, y: 0, w: 8, h: 8, name: undefined });
  const sheet = makeSheet({ tiles: [a, b] });
  const services = makeServices(makeProject(sheet));

  moveTile(services, 'sheet1', 'a', 'b');
  assert.equal(a.name, undefined);
  assert.equal(b.name, 'grass');

  services.history.undo();
  assert.equal(a.name, 'grass');
  assert.equal(b.name, undefined);
});

test('moveStandaloneTile offsets position and undoes', () => {
  resetLegacy();
  const tile = makeTile({ x: 4, y: 4 });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  moveStandaloneTile(services, 'sheet1', 't1', 3, -2);
  assert.deepEqual({ x: tile.x, y: tile.y }, { x: 7, y: 2 });
  services.history.undo();
  assert.deepEqual({ x: tile.x, y: tile.y }, { x: 4, y: 4 });
});

test('resizeTile applies and undoes a full rect change', () => {
  resetLegacy();
  const tile = makeTile({ x: 0, y: 0, w: 8, h: 8 });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  resizeTile(services, 'sheet1', 't1', { x: 0, y: 0, w: 8, h: 8 }, { x: 0, y: 0, w: 16, h: 12 });
  assert.deepEqual({ w: tile.w, h: tile.h }, { w: 16, h: 12 });
  services.history.undo();
  assert.deepEqual({ w: tile.w, h: tile.h }, { w: 8, h: 8 });
});

test('createTile adds a tile, selects it, and undo removes + deselects', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  createTile(services, 'sheet1', { x: 2, y: 2, w: 8, h: 8 });
  assert.equal(sheet.tiles.length, 1);
  assert.equal(state.selectedTileId, sheet.tiles[0].id);

  services.history.undo();
  assert.equal(sheet.tiles.length, 0);
  assert.equal(state.selectedTileId, null);

  services.history.redo();
  assert.equal(sheet.tiles.length, 1);
});

test('deleteTile removes a standalone tile and is undoable, refusing grid-owned tiles', () => {
  resetLegacy();
  const standalone = makeTile({ id: 's1' });
  const owned = makeTile({ id: 'o1', gridId: 'g1' });
  const sheet = makeSheet({ tiles: [standalone, owned], terrainSets: [] });
  const services = makeServices(makeProject(sheet));

  deleteTile(services, 'sheet1', 'o1');
  assert.equal(sheet.tiles.length, 2, 'grid-owned tiles are not deleted individually');

  deleteTile(services, 'sheet1', 's1');
  assert.equal(sheet.tiles.length, 1);
  assert.equal(sheet.tiles[0].id, 'o1');

  services.history.undo();
  assert.equal(sheet.tiles.length, 2);
});

test('setTileLayer, renameTile, setTileTags each round-trip through undo', () => {
  resetLegacy();
  const tile = makeTile();
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  setTileLayer(services, 'sheet1', 't1', 'terrain');
  renameTile(services, 'sheet1', 't1', 'grass');
  setTileTags(services, 'sheet1', 't1', 'green, ground');
  assert.deepEqual({ layer: tile.layer, name: tile.name, tags: tile.tags }, { layer: 'terrain', name: 'grass', tags: ['green', 'ground'] });

  services.history.undo();
  assert.equal(tile.tags, undefined);
  services.history.undo();
  assert.equal(tile.name, undefined);
  services.history.undo();
  assert.equal(tile.layer, undefined);
});

test('setTileSize detaches from a mismatched terrain set as part of the mutation, and undo restores it', () => {
  resetLegacy();
  const tile = makeTile({ w: 16, terrainSetId: 'ts1', blobIndex: 3 });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [{ id: 'ts1', tileW: 16, tileH: 8, slots: {}, symmetry: { flip: false, rotate: false } }] });
  const services = makeServices(makeProject(sheet));

  setTileSize(services, 'sheet1', 't1', 'w', 24);
  assert.equal(tile.w, 24);
  assert.equal(tile.terrainSetId, undefined, 'mismatched size detaches from its terrain set');

  services.history.undo();
  assert.equal(tile.w, 16);
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, 3);
});

test('addGrid creates a grid+tiles and undo removes them; deleteGrid reverses it', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);

  services.history.undo();
  assert.equal(sheet.tileGrids.length, 0);
  assert.equal(sheet.tiles.length, 0);

  services.history.redo();
  deleteGrid(services, 'sheet1', grid.id);
  assert.equal(sheet.tileGrids.length, 0);
  assert.equal(sheet.tiles.length, 0);

  services.history.undo();
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);
});

test('moveGrid offsets every owned tile via relayout, and undoes', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });

  moveGrid(services, 'sheet1', grid.id, 4, 0);
  assert.equal(grid.x, 4);
  assert.equal(sheet.tiles[0].x, 4);

  services.history.undo();
  assert.equal(grid.x, 0);
  assert.equal(sheet.tiles[0].x, 0);
});

test('setGridCellField resizes owned tiles via relayout, and undo restores their rects', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const beforeW = sheet.tiles[0].w;

  setGridCellField(services, 'sheet1', grid.id, 'cellW', 16);
  assert.equal(grid.cellW, 16);
  assert.equal(sheet.tiles[0].w, 16);

  services.history.undo();
  assert.equal(grid.cellW, 8);
  assert.equal(sheet.tiles[0].w, beforeW);
});

test('detachTile clears grid ownership and undo restores it', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 1, rows: 1 });
  const tileId = sheet.tiles[0].id;

  detachTile(services, 'sheet1', tileId);
  assert.equal(sheet.tiles[0].gridId, null);

  services.history.undo();
  assert.equal(sheet.tiles[0].gridId, grid.id);
});

test('growTileIntoGrid converts a standalone tile into a 1-cell grid and selects the survivor; resizeGridAxis can collapse back to one tile', () => {
  resetLegacy();
  const tile = makeTile({ id: 't1', x: 0, y: 0, w: 8, h: 8 });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  growTileIntoGrid(services, 'sheet1', 't1', 'cols', 'end', 2);
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);
  const grid = sheet.tileGrids[0];

  resizeGridAxis(services, 'sheet1', grid.id, 'cols', 'end', 1);
  assert.equal(sheet.tileGrids.length, 0, 'collapses back to a single standalone tile');
  assert.equal(sheet.tiles.length, 1);

  services.history.undo();
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);
});
