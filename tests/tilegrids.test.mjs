import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import {
  gridCellRect, createTileGrid, ownedTiles, relayoutGrid,
  resizeGridCols, resizeGridRows, moveGrid, removeTileGrid, detachTile,
} from '../js/core/tilegrids.js';

function tileSheet(w = 64, h = 64) {
  const p = createProject('t');
  return createSheet(p, { name: 'tiles', width: w, height: h, kind: 'tile' });
}

test('gridCellRect: cell geometry from origin/size/spacing', () => {
  const grid = { x: 10, y: 20, cellW: 8, cellH: 8, cols: 3, rows: 3, spacingX: 2, spacingY: 0 };
  assert.deepEqual(gridCellRect(grid, 0, 0), { x: 10, y: 20, w: 8, h: 8 });
  assert.deepEqual(gridCellRect(grid, 1, 0), { x: 20, y: 20, w: 8, h: 8 });
  assert.deepEqual(gridCellRect(grid, 0, 1), { x: 10, y: 28, w: 8, h: 8 });
});

test('createTileGrid: pushes grid + cols*rows tiles with gridCol/gridRow', () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 3 });
  assert.equal(s.tileGrids.length, 1);
  assert.equal(s.tiles.length, 6);
  assert.equal(tiles.length, 6);
  const t = tiles.find(t => t.gridCol === 1 && t.gridRow === 2);
  assert.deepEqual({ x: t.x, y: t.y, w: t.w, h: t.h }, { x: 16, y: 32, w: 16, h: 16 });
  assert.equal(t.gridId, grid.id);
  assert.equal(t.name, undefined);
});

test('ownedTiles filters by gridId', () => {
  const s = tileSheet();
  const { grid: g1 } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const { grid: g2 } = createTileGrid(s, { x: 0, y: 8, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  assert.equal(ownedTiles(s, g1.id).length, 2);
  assert.equal(ownedTiles(s, g2.id).length, 2);
});

test('relayoutGrid recomputes owned tile rects after grid geometry changes', () => {
  const s = tileSheet();
  const { grid } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  grid.cellW = 8;
  relayoutGrid(s, grid);
  const t1 = ownedTiles(s, grid.id).find(t => t.gridCol === 1);
  assert.deepEqual({ x: t1.x, w: t1.w }, { x: 8, w: 8 });
});

test('resizeGridCols: growing adds a trailing column, preserves existing tiles', () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 2 });
  tiles[0].name = 'grass';
  const { added } = resizeGridCols(s, grid, 3);
  assert.equal(grid.cols, 3);
  assert.equal(added.length, 2); // one new cell per row
  assert.equal(s.tiles.length, 6);
  assert.equal(tiles[0].name, 'grass'); // untouched existing tile survives
});

test('resizeGridCols: shrinking removes the trailing column, pixels/tiles for it gone', () => {
  const s = tileSheet();
  const { grid } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 3, rows: 2 });
  const { removed } = resizeGridCols(s, grid, 2);
  assert.equal(grid.cols, 2);
  assert.equal(removed.length, 2);
  assert.equal(s.tiles.length, 4);
  assert.ok(s.tiles.every(t => t.gridCol < 2));
});

test('resizeGridRows: growing/shrinking mirrors resizeGridCols for rows', () => {
  const s = tileSheet();
  const { grid } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 2 });
  resizeGridRows(s, grid, 3);
  assert.equal(grid.rows, 3);
  assert.equal(s.tiles.length, 6);
  resizeGridRows(s, grid, 1);
  assert.equal(grid.rows, 1);
  assert.equal(s.tiles.length, 2);
});

test('moveGrid shifts origin and every owned tile by the same delta', () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  moveGrid(s, grid, 5, 7);
  assert.deepEqual({ x: grid.x, y: grid.y }, { x: 5, y: 7 });
  assert.deepEqual({ x: tiles[0].x, y: tiles[0].y }, { x: 5, y: 7 });
  assert.deepEqual({ x: tiles[1].x, y: tiles[1].y }, { x: 21, y: 7 });
});

test('removeTileGrid drops the grid and every tile it owns, leaves others', () => {
  const s = tileSheet();
  const { grid } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  s.tiles.push({ id: 'standalone', x: 100, y: 100, w: 8, h: 8, name: undefined, gridId: null, neighbors: undefined });
  removeTileGrid(s, grid.id);
  assert.equal(s.tileGrids.length, 0);
  assert.equal(s.tiles.length, 1);
  assert.equal(s.tiles[0].id, 'standalone');
});

test('detachTile clears gridId/gridCol/gridRow', () => {
  const s = tileSheet();
  const { tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 1, rows: 1 });
  detachTile(tiles[0]);
  assert.equal(tiles[0].gridId, null);
  assert.equal(tiles[0].gridCol, undefined);
  assert.equal(tiles[0].gridRow, undefined);
});
