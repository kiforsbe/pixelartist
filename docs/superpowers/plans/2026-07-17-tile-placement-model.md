# Tile Placement Model (Grids + Standalone Tiles) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the tile sheet's implicit "one uniform grid covers the whole
sheet" model with explicit, persistent grid objects and standalone tile
frames that coexist freely, per
`docs/superpowers/specs/2026-07-17-tile-placement-model-design.md`.

**Architecture:** `sheet.tile` (a settings object) is replaced by
`sheet.tileGrids` (persistent grid geometry) + `sheet.tiles` (a flat,
id-based array of tile records — grid-owned or standalone — mirroring how
`sheet.frames` already works). A new pure core module,
`js/core/tilegrids.js`, holds grid geometry + create/resize/move/detach
logic (mirrors `js/core/strips.js`'s role for animation strips). The tile
tool (`js/ui/tilemode.js`), the tile editor (`js/ui/tileeditor.js`), the
sheet overlays (`js/ui/overlays.js`), and the exporter
(`js/app/exports.js`) are updated to read/write the new shape. Tile
identity moves from array index to `id`, matching frames
(`state.selectedFrameId`/`editingFrameId`).

**Tech Stack:** Vanilla JS (ES modules), `node --test` for unit tests
(`tests/*.mjs`), Canvas 2D for rendering. No build step, no framework.

## Global Constraints

- `PROJECT_VERSION` stays 2 — this is a same-version shape migration, not a
  version bump.
- Every mutating operation on tiles/grids goes through the codebase's
  existing "eager mutate, then push a command whose `do()`/`undo()` replay
  that state" idiom (`state.commands.push(cmd)` — note `CommandStack.push`
  calls `cmd.do()` immediately, so `do()` must be idempotent whether invoked
  from `push()` or `redo()`). See `js/ui/frames.js`'s `commitCreate`/
  `commitResizeSegment` for the canonical shape.
