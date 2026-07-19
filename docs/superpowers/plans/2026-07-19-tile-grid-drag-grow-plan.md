# Tile Grid Drag-to-Grow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tile-mode user grow a placed tile into a grid (and shrink a grid back into a tile) by dragging edge grips, and move a whole grid by dragging any of its tiles — mirroring sprite mode's strip-grow interaction, generalized from 1D to 2D.

**Architecture:** A pure-logic layer (`core/tilegrids.js`) gains `resizeGridAxis` (generalizes the existing `resizeGridCols`/`resizeGridRows` to grow/shrink from either end of either axis), `growTileIntoGrid` (promotes a standalone tile into a grid, reusing the tile object), and `collapseGridToTile` (the inverse, for when a grid shrinks to 1×1). The UI layer (`ui/tilemode.js`) adds a new `gridresize` pointer-drag kind with 4 edge-grip hit zones (mirrors `frames.js`'s `stripresize`/grip machinery, generalized to 4 sides), fixes a dead-end in the existing tile-drag handling so dragging a grid-owned tile's body moves the whole grid, and fixes a pre-existing bounds-clamping gap in grid movement.

**Tech Stack:** Vanilla JS, ES modules, `node --test` for unit tests, Canvas 2D for rendering. No new dependencies.

## Global Constraints

- No simulated pointer drags in Playwright (project convention) — all drag interactions in this plan are verified manually by the user, not automated in browser tests.
- Follow this codebase's established undo-command idiom exactly: mutate eagerly once, snapshot before/after, `do()`/`undo()` only ever assign snapshots — never re-invoke the mutating primitive inside `do()`/`undo()` (see `commitResizeGridCols`/`commitDeleteGrid`/`commitNewStripFromFrame` for the existing precedent).
- `resizeGridAxis`, `growTileIntoGrid`, `collapseGridToTile` are pure core primitives (like the functions they replace/extend) — they never push undo commands or call `markDirty()`/`emit()` themselves; that's always the UI-layer commit wrapper's job.
- Full test suite (`npm test`) must stay green (190 tests before this plan starts) after every task.
- Every drag-kind/ghost-rendering addition must match this file's existing code style: `ctx.save()`/`ctx.restore()` bracketing, the established `TILE_GHOST`/`TILE_HANDLE` color constants, the `strokeGhostRect`/`drawRectDims`/`drawChainDims`/`drawGridDims` helpers already in the file — do not introduce a parallel rendering convention.

---

### Task 1: `core/tilegrids.js` — resizeGridAxis, growTileIntoGrid, collapseGridToTile

**Files:**
- Modify: `js/core/tilegrids.js`
- Modify: `tests/tilegrids.test.mjs`

**Interfaces:**
- Produces: `resizeGridAxis(sheet, grid, axis, side, count)` → `{ added: Tile[], removed: Tile[] }`; `axis: 'cols' | 'rows'`; `side: 'start' | 'end'`; `count` is the new TOTAL cols/rows (not a delta), same contract as the functions it replaces.
- Produces: `growTileIntoGrid(sheet, tile, axis, side, count)` → `{ grid, added: Tile[], removed: [] }`.
- Produces: `collapseGridToTile(sheet, grid)` → the surviving `Tile`.
- Removes: `resizeGridCols`, `resizeGridRows` (both exports deleted — Task 2 and Task 4 update their only callers).

Current file for reference (`js/core/tilegrids.js`):
```js
// Persistent tile-grid geometry + mutation helpers. A grid owns a
// rectangular block of tiles (sheet.tiles entries with matching gridId);
// tile identity within a grid is (gridCol, gridRow), which is what lets a
// resize preserve an existing tile's name/neighbors instead of recreating
// it. Mirrors js/core/strips.js's role for animation strips: pure,
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
    for (const t of drop) scrubTileReferences(sheet, t.id);
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
    for (const t of drop) scrubTileReferences(sheet, t.id);
  }
  grid.rows = rows;
  return { added, removed };
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
```

- [ ] **Step 1: Write failing tests for `resizeGridAxis`'s `'end'` side (renamed from the existing `resizeGridCols`/`resizeGridRows` tests)**

In `tests/tilegrids.test.mjs`, change the import line:
```js
import {
  gridCellRect, createTileGrid, ownedTiles, relayoutGrid,
  resizeGridAxis, growTileIntoGrid, collapseGridToTile,
  moveGrid, removeTileGrid, detachTile,
} from '../js/core/tilegrids.js';
```

Replace the four tests that call `resizeGridCols`/`resizeGridRows` (currently named `'resizeGridCols: growing adds a trailing column, preserves existing tiles'`, `'resizeGridCols: shrinking removes the trailing column, pixels/tiles for it gone'`, `'resizeGridRows: growing/shrinking mirrors resizeGridCols for rows'`, and `'resizeGridCols shrink scrubs dropped tiles from other tiles\' neighbors and any terrain set\'s slots'`) with:

```js
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
```

- [ ] **Step 2: Run the renamed tests, confirm they fail**

Run: `npm test`
Expected: FAIL — `resizeGridAxis is not a function` (import error), since `js/core/tilegrids.js` doesn't export it yet.

- [ ] **Step 3: Write failing tests for `resizeGridAxis`'s `'start'` side (new behavior)**

Add to `tests/tilegrids.test.mjs`, after the 4 tests from Step 1:

```js
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
```

- [ ] **Step 4: Implement `resizeGridAxis`, remove `resizeGridCols`/`resizeGridRows`**

In `js/core/tilegrids.js`, replace the `resizeGridCols` and `resizeGridRows` functions (both, in their entirety) with:

```js
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
```

- [ ] **Step 5: Run tests, confirm the `resizeGridAxis` tests pass**

Run: `npm test`
Expected: The 8 `resizeGridAxis` tests (4 from Step 1 + 4 from Step 3) PASS. Other tests will still FAIL at this point (`createTileGrid`'s own tests etc. are unaffected and should already pass; only tests still referencing `resizeGridCols`/`resizeGridRows` by name would fail to import — there are none left after Step 1's replacement). If any test still imports the removed names, fix the import list now.

- [ ] **Step 6: Write failing tests for `growTileIntoGrid` and `collapseGridToTile`**

Add to `tests/tilegrids.test.mjs`:

```js
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
```

- [ ] **Step 7: Run tests, confirm the new tests fail**

Run: `npm test`
Expected: FAIL — `growTileIntoGrid is not a function` / `collapseGridToTile is not a function`.

- [ ] **Step 8: Implement `growTileIntoGrid` and `collapseGridToTile`**

In `js/core/tilegrids.js`, add after `resizeGridAxis`:

```js
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
```

- [ ] **Step 9: Run the full test file, confirm all tilegrids tests pass**

Run: `node --test tests/tilegrids.test.mjs`
Expected: All tests pass, pristine output, 0 failures.

- [ ] **Step 10: Update `tilemode.js`'s import of the removed functions (temporary — full removal of dead callers is Task 2)**

In `js/ui/tilemode.js`, change the `tilegrids.js` import line from:
```js
import {
  gridCellRect, ownedTiles, relayoutGrid, resizeGridCols, resizeGridRows,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
} from '../core/tilegrids.js';
```
to:
```js
import {
  gridCellRect, ownedTiles, relayoutGrid,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
} from '../core/tilegrids.js';
```
This will leave `commitResizeGridCols`/`commitResizeGridRows` (tilemode.js's dead-code UI wrappers, which call the now-removed `resizeGridCols`/`resizeGridRows`) as broken references. That's fine — Task 2 deletes those two dead functions entirely in the same file; this step only needs to get the import list correct so nothing else in the file breaks.

Immediately after changing the import, delete `commitResizeGridCols` and `commitResizeGridRows` (both function definitions in full) from `js/ui/tilemode.js` — they have no callers (confirmed dead code) and now reference removed imports.

- [ ] **Step 11: Run the full suite**

Run: `npm test`
Expected: All 190+ tests pass (190 existing + 11 new/renamed in tilegrids.test.mjs = 201... recount exactly from the actual run output), 0 failures, pristine.

- [ ] **Step 12: Commit**

```bash
git add js/core/tilegrids.js tests/tilegrids.test.mjs js/ui/tilemode.js
git commit -m "feat: add resizeGridAxis/growTileIntoGrid/collapseGridToTile, replacing resizeGridCols/resizeGridRows"
```

---

### Task 2: Remove the "Add Grid" dialog and button

**Files:**
- Modify: `js/ui/tilemode.js`

**Interfaces:**
- Consumes: nothing new (uses only what's already in the file).
- Produces: nothing new — this task only removes code. `commitAddGrid` and `createTileGrid` are explicitly KEPT (still used by `buildAddTerrainSetDialog`'s create handler for blob47 layout presets) — do not remove them.

- [ ] **Step 1: Remove the Add Grid dialog, its preview, and the preview-state variable**

In `js/ui/tilemode.js`, delete these three items in their entirety (they sit together, right before the `// ------------------------------------------------------------- terrain sets` comment):
- `let addGridPreviewOpts = null; // dialog's current field values while open, else null`
- `function drawAddGridPreview(ctx, view) { ... }` (the whole function)
- `function buildAddGridDialog() { ... }` (the whole function, ending at its closing `}` right before the terrain-sets comment)

- [ ] **Step 2: Remove the preview's call site in the ghost-render function**

In `drawTileToolGhost` (the function is kept — only this one line inside it goes away):
```js
  if (addGridPreviewOpts) drawAddGridPreview(ctx, view);
```
Delete this line entirely (it's the first statement inside the function body, right after the `if (!sheet) return;` guard).

- [ ] **Step 3: Remove the "➕ Grid" button from the Tiles panel**

In `mountTilePanel`, replace:
```js
  const addGridDialog = buildAddGridDialog();
  const btnAddGrid = document.createElement('button');
  btnAddGrid.type = 'button';
  btnAddGrid.className = 'btn-sm';
  btnAddGrid.textContent = '➕ Grid';
  btnAddGrid.title = 'Add grid';
  btnAddGrid.addEventListener('click', () => { if (activeSheet()) addGridDialog.open(); });

  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.className = 'btn-sm';
  btnAddTerrainSet.textContent = '➕ Autotiles';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });

  const btnRow = document.createElement('div');
  btnRow.className = 'row layer-actions';
  btnRow.append(btnAddGrid, btnAddTerrainSet);
  wrap.appendChild(btnRow);
```
with:
```js
  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.className = 'btn-sm';
  btnAddTerrainSet.textContent = '➕ Autotiles';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });

  const btnRow = document.createElement('div');
  btnRow.className = 'row layer-actions';
  btnRow.append(btnAddTerrainSet);
  wrap.appendChild(btnRow);
```

- [ ] **Step 4: Grep-verify no leftover references**

Run: `grep -n "buildAddGridDialog\|drawAddGridPreview\|addGridPreviewOpts\|btnAddGrid\b" js/ui/tilemode.js`
Expected: no output (zero matches).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests still pass (this task doesn't touch tested logic, only UI wiring).

- [ ] **Step 6: Manual browser verification**

Per project convention (no simulated drags, but plain clicks are fine to verify in Playwright): load the app, switch to Tile Sheets mode, confirm the Tiles panel shows only "➕ Autotiles" (no "➕ Grid"), confirm clicking "➕ Autotiles" still opens the "Add terrain set" dialog and (with a preset selected) still successfully creates a populated terrain set — this exercises `commitAddGrid`/`createTileGrid`, confirming they survived intact. Check console: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: remove Add Grid dialog and button, superseded by drag-to-grow"
```

---

### Task 3: Grid body-drag-to-move + bounds-clamp fix

**Files:**
- Modify: `js/ui/tilemode.js`

**Interfaces:**
- Consumes: `commitMoveGrid` (already exported from `core/tilegrids.js`, already imported in this file), `ownedTiles`, `drawGridDims` (already in this file).
- Produces: no new exports — extends existing `handleUp`'s `tiledrag` branch and the overlay-render function's `tiledrag` ghost branch.

Current relevant code (`js/ui/tilemode.js`, inside `handleUp`):
```js
  if (d.kind === 'tiledrag') {
    const from = d.from;
    const target = tileAt(sheet, ev.x, ev.y);
    if (target && target !== from && target.w === from.w && target.h === from.h) {
      if (d.shift) commitMoveTile(sheet, from, target);
      else commitSwapTile(sheet, from, target);
      state.selectedTileId = target.id;
      emit('selection');
      return;
    }
    if (from.gridId != null) return; // grid-owned, no same-size target: snaps back
    const dx = Math.max(-from.x, Math.min(sheet.width - (from.x + from.w), ev.x - d.anchor.x));
    const dy = Math.max(-from.y, Math.min(sheet.height - (from.y + from.h), ev.y - d.anchor.y));
    if (dx !== 0 || dy !== 0) commitMoveStandaloneTile(from, dx, dy);
    return;
  }
```

And inside `drawTileToolGhost`'s overlay drawing (dashed-stroke section):
```js
  } else if (drag.kind === 'tiledrag' && drag.to) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (swapCandidate) {
      ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
      strokeGhostRect(ctx, view, target);
    } else if (drag.from.gridId == null) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      strokeGhostRect(ctx, view, { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h });
    }
  }
```
and, right after that block (still inside the same function, in the dimension-label section):
```js
  } else if (drag.kind === 'tiledrag' && drag.to && drag.from.gridId == null) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (!swapCandidate) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      const r = { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h };
      drawRectDims(ctx, view, r, { dx, dy });
    }
  }
