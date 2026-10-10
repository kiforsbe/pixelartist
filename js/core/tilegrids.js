// Persistent tile-grid geometry + mutation helpers. A grid owns a
// rectangular block of tiles (sheet.tiles entries with matching gridId);
// tile identity within a grid is (gridCol, gridRow), which is what lets a
// resize preserve an existing tile's name/neighbors instead of recreating
// it. Like domain/sprites/auto-layout.js for animations: pure,
// DOM-free, mutates the sheet directly (the "eager mutate" half of this
// codebase's do()-then-snapshot command idiom — UI callers wrap these with
// state.commands.push()).
import { newId } from './palettes.js';
import { scrubTileReferences } from './model.js';

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
    terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined, duplicateOf: undefined,
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

// Generalizes the removed resizeGridCols/resizeGridRows to grow/shrink
// from either end of either axis. axis: 'cols' | 'rows'. side: 'start' |
// 'end' -- 'start' is left (cols) or top (rows); 'end' is right (cols) or
// bottom (rows), and behaves exactly like the old resizeGridCols/
// resizeGridRows (append/truncate high-index cells). `count` is the new
// TOTAL cols/rows, not a delta. Does not clamp count to >= 1 -- trusts
// the caller, same as the functions it replaces.
//
// 'start' growth shifts grid.x/grid.y by exactly one step per new cell so
// every EXISTING tile's on-screen position is unchanged (shift the origin
// left/up by `delta * step`, then add `delta` to every existing tile's
// gridCol/gridRow -- the two shifts cancel algebraically in
// gridCellRect's x = grid.x + col*step formula), then relayoutGrid fixes
// the renumbered existing tiles' x/y, then new cells are appended at the
// freed-up low indices (computed fresh from the already-shifted grid, so
// they land correctly without a second relayout).
//
// 'start' shrink is the exact inverse: drop the lowest-index cells
// (scrubTileReferences each, same as 'end' shrink), renumber survivors
// down by the dropped count, shift grid.x/grid.y the other way, relayout.
export function resizeGridAxis(sheet, grid, axis, side, count) {
  const isCols = axis === 'cols';
  const current = isCols ? grid.cols : grid.rows;
  const delta = count - current;
  if (delta === 0) return { added: [], removed: [] };

  const added = [], removed = [];
  const step = isCols ? grid.cellW + grid.spacingX : grid.cellH + grid.spacingY;

  const appendCells = (fromIndex, toIndex) => {
    const otherCount = isCols ? grid.rows : grid.cols;
    for (let i = fromIndex; i < toIndex; i++)
      for (let j = 0; j < otherCount; j++) {
        const col = isCols ? i : j;
        const row = isCols ? j : i;
        const tile = makeCellTile(grid, col, row);
        sheet.tiles.push(tile);
        added.push(tile);
      }
  };

  if (delta > 0) {
    if (side === 'end') {
      appendCells(current, count);
      if (isCols) grid.cols = count; else grid.rows = count;
    } else {
      if (isCols) grid.x -= delta * step; else grid.y -= delta * step;
      for (const t of ownedTiles(sheet, grid.id)) {
        if (isCols) t.gridCol += delta; else t.gridRow += delta;
      }
      if (isCols) grid.cols = count; else grid.rows = count;
      relayoutGrid(sheet, grid);
      appendCells(0, delta);
    }
  } else {
    const dropCount = -delta;
    if (side === 'end') {
      const drop = new Set(ownedTiles(sheet, grid.id).filter(t => (isCols ? t.gridCol : t.gridRow) >= count));
      removed.push(...drop);
      sheet.tiles = sheet.tiles.filter(t => !drop.has(t));
      for (const t of drop) scrubTileReferences(sheet, t.id);
      if (isCols) grid.cols = count; else grid.rows = count;
    } else {
      const drop = new Set(ownedTiles(sheet, grid.id).filter(t => (isCols ? t.gridCol : t.gridRow) < dropCount));
      removed.push(...drop);
      sheet.tiles = sheet.tiles.filter(t => !drop.has(t));
      for (const t of drop) scrubTileReferences(sheet, t.id);
      for (const t of ownedTiles(sheet, grid.id)) {
        if (isCols) t.gridCol -= dropCount; else t.gridRow -= dropCount;
      }
      if (isCols) grid.x += dropCount * step; else grid.y += dropCount * step;
      if (isCols) grid.cols = count; else grid.rows = count;
      relayoutGrid(sheet, grid);
    }
  }

  return { added, removed };
}

// Promotes a standalone tile into a brand-new 1x1 grid (spacingX/Y always
// 0 -- there's no dialog to set spacing anymore, drag-created grids are
// always flush), then immediately grows it via resizeGridAxis. Does NOT
// call createTileGrid -- that always builds a brand-new blank tile via
// its own makeCellTile, which would create a second, duplicate tile
// object at the same rect instead of reusing this one. The ORIGINAL tile
// is mutated in place (gridId/gridCol/gridRow set; x/y/w/h untouched,
// they already match the grid's sole cell) -- its id, name, neighbors,
// terrainSetId etc. all survive the promotion, matching how
// commitNewStripFromFrame in frames.js reuses the origin frame as a real
// strip member. Its final gridCol/gridRow depends on side (see
// resizeGridAxis's renumbering rule): index 0 for 'end' growth, or the
// highest index for 'start' growth.
export function growTileIntoGrid(sheet, tile, axis, side, count) {
  const grid = {
    id: newId('tg'), x: tile.x, y: tile.y,
    cellW: tile.w, cellH: tile.h,
    cols: 1, rows: 1, spacingX: 0, spacingY: 0,
  };
  sheet.tileGrids.push(grid);
  tile.gridId = grid.id;
  tile.gridCol = 0;
  tile.gridRow = 0;
  const { added } = resizeGridAxis(sheet, grid, axis, side, count);
  return { grid, added, removed: [] };
}

// The inverse of growTileIntoGrid's starting point: when a grid has
// shrunk to exactly 1 col and 1 row, removes the tileGrids entry and
// detaches the surviving tile (reuses detachTile). Caller's
// responsibility to only call this when the grid is actually 1x1 --
// this function doesn't check.
export function collapseGridToTile(sheet, grid) {
  const tile = ownedTiles(sheet, grid.id)[0];
  detachTile(tile);
  sheet.tileGrids = sheet.tileGrids.filter(g => g.id !== grid.id);
  return tile;
}

export function moveGrid(sheet, grid, dx, dy) {
  grid.x += dx; grid.y += dy;
  relayoutGrid(sheet, grid);
}

// Mirrors resizeGridCols/resizeGridRows's shrink path: every removed tile
// must be scrubbed from other tiles' neighbors and any terrain set's slots,
// or those references dangle. Whole-grid deletion was missing this.
export function removeTileGrid(sheet, gridId) {
  const removed = sheet.tiles.filter(t => t.gridId === gridId);
  sheet.tileGrids = sheet.tileGrids.filter(g => g.id !== gridId);
  sheet.tiles = sheet.tiles.filter(t => t.gridId !== gridId);
  for (const t of removed) scrubTileReferences(sheet, t.id);
}

export function detachTile(tile) {
  tile.gridId = null;
  tile.gridCol = undefined;
  tile.gridRow = undefined;
}