- Every new/renamed exported function must have its call sites updated in
  the same task where feasible; where a later task is the natural owner of a
  call site (e.g. `js/ui/tilemode.js`'s own rewrite), leaving it temporarily
  unreferenced by an earlier task is fine — `node --test` doesn't import
  DOM-dependent UI files, so intermediate states between tasks don't fail
  the automated suite.
- Drags are never simulated in Playwright in this repo — the project owner
  verifies drag/resize/swap interactions manually. Automated coverage is
  unit tests (`tests/*.mjs`) for pure logic; UI tasks get a manual
  verification checklist instead of a Playwright script.
- Run `npm test` after every task; it must stay green throughout.

---

## File structure

Create:
- `js/core/tilegrids.js` — pure grid geometry + create/resize/move/detach
  helpers (mirrors `js/core/strips.js`'s role for strips).
- `tests/tilegrids.test.mjs` — unit tests for the above.

Modify:
- `js/core/model.js` — `sheet.tileGrids`/`sheet.tiles` replace `sheet.tile`;
  remove `tileCount`/`tileRect`; migrate legacy shape on load.
- `js/core/neighbors.js` — presets keyed on a tile record directly instead
  of a `sheet.tile.neighbors[index]` side-map; cross-tile references become
  `tileId` instead of `tileIndex`.
- `js/app/exports.js` — `buildTilesJson` reads `sheet.tiles` directly,
  resolves `tileId` → export-time `tileIndex`.
- `js/app/state.js` — `selectedTileIndex`/`editingTileIndex` →
  `selectedTileId`/`editingTileId`; `newDefaultProject` stops passing
  `tileW`/`tileH` to `createSheet`.
- `js/ui/overlays.js` — `drawTileOverlays` iterates `sheet.tiles` directly.
- `js/ui/tilemode.js` — full rewrite: grid-aware hit-testing, create/move/
  resize/swap/detach, grid CRUD, Add Grid dialog, tile/grid panel.
- `js/ui/tileeditor.js` — id-based tile lookup, per-tile cell size, neighbor
  slot dialog's "other tile" input becomes a `<select>`.
- `js/app/main.js` — id-based selection clears; New Sheet dialog stops
  asking for tile size (tile sheets no longer need it upfront).
- `index.html` — remove the New Sheet dialog's now-unused tile-size row.
- `tests/model.test.mjs`, `tests/neighbors.test.mjs`, `tests/exports.test.mjs`
  — updated for the new shapes.
- `tests/smoke.md` — sections 8 (Tile mode) and 9 (Tile editor) rewritten
  for the new interactions.

---

### Task 1: Core data model (`sheet.tileGrids` + `sheet.tiles`)

**Files:**
- Modify: `js/core/model.js`
- Test: `tests/model.test.mjs`

**Interfaces:**
- Produces: `createSheet(project, { name, width, height, kind })` (drops
  `tileW`/`tileH` params — extra keys passed by not-yet-updated callers are
  harmless, destructuring ignores them). `sheet.tileGrids: []` and
  `sheet.tiles: []` for `kind === 'tile'`, both `null` otherwise (mirrors
  `sheet.tile` being `null` for sprite sheets today).
- Consumes: `newId` from `js/core/palettes.js` (already imported).

- [ ] **Step 1: Write the failing tests**

Replace the existing `'tile helpers'` and `'createSheet tile kind honors
tileW/tileH'` tests in `tests/model.test.mjs` (they reference the removed
`tileCount`/`tileRect`/`tileW` shape) with:

```js
test('createSheet tile kind starts with empty grids/tiles', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'x', width: 64, height: 64, kind: 'tile' });
  assert.deepEqual(s.tileGrids, []);
  assert.deepEqual(s.tiles, []);
});

test('createSheet sprite kind has null tileGrids/tiles', () => {
  const { s } = proj();
  assert.equal(s.tileGrids, null);
  assert.equal(s.tiles, null);
});

test('serialize/deserialize round-trips tileGrids and tiles', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'Tiles', width: 32, height: 16, kind: 'tile' });
  s.tileGrids.push({ id: 'tg1', x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1, spacingX: 0, spacingY: 0 });
  s.tiles.push({ id: 'ti1', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: 'tg1', gridCol: 0, gridRow: 0, neighbors: undefined });
  s.tiles.push({ id: 'ti2', x: 16, y: 0, w: 16, h: 16, name: undefined, gridId: 'tg1', gridCol: 1, gridRow: 0, neighbors: { n: { mode: 'empty', tileId: null, flipH: false, flipV: false } } });
  const { json, images } = serializeProject(p);
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  const s2 = p2.sheets[0];
  assert.deepEqual(s2.tileGrids, s.tileGrids);
  assert.equal(s2.tiles.length, 2);
  assert.equal(s2.tiles[0].name, 'grass');
  assert.deepEqual(s2.tiles[1].neighbors, { n: { mode: 'empty', tileId: null, flipH: false, flipV: false } });
});

test('deserializeProject migrates legacy sheet.tile shape into one grid + tiles', () => {
  const legacy = {
    version: 2, name: 't',
    settings: DEFAULT_SETTINGS,
    activePaletteId: null, palettes: [],
    sheets: [{
      id: 's1', name: 'Ground', width: 32, height: 16, kind: 'tile',
      tile: {
        tileWidth: 16, tileHeight: 16,
        names: { 1: 'grass' },
        neighbors: { 1: { e: { mode: 'tile', tileIndex: 0, flipH: true, flipV: false } } },
      },
      frames: [], animations: [],
      layerTree: { id: 'root', type: GROUP, name: 'root', animationId: null, open: true, children: [
        { id: 'ly1', type: LAYER, name: 'Layer 1', visible: true, opacity: 1, image: 'images/s1/ly1.png' },
      ] },
    }],
  };
  const bitmap = createBitmap(32, 16);
  const p2 = deserializeProject(legacy, new Map([['images/s1/ly1.png', bitmap]]));
  const s2 = p2.sheets[0];
  assert.equal(s2.tileGrids.length, 1);
  assert.deepEqual(s2.tileGrids[0], { id: s2.tileGrids[0].id, x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1, spacingX: 0, spacingY: 0 });
  assert.equal(s2.tiles.length, 2);
  const t0 = s2.tiles.find(t => t.gridCol === 0 && t.gridRow === 0);
  const t1 = s2.tiles.find(t => t.gridCol === 1 && t.gridRow === 0);
  assert.equal(t0.name, undefined);
  assert.equal(t1.name, 'grass');
  assert.deepEqual(t1.neighbors.e, { mode: 'tile', tileIndex: 0, flipH: true, flipV: false });
});
```

Add `createBitmap` and `GROUP`/`LAYER` to the test file's existing imports
(`GROUP`/`LAYER` are already exported by `js/core/model.js`; `createBitmap`
from `js/core/pixels.js`, already imported for `setPixel`/`getPixel` — add
`createBitmap` to that import line). Remove `tileCount`, `tileRect` from the
`model.js` import line at the top of the test file (no longer exported).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tileCount`/`tileRect` import error, or `s.tileGrids` is
`undefined` (old shape still has `s.tile`).

- [ ] **Step 3: Implement the model changes**

In `js/core/model.js`:

Replace `createSheet` (lines 43-58):

```js
export function createSheet(project, { name, width, height, kind }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM)
    throw new Error(`sheet size must be 1..${MAX_DIM}`);
  const root = createGroupNode(name);
  root.children.push(createLayerNode('Layer 1', width, height));
  const sheet = {
    id: newId('sh'), name, width, height, kind,
    layerTree: root, frames: [], animations: [],
    tileGrids: kind === 'tile' ? [] : null,
    tiles: kind === 'tile' ? [] : null,
  };
  project.sheets.push(sheet);
  return sheet;
}
```

Remove `tileCount`/`tileRect` (lines 293-306) entirely.

Replace the `tile: s.tile ? structuredClone(s.tile) : null,` line inside
`serializeProject` with:

```js
tileGrids: s.tileGrids ? s.tileGrids.map(g => ({ ...g })) : null,
tiles: s.tiles ? s.tiles.map(t => ({ ...t, neighbors: t.neighbors ? { ...t.neighbors } : undefined })) : null,
```

Add a migration helper above `deserializeProject`:

```js
// Legacy sheets stored one uniform grid as sheet.tile = { tileWidth,
// tileHeight, names, neighbors }, with every tile's identity implied by its
// row-major array index. Synthesize the equivalent explicit grid + tiles;
// name/neighbors carry over unchanged (js/core/neighbors.js's Phase A
// re-key handles the neighbor shape itself; this only reproduces the old
// per-index assignment).
function migrateLegacyTile(sheetJson) {
  const t = sheetJson.tile;
  const cols = Math.floor(sheetJson.width / t.tileWidth);
  const rows = Math.floor(sheetJson.height / t.tileHeight);
  const grid = { id: newId('tg'), x: 0, y: 0, cellW: t.tileWidth, cellH: t.tileHeight, cols, rows, spacingX: 0, spacingY: 0 };
  const tiles = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      tiles.push({
        id: newId('ti'), x: col * t.tileWidth, y: row * t.tileHeight, w: t.tileWidth, h: t.tileHeight,
        name: t.names?.[index], gridId: grid.id, gridCol: col, gridRow: row,
        neighbors: t.neighbors?.[index] ? { ...t.neighbors[index] } : undefined,
      });
    }
  }
  return { tileGrids: [grid], tiles };
}
```

In `deserializeProject`'s sheet mapping, replace `tile: s.tile ?? null,`
with:

```js
...(() => {
  if (s.kind !== 'tile') return { tileGrids: null, tiles: null };
  if (!s.tiles && s.tile) return migrateLegacyTile(s);
  return { tileGrids: s.tileGrids ?? [], tiles: s.tiles ?? [] };
})(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add js/core/model.js tests/model.test.mjs
git commit -m "$(cat <<'EOF'
refactor: replace sheet.tile with sheet.tileGrids + sheet.tiles

Phase A of the tile placement model overhaul. Tiles are now explicit,
id-based records (mirroring sheet.frames) instead of an implicit grid
computed from sheet.tile.tileWidth/tileHeight. Legacy projects migrate
on load: one grid + one tile per old cell, name/neighbors carried over.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Grid geometry + mutation helpers (`js/core/tilegrids.js`)

**Files:**
- Create: `js/core/tilegrids.js`
- Create: `tests/tilegrids.test.mjs`

**Interfaces:**
- Consumes: `newId` from `js/core/palettes.js`.
- Produces (used by Task 6/7's `js/ui/tilemode.js` and Task 4's
  `js/app/exports.js` tests):
  - `gridCellRect(grid, col, row) → { x, y, w, h }`
  - `createTileGrid(sheet, { x, y, cellW, cellH, cols, rows, spacingX = 0, spacingY = 0 }) → { grid, tiles }`
  - `ownedTiles(sheet, gridId) → Tile[]`
  - `relayoutGrid(sheet, grid)` — recomputes every owned tile's `x/y/w/h`
    from current grid geometry.
  - `resizeGridCols(sheet, grid, cols) → { added: Tile[], removed: Tile[] }`
  - `resizeGridRows(sheet, grid, rows) → { added: Tile[], removed: Tile[] }`
  - `moveGrid(sheet, grid, dx, dy)` — shifts `grid.x/y` and relayouts.
  - `removeTileGrid(sheet, gridId)` — removes the grid and its owned tiles.
  - `detachTile(tile)` — clears `gridId`/`gridCol`/`gridRow`.

- [ ] **Step 1: Write the failing tests**

Create `tests/tilegrids.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../js/core/tilegrids.js'`.

- [ ] **Step 3: Implement `js/core/tilegrids.js`**

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add js/core/tilegrids.js tests/tilegrids.test.mjs
git commit -m "$(cat <<'EOF'
feat: add core/tilegrids.js — persistent grid geometry + resize/move/detach

Pure, DOM-free grid helpers mirroring core/strips.js's role for strips:
cell rect math, create/resize (col/row add-remove-at-trailing-edge)/move/
remove/detach, all operating directly on sheet.tileGrids + sheet.tiles.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Neighbor presets keyed on the tile record (`js/core/neighbors.js`)

**Files:**
- Modify: `js/core/neighbors.js`
- Test: `tests/neighbors.test.mjs`

**Interfaces:**
- Produces: `defaultPreset()` (unchanged shape, but slot field renamed
  `tileIndex`→`tileId`), `getPreset(tile) → preset`, `setSlot(tile, dir,
  slot)`, `resolveNeighborGrid(preset, centerTileId, radius = 1) → [{ dx,
  dy, tileId, flipH, flipV }]`. No `sheet` parameter anymore — neighbors
  live directly on the tile record (`tile.neighbors`), so callers no longer
  need to pass the sheet in.
- Consumed by: Task 4 (`exports.js`), Task 6/7 (`tilemode.js`'s swap/move
  commands, via `tile.neighbors` directly — no `neighbors.js` calls needed
  there since it's a plain field copy), Task 8 (`tileeditor.js`).

**Rationale for the `tileIndex`→`tileId` rename:** a neighbor slot's "other
tile" reference must survive tiles being added/removed elsewhere in the
array (grid resize, standalone delete) without silently pointing at the
wrong tile after a splice shifts everyone's array position. The codebase's
existing convention for exactly this situation is animation frame entries
referencing frames by `frameId`, not array index (`js/core/model.js`'s
`anim.frames: [{ frameId, duration }]`) — this applies the same pattern to
neighbor slots. Export-time, the id is resolved back to an index (Task 4)
so the exported shape stays the same as today's.

- [ ] **Step 1: Write the failing tests**

Replace `tests/neighbors.test.mjs` entirely:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tileIndex` vs `tileId` mismatches, and `getPreset(tile)`
called with one argument still expects `(sheet, tileIndex)`.

- [ ] **Step 3: Implement**

Replace `js/core/neighbors.js` entirely:

```js
export const NEIGHBOR_DIRS = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

const DIR_BY_DELTA = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};

function emptySlot() { return { mode: 'same', tileId: null, flipH: false, flipV: false }; }

export function defaultPreset() {
  const p = {};
  for (const d of NEIGHBOR_DIRS) p[d] = emptySlot();
  return p;
}

export function getPreset(tile) {
  const p = defaultPreset();
  if (tile.neighbors) for (const d of NEIGHBOR_DIRS) if (tile.neighbors[d]) p[d] = { ...tile.neighbors[d] };
  return p;
}

export function setSlot(tile, dir, slot) {
  if (!tile.neighbors) tile.neighbors = defaultPreset();
  tile.neighbors[dir] = { ...slot };
}

export function resolveNeighborGrid(preset, centerTileId, radius = 1) {
  const cells = [];
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const dir = DIR_BY_DELTA[`${Math.sign(dx)},${Math.sign(dy)}`];
      const slot = preset[dir];
      let tileId;
      if (slot.mode === 'empty') tileId = null;
      else if (slot.mode === 'tile') tileId = slot.tileId;
      else tileId = centerTileId;
      cells.push({ dx, dy, tileId, flipH: slot.flipH, flipV: slot.flipV });
    }
  return cells;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green. (`tests/exports.test.mjs` will now fail
— that's Task 4.)

- [ ] **Step 5: Commit**

```bash
git add js/core/neighbors.js tests/neighbors.test.mjs
git commit -m "$(cat <<'EOF'
refactor: key neighbor presets on the tile record, tileIndex -> tileId

getPreset/setSlot now take the tile record directly instead of (sheet,
index) — neighbors live on tile.neighbors. Cross-tile references use the
stable tile id instead of an array index that can shift on removal.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Export builder (`js/app/exports.js`)

**Files:**
- Modify: `js/app/exports.js`
- Test: `tests/exports.test.mjs`

**Interfaces:**
- Consumes: `getPreset`, `NEIGHBOR_DIRS` from `js/core/neighbors.js` (Task 3
  shape); `createTileGrid` from `js/core/tilegrids.js` (Task 2, test only).
- Produces: `buildTilesJson(sheet) → { sheet, count, tiles: [{ index, name,
  x, y, w, h, neighbors }] }`. Each `neighbors[dir]` is `{ mode, tileIndex,
  flipH, flipV }` — `tileIndex` here is the EXPORTED, resolved form (the
  referenced tile's position in `sheet.tiles`), not the internal `tileId`.
  Top-level `tileWidth`/`tileHeight`/`columns` are removed (no longer
  meaningful once tiles can have per-tile size).

- [ ] **Step 1: Write the failing tests**

Replace the two `buildTilesJson` tests in `tests/exports.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { createTileGrid } from '../js/core/tilegrids.js';
import { setSlot } from '../js/core/neighbors.js';
import { buildFramesJson, buildTilesJson } from '../js/app/exports.js';

// ... (keep the two existing buildFramesJson tests unchanged) ...

test('buildTilesJson: only named/preset tiles listed, full 8-dir neighbors, resolved tileIndex', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 32, height: 16, kind: 'tile' });
  const { tiles } = createTileGrid(sheet, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  const [t0, t1] = tiles;
  t0.name = 'grass';
  setSlot(t1, 'e', { mode: 'tile', tileId: t0.id, flipH: true, flipV: false });

  const json = buildTilesJson(sheet);
  assert.equal(json.sheet, 'Ground.png');
  assert.equal(json.count, 2);
  assert.equal(json.tiles.length, 2); // both named-or-preset; none unlisted

  const named = json.tiles.find(t => t.index === 0);
  assert.equal(named.name, 'grass');
  assert.deepEqual({ x: named.x, y: named.y, w: named.w, h: named.h }, { x: 0, y: 0, w: 16, h: 16 });
  assert.deepEqual(Object.keys(named.neighbors).sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
  for (const dir of Object.keys(named.neighbors))
    assert.deepEqual(named.neighbors[dir], { mode: 'same', tileIndex: null, flipH: false, flipV: false });

  const presetOnly = json.tiles.find(t => t.index === 1);
  assert.equal(presetOnly.name, null);
  assert.deepEqual(presetOnly.neighbors.e, { mode: 'tile', tileIndex: 0, flipH: true, flipV: false });
  assert.deepEqual(presetOnly.neighbors.n, { mode: 'same', tileIndex: null, flipH: false, flipV: false });
});

test('buildTilesJson: unnamed, unset tiles are excluded entirely', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Blank', width: 32, height: 16, kind: 'tile' });
  createTileGrid(sheet, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  const json = buildTilesJson(sheet);
  assert.equal(json.count, 2);
  assert.deepEqual(json.tiles, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildTilesJson` still reads `sheet.tile.tileWidth` (now
`undefined`), throws or produces wrong shape.

- [ ] **Step 3: Implement**

Replace `js/app/exports.js`'s `buildTilesJson` (and its header comment) and
drop the now-unused `tileCount` import:

```js
import { getPreset, NEIGHBOR_DIRS } from '../core/neighbors.js';

// (buildFramesJson unchanged above this point)

// { sheet, count, tiles: [{ index, name: <or null>, x, y, w, h,
//   neighbors: { n: {mode,tileIndex,flipH,flipV}, ... } }] }
// Only tiles with a stored name or a stored neighbor preset are listed;
// neighbors are always exported as the full 8-dir preset (getPreset fills
// unset directions with the 'same' default). A neighbor slot's internal
// tileId is resolved to that tile's position in sheet.tiles for export
// (mirrors buildFramesJson resolving animation frameId -> frame name).
export function buildTilesJson(sheet) {
  const indexById = new Map(sheet.tiles.map((t, i) => [t.id, i]));
  const tiles = [];
  sheet.tiles.forEach((tile, index) => {
    if (!tile.name && !tile.neighbors) return;
    const preset = getPreset(tile);
    const neighbors = {};
    for (const d of NEIGHBOR_DIRS) {
      const slot = preset[d];
      neighbors[d] = {
        mode: slot.mode,
        tileIndex: slot.tileId != null ? (indexById.get(slot.tileId) ?? null) : null,
        flipH: slot.flipH, flipV: slot.flipV,
      };
    }
    tiles.push({ index, name: tile.name ?? null, x: tile.x, y: tile.y, w: tile.w, h: tile.h, neighbors });
  });
  return { sheet: `${sheet.name}.png`, count: sheet.tiles.length, tiles };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add js/app/exports.js tests/exports.test.mjs
git commit -m "$(cat <<'EOF'
refactor: buildTilesJson reads sheet.tiles directly, per-tile w/h

Drops the sheet-global tileWidth/tileHeight/columns fields (no longer
meaningful once tiles can have per-tile size); adds per-tile x/y/w/h to
each exported entry. Neighbor slot tileId resolves to an export-time
tileIndex, same shape external consumers already parse.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Selection state rename + sheet overlays (`js/app/state.js`, `js/ui/overlays.js`)

**Files:**
- Modify: `js/app/state.js`
- Modify: `js/ui/overlays.js`

**Interfaces:**
- Produces: `state.selectedTileId`, `state.editingTileId` (renamed from
  `selectedTileIndex`/`editingTileIndex`) — consumed by Task 6/7/8/9.
- Consumes: nothing new.

No dedicated automated test (both files are DOM/state-only, not imported by
`node --test`); verified manually once Task 6-9 land (Task 10's checklist).

- [ ] **Step 1: Rename state fields**

In `js/app/state.js`, replace:

```js
  selectedTileIndex: null,    // tile tool selection (tile mode)
```
with
```js
  selectedTileId: null,       // tile tool selection (tile mode)
```

and replace:
```js
  editingTileIndex: null,     // tile editor target
```
with
```js
  editingTileId: null,        // tile editor target
```

In `newDefaultProject`, drop the now-removed `tileW`/`tileH` args from the
tile sheet's `createSheet` call:

```js
export function newDefaultProject(settings = DEFAULT_SETTINGS) {
  const project = createProject('untitled', settings);
  createSheet(project, { name: 'Sprites', width: settings.spriteSheetW, height: settings.spriteSheetH, kind: 'sprite' });
  createSheet(project, { name: 'Tiles', width: settings.tileSheetW, height: settings.tileSheetH, kind: 'tile' });
  return project;
}
```

- [ ] **Step 2: Rewrite `drawTileOverlays` in `js/ui/overlays.js`**

Replace the `import { tileCount, tileRect } from '../core/model.js';` line
with nothing (no longer needed — remove the import entirely, it's the only
thing this file imports from `core/model.js`).

Replace `drawTileOverlays` (current lines 81-118):

```js
function drawTileOverlays(view, ctx, sheet) {
  if (!sheet.tiles) return;
  const tiles = sheet.tiles;

  if (state.overlays.labels && tiles.length > 0) {
    ctx.save();
    ctx.strokeStyle = FRAME_STROKE;
    ctx.lineWidth = 1;
    for (const t of tiles) {
      const p0 = view.imageToScreen(t.x, t.y);
      const p1 = view.imageToScreen(t.x + t.w, t.y + t.h);
      ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
    }
    ctx.restore();

    tiles.forEach((t, i) => {
      const p0 = view.imageToScreen(t.x, t.y);
      drawChip(ctx, view, t.name ? `${i}:${t.name}` : `${i}`, p0.x, p0.y);
    });
  }

  // Selected-tile highlight (tile tool) — independent of the labels toggle,
  // like sprite mode's selected-frame fill/stroke.
  const sel = tiles.find(t => t.id === state.selectedTileId);
  if (sel) {
    const p0 = view.imageToScreen(sel.x, sel.y);
    const p1 = view.imageToScreen(sel.x + sel.w, sel.y + sel.h);
    ctx.save();
    ctx.strokeStyle = FRAME_STROKE;
    ctx.lineWidth = 2;
    ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    ctx.restore();
  }
}
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (no test covers these files directly; this confirms the
rename didn't break anything the suite does cover).

- [ ] **Step 4: Commit**

```bash
git add js/app/state.js js/ui/overlays.js
git commit -m "$(cat <<'EOF'
refactor: rename tile selection state to id-based, update sheet overlays

state.selectedTileIndex/editingTileIndex -> selectedTileId/editingTileId,
matching frames' id-based selection. drawTileOverlays now iterates
sheet.tiles directly instead of computed tileCount/tileRect.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Tile tool interactions (`js/ui/tilemode.js` — pointer/overlay/commands)

**Files:**
- Modify: `js/ui/tilemode.js` (geometry, pointer handling, overlay drawing,
  swap/move/create/resize/detach commands, `registerTileTool`/
  `bindTileTool`; `mountTilePanel` is Task 7)

**Interfaces:**
- Consumes: `gridCellRect`, `ownedTiles`, `relayoutGrid`, `resizeGridCols`,
  `resizeGridRows`, `moveGrid`, `removeTileGrid`, `createTileGrid`,
  `detachTile` from `js/core/tilegrids.js` (Task 2); `state.selectedTileId`/
  `editingTileId` (Task 5); `copyRegion`/`blitRegion`/`fillRegion` from
  `js/core/pixels.js` (already imported).
- Produces (consumed by Task 7's `mountTilePanel`, added to the SAME file
  in the next task): `openTileEditor(tileId)`, `commitTileName(tile, name)`,
  `commitTileSize(tile, key, value)`, `commitDetachTile(tile)`,
  `commitAddGrid(sheet, opts)`, `commitResizeGridCols(sheet, grid, cols)`,
  `commitResizeGridRows(sheet, grid, rows)`, `commitGridCellField(sheet,
  grid, key, value)`, `commitDeleteGrid(sheet, grid)`, `deleteTile(sheet,
  tileId)`, module-scoped `tileToolView` (set by `bindTileTool`, read by
  Task 7's Add Grid dialog for its preview).
- Produces (unchanged public API, consumed by `js/app/main.js`):
  `registerTileTool()`, `bindTileTool(view)`, `mountTilePanel(el)` (Task 7).

No automated test for this file (DOM/pointer-driven, not imported by
`node --test`) — verified via Task 10's manual checklist once Task 7 also
lands (the panel is needed to create a grid to interact with).

- [ ] **Step 1: Replace the geometry + pointer-drag section**

In `js/ui/tilemode.js`, update the imports at the top:

```js
import { state, on, emit, activeSheet, markDirty, currentContextLayers } from '../app/state.js';
import { copyRegion, blitRegion, fillRegion } from '../core/pixels.js';
import { registerTool } from './tools.js';
import {
  gridCellRect, ownedTiles, relayoutGrid, resizeGridCols, resizeGridRows,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
} from '../core/tilegrids.js';
import { newId } from '../core/palettes.js';
```

(Drop the `tileCount`/`tileRect` import from `../core/model.js` — no longer
exists.)

Replace the whole "geometry" section (current `tileIndexAt`, lines 28-41)
with:

```js
// ------------------------------------------------------------- geometry

function tileAt(sheet, x, y) {
  for (let i = sheet.tiles.length - 1; i >= 0; i--) {
    const t = sheet.tiles[i];
    if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
  }
  return null;
}

// Inclusive rect (create-drag: both points are pixel indices, w = |dx|+1)
// vs. non-inclusive (resize: points are rect EDGE coords). Duplicated from
// frames.js's private helper of the same name/shape — small enough, and
// this codebase already duplicates isTypingTarget the same way across
// tileeditor.js/tilemode.js/frames.js.
function rectBetween(ax, ay, bx, by, inclusive) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  if (inclusive) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

const HANDLES = ['nw', 'ne', 'sw', 'se'];
const HANDLE_SCREEN_PX = 6;
const GRID_HANDLE_SCREEN_PX = 6;

function oppositeCorner(t, handle) {
  const map = {
    nw: { x: t.x + t.w, y: t.y + t.h },
    ne: { x: t.x, y: t.y + t.h },
    sw: { x: t.x + t.w, y: t.y },
    se: { x: t.x, y: t.y },
  };
  return map[handle];
}

// Resize handles only ever apply to a STANDALONE (gridId == null) selected
// tile — a grid-owned tile's size is controlled by its grid's cellW/cellH.
function hitHandle(view, tile, sx, sy) {
  if (!tile || tile.gridId != null) return null;
  for (const h of HANDLES) {
    const ix = h[1] === 'w' ? tile.x : tile.x + tile.w;
    const iy = h[0] === 'n' ? tile.y : tile.y + tile.h;
    const p = view.imageToScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}

// A grid's own drag handle sits at its origin corner — dragging an owned
// TILE is reserved for the swap/move interaction below, so moving the whole
// grid needs a separate, always-visible affordance.
function hitGridHandle(view, sheet, sx, sy) {
  for (const g of sheet.tileGrids) {
    const p = view.imageToScreen(g.x, g.y);
    if (Math.abs(sx - p.x) <= GRID_HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= GRID_HANDLE_SCREEN_PX) return g;
  }
  return null;
}
```

- [ ] **Step 2: Replace the commands section**

Replace `setOrDelete`/`commitSwapTile`/`commitMoveTile` (current lines
43-154) — `setOrDelete` is no longer needed (name/neighbors are now plain
fields, `undefined` means unset, direct assignment works):

```js
// ------------------------------------------------------------- commands

// Deep-clone a neighbors preset value, guarded for undefined.
const cloneNb = v => v === undefined ? undefined : structuredClone(v);

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// Pixel-carrying swap across all layers, plus name<->name and
// neighbors<->neighbors, as one undo/redo step. Same size required by the
// caller (handleUp) before this is invoked — a and b's rects are used
// as-is, whatever their current x/y/w/h (grid-owned or standalone).
function commitSwapTile(sheet, a, b) {
  const patches = currentContextLayers().map((layer) => {
    const beforeA = copyRegion(layer.bitmap, a.x, a.y, a.w, a.h);
    const beforeB = copyRegion(layer.bitmap, b.x, b.y, b.w, b.h);
    blitRegion(layer.bitmap, beforeB, a.x, a.y);
    blitRegion(layer.bitmap, beforeA, b.x, b.y);
    return { layer, beforeA, beforeB };
  });

  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };
  a.name = namesBefore.b; b.name = namesBefore.a;
  a.neighbors = cloneNb(neighborsBefore.b); b.neighbors = cloneNb(neighborsBefore.a);

  const cmd = {
    label: 'swap tiles',
    do() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeB, a.x, a.y);
        blitRegion(p.layer.bitmap, p.beforeA, b.x, b.y);
      }
      a.name = namesBefore.b; b.name = namesBefore.a;
      a.neighbors = cloneNb(neighborsBefore.b); b.neighbors = cloneNb(neighborsBefore.a);
    },
    undo() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(p.layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    },
  };
  state.commands.push(cmd);
  markDirty();
}

// Move: A's pixels overwrite B (all layers), A clears to transparent.
// A's name/neighbors move to B; B's originals are dropped.
function commitMoveTile(sheet, a, b) {
  const patches = currentContextLayers().map((layer) => {
    const beforeA = copyRegion(layer.bitmap, a.x, a.y, a.w, a.h);
    const beforeB = copyRegion(layer.bitmap, b.x, b.y, b.w, b.h);
    blitRegion(layer.bitmap, beforeA, b.x, b.y);
    fillRegion(layer.bitmap, a.x, a.y, a.w, a.h, [0, 0, 0, 0]);
    return { layer, beforeA, beforeB };
  });

  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };
  b.name = namesBefore.a; a.name = undefined;
  b.neighbors = cloneNb(neighborsBefore.a); a.neighbors = undefined;

  const cmd = {
    label: 'move tile',
    do() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, b.x, b.y);
        fillRegion(p.layer.bitmap, a.x, a.y, a.w, a.h, [0, 0, 0, 0]);
      }
      b.name = namesBefore.a; a.name = undefined;
      b.neighbors = cloneNb(neighborsBefore.a); a.neighbors = undefined;
    },
    undo() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(p.layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    },
  };
  state.commands.push(cmd);
  markDirty();
}

// Standalone tile: metadata-only reposition (frame-style), clamped so the
// caller's delta keeps the tile fully on-sheet.
function commitMoveStandaloneTile(tile, dx, dy) {
  const before = { x: tile.x, y: tile.y };
  state.commands.push({
    label: 'move tile',
    do() { tile.x = before.x + dx; tile.y = before.y + dy; },
    undo() { tile.x = before.x; tile.y = before.y; },
  });
  markDirty();
}

function commitResizeTile(tile, before, after) {
  state.commands.push({
    label: 'resize tile',
    do() { tile.x = after.x; tile.y = after.y; tile.w = after.w; tile.h = after.h; },
    undo() { tile.x = before.x; tile.y = before.y; tile.w = before.w; tile.h = before.h; },
  });
  markDirty();
}

function commitCreateTile(sheet, rect) {
  let created = null;
  const cmd = {
    label: 'add tile',
    do() {
      if (!created) {
        created = { id: newId('ti'), x: rect.x, y: rect.y, w: rect.w, h: rect.h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined };
        sheet.tiles.push(created);
      } else if (!sheet.tiles.includes(created)) {
        sheet.tiles.push(created);
      }
      state.selectedTileId = created.id;
    },
    undo() {
      sheet.tiles = sheet.tiles.filter(t => t !== created);
      if (state.selectedTileId === created.id) state.selectedTileId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}

// Grid-owned tiles aren't deleted individually (that would desync the grid
// — shrink the grid, or detach first).
function deleteTile(sheet, tileId) {
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!tile || tile.gridId != null) return;
  const idx = sheet.tiles.indexOf(tile);
  const wasSelected = state.selectedTileId === tileId;
  state.commands.push({
    label: 'delete tile',
    do() {
      sheet.tiles = sheet.tiles.filter(t => t !== tile);
      if (state.selectedTileId === tile.id) state.selectedTileId = null;
    },
    undo() {
      sheet.tiles.splice(Math.min(idx, sheet.tiles.length), 0, tile);
      if (wasSelected) state.selectedTileId = tile.id;
    },
  });
  markDirty();
  emit('selection');
}

function commitMoveGrid(sheet, grid, dx, dy) {
  const before = { x: grid.x, y: grid.y };
  state.commands.push({
    label: 'move grid',
    do() { grid.x = before.x + dx; grid.y = before.y + dy; relayoutGrid(sheet, grid); },
    undo() { grid.x = before.x; grid.y = before.y; relayoutGrid(sheet, grid); },
  });
  markDirty();
}

function openTileEditor(tileId) {
  state.editingTileId = tileId;
  state.view = 'tile';
  emit('view');
}
```

- [ ] **Step 3: Replace pointer handling (`handleDown`/`handleMove`/`handleUp`)**

```js
// ------------------------------------------------------------- pointer

const DBLCLICK_MS = 400;
const TILE_GHOST = '#fff';
const TILE_GHOST_MOVE = '#ffb020';

let drag = null;
let lastClick = null; // { tileId, time }

function handleDown(ev, view) {
  const sheet = activeSheet();
  if (!sheet) return;

  const gridHit = hitGridHandle(view, sheet, ev.sx, ev.sy);
  if (gridHit) {
    drag = { kind: 'gridmove', grid: gridHit, anchor: { x: ev.x, y: ev.y }, dx: 0, dy: 0 };
    view.requestRender();
    return;
  }

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
  const now = performance.now();
  if (hit && lastClick && lastClick.tileId === hit.id && now - lastClick.time < DBLCLICK_MS) {
    lastClick = null;
    drag = null;
    openTileEditor(hit.id);
    return;
  }
  lastClick = hit ? { tileId: hit.id, time: now } : null;

  if (!hit) {
    if (state.selectedTileId !== null) { state.selectedTileId = null; emit('selection'); }
    drag = { kind: 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
    view.requestRender();
    return;
  }

  if (state.selectedTileId !== hit.id) { state.selectedTileId = hit.id; emit('selection'); }
  drag = { kind: 'tiledrag', from: hit, anchor: { x: ev.x, y: ev.y }, to: { x: ev.x, y: ev.y }, shift: ev.shiftKey };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) return;
  if (drag.kind === 'create') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true);
  } else if (drag.kind === 'resize') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false);
  } else if (drag.kind === 'gridmove') {
    drag.dx = ev.x - drag.anchor.x;
    drag.dy = ev.y - drag.anchor.y;
  } else if (drag.kind === 'tiledrag') {
    drag.to = { x: ev.x, y: ev.y };
    drag.shift = ev.shiftKey;
  }
  view.requestRender();
}

function handleUp(ev, view) {
  if (!drag) return;
  handleMove(ev, view);
  const sheet = activeSheet();
  const d = drag;
  drag = null;
  view.requestRender();
  if (!sheet) return;

  if (d.kind === 'create') {
    const moved = ev.x !== d.anchor.x || ev.y !== d.anchor.y;
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1) commitCreateTile(sheet, d.rect);
    return;
  }
  if (d.kind === 'gridmove') {
    if (d.dx !== 0 || d.dy !== 0) commitMoveGrid(sheet, d.grid, d.dx, d.dy);
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      commitResizeTile(d.tile, d.before, r);
    return;
  }
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
}
```

- [ ] **Step 4: Replace overlay drawing**

```js
// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

function drawGridHandles(ctx, view, sheet) {
  ctx.save();
  ctx.fillStyle = '#4f8cff';
  for (const g of sheet.tileGrids) {
    const p = view.imageToScreen(g.x, g.y);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.restore();
}

function drawTileToolGhost(ctx, view) {
  if (state.mode !== 'tiles') return;
  const sheet = activeSheet();
  if (!sheet) return;

  if (addGridPreviewOpts) drawAddGridPreview(ctx, view);

  if (state.tool === 'tiletool') drawGridHandles(ctx, view, sheet);

  if (!drag) return;
  ctx.save();
  ctx.strokeStyle = TILE_GHOST;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'gridmove') {
    for (const t of ownedTiles(sheet, drag.grid.id))
      strokeGhostRect(ctx, view, { x: t.x + drag.dx, y: t.y + drag.dy, w: t.w, h: t.h });
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
  ctx.restore();
}
```

(`addGridPreviewOpts`/`drawAddGridPreview` are declared in Task 7, in the
same file — forward reference is fine since both land in this one module
before either is exercised at runtime.)

- [ ] **Step 5: Replace `registerTileTool`/`bindTileTool`**

```js
// ------------------------------------------------------------- public API

let tileToolView = null; // set by bindTileTool; read by Task 7's Add Grid dialog preview

export function registerTileTool() {
  registerTool({ id: 'tiletool', icon: '🔲', key: 't', isAvailable: () => state.mode === 'tiles' });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'tiletool' || state.mode !== 'tiles') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedTileId) return;
    deleteTile(sheet, state.selectedTileId);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.mode === 'tiles' && state.selectedTileId !== null) {
      state.selectedTileId = null;
      drag = null;
      emit('selection');
    }
  });
}

export function bindTileTool(view) {
  tileToolView = view;
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'tiles' && state.tool === 'tiletool') {
      if (ev.type === 'down') handleDown(ev, view);
      else if (ev.type === 'move') handleMove(ev, view);
      else if (ev.type === 'up') handleUp(ev, view);
      return;
    }
    prevPointer(ev);
  };

  const prevOverlay = view.onOverlay;
  view.onOverlay = (ctx) => {
    prevOverlay(ctx);
    drawTileToolGhost(ctx, view);
  };

  on('project', () => { if (drag) { drag = null; lastClick = null; view.requestRender(); } });
  on('tool', () => { if (state.tool !== 'tiletool' && drag) { drag = null; view.requestRender(); } });
}
```

Leave the rest of the file (from `mountTilePanel` onward, currently lines
315-389) as-is for now — Task 7 replaces it.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS (no automated test covers this file; this confirms nothing
else broke). The app itself is not yet fully working — `mountTilePanel`
still references the old shape until Task 7 — that's expected and checked
manually in Task 10, not now.

- [ ] **Step 7: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "$(cat <<'EOF'
refactor: tile tool works on grid-owned + standalone tile records

Hit-testing, create/move/resize/swap/detach-aware drag reconciliation,
and grid move-handle all rewritten against sheet.tiles/tileGrids. Swap
works for any same-size pair (grid or standalone); a grid-owned tile
dropped without a same-size target snaps back (moving a whole grid goes
through its own origin handle instead). mountTilePanel is updated next.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Tile/grid panel UI (`js/ui/tilemode.js` — `mountTilePanel` + Add Grid dialog)

**Files:**
- Modify: `js/ui/tilemode.js` (replaces `mountTilePanel` and the old
  `commitTileSize`/`commitTileName`/`sizeField` section; adds grid CRUD
  commands + the Add Grid dialog)

**Interfaces:**
- Consumes: `tileToolView` (module-scoped, set in Task 6's `bindTileTool`),
  `createTileGrid`, `resizeGridCols`, `resizeGridRows`, `removeTileGrid`,
  `detachTile`, `gridCellRect` (Task 2), `state.project?.settings.tileW/H`
  (existing settings, now repurposed as the Add Grid dialog's defaults).
- Produces: `mountTilePanel(el)` (same public signature as before).

- [ ] **Step 1: Add grid-editing commands**

Insert alongside the other `commit*` functions from Task 6 (anywhere in the
"commands" section):

```js
function commitAddGrid(sheet, opts) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  createTileGrid(sheet, opts);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'add grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

function commitDeleteGrid(sheet, grid) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  removeTileGrid(sheet, grid.id);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'delete grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

function commitResizeGridCols(sheet, grid, cols) {
  if (cols === grid.cols) return;
  const beforeTiles = sheet.tiles.slice();
  const beforeCols = grid.cols;
  resizeGridCols(sheet, grid, cols);
  const afterTiles = sheet.tiles.slice();
  const afterCols = grid.cols;
  state.commands.push({
    label: 'resize grid cols',
    do() { grid.cols = afterCols; sheet.tiles = afterTiles.slice(); },
    undo() { grid.cols = beforeCols; sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

function commitResizeGridRows(sheet, grid, rows) {
  if (rows === grid.rows) return;
  const beforeTiles = sheet.tiles.slice();
  const beforeRows = grid.rows;
  resizeGridRows(sheet, grid, rows);
  const afterTiles = sheet.tiles.slice();
  const afterRows = grid.rows;
  state.commands.push({
    label: 'resize grid rows',
    do() { grid.rows = afterRows; sheet.tiles = afterTiles.slice(); },
    undo() { grid.rows = beforeRows; sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

// Cell size/spacing edits re-layout every owned tile in place; only their
// geometry needs snapshotting (name/neighbors/gridCol/gridRow are untouched).
function commitGridCellField(sheet, grid, key, value) {
  if (grid[key] === value) return;
  const before = grid[key];
  const beforeRects = ownedTiles(sheet, grid.id).map(t => ({ t, x: t.x, y: t.y, w: t.w, h: t.h }));
  state.commands.push({
    label: `edit grid ${key}`,
    do() { grid[key] = value; relayoutGrid(sheet, grid); },
    undo() {
      grid[key] = before;
      for (const r of beforeRects) { r.t.x = r.x; r.t.y = r.y; r.t.w = r.w; r.t.h = r.h; }
    },
  });
  markDirty();
}

function commitDetachTile(tile) {
  const before = { gridId: tile.gridId, gridCol: tile.gridCol, gridRow: tile.gridRow };
  state.commands.push({
    label: 'detach tile from grid',
    do() { detachTile(tile); },
    undo() { tile.gridId = before.gridId; tile.gridCol = before.gridCol; tile.gridRow = before.gridRow; },
  });
  markDirty();
}

function commitTileName(tile, name) {
  const before = tile.name;
  const after = name || undefined;
  if (before === after) return;
  state.commands.push({
    label: 'rename tile',
    do() { tile.name = after; },
    undo() { tile.name = before; },
  });
  markDirty();
}

function commitTileSize(tile, key, value) {
  if (tile[key] === value) return;
  const before = tile[key];
  state.commands.push({
    label: `edit tile ${key}`,
    do() { tile[key] = value; },
    undo() { tile[key] = before; },
  });
  markDirty();
}
```

- [ ] **Step 2: Add the Add Grid dialog + its live preview**

```js
// ------------------------------------------------------------- add-grid dialog

let addGridPreviewOpts = null; // dialog's current field values while open, else null

function drawAddGridPreview(ctx, view) {
  const { cellW, cellH, cols, rows, spacingX, spacingY } = addGridPreviewOpts;
  if (cellW < 1 || cellH < 1 || cols < 1 || rows < 1) return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  const previewGrid = { x: 0, y: 0, cellW, cellH, spacingX, spacingY };
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const r = gridCellRect(previewGrid, col, row);
      strokeGhostRect(ctx, view, r);
    }
  ctx.restore();
}

function buildAddGridDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add grid</h3>
    <div class="row"><label>Cell W <input type="number" id="ag-cellw" min="1" value="16"></label></div>
    <div class="row"><label>Cell H <input type="number" id="ag-cellh" min="1" value="16"></label></div>
    <div class="row"><label>Cols <input type="number" id="ag-cols" min="1" value="4"></label></div>
    <div class="row"><label>Rows <input type="number" id="ag-rows" min="1" value="4"></label></div>
    <div class="row"><label>Spacing X <input type="number" id="ag-spacingx" min="0" value="0"></label></div>
    <div class="row"><label>Spacing Y <input type="number" id="ag-spacingy" min="0" value="0"></label></div>
    <div class="row"><button type="button" id="ag-create">Create</button><button type="button" id="ag-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  const readPreview = () => {
    const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
    return {
      cellW: intVal($('#ag-cellw'), 1), cellH: intVal($('#ag-cellh'), 1),
      cols: intVal($('#ag-cols'), 1), rows: intVal($('#ag-rows'), 1),
      spacingX: intVal($('#ag-spacingx'), 0), spacingY: intVal($('#ag-spacingy'), 0),
    };
  };
  for (const id of ['#ag-cellw', '#ag-cellh', '#ag-cols', '#ag-rows', '#ag-spacingx', '#ag-spacingy'])
    $(id).addEventListener('input', () => {
      if (!addGridPreviewOpts) return;
      addGridPreviewOpts = readPreview();
      tileToolView?.requestRender();
    });
  dlg.addEventListener('close', () => {
    addGridPreviewOpts = null;
    tileToolView?.requestRender();
  });
  $('#ag-cancel').addEventListener('click', () => dlg.close());
  $('#ag-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    commitAddGrid(sheet, { x: 0, y: 0, ...readPreview() });
    dlg.close();
  });
  return {
    open() {
      const settings = state.project?.settings ?? {};
      $('#ag-cellw').value = String(settings.tileW ?? 16);
      $('#ag-cellh').value = String(settings.tileH ?? 16);
      addGridPreviewOpts = readPreview();
      dlg.showModal();
      tileToolView?.requestRender();
    },
  };
}
```

- [ ] **Step 3: Replace `mountTilePanel` and remove the old `sizeField`-based tile-size code**

The existing `sizeField` helper (current lines 296-313) is reused as-is —
keep it. Replace everything from the old `commitTileSize`/`commitTileName`
functions (current lines 273-294) through the end of `mountTilePanel`
(current lines 315-389) with:

```js
// ------------------------------------------------------------- tile/grid panel

export function mountTilePanel(el) {
  // Shares #panel-context with frames.js's mountFramesPanel — see that
  // function's wrap-div comment. This panel gets its own wrapper, toggled
  // independently, so the two never clobber each other's DOM.
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Tiles';
  wrap.appendChild(h3);

  const gridList = document.createElement('div');
  gridList.className = 'tile-grid-list';
  wrap.appendChild(gridList);

  const addGridDialog = buildAddGridDialog();
  const btnAddGrid = document.createElement('button');
  btnAddGrid.type = 'button';
  btnAddGrid.textContent = 'Add Grid…';
  btnAddGrid.addEventListener('click', () => { if (activeSheet()) addGridDialog.open(); });
  wrap.appendChild(btnAddGrid);

  const countRow = document.createElement('div');
  countRow.className = 'row';
  wrap.appendChild(countRow);

  const selRow = document.createElement('div');
  selRow.className = 'row tile-selected';
  wrap.appendChild(selRow);

  function render() {
    if (state.mode !== 'tiles') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const sheet = activeSheet();
    gridList.innerHTML = '';
    countRow.innerHTML = '';
    selRow.innerHTML = '';
    if (!sheet) return;

    for (const grid of sheet.tileGrids) {
      const row = document.createElement('div');
      row.className = 'row tile-grid-row';
      row.append(
        sizeField('Cols', grid.cols, (v) => commitResizeGridCols(sheet, grid, v)),
        sizeField('Rows', grid.rows, (v) => commitResizeGridRows(sheet, grid, v)),
        sizeField('W', grid.cellW, (v) => commitGridCellField(sheet, grid, 'cellW', v)),
        sizeField('H', grid.cellH, (v) => commitGridCellField(sheet, grid, 'cellH', v)),
      );
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.textContent = 'Delete grid';
      btnDel.addEventListener('click', () => commitDeleteGrid(sheet, grid));
      row.appendChild(btnDel);
      gridList.appendChild(row);
    }

    const count = sheet.tiles.length;
    countRow.textContent = `${count} tile${count === 1 ? '' : 's'}`;

    const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
    if (!tile) {
      const hint = document.createElement('span');
      hint.textContent = 'No tile selected';
      selRow.appendChild(hint);
      return;
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = tile.name || '';
    nameInput.placeholder = 'name';
    nameInput.addEventListener('change', () => commitTileName(tile, nameInput.value.trim()));
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.textContent = 'Edit tile';
    btnEdit.addEventListener('click', () => openTileEditor(tile.id));
    selRow.append(nameInput, btnEdit);

    if (tile.gridId != null) {
      const btnDetach = document.createElement('button');
      btnDetach.type = 'button';
      btnDetach.textContent = 'Detach from grid';
      btnDetach.addEventListener('click', () => commitDetachTile(tile));
      selRow.appendChild(btnDetach);
    } else {
      selRow.append(
        sizeField('W', tile.w, (v) => commitTileSize(tile, 'w', v)),
        sizeField('H', tile.h, (v) => commitTileSize(tile, 'h', v)),
      );
    }
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  on('project', schedule);
  on('history', schedule);
  on('view', schedule);
  on('selection', schedule);
  render();
}
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "$(cat <<'EOF'
feat: tile panel — grid list (cols/rows/cellW/cellH + delete), Add Grid
dialog with live dashed preview, per-tile detail (name/edit/detach or
standalone W/H)

Nothing-selected state lists every grid with inline-editable geometry
fields; a selected tile shows its name + Edit tile, plus either Detach
(grid-owned) or W/H resize fields (standalone). Add Grid mirrors the
sprite Slice Grid dialog's style, defaulting cell size from
project.settings.tileW/tileH.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Tile editor re-pointing (`js/ui/tileeditor.js`)

**Files:**
- Modify: `js/ui/tileeditor.js`

**Interfaces:**
- Consumes: `getPreset(tile)`, `setSlot(tile, dir, slot)`,
  `resolveNeighborGrid(preset, centerTileId, radius)` (Task 3 shape);
  `state.editingTileId` (Task 5).
- Produces: `mountTileEditor(hostEl)` (unchanged public signature).

No automated test (DOM-driven) — verified in Task 10's manual checklist.

- [ ] **Step 1: Replace tile lookup + geometry**

Replace `currentTileIndex`/`centerRect`/`offset` (current lines 104-125):

```js
function currentTile() {
  const sheet = activeSheet();
  if (!sheet) return null;
  const id = state.editingTileId;
  if (!id) return null;
  return sheet.tiles.find(t => t.id === id) ?? null;
}

// Sheet-global rect of the tile currently being edited, or null.
function centerRect() {
  const t = currentTile();
  return t ? { x: t.x, y: t.y, w: t.w, h: t.h } : null;
}

function offset() {
  const t = currentTile();
  const r = centerRect();
  if (!t || !r) return { x: 0, y: 0 };
  return { x: r.x - radius * t.w, y: r.y - radius * t.h };
}
```

- [ ] **Step 2: Replace `drawTileCell` and `view.onPaint`**

```js
// Draws `tile`'s current flattened pixels into the neighbor-grid cell at
// (dx, dy) (tile units relative to center, 0,0 = center), applying flips
// around that cell's own bounds. tw/th are the CENTER tile's own size —
// a differently-sized neighbor's source rect is stretched into it (an
// accepted, minor visual quirk for mixed-size neighbors; Phase B's terrain
// sets are the real fix, since a terrain set requires uniform tile size).
function drawTileCell(ctx, flatCanvasEl, tile, dx, dy, flipH, flipV, tw, th) {
  const destX = (dx + radius) * tw;
  const destY = (dy + radius) * th;
  ctx.save();
  ctx.translate(destX + (flipH ? tw : 0), destY + (flipV ? th : 0));
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.drawImage(flatCanvasEl, tile.x, tile.y, tile.w, tile.h, 0, 0, tw, th);
  ctx.restore();
}

view.onPaint = (ctx) => {
  const sheet = activeSheet();
  const t = currentTile();
  if (!sheet || !t) return;
  const tw = t.w, th = t.h;
  const flat = getFlatCanvas(sheet);
  const preset = getPreset(t);
  const cells = resolveNeighborGrid(preset, t.id, radius);

  ctx.save();
  ctx.globalAlpha = 0.85;
  for (const cell of cells) {
    if (cell.tileId == null) continue;
    const nb = sheet.tiles.find(x => x.id === cell.tileId);
    if (!nb) continue;
    drawTileCell(ctx, flat, nb, cell.dx, cell.dy, cell.flipH, cell.flipV, tw, th);
  }
  ctx.restore();

  // center tile, full alpha, never flipped
  drawTileCell(ctx, flat, t, 0, 0, false, false, tw, th);
};
```

Update the module import line to drop `tileRect`/`tileCount` (no longer
exported by `model.js`):

```js
import { flattenSheet } from '../core/model.js';
```

- [ ] **Step 3: Replace the slot dialog's "other tile" numeric input with a `<select>`**

Replace the dialog markup:

```js
  dlg.innerHTML = `
    <h3>Neighbor slot: <span id="te-slot-dir"></span></h3>
    <div class="row"><label><input type="radio" name="te-mode" value="same"> Same tile (mirrors center)</label></div>
    <div class="row"><label><input type="radio" name="te-mode" value="tile"> Other tile</label></div>
    <div class="row"><label><input type="radio" name="te-mode" value="empty"> Empty</label></div>
    <div class="row"><label>Tile <select id="te-tile-select"></select></label></div>
    <div class="row"><label><input type="checkbox" id="te-fliph"> Flip H</label></div>
    <div class="row"><label><input type="checkbox" id="te-flipv"> Flip V</label></div>
    <div class="row"><button type="button" id="te-ok">OK</button><button type="button" id="te-cancel">Cancel</button></div>
  `;
```

Replace the element refs and `setMode`:

```js
  const teDirSpan = dlg.querySelector('#te-slot-dir');
  const teTileSelect = dlg.querySelector('#te-tile-select');
  const teFlipH = dlg.querySelector('#te-fliph');
  const teFlipV = dlg.querySelector('#te-flipv');
  const teOk = dlg.querySelector('#te-ok');
  const teCancel = dlg.querySelector('#te-cancel');
  const teModeRadios = [...dlg.querySelectorAll('input[name="te-mode"]')];

  function setMode(mode) {
    for (const r of teModeRadios) r.checked = r.value === mode;
    teTileSelect.disabled = mode !== 'tile';
  }
  for (const r of teModeRadios) r.addEventListener('change', () => setMode(r.value));
```

Replace `openSlotDialog`:

```js
  let dialogDir = null;

  function openSlotDialog(dir) {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    dialogDir = dir;
    const slot = getPreset(t)[dir];
    teDirSpan.textContent = `${DIR_LABELS[dir]} (${dir})`;
    setMode(slot.mode);
    teTileSelect.innerHTML = '';
    sheet.tiles.forEach((other, i) => {
      const opt = document.createElement('option');
      opt.value = other.id;
      opt.textContent = other.name ? `${i}: ${other.name}` : `#${i}`;
      teTileSelect.appendChild(opt);
    });
    teTileSelect.value = (slot.mode === 'tile' && slot.tileId != null) ? slot.tileId : t.id;
    teFlipH.checked = slot.flipH;
    teFlipV.checked = slot.flipV;
    dlg.showModal();
  }
```

Replace `commitSlot` and the `teOk` handler:

```js
  function commitSlot(tile, dir, slot) {
    const before = tile.neighbors ? structuredClone(tile.neighbors) : null;
    state.commands.push({
      label: 'edit tile neighbor slot',
      do() { setSlot(tile, dir, slot); },
      undo() { tile.neighbors = before ? structuredClone(before) : undefined; },
    });
    markDirty();
  }

  teCancel.addEventListener('click', () => dlg.close());
  teOk.addEventListener('click', () => {
    const t = currentTile();
    if (!t || !dialogDir) { dlg.close(); return; }
    const mode = teModeRadios.find(r => r.checked)?.value ?? 'same';
    const tileId = mode === 'tile' ? teTileSelect.value : null;
    const slot = { mode, tileId, flipH: teFlipH.checked, flipV: teFlipV.checked };
    commitSlot(t, dialogDir, slot);
    dlg.close();
  });
```

- [ ] **Step 4: Replace pointer routing, strip wiring, and content sizing to use `currentTile()`**

Replace `cellAt`/`insideCenter` (use the tile's own `w`/`h` instead of a
sheet-global tile size):

```js
  function cellAt(x, y) {
    const t = currentTile();
    if (!t) return null;
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) return null;
    const dx = Math.floor(x / t.w) - radius;
    const dy = Math.floor(y / t.h) - radius;
    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }

  function insideCenter(x, y) {
    const t = currentTile();
    if (!t) return false;
    return x >= radius * t.w && x < radius * t.w + t.w && y >= radius * t.h && y < radius * t.h + t.h;
  }
```

Replace `updateStrip` (compute a display-only index; not stored anywhere):

```js
  function updateStrip() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) { nameLabel.textContent = ''; return; }
    const idx = sheet.tiles.indexOf(t);
    nameLabel.textContent = t.name ? `Tile ${idx} (${t.name})` : `Tile ${idx}`;
    radiusSelect.value = String(radius);
  }
```

Replace `backToSheet`'s Escape handler and `loadContent`/`refresh`/`show`
tracking variable: everywhere `currentTileIndex()` was called, call
`currentTile()` and compare/track `.id` instead of the raw value:

```js
  function loadContent() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    view.setContent({ width: (2 * radius + 1) * t.w, height: (2 * radius + 1) * t.h });
    view.centerFit();
    loadedTileId = t.id;
    loadedRadius = radius;
  }
```

Rename the module-scoped `loadedTileIndex` variable to `loadedTileId`
everywhere it appears (`refresh()`'s `if (loadedTileIndex !== t || ...)`
becomes `if (loadedTileId !== t.id || ...)`, using the tile object `t`
returned by `currentTile()`):

```js
  let loadedTileId = null;
  let loadedRadius = null;

  function refresh() {
    const t = currentTile();
    if (!t) {
      hide();
      if (state.view === 'tile') { state.view = 'sheet'; state.editingTileId = null; emit('view'); }
      return;
    }
    if (loadedTileId !== t.id || loadedRadius !== radius) loadContent();
    updateStrip();
    view.requestRender();
  }

  function show() {
    const wasHidden = !visible;
    container.style.display = 'flex';
    visible = true;
    if (wasHidden) {
      view._resize();
      if (loadedTileId != null && (view.cssWidth !== lastCssW || view.cssHeight !== lastCssH)) {
        view.centerFit();
      }
    }
    refresh();
  }
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add js/ui/tileeditor.js
git commit -m "$(cat <<'EOF'
refactor: tile editor looks up tiles by id, per-tile cell size

currentTileIndex -> currentTile (id-based lookup via state.editingTileId).
Neighbor grid cell size comes from the edited tile's own w/h instead of a
sheet-global tileWidth/tileHeight. The slot dialog's "other tile" input is
now a <select> populated from sheet.tiles (labeled by name, falling back
to #index) instead of a raw numeric index, since tile identity is id-based
and array position can shift.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `main.js` + `index.html` glue

**Files:**
- Modify: `js/app/main.js`
- Modify: `index.html`

**Interfaces:**
- Consumes: `state.selectedTileId` (Task 5); `createSheet(project, { name,
  width, height, kind })` (Task 1 signature, no `tileW`/`tileH`).

No automated test (DOM-driven) — verified in Task 10's manual checklist.

- [ ] **Step 1: Remove the New Sheet dialog's tile-size row**

In `index.html`, inside `<dialog id="dlg-newsheet">`, delete these two
lines:

```html
    <span class="ns-tile-row">Tile size</span><input id="ns-tile-w" class="ns-tile-row" type="number" min="1" max="256" value="16">
    <span class="ns-tile-row">×</span><input id="ns-tile-h" class="ns-tile-row" type="number" min="1" max="256" value="16">
```

(Confirmed via grep: no CSS rule targets `.ns-tile-row`, so nothing else
needs cleanup there — visibility was purely JS-driven.)

- [ ] **Step 2: Update `js/app/main.js`'s tile-size element refs and dialog wiring**

Remove these three lines (element refs for the now-deleted inputs/rows):

```js
const nsTileW = document.getElementById('ns-tile-w');
const nsTileH = document.getElementById('ns-tile-h');
const nsTileRowEls = document.querySelectorAll('.ns-tile-row');
```

Replace `updateNewSheetTileRow` + the `btnNewSheet` click handler (current
lines 194-215) — the New Sheet dialog no longer varies by kind:

```js
btnNewSheet.addEventListener('click', () => {
  if (!state.project) return;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const settings = state.project.settings;
  const n = state.project.sheets.filter(s => s.kind === kind).length + 1;
  nsName.value = `sheet_${n}`;
  nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
  nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
  dlgNewSheet.showModal();
});
```

Replace `nsCreate`'s click handler (current lines 217-242) — drop the
`tileW`/`tileH` reading and validation:

```js
nsCancel.addEventListener('click', () => dlgNewSheet.close());
nsCreate.addEventListener('click', () => {
  if (!state.project) return;
  const project = state.project;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const sheetDim = (el) => {
    const v = parseInt(el.value, 10);
    return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
  };
  const width = sheetDim(nsW);
  const height = sheetDim(nsH);
  if (width == null || height == null) {
    alert('Please enter valid positive numbers for all fields.');
    return;
  }
  const name = nsName.value.trim() || `sheet_${project.sheets.filter(s => s.kind === kind).length + 1}`;

  const sheet = createSheet(project, { name, width, height, kind });
  commitAddSheet(sheet);
  dlgNewSheet.close();
});
```

- [ ] **Step 3: Update the import-sheet handler**

Replace the `createSheet` call inside `btnImportSheet`'s click handler
(current lines 271-274):

```js
  const sheet = createSheet(project, {
    name, width: bitmap.width, height: bitmap.height, kind,
  });
```

(Drop the `tileW: settings.tileW, tileH: settings.tileH` line — the
`settings` variable above it is now unused in this handler; remove the
`const settings = project.settings;` line too if nothing else in that
handler reads it — check the full handler body before deleting, since
`settings` might still be referenced elsewhere in it.)

- [ ] **Step 4: Rename remaining `state.selectedTileIndex` references**

Four occurrences (lines 104, 147, 172, 183 — inside `switchMode`,
`sheetSelect`'s change handler, and `commitAddSheet`'s `do()`/`undo()`):
replace every `state.selectedTileIndex` with `state.selectedTileId`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add js/app/main.js index.html
git commit -m "$(cat <<'EOF'
refactor: New Sheet dialog drops upfront tile size, id-based tile selection

Tile sheets no longer ask for a tile size at creation time — tiles are
added afterward via the tile panel's Add Grid / create-standalone-tile
actions, matching the "no default grid" goal. project.settings.tileW/H
now only seeds the Add Grid dialog's defaults (New Project dialog still
collects them for that purpose).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Smoke checklist update + manual verification pass

**Files:**
- Modify: `tests/smoke.md`

**Interfaces:** none (documentation + a manual pass, no code change).

- [ ] **Step 1: Rewrite smoke.md sections 8 and 9**

Replace section "## 8. Tile mode" (current items 34-37) with:

```markdown
## 8. Tile mode

34. [A] Switch to Tile Sheets tab on a fresh tile sheet: tile panel shows
    "0 tiles", no grids listed, an "Add Grid…" button, and "No tile
    selected".
35. [M] Click "Add Grid…": a dialog opens (Cell W/H, Cols, Rows, Spacing
    X/Y, defaulted from the project's tile size setting) with a live
    dashed-outline preview on the canvas that updates as fields change and
    disappears on Cancel. Create adds a grid; the panel now lists it with
    editable Cols/Rows/W/H fields and the tile count updates.
36. [A] Tile tool (`T`, tile mode only): click a tile in the grid to select
    it — the panel shows a name field, "Edit tile", and "Detach from grid"
    (no W/H fields, since a grid-owned tile's size follows its grid).
37. [M] Drag one tile onto another SAME-SIZE tile (no Shift) to swap them —
    pixels, names, and neighbor presets swap on all layers; undo restores
    both. Shift-drag instead moves (source clears to transparent, its
    name/neighbors move to the target); undo restores both tiles.
38. [M] Drag a grid-owned tile onto empty space (nothing same-size under
    the cursor): it snaps back — a single grid cell can't move
    independently. Dragging the grid's own origin-corner handle instead
    moves the whole grid and every one of its tiles together; undo
    restores the prior position.
39. [M] Click empty canvas space and drag with the tile tool active: creates
    a new standalone tile there (frame-style create-drag); the panel shows
    W/H fields for it (no "Detach" button, since it isn't grid-owned).
    Dragging a standalone tile to empty space (or a different-size tile)
    repositions it; undo restores its prior position.
40. [A] Select a grid-owned tile, click "Detach from grid" — it becomes a
    standalone tile (W/H fields appear, resize handles become available);
    undo restores its grid membership.
41. [A] Editing a grid's Cols/Rows in the panel adds/removes tiles at the
    trailing edge (pixels stay on the sheet; only the tile record and any
    name/neighbor preset it held are removed on shrink); editing Cell W/H
    re-lays-out every owned tile from the grid's origin, preserving each
    cell's name/neighbor preset. Each edit is one undo step.
42. [A] "Delete grid" removes the grid and every tile it owns; undo restores
    all of them. Select a standalone tile and press `Delete`: it's removed;
    undo restores it. Grid-owned tiles have no direct delete (shrink the
    grid, or detach first).
```

Replace section "## 9. Tile editor" (current items 38-41 — renumbered to
43-46 given the inserted items above, but don't hand-renumber the whole
rest of the file; just append these as a new section 9 immediately after
and leave every later section's existing numbers as-is, since this file
already isn't strictly sequential-safe across edits — historical sections
elsewhere in this doc keep their own item numbers stable across previous
feature additions) with:

```markdown
## 9. Tile editor

43. [A] Double-click a tile (or "Edit tile") to open the tile editor;
    center tile is outlined, neighbor cells render the live composite.
44. [A] Draw inside the center tile: neighbor cells that mirror it (mode
    `same`) update live as you draw (drag confinement: strokes cannot
    escape the center tile even if the drag leaves it).
45. [A] Click a neighbor slot (outside the center tile, no drag) to open
    the slot config dialog; the "Other tile" field is now a dropdown
    listing every tile on the sheet (by name, or `#index` if unnamed) —
    try each mode (`same tile` / `other tile` + selection / `empty`), and
    Flip H/V; OK commits, undo restores the prior preset for that slot.
46. [A] Switch the neighbor radius to 5×5 and back to 3×3; grid resizes
    and recenters, sized from the edited tile's own W/H (not a sheet-wide
    size).
```

- [ ] **Step 2: Update section 10's Tiles JSON item for the new export shape**

Replace item 44 (now wherever it falls after the renumbering note above —
locate it by its current text, `"Tiles JSON" (enabled only for tile
sheets)...`) with:

```markdown
44. [A] "Tiles JSON" (enabled only for tile sheets) downloads
    `<sheet>.tiles.json`; shape is `{ sheet, count, tiles[] }` — `tiles[]`
    includes only named/preset tiles, each with `index, name, x, y, w, h`
    and the full 8-direction `neighbors` (each slot's `tileIndex` resolved
    from the internal tile id to that tile's position in the array).
```

- [ ] **Step 3: Run the automated suite one last time**

Run: `npm test`
Expected: PASS, full green summary line.

- [ ] **Step 4: Manual verification pass**

Per this repo's convention (drags are never simulated in Playwright here —
verified by the project owner), work through the new/changed **[M]** items
above by hand in a running instance
(`http://localhost:8080/?autotest`): Add Grid dialog + preview, grid-handle
move, same-size swap/move-drag, grid-owned-tile-drop-on-empty-space
snapback, standalone create/move drag. The **[A]** items in the same
sections can additionally be exercised via Playwright by whoever runs this
step, per the repo's existing pattern.

- [ ] **Step 5: Commit**

```bash
git add tests/smoke.md
git commit -m "$(cat <<'EOF'
docs: rewrite smoke checklist sections 8-9 for grids + standalone tiles

Replaces the old uniform-grid tile mode checklist with the new Add Grid
dialog, grid-handle move, same-size swap/move drag reconciliation,
standalone create, and detach flows. Tile editor section's slot dialog
item updated for the id-based tile-select dropdown. Export item updated
for the new { sheet, count, tiles[] } shape.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:**
- Data model (grids + tiles, id-based) — Task 1, 2. ✅
- Grid mechanics (create/resize/move/detach/delete) — Task 2, 6, 7. ✅
- Tile-tool drag reconciliation (swap-same-size / standalone-move /
  grid-snapback) — Task 6. ✅
- Tile/grid panel UI — Task 7. ✅
- Tile editor re-pointing + neighbor picker upgrade — Task 8. ✅
- Migration of legacy `sheet.tile` shape — Task 1. ✅
- Export shape update — Task 4. ✅
- Smoke checklist — Task 10. ✅

**Placeholder scan:** none found — every step has concrete code or an exact
command.

**Type/name consistency check:** `getPreset`/`setSlot`/`resolveNeighborGrid`
signatures introduced in Task 3 are used identically in Task 4 (`exports.js`),
Task 6 (plain field copies, no direct calls needed), and Task 8
(`tileeditor.js`) — no drift. `tilegrids.js`'s exports (Task 2) are consumed
with matching names/argument order in Task 4's tests, Task 6, and Task 7.
`state.selectedTileId`/`editingTileId` (Task 5) are used consistently in
Tasks 6-9. Caught and fixed a duplicated `sheet.tiles.push(created)` line in
Task 6 Step 2's `commitCreateTile` before finalizing this document.