```

- [ ] **Step 1: Add a `gridBounds` helper**

In `js/ui/tilemode.js`, add this small function right after `hitGridHandle` (it will also be used by Task 4's grip geometry):

```js
// Outer bounding box of everything a grid owns, in sheet-space.
function gridBounds(grid) {
  return {
    x: grid.x, y: grid.y,
    w: grid.cols * (grid.cellW + grid.spacingX) - grid.spacingX,
    h: grid.rows * (grid.cellH + grid.spacingY) - grid.spacingY,
  };
}
```

- [ ] **Step 2: Fix the dead-end in `handleUp`'s `tiledrag` branch — move the whole grid instead of no-op**

Replace:
```js
    if (from.gridId != null) return; // grid-owned, no same-size target: snaps back
```
with:
```js
    if (from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === from.gridId);
      const bounds = gridBounds(grid);
      const dx = Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - d.anchor.x));
      const dy = Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - d.anchor.y));
      if (dx !== 0 || dy !== 0) commitMoveGrid(sheet, grid, dx, dy);
      return;
    }
```
(this also fixes `commitMoveGrid`'s total lack of bounds clamping for grid-owned tile body-drags; Step 4 below applies the same clamp to the pre-existing origin-handle `gridmove` path, which calls the same `commitMoveGrid` and has the identical gap today.)

- [ ] **Step 3: Add the ghost preview for the new grid-move case**

Replace:
```js
  } else if (drag.kind === 'tiledrag' && drag.to) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (swapCandidate) {
      ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
      strokeGhostRect(ctx, view, target);
    } else if (drag.from.gridId == null) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      strokeGhostRect(ctx, view, { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h });
    }
  }
