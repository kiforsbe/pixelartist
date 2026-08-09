# Phase 3b — Tiles mode: autotile/Blob-47 paint tool migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the `application/`(`commands/`+`geometry/`)+`presentation/` split — already used for maps, sprites, and tiles' core tool (Phase 3a) — to `js/modes/tiles/autotile-paint-controller.js` (511 lines), the Blob-47 autotile painter. This is sub-phase 2 of 4 for tiles mode.

**Architecture:** Split the single legacy controller into four files: `application/geometry/autotile-geometry.js` (pure paint-grid/cell/mask math, no DOM/state), `application/commands/autotile-paint-commands.js` (3 resolve-by-id Command Handlers wrapping the geometry + `core/terrainsets.js`), `presentation/autotile-paint-presenter.js` (pointer routing + all Canvas rendering, dispatches Commands by id only), and `presentation/blob47-coverage-dialog.js` (the standalone coverage-review `<dialog>`, split out since it's a separate UI surface). `contributions.js` and `terrain-set-controller.js` get import-path updates only — no other mode's files change (`terrain-set-controller.js`'s own internals, `autotiles-panel.js`, `terrain-set-commands.js` are out of scope, deferred to Phase 3c).

**Tech Stack:** Vanilla JS (ES modules, no build step), Node's built-in `node:test` + `node:assert/strict` for unit tests, Playwright MCP for browser smoke verification.

## Global Constraints

- Command Handlers: `(services, sheetId, ...)` signature, resolve their sheet/terrain-set/tile by id via local `find*` helpers *inside* `apply`/`revert` closures — never a captured object reference held across a `services.projects.mutate()` boundary. This is the load-bearing lesson from Phase 3a's final review, where `createTile` briefly regressed on exactly this.
- Presenters dispatch Commands by id only: `getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args)`. A presentation-layer file never imports `application/commands/` or `core/commands.js` directly — enforced by `tests/architecture.test.mjs`.
- `application/` code (including this sub-phase's `autotile-paint-commands.js`) never touches `document`, `window`, `alert`, `confirm`, or `prompt` — enforced by `tests/architecture.test.mjs`'s banned-globals scan, which this plan extends to cover the new file.
- `services.history.execute()` shares the same `CommandStack` as the legacy global undo/redo (`state.commands`) — pre-existing infrastructure; `CommandStack.push()` runs `cmd.do()` synchronously, so a dispatched command's mutation is visible immediately after `dispatch(...)` returns.
- No command may capture a `tile`/`terrainSet` entity object in a closure across a `mutate()` boundary — every entity is re-resolved fresh inside each `apply`/`revert` via `sheet.tiles.find(...)` / `sheet.terrainSets.find(...)`, never held from an outer scope.
- Per-project convention, pointer-drag interactions are verified manually only — never simulated in Playwright (see the plan's final task, which uses only clicks).
- `core/blob47.js` and `core/blob47templates.js` are untouched by this migration — already pure, DOM-free Domain-level code.

---

## Task 1: Extract `application/geometry/autotile-geometry.js`

**Files:**
- Create: `js/modes/tiles/application/geometry/autotile-geometry.js`

**Interfaces:**
- Consumes: `NEIGHBOR_BITS`, `blobIndexToMask`, `BLOB47_PAINT_CELLS` from `js/core/blob47.js` (already exist, unchanged).
- Produces: `describeMask(mask)`, `terrainPaintGrid(sheet, terrainSet)`, `paintTileAt(sheet, terrainSet, x, y)`, `paintCellAt(tile, x, y)`, `persistedPaintMask(tile, terrainSet)`, `strokePaintMask(tile, terrainSet, stroke)`, `planTerrainPaintCells(sheet, terrainSet)` — all consumed by Task 2 (commands) and Task 3 (presenter).

This file has no direct unit tests, matching Phase 3a's precedent (`tile-geometry.js` also has none) — its correctness is covered indirectly by Task 2's command tests (which exercise `planTerrainPaintCells` and `strokePaintMask` isn't directly tested here but is trivial pass-through) and Task 5's browser smoke check.

- [ ] **Step 1: Write `js/modes/tiles/application/geometry/autotile-geometry.js`**

```js
// js/modes/tiles/application/geometry/autotile-geometry.js
import { NEIGHBOR_BITS, blobIndexToMask, BLOB47_PAINT_CELLS } from '../../../../core/blob47.js';

export function describeMask(mask) {
  const names = {
    [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE',
    [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE',
    [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW',
    [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW',
  };
  const parts = Object.keys(names).filter(bit => mask & Number(bit)).map(bit => names[bit]);
  return parts.length ? parts.join(' + ') : 'isolated';
}

export function terrainPaintGrid(sheet, terrainSet) {
  if (!terrainSet || sheet.width % terrainSet.tileW || sheet.height % terrainSet.tileH) return null;
  return { cols: sheet.width / terrainSet.tileW, rows: sheet.height / terrainSet.tileH };
}

export function paintTileAt(sheet, terrainSet, x, y) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid || x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return null;
  const col = Math.floor(x / terrainSet.tileW), row = Math.floor(y / terrainSet.tileH);
  const tx = col * terrainSet.tileW, ty = row * terrainSet.tileH;
  return sheet.tiles.find(t => t.x === tx && t.y === ty && t.w === terrainSet.tileW && t.h === terrainSet.tileH) ?? null;
}

export function paintCellAt(tile, x, y) {
  const col = Math.min(2, Math.floor(((x - tile.x) * 3) / tile.w));
  const row = Math.min(2, Math.floor(((y - tile.y) * 3) / tile.h));
  return BLOB47_PAINT_CELLS.find(c => c.col === col && c.row === row) ?? null;
}

export function persistedPaintMask(tile, terrainSet) {
  return tile?.terrainSetId === terrainSet.id && tile.blobIndex != null ? blobIndexToMask[tile.blobIndex] : 0;
}

export function strokePaintMask(tile, terrainSet, stroke) {
  return stroke?.masks.get(tile.id) ?? persistedPaintMask(tile, terrainSet);
}

// Pure validation + diff for laying a neat full-sheet lattice over a terrain
// set's tile size, without ever creating a Tile Grid. A pre-existing tile is
// safe to reuse only when it exactly matches one cell; anything spanning
// cells would make a direct paint target ambiguous. Returns either
// `{ error }` or `{ grid, missing }` -- `missing` is the list of cell rects
// (`{x,y,w,h}`) that still need a standalone tile created by the caller.
export function planTerrainPaintCells(sheet, terrainSet) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid) return { error: `Sheet size must be divisible by ${terrainSet.tileW}×${terrainSet.tileH}.` };
  const expected = new Map();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const x = col * terrainSet.tileW, y = row * terrainSet.tileH;
    expected.set(`${x},${y}`, { x, y, w: terrainSet.tileW, h: terrainSet.tileH });
  }
  for (const tile of sheet.tiles) {
    const e = expected.get(`${tile.x},${tile.y}`);
    if (!e || tile.gridId != null || tile.w !== e.w || tile.h !== e.h) {
      return { error: 'Existing tiles must align exactly to the terrain size before terrain painting can start.' };
    }
    if (sheet.tiles.filter(t => t.x === tile.x && t.y === tile.y && t.w === tile.w && t.h === tile.h).length > 1) {
      return { error: 'Multiple tile records occupy the same terrain cell. Remove the duplicate before terrain painting.' };
    }
  }
  const missing = [];
  for (const e of expected.values()) {
    if (!sheet.tiles.some(t => t.x === e.x && t.y === e.y && t.w === e.w && t.h === e.h)) missing.push(e);
  }
  return { grid, missing };
}
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all existing tests still pass (this new file is not yet imported by anything, so nothing can regress).

- [ ] **Step 3: Commit**

```
git add js/modes/tiles/application/geometry/autotile-geometry.js
git commit -m "Extract pure Blob-47 paint geometry into application/geometry/autotile-geometry.js"
```

---

## Task 2: Create `application/commands/autotile-paint-commands.js` + tests

**Files:**
- Create: `js/modes/tiles/application/commands/autotile-paint-commands.js`
- Create: `tests/autotile-paint-commands.test.mjs`

**Interfaces:**
- Consumes: `runCommand` from `js/modes/tiles/application/commands/tile-sheet-commands.js` (existing, unchanged — `runCommand(services, sheetId, label, apply, revert)`); `newId` from `js/core/palettes.js`; `assignSlot` from `js/core/terrainsets.js`; `blobIndexFromPaintMask` from `js/core/blob47.js`; `planTerrainPaintCells` from Task 1's `../geometry/autotile-geometry.js`.
- Produces: `prepareTerrainPaint(services, sheetId, terrainSetId)` → `{ error }` or `{ grid }`; `paintTerrainStroke(services, sheetId, terrainSetId, strokeMasks)` (where `strokeMasks` is a `Map<tileId, mask>`) → `{ conflicts }` (a `Map<tileId, blobIndex>`); `resolveAutotilePaintConflict(services, sheetId, terrainSetId, tileId, blobIndex)` → `undefined`. All three consumed by Task 4's `contributions.js` command registration and dispatched from Task 3's presenter.

- [ ] **Step 1: Write the failing tests in `tests/autotile-paint-commands.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { createBitmap } from '../js/core/pixels.js';
import { blobIndexFromPaintMask } from '../js/core/blob47.js';
import {
  prepareTerrainPaint, paintTerrainStroke, resolveAutotilePaintConflict,
} from '../js/modes/tiles/application/commands/autotile-paint-commands.js';

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
    tiles: [], tileGrids: [], terrainSets: [], layers: [],
    ...overrides,
  };
}

function makeProject(sheet) { return { sheets: [sheet] }; }

const isolatedBlobIndex = blobIndexFromPaintMask(0);

test('prepareTerrainPaint creates the missing standalone cells and undoes', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] }); // 16x8 sheet, 8x8 cells -> 2 cells, none exist yet
  const services = makeServices(makeProject(sheet));

  const result = prepareTerrainPaint(services, 'sheet1', 'ts1');
  assert.deepEqual(result, { grid: { cols: 2, rows: 1 } });
  assert.equal(sheet.tiles.length, 2);
  assert.ok(sheet.tiles.every(t => t.w === 8 && t.h === 8));
  assert.equal(services.history.canUndo(), true);

  services.history.undo();
  assert.equal(sheet.tiles.length, 0);
});

