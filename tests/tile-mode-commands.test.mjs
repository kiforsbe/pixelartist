import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../js/app/state.js';
import { CommandStack } from '../js/core/commands.js';
import {
  commitAddTerrainSet, commitRenameTerrainSet, commitSetTerrainSetLayer,
} from '../js/modes/tiles/terrain-set-commands.js';

function resetHistory() {
  state.commands = new CommandStack();
  state.dirty = false;
}

test('terrain-set lifecycle and metadata commands round-trip through history', () => {
  resetHistory();
  const sheet = { terrainSets: [], tiles: [] };
  const terrainSet = commitAddTerrainSet(sheet, { name: 'Ground', tileW: 16, tileH: 16 });
  assert.equal(sheet.terrainSets[0], terrainSet);

  commitRenameTerrainSet(terrainSet, 'Cliffs');
  commitSetTerrainSetLayer(terrainSet, 'terrain');
  assert.equal(terrainSet.name, 'Cliffs');
  assert.equal(terrainSet.layer, 'terrain');

  state.commands.undo();
  assert.equal(terrainSet.layer, null);
  state.commands.undo();
  assert.equal(terrainSet.name, 'Ground');
  state.commands.undo();
  assert.deepEqual(sheet.terrainSets, []);

  state.commands.redo();
  state.commands.redo();
  state.commands.redo();
  assert.equal(sheet.terrainSets[0], terrainSet);
  assert.equal(terrainSet.name, 'Cliffs');
  assert.equal(terrainSet.layer, 'terrain');
});
