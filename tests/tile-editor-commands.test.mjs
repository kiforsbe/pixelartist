import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { createBitmap } from '../js/core/pixels.js';
import { setTileNeighborSlot } from '../js/modes/tiles/application/commands/tile-editor-commands.js';

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
    tiles: [], tileGrids: [], terrainSets: [], tileLayerNames: [],
    ...overrides,
  };
}

function makeProject(sheet) { return { sheets: [sheet] }; }

test('setTileNeighborSlot assigns a "tile" mode slot, and undoes/redoes', () => {
  const tile = makeTile({ id: 't1' });
  const other = makeTile({ id: 't2' });
  const sheet = makeSheet({ tiles: [tile, other] });
  const services = makeServices(makeProject(sheet));

  setTileNeighborSlot(services, 'sheet1', 't1', 'e', { mode: 'tile', tileId: 't2', flipH: true, flipV: false });
  assert.deepEqual(tile.neighbors.e, { mode: 'tile', tileId: 't2', flipH: true, flipV: false });

  services.history.undo();
  assert.equal(tile.neighbors, undefined);

  services.history.redo();
  assert.deepEqual(tile.neighbors.e, { mode: 'tile', tileId: 't2', flipH: true, flipV: false });
});

test('setTileNeighborSlot overwrites one slot and preserves the tile\'s other slots on undo', () => {
  const tile = makeTile({
    id: 't1',
    neighbors: {
      e: { mode: 'same', tileId: null, flipH: false, flipV: false },
      w: { mode: 'empty', tileId: null, flipH: false, flipV: false },
    },
  });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  setTileNeighborSlot(services, 'sheet1', 't1', 'e', { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(tile.neighbors.e, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(tile.neighbors.w, { mode: 'empty', tileId: null, flipH: false, flipV: false });

  services.history.undo();
  assert.deepEqual(tile.neighbors.e, { mode: 'same', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(tile.neighbors.w, { mode: 'empty', tileId: null, flipH: false, flipV: false });
});

test('setTileNeighborSlot is a silent no-op when the tileId does not resolve', () => {
  const sheet = makeSheet({ tiles: [] });
  const services = makeServices(makeProject(sheet));

  assert.doesNotThrow(() => setTileNeighborSlot(services, 'sheet1', 'missing', 'e', { mode: 'empty', tileId: null, flipH: false, flipV: false }));
  assert.equal(services.history.canUndo(), false);
});
