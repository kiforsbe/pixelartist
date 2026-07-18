import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset,
  groupCellsByBlobIndex, pruneEmptyTerrainSets,
} from '../js/core/terrainsets.js';

function tileSheet() {
  const p = createProject('t');
  return createSheet(p, { name: 'Tiles', width: 64, height: 64, kind: 'tile' });
}

function tile(id, w = 16, h = 16) {
  return { id, x: 0, y: 0, w, h, name: undefined, gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined };
}

test('createTerrainSet pushes a set with empty slots, symmetry off, and no layer', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  assert.equal(s.terrainSets.length, 1);
  assert.deepEqual(ts.slots, {});
  assert.deepEqual(ts.symmetry, { flip: false, rotate: false });
  assert.equal(ts.layer, null);
});

test('assignSlot sets both directions of the reference and enforces exclusivity', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  assert.equal(ts.slots[5], 't1');
  assert.equal(t.terrainSetId, ts.id);
  assert.equal(t.blobIndex, 5);

  // Reassigning the same tile into a different slot clears the old one.
  assignSlot(s, ts, 9, t);
  assert.equal(ts.slots[5], undefined);
  assert.equal(ts.slots[9], 't1');
  assert.equal(t.blobIndex, 9);
});

test('assignSlot clears the PREVIOUS OCCUPANT\'s back-reference when a different tile takes its slot', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const tileX = tile('tx');
  const tileY = tile('ty');
  s.tiles.push(tileX, tileY);
  assignSlot(s, ts, 5, tileX);
  assignSlot(s, ts, 5, tileY); // tileY takes over slot 5 from tileX
  assert.equal(ts.slots[5], 'ty');
  assert.equal(tileY.terrainSetId, ts.id);
  assert.equal(tileY.blobIndex, 5);
  // tileX must no longer claim slot 5 -- this is the bug this test guards
  // against: assignSlot only clearing the NEW tile's own previous slot,
  // and forgetting to clear the slot's PREVIOUS OCCUPANT's back-reference.
  assert.equal(tileX.terrainSetId, undefined);
  assert.equal(tileX.blobIndex, undefined);
});

test('assignSlot clears the tile\'s slot in a DIFFERENT terrain set too', () => {
  const s = tileSheet();
  const tsA = createTerrainSet(s, { name: 'A', tileW: 16, tileH: 16 });
  const tsB = createTerrainSet(s, { name: 'B', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, tsA, 0, t);
  assignSlot(s, tsB, 0, t);
  assert.deepEqual(tsA.slots, {});
  assert.equal(tsB.slots[0], 't1');
  assert.equal(t.terrainSetId, tsB.id);
});

test('clearSlot removes the assignment and the tile\'s back-reference', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  clearSlot(ts, 5, t);
  assert.equal(ts.slots[5], undefined);
  assert.equal(t.terrainSetId, undefined);
  assert.equal(t.blobIndex, undefined);
});

test('removeTerrainSet clears every referencing tile\'s back-ref, tiles survive', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  removeTerrainSet(s, ts.id);
  assert.equal(s.terrainSets.length, 0);
  assert.equal(s.tiles.length, 1);
  assert.equal(t.terrainSetId, undefined);
  assert.equal(t.blobIndex, undefined);
});

test('detachFromTerrainSetIfMismatched clears the slot when tile size no longer matches', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  t.w = 8; // resized, no longer matches ts.tileW
  detachFromTerrainSetIfMismatched(s, t);
  assert.equal(t.terrainSetId, undefined);
  assert.equal(ts.slots[5], undefined);
});

test('detachFromTerrainSetIfMismatched is a no-op when size still matches', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const t = tile('t1');
  s.tiles.push(t);
  assignSlot(s, ts, 5, t);
  detachFromTerrainSetIfMismatched(s, t);
  assert.equal(t.terrainSetId, ts.id);
});

