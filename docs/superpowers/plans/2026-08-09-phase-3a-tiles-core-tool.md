# Phase 3a: Tiles Core Tool + Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the tile-sheet CRUD/resize/grid commands and the core tile-selection pointer tool onto the target `application/` + `presentation/` DDD layout established by `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md` (already fully done for maps and sprites), without touching the autotile-paint tool or the terrain-set editor dialog — those are separate, later sub-phases (3b, 3c) per the decomposition below.

**Architecture:** Follows the exact pattern already proven by `js/modes/maps/`: Command Handlers move to `application/commands/`, take a `services` bag (`{ projects, history }`) as their first argument, resolve entities by id from `services.projects.project` on every call (never close over a stale object reference), and mutate via a local `runCommand(services, sheetId, label, apply, revert)` helper built on `js/host/command-helpers.js`'s `runEntityCommand`. The pointer tool splits into a pure `application/geometry/tile-geometry.js` (hit-testing/resize math, verbatim-extracted — already side-effect-free in the current code) and a `presentation/tile-tool-presenter.js` Humble Object that calls geometry functions directly but commands only via `getEditorHost().registries.commands.execute(id, ...)`.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test`/`node:assert`, no build step, `npm test` runs the full suite.

## Sub-phase decomposition (context for why this plan stops where it does)

Tiles mode (~2,700 lines across `js/modes/tiles/` + `js/ui/tileeditor.js`) is larger than any single mode migrated so far, and contains three genuinely separate tools/dialogs. It is split into four sub-phases rather than one big-bang plan (mirroring how sprites split timeline/onion-skin into their own phases, but finer-grained since tiles has more separable surface area):

- **3a (this plan)** — Core tile tool + commands: `tile-sheet-commands.js`, `tile-layer-commands.js`, `tile-editor-controller.js`, `tile-raster-service.js`, `tile-panel.js`, `tile-layers-panel.js`, `tile-tags-field.js`. Establishes the CommandRegistry wiring for tiles from scratch (it currently has none) on the least risky code.
- **3b (future)** — Autotile paint tool: `autotile-paint-controller.js` → `application/geometry/autotile-geometry.js` + `presentation/autotile-paint-presenter.js`. Blob-47 stroke/mask logic is dense and isolated on purpose.
- **3c (future)** — Terrain-set editor: `terrain-set-controller.js`, `terrain-set-commands.js` → `application/geometry/terrain-layout.js` + `presentation/terrain-set-presenter.js`, plus `autotiles-panel.js`.
- **3d (future)** — Legacy `js/ui/tileeditor.js` absorption + final cleanup pass (remove any remaining direct `state.project` writes, tighten architecture tests).

## Global Constraints

