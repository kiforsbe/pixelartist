import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { createBitmap } from '../js/core/pixels.js';
import { blobIndexFromPaintMask, NEIGHBOR_BITS } from '../js/core/blob47.js';
import {
  prepareTerrainPaint, paintTerrainStroke, resolveAutotilePaintConflict,
} from '../js/modes/tiles/application/commands/autotile-paint-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeTile(overrides = {}) {
  return { id: overrides.id ?? 't1', x: 0, y: 0, w: 8, h: 8, gridId: null, ...overrides };
}

function makeTerrainSet(overrides = {}) {
  return { id: 'ts1', name: 'Ground', tileW: 8, tileH: 8, slots: {}, symmetry: { flip: false, rotate: false }, layer: null, ...overrides };
}

function makeSheet(overrides = {}) {
  return {
    id: 'sheet1', width: 16, height: 8,
    layerTree: { type: 'group', id: 'root', children: [{ type: 'layer', id: 'l0', bitmap: createBitmap(16, 8), visible: true, opacity: 1 }] },
    tiles: [], tileGrids: [], terrainSets: [], tileLayerNames: [],
    ...overrides,
  };
}

function makeProject(sheet) { return { sheets: [sheet] }; }

const isolatedBlobIndex = blobIndexFromPaintMask(0);

test('prepareTerrainPaint creates the missing standalone cells and undoes', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] }); // 16x8 sheet, 8x8 cells -> 2 cells, none exist yet
  const services = makeServices(makeProject(sheet));

  const result = prepareTerrainPaint(services, 'sheet1', 'ts1');
  assert.deepEqual(result, { grid: { cols: 2, rows: 1 } });
  assert.equal(sheet.tiles.length, 2);
  assert.ok(sheet.tiles.every(t => t.w === 8 && t.h === 8));
  assert.equal(services.history.canUndo(), true);

  services.history.undo();
  assert.equal(sheet.tiles.length, 0);
});

test('prepareTerrainPaint returns an error and makes no history entry when the sheet size does not divide the terrain tile size', () => {
  const terrainSet = makeTerrainSet({ tileW: 5, tileH: 8 });
  const sheet = makeSheet({ width: 16, height: 8, terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const result = prepareTerrainPaint(services, 'sheet1', 'ts1');
  assert.equal(typeof result.error, 'string');
  assert.equal(sheet.tiles.length, 0);
  assert.equal(services.history.canUndo(), false);
});

test('prepareTerrainPaint is a no-op with no history entry when the sheet is already fully covered', () => {
  const terrainSet = makeTerrainSet();
  const existing = makeTile({ id: 'e1', x: 0, y: 0, w: 8, h: 8 });
  const existing2 = makeTile({ id: 'e2', x: 8, y: 0, w: 8, h: 8 });
  const sheet = makeSheet({ tiles: [existing, existing2], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const result = prepareTerrainPaint(services, 'sheet1', 'ts1');
  assert.deepEqual(result, { grid: { cols: 2, rows: 1 } });
  assert.equal(sheet.tiles.length, 2);
  assert.equal(services.history.canUndo(), false);
});

test('paintTerrainStroke assigns a blob slot for a painted tile and undoes', () => {
  const terrainSet = makeTerrainSet();
  const tile = makeTile({ id: 't1' });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const strokeMasks = new Map([['t1', 0]]);
  const { conflicts } = paintTerrainStroke(services, 'sheet1', 'ts1', strokeMasks);
  assert.equal(conflicts.size, 0);
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolatedBlobIndex);
  assert.equal(terrainSet.slots[isolatedBlobIndex], 't1');
  assert.equal(services.history.canUndo(), true);

  services.history.undo();
  assert.equal(tile.terrainSetId, undefined);
  assert.equal(tile.blobIndex, undefined);
  assert.deepEqual(terrainSet.slots, {});
});

test('paintTerrainStroke reports a conflict when two tiles resolve to the same blobIndex, leaving the loser untouched', () => {
  const terrainSet = makeTerrainSet();
  const a = makeTile({ id: 'a', x: 0, y: 0 });
  const b = makeTile({ id: 'b', x: 8, y: 0 });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const strokeMasks = new Map([['a', 0], ['b', 0]]);
  const { conflicts } = paintTerrainStroke(services, 'sheet1', 'ts1', strokeMasks);
  assert.equal(conflicts.size, 1);
  assert.equal(conflicts.get('b'), isolatedBlobIndex);
  assert.equal(a.blobIndex, isolatedBlobIndex);
  assert.equal(b.terrainSetId, undefined, 'the conflicting tile is left untouched');

  services.history.undo();
  assert.equal(a.terrainSetId, undefined);
});

test('resolveAutotilePaintConflict reassigns a slot from its previous occupant and undoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolatedBlobIndex]: 'a' } });
  const a = makeTile({ id: 'a', x: 0, y: 0, terrainSetId: 'ts1', blobIndex: isolatedBlobIndex });
  const b = makeTile({ id: 'b', x: 8, y: 0, duplicateOf: 'a' });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  resolveAutotilePaintConflict(services, 'sheet1', 'ts1', 'b', isolatedBlobIndex);
  assert.equal(terrainSet.slots[isolatedBlobIndex], 'b');
  assert.equal(b.terrainSetId, 'ts1');
  assert.equal(b.blobIndex, isolatedBlobIndex);
  assert.equal(b.duplicateOf, undefined);
  assert.equal(a.terrainSetId, undefined, 'the previous occupant is vacated');
  assert.equal(a.blobIndex, undefined);

  services.history.undo();
  assert.equal(terrainSet.slots[isolatedBlobIndex], 'a');
  assert.equal(a.terrainSetId, 'ts1');
  assert.equal(a.blobIndex, isolatedBlobIndex);
  assert.equal(b.terrainSetId, undefined);
  assert.equal(b.duplicateOf, 'a', 'undo restores the original duplicateOf marker');
});

test('REDO: prepareTerrainPaint round-trips and preserves tile identity', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  prepareTerrainPaint(services, 'sheet1', 'ts1');
  const idsAfterDo = sheet.tiles.map(t => t.id);
  const objsAfterDo = sheet.tiles.slice();

  services.history.undo();
  assert.equal(sheet.tiles.length, 0);
  assert.equal(services.history.canRedo(), true);

  services.history.redo();
  assert.deepEqual(sheet.tiles.map(t => t.id), idsAfterDo, 'redo restores the same tile ids');
  assert.ok(sheet.tiles.every((t, i) => t === objsAfterDo[i]), 'redo restores the SAME tile object instances');
});

test('REDO: paintTerrainStroke round-trips slots and tile back-references', () => {
  const terrainSet = makeTerrainSet();
  const tile = makeTile({ id: 't1' });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  paintTerrainStroke(services, 'sheet1', 'ts1', new Map([['t1', 0]]));
  services.history.undo();
  assert.equal(tile.terrainSetId, undefined);

  services.history.redo();
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolatedBlobIndex);
  assert.equal(terrainSet.slots[isolatedBlobIndex], 't1');
});

