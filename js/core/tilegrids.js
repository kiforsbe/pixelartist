// Persistent tile-grid geometry + mutation helpers. A grid owns a
// rectangular block of tiles (sheet.tiles entries with matching gridId);
// tile identity within a grid is (gridCol, gridRow), which is what lets a
// resize preserve an existing tile's name/neighbors instead of recreating
// it. Mirrors js/core/strips.js's role for animation strips: pure,
// DOM-free, mutates the sheet directly (the "eager mutate" half of this
// codebase's do()-then-snapshot command idiom — UI callers wrap these with
// state.commands.push()).
import { newId } from './palettes.js';

export function gridCellRect(grid, col, row) {
  return {
    x: grid.x + col * (grid.cellW + grid.spacingX),
    y: grid.y + row * (grid.cellH + grid.spacingY),
    w: grid.cellW, h: grid.cellH,
  };
}

function makeCellTile(grid, col, row) {
  const r = gridCellRect(grid, col, row);
  return {
    id: newId('ti'), x: r.x, y: r.y, w: r.w, h: r.h,
    name: undefined, gridId: grid.id, gridCol: col, gridRow: row, neighbors: undefined,
    terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined,
  };
}

export function createTileGrid(sheet, { x, y, cellW, cellH, cols, rows, spacingX = 0, spacingY = 0 }) {
  const grid = { id: newId('tg'), x, y, cellW, cellH, cols, rows, spacingX, spacingY };
  sheet.tileGrids.push(grid);
  const tiles = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const tile = makeCellTile(grid, col, row);
      sheet.tiles.push(tile);
      tiles.push(tile);
    }
  return { grid, tiles };
}

export function ownedTiles(sheet, gridId) {
  return sheet.tiles.filter(t => t.gridId === gridId);
}

export function relayoutGrid(sheet, grid) {
  for (const t of ownedTiles(sheet, grid.id)) {
    const r = gridCellRect(grid, t.gridCol, t.gridRow);
    t.x = r.x; t.y = r.y; t.w = r.w; t.h = r.h;
  }
}

export function resizeGridCols(sheet, grid, cols) {
  const delta = cols - grid.cols;
  const added = [], removed = [];
  if (delta > 0) {
    for (let row = 0; row < grid.rows; row++)
      for (let col = grid.cols; col < cols; col++) {
        const tile = makeCellTile(grid, col, row);
        sheet.tiles.push(tile);
        added.push(tile);
      }
  } else if (delta < 0) {
    const drop = new Set(ownedTiles(sheet, grid.id).filter(t => t.gridCol >= cols));
    removed.push(...drop);
    sheet.tiles = sheet.tiles.filter(t => !drop.has(t));
  }
  grid.cols = cols;
  return { added, removed };
}

export function resizeGridRows(sheet, grid, rows) {
  const delta = rows - grid.rows;
  const added = [], removed = [];
  if (delta > 0) {
    for (let row = grid.rows; row < rows; row++)
      for (let col = 0; col < grid.cols; col++) {
        const tile = makeCellTile(grid, col, row);
        sheet.tiles.push(tile);
        added.push(tile);
      }
  } else if (delta < 0) {
    const drop = new Set(ownedTiles(sheet, grid.id).filter(t => t.gridRow >= rows));
    removed.push(...drop);
    sheet.tiles = sheet.tiles.filter(t => !drop.has(t));
  }
  grid.rows = rows;
  return { added, removed };
}

export function moveGrid(sheet, grid, dx, dy) {
  grid.x += dx; grid.y += dy;
  relayoutGrid(sheet, grid);
}

export function removeTileGrid(sheet, gridId) {
  sheet.tileGrids = sheet.tileGrids.filter(g => g.id !== gridId);
  sheet.tiles = sheet.tiles.filter(t => t.gridId !== gridId);
}

export function detachTile(tile) {
  tile.gridId = null;
  tile.gridCol = undefined;
  tile.gridRow = undefined;
}