- **Command Handler naming drops the `commit` prefix**, matching maps' (`paintMapTile`, not `commitPaintMapTile`) and sprites' established convention. Every migrated function is renamed accordingly; see the exact old→new name table in Task 1.
- **Every migrated command takes `(services, sheetId, ...)`**, resolves the sheet fresh via a local `findSheet(project, sheetId)` on every call (inside `apply`/`revert`, never captured by closure across a `mutate()` boundary) — mirrors `map-paint-commands.js`'s `findMap`/`findLayer` pattern exactly.
- **`services.history.execute()` shares the SAME `CommandStack` as the legacy global undo/redo.** Confirmed via `js/bootstrap.js:13-14`: `new EditorHost({ historyStack: legacyState.commands, ... })`. This means Ctrl+Z / the Undo menu item, which call `state.commands.undo()`/`canUndo()` (wired in `document-controller.js`), transparently undo the migrated tile commands too — no separate integration needed, exactly as already proven by maps/sprites.
- **`state.selectedTileId` / `state.selectedTerrainSetId` / `state.editingTileId` stay legacy `state.*` fields, untouched, for this phase.** They were explicitly ruled out of the Phase 2d SelectionService unification ("tiles-mode-only fields... explicitly OUT OF SCOPE") and stay that way here. Commands that today write these fields directly (`commitCreateTile`, `deleteTile`, `commitGrowTileIntoGrid`, `commitResizeGridAxis`, `commitDeleteGrid`) keep doing so, via a direct `import { state } from '../../../../app/state.js'` in the new command file — precedented by maps' commands importing `markDirty` from the same module.
- **`emit('selection')` is called directly from inside Command Handlers** when a command's own logic decides the new selection (e.g. auto-selecting a newly created tile) — this is NOT a Presenter decision here, unlike maps' plain paint commands. Precedented by `js/modes/sprites/application/commands/frame-commands.js` and `strip-commands.js`, which already call `emit('selection')` directly for the identical reason.
- **Pixel-layer sweep operations (`swapTiles`, `moveTile`) use `sheetLayers(sheet)` from `js/core/model.js`, never `currentContextLayers()` from `js/app/state.js`.** `currentContextLayers()` reads `state.project`/`state.selectedAnimationId` — unset in the isolated `EditorStore` the test suite's `makeServices()` helper builds, which would silently make swap/move tile commands operate on zero layers under test. `sheetLayers(sheet)` is a pure Domain function operating on the resolved sheet argument directly — correct in both production and test.
- **`services.history.execute(command)` calls `command.do()` exactly once, synchronously**, via `CommandStack.push()` (`js/core/commands.js:11-17`: `push(cmd) { cmd.do(); this.done.push(cmd); ... }`). Command functions that snapshot/mutate eagerly *before* constructing the do/undo pair (`deleteTile`, `addGrid`, `deleteGrid`, `growTileIntoGrid`, `resizeGridAxis`, `setGridCellField`) — because the underlying core helpers (`createTileGrid`, `resizeGridAxis`, `pruneEmptyTerrainSets`, etc.) have complex side effects not easily expressed as a pure apply/revert pair — mirror the *exact* pre-existing legacy pattern of eager-mutate-then-snapshot-array-swap. This causes the resulting `do()` to redundantly reassign an array to a clone of its own current content on first invocation; this is pre-existing, harmless, and intentional (not a regression introduced by this plan).
- **`js/modes/tiles/terrain-set-controller.js` and `js/modes/tiles/autotile-paint-controller.js` are OUT OF SCOPE for this plan** (they migrate in 3b/3c) but both currently import from files this plan moves/renames, so both need small, mechanical **import-path-and-call-signature updates only** — never a functional rewrite — to stay working:
  - `terrain-set-controller.js` calls `commitAddGrid(sheet, opts)` and `commitCreateTile(sheet, rect)` (2 call sites, lines 298 and 311) → becomes `addGrid(services(), sheet.id, opts)` / `createTile(services(), sheet.id, rect)`, with a tiny local `services()` helper added to that file (mirrors `contributions.js`'s existing `services()` shape).
  - `terrain-set-controller.js`, `autotile-paint-controller.js`, and `autotiles-panel.js` (which itself moves to `presentation/` in this plan) import `getTileSheetCanvas`/`tileThumbnailUrl`/`invalidateTileRaster` from `tile-raster-service.js`, which this plan relocates — their import paths update, nothing else.
- **`tests/architecture.test.mjs` hardcodes per-file paths for tiles that this plan partially moves.** Update only the paths for files this plan actually relocates (`tile-editor-controller.js` → `presentation/tile-tool-presenter.js`, `tile-sheet-commands.js`/`tile-layer-commands.js` → `application/commands/`). Leave `autotile-paint-controller.js`'s references at its current (unmoved) path — this exact mixed-state is already the file's own established precedent (compare line 63's already-migrated sprites path against line 65's still-legacy tiles path in the current file).
- No test file should assert against the old `commitX(sheet, ...)` / `commitX(tile, ...)` bare-object call signatures once migrated — `tests/tile-mode-commands.test.mjs`'s first test (`'tile metadata commands share undo/redo history without DOM dependencies'`) exercises exactly this and must be removed from that file (its second test, covering `terrain-set-commands.js`, is untouched and stays).

---

## Task 1: Migrate tile-sheet and tile-layer commands to `application/commands/`

**Files:**
- Create: `js/modes/tiles/application/commands/tile-sheet-commands.js`
- Create: `js/modes/tiles/application/commands/tile-layer-commands.js`
- Create: `tests/tile-sheet-commands.test.mjs`
- Create: `tests/tile-layer-commands.test.mjs`
- Modify: `js/modes/tiles/contributions.js` (add command registration; tool/panel/view wiring stays untouched until Task 5)
- Modify: `js/modes/tiles/terrain-set-controller.js` (2 call sites + a local `services()` helper — see Global Constraints)
- Modify: `tests/tile-mode-commands.test.mjs` (remove the first test, keep the terrain-set test)

**Do NOT delete `js/modes/tiles/tile-sheet-commands.js` or `js/modes/tiles/tile-layer-commands.js` in this task.** They stay in place, completely unmodified, as a temporary bridge: `tile-editor-controller.js` (deleted in Task 2), and `tile-panel.js`/`tile-tags-field.js`/`tile-layers-panel.js` (deleted in Task 4) still import the old `commitX` functions from them until those tasks land. Deleting the old files now would break every one of those still-unmigrated files' imports and fail `npm test` for this task. Task 4's final step deletes both old files, once its own changes remove their last remaining consumers.

**Old name → new name (all in the new `application/commands/tile-sheet-commands.js` unless noted):**

| Old (`js/modes/tiles/tile-sheet-commands.js`) | New | Old signature | New signature |
|---|---|---|---|
| `commitSwapTile(sheet, a, b)` | `swapTiles` | object refs | `(services, sheetId, aId, bId)` |
| `commitMoveTile(sheet, a, b)` | `moveTile` | object refs | `(services, sheetId, aId, bId)` |
| `commitMoveStandaloneTile(tile, dx, dy)` | `moveStandaloneTile` | object ref | `(services, sheetId, tileId, dx, dy)` |
| `commitResizeTile(tile, before, after)` | `resizeTile` | object ref | `(services, sheetId, tileId, before, after)` |
| `commitCreateTile(sheet, rect)` | `createTile` | object ref | `(services, sheetId, rect)` |
| `deleteTile(sheet, tileId)` | `deleteTile` (unchanged name) | object ref | `(services, sheetId, tileId)` |
| `commitMoveGrid(sheet, grid, dx, dy)` | `moveGrid` | object refs | `(services, sheetId, gridId, dx, dy)` |
| `commitGrowTileIntoGrid(sheet, tile, axis, side, count)` | `growTileIntoGrid` | object refs | `(services, sheetId, tileId, axis, side, count)` |
| `commitResizeGridAxis(sheet, grid, axis, side, count)` | `resizeGridAxis` | object refs | `(services, sheetId, gridId, axis, side, count)` |
| `commitAddGrid(sheet, opts)` | `addGrid` | object ref | `(services, sheetId, opts)` (still returns the created grid) |
| `commitDeleteGrid(sheet, grid)` | `deleteGrid` | object refs | `(services, sheetId, gridId)` |
| `commitGridCellField(sheet, grid, key, value)` | `setGridCellField` | object refs | `(services, sheetId, gridId, key, value)` |
| `commitDetachTile(tile)` | `detachTile` | object ref | `(services, sheetId, tileId)` |
| `commitTileLayer(tile, layer)` | `setTileLayer` | object ref | `(services, sheetId, tileId, layer)` |
| `commitTileName(tile, name)` | `renameTile` | object ref | `(services, sheetId, tileId, name)` |
| `commitTileTags(tile, tagsText)` | `setTileTags` | object ref | `(services, sheetId, tileId, tagsText)` |
| `commitTileSize(sheet, tile, key, value)` | `setTileSize` | object refs | `(services, sheetId, tileId, key, value)` |
| `openTileEditor(tileId)` | *(moves to Task 2's `presentation/tile-tool-presenter.js` — not a project-mutating command, no undo entry)* | — | — |

`js/modes/tiles/tile-layer-commands.js`:

| Old | New | New signature |
|---|---|---|
| `commitAddTileLayer(sheet, name)` | `addTileLayer` | `(services, sheetId, name)` |
| `commitRemoveTileLayer(sheet, name)` | `removeTileLayer` | `(services, sheetId, name)` |

**Interfaces:**
- Consumes: `runEntityCommand(services, label, resolve, apply, revert, { after })` from `js/host/command-helpers.js` (unchanged, already used by maps/sprites).
- Produces: `runCommand(services, sheetId, label, apply, revert)` — exported from `application/commands/tile-sheet-commands.js`, imported by `tile-layer-commands.js` (mirrors `map-layer-commands.js` importing `runCommand` from `map-paint-commands.js`). All 17+2 function names/signatures above are the public interface Task 2/4's presenter and panels dispatch against (by CommandRegistry id, never by direct import from `presentation/` files).

- [ ] **Step 1: Write `js/modes/tiles/application/commands/tile-sheet-commands.js`**

```js
// js/modes/tiles/application/commands/tile-sheet-commands.js
import { state, emit, markDirty } from '../../../../app/state.js';
import { copyRegion, blitRegion, fillRegion } from '../../../../core/pixels.js';
import { sheetLayers, scrubTileReferences } from '../../../../core/model.js';
import {
  ownedTiles, relayoutGrid, removeTileGrid, createTileGrid,
  detachTile as coreDetachTile, resizeGridAxis as coreResizeGridAxis,
  growTileIntoGrid as coreGrowTileIntoGrid, collapseGridToTile,
} from '../../../../core/tilegrids.js';
import { newId } from '../../../../core/palettes.js';
import { pruneEmptyTerrainSets, detachFromTerrainSetIfMismatched } from '../../../../core/terrainsets.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
function findTile(sheet, tileId) { return sheet.tiles.find(t => t.id === tileId) ?? null; }
function findGrid(sheet, gridId) { return sheet.tileGrids.find(g => g.id === gridId) ?? null; }

export function runCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSheet(project, sheetId), apply, revert);
  markDirty();
}

const cloneNb = v => v === undefined ? undefined : structuredClone(v);

export function swapTiles(services, sheetId, aId, bId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const a = findTile(sheet, aId), b = findTile(sheet, bId);
  const patches = sheetLayers(sheet).map(layer => ({
    layerId: layer.id,
    beforeA: copyRegion(layer.bitmap, a.x, a.y, a.w, a.h),
    beforeB: copyRegion(layer.bitmap, b.x, b.y, b.w, b.h),
  }));
  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };

  runCommand(services, sheetId, 'swap tiles',
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeB, a.x, a.y);
        blitRegion(layer.bitmap, p.beforeA, b.x, b.y);
      }
      a.name = namesBefore.b; b.name = namesBefore.a;
      a.neighbors = cloneNb(neighborsBefore.b); b.neighbors = cloneNb(neighborsBefore.a);
    },
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    });
}

export function moveTile(services, sheetId, aId, bId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const a = findTile(sheet, aId), b = findTile(sheet, bId);
  const patches = sheetLayers(sheet).map(layer => ({
    layerId: layer.id,
    beforeA: copyRegion(layer.bitmap, a.x, a.y, a.w, a.h),
    beforeB: copyRegion(layer.bitmap, b.x, b.y, b.w, b.h),
  }));
  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };

  runCommand(services, sheetId, 'move tile',
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeA, b.x, b.y);
        fillRegion(layer.bitmap, a.x, a.y, a.w, a.h, [0, 0, 0, 0]);
      }
      b.name = namesBefore.a; a.name = undefined;
      b.neighbors = cloneNb(neighborsBefore.a); a.neighbors = undefined;
    },
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    });
}

export function moveStandaloneTile(services, sheetId, tileId, dx, dy) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const before = { x: tile.x, y: tile.y };
  runCommand(services, sheetId, 'move tile',
    sheet => { const t = findTile(sheet, tileId); t.x = before.x + dx; t.y = before.y + dy; },
    sheet => { const t = findTile(sheet, tileId); t.x = before.x; t.y = before.y; });
}

export function resizeTile(services, sheetId, tileId, before, after) {
  runCommand(services, sheetId, 'resize tile',
    sheet => { const t = findTile(sheet, tileId); t.x = after.x; t.y = after.y; t.w = after.w; t.h = after.h; },
    sheet => { const t = findTile(sheet, tileId); t.x = before.x; t.y = before.y; t.w = before.w; t.h = before.h; });
}

export function createTile(services, sheetId, rect) {
  const id = newId('ti');
  runCommand(services, sheetId, 'add tile',
    sheet => {
      if (!findTile(sheet, id)) {
        sheet.tiles.push({
          id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, name: undefined, gridId: null,
          gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: undefined,
          blobIndex: undefined, layer: undefined, tags: undefined,
        });
      }
      state.selectedTileId = id;
    },
    sheet => {
      sheet.tiles = sheet.tiles.filter(t => t.id !== id);
      if (state.selectedTileId === id) state.selectedTileId = null;
    });
  emit('selection');
}

// Grid-owned tiles aren't deleted individually (shrink the grid, or detach
// first). Mutates eagerly, then snapshots before/after arrays for do/undo --
// see Global Constraints re: complex multi-entity operations.
export function deleteTile(services, sheetId, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (!tile || tile.gridId != null) return;
  const wasSelected = state.selectedTileId === tileId;
  const candidateTerrainSetId = tile.terrainSetId ?? null;
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  sheet.tiles = sheet.tiles.filter(t => t !== tile);
  scrubTileReferences(sheet, tile.id);
  const prunedIds = candidateTerrainSetId != null ? pruneEmptyTerrainSets(sheet, [candidateTerrainSetId]) : [];
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  if (state.selectedTileId === tileId) state.selectedTileId = null;
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  runCommand(services, sheetId, 'delete tile',
    sheet => {
      sheet.tiles = afterTiles.slice();
      sheet.terrainSets = afterSets.slice();
      if (state.selectedTileId === tileId) state.selectedTileId = null;
    },
    sheet => {
      sheet.tiles = beforeTiles.slice();
      sheet.terrainSets = beforeSets.slice();
      if (wasSelected) state.selectedTileId = tileId;
    });
  emit('selection');
}

export function moveGrid(services, sheetId, gridId, dx, dy) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const before = { x: grid.x, y: grid.y };
  runCommand(services, sheetId, 'move grid',
    sheet => { const g = findGrid(sheet, gridId); g.x = before.x + dx; g.y = before.y + dy; relayoutGrid(sheet, g); },
    sheet => { const g = findGrid(sheet, gridId); g.x = before.x; g.y = before.y; relayoutGrid(sheet, g); });
}

export function growTileIntoGrid(services, sheetId, tileId, axis, side, count) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  coreGrowTileIntoGrid(sheet, tile, axis, side, count);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  runCommand(services, sheetId, 'grow tile into grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); state.selectedTileId = tileId; },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); state.selectedTileId = tileId; });
  emit('selection');
}

export function resizeGridAxis(services, sheetId, gridId, axis, side, count) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  coreResizeGridAxis(sheet, grid, axis, side, count);
  let survivorId = null;
  if (grid.cols === 1 && grid.rows === 1) survivorId = collapseGridToTile(sheet, grid).id;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  runCommand(services, sheetId, 'resize grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); if (survivorId) state.selectedTileId = survivorId; },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); });
  if (survivorId) emit('selection');
}

export function addGrid(services, sheetId, opts) {
  const sheet = findSheet(services.projects.project, sheetId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const created = createTileGrid(sheet, opts);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  runCommand(services, sheetId, 'add grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); });
  return created;
}

export function deleteGrid(services, sheetId, gridId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  const candidateTerrainSetIds = [...new Set(ownedTiles(sheet, grid.id).map(t => t.terrainSetId).filter(id => id != null))];
  removeTileGrid(sheet, grid.id);
  const prunedIds = pruneEmptyTerrainSets(sheet, candidateTerrainSetIds);
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  if (state.selectedTileId != null && !sheet.tiles.some(t => t.id === state.selectedTileId)) state.selectedTileId = null;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  runCommand(services, sheetId, 'delete grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); sheet.terrainSets = afterSets.slice(); },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); sheet.terrainSets = beforeSets.slice(); });
}

export function setGridCellField(services, sheetId, gridId, key, value) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  if (grid[key] === value) return;
  const before = grid[key];
  const beforeRects = ownedTiles(sheet, grid.id).map(t => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h }));
  runCommand(services, sheetId, `edit grid ${key}`,
    sheet => { const g = findGrid(sheet, gridId); g[key] = value; relayoutGrid(sheet, g); },
    sheet => {
      const g = findGrid(sheet, gridId);
      g[key] = before;
      for (const r of beforeRects) {
        const t = findTile(sheet, r.id);
        t.x = r.x; t.y = r.y; t.w = r.w; t.h = r.h;
      }
    });
}

export function detachTile(services, sheetId, tileId) {
  const before = (() => {
    const sheet = findSheet(services.projects.project, sheetId);
    const t = findTile(sheet, tileId);
    return { gridId: t.gridId, gridCol: t.gridCol, gridRow: t.gridRow };
  })();
  runCommand(services, sheetId, 'detach tile from grid',
    sheet => { coreDetachTile(findTile(sheet, tileId)); },
    sheet => { const t = findTile(sheet, tileId); t.gridId = before.gridId; t.gridCol = before.gridCol; t.gridRow = before.gridRow; });
}

export function setTileLayer(services, sheetId, tileId, layer) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const after = layer || undefined;
  if (tile.layer === after) return;
  const before = tile.layer;
  runCommand(services, sheetId, 'set tile layer',
    sheet => { findTile(sheet, tileId).layer = after; },
    sheet => { findTile(sheet, tileId).layer = before; });
}

export function renameTile(services, sheetId, tileId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const before = tile.name;
  const after = name || undefined;
  if (before === after) return;
  runCommand(services, sheetId, 'rename tile',
    sheet => { findTile(sheet, tileId).name = after; },
    sheet => { findTile(sheet, tileId).name = before; });
}

export function setTileTags(services, sheetId, tileId, tagsText) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const tags = tagsText.split(',').map(value => value.trim()).filter(Boolean);
  const before = tile.tags ? [...tile.tags] : undefined;
  const after = tags.length ? tags : undefined;
  runCommand(services, sheetId, 'set tile tags',
    sheet => { findTile(sheet, tileId).tags = after ? [...after] : undefined; },
    sheet => { findTile(sheet, tileId).tags = before ? [...before] : undefined; });
}

export function setTileSize(services, sheetId, tileId, key, value) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (tile[key] === value) return;
  const before = { size: tile[key], terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  runCommand(services, sheetId, `edit tile ${key}`,
    sheet => { const t = findTile(sheet, tileId); t[key] = value; detachFromTerrainSetIfMismatched(sheet, t); },
    sheet => { const t = findTile(sheet, tileId); t[key] = before.size; t.terrainSetId = before.terrainSetId; t.blobIndex = before.blobIndex; });
}
```

- [ ] **Step 2: Write `js/modes/tiles/application/commands/tile-layer-commands.js`**

```js
// js/modes/tiles/application/commands/tile-layer-commands.js
import { runCommand } from './tile-sheet-commands.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

export function addTileLayer(services, sheetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.layers.slice();
  sheet.layers.push(name);
  const after = sheet.layers.slice();
  runCommand(services, sheetId, 'add layer name',
    sheet => { sheet.layers = after.slice(); },
    sheet => { sheet.layers = before.slice(); });
}

export function removeTileLayer(services, sheetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.layers.slice();
  const assignments = sheet.tiles.map(tile => ({ id: tile.id, layer: tile.layer }));
  sheet.layers = sheet.layers.filter(layer => layer !== name);
  for (const tile of sheet.tiles) if (tile.layer === name) tile.layer = undefined;
  const after = sheet.layers.slice();
  runCommand(services, sheetId, 'remove layer name',
    sheet => {
      sheet.layers = after.slice();
      for (const tile of sheet.tiles) if (tile.layer === name) tile.layer = undefined;
    },
    sheet => {
      sheet.layers = before.slice();
      for (const entry of assignments) {
        const tile = sheet.tiles.find(t => t.id === entry.id);
        if (tile) tile.layer = entry.layer;
      }
    });
}
```

- [ ] **Step 3: Register the commands in `contributions.js`**

Replace the current (empty of commands) `js/modes/tiles/contributions.js` top section with:

```js
import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './tile-editor-controller.js';
import { registerAutotilePaintTool, bindAutotilePaintTool } from './autotile-paint-controller.js';
import { mountTilePanel } from './tile-panel.js';
import { mountAutotilesPanel } from './autotiles-panel.js';
import { mountTileLayersPanel } from './tile-layers-panel.js';
import { mountTileEditor } from '../../ui/tileeditor.js';
import { renderTilePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  swapTiles, moveTile, moveStandaloneTile, resizeTile, createTile, deleteTile,
  moveGrid, growTileIntoGrid, resizeGridAxis, addGrid, deleteGrid, setGridCellField,
  detachTile, setTileLayer, renameTile, setTileTags, setTileSize,
} from './application/commands/tile-sheet-commands.js';
import { addTileLayer, removeTileLayer } from './application/commands/tile-layer-commands.js';

function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }

function registerTileCommands(api) {
  const whenTiles = keys => keys.modeId === 'tiles';
  api.commands.register({ id: 'tiles.swapTile', when: whenTiles, execute: (_c, { sheetId, aId, bId }) => swapTiles(services(), sheetId, aId, bId) });
  api.commands.register({ id: 'tiles.moveTile', when: whenTiles, execute: (_c, { sheetId, aId, bId }) => moveTile(services(), sheetId, aId, bId) });
  api.commands.register({ id: 'tiles.moveStandaloneTile', when: whenTiles, execute: (_c, { sheetId, tileId, dx, dy }) => moveStandaloneTile(services(), sheetId, tileId, dx, dy) });
  api.commands.register({ id: 'tiles.resizeTile', when: whenTiles, execute: (_c, { sheetId, tileId, before, after }) => resizeTile(services(), sheetId, tileId, before, after) });
  api.commands.register({ id: 'tiles.createTile', when: whenTiles, execute: (_c, { sheetId, rect }) => createTile(services(), sheetId, rect) });
  api.commands.register({ id: 'tiles.deleteTile', when: whenTiles, execute: (_c, { sheetId, tileId }) => deleteTile(services(), sheetId, tileId) });
  api.commands.register({ id: 'tiles.moveGrid', when: whenTiles, execute: (_c, { sheetId, gridId, dx, dy }) => moveGrid(services(), sheetId, gridId, dx, dy) });
  api.commands.register({ id: 'tiles.growTileIntoGrid', when: whenTiles, execute: (_c, { sheetId, tileId, axis, side, count }) => growTileIntoGrid(services(), sheetId, tileId, axis, side, count) });
  api.commands.register({ id: 'tiles.resizeGridAxis', when: whenTiles, execute: (_c, { sheetId, gridId, axis, side, count }) => resizeGridAxis(services(), sheetId, gridId, axis, side, count) });
  api.commands.register({ id: 'tiles.addGrid', when: whenTiles, execute: (_c, { sheetId, opts }) => addGrid(services(), sheetId, opts) });
  api.commands.register({ id: 'tiles.deleteGrid', when: whenTiles, execute: (_c, { sheetId, gridId }) => deleteGrid(services(), sheetId, gridId) });
  api.commands.register({ id: 'tiles.setGridCellField', when: whenTiles, execute: (_c, { sheetId, gridId, key, value }) => setGridCellField(services(), sheetId, gridId, key, value) });
  api.commands.register({ id: 'tiles.detachTile', when: whenTiles, execute: (_c, { sheetId, tileId }) => detachTile(services(), sheetId, tileId) });
  api.commands.register({ id: 'tiles.setTileLayer', when: whenTiles, execute: (_c, { sheetId, tileId, layer }) => setTileLayer(services(), sheetId, tileId, layer) });
  api.commands.register({ id: 'tiles.renameTile', when: whenTiles, execute: (_c, { sheetId, tileId, name }) => renameTile(services(), sheetId, tileId, name) });
  api.commands.register({ id: 'tiles.setTileTags', when: whenTiles, execute: (_c, { sheetId, tileId, tagsText }) => setTileTags(services(), sheetId, tileId, tagsText) });
  api.commands.register({ id: 'tiles.setTileSize', when: whenTiles, execute: (_c, { sheetId, tileId, key, value }) => setTileSize(services(), sheetId, tileId, key, value) });
  api.commands.register({ id: 'tiles.addTileLayer', when: whenTiles, execute: (_c, { sheetId, name }) => addTileLayer(services(), sheetId, name) });
  api.commands.register({ id: 'tiles.removeTileLayer', when: whenTiles, execute: (_c, { sheetId, name }) => removeTileLayer(services(), sheetId, name) });
}

export function registerTileContributions(api) {
  registerTileCommands(api);

  // ...rest of the function (previews/tools/panels/views registration) is unchanged in this task.
```

The rest of `registerTileContributions` (the `api.previews.register`/`api.tools.register`/`api.panels.register`/`api.views.register` calls) is untouched in this task — Task 5 updates those import paths once the files they reference move.

- [ ] **Step 4: Update `terrain-set-controller.js`'s two call sites**

Add near its top (alongside its existing imports):
```js
import { getEditorHost } from '../../host/runtime.js';
```
Add a small local helper near the top of the file:
```js
function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }
```
Change the import at line 25 from:
```js
import { commitAddGrid, commitCreateTile } from './tile-sheet-commands.js';
```
to:
```js
import { addGrid, createTile } from './application/commands/tile-sheet-commands.js';
```
Change line 298 from `commitAddGrid(sheet, {...})` to `addGrid(services(), sheet.id, {...})`.
Change line 311 from `commitCreateTile(sheet, {...})` to `createTile(services(), sheet.id, {...})`.

- [ ] **Step 5: Write `tests/tile-sheet-commands.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { createBitmap } from '../js/core/pixels.js';
import {
  swapTiles, moveTile, moveStandaloneTile, resizeTile, createTile, deleteTile,
  moveGrid, growTileIntoGrid, resizeGridAxis, addGrid, deleteGrid, setGridCellField,
  detachTile, setTileLayer, renameTile, setTileTags, setTileSize,
} from '../js/modes/tiles/application/commands/tile-sheet-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeTile(overrides = {}) {
  return { id: overrides.id ?? 't1', x: 0, y: 0, w: 8, h: 8, gridId: null, ...overrides };
}

function makeSheet(overrides = {}) {
  return {
    id: 'sheet1', width: 32, height: 32,
    layerTree: { type: 'group', id: 'root', children: [{ type: 'layer', id: 'l0', bitmap: createBitmap(32, 32), visible: true, opacity: 1 }] },
    tiles: [], tileGrids: [], terrainSets: [], layers: [],
    ...overrides,
  };
}

function makeProject(sheet) { return { sheets: [sheet] }; }

function resetLegacy() {
  state.commands = new CommandStack();
  state.dirty = false;
  state.selectedTileId = null;
  state.selectedTerrainSetId = null;
}

test('swapTiles swaps pixels and names between two same-size tiles, and undoes', () => {
  resetLegacy();
  const a = makeTile({ id: 'a', x: 0, y: 0, w: 8, h: 8, name: 'grass' });
  const b = makeTile({ id: 'b', x: 8, y: 0, w: 8, h: 8, name: 'water' });
  const sheet = makeSheet({ tiles: [a, b] });
  const layer = sheet.layerTree.children[0];
  layer.bitmap.data.fill(1, 0, 8 * 4);
  const services = makeServices(makeProject(sheet));

  swapTiles(services, 'sheet1', 'a', 'b');
  assert.equal(a.name, 'water');
  assert.equal(b.name, 'grass');
  assert.equal(layer.bitmap.data[0], 0);

  services.history.undo();
  assert.equal(a.name, 'grass');
  assert.equal(b.name, 'water');
  assert.equal(layer.bitmap.data[0], 1);
});

test('moveTile clears the source tile and moves name/pixels to the target, and undoes', () => {
  resetLegacy();
  const a = makeTile({ id: 'a', x: 0, y: 0, w: 8, h: 8, name: 'grass' });
  const b = makeTile({ id: 'b', x: 8, y: 0, w: 8, h: 8, name: undefined });
  const sheet = makeSheet({ tiles: [a, b] });
  const services = makeServices(makeProject(sheet));

  moveTile(services, 'sheet1', 'a', 'b');
  assert.equal(a.name, undefined);
  assert.equal(b.name, 'grass');

  services.history.undo();
  assert.equal(a.name, 'grass');
  assert.equal(b.name, undefined);
});

test('moveStandaloneTile offsets position and undoes', () => {
  resetLegacy();
  const tile = makeTile({ x: 4, y: 4 });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  moveStandaloneTile(services, 'sheet1', 't1', 3, -2);
  assert.deepEqual({ x: tile.x, y: tile.y }, { x: 7, y: 2 });
  services.history.undo();
  assert.deepEqual({ x: tile.x, y: tile.y }, { x: 4, y: 4 });
});

test('resizeTile applies and undoes a full rect change', () => {
  resetLegacy();
  const tile = makeTile({ x: 0, y: 0, w: 8, h: 8 });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  resizeTile(services, 'sheet1', 't1', { x: 0, y: 0, w: 8, h: 8 }, { x: 0, y: 0, w: 16, h: 12 });
  assert.deepEqual({ w: tile.w, h: tile.h }, { w: 16, h: 12 });
  services.history.undo();
  assert.deepEqual({ w: tile.w, h: tile.h }, { w: 8, h: 8 });
});

test('createTile adds a tile, selects it, and undo removes + deselects', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  createTile(services, 'sheet1', { x: 2, y: 2, w: 8, h: 8 });
  assert.equal(sheet.tiles.length, 1);
  assert.equal(state.selectedTileId, sheet.tiles[0].id);

  services.history.undo();
  assert.equal(sheet.tiles.length, 0);
  assert.equal(state.selectedTileId, null);

  services.history.redo();
  assert.equal(sheet.tiles.length, 1);
});

test('deleteTile removes a standalone tile and is undoable, refusing grid-owned tiles', () => {
  resetLegacy();
  const standalone = makeTile({ id: 's1' });
  const owned = makeTile({ id: 'o1', gridId: 'g1' });
  const sheet = makeSheet({ tiles: [standalone, owned], terrainSets: [] });
  const services = makeServices(makeProject(sheet));

  deleteTile(services, 'sheet1', 'o1');
  assert.equal(sheet.tiles.length, 2, 'grid-owned tiles are not deleted individually');

  deleteTile(services, 'sheet1', 's1');
  assert.equal(sheet.tiles.length, 1);
  assert.equal(sheet.tiles[0].id, 'o1');

  services.history.undo();
  assert.equal(sheet.tiles.length, 2);
});

test('setTileLayer, renameTile, setTileTags each round-trip through undo', () => {
  resetLegacy();
  const tile = makeTile();
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  setTileLayer(services, 'sheet1', 't1', 'terrain');
  renameTile(services, 'sheet1', 't1', 'grass');
  setTileTags(services, 'sheet1', 't1', 'green, ground');
  assert.deepEqual({ layer: tile.layer, name: tile.name, tags: tile.tags }, { layer: 'terrain', name: 'grass', tags: ['green', 'ground'] });

  services.history.undo();
  assert.equal(tile.tags, undefined);
  services.history.undo();
  assert.equal(tile.name, undefined);
  services.history.undo();
  assert.equal(tile.layer, undefined);
});

test('setTileSize detaches from a mismatched terrain set as part of the mutation, and undo restores it', () => {
  resetLegacy();
  const tile = makeTile({ w: 16, terrainSetId: 'ts1', blobIndex: 3 });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [{ id: 'ts1', tileW: 16, tileH: 8, slots: {}, symmetry: { flip: false, rotate: false } }] });
  const services = makeServices(makeProject(sheet));

  setTileSize(services, 'sheet1', 't1', 'w', 24);
  assert.equal(tile.w, 24);
  assert.equal(tile.terrainSetId, undefined, 'mismatched size detaches from its terrain set');

  services.history.undo();
  assert.equal(tile.w, 16);
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, 3);
});

test('addGrid creates a grid+tiles and undo removes them; deleteGrid reverses it', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);

  services.history.undo();
  assert.equal(sheet.tileGrids.length, 0);
  assert.equal(sheet.tiles.length, 0);

  services.history.redo();
  deleteGrid(services, 'sheet1', grid.id);
  assert.equal(sheet.tileGrids.length, 0);
  assert.equal(sheet.tiles.length, 0);

  services.history.undo();
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);
});

test('moveGrid offsets every owned tile via relayout, and undoes', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });

  moveGrid(services, 'sheet1', grid.id, 4, 0);
  assert.equal(grid.x, 4);
  assert.equal(sheet.tiles[0].x, 4);

  services.history.undo();
  assert.equal(grid.x, 0);
  assert.equal(sheet.tiles[0].x, 0);
});

test('setGridCellField resizes owned tiles via relayout, and undo restores their rects', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 2, rows: 1 });
  const beforeW = sheet.tiles[0].w;

  setGridCellField(services, 'sheet1', grid.id, 'cellW', 16);
  assert.equal(grid.cellW, 16);
  assert.equal(sheet.tiles[0].w, 16);

  services.history.undo();
  assert.equal(grid.cellW, 8);
  assert.equal(sheet.tiles[0].w, beforeW);
});

test('detachTile clears grid ownership and undo restores it', () => {
  resetLegacy();
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));
  const { grid } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 1, rows: 1 });
  const tileId = sheet.tiles[0].id;

  detachTile(services, 'sheet1', tileId);
  assert.equal(sheet.tiles[0].gridId, null);

  services.history.undo();
  assert.equal(sheet.tiles[0].gridId, grid.id);
});

test('growTileIntoGrid converts a standalone tile into a 1-cell grid and selects the survivor; resizeGridAxis can collapse back to one tile', () => {
  resetLegacy();
  const tile = makeTile({ id: 't1', x: 0, y: 0, w: 8, h: 8 });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  growTileIntoGrid(services, 'sheet1', 't1', 'cols', 'end', 2);
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);
  const grid = sheet.tileGrids[0];

  resizeGridAxis(services, 'sheet1', grid.id, 'cols', 'end', 1);
  assert.equal(sheet.tileGrids.length, 0, 'collapses back to a single standalone tile');
  assert.equal(sheet.tiles.length, 1);

  services.history.undo();
  assert.equal(sheet.tileGrids.length, 1);
  assert.equal(sheet.tiles.length, 2);
});
```

- [ ] **Step 6: Write `tests/tile-layer-commands.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { addTileLayer, removeTileLayer } from '../js/modes/tiles/application/commands/tile-layer-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  return { sheets: [{ id: 'sheet1', layers: [], tiles: [] }] };
}

test('addTileLayer appends a layer name and is undoable', () => {
  state.commands = new CommandStack(); state.dirty = false;
  const project = makeProject();
  const services = makeServices(project);

  addTileLayer(services, 'sheet1', 'terrain');
  assert.deepEqual(project.sheets[0].layers, ['terrain']);

  services.history.undo();
  assert.deepEqual(project.sheets[0].layers, []);

  services.history.redo();
  assert.deepEqual(project.sheets[0].layers, ['terrain']);
});

test('removeTileLayer clears the layer name from every tile that used it, and undo restores both', () => {
  state.commands = new CommandStack(); state.dirty = false;
  const project = makeProject();
  const sheet = project.sheets[0];
  sheet.layers = ['terrain', 'decor'];
  sheet.tiles = [{ id: 't1', layer: 'terrain' }, { id: 't2', layer: 'decor' }];
  const services = makeServices(project);

  removeTileLayer(services, 'sheet1', 'terrain');
  assert.deepEqual(sheet.layers, ['decor']);
  assert.equal(sheet.tiles[0].layer, undefined);
  assert.equal(sheet.tiles[1].layer, 'decor');

  services.history.undo();
  assert.deepEqual(sheet.layers, ['terrain', 'decor']);
  assert.equal(sheet.tiles[0].layer, 'terrain');
});
```

- [ ] **Step 7: Trim `tests/tile-mode-commands.test.mjs`**

Remove its first test (`'tile metadata commands share undo/redo history without DOM dependencies'`, lines 17-37) and the now-unused `commitTileLayer, commitTileName, commitTileTags` import from `../js/modes/tiles/tile-sheet-commands.js` (deleted in Step 3). Keep the `terrain-set-commands.js` import and its one remaining test (`'terrain-set lifecycle and metadata commands round-trip through history'`) exactly as-is.

- [ ] **Step 8: Run the affected tests**

Run: `npm test`
Expected: all tests pass, including the 2 new files and the trimmed `tile-mode-commands.test.mjs`. `terrain-set-controller.js`'s changed import will be exercised indirectly by any existing test that imports it (if none do, this step's real check is `npm test` reporting no import/syntax errors anywhere).

- [ ] **Step 9: Commit**

```
git add js/modes/tiles/application js/modes/tiles/contributions.js js/modes/tiles/terrain-set-controller.js tests/tile-sheet-commands.test.mjs tests/tile-layer-commands.test.mjs tests/tile-mode-commands.test.mjs
git commit -m "Migrate tile-sheet and tile-layer commands to application/commands/"
```

---

## Task 2: Extract tile geometry and rebuild the tool as a Presenter

**Files:**
- Create: `js/modes/tiles/application/geometry/tile-geometry.js`
- Create: `js/modes/tiles/presentation/tile-tool-presenter.js`
- Delete: `js/modes/tiles/tile-editor-controller.js`
- Modify: `js/modes/tiles/contributions.js` (update the tool-wiring import from `./tile-editor-controller.js` to `./presentation/tile-tool-presenter.js`)

**Interfaces:**
- Consumes: the 17 command ids registered in Task 1, dispatched via `getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args)`.
- Produces: `registerTileTool()`, `bindTileTool(view)`, `drawTileChrome(ctx, view)`, `openTileEditor(tileId)` — all exported from `presentation/tile-tool-presenter.js`, consumed by `contributions.js` (Task 5) and by `presentation/tile-panel.js` (Task 4, for `openTileEditor`).

- [ ] **Step 1: Write `js/modes/tiles/application/geometry/tile-geometry.js`**

Verbatim-extract the following functions from `js/modes/tiles/tile-editor-controller.js` lines 19-110 (`tileAt`, `hitHandle`, `hitGridHandle`, `gridBounds`, `tileGripGeometry`, `hitTileGrip`, `ghostGridFor`, plus the `HANDLE_SCREEN_PX`/`GRID_HANDLE_SCREEN_PX`/`GRIP_INSET_PX` constants) — no logic changes, only:
- Add `export` to every function.
- Update the two imports it needs: `import { gridCellRect, ownedTiles } from '../../../../core/tilegrids.js';` and `import { HANDLES_CORNER } from '../../../../core/resizeAnchor.js';` — wait, `gridCellRect`/`ownedTiles` are only used by `drawGridDims` (an overlay-drawing function, stays in the Presenter) and `drawTileToolGhost`/`drawTileChrome` (also stay in the Presenter) — the geometry functions being extracted here (lines 19-110) only need `HANDLES_CORNER` from `../../../../core/resizeAnchor.js`.

Full file:
```js
// js/modes/tiles/application/geometry/tile-geometry.js
import { HANDLES_CORNER } from '../../../../core/resizeAnchor.js';

export function tileAt(sheet, x, y) {
  for (let i = sheet.tiles.length - 1; i >= 0; i--) {
    const t = sheet.tiles[i];
    if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
  }
  return null;
}

export const HANDLE_SCREEN_PX = 6;
export const GRID_HANDLE_SCREEN_PX = 6;

// Resize handles only ever apply to a STANDALONE (gridId == null) selected
// tile -- a grid-owned tile's size is controlled by its grid's cellW/cellH.
export function hitHandle(view, tile, sx, sy) {
  if (!tile || tile.gridId != null) return null;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? tile.x : tile.x + tile.w;
    const iy = h[0] === 'n' ? tile.y : tile.y + tile.h;
    const p = view.imageToScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}

// A grid's own drag handle sits at its origin corner -- dragging an owned
// TILE is reserved for the swap/move interaction, so moving the whole grid
// needs a separate, always-visible affordance.
export function hitGridHandle(view, sheet, sx, sy) {
  for (const g of sheet.tileGrids) {
    const p = view.imageToScreen(g.x, g.y);
    if (Math.abs(sx - p.x) <= GRID_HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= GRID_HANDLE_SCREEN_PX) return g;
  }
  return null;
}

// Outer bounding box of everything a grid owns, in sheet-space.
export function gridBounds(grid) {
  return {
    x: grid.x, y: grid.y,
    w: grid.cols * (grid.cellW + grid.spacingX) - grid.spacingX,
    h: grid.rows * (grid.cellH + grid.spacingY) - grid.spacingY,
  };
}

// 4 edge-strip hit zones (screen space) around `bounds` (sheet-space
// {x,y,w,h}) -- either a standalone tile's own rect, or a grid's outer
// bounding box. Each strip is inset by a fixed number of screen pixels at
// both ends (matching HANDLE_SCREEN_PX/GRID_HANDLE_SCREEN_PX's 6px corner-
// handle size) rather than spanning the full edge.
const GRIP_INSET_PX = 12;

export function tileGripGeometry(view, bounds) {
  const p0 = view.imageToScreen(bounds.x, bounds.y);
  const p1 = view.imageToScreen(bounds.x + bounds.w, bounds.y + bounds.h);
  const gripH = Math.max(0, (p1.y - p0.y) - 2 * GRIP_INSET_PX);
  const gripW = Math.max(0, (p1.x - p0.x) - 2 * GRIP_INSET_PX);
  return [
    { axis: 'cols', side: 'start', x: p0.x - 3, y: p0.y + GRIP_INSET_PX, w: 6, h: gripH },
    { axis: 'cols', side: 'end', x: p1.x - 3, y: p0.y + GRIP_INSET_PX, w: 6, h: gripH },
    { axis: 'rows', side: 'start', x: p0.x + GRIP_INSET_PX, y: p0.y - 3, w: gripW, h: 6 },
    { axis: 'rows', side: 'end', x: p0.x + GRIP_INSET_PX, y: p1.y - 3, w: gripW, h: 6 },
  ];
}

export function hitTileGrip(grips, sx, sy) {
  for (const g of grips)
    if (sx >= g.x - 2 && sx <= g.x + g.w + 2 && sy >= g.y - 2 && sy <= g.y + g.h + 2)
      return { axis: g.axis, side: g.side };
  return null;
}

// A synthetic grid-shaped object representing the LIVE state of an
// in-progress gridresize drag, for rendering only -- never touches real
// sheet data.
export function ghostGridFor(d) {
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

- [ ] **Step 2: Write `js/modes/tiles/presentation/tile-tool-presenter.js`**

```js
// js/modes/tiles/presentation/tile-tool-presenter.js
// Tile-sheet pointer routing and overlay rendering (Humble Object) --
// geometry math lives in application/geometry/tile-geometry.js; all project
// mutations go through CommandRegistry by id, never a direct import.

import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { registerTool } from '../../../ui/tools.js';
import { gridCellRect, ownedTiles } from '../../../core/tilegrids.js';
import { rectBetween } from '../../../core/rect.js';
import { HANDLES_CORNER, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../../core/resizeAnchor.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { bindDragCancelGuard } from '../../../components/canvas/drag-cancel-guard.js';
import { drawRectDims, drawChainDims } from '../../../ui/dimlabels.js';
import {
  tileAt, hitHandle, hitGridHandle, gridBounds, tileGripGeometry, hitTileGrip, ghostGridFor,
} from '../application/geometry/tile-geometry.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

// Not a project-mutating command (no undo entry) -- pure UI navigation state
// on the legacy `state` object. Shared by this file's double-click handler
// and presentation/tile-panel.js's Edit button.
export function openTileEditor(tileId) {
  state.editingTileId = tileId;
  state.view = 'tile';
  emit('view');
}

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
    drag.rect = resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    });
  } else if (drag.kind === 'gridmove') {
    const sheet = activeSheet();
    const bounds = gridBounds(drag.grid);
    drag.dx = sheet ? Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - drag.anchor.x)) : ev.x - drag.anchor.x;
    drag.dy = sheet ? Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - drag.anchor.y)) : ev.y - drag.anchor.y;
  } else if (drag.kind === 'tiledrag') {
    drag.to = { x: ev.x, y: ev.y };
    drag.shift = ev.shiftKey;
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
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1) dispatch('tiles.createTile', { sheetId: sheet.id, rect: d.rect });
    return;
  }
  if (d.kind === 'gridmove') {
    if (d.dx !== 0 || d.dy !== 0) dispatch('tiles.moveGrid', { sheetId: sheet.id, gridId: d.grid.id, dx: d.dx, dy: d.dy });
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      dispatch('tiles.resizeTile', { sheetId: sheet.id, tileId: d.tile.id, before: d.before, after: r });
    return;
  }
  if (d.kind === 'tiledrag') {
    const from = d.from;
    if (from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === from.gridId);
      const bounds = gridBounds(grid);
      const dx = Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - d.anchor.x));
      const dy = Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - d.anchor.y));
      if (dx !== 0 || dy !== 0) dispatch('tiles.moveGrid', { sheetId: sheet.id, gridId: grid.id, dx, dy });
      return;
    }
    const target = tileAt(sheet, ev.x, ev.y);
    if (target && target !== from && target.w === from.w && target.h === from.h) {
      if (d.shift) dispatch('tiles.moveTile', { sheetId: sheet.id, aId: from.id, bId: target.id });
      else dispatch('tiles.swapTile', { sheetId: sheet.id, aId: from.id, bId: target.id });
      state.selectedTileId = target.id;
      emit('selection');
      return;
    }
    const dx = Math.max(-from.x, Math.min(sheet.width - (from.x + from.w), ev.x - d.anchor.x));
    const dy = Math.max(-from.y, Math.min(sheet.height - (from.y + from.h), ev.y - d.anchor.y));
    if (dx !== 0 || dy !== 0) dispatch('tiles.moveStandaloneTile', { sheetId: sheet.id, tileId: from.id, dx, dy });
    return;
  }
  if (d.kind === 'gridresize') {
    if (d.count === d.count0) return;
    if (d.grid) dispatch('tiles.resizeGridAxis', { sheetId: sheet.id, gridId: d.grid.id, axis: d.axis, side: d.side, count: d.count });
    else dispatch('tiles.growTileIntoGrid', { sheetId: sheet.id, tileId: d.tile.id, axis: d.axis, side: d.side, count: d.count });
    return;
  }
}

// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

const SELECTION_OUTLINE = '#ffe066';
function drawTileSelectionOutline(ctx, view, bounds) {
  ctx.save();
  ctx.strokeStyle = SELECTION_OUTLINE;
  ctx.lineWidth = 2;
  strokeGhostRect(ctx, view, bounds);
  ctx.restore();
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

const TILE_HANDLE = '#4f8cff';

function drawTileHandles(ctx, view, tile) {
  ctx.save();
  ctx.fillStyle = TILE_HANDLE;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? tile.x : tile.x + tile.w;
    const iy = h[0] === 'n' ? tile.y : tile.y + tile.h;
    const p = view.imageToScreen(ix, iy);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.restore();
}

function drawTileGrips(ctx, grips) {
  ctx.save();
  ctx.fillStyle = TILE_HANDLE;
  ctx.globalAlpha = 0.7;
  for (const g of grips) ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.restore();
}

function drawGridDims(ctx, view, grid, opts = {}) {
  const dx = opts.dx ?? 0, dy = opts.dy ?? 0;
  const shifted = (dx || dy) ? { ...grid, x: grid.x + dx, y: grid.y + dy } : grid;
  const alpha = opts.quiet ? 0.7 : 1;
  const last = gridCellRect(shifted, grid.cols - 1, grid.rows - 1);
  if (grid.cols > 1) {
    const bottomRow = Array.from({ length: grid.cols }, (_, col) => gridCellRect(shifted, col, grid.rows - 1));
    drawChainDims(ctx, view, {
      axis: 'h', edge: last.y + last.h,
      spans: bottomRow.map(r => ({ from: r.x, to: r.x + r.w, text: `${r.w}` })),
      alpha,
    });
  }
  if (grid.rows > 1) {
    const rightCol = Array.from({ length: grid.rows }, (_, row) => gridCellRect(shifted, grid.cols - 1, row));
    drawChainDims(ctx, view, {
      axis: 'v', edge: last.x + last.w,
      spans: rightCol.map(r => ({ from: r.y, to: r.y + r.h, text: `${r.h}` })),
      alpha,
    });
  }
  const overall = { x: shifted.x, y: shifted.y, w: last.x + last.w - shifted.x, h: last.y + last.h - shifted.y };
  drawRectDims(ctx, view, overall, {
    quiet: opts.quiet, dx: opts.dx, dy: opts.dy, dw: opts.dw, dh: opts.dh,
    wLevel: grid.cols > 1 ? 1 : 0, hLevel: grid.rows > 1 ? 1 : 0,
  });
}

function drawTileToolGhost(ctx, view) {
  if (state.mode !== 'tiles') return;
  const sheet = activeSheet();
  if (!sheet) return;

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
    if (drag.from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === drag.from.gridId);
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      for (const t of ownedTiles(sheet, grid.id))
        strokeGhostRect(ctx, view, { x: t.x + dx, y: t.y + dy, w: t.w, h: t.h });
    } else {
      const target = tileAt(sheet, drag.to.x, drag.to.y);
      const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
      if (swapCandidate) {
        ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
        strokeGhostRect(ctx, view, target);
      } else {
        const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
        strokeGhostRect(ctx, view, { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h });
      }
    }
  } else if (drag.kind === 'gridresize') {
    strokeGhostRect(ctx, view, gridBounds(ghostGridFor(drag)));
  }
  ctx.restore();

  if (drag.kind === 'create' && drag.rect) {
    drawRectDims(ctx, view, drag.rect);
  } else if (drag.kind === 'resize' && drag.rect) {
    drawRectDims(ctx, view, drag.rect, { dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h });
  } else if (drag.kind === 'gridmove') {
    drawGridDims(ctx, view, drag.grid, { dx: drag.dx, dy: drag.dy });
  } else if (drag.kind === 'tiledrag' && drag.to) {
    if (drag.from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === drag.from.gridId);
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      drawGridDims(ctx, view, grid, { dx, dy });
    } else {
      const target = tileAt(sheet, drag.to.x, drag.to.y);
      const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
      if (!swapCandidate) {
        const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
        const r = { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h };
        drawRectDims(ctx, view, r, { dx, dy });
      }
    }
  } else if (drag.kind === 'gridresize') {
    drawGridDims(ctx, view, ghostGridFor(drag), {
      dw: drag.axis === 'cols' ? (drag.count - drag.count0) * drag.step : 0,
      dh: drag.axis === 'rows' ? (drag.count - drag.count0) * drag.step : 0,
    });
  }
}