test('REDO: resolveAutotilePaintConflict round-trips both occupants', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolatedBlobIndex]: 'a' } });
  const a = makeTile({ id: 'a', terrainSetId: 'ts1', blobIndex: isolatedBlobIndex });
  const b = makeTile({ id: 'b', x: 8, duplicateOf: 'a' });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  resolveAutotilePaintConflict(services, 'sheet1', 'ts1', 'b', isolatedBlobIndex);
  services.history.undo();
  assert.equal(terrainSet.slots[isolatedBlobIndex], 'a');

  services.history.redo();
  assert.equal(terrainSet.slots[isolatedBlobIndex], 'b');
  assert.equal(b.terrainSetId, 'ts1');
  assert.equal(b.duplicateOf, undefined);
  assert.equal(a.terrainSetId, undefined);
  assert.equal(a.blobIndex, undefined);
});

test('REDO: full stack prepare -> paint -> resolve, undo x3 then redo x3', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  prepareTerrainPaint(services, 'sheet1', 'ts1');
  const [t0, t1] = sheet.tiles;
  paintTerrainStroke(services, 'sheet1', 'ts1', new Map([[t0.id, 0]]));
  const { conflicts } = paintTerrainStroke(services, 'sheet1', 'ts1', new Map([[t1.id, 0]]));
  assert.equal(conflicts.get(t1.id), isolatedBlobIndex, 'second paint conflicts');
  resolveAutotilePaintConflict(services, 'sheet1', 'ts1', t1.id, isolatedBlobIndex);
  const finalSlots = { ...sheet.terrainSets[0].slots };
  assert.equal(finalSlots[isolatedBlobIndex], t1.id);

  // The conflicted stroke produced no history entry, so 3 undos empty the sheet.
  services.history.undo();
  services.history.undo();
  assert.equal(services.history.canUndo(), true);
  services.history.undo();
  assert.equal(sheet.tiles.length, 0, 'all the way back to empty');
  assert.equal(services.history.canUndo(), false);

  services.history.redo();
  services.history.redo();
  services.history.redo();
  assert.equal(sheet.tiles.length, 2);
  assert.deepEqual(sheet.terrainSets[0].slots, finalSlots, 'slots identical after full redo');
  assert.equal(sheet.tiles.find(t => t.id === t1.id).terrainSetId, 'ts1');
  assert.equal(sheet.tiles.find(t => t.id === t0.id).terrainSetId, undefined);
});

test('REDO: repeated undo/redo thrash stays stable', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  prepareTerrainPaint(services, 'sheet1', 'ts1');
  const t0 = sheet.tiles[0];
  paintTerrainStroke(services, 'sheet1', 'ts1', new Map([[t0.id, NEIGHBOR_BITS.N]]));
  const snapshot = () => JSON.stringify({
    slots: sheet.terrainSets[0].slots,
    tiles: sheet.tiles.map(t => [t.id, t.terrainSetId, t.blobIndex]),
  });
  const before = snapshot();
  for (let i = 0; i < 5; i++) {
    services.history.undo(); services.history.undo();
    services.history.redo(); services.history.redo();
  }
  assert.equal(snapshot(), before);
});
