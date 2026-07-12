import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEIGHBOR_DIRS, defaultPreset, getPreset, setSlot, resolveNeighborGrid }
  from '../js/core/neighbors.js';

test('default preset: all 8 same, no flips', () => {
  const p = defaultPreset();
  assert.deepEqual(Object.keys(p).sort(), [...NEIGHBOR_DIRS].sort());
  for (const d of NEIGHBOR_DIRS)
    assert.deepEqual(p[d], { mode: 'same', tileIndex: null, flipH: false, flipV: false });
});

test('get/set preset on sheet', () => {
  const sheet = { tile: { neighbors: {} } };
  assert.deepEqual(getPreset(sheet, 3), defaultPreset());
  assert.deepEqual(sheet.tile.neighbors, {}); // get does not store
  setSlot(sheet, 3, 'e', { mode: 'tile', tileIndex: 7, flipH: true, flipV: false });
  assert.equal(getPreset(sheet, 3).e.tileIndex, 7);
  assert.equal(getPreset(sheet, 3).n.mode, 'same'); // rest defaulted
});

test('resolveNeighborGrid radius 1: 8 cells, same->center, empty->null', () => {
  const p = defaultPreset();
  p.n = { mode: 'empty', tileIndex: null, flipH: false, flipV: false };
  p.e = { mode: 'tile', tileIndex: 9, flipH: false, flipV: true };
  const cells = resolveNeighborGrid(p, 4, 1);
  assert.equal(cells.length, 8);
  const at = (dx, dy) => cells.find(c => c.dx === dx && c.dy === dy);
  assert.equal(at(0, -1).tileIndex, null);            // n empty
  assert.deepEqual(at(1, 0), { dx: 1, dy: 0, tileIndex: 9, flipH: false, flipV: true });
  assert.equal(at(-1, -1).tileIndex, 4);              // nw same -> center
});

test('resolveNeighborGrid radius 2: 24 cells, outer ring reuses direction slot', () => {
  const p = defaultPreset();
  p.e = { mode: 'tile', tileIndex: 9, flipH: true, flipV: false };
  const cells = resolveNeighborGrid(p, 4, 2);
  assert.equal(cells.length, 24);
  const at = (dx, dy) => cells.find(c => c.dx === dx && c.dy === dy);
  assert.equal(at(2, 0).tileIndex, 9);
  assert.equal(at(2, 0).flipH, true);
  assert.equal(at(2, 2).tileIndex, 4); // se is 'same'
});
