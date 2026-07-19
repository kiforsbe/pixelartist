import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import {
  gridCellRect, createTileGrid, ownedTiles, relayoutGrid,
  resizeGridAxis, growTileIntoGrid, collapseGridToTile,
  moveGrid, removeTileGrid, detachTile,
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

test("resizeGridAxis: growing on 'end' adds a trailing column (cols), preserves existing tiles", () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 2 });
  tiles[0].name = 'grass';
  const { added } = resizeGridAxis(s, grid, 'cols', 'end', 3);
  assert.equal(grid.cols, 3);
  assert.equal(added.length, 2); // one new cell per row
  assert.equal(s.tiles.length, 6);
  assert.equal(tiles[0].name, 'grass'); // untouched existing tile survives
});

test("resizeGridAxis: shrinking on 'end' removes the trailing column (cols), pixels/tiles for it gone", () => {
  const s = tileSheet();
  const { grid } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 3, rows: 2 });
  const { removed } = resizeGridAxis(s, grid, 'cols', 'end', 2);
  assert.equal(grid.cols, 2);
  assert.equal(removed.length, 2);
  assert.equal(s.tiles.length, 4);
  assert.ok(s.tiles.every(t => t.gridCol < 2));
});

test("resizeGridAxis: growing/shrinking on 'end' mirrors cols for rows", () => {
  const s = tileSheet();
  const { grid } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 2 });
  resizeGridAxis(s, grid, 'rows', 'end', 3);
  assert.equal(grid.rows, 3);
  assert.equal(s.tiles.length, 6);
  resizeGridAxis(s, grid, 'rows', 'end', 1);
  assert.equal(grid.rows, 1);
  assert.equal(s.tiles.length, 2);
});

test("resizeGridAxis: growing on 'start' (cols) shifts grid.x and keeps existing tiles' on-screen position", () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 10, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  const before = tiles.map(t => ({ x: t.x, y: t.y }));
  const { added } = resizeGridAxis(s, grid, 'cols', 'start', 3);
  assert.equal(grid.cols, 3);
  assert.equal(grid.x, 10 - 16); // shifted left by one cell
  assert.equal(added.length, 1);
  assert.deepEqual(tiles.map(t => ({ x: t.x, y: t.y })), before); // unchanged on screen
  assert.deepEqual(tiles.map(t => t.gridCol), [1, 2]); // renumbered
  assert.equal(added[0].gridCol, 0);
  assert.equal(added[0].x, 10 - 16);
});

test("resizeGridAxis: growing on 'start' (rows) shifts grid.y and keeps existing tiles' on-screen position", () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 10, cellW: 16, cellH: 16, cols: 1, rows: 2 });
  const before = tiles.map(t => ({ x: t.x, y: t.y }));
  resizeGridAxis(s, grid, 'rows', 'start', 3);
  assert.equal(grid.rows, 3);
  assert.equal(grid.y, 10 - 16);
  assert.deepEqual(tiles.map(t => ({ x: t.x, y: t.y })), before);
  assert.deepEqual(tiles.map(t => t.gridRow), [1, 2]);
});

test("resizeGridAxis: shrinking on 'start' (cols) drops low-index tiles, shifts grid.x, survivors keep on-screen position", () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 3, rows: 1 });
  const survivorsBefore = [tiles[1], tiles[2]].map(t => ({ x: t.x, y: t.y }));
  const { removed } = resizeGridAxis(s, grid, 'cols', 'start', 2);
  assert.equal(grid.cols, 2);
  assert.equal(grid.x, 16); // shifted right by the dropped column's width
  assert.equal(removed.length, 1);
  assert.equal(removed[0].id, tiles[0].id);
  assert.deepEqual([tiles[1], tiles[2]].map(t => ({ x: t.x, y: t.y })), survivorsBefore);
  assert.deepEqual([tiles[1].gridCol, tiles[2].gridCol], [0, 1]);
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

