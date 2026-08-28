import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { createBitmap } from '../js/core/pixels.js';
import { blobIndexFromPaintMask } from '../js/core/blob47.js';
import {
  createTerrainSet, deleteTerrainSet, renameTerrainSet, assignTerrainSlot,
  clearTerrainSlot, setTerrainSymmetry, applyTerrainLayoutPreset, setTerrainSetLayer,
} from '../js/modes/tiles/application/commands/terrain-set-commands.js';

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

const isolated = blobIndexFromPaintMask(0);

test('createTerrainSet adds a set and undoes/redoes', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  const { terrainSetId } = createTerrainSet(services, 'sheet1', { name: 'Ground', tileW: 8, tileH: 8 });
  assert.equal(sheet.terrainSets.length, 1);
  assert.equal(sheet.terrainSets[0].id, terrainSetId);
  assert.equal(sheet.terrainSets[0].name, 'Ground');

  services.history.undo();
  assert.equal(sheet.terrainSets.length, 0);

  services.history.redo();
  assert.equal(sheet.terrainSets.length, 1);
  assert.equal(sheet.terrainSets[0].id, terrainSetId);
});

test('deleteTerrainSet removes the set and clears tile back-references, undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolated]: 't1' } });
  const tile = makeTile({ id: 't1', terrainSetId: 'ts1', blobIndex: isolated });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  deleteTerrainSet(services, 'sheet1', 'ts1');
  assert.equal(sheet.terrainSets.length, 0);
  assert.equal(tile.terrainSetId, undefined);
  assert.equal(tile.blobIndex, undefined);

  services.history.undo();
  assert.equal(sheet.terrainSets.length, 1);
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolated);

  services.history.redo();
  assert.equal(sheet.terrainSets.length, 0);
  assert.equal(tile.terrainSetId, undefined);
});

test('renameTerrainSet updates the name and undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ name: 'Ground' });
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  renameTerrainSet(services, 'sheet1', 'ts1', 'Cliffs');
  assert.equal(terrainSet.name, 'Cliffs');

  services.history.undo();
  assert.equal(terrainSet.name, 'Ground');

  services.history.redo();
  assert.equal(terrainSet.name, 'Cliffs');
});

test('renameTerrainSet is a no-op with no history entry for a blank name', () => {
  const terrainSet = makeTerrainSet({ name: 'Ground' });
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  renameTerrainSet(services, 'sheet1', 'ts1', '   ');
  assert.equal(terrainSet.name, 'Ground');
  assert.equal(services.history.canUndo(), false);
});

test('renameTerrainSet is a silent no-op when the terrainSetId does not resolve', () => {
  const sheet = makeSheet({ terrainSets: [] });
  const services = makeServices(makeProject(sheet));
  assert.doesNotThrow(() => renameTerrainSet(services, 'sheet1', 'nonexistent', 'New Name'));
  assert.equal(services.history.canUndo(), false);
});

test('assignTerrainSlot assigns a tile into a slot and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const tile = makeTile({ id: 't1' });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  assignTerrainSlot(services, 'sheet1', 'ts1', isolated, 't1');
  assert.equal(terrainSet.slots[isolated], 't1');
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolated);

  services.history.undo();
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(tile.terrainSetId, undefined);

  services.history.redo();
  assert.equal(terrainSet.slots[isolated], 't1');
  assert.equal(tile.terrainSetId, 'ts1');
});

test('assignTerrainSlot reassigns a tile away from a DIFFERENT terrain set, undoes/redoes both sets correctly', () => {
  const otherSet = makeTerrainSet({ id: 'ts-other', slots: { [isolated]: 't1' } });
  const targetSet = makeTerrainSet({ id: 'ts1', slots: {} });
  const tile = makeTile({ id: 't1', terrainSetId: 'ts-other', blobIndex: isolated });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [otherSet, targetSet] });
  const services = makeServices(makeProject(sheet));

  assignTerrainSlot(services, 'sheet1', 'ts1', isolated, 't1');
  assert.equal(targetSet.slots[isolated], 't1');
  assert.deepEqual(otherSet.slots, {}, 'the old set is vacated');
  assert.equal(tile.terrainSetId, 'ts1');

  services.history.undo();
  assert.deepEqual(targetSet.slots, {});
  assert.equal(otherSet.slots[isolated], 't1', 'undo restores the OTHER set too, not just the target');
  assert.equal(tile.terrainSetId, 'ts-other');

  services.history.redo();
  assert.equal(targetSet.slots[isolated], 't1');
  assert.deepEqual(otherSet.slots, {});
  assert.equal(tile.terrainSetId, 'ts1');
});