```
with:
```js
  } else if (drag.kind === 'tiledrag' && drag.to) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (swapCandidate) {
      ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
      strokeGhostRect(ctx, view, target);
    } else if (drag.from.gridId == null) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      strokeGhostRect(ctx, view, { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h });
    } else {
      const grid = sheet.tileGrids.find(g => g.id === drag.from.gridId);
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      for (const t of ownedTiles(sheet, grid.id))
        strokeGhostRect(ctx, view, { x: t.x + dx, y: t.y + dy, w: t.w, h: t.h });
    }
  }
```

- [ ] **Step 4: Add the dimension label for the new grid-move case, and reuse the same clamp logic for the origin-handle move**

Replace:
```js
  } else if (drag.kind === 'tiledrag' && drag.to && drag.from.gridId == null) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (!swapCandidate) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      const r = { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h };
      drawRectDims(ctx, view, r, { dx, dy });
    }
  }
```
with:
```js
  } else if (drag.kind === 'tiledrag' && drag.to) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (swapCandidate) {
      // no label for a swap — matches today's behavior
    } else if (drag.from.gridId == null) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      const r = { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h };
      drawRectDims(ctx, view, r, { dx, dy });
    } else {
      const grid = sheet.tileGrids.find(g => g.id === drag.from.gridId);
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      drawGridDims(ctx, view, grid, { dx, dy });
    }
  }