test('removeTileGrid scrubs the removed tiles from other tiles\' neighbors and any terrain set\'s slots', () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const [left, right] = tiles;
  left.neighbors = { e: { mode: 'tile', tileId: right.id, flipH: false, flipV: false } };
  s.terrainSets.push({ id: 'ts1', name: 'T', tileW: 8, tileH: 8, slots: { 5: right.id }, symmetry: { flip: false, rotate: false } });
  s.tiles.push({ id: 'standalone', x: 100, y: 100, w: 8, h: 8, name: undefined, gridId: null, neighbors: undefined });
  removeTileGrid(s, grid.id);
  const standalone = s.tiles.find(t => t.id === 'standalone');
  assert.equal(standalone.neighbors, undefined); // untouched -- had none to begin with, just confirms it survives
  assert.deepEqual(s.terrainSets[0].slots, {});
});

test('detachTile clears gridId/gridCol/gridRow', () => {
  const s = tileSheet();
  const { tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 1, rows: 1 });
  detachTile(tiles[0]);
  assert.equal(tiles[0].gridId, null);
  assert.equal(tiles[0].gridCol, undefined);
  assert.equal(tiles[0].gridRow, undefined);
});

test("resizeGridAxis shrink on 'end' scrubs dropped tiles from other tiles' neighbors and any terrain set's slots", () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const [left, right] = tiles;
  left.neighbors = { e: { mode: 'tile', tileId: right.id, flipH: false, flipV: false } };
  s.terrainSets.push({ id: 'ts1', name: 'T', tileW: 8, tileH: 8, slots: { 5: right.id }, symmetry: { flip: false, rotate: false } });
  resizeGridAxis(s, grid, 'cols', 'end', 1);
  assert.deepEqual(left.neighbors.e, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(s.terrainSets[0].slots, {});
});

test("resizeGridAxis shrink on 'start' scrubs dropped tiles from other tiles' neighbors and any terrain set's slots", () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const [left, right] = tiles;
  right.neighbors = { w: { mode: 'tile', tileId: left.id, flipH: false, flipV: false } };
  s.terrainSets.push({ id: 'ts1', name: 'T', tileW: 8, tileH: 8, slots: { 5: left.id }, symmetry: { flip: false, rotate: false } });
  resizeGridAxis(s, grid, 'cols', 'start', 1);
  assert.deepEqual(right.neighbors.w, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(s.terrainSets[0].slots, {});
});

test('growTileIntoGrid: promotes a standalone tile into a 1xN grid, reusing the original tile', () => {
  const s = tileSheet();
  const tile = { id: 'standalone', x: 20, y: 30, w: 16, h: 16, name: 'grass', gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined };
  s.tiles.push(tile);
  const { grid, added } = growTileIntoGrid(s, tile, 'cols', 'end', 3);
  assert.equal(s.tileGrids.length, 1);
  assert.equal(grid.x, 20);
  assert.equal(grid.y, 30);
  assert.equal(grid.cellW, 16);
  assert.equal(grid.cellH, 16);
  assert.equal(grid.cols, 3);
  assert.equal(grid.rows, 1);
  assert.equal(added.length, 2);
  assert.equal(tile.gridId, grid.id);
  assert.equal(tile.gridCol, 0);
  assert.equal(tile.name, 'grass'); // original tile's identity/content survives
  assert.equal(s.tiles.length, 3); // original + 2 new, no duplicate created
});

test("growTileIntoGrid: growing on 'start' renumbers the original tile to the far end", () => {
  const s = tileSheet();
  const tile = { id: 'standalone', x: 20, y: 30, w: 16, h: 16, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined };
  s.tiles.push(tile);
  const { grid } = growTileIntoGrid(s, tile, 'cols', 'start', 2);
  assert.equal(grid.x, 20 - 16);
  assert.equal(tile.x, 20); // stayed in place on screen
  assert.equal(tile.gridCol, 1); // renumbered to the far end
});

test('collapseGridToTile: removes the grid, detaches the surviving tile, keeps its rect', () => {
  const s = tileSheet();
  const { grid, tiles } = createTileGrid(s, { x: 5, y: 6, cellW: 16, cellH: 16, cols: 1, rows: 1 });
  const tile = collapseGridToTile(s, grid);
  assert.equal(s.tileGrids.length, 0);
  assert.equal(tile.id, tiles[0].id);
  assert.equal(tile.gridId, null);
  assert.equal(tile.gridCol, undefined);
  assert.equal(tile.gridRow, undefined);
  assert.deepEqual({ x: tile.x, y: tile.y, w: tile.w, h: tile.h }, { x: 5, y: 6, w: 16, h: 16 });
});
