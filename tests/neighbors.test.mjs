import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEIGHBOR_DIRS, defaultPreset, getPreset, setSlot, resolveNeighborGrid }
  from '../js/core/neighbors.js';

test('default preset: all 8 same, no flips', () => {
  const p = defaultPreset();
  assert.deepEqual(Object.keys(p).sort(), [...NEIGHBOR_DIRS].sort());
  for (const d of NEIGHBOR_DIRS)
    assert.deepEqual(p[d], { mode: 'same', tileId: null, flipH: false, flipV: false });
});

test('get/set preset on a tile record', () => {
  const tile = { neighbors: undefined };
  assert.deepEqual(getPreset(tile), defaultPreset());
  assert.equal(tile.neighbors, undefined); // get does not store
  setSlot(tile, 'e', { mode: 'tile', tileId: 'ti7', flipH: true, flipV: false });
  assert.equal(getPreset(tile).e.tileId, 'ti7');
  assert.equal(getPreset(tile).n.mode, 'same'); // rest defaulted
});

test('resolveNeighborGrid radius 1: 8 cells, same->center, empty->null', () => {
  const p = defaultPreset();
  p.n = { mode: 'empty', tileId: null, flipH: false, flipV: false };
  p.e = { mode: 'tile', tileId: 'ti9', flipH: false, flipV: true };
  const cells = resolveNeighborGrid(p, 'ti4', 1);
  assert.equal(cells.length, 8);
  const at = (dx, dy) => cells.find(c => c.dx === dx && c.dy === dy);
  assert.equal(at(0, -1).tileId, null);              // n empty
  assert.deepEqual(at(1, 0), { dx: 1, dy: 0, tileId: 'ti9', flipH: false, flipV: true });
  assert.equal(at(-1, -1).tileId, 'ti4');             // nw same -> center
});

test('resolveNeighborGrid radius 2: 24 cells, outer ring reuses direction slot', () => {
  const p = defaultPreset();
  p.e = { mode: 'tile', tileId: 'ti9', flipH: true, flipV: false };
  const cells = resolveNeighborGrid(p, 'ti4', 2);
  assert.equal(cells.length, 24);
  const at = (dx, dy) => cells.find(c => c.dx === dx && c.dy === dy);
  assert.equal(at(2, 0).tileId, 'ti9');
  assert.equal(at(2, 0).flipH, true);
  assert.equal(at(2, 2).tileId, 'ti4'); // se is 'same'
});