```

(Note: this replacement changes the condition from `drag.kind === 'tiledrag' && drag.to && drag.from.gridId == null` to `drag.kind === 'tiledrag' && drag.to` with the gridId check moved inside — read the surrounding `if/else if` chain carefully before editing so the swap-case's existing "no label" behavior, which was implicit before via the old condition simply not matching for swaps, is preserved as an explicit no-op branch here.)

- [ ] **Step 5: Fix `commitMoveGrid`'s existing origin-handle path to use the same clamp**

Find the existing `gridmove` handling in `handleUp`:
```js
  if (d.kind === 'gridmove') {
    if (d.dx !== 0 || d.dy !== 0) commitMoveGrid(sheet, d.grid, d.dx, d.dy);
    return;
  }
```
and in `handleMove`:
```js
  } else if (drag.kind === 'gridmove') {
    drag.dx = ev.x - drag.anchor.x;
    drag.dy = ev.y - drag.anchor.y;
  }
```
Change `handleMove`'s `gridmove` branch to clamp using the same `gridBounds` helper:
```js
  } else if (drag.kind === 'gridmove') {
    const sheet = activeSheet();
    const bounds = gridBounds(drag.grid);
    drag.dx = sheet ? Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - drag.anchor.x)) : ev.x - drag.anchor.x;
    drag.dy = sheet ? Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - drag.anchor.y)) : ev.y - drag.anchor.y;
  }
```
(`handleUp`'s `gridmove` branch itself needs no change — `d.dx`/`d.dy` are already clamped by the time `handleUp` reads them, since `handleUp` calls `handleMove(ev, view)` first thing.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests pass (this task is pure UI/interaction code with no unit-test seam, per the design spec's Testing section — no new automated tests are added here).

- [ ] **Step 7: Manual browser verification**

Per project convention (pointer drags are verified manually, not simulated in Playwright) — the user verifies: dragging a grid-owned tile's body (not onto another same-size tile) moves the whole grid with a live ghost preview and dimension label; dropping onto a same-size tile still swaps as before; the small origin-handle move still works and now also can't drag the grid off-sheet; a grid can't be dragged (by either method) past the sheet's edges.

- [ ] **Step 8: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "fix: dragging a grid tile's body moves the whole grid; clamp grid moves to sheet bounds"
```