export function drawTileChrome(ctx, view) {
  if (state.mode !== 'tiles' || state.tool !== 'tiletool' || drag) return;
  const sheet = activeSheet();
  if (!sheet) return;
  const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
  if (!tile) return;
  if (tile.gridId != null) {
    const grid = sheet.tileGrids.find(g => g.id === tile.gridId);
    if (grid) {
      const bounds = gridBounds(grid);
      drawTileSelectionOutline(ctx, view, tile);
      drawGridDims(ctx, view, grid, { quiet: true });
      drawTileGrips(ctx, tileGripGeometry(view, bounds));
    }
  } else {
    drawTileSelectionOutline(ctx, view, tile);
    drawRectDims(ctx, view, tile, { quiet: true });
    drawTileHandles(ctx, view, tile);
    drawTileGrips(ctx, tileGripGeometry(view, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }));
  }
}

// ------------------------------------------------------------- public API

export function registerTileTool() {
  registerTool({ id: 'tiletool', icon: '🔲', key: 't', isAvailable: () => state.mode === 'tiles' });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'tiletool' || state.mode !== 'tiles') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedTileId) return;
    dispatch('tiles.deleteTile', { sheetId: sheet.id, tileId: state.selectedTileId });
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

  bindDragCancelGuard(on, {
    isToolActive: () => state.tool === 'tiletool',
    hasDrag: () => !!drag,
    cancel: () => { drag = null; lastClick = null; },
    requestRender: () => view.requestRender(),
  });
}
```

- [ ] **Step 3: Delete `js/modes/tiles/tile-editor-controller.js`**

- [ ] **Step 4: Update `contributions.js`'s import**

Change the top import from:
```js
import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './tile-editor-controller.js';
```
to:
```js
import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './presentation/tile-tool-presenter.js';
```

- [ ] **Step 5: Run the affected tests**

Run: `npm test`
Expected: all tests pass. `tests/architecture.test.mjs` will still reference the OLD `tile-editor-controller.js` path at this point (Task 5 updates it) — since that file no longer exists, its two hardcoded-path tests (`'mode canvas controllers do not own contribution panels'`, `'mode pointer controllers do not import contextual panels or terrain UI'`) will fail with an ENOENT on `readFile`. This is expected and intentionally deferred to Task 5, not a regression to fix here — note it in this task's completion report so it isn't mistaken for a new bug.

- [ ] **Step 6: Commit**

```
git add js/modes/tiles/application/geometry js/modes/tiles/presentation js/modes/tiles/contributions.js
git rm js/modes/tiles/tile-editor-controller.js
git commit -m "Extract tile geometry and rebuild the tile tool as a Presenter"
```

---

## Task 3: Relocate the raster cache to `presentation/`

**Files:**
- Create: `js/modes/tiles/presentation/tile-raster-cache.js`
- Delete: `js/modes/tiles/tile-raster-service.js`
- Modify: `js/modes/tiles/autotiles-panel.js` (import path only)
- Modify: `js/modes/tiles/terrain-set-controller.js` (import path only)
- Modify: `js/modes/tiles/autotile-paint-controller.js` (import path only)

**Interfaces:**
- Produces: `invalidateTileRaster()`, `getTileSheetCanvas(sheet)`, `tileThumbnailUrl(sheet, tile, opts)` — same names and signatures as today, just relocated (per the target layout, this file uses `document.createElement('canvas')`/`getContext('2d')`, genuine Canvas API use, so it belongs in `presentation/`, not `application/`).

- [ ] **Step 1: Write `js/modes/tiles/presentation/tile-raster-cache.js`**

Identical content to the current `js/modes/tiles/tile-raster-service.js`, with only the relative import paths adjusted for the new one-level-deeper location:
```js
// js/modes/tiles/presentation/tile-raster-cache.js
import { state } from '../../../app/state.js';
import { flattenSheet } from '../../../core/model.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';