test('applyLayoutPreset assigns each cell\'s blobIndex to the tile at that col/row', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const grid = [tile('t00'), tile('t10'), tile('t01'), tile('t11')]; // 2x2, row-major
  s.tiles.push(...grid);
  const preset = { id: 'p1', name: 'Test', cols: 2, rows: 2, cells: [{ col: 1, row: 0, blobIndex: 3 }, { col: 0, row: 1, blobIndex: 7 }] };
  applyLayoutPreset(s, ts, preset, grid, 2);
  assert.equal(ts.slots[3], 't10');
  assert.equal(ts.slots[7], 't01');
});

test('applyLayoutPreset skips a source tile whose size doesn\'t match the terrain set', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const grid = [tile('t00', 8, 8)]; // wrong size
  s.tiles.push(...grid);
  const preset = { id: 'p1', name: 'Test', cols: 1, rows: 1, cells: [{ col: 0, row: 0, blobIndex: 0 }] };
  applyLayoutPreset(s, ts, preset, grid, 1);
  assert.deepEqual(ts.slots, {});
});

test('applyLayoutPreset marks non-primary duplicate cells (same blobIndex, multiple cells)', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  const grid = [tile('t00'), tile('t10'), tile('t01')]; // 2x2 minus one corner, row-major over a 2-wide grid
  s.tiles.push(...grid);
  const preset = {
    id: 'p1', name: 'Test', cols: 2, rows: 2,
    cells: [{ col: 0, row: 0, blobIndex: 0 }, { col: 1, row: 0, blobIndex: 0 }, { col: 0, row: 1, blobIndex: 5 }],
  };
  applyLayoutPreset(s, ts, preset, grid, 2);
  // first cell for blobIndex 0 in raster order (col 0, row 0 -> t00) wins the slot
  assert.equal(ts.slots[0], 't00');
  assert.equal(grid[0].duplicateOf, undefined); // the winner itself isn't marked
  assert.equal(grid[1].duplicateOf, 't00');      // t10 loses out -> flagged as a dead-end duplicate
  assert.equal(grid[2].duplicateOf, undefined);  // blobIndex 5 had only one cell -- not a duplicate
});

test('pruneEmptyTerrainSets removes only candidates that ended up with zero referencing tiles', () => {
  const s = tileSheet();
  const tsEmptiedOut = createTerrainSet(s, { name: 'Emptied', tileW: 16, tileH: 16 });
  const tsStillHasTiles = createTerrainSet(s, { name: 'Survives', tileW: 16, tileH: 16 });
  const tsUnrelatedAndAlreadyEmpty = createTerrainSet(s, { name: 'PreExistingEmpty', tileW: 16, tileH: 16 });
  const survivor = tile('t-survivor');
  s.tiles.push(survivor);
  assignSlot(s, tsStillHasTiles, 0, survivor);
  // tsEmptiedOut has no tiles at all (as if its only tile was just scrubbed by removeTileGrid)
  // tsUnrelatedAndAlreadyEmpty also has none, but is NOT a candidate -- must survive untouched
  const removedIds = pruneEmptyTerrainSets(s, [tsEmptiedOut.id, tsStillHasTiles.id]);
  assert.deepEqual(removedIds, [tsEmptiedOut.id]);
  assert.equal(s.terrainSets.some(ts => ts.id === tsEmptiedOut.id), false);
  assert.equal(s.terrainSets.some(ts => ts.id === tsStillHasTiles.id), true);
  assert.equal(s.terrainSets.some(ts => ts.id === tsUnrelatedAndAlreadyEmpty.id), true);
});

test('saveLayoutPreset pushes a named preset onto sheet.terrainLayoutPresets', () => {
  const s = tileSheet();
  const preset = saveLayoutPreset(s, 'My layout', 2, 2, [{ col: 0, row: 0, blobIndex: 0 }]);
  assert.equal(s.terrainLayoutPresets.length, 1);
  assert.equal(s.terrainLayoutPresets[0].name, 'My layout');
  assert.equal(preset.id, s.terrainLayoutPresets[0].id);
});