---

### Task 4: Edge-grip grow/shrink — the `gridresize` drag kind

**Files:**
- Modify: `js/ui/tilemode.js`
- Modify: `js/ui/dimlabels.js`

**Interfaces:**
- Consumes: `resizeGridAxis`, `growTileIntoGrid`, `collapseGridToTile` (Task 1, `core/tilegrids.js`); `gridBounds` (Task 3, same file).
- Produces: no new exports — extends `handleDown`/`handleMove`/`handleUp`, `drawTileToolGhost`, `drawTileChrome` (all already in `tilemode.js`), and extends `drawRectDims`'s options in `dimlabels.js`.

- [ ] **Step 1: Extend `drawRectDims` to accept `dw`/`dh` pixel-delta overrides (dimlabels.js)**

Read `js/ui/dimlabels.js`'s current `drawRectDims` (already accepts `opts.dw`/`opts.dh` per its own doc comment — verify this before editing; if the delta wiring is already present and working exactly as documented, this step is a no-op and should be skipped, noted in the implementer's report rather than silently done). If it needs no change, move directly to Step 2.

- [ ] **Step 2: Add `dw`/`dh` passthrough to `drawGridDims` (tilemode.js)**

Current `drawGridDims`:
```js
function drawGridDims(ctx, view, grid, opts = {}) {
  const dx = opts.dx ?? 0, dy = opts.dy ?? 0;
  const shifted = (dx || dy) ? { ...grid, x: grid.x + dx, y: grid.y + dy } : grid;
  const alpha = opts.quiet ? 0.7 : 1;
  const last = gridCellRect(shifted, grid.cols - 1, grid.rows - 1);
  const bottomRow = Array.from({ length: grid.cols }, (_, col) => gridCellRect(shifted, col, grid.rows - 1));
  const rightCol = Array.from({ length: grid.rows }, (_, row) => gridCellRect(shifted, grid.cols - 1, row));
  drawChainDims(ctx, view, {
    axis: 'h', edge: last.y + last.h,
    spans: bottomRow.map(r => ({ from: r.x, to: r.x + r.w, text: `${r.w}` })),
    alpha,
  });
  drawChainDims(ctx, view, {
    axis: 'v', edge: last.x + last.w,
    spans: rightCol.map(r => ({ from: r.y, to: r.y + r.h, text: `${r.h}` })),
    alpha,
  });
  const overall = { x: shifted.x, y: shifted.y, w: last.x + last.w - shifted.x, h: last.y + last.h - shifted.y };
  drawRectDims(ctx, view, overall, { quiet: opts.quiet, dx: opts.dx, dy: opts.dy, wLevel: 1, hLevel: 1 });
}
```
Change only the final `drawRectDims` call's opts object to also pass through `dw`/`dh`:
```js
  drawRectDims(ctx, view, overall, { quiet: opts.quiet, dx: opts.dx, dy: opts.dy, dw: opts.dw, dh: opts.dh, wLevel: 1, hLevel: 1 });
```
(Everything else in the function is unchanged — this is a one-line edit to the last statement.)

- [ ] **Step 3: Add grip geometry and hit-testing**

Add these two functions right after `gridBounds` (Task 3, Step 1):

```js
// 4 edge-strip hit zones (screen space) around `bounds` (sheet-space
// {x,y,w,h}) -- either a standalone tile's own rect, or a grid's outer
// bounding box. Mirrors frames.js's standaloneGripGeometry/
// chromeGeometry grips, generalized from 2 sides (left/right) to 4.
function tileGripGeometry(view, bounds) {
  const p0 = view.imageToScreen(bounds.x, bounds.y);
  const p1 = view.imageToScreen(bounds.x + bounds.w, bounds.y + bounds.h);
  return [
    { axis: 'cols', side: 'start', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { axis: 'cols', side: 'end', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { axis: 'rows', side: 'start', x: p0.x, y: p0.y - 3, w: p1.x - p0.x, h: 6 },
    { axis: 'rows', side: 'end', x: p0.x, y: p1.y - 3, w: p1.x - p0.x, h: 6 },
  ];
}

function hitTileGrip(grips, sx, sy) {
  for (const g of grips)
    if (sx >= g.x - 2 && sx <= g.x + g.w + 2 && sy >= g.y - 2 && sy <= g.y + g.h + 2)
      return { axis: g.axis, side: g.side };
  return null;
}
```

- [ ] **Step 4: Wire grip hit-testing into `handleDown`**