const cache = createRasterCache();
const thumbnails = new Map();

function flatten(sheet) { return flattenSheet(sheet, state.floating); }

export function invalidateTileRaster() { cache.invalidate(); }

export function getTileSheetCanvas(sheet) {
  return cache.getCanvas(sheet, flatten);
}

export function tileThumbnailUrl(sheet, tile, { flipH = false, flipV = false, rotate = 0 } = {}) {
  const source = cache.getCanvas(sheet, flatten);
  const bitmap = cache.getBitmap(sheet, flatten);
  const key = `${tile.id}|${flipH}|${flipV}|${rotate}`;
  const cached = thumbnails.get(key);
  if (cached?.bitmap === bitmap) return cached.url;

  const scratch = document.createElement('canvas');
  scratch.width = tile.w;
  scratch.height = tile.h;
  const context = scratch.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.save();
  context.translate(flipH ? tile.w : 0, flipV ? tile.h : 0);
  context.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  if (rotate) {
    context.translate(tile.w / 2, tile.h / 2);
    context.rotate((rotate * Math.PI) / 180);
    context.translate(-tile.w / 2, -tile.h / 2);
  }
  context.drawImage(source, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
  context.restore();
  const url = scratch.toDataURL();
  thumbnails.set(key, { url, bitmap });
  return url;
}
```

- [ ] **Step 2: Delete `js/modes/tiles/tile-raster-service.js`**

- [ ] **Step 3: Update the 3 importers' paths**

In `js/modes/tiles/autotiles-panel.js`, `js/modes/tiles/terrain-set-controller.js`, and `js/modes/tiles/autotile-paint-controller.js`, change whatever import statement currently reads `from './tile-raster-service.js'` to `from './presentation/tile-raster-cache.js'`. (`autotiles-panel.js` itself moves into `presentation/` in Task 4 — if Task 4 is done after this task as planned, update `autotiles-panel.js`'s import path a second time in Task 4 to the same-directory `'./tile-raster-cache.js'`; if done in this step it's a one-time no-op difference, call it out in the Task 4 dispatch so the implementer doesn't duplicate the edit.)

- [ ] **Step 4: Run the affected tests**

Run: `npm test`
Expected: all tests pass (no test directly exercises this file today, so this step's real check is that nothing else broke).

- [ ] **Step 5: Commit**

```
git add js/modes/tiles/presentation/tile-raster-cache.js js/modes/tiles/autotiles-panel.js js/modes/tiles/terrain-set-controller.js js/modes/tiles/autotile-paint-controller.js
git rm js/modes/tiles/tile-raster-service.js
git commit -m "Relocate tile raster cache to presentation/"
```

---

## Task 4: Migrate the tile panels to `presentation/`

**Files:**
- Create: `js/modes/tiles/presentation/tile-panel.js`
- Create: `js/modes/tiles/presentation/tile-layers-panel.js`
- Create: `js/modes/tiles/presentation/tile-tags-field.js`
- Delete: `js/modes/tiles/tile-panel.js`
- Delete: `js/modes/tiles/tile-layers-panel.js`
- Delete: `js/modes/tiles/tile-tags-field.js`
- Delete: `js/modes/tiles/tile-sheet-commands.js` (the old, pre-Task-1 file — deferred here; see Task 1's note)
- Delete: `js/modes/tiles/tile-layer-commands.js` (same)
- Modify: `js/modes/tiles/contributions.js` (update the 3 panel-mount imports)

**Interfaces:**
- Consumes: `openTileEditor` from `./tile-tool-presenter.js` (same directory); command ids from Task 1, dispatched the same way as Task 2's presenter.
- Produces: `mountTilePanel(element)`, `mountTileLayersPanel(element, opts)`, `buildTagsField(sheet, tile)` (signature widened — see below) — same names, `contributions.js` import paths change.

- [ ] **Step 1: Write `js/modes/tiles/presentation/tile-tags-field.js`**

Widen `buildTagsField(tile)` to `buildTagsField(sheet, tile)` since `setTileTags` now needs a `sheetId`:

```js
// js/modes/tiles/presentation/tile-tags-field.js
import { state } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

let focusPending = false;

export function buildTagsField(sheet, tile) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tag-field';
  const label = document.createElement('span');
  label.className = 'tag-field-label';
  label.textContent = 'Tags';
  const box = document.createElement('div');
  box.className = 'tag-input';

  const tags = (tile.tags ?? []).slice();
  const commit = next => {
    focusPending = true;
    dispatch('tiles.setTileTags', { sheetId: sheet.id, tileId: tile.id, tagsText: next.join(',') });
  };

  const entry = document.createElement('input');
  entry.type = 'text';
  entry.className = 'tag-entry';
  entry.placeholder = tags.length ? '' : 'add tag…';

  tags.forEach((tag, index) => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.appendChild(document.createTextNode(tag));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = `Remove "${tag}"`;
    remove.addEventListener('click', event => {
      event.stopPropagation();
      commit(tags.filter((_, candidate) => candidate !== index));
    });
    pill.appendChild(remove);
    box.appendChild(pill);
  });

  function addFromEntry() {
    const additions = entry.value.split(/[, ]+/).map(value => value.trim()).filter(Boolean);
    if (!additions.length) return;
    entry.value = '';
    commit([...tags, ...additions]);
  }

  entry.addEventListener('keydown', event => {
    if (event.key === ',' || event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      addFromEntry();
    } else if (event.key === 'Backspace' && entry.value === '' && tags.length) {
      commit(tags.slice(0, -1));
    }
  });
  entry.addEventListener('blur', () => {
    if (entry.value.trim()) addFromEntry();
  });
  entry.addEventListener('paste', event => {
    event.preventDefault();
    entry.value += (event.clipboardData ?? window.clipboardData).getData('text');
    addFromEntry();
  });
  box.addEventListener('click', event => {
    if (event.target === box) entry.focus();
  });

  box.appendChild(entry);
  wrapper.append(label, box);
  if (focusPending) {
    focusPending = false;
    queueMicrotask(() => entry.focus());
  }
  return wrapper;
}
```

- [ ] **Step 2: Write `js/modes/tiles/presentation/tile-layers-panel.js`**

```js
// js/modes/tiles/presentation/tile-layers-panel.js
import { state, on, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { mountReactivePanel } from '../../../components/panel-mount.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

export function mountTileLayersPanel(element, { showVisibility = false, showOpacity = false } = {}) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Tile Layers';
  panel.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'layer-list';
  panel.appendChild(list);

  let selectedName = null;

  const actions = document.createElement('div');
  actions.className = 'row layer-actions';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn-icon-md';
  addButton.textContent = '➕';
  addButton.title = 'Add layer';
  addButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    dispatch('tiles.addTileLayer', { sheetId: sheet.id, name });
    selectedName = name;
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn-icon-md';
  deleteButton.textContent = '🗑';
  deleteButton.title = 'Delete layer';
  deleteButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || selectedName == null) return;
    dispatch('tiles.removeTileLayer', { sheetId: sheet.id, name: selectedName });
    selectedName = null;
  });

  actions.append(addButton, deleteButton);
  panel.appendChild(actions);

  function render() {
    if (state.mode !== 'tiles') {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const sheet = activeSheet();
    list.innerHTML = '';
    if (!sheet) return;
    if (selectedName != null && !sheet.layers.includes(selectedName)) selectedName = null;

    for (const name of sheet.layers) {
      const row = document.createElement('div');
      row.className = `layer-row${name === selectedName ? ' active' : ''}`;
      row.tabIndex = 0;
      row.addEventListener('click', () => {
        selectedName = name;
        render();
      });

      const nameElement = document.createElement('span');
      nameElement.className = 'layer-name';
      nameElement.textContent = name;
      row.appendChild(nameElement);

      void showVisibility;
      void showOpacity;
      list.appendChild(row);
    }
  }

  return mountReactivePanel(on, ['project', 'history', 'view', 'selection'], render);
}
```

- [ ] **Step 3: Write `js/modes/tiles/presentation/tile-panel.js`**

```js
// js/modes/tiles/presentation/tile-panel.js
import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import {
  buildAddTerrainSetDialog,
  terrainSetNameField,
  terrainSetLayerField,
  terrainSetDeleteButton,
  syncSelectedTerrainSetFromTile,
} from '../terrain-set-controller.js';
import { openTileEditor } from './tile-tool-presenter.js';
import { buildTagsField } from './tile-tags-field.js';
import { mountReactivePanel } from '../../../components/panel-mount.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