test('prepareTerrainPaint returns an error and makes no history entry when the sheet size does not divide the terrain tile size', () => {
  const terrainSet = makeTerrainSet({ tileW: 5, tileH: 8 });
  const sheet = makeSheet({ width: 16, height: 8, terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const result = prepareTerrainPaint(services, 'sheet1', 'ts1');
  assert.equal(typeof result.error, 'string');
  assert.equal(sheet.tiles.length, 0);
  assert.equal(services.history.canUndo(), false);
});

test('prepareTerrainPaint is a no-op with no history entry when the sheet is already fully covered', () => {
  const terrainSet = makeTerrainSet();
  const existing = makeTile({ id: 'e1', x: 0, y: 0, w: 8, h: 8 });
  const existing2 = makeTile({ id: 'e2', x: 8, y: 0, w: 8, h: 8 });
  const sheet = makeSheet({ tiles: [existing, existing2], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const result = prepareTerrainPaint(services, 'sheet1', 'ts1');
  assert.deepEqual(result, { grid: { cols: 2, rows: 1 } });
  assert.equal(sheet.tiles.length, 2);
  assert.equal(services.history.canUndo(), false);
});

test('paintTerrainStroke assigns a blob slot for a painted tile and undoes', () => {
  const terrainSet = makeTerrainSet();
  const tile = makeTile({ id: 't1' });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const strokeMasks = new Map([['t1', 0]]);
  const { conflicts } = paintTerrainStroke(services, 'sheet1', 'ts1', strokeMasks);
  assert.equal(conflicts.size, 0);
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolatedBlobIndex);
  assert.equal(terrainSet.slots[isolatedBlobIndex], 't1');
  assert.equal(services.history.canUndo(), true);

  services.history.undo();
  assert.equal(tile.terrainSetId, undefined);
  assert.equal(tile.blobIndex, undefined);
  assert.deepEqual(terrainSet.slots, {});
});

test('paintTerrainStroke reports a conflict when two tiles resolve to the same blobIndex, leaving the loser untouched', () => {
  const terrainSet = makeTerrainSet();
  const a = makeTile({ id: 'a', x: 0, y: 0 });
  const b = makeTile({ id: 'b', x: 8, y: 0 });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  const strokeMasks = new Map([['a', 0], ['b', 0]]);
  const { conflicts } = paintTerrainStroke(services, 'sheet1', 'ts1', strokeMasks);
  assert.equal(conflicts.size, 1);
  assert.equal(conflicts.get('b'), isolatedBlobIndex);
  assert.equal(a.blobIndex, isolatedBlobIndex);
  assert.equal(b.terrainSetId, undefined, 'the conflicting tile is left untouched');

  services.history.undo();
  assert.equal(a.terrainSetId, undefined);
});

test('resolveAutotilePaintConflict reassigns a slot from its previous occupant and undoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolatedBlobIndex]: 'a' } });
  const a = makeTile({ id: 'a', x: 0, y: 0, terrainSetId: 'ts1', blobIndex: isolatedBlobIndex });
  const b = makeTile({ id: 'b', x: 8, y: 0, duplicateOf: 'a' });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  resolveAutotilePaintConflict(services, 'sheet1', 'ts1', 'b', isolatedBlobIndex);
  assert.equal(terrainSet.slots[isolatedBlobIndex], 'b');
  assert.equal(b.terrainSetId, 'ts1');
  assert.equal(b.blobIndex, isolatedBlobIndex);
  assert.equal(b.duplicateOf, undefined);
  assert.equal(a.terrainSetId, undefined, 'the previous occupant is vacated');
  assert.equal(a.blobIndex, undefined);

  services.history.undo();
  assert.equal(terrainSet.slots[isolatedBlobIndex], 'a');
  assert.equal(a.terrainSetId, 'ts1');
  assert.equal(a.blobIndex, isolatedBlobIndex);
  assert.equal(b.terrainSetId, undefined);
  assert.equal(b.duplicateOf, 'a', 'undo restores the original duplicateOf marker');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tests/autotile-paint-commands.test.mjs` errors on the import, since `js/modes/tiles/application/commands/autotile-paint-commands.js` does not exist yet.

- [ ] **Step 3: Write `js/modes/tiles/application/commands/autotile-paint-commands.js`**

```js
// js/modes/tiles/application/commands/autotile-paint-commands.js
import { runCommand } from './tile-sheet-commands.js';
import { newId } from '../../../../core/palettes.js';
import { assignSlot } from '../../../../core/terrainsets.js';
import { blobIndexFromPaintMask } from '../../../../core/blob47.js';
import { planTerrainPaintCells } from '../geometry/autotile-geometry.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

function standalonePaintTile(x, y, w, h) {
  return {
    id: newId('ti'), x, y, w, h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined,
    neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined,
    duplicateOf: undefined,
  };
}

// Prepare a neat full-sheet lattice without ever creating a Tile Grid, then
// push one undo entry only if any standalone cells were actually created.
export function prepareTerrainPaint(services, sheetId, terrainSetId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  const planned = planTerrainPaintCells(sheet, terrainSet);
  if (planned.error) return { error: planned.error };
  if (!planned.missing.length) return { grid: planned.grid };

  const before = sheet.tiles.slice();
  const after = before.concat(planned.missing.map(cell => standalonePaintTile(cell.x, cell.y, cell.w, cell.h)));
  runCommand(services, sheetId, 'create terrain paint cells',
    sheet => { sheet.tiles = after.slice(); },
    sheet => { sheet.tiles = before.slice(); });
  return { grid: planned.grid };
}

// Assigns every painted tile's Blob-47 slot from its finished stroke mask.
// A tile whose canonical shape collides with an already-claimed slot is
// reported as a conflict instead of silently overwriting it; the caller
// resolves conflicts explicitly via resolveAutotilePaintConflict.
export function paintTerrainStroke(services, sheetId, terrainSetId, strokeMasks) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  if (!terrainSet || !strokeMasks.size) return { conflicts: new Map() };

  const beforeSlots = { ...terrainSet.slots };
  const afterSlots = { ...beforeSlots };
  const beforeTiles = new Map();
  const afterTiles = new Map();
  const candidates = [];
  const conflicts = new Map();
  for (const [tileId, mask] of strokeMasks) {
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile || (tile.terrainSetId != null && tile.terrainSetId !== terrainSet.id)) continue;
    beforeTiles.set(tileId, { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex, duplicateOf: tile.duplicateOf });
    for (const idx of Object.keys(afterSlots)) if (afterSlots[idx] === tileId) delete afterSlots[idx];
    candidates.push({ tileId, blobIndex: blobIndexFromPaintMask(mask) });
  }
  for (const candidate of candidates) {
    const owner = afterSlots[candidate.blobIndex];
    if (owner != null && owner !== candidate.tileId) { conflicts.set(candidate.tileId, candidate.blobIndex); continue; }
    afterSlots[candidate.blobIndex] = candidate.tileId;
    afterTiles.set(candidate.tileId, { terrainSetId: terrainSet.id, blobIndex: candidate.blobIndex, duplicateOf: undefined });
  }
  // A conflicted tile was removed from the working slots above only if it had
  // moved. Restore it exactly, and do not create a history command if every
  // changed cell was blocked by a duplicate/other terrain set.
  for (const candidate of candidates) if (conflicts.has(candidate.tileId)) {
    const before = beforeTiles.get(candidate.tileId);
    if (before?.terrainSetId === terrainSet.id && before.blobIndex != null) afterSlots[before.blobIndex] = candidate.tileId;
  }
  if (afterTiles.size) {
    runCommand(services, sheetId, 'paint autotile terrain',
      sheet => {
        const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
        terrainSet.slots = { ...afterSlots };
        for (const [id, next] of afterTiles) Object.assign(sheet.tiles.find(t => t.id === id), next);
      },
      sheet => {
        const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
        terrainSet.slots = { ...beforeSlots };
        for (const [id, prev] of beforeTiles) Object.assign(sheet.tiles.find(t => t.id === id), prev);
      });
  }
  return { conflicts };
}

// Conflicts are deliberately non-destructive during a paint stroke. This is
// the explicit escape hatch: replace the old artwork for that Blob-47 shape
// only when the user asks to use the newly painted tile.
export function resolveAutotilePaintConflict(services, sheetId, terrainSetId, tileId, blobIndex) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!terrainSet || !tile) return;

  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));

  assignSlot(sheet, terrainSet, blobIndex, tile);
  tile.duplicateOf = undefined;

  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));

  runCommand(services, sheetId, 'replace autotile terrain art',
    sheet => {
      const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
      terrainSet.slots = { ...afterSlots };
      for (const entry of afterTiles) {
        const t = sheet.tiles.find(x => x.id === entry.id);
        if (t) Object.assign(t, { terrainSetId: entry.terrainSetId, blobIndex: entry.blobIndex, duplicateOf: entry.duplicateOf });
      }
    },
    sheet => {
      const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
      terrainSet.slots = { ...beforeSlots };
      for (const entry of beforeTiles) {
        const t = sheet.tiles.find(x => x.id === entry.id);
        if (t) Object.assign(t, { terrainSetId: entry.terrainSetId, blobIndex: entry.blobIndex, duplicateOf: entry.duplicateOf });
      }
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the 6 new tests in `tests/autotile-paint-commands.test.mjs`.

- [ ] **Step 5: Commit**

```
git add js/modes/tiles/application/commands/autotile-paint-commands.js tests/autotile-paint-commands.test.mjs
git commit -m "Add resolve-by-id Command Handlers for the Blob-47 autotile painter"
```

---

## Task 3: Create the Presenter and the coverage dialog

**Files:**
- Create: `js/modes/tiles/presentation/autotile-paint-presenter.js`
- Create: `js/modes/tiles/presentation/blob47-coverage-dialog.js`

**Interfaces:**
- Consumes: Task 1's `describeMask`, `terrainPaintGrid`, `paintTileAt`, `paintCellAt`, `strokePaintMask` from `../application/geometry/autotile-geometry.js`; Task 2's 3 commands, dispatched by id (`tiles.prepareTerrainPaint`, `tiles.paintTerrainStroke`, `tiles.resolveAutotilePaintConflict` — registered in Task 4, but the dispatch calls are written now); `getTileSheetCanvas` from the existing `./tile-raster-cache.js`; `NEIGHBOR_BITS`/`blobIndexToMask`/`blobIndexFromPaintMask`/`BLOB47_PAINT_CELLS`/`BLOB47_8X6_RAW`/`terrainNeighborPreviewCells` from the existing, unchanged `core/blob47.js`/`core/blob47templates.js`.
- Produces: `registerAutotilePaintTool()`, `bindAutotilePaintTool(view)`, `startAutotilePaint(sheet, terrainSet)`, `stopAutotilePaint()`, `useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex)`, `getAutotilePaintSession()`, `setAutotilePaintBrush(brush)`, `getBlob47ReferenceImage()` (all from the presenter) and `openBlob47Coverage(sheet, terrainSet)`, `refreshBlob47CoverageIfOpen()` (from the dialog file) — consumed by Task 4's `contributions.js` and `terrain-set-controller.js` import updates. External signatures of every one of these functions are unchanged from the original `autotile-paint-controller.js` (only their internal implementation and file location change), so Task 4's consumer call sites need no rewrite beyond the import path.

These two files have no direct unit tests (they are DOM/Canvas-only — Node's test runner has no `document`/`CanvasRenderingContext2D`). Correctness is verified by Task 5's browser smoke check. Note: `autotile-paint-presenter.js` imports `refreshBlob47CoverageIfOpen` from `blob47-coverage-dialog.js`, and `blob47-coverage-dialog.js` imports `getBlob47ReferenceImage` from `autotile-paint-presenter.js` — this is a circular import between two sibling files. It's safe here because both usages are inside function bodies invoked only after both modules finish loading (never at module-evaluation/top-level scope), and ES module function declarations are hoisted with live bindings.

- [ ] **Step 1: Write `js/modes/tiles/presentation/autotile-paint-presenter.js`**

```js
// js/modes/tiles/presentation/autotile-paint-presenter.js
// Blob-47 terrain paint tool: pointer/stroke routing + overlay/preview
// rendering (Humble Object) -- geometry math lives in
// application/geometry/autotile-geometry.js; all project mutations go
// through CommandRegistry by id, never a direct import.

import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { registerTool } from '../../../ui/tools.js';
import { blobIndexToMask, blobIndexFromPaintMask, BLOB47_PAINT_CELLS } from '../../../core/blob47.js';
import { BLOB47_8X6_RAW, terrainNeighborPreviewCells } from '../../../core/blob47templates.js';
import { getTileSheetCanvas as getFlatCanvas } from './tile-raster-cache.js';
import { refreshBlob47CoverageIfOpen } from './blob47-coverage-dialog.js';
import {
  describeMask, terrainPaintGrid, paintTileAt, paintCellAt, strokePaintMask,
} from '../application/geometry/autotile-geometry.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

// A Tiled-style terrain editor paints the meaningful Wang positions directly
// over tileset art. Blob-47 is the binary, reduced version of that model, so
// this keeps only one paint color (terrain) plus erase, then derives the
// canonical slot at the end of each pointer stroke.
let autotilePaint = null; // { terrainSetId, brush: 'paint'|'erase', stroke, conflicts:Map<tileId,blobIndex>, hover }

function beginTerrainPaintStroke(ev, view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  if (!sheet || !terrainSet) return;
  // Secondary-button drags always erase, independent of the selected brush.
  autotilePaint.stroke = { masks: new Map(), seen: new Set(), brush: (ev.buttons & 2) ? 'erase' : autotilePaint.brush };
  applyTerrainPaintPoint(ev, view);
}

function applyTerrainPaintPoint(ev, view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke) return;
  const tile = paintTileAt(sheet, terrainSet, ev.x, ev.y);
  const cell = tile && paintCellAt(tile, ev.x, ev.y);
  autotilePaint.hover = tile && cell ? { tileId: tile.id, bit: cell.bit } : null;
  if (tile && cell) autotilePaint.previewTileId = tile.id;
  if (!tile || !cell) return;
  const key = `${tile.id}:${cell.bit}`;
  if (stroke.seen.has(key)) return;
  stroke.seen.add(key);
  const mask = strokePaintMask(tile, terrainSet, stroke);
  stroke.masks.set(tile.id, stroke.brush === 'erase' ? (mask & ~cell.bit) : (mask | cell.bit));
  view.requestRender();
}

function commitTerrainPaintStroke(view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke?.masks.size) { if (autotilePaint) autotilePaint.stroke = null; return; }
  const result = dispatch('tiles.paintTerrainStroke', { sheetId: sheet.id, terrainSetId: terrainSet.id, strokeMasks: stroke.masks });
  autotilePaint.conflicts = result?.conflicts ?? new Map();
  autotilePaint.stroke = null;
  refreshBlob47CoverageIfOpen();
  view.requestRender();
}

function drawAutotilePaintOverlay(ctx, view) {
  if (!autotilePaint || state.tool !== 'autotilepaint' || state.mode !== 'tiles') return;
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
  const grid = sheet && terrainSet && terrainPaintGrid(sheet, terrainSet);
  if (!sheet || !terrainSet || !grid) return;
  ctx.save();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const tile = paintTileAt(sheet, terrainSet, col * terrainSet.tileW, row * terrainSet.tileH);
    if (!tile) continue;
    const mask = strokePaintMask(tile, terrainSet, autotilePaint.stroke);
    const p0 = view.imageToScreen(tile.x, tile.y), p1 = view.imageToScreen(tile.x + tile.w, tile.y + tile.h);
    const cw = (p1.x - p0.x) / 3, ch = (p1.y - p0.y) / 3;
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    ctx.strokeRect(p0.x + .5, p0.y + .5, p1.x - p0.x - 1, p1.y - p0.y - 1);
    for (const cell of BLOB47_PAINT_CELLS) if (mask & cell.bit) {
      ctx.fillStyle = 'rgba(74, 201, 122, .45)';
      ctx.fillRect(p0.x + cell.col * cw + 1, p0.y + cell.row * ch + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
    }
    if (autotilePaint.conflicts?.has(tile.id)) {
      ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 2;
      ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    }
    if (autotilePaint.hover?.tileId === tile.id) {
      const hover = BLOB47_PAINT_CELLS.find(c => c.bit === autotilePaint.hover.bit);
      if (hover) {
        ctx.strokeStyle = (autotilePaint.stroke?.brush ?? autotilePaint.brush) === 'erase' ? '#ef5350' : '#72d995'; ctx.lineWidth = 2;
        ctx.strokeRect(p0.x + hover.col * cw + 1, p0.y + hover.row * ch + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
      }
    }
  }
  drawAutotilePaintPreview(ctx, view, sheet, terrainSet);
  ctx.restore();
}

// A concrete 3x3 result preview is much easier to reason about than eight
// green metadata cells. It renders the hovered tile at the center and the
// actual resolved neighbor artwork around it, using the tentative stroke mask
// when a drag is currently in progress.
function drawAutotilePaintPreview(ctx, view, sheet, terrainSet) {
  const hoverId = autotilePaint?.hover?.tileId ?? autotilePaint?.previewTileId;
  const tile = hoverId ? sheet.tiles.find(t => t.id === hoverId) : null;
  if (!tile) return;
  const mask = strokePaintMask(tile, terrainSet, autotilePaint?.stroke);
  const blobIndex = blobIndexFromPaintMask(mask);
  // This is the comparison view the painter relies on, so give the artwork
  // room to be read rather than treating it like a small tooltip.  On small
  // canvases it still scales down enough to leave the sheet usable.
  const cellSize = Math.max(28, Math.min(108, Math.floor(Math.min(view.cssWidth, view.cssHeight) / 4.5)));
  const size = cellSize * 3;
  const x = Math.max(8, view.cssWidth - size - 10), y = 10;
  const flat = getFlatCanvas(sheet);
  const draw = (source, dx, dy, { flipH = false, flipV = false, rotate = 0 } = {}) => {
    if (!source) return;
    ctx.save();
    ctx.translate(x + dx * cellSize, y + dy * cellSize);
    ctx.translate(flipH ? cellSize : 0, flipV ? cellSize : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (rotate) {
      ctx.translate(cellSize / 2, cellSize / 2);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(-cellSize / 2, -cellSize / 2);
    }
    ctx.drawImage(flat, source.x, source.y, source.w, source.h, 0, 0, cellSize, cellSize);
    ctx.restore();
  };
  const candidate = { ...tile, blobIndex };
  const neighbors = terrainNeighborPreviewCells(candidate, terrainSet);
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,18,.9)';
  ctx.fillRect(x - 3, y - 20, size + 6, size + 24);
  ctx.strokeStyle = '#8bd6ff'; ctx.lineWidth = 1;
  ctx.strokeRect(x - .5, y - .5, size + 1, size + 1);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.fillText(`Preview · ${describeMask(blobIndexToMask[blobIndex])}`, x, y - 17);
  for (const cell of neighbors) {
    const source = cell.tileId ? sheet.tiles.find(t => t.id === cell.tileId) : null;
    draw(source, cell.dx + 1, cell.dy + 1, cell);
  }
  draw(tile, 1, 1);
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(x + i * cellSize, y); ctx.lineTo(x + i * cellSize, y + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + i * cellSize); ctx.lineTo(x + size, y + i * cellSize); ctx.stroke();
  }
  ctx.strokeStyle = '#8bd6ff'; ctx.lineWidth = 2;
  ctx.strokeRect(x + cellSize + 1, y + cellSize + 1, cellSize - 2, cellSize - 2);
  drawBlob47Reference(ctx, view, sheet, terrainSet, blobIndex);
  ctx.restore();
}

let blob47ReferenceImage = null;
export function getBlob47ReferenceImage() {
  if (blob47ReferenceImage) return blob47ReferenceImage;
  const image = new Image();
  image.onload = () => emit('view'); // repaint the canvas once the artwork is ready
  image.src = 'assets/blob47-templates/blob47-8x6-reference.png';
  blob47ReferenceImage = image;
  return image;
}

// This is the real, bundled Blob-47 reference art rather than another
// symbolic mask diagram. It stays large enough to compare an artwork tile
// directly against the exact target shape it is being assigned to.
function drawBlob47Reference(ctx, view, sheet, terrainSet, selectedBlobIndex) {
  // Keep the complete reference visible on-canvas, but make each source tile
  // genuinely inspectable. The previous 32px cap made the 47-tile board read
  // more like an icon than a visual comparison aid.
  const cellSize = Math.max(20, Math.min(48,
    Math.floor((view.cssWidth - 20) / 8), Math.floor((view.cssHeight - 42) / 6)));
  const width = cellSize * 8, height = cellSize * 6;
  const x = 10, y = Math.max(26, view.cssHeight - height - 10);
  const image = getBlob47ReferenceImage();
  const flat = getFlatCanvas(sheet);
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,18,.9)';
  ctx.fillRect(x - 3, y - 18, width + 6, height + 22);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.fillText('Blob-47 artwork reference · blue = this tile', x, y - 15);
  if (image.complete && image.naturalWidth) ctx.drawImage(image, x, y, width, height);
  for (let row = 0; row < BLOB47_8X6_RAW.length; row++) {
    for (let col = 0; col < BLOB47_8X6_RAW[row].length; col++) {
      const rawMask = BLOB47_8X6_RAW[row][col];
      const blobIndex = blobIndexFromPaintMask(rawMask);
      const px = x + col * cellSize, py = y + row * cellSize;
      // Read the current, painted tilesheet records first. This is the live
      // artwork being edited; `slots` is only retained as a compatibility
      // fallback for older terrain sets.
      const paintedTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id && t.blobIndex === blobIndex && !t.duplicateOf);
      drawBlob47AssignedTileOverlay(ctx, flat, sheet, paintedTile?.id ?? terrainSet.slots?.[blobIndex], px, py, cellSize);
      drawBlob47PaintMarks(ctx, px, py, cellSize, blobIndexToMask[blobIndex]);
      ctx.strokeStyle = blobIndex === selectedBlobIndex ? '#28b9ff' : 'rgba(255,255,255,.22)';
      ctx.lineWidth = blobIndex === selectedBlobIndex ? 3 : 1;
      ctx.strokeRect(px + .5, py + .5, cellSize - 1, cellSize - 1);
    }
  }
  ctx.restore();
}

// Only show explicitly assigned slots here. Derived symmetry variants remain
// absent, which lets the board distinguish artwork the user has selected from
// shapes the editor can infer automatically.
function drawBlob47AssignedTileOverlay(ctx, flat, sheet, tileId, x, y, size) {
  const tile = tileId ? sheet.tiles.find(t => t.id === tileId) : null;
  if (!tile) return;
  ctx.save();
  ctx.globalAlpha = .67;
  ctx.translate(x, y);
  ctx.drawImage(flat, tile.x, tile.y, tile.w, tile.h, 0, 0, size, size);
  ctx.restore();
}

// Use exactly the painter's eight regions to annotate every example in the
// reference board. This makes the reference artwork a visual answer to
// "which parts should I paint for this tile?" rather than a second diagram
// the user has to translate mentally.
function drawBlob47PaintMarks(ctx, x, y, size, mask) {
  const unit = size / 3;
  for (const cell of BLOB47_PAINT_CELLS) {
    if (!(mask & cell.bit)) continue;
    const px = x + cell.col * unit, py = y + cell.row * unit;
    ctx.fillStyle = 'rgba(238, 82, 82, .5)';
    ctx.fillRect(px + 1, py + 1, Math.max(1, unit - 2), Math.max(1, unit - 2));
    ctx.strokeStyle = 'rgba(255, 222, 222, .5)'; ctx.lineWidth = 1;
    ctx.strokeRect(px + .5, py + .5, Math.max(0, unit - 1), Math.max(0, unit - 1));
  }
}

export function registerAutotilePaintTool() {
  registerTool({ id: 'autotilepaint', icon: '🧩', label: 'Autotile paint', key: 'a', isAvailable: () => state.mode === 'tiles' && !!autotilePaint });
}

export function bindAutotilePaintTool(view) {
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'tiles' && state.tool === 'autotilepaint' && autotilePaint) {
      if (ev.type === 'down') beginTerrainPaintStroke(ev, view);
      else if (ev.type === 'move') {
        if (autotilePaint.stroke) applyTerrainPaintPoint(ev, view);
        else {
          const sheet = activeSheet();
          const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
          const tile = sheet && terrainSet && paintTileAt(sheet, terrainSet, ev.x, ev.y);
          const cell = tile && paintCellAt(tile, ev.x, ev.y);
          autotilePaint.hover = tile && cell ? { tileId: tile.id, bit: cell.bit } : null;
          if (tile && cell) autotilePaint.previewTileId = tile.id;
          view.requestRender();
        }
      }
      else if (ev.type === 'up') commitTerrainPaintStroke(view);
      return;
    }
    prevPointer(ev);
  };
  const prevOverlay = view.onOverlay;
  view.onOverlay = (ctx) => { prevOverlay(ctx); drawAutotilePaintOverlay(ctx, view); };
  on('tool', () => { if (state.tool !== 'autotilepaint' && autotilePaint?.stroke) autotilePaint.stroke = null; });
}

export function startAutotilePaint(sheet, terrainSet) {
  const prepared = dispatch('tiles.prepareTerrainPaint', { sheetId: sheet.id, terrainSetId: terrainSet.id });
  if (prepared?.error) { alert(prepared.error); return; }
  const initialPreviewTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id)
    ?? sheet.tiles.find(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH);
  autotilePaint = {
    terrainSetId: terrainSet.id, brush: 'paint', stroke: null, conflicts: new Map(), hover: null,
    previewTileId: initialPreviewTile?.id ?? null,
  };
  state.tool = 'autotilepaint';
  emit('tool');
  emit('selection');
  emit('view');
}

export function stopAutotilePaint() {
  if (!autotilePaint) return;
  autotilePaint = null;
  if (state.tool === 'autotilepaint') state.tool = 'tiletool';
  emit('tool');
  emit('view');
}

// Conflicts are deliberately non-destructive during a paint stroke. This is
// the explicit escape hatch: replace the old artwork for that Blob-47 shape
// only when the user asks to use the newly painted tile.
export function useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex) {
  dispatch('tiles.resolveAutotilePaintConflict', { sheetId: sheet.id, terrainSetId: terrainSet.id, tileId, blobIndex });
  autotilePaint?.conflicts.delete(tileId);
  refreshBlob47CoverageIfOpen();
}

export function getAutotilePaintSession() {
  return autotilePaint;
}

export function setAutotilePaintBrush(brush) {
  if (!autotilePaint || (brush !== 'paint' && brush !== 'erase')) return;
  autotilePaint.brush = brush;
}
```

- [ ] **Step 2: Write `js/modes/tiles/presentation/blob47-coverage-dialog.js`**

```js
// js/modes/tiles/presentation/blob47-coverage-dialog.js
// The standalone Blob-47 coverage-review dialog: an inspectable board of
// all 47 canonical shapes, each card comparing the expected reference
// artwork against the terrain set's actual assigned tile.
import { blobIndexToMask, blobIndexFromPaintMask, resolveTerrainSlot } from '../../../core/blob47.js';
import { BLOB47_8X6_RAW } from '../../../core/blob47templates.js';
import { getTileSheetCanvas as getFlatCanvas } from './tile-raster-cache.js';
import { describeMask } from '../application/geometry/autotile-geometry.js';
import { getBlob47ReferenceImage } from './autotile-paint-presenter.js';

let blob47CoverageDialog = null;
let refreshBlob47Coverage = null;

// Large, inspectable reference board: each card places the expected Blob-47
// artwork above the terrain set's actual assigned tile. Missing patterns are
// intentionally loud instead of silently appearing as empty slots.
export function openBlob47Coverage(sheet, terrainSet) {
  if (!blob47CoverageDialog) {
    blob47CoverageDialog = document.createElement('dialog');
    document.body.appendChild(blob47CoverageDialog);
  }
  const dialog = blob47CoverageDialog;
  const render = () => {
    dialog.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = `${terrainSet.name} · Blob-47 coverage`;
    const help = document.createElement('p');
    help.textContent = 'Top: expected Blob-47 reference artwork. Bottom: your assigned tile. Red cards are missing.';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,72px);gap:6px;max-height:72vh;overflow:auto;padding:4px;';
    const flat = getFlatCanvas(sheet);
    const reference = getBlob47ReferenceImage();
    for (let row = 0; row < BLOB47_8X6_RAW.length; row++) for (let col = 0; col < BLOB47_8X6_RAW[row].length; col++) {
      const rawMask = BLOB47_8X6_RAW[row][col];
      const blobIndex = blobIndexFromPaintMask(rawMask);
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const source = resolved ? sheet.tiles.find(t => t.id === resolved.tileId) : null;
      const card = document.createElement('div');
      card.style.cssText = `border:2px solid ${source ? '#4f8cff' : '#ef5350'};background:${source ? '#171a22' : '#3d1619'};padding:2px;`;
      card.title = `${describeMask(blobIndexToMask[blobIndex])}${source ? ` — tile #${sheet.tiles.indexOf(source)}${resolved.rotate || resolved.flipH ? ' (derived)' : ''}` : ' — missing'}`;
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 128;
      canvas.style.cssText = 'display:block;width:64px;height:128px;image-rendering:pixelated;';
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      if (reference.complete && reference.naturalWidth) ctx.drawImage(reference, col * 32, row * 32, 32, 32, 0, 0, 64, 64);
      else { ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 64, 64); }
      ctx.fillStyle = source ? '#0d1016' : '#5d1c21'; ctx.fillRect(0, 64, 64, 64);
      if (source) {
        ctx.save();
        ctx.translate(0, 64);
        ctx.translate(resolved.flipH ? 64 : 0, resolved.flipV ? 64 : 0);
        ctx.scale(resolved.flipH ? -1 : 1, resolved.flipV ? -1 : 1);
        if (resolved.rotate) {
          ctx.translate(32, 32); ctx.rotate((resolved.rotate * Math.PI) / 180); ctx.translate(-32, -32);
        }
        ctx.drawImage(flat, source.x, source.y, source.w, source.h, 0, 0, 64, 64);
        ctx.restore();
      } else {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('MISSING', 32, 96);
      }
      const label = document.createElement('div');
      label.style.cssText = `font-size:10px;text-align:center;color:${source ? '#d6d7dc' : '#ffb4b4'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      label.textContent = source ? `#${sheet.tiles.indexOf(source)}` : 'MISSING';
      card.append(canvas, label); grid.appendChild(card);
    }
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
    dialog.append(title, help, grid, close);
  };
  refreshBlob47Coverage = () => {
    if (dialog.open) render();
  };
  dialog.onclose = () => { refreshBlob47Coverage = null; };
  render();
  const reference = getBlob47ReferenceImage();
  if (!reference.complete) reference.addEventListener('load', render, { once: true });
  if (!dialog.open) dialog.showModal();
}

export function refreshBlob47CoverageIfOpen() {
  refreshBlob47Coverage?.();
}
```

- [ ] **Step 3: Sanity-check both files parse**

Run (PowerShell):
```
node --check js/modes/tiles/presentation/autotile-paint-presenter.js
node --check js/modes/tiles/presentation/blob47-coverage-dialog.js
```
Expected: no output, exit code 0 from both (this only checks syntax, not the circular import — that gets exercised for real once Task 4 wires these files in and Task 5 loads the app in a browser).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, unchanged from Task 2 (these two new files are still unused by anything at this point).

- [ ] **Step 5: Commit**

```
git add js/modes/tiles/presentation/autotile-paint-presenter.js js/modes/tiles/presentation/blob47-coverage-dialog.js
git commit -m "Rebuild the Blob-47 autotile painter as a Presenter + split out the coverage dialog"
```

---

## Task 4: Wire up contributions, update the consumer, delete the old file

**Files:**
- Modify: `js/modes/tiles/contributions.js`
- Modify: `js/modes/tiles/terrain-set-controller.js:21-25`
- Delete: `js/modes/tiles/autotile-paint-controller.js`
- Modify: `tests/architecture.test.mjs`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything produced by Tasks 1-3.
- Produces: 3 new command ids registered — `tiles.prepareTerrainPaint`, `tiles.paintTerrainStroke`, `tiles.resolveAutotilePaintConflict` — matching exactly what Task 3's presenter already dispatches.

- [ ] **Step 1: Update `js/modes/tiles/contributions.js`**

Change the import on line 4 from:
```js
import { registerAutotilePaintTool, bindAutotilePaintTool } from './autotile-paint-controller.js';
```
to:
```js
import { registerAutotilePaintTool, bindAutotilePaintTool } from './presentation/autotile-paint-presenter.js';
```

Add a new import right after the existing `tile-sheet-commands.js` import block (currently lines 12-16):
```js
import {
  prepareTerrainPaint, paintTerrainStroke, resolveAutotilePaintConflict,
} from './application/commands/autotile-paint-commands.js';
```

Inside `registerTileCommands(api)`, add these 3 registrations after the existing `tiles.removeTileLayer` line:
```js
  api.commands.register({ id: 'tiles.prepareTerrainPaint', when: whenTiles, execute: (_c, { sheetId, terrainSetId }) => prepareTerrainPaint(services(), sheetId, terrainSetId) });
  api.commands.register({ id: 'tiles.paintTerrainStroke', when: whenTiles, execute: (_c, { sheetId, terrainSetId, strokeMasks }) => paintTerrainStroke(services(), sheetId, terrainSetId, strokeMasks) });
  api.commands.register({ id: 'tiles.resolveAutotilePaintConflict', when: whenTiles, execute: (_c, { sheetId, terrainSetId, tileId, blobIndex }) => resolveAutotilePaintConflict(services(), sheetId, terrainSetId, tileId, blobIndex) });
```

The rest of `contributions.js` (tool/panel/view registrations) is unchanged — `registerAutotilePaintTool`/`bindAutotilePaintTool` are called exactly as before, just imported from the new path.

- [ ] **Step 2: Update `js/modes/tiles/terrain-set-controller.js`**

Replace lines 21-25:
```js
import {
  getAutotilePaintSession, setAutotilePaintBrush,
  startAutotilePaint, stopAutotilePaint, useAutotilePaintConflict,
  openBlob47Coverage,
} from './autotile-paint-controller.js';
```
with:
```js
import {
  getAutotilePaintSession, setAutotilePaintBrush,
  startAutotilePaint, stopAutotilePaint, useAutotilePaintConflict,
} from './presentation/autotile-paint-presenter.js';
import { openBlob47Coverage } from './presentation/blob47-coverage-dialog.js';
```
No other line in this file changes — every call site of these 6 functions keeps its existing arguments, since none of the external signatures changed.

- [ ] **Step 3: Delete the old controller file**

```
git rm js/modes/tiles/autotile-paint-controller.js
```

- [ ] **Step 4: Update `tests/architecture.test.mjs`**

In the `'mode canvas controllers do not own contribution panels'` test, change:
```js
    join(root, 'js/modes/tiles/autotile-paint-controller.js'),
```
to:
```js
    join(root, 'js/modes/tiles/presentation/autotile-paint-presenter.js'),
```

In the `'mode command modules do not access browser UI globals'` test, add a new entry to the file list so the banned-globals scan covers the new command file:
```js
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
    join(root, 'js/modes/tiles/application/commands/autotile-paint-commands.js'),
  ]) {
```

- [ ] **Step 5: Update `docs/ARCHITECTURE.md`**

In the "Tiles mode" section, change the intro sentence (currently around line 245-249):
```
**Tiles mode** (`js/modes/tiles/`, 16 files, ~2430 lines) — this is the
mode the autotiles panel belongs to. It has partially migrated to the
Application/Presentation split (see the Sprites/Maps note below): the tile
sheet/grid tool and its commands have moved; the autotile painter and
terrain-set editor have not yet (planned for sub-phases 3b/3c):
```
to:
```
**Tiles mode** (`js/modes/tiles/`) — this is the mode the autotiles panel
belongs to. It has partially migrated to the Application/Presentation split
(see the Sprites/Maps note below): the tile sheet/grid tool and the Blob-47
autotile painter have moved; the terrain-set editor has not yet (planned
for sub-phase 3c):
```

Replace the `autotile-paint-controller.js` bullet (currently around line 280-282):
```
- `autotile-paint-controller.js` (484 lines) — the Blob-47 autotile
  painter tool. **Not yet migrated** — stays on the old (legacy,
  object-capture command style) pattern pending Phase 3b.
```
with:
```
- `application/commands/autotile-paint-commands.js` — Command Handlers
  for the Blob-47 terrain painter: `prepareTerrainPaint`,
  `paintTerrainStroke`, `resolveAutotilePaintConflict`. Resolve-by-id,
  registered by id in `contributions.js`. Wraps `core/terrainsets.js`'s
  pure `assignSlot` directly — no dependency on the still-legacy
  `terrain-set-commands.js`.
- `application/geometry/autotile-geometry.js` — pure paint-grid/cell/mask
  helpers (`terrainPaintGrid`, `paintTileAt`, `paintCellAt`,
  `strokePaintMask`, `planTerrainPaintCells`, `describeMask`), no DOM or
  state access. `core/blob47.js`'s Blob-47 bitmask/canonicalization
  algorithm itself remains untouched, already pure Domain code.
- `presentation/autotile-paint-presenter.js` — the autotile paint tool's
  Humble Object: pointer/stroke routing, conflict resolution, and all
  Canvas overlay/preview rendering (including the Blob-47 artwork
  reference strip). Dispatches Commands by id; never imports
  `application/commands/` directly (test-enforced).
- `presentation/blob47-coverage-dialog.js` — the standalone Blob-47
  coverage-review `<dialog>`, split out of the painter so the Presenter
  doesn't also own an unrelated `document.createElement` side-panel.
```

Leave the `terrain-set-controller.js`, `autotiles-panel.js`, and `terrain-set-commands.js` bullets exactly as they are — those files are unchanged by this sub-phase except `terrain-set-controller.js`'s import lines, which the doc doesn't need to call out.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 2 updated assertions in `tests/architecture.test.mjs`.

- [ ] **Step 7: Commit**

```
git add js/modes/tiles/contributions.js js/modes/tiles/terrain-set-controller.js tests/architecture.test.mjs docs/ARCHITECTURE.md
git rm js/modes/tiles/autotile-paint-controller.js
git commit -m "Wire the migrated autotile paint tool into contributions.js and retire the old controller"
```

---

## Task 5: Non-drag browser smoke check

**Files:** none (verification only).

**Interfaces:** none — this task exercises the finished feature end-to-end through the running app.

Per project convention, pointer-drag interactions are verified manually only, never simulated in Playwright. This task uses only clicks.

- [ ] **Step 1: Start the dev server**

Run (PowerShell), in the background:
```
.\serve.ps1
```
Note the printed port and the process PID (e.g. via `Get-Process node` or the job you started it as) — report both to the user at the end of this task along with the kill command (`Stop-Process -Id <PID> -Force`), and do not leave it running once this task is done.

- [ ] **Step 2: Open the app and reach a paintable state**

Using the Playwright MCP tools:
1. `browser_navigate` to `http://localhost:<port>/?autotest` (the `?autotest` query param suppresses `beforeunload`/`confirm` dialogs — see project convention).
2. `browser_snapshot` to see the current UI.
3. Switch to Tiles mode (click the Tiles tab/mode switcher).
4. If no tile sheet exists, create one via the app's own "New tile sheet" flow (use `browser_snapshot` to find the exact control — it's a standard document-creation flow, not part of this migration).
5. In the Autotiles panel, create a terrain set if none exists (click "Add Terrain Set" or equivalent — use `browser_snapshot` to find the exact button text) with a tile size matching the sheet's tile size.
6. Click the "🧩 Paint terrain" button in the terrain-set editor row. This calls the migrated `startAutotilePaint`, which dispatches `tiles.prepareTerrainPaint` — confirm via `browser_console_messages` that no errors were logged and that standalone paint-grid cells now appear on the canvas (if the sheet didn't already have full tile coverage).

- [ ] **Step 3: Paint a Blob-47 shape via clicks (not drags)**

1. `browser_snapshot` to get canvas coordinates.
2. Use `browser_click` (a single down+up at one point — not `browser_drag`) on one of the 8 paint-cell regions (edge/corner) of a tile in the paint overlay. A single click still exercises the full `beginTerrainPaintStroke` → `applyTerrainPaintPoint` → `commitTerrainPaintStroke` path (`down` then `up` at the same point), which now dispatches `tiles.paintTerrainStroke`.
3. `browser_snapshot` / `browser_take_screenshot` to confirm a green paint mark appears at the clicked cell.
4. Check `browser_console_messages` for errors.

- [ ] **Step 4: Create and resolve a conflict**

1. Click a different paint-cell region on a second tile such that it resolves to the same Blob-47 shape as the first tile (e.g. click the same relative corner/edge with nothing else painted, since an all-isolated stroke on any tile maps to the same canonical shape).
2. `browser_snapshot` — confirm the second tile now shows a red conflict outline and a "Use #N" button appears in the terrain-set editor panel (this reads `getAutotilePaintSession().conflicts`, populated by the `{ conflicts }` returned from `tiles.paintTerrainStroke`).
3. `browser_click` the "Use #N" button. This calls `useAutotilePaintConflict`, which dispatches `tiles.resolveAutotilePaintConflict`.
4. `browser_snapshot` — confirm the conflict button is gone and the second tile now owns that Blob-47 slot.
5. Check `browser_console_messages` for errors at each step.

- [ ] **Step 5: Open the Blob-47 coverage dialog**

1. `browser_click` the "🔎 Blob-47 coverage…" button.
2. `browser_snapshot` — confirm the dialog opens showing the 8x6 reference grid with the two painted tiles' cards showing blue borders (assigned) rather than red (missing).
3. Close the dialog.
4. Check `browser_console_messages` for errors — this specifically exercises the circular import between `autotile-paint-presenter.js` and `blob47-coverage-dialog.js` for real, since `openBlob47Coverage` calls `getBlob47ReferenceImage` across that boundary.

- [ ] **Step 6: Undo/redo round-trip**

1. Use the app's undo control (or keyboard shortcut) enough times to revert the conflict resolution and the paint strokes.
2. `browser_snapshot` after each undo to confirm the tiles' paint marks disappear in reverse order.
3. Redo back to the fully-painted state and confirm it matches Step 4's end state.
4. Check `browser_console_messages` for errors throughout.

- [ ] **Step 7: Stop the dev server**

Report the PID and kill command to the user; stop the server:
```
Stop-Process -Id <PID> -Force
```

- [ ] **Step 8: Report results**

Summarize: which steps passed, any console errors seen, any visual discrepancies from the pre-migration behavior. If everything passed cleanly, no commit is needed for this task (verification-only).

---