Current `handleDown` (relevant excerpt, after the existing `gridHit`/`handle` checks, before the `tileAt` hit-test):
```js
  const selected = sheet.tiles.find(t => t.id === state.selectedTileId) || null;
  const handle = hitHandle(view, selected, ev.sx, ev.sy);
  if (handle) {
    drag = {
      kind: 'resize', tile: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      anchor: oppositeCorner(selected, handle),
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }

  const hit = tileAt(sheet, ev.x, ev.y);
```
Insert a new grip check between the `handle` block and `const hit = tileAt(...)`:
```js
  const selected = sheet.tiles.find(t => t.id === state.selectedTileId) || null;
  const handle = hitHandle(view, selected, ev.sx, ev.sy);
  if (handle) {
    drag = {
      kind: 'resize', tile: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      anchor: oppositeCorner(selected, handle),
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }

  if (selected) {
    const grid = selected.gridId != null ? sheet.tileGrids.find(g => g.id === selected.gridId) : null;
    const bounds = grid ? gridBounds(grid) : { x: selected.x, y: selected.y, w: selected.w, h: selected.h };
    const gripHit = hitTileGrip(tileGripGeometry(view, bounds), ev.sx, ev.sy);
    if (gripHit) {
      const step = gripHit.axis === 'cols'
        ? (grid ? grid.cellW + grid.spacingX : selected.w)
        : (grid ? grid.cellH + grid.spacingY : selected.h);
      const count0 = grid ? (gripHit.axis === 'cols' ? grid.cols : grid.rows) : 1;
      drag = {
        kind: 'gridresize', axis: gripHit.axis, side: gripHit.side,
        grid, tile: selected, step, bbox: bounds, count0, count: count0,
      };
      view.requestRender();
      return;
    }
  }

  const hit = tileAt(sheet, ev.x, ev.y);
```

- [ ] **Step 5: Add `gridresize` to `handleMove`**