function sizeField(labelText, value, onCommit) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.value = String(value);
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => {
    let next = Number.parseInt(input.value, 10);
    if (!Number.isFinite(next) || next < 1) next = 1;
    input.value = String(next);
    onCommit(next);
  });
  label.appendChild(input);
  return label;
}

export function mountTilePanel(element) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Tiles';
  panel.appendChild(heading);

  const selectionRow = document.createElement('div');
  selectionRow.className = 'frame-row tile-selected';
  panel.appendChild(selectionRow);

  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const addTerrainSetButton = document.createElement('button');
  addTerrainSetButton.type = 'button';
  addTerrainSetButton.className = 'btn-sm';
  addTerrainSetButton.textContent = '➕ Autotiles';
  addTerrainSetButton.title = 'Add terrain set';
  addTerrainSetButton.addEventListener('click', () => {
    if (activeSheet()) addTerrainSetDialog.open();
  });

  const buttonRow = document.createElement('div');
  buttonRow.className = 'row layer-actions';
  buttonRow.append(addTerrainSetButton);
  panel.appendChild(buttonRow);

  function render() {
    if (state.mode !== 'tiles') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const sheet = activeSheet();
    selectionRow.innerHTML = '';
    selectionRow.classList.remove('active');
    if (!sheet) return;

    const tile = sheet.tiles.find(candidate => candidate.id === state.selectedTileId);
    if (!tile) {
      const terrainSet = sheet.terrainSets.find(candidate => candidate.id === state.selectedTerrainSetId);
      if (terrainSet) {
        selectionRow.classList.add('active');
        const title = document.createElement('div');
        title.className = 'frame-field';
        title.textContent = `Terrain set · ${terrainSet.tileW}×${terrainSet.tileH}`;
        const fields = document.createElement('div');
        fields.className = 'frame-fields';
        fields.append(terrainSetNameField(terrainSet), terrainSetLayerField(sheet, terrainSet));
        const actions = document.createElement('div');
        actions.className = 'row layer-actions';
        actions.appendChild(terrainSetDeleteButton(sheet, terrainSet));
        selectionRow.append(title, fields, actions);
        return;
      }
      const hint = document.createElement('span');
      hint.textContent = 'No tile selected';
      selectionRow.appendChild(hint);
      return;
    }
    selectionRow.classList.add('active');

    const grid = tile.gridId != null ? sheet.tileGrids.find(candidate => candidate.id === tile.gridId) : null;
    const terrainSet = tile.terrainSetId != null
      ? sheet.terrainSets.find(candidate => candidate.id === tile.terrainSetId)
      : null;

    const nameField = document.createElement('label');
    nameField.className = 'frame-field tile-name-field';
    nameField.appendChild(document.createTextNode('Tile name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = tile.name || '';
    nameInput.placeholder = `#${sheet.tiles.indexOf(tile)}`;
    nameInput.title = terrainSet
      ? 'Optional alias for this tile. This is separate from the terrain set name below.'
      : 'Optional alias for this tile; unnamed tiles use their sheet index.';
    nameInput.addEventListener('change', () => dispatch('tiles.renameTile', { sheetId: sheet.id, tileId: tile.id, name: nameInput.value.trim() }));
    nameField.appendChild(nameInput);

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    if (grid) {
      fields.append(
        sizeField('W', grid.cellW, value => dispatch('tiles.setGridCellField', { sheetId: sheet.id, gridId: grid.id, key: 'cellW', value })),
        sizeField('H', grid.cellH, value => dispatch('tiles.setGridCellField', { sheetId: sheet.id, gridId: grid.id, key: 'cellH', value })),
      );
    } else {
      fields.append(
        sizeField('W', tile.w, value => dispatch('tiles.setTileSize', { sheetId: sheet.id, tileId: tile.id, key: 'w', value })),
        sizeField('H', tile.h, value => dispatch('tiles.setTileSize', { sheetId: sheet.id, tileId: tile.id, key: 'h', value })),
      );
    }

    if (terrainSet) {
      fields.append(terrainSetNameField(terrainSet), terrainSetLayerField(sheet, terrainSet));
    } else {
      const layerField = document.createElement('label');
      layerField.className = 'frame-field';
      layerField.appendChild(document.createTextNode('Layer'));
      const layerSelect = document.createElement('select');
      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = '(none)';
      layerSelect.appendChild(noneOption);
      for (const name of sheet.layers) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        layerSelect.appendChild(option);
      }
      layerSelect.value = tile.layer ?? '';
      layerSelect.title = 'Tile Layer for this tile';
      layerSelect.addEventListener('change', () => dispatch('tiles.setTileLayer', { sheetId: sheet.id, tileId: tile.id, layer: layerSelect.value }));
      layerField.appendChild(layerSelect);
      fields.appendChild(layerField);
    }

    const actions = document.createElement('div');
    actions.className = 'row layer-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn-icon-md';
    editButton.textContent = '✎';
    editButton.title = 'Edit tile';
    editButton.addEventListener('click', () => openTileEditor(tile.id));
    actions.appendChild(editButton);
    if (grid) {
      const detachButton = document.createElement('button');
      detachButton.type = 'button';
      detachButton.className = 'btn-icon-md';
      detachButton.textContent = '⏏';
      detachButton.title = 'Detach from grid';
      detachButton.addEventListener('click', () => dispatch('tiles.detachTile', { sheetId: sheet.id, tileId: tile.id }));
      const deleteGridButton = document.createElement('button');
      deleteGridButton.type = 'button';
      deleteGridButton.className = 'btn-icon-md';
      deleteGridButton.textContent = '🗑';
      deleteGridButton.title = 'Delete grid';
      deleteGridButton.addEventListener('click', () => dispatch('tiles.deleteGrid', { sheetId: sheet.id, gridId: grid.id }));
      actions.append(detachButton, deleteGridButton);
    }
    if (terrainSet) actions.appendChild(terrainSetDeleteButton(sheet, terrainSet));

    selectionRow.append(nameField, fields, buildTagsField(sheet, tile), actions);
  }

  function syncSelection() {
    const sheet = activeSheet();
    if (sheet) syncSelectedTerrainSetFromTile(sheet.tiles.find(tile => tile.id === state.selectedTileId));
  }

  syncSelection();
  return mountReactivePanel(on, ['project', 'history', 'view', ['selection', syncSelection]], render);
}
```

Note `emit` is imported but unused by this file after migration — remove it from the import list (`import { state, on, activeSheet } from '../../../app/state.js';`) since every mutation now goes through `dispatch()`, which triggers the store's own change notifications.

- [ ] **Step 4: Delete the 5 old files**

Delete `js/modes/tiles/tile-panel.js`, `js/modes/tiles/tile-layers-panel.js`, `js/modes/tiles/tile-tags-field.js`, `js/modes/tiles/tile-sheet-commands.js`, `js/modes/tiles/tile-layer-commands.js`. The last two are the ORIGINAL command files Task 1 deliberately left in place — this step is safe now because every file that imported from them (`tile-editor-controller.js` in Task 2, and this task's own `tile-panel.js`/`tile-tags-field.js`/`tile-layers-panel.js`) has just been replaced; `terrain-set-controller.js` was already repointed at the new `application/commands/` location in Task 1 Step 4.

- [ ] **Step 5: Finish `autotiles-panel.js`'s raster-cache import path (if not already done in Task 3)**

If Task 3 was completed first, `autotiles-panel.js` currently imports from `'./presentation/tile-raster-cache.js'`. Since `autotiles-panel.js` itself stays at the mode root in this plan (it moves in sub-phase 3c along with the rest of the terrain-set editor UI), no further change is needed here — confirm the import still resolves correctly and move on.

- [ ] **Step 6: Update `contributions.js`'s panel imports**

Change:
```js
import { mountTilePanel } from './tile-panel.js';
import { mountAutotilesPanel } from './autotiles-panel.js';
import { mountTileLayersPanel } from './tile-layers-panel.js';
```
to:
```js
import { mountTilePanel } from './presentation/tile-panel.js';
import { mountAutotilesPanel } from './autotiles-panel.js';
import { mountTileLayersPanel } from './presentation/tile-layers-panel.js';
```
(`autotiles-panel.js`'s own import is unchanged here — it isn't moved until 3c.)

- [ ] **Step 7: Run the affected tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```
git add js/modes/tiles/presentation/tile-panel.js js/modes/tiles/presentation/tile-layers-panel.js js/modes/tiles/presentation/tile-tags-field.js js/modes/tiles/contributions.js js/modes/tiles/autotiles-panel.js
git rm js/modes/tiles/tile-panel.js js/modes/tiles/tile-layers-panel.js js/modes/tiles/tile-tags-field.js js/modes/tiles/tile-sheet-commands.js js/modes/tiles/tile-layer-commands.js
git commit -m "Migrate tile panels to presentation/, retiring the old command files"
```

---

## Task 5: Update architecture tests and verify

**Files:**
- Modify: `tests/architecture.test.mjs`

**Interfaces:**
- None new — this task only updates hardcoded path assertions to match Tasks 1-4's file moves, and performs final verification. `contributions.js`'s remaining wiring (`api.previews.register`, `api.tools.register`, `api.panels.register`, `api.views.register`) was already left untouched by Tasks 1-4 since none of it referenced a moved path beyond what those tasks already updated — confirm this by re-reading the file's full current contents before starting (no code change expected here beyond what Steps in Tasks 1/2/4 already made).

- [ ] **Step 1: Update `tests/architecture.test.mjs`'s hardcoded tiles paths**

In the test `'mode canvas controllers do not own contribution panels'` (~line 61-70), change:
```js
    join(root, 'js/modes/tiles/tile-editor-controller.js'),