test('clearTerrainSlot clears an explicit assignment and undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolated]: 't1' } });
  const tile = makeTile({ id: 't1', terrainSetId: 'ts1', blobIndex: isolated });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  clearTerrainSlot(services, 'sheet1', 'ts1', isolated, 't1');
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(tile.terrainSetId, undefined);

  services.history.undo();
  assert.equal(terrainSet.slots[isolated], 't1');
  assert.equal(tile.terrainSetId, 'ts1');

  services.history.redo();
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(tile.terrainSetId, undefined);
});

test('clearTerrainSlot with no owning tile (tileId null) still clears the slot map and undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolated]: 'ghost-id' } });
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  clearTerrainSlot(services, 'sheet1', 'ts1', isolated, null);
  assert.deepEqual(terrainSet.slots, {});

  services.history.undo();
  assert.equal(terrainSet.slots[isolated], 'ghost-id');

  services.history.redo();
  assert.deepEqual(terrainSet.slots, {});
});

test('setTerrainSymmetry toggles a flag and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  setTerrainSymmetry(services, 'sheet1', 'ts1', 'flip', true);
  assert.equal(terrainSet.symmetry.flip, true);

  services.history.undo();
  assert.equal(terrainSet.symmetry.flip, false);

  services.history.redo();
  assert.equal(terrainSet.symmetry.flip, true);
});

test('setTerrainSymmetry is a no-op with no history entry when the value is unchanged', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  setTerrainSymmetry(services, 'sheet1', 'ts1', 'flip', false);
  assert.equal(services.history.canUndo(), false);
});

test('setTerrainSymmetry is a silent no-op when the terrainSetId does not resolve', () => {
  const sheet = makeSheet({ terrainSets: [] });
  const services = makeServices(makeProject(sheet));
  assert.doesNotThrow(() => setTerrainSymmetry(services, 'sheet1', 'nonexistent', 'flip', true));
  assert.equal(services.history.canUndo(), false);
});

test('applyTerrainLayoutPreset assigns slots from a preset and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const a = makeTile({ id: 'a', x: 0, y: 0 });
  const b = makeTile({ id: 'b', x: 8, y: 0 });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));
  const preset = {
    cols: 2, rows: 1,
    cells: [{ col: 0, row: 0, blobIndex: isolated }, { col: 1, row: 0, blobIndex: isolated }],
  };

  applyTerrainLayoutPreset(services, 'sheet1', 'ts1', preset, ['a', 'b'], 2);
  assert.equal(terrainSet.slots[isolated], 'a', 'first cell in raster order wins');
  assert.equal(a.terrainSetId, 'ts1');
  assert.equal(b.duplicateOf, 'a');

  services.history.undo();
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(a.terrainSetId, undefined);
  assert.equal(b.duplicateOf, undefined);

  services.history.redo();
  assert.equal(terrainSet.slots[isolated], 'a');
  assert.equal(b.duplicateOf, 'a');
});

test('setTerrainSetLayer sets the layer and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  setTerrainSetLayer(services, 'sheet1', 'ts1', 'Terrain');
  assert.equal(terrainSet.layer, 'Terrain');

  services.history.undo();
  assert.equal(terrainSet.layer, null);

  services.history.redo();
  assert.equal(terrainSet.layer, 'Terrain');
});

test('setTerrainSetLayer is a silent no-op when the terrainSetId does not resolve', () => {
  const sheet = makeSheet({ terrainSets: [] });
  const services = makeServices(makeProject(sheet));
  assert.doesNotThrow(() => setTerrainSetLayer(services, 'sheet1', 'nonexistent', 'Terrain'));
  assert.equal(services.history.canUndo(), false);
});