Current `handleMove`:
```js
function handleMove(ev, view) {
  if (!drag) return;
  if (drag.kind === 'create') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true);
  } else if (drag.kind === 'resize') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false);
  } else if (drag.kind === 'gridmove') {
    ... (already changed by Task 3, Step 5)
  } else if (drag.kind === 'tiledrag') {
    drag.to = { x: ev.x, y: ev.y };
    drag.shift = ev.shiftKey;
  }
  view.requestRender();
}
```
Add a new branch (order among the `else if`s doesn't matter, append at the end before the closing brace):
```js
  } else if (drag.kind === 'gridresize') {
    const raw = drag.side === 'end'
      ? (drag.axis === 'cols' ? ev.x - (drag.bbox.x + drag.bbox.w) : ev.y - (drag.bbox.y + drag.bbox.h))
      : (drag.axis === 'cols' ? drag.bbox.x - ev.x : drag.bbox.y - ev.y);
    let count = drag.count0 + Math.round(raw / drag.step);
    count = Math.max(1, count);
    const sheet = activeSheet();
    if (sheet) {
      const maxCount = drag.axis === 'cols'
        ? (drag.side === 'end'
            ? Math.floor((sheet.width - drag.bbox.x) / drag.step)
            : Math.floor((drag.bbox.x + drag.bbox.w) / drag.step))
        : (drag.side === 'end'
            ? Math.floor((sheet.height - drag.bbox.y) / drag.step)
            : Math.floor((drag.bbox.y + drag.bbox.h) / drag.step));
      count = Math.min(count, Math.max(1, maxCount));
    }
    drag.count = count;
  }
```

- [ ] **Step 6: Add the two commit functions**

Add near the other `commit*` functions (e.g. right after `commitMoveGrid`):

```js
function commitGrowTileIntoGrid(sheet, tile, axis, side, count) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const { grid } = growTileIntoGrid(sheet, tile, axis, side, count);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const tileId = tile.id;
  state.commands.push({
    label: 'grow tile into grid',
    do() {
      sheet.tileGrids = afterGrids.slice();
      sheet.tiles = afterTiles.slice();
      state.selectedTileId = tileId;
    },
    undo() {
      sheet.tileGrids = beforeGrids.slice();
      sheet.tiles = beforeTiles.slice();
      state.selectedTileId = tileId;
    },
  });
  markDirty();
  emit('selection');
}

function commitResizeGridAxis(sheet, grid, axis, side, count) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  resizeGridAxis(sheet, grid, axis, side, count);
  let survivorId = null;
  if (grid.cols === 1 && grid.rows === 1) {
    survivorId = collapseGridToTile(sheet, grid).id;
  }
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'resize grid',
    do() {
      sheet.tileGrids = afterGrids.slice();
      sheet.tiles = afterTiles.slice();
      if (survivorId) state.selectedTileId = survivorId;
    },
    undo() {
      sheet.tileGrids = beforeGrids.slice();
      sheet.tiles = beforeTiles.slice();
    },
  });
  markDirty();
  if (survivorId) emit('selection');
}
```

Add the import for the three new `tilegrids.js` functions (extend the import line touched in Task 1 Step 10):
```js
import {
  gridCellRect, ownedTiles, relayoutGrid,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
  resizeGridAxis, growTileIntoGrid, collapseGridToTile,
} from '../core/tilegrids.js';
```

- [ ] **Step 7: Wire `gridresize` into `handleUp`**

Add a new branch in `handleUp` (anywhere among the existing `if (d.kind === ...)` blocks, e.g. right after the `tiledrag` block):
```js
  if (d.kind === 'gridresize') {
    if (d.count === d.count0) return;
    if (d.grid) commitResizeGridAxis(sheet, d.grid, d.axis, d.side, d.count);
    else commitGrowTileIntoGrid(sheet, d.tile, d.axis, d.side, d.count);
    return;
  }
```

- [ ] **Step 8: Add ghost rendering for the in-progress `gridresize` drag**

Add a helper right after `hitTileGrip` (Step 3):
```js
// A synthetic grid-shaped object representing the LIVE state of an
// in-progress gridresize drag, for rendering only -- never touches real
// sheet data. Works uniformly whether d.grid is set (existing grid being
// resized) or null (a standalone tile being dragged into a brand-new
// grid): cellW/cellH/spacing fall back to the dragged tile's own size
// with no spacing when there's no real grid yet.
function ghostGridFor(d) {
  const cellW = d.grid ? d.grid.cellW : (d.axis === 'rows' ? d.tile.w : d.step);
  const cellH = d.grid ? d.grid.cellH : (d.axis === 'cols' ? d.tile.h : d.step);
  const spacingX = d.grid ? d.grid.spacingX : 0;
  const spacingY = d.grid ? d.grid.spacingY : 0;
  const cols = d.axis === 'cols' ? d.count : (d.grid ? d.grid.cols : 1);
  const rows = d.axis === 'rows' ? d.count : (d.grid ? d.grid.rows : 1);
  let x = d.bbox.x, y = d.bbox.y;
  if (d.axis === 'cols' && d.side === 'start') x = d.bbox.x + d.bbox.w - (cols * (cellW + spacingX) - spacingX);
  if (d.axis === 'rows' && d.side === 'start') y = d.bbox.y + d.bbox.h - (rows * (cellH + spacingY) - spacingY);
  return { x, y, cellW, cellH, cols, rows, spacingX, spacingY };
}
```

In `drawTileToolGhost`'s dashed-stroke section, add a branch (alongside the existing `create`/`resize`/`gridmove`/`tiledrag` branches):
```js
  else if (drag.kind === 'gridresize') strokeGhostRect(ctx, view, gridBounds(ghostGridFor(drag)));
```

In the dimension-label section (the second `if/else if` chain in the same function), add:
```js
  } else if (drag.kind === 'gridresize') {
    drawGridDims(ctx, view, ghostGridFor(drag), {
      dw: drag.axis === 'cols' ? (drag.count - drag.count0) * drag.step : 0,
      dh: drag.axis === 'rows' ? (drag.count - drag.count0) * drag.step : 0,
    });
  }
```

- [ ] **Step 9: Show visible grips in idle chrome (`drawTileChrome`)**

Current `drawTileChrome`:
```js
export function drawTileChrome(ctx, view) {
  if (state.mode !== 'tiles' || state.tool !== 'tiletool' || drag) return;
  const sheet = activeSheet();
  if (!sheet) return;
  const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
  if (!tile) return;
  if (tile.gridId != null) {
    const grid = sheet.tileGrids.find(g => g.id === tile.gridId);
    if (grid) drawGridDims(ctx, view, grid, { quiet: true });
  } else {
    drawRectDims(ctx, view, tile, { quiet: true });
    drawTileHandles(ctx, view, tile);
  }
}
```
Add a small grip-drawing helper right after `drawTileHandles`:
```js
// Visible edge-grip squares -- mirrors frames.js's drawGrips look
// (filled blue rects), no hover-highlight tracking (out of scope for
// this pass; frames.js's hover state is a bigger refactor than this
// feature needs).
function drawTileGrips(ctx, grips) {
  ctx.save();
  ctx.fillStyle = TILE_HANDLE;
  ctx.globalAlpha = 0.7;
  for (const g of grips) ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.restore();
}
```
Then change `drawTileChrome` to:
```js
export function drawTileChrome(ctx, view) {
  if (state.mode !== 'tiles' || state.tool !== 'tiletool' || drag) return;
  const sheet = activeSheet();
  if (!sheet) return;
  const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
  if (!tile) return;
  if (tile.gridId != null) {
    const grid = sheet.tileGrids.find(g => g.id === tile.gridId);
    if (grid) {
      drawGridDims(ctx, view, grid, { quiet: true });
      drawTileGrips(ctx, tileGripGeometry(view, gridBounds(grid)));
    }
  } else {
    drawRectDims(ctx, view, tile, { quiet: true });
    drawTileHandles(ctx, view, tile);
    drawTileGrips(ctx, tileGripGeometry(view, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }));
  }
}
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: all tests pass (this task adds no new unit-testable pure logic beyond what Task 1 already covers — see the design spec's Testing section for why the drag/ghost code itself has no unit-test seam).

- [ ] **Step 11: Manual browser verification**

Per project convention (no simulated drags in Playwright) — the user verifies, for a freshly placed standalone tile: each of the 4 edge grips is visible when the tile is selected; dragging the right grip out grows a new grid to the right (ghost + dimension label update live, original tile stays in col 0); dragging the left grip out grows to the left (original tile's on-screen position doesn't jump, ends up at the far column); same for top/bottom (rows); dragging an edge grip back to 1 cell on an existing multi-cell grid collapses it back to a standalone tile (corner handles reappear, edge grips reappear on the tile's own rect); growth/shrink stops at the sheet's edges; undo/redo restores the pre-drag state correctly at every step; console shows 0 errors throughout.

- [ ] **Step 12: Commit**

```bash
git add js/ui/tilemode.js js/ui/dimlabels.js
git commit -m "feat: drag-to-grow tile grids via 4 edge grips (create, grow, shrink, collapse)"
```

---

## Self-Review

**Spec coverage:**
- "End-grip resize only" (no mid-grid insert/split) — Task 4 implements exactly 4 edge grips, no insert/split call-outs. ✓
- "Add Grid dialog removed entirely" — Task 2. ✓
- "commitAddGrid/createTileGrid stay (terrain-set preset flow)" — Task 2 explicitly does not touch them; Task 2 Step 6 manually verifies the terrain-set flow still works. ✓
- "resizeGridAxis generalizes resizeGridCols/resizeGridRows, replacing them" — Task 1. ✓
- "growTileIntoGrid reuses the original tile, doesn't call createTileGrid" — Task 1 Step 8. ✓
- "collapseGridToTile on shrink to 1×1" — Task 1 Step 8 (primitive) + Task 4 Step 6 (`commitResizeGridAxis` calling it at the right moment). ✓
- "No pixel-shifting needed, algebra proof" — Task 1's `resizeGridAxis` 'start' tests directly assert existing tiles' x/y are unchanged. ✓
- "Bounds clamping on grow" — Task 4 Step 5 (`handleMove`'s `gridresize` branch). ✓
- "Grid body-drag-to-move" — Task 3. ✓
- "commitMoveGrid bounds-clamp fix, covers both paths" — Task 3 Steps 2 and 5 both route through the same `gridBounds`-based clamp. ✓
- "Eager-mutate-then-snapshot undo idiom" — Task 4 Step 6's two commit functions follow it explicitly. ✓
- Testing section ("no pure-logic seam for the drag/ghost code, manual verification only") — Tasks 3 and 4 have no new unit tests for UI code, matching the spec; Task 1 has full unit coverage for the pure logic. ✓

**Placeholder scan:** no TBD/TODO, no "add appropriate handling", every step has real code or an exact `grep`/`npm test` command with an expected result.

**Type/signature consistency:** `resizeGridAxis(sheet, grid, axis, side, count)` used identically across Task 1 (definition + tests), Task 4 Steps 4/6/7 (call sites). `growTileIntoGrid(sheet, tile, axis, side, count)` and `collapseGridToTile(sheet, grid)` likewise consistent between Task 1 and Task 4. `gridBounds(grid)` defined once in Task 3 Step 1, reused by Task 3 Step 5 and Task 4 Steps 4/9 without redefinition.

**One gap flagged, not a placeholder:** Task 4 Step 1 asks the implementer to verify `drawRectDims`'s `dw`/`dh` wiring already works as documented before assuming it needs no change — this is because the plan author (me) read the doc comment claiming `dw`/`dh` support but did not exhaustively trace every line proving it end-to-end; the implementer must confirm this cheaply (read ~15 lines) rather than the plan asserting it blindly.

## Execution Handoff

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Given Task 1 is pure/independently testable, Task 2 and Task 3 are both small and independent of Task 1's new exports, and Task 4 is the large piece that depends on Task 1, a reasonable cluster is: Task 1 alone (foundation, needs its own careful review of the algebra), Task 2 alone (small, quick), Task 3 alone (small, quick, independent), Task 4 alone (large, depends on Task 1) — or cluster 2+3 together since both are small independent tilemode.js edits with no shared risk.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