```
to:
```js
    join(root, 'js/modes/tiles/presentation/tile-tool-presenter.js'),
```
(leave the `js/modes/sprites/presentation/frame-tool-presenter.js` and `js/modes/tiles/autotile-paint-controller.js` lines exactly as they are).

In the test `'mode pointer controllers do not import contextual panels or terrain UI'` (~line 72-78), change:
```js
  const tileController = await readFile(join(root, 'js/modes/tiles/tile-editor-controller.js'), 'utf8');
```
to:
```js
  const tileController = await readFile(join(root, 'js/modes/tiles/presentation/tile-tool-presenter.js'), 'utf8');
```
(the `assert.doesNotMatch` regex on the next line stays unchanged — `tile-panel|autotiles-panel|tile-layers-panel|terrain-set-controller|tile-tags-field` are still exactly the modules this Presenter must not import).

In the test `'mode command modules do not access browser UI globals'` (~line 80-89), change:
```js
  for (const file of [
    join(root, 'js/modes/tiles/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/tile-layer-commands.js'),
  ]) {
```
to:
```js
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
  ]) {
```
(`terrain-set-commands.js` stays at its current path — untouched until 3c).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including every updated/new assertion in `tests/architecture.test.mjs`.

- [ ] **Step 3: Non-drag browser smoke check**

Per project convention, pointer-drag interactions are verified manually only (never simulated in Playwright). Start the dev server per `serve.ps1` (capture its PID), open the app with `?autotest`, and check via Playwright:
- Switch to Tiles mode, create a tile sheet if none exists, create a standalone tile by dragging is NOT tested here — instead verify via non-drag means: select the tiles tool, click on empty canvas (no tile created by a click alone — expected, matches `handleDown`'s create-drag-only behavior), open the Tile Layers panel and click "Add layer" (uses a `prompt()` — handle via `page.on('dialog', ...)` or Playwright's dialog handler), verify the new layer name appears in the panel, delete it, verify it's removed.
- Check the browser console for errors/warnings at each step.
- Report the dev server's PID and the kill command to the user; do not leave it running.

- [ ] **Step 4: Commit**

```
git add tests/architecture.test.mjs
git commit -m "Update architecture tests for Phase 3a file moves"
```
