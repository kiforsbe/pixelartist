# Phase 3d — Tiles mode: `tileeditor.js` absorption + terrain-slot undo fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out tiles mode's DDD migration by absorbing `js/ui/tileeditor.js` into the `application/`(`commands/`+`geometry/`)+`presentation/` split already used everywhere else in tiles mode, and fix a pre-existing Phase 3a undo/redo bug along the way.

**Architecture:** Same three-way split as Phase 3a's tile tool: pure hit-testing/offset math moves to `application/geometry/tile-editor-geometry.js`, the one raw `state.commands.push` idiom becomes a resolve-by-id Command in `application/commands/tile-editor-commands.js`, and the DOM/Canvas bulk becomes `presentation/tile-editor-presenter.js`. Separately (and independently), `deleteTile`/`deleteGrid`/`resizeGridAxis` in `tile-sheet-commands.js` get a real terrain-slot-state snapshot instead of the shallow array `.slice()` they use today, which never actually protected anything `core/model.js`'s `scrubTileReferences` mutates in place.

**Tech Stack:** Vanilla JS ES modules, no build step, `node --test` for tests, Playwright MCP for the one non-drag browser smoke check at the end.

## Global Constraints

- Command Handlers: `(services, sheetId, ...)` signature, resolve-by-id via local `find*` helpers inside `apply`/`revert` closures — never capture an entity object across a `mutate()` boundary.
- Presenters dispatch Commands by id only, via a local `dispatch(id, args)` helper (`getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args)`) — never import `application/commands/` or `core/commands.js` directly. Enforced by `tests/architecture.test.mjs`.
- `application/` (both `commands/` and `geometry/`) never touches `document`/`window`/`alert`/`confirm`/`prompt`/`CanvasRenderingContext2D`/`.getContext(` — enforced by `tests/architecture.test.mjs`'s banned-globals scans.
- `dispatch()`'s second argument is always a single named-keys object (e.g. `{ sheetId, tileId, dir, slot }`), never a positional array — matches every existing call site in this codebase.
- Every new/modified command's tests include explicit **redo** coverage (undo, then redo, then assert), not just apply+undo.
- Run `npm test` (== `node --test tests/*.mjs`) after every task; all tasks must leave the full suite green before commit.

---

### Task 1: Fix the terrain-slot undo/redo bug (independent of the tileeditor.js work)

**Files:**
- Modify: `js/modes/tiles/application/commands/terrain-slot-snapshot.js`
- Modify: `js/modes/tiles/application/commands/tile-sheet-commands.js`
- Test: `tests/tile-sheet-commands.test.mjs`

**Interfaces:**
- Consumes: `captureTerrainSlotState(sheet)` / `restoreTerrainSlotState(sheet, snapshot)` (existing, from `terrain-slot-snapshot.js` — widened by this task).
- Produces: no new exports; `deleteTile`, `deleteGrid`, `resizeGridAxis` keep their existing signatures `(services, sheetId, ...)`.

- [ ] **Step 1: Widen `terrain-slot-snapshot.js` to also capture/restore `tile.neighbors`**

`core/model.js`'s `scrubTileReferences` (called by all three functions this task fixes) mutates two things in place: terrain sets' `slots` maps (already covered), and any *other* tile's manual neighbor-slot override (`tile.neighbors[dir]`) that pointed at the removed tile — reset to `{mode:'empty', tileId:null}`. That second mutation isn't covered by the existing snapshot shape, so it needs to be added.

Replace the full contents of `js/modes/tiles/application/commands/terrain-slot-snapshot.js` with:

```js
// js/modes/tiles/application/commands/terrain-slot-snapshot.js

const cloneOrUndefined = v => v === undefined ? undefined : structuredClone(v);

// Captures every side effect core/terrainsets.js's assignSlot()/applyLayoutPreset()
// and core/model.js's scrubTileReferences() can produce: assignSlot can mutate
// a DIFFERENT terrain set's slots (when the tile being assigned already
// belongs to another set) and can clear a previous slot occupant's
// terrainSetId/blobIndex on ANY tile on the sheet; scrubTileReferences (called
// when a tile is deleted) can clear a DIFFERENT tile's manual neighbor-slot
// override if it pointed at the removed tile. The snapshot covers every
// terrain set's slots and every tile's back-reference fields, not just the
// one terrain set/tile a caller is directly acting on.
export function captureTerrainSlotState(sheet) {
  return {
    terrainSets: sheet.terrainSets.map(ts => ({ id: ts.id, slots: { ...ts.slots } })),
    tiles: sheet.tiles.map(t => ({
      id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf,
      neighbors: cloneOrUndefined(t.neighbors),
    })),
  };
}

export function restoreTerrainSlotState(sheet, snapshot) {
  for (const s of snapshot.terrainSets) {
    const ts = sheet.terrainSets.find(t => t.id === s.id);
    if (ts) ts.slots = { ...s.slots };
  }
  for (const s of snapshot.tiles) {
    const t = sheet.tiles.find(x => x.id === s.id);
    if (t) Object.assign(t, {
      terrainSetId: s.terrainSetId, blobIndex: s.blobIndex, duplicateOf: s.duplicateOf,
      neighbors: cloneOrUndefined(s.neighbors),
    });
  }
}
```

(`cloneOrUndefined` is a local one-liner, not imported from `tile-sheet-commands.js`'s near-identical `cloneNb` — importing it would create a circular dependency, since Step 2 makes `tile-sheet-commands.js` import *from* this file.)

- [ ] **Step 2: Add the import to `tile-sheet-commands.js`**

Add this line to the top of `js/modes/tiles/application/commands/tile-sheet-commands.js`, after the existing `import { pruneEmptyTerrainSets, detachFromTerrainSetIfMismatched } from '../../../../core/terrainsets.js';` line:

```js
import { captureTerrainSlotState, restoreTerrainSlotState } from './terrain-slot-snapshot.js';
```

- [ ] **Step 3: Rewrite `deleteTile`**

Replace the existing `deleteTile` function (currently at approximately line 133) with:

```js
export function deleteTile(services, sheetId, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (!tile || tile.gridId != null) return;
  const wasSelected = state.selectedTileId === tileId;
  const beforeSelectedTerrainSetId = state.selectedTerrainSetId;
  const candidateTerrainSetId = tile.terrainSetId ?? null;
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  const beforeSlotState = captureTerrainSlotState(sheet);
  sheet.tiles = sheet.tiles.filter(t => t !== tile);
  scrubTileReferences(sheet, tile.id);
  const prunedIds = candidateTerrainSetId != null ? pruneEmptyTerrainSets(sheet, [candidateTerrainSetId]) : [];
  const terrainSetCleared = prunedIds.includes(state.selectedTerrainSetId);
  if (terrainSetCleared) state.selectedTerrainSetId = null;
  if (state.selectedTileId === tileId) state.selectedTileId = null;
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  const afterSlotState = captureTerrainSlotState(sheet);
  runCommand(services, sheetId, 'delete tile',
    sheet => {
      sheet.tiles = afterTiles.slice();
      sheet.terrainSets = afterSets.slice();
      restoreTerrainSlotState(sheet, afterSlotState);
      if (state.selectedTileId === tileId) state.selectedTileId = null;
      if (terrainSetCleared) state.selectedTerrainSetId = null;
    },
    sheet => {
      sheet.tiles = beforeTiles.slice();
      sheet.terrainSets = beforeSets.slice();
      restoreTerrainSlotState(sheet, beforeSlotState);
      if (wasSelected) state.selectedTileId = tileId;
      if (terrainSetCleared) state.selectedTerrainSetId = beforeSelectedTerrainSetId;
    });
  emit('selection');
}
```

(The `beforeSets`/`afterSets` array-level snapshot stays — it's what protects whole terrain-set entries being pruned/restored; `captureTerrainSlotState`/`restoreTerrainSlotState` is additive, protecting the *content* of sets that survive.)

- [ ] **Step 4: Rewrite `deleteGrid`**

Replace the existing `deleteGrid` function with:

```js
export function deleteGrid(services, sheetId, gridId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  const beforeSlotState = captureTerrainSlotState(sheet);
  const beforeSelectedTileId = state.selectedTileId;
  const beforeSelectedTerrainSetId = state.selectedTerrainSetId;
  const candidateTerrainSetIds = [...new Set(ownedTiles(sheet, grid.id).map(t => t.terrainSetId).filter(id => id != null))];
  removeTileGrid(sheet, grid.id);
  const prunedIds = pruneEmptyTerrainSets(sheet, candidateTerrainSetIds);
  const terrainSetCleared = prunedIds.includes(state.selectedTerrainSetId);
  if (terrainSetCleared) state.selectedTerrainSetId = null;
  const tileCleared = state.selectedTileId != null && !sheet.tiles.some(t => t.id === state.selectedTileId);
  if (tileCleared) state.selectedTileId = null;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  const afterSlotState = captureTerrainSlotState(sheet);
  runCommand(services, sheetId, 'delete grid',
    sheet => {
      sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); sheet.terrainSets = afterSets.slice();
      restoreTerrainSlotState(sheet, afterSlotState);
      if (terrainSetCleared) state.selectedTerrainSetId = null;
      if (tileCleared) state.selectedTileId = null;
    },
    sheet => {
      sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); sheet.terrainSets = beforeSets.slice();
      restoreTerrainSlotState(sheet, beforeSlotState);
      if (terrainSetCleared) state.selectedTerrainSetId = beforeSelectedTerrainSetId;
      if (tileCleared) state.selectedTileId = beforeSelectedTileId;
    });
  if (terrainSetCleared || tileCleared) emit('selection');
}
```

- [ ] **Step 5: Rewrite `resizeGridAxis`**

Replace the existing `resizeGridAxis` function with:

```js
export function resizeGridAxis(services, sheetId, gridId, axis, side, count) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const beforeSlotState = captureTerrainSlotState(sheet);
  const beforeSelectedTileId = state.selectedTileId;
  coreResizeGridAxis(sheet, grid, axis, side, count);
  let survivorId = null;
  if (grid.cols === 1 && grid.rows === 1) survivorId = collapseGridToTile(sheet, grid).id;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const afterSlotState = captureTerrainSlotState(sheet);
  runCommand(services, sheetId, 'resize grid',
    sheet => {
      sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice();
      restoreTerrainSlotState(sheet, afterSlotState);
      if (survivorId) state.selectedTileId = survivorId;
    },
    sheet => {
      sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice();
      restoreTerrainSlotState(sheet, beforeSlotState);
      if (survivorId) state.selectedTileId = beforeSelectedTileId;
    });
  if (survivorId) emit('selection');
}
```

(`resizeGridAxis` never mutates `sheet.terrainSets` array membership — `core/tilegrids.js`'s `resizeGridAxis` only calls `scrubTileReferences`, never `pruneEmptyTerrainSets` — so no array-level `terrainSets` snapshot is needed here, only the slot-content one.)

- [ ] **Step 6: Add 3 new tests to `tests/tile-sheet-commands.test.mjs`**

Add these three tests (they can go anywhere in the file; placing them right after the existing `deleteTile`/`deleteGrid`/`resizeGridAxis`-related tests keeps related coverage together):

```js
test('deleteTile restores a surviving terrain set\'s slots map and other tiles\' neighbor overrides on undo', () => {
  resetLegacy();
  const victim = makeTile({ id: 'victim', terrainSetId: 'ts1', blobIndex: 5 });
  const survivor = makeTile({ id: 'survivor', terrainSetId: 'ts1', blobIndex: 6 });
  const watcher = makeTile({ id: 'watcher', neighbors: { e: { mode: 'tile', tileId: 'victim', flipH: false, flipV: false } } });
  const sheet = makeSheet({
    tiles: [victim, survivor, watcher],
    terrainSets: [{ id: 'ts1', tileW: 8, tileH: 8, slots: { 5: 'victim', 6: 'survivor' }, symmetry: { flip: false, rotate: false } }],
  });
  const services = makeServices(makeProject(sheet));

  deleteTile(services, 'sheet1', 'victim');
  assert.equal(sheet.terrainSets.length, 1, 'terrain set survives -- "survivor" still occupies it');
  assert.deepEqual(sheet.terrainSets[0].slots, { 6: 'survivor' }, 'the victim\'s slot entry is scrubbed');
  assert.deepEqual(watcher.neighbors.e, { mode: 'empty', tileId: null, flipH: false, flipV: false }, 'the watching tile\'s manual neighbor override is scrubbed');

  services.history.undo();
  assert.deepEqual(sheet.terrainSets[0].slots, { 5: 'victim', 6: 'survivor' }, 'undo restores the scrubbed slot entry');
  assert.deepEqual(watcher.neighbors.e, { mode: 'tile', tileId: 'victim', flipH: false, flipV: false }, 'undo restores the scrubbed neighbor override');

  services.history.redo();
  assert.deepEqual(sheet.terrainSets[0].slots, { 6: 'survivor' }, 'redo re-applies the scrub');
});

test('deleteGrid restores a surviving terrain set\'s slots map on undo', () => {
  resetLegacy();
  const sheet = makeSheet({
    terrainSets: [{ id: 'ts1', tileW: 8, tileH: 8, slots: {}, symmetry: { flip: false, rotate: false } }],
  });
  const services = makeServices(makeProject(sheet));
  const { grid, tiles } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 1, rows: 1 });
  const gridTile = tiles[0];
  gridTile.terrainSetId = 'ts1';
  gridTile.blobIndex = 3;
  const outsider = makeTile({ id: 'outsider', terrainSetId: 'ts1', blobIndex: 4 });
  sheet.tiles.push(outsider);
  sheet.terrainSets[0].slots = { 3: gridTile.id, 4: 'outsider' };

  deleteGrid(services, 'sheet1', grid.id);
  assert.equal(sheet.terrainSets.length, 1, 'terrain set survives -- "outsider" still occupies it');
  assert.deepEqual(sheet.terrainSets[0].slots, { 4: 'outsider' });

  services.history.undo();
  assert.deepEqual(sheet.terrainSets[0].slots, { 3: gridTile.id, 4: 'outsider' }, 'undo restores the grid tile\'s scrubbed slot entry');

  services.history.redo();
  assert.deepEqual(sheet.terrainSets[0].slots, { 4: 'outsider' });
});

test('resizeGridAxis shrink restores a surviving terrain set\'s slots map on undo', () => {
  resetLegacy();
  const sheet = makeSheet({
    terrainSets: [{ id: 'ts1', tileW: 8, tileH: 8, slots: {}, symmetry: { flip: false, rotate: false } }],
  });
  const services = makeServices(makeProject(sheet));
  const { grid, tiles } = addGrid(services, 'sheet1', { x: 0, y: 0, cellW: 8, cellH: 8, cols: 3, rows: 1 });
  const kept = tiles[0];
  const dropped = tiles[2];
  kept.terrainSetId = 'ts1'; kept.blobIndex = 2;
  dropped.terrainSetId = 'ts1'; dropped.blobIndex = 1;
  sheet.terrainSets[0].slots = { 1: dropped.id, 2: kept.id };

  resizeGridAxis(services, 'sheet1', grid.id, 'cols', 'end', 2);
  assert.equal(sheet.tiles.length, 2, 'the third column tile is dropped');
  assert.deepEqual(sheet.terrainSets[0].slots, { 2: kept.id }, 'the dropped tile\'s slot entry is scrubbed');

  services.history.undo();
  assert.equal(sheet.tiles.length, 3);
  assert.deepEqual(sheet.terrainSets[0].slots, { 1: dropped.id, 2: kept.id }, 'undo restores the scrubbed slot entry');

  services.history.redo();
  assert.deepEqual(sheet.terrainSets[0].slots, { 2: kept.id });
});
```

- [ ] **Step 7: Run the affected tests**

Run: `npm test`
Expected: PASS, all tests including the 3 new ones (full suite currently at 621 tests, so expect 624).

- [ ] **Step 8: Commit**

```bash
git add js/modes/tiles/application/commands/terrain-slot-snapshot.js js/modes/tiles/application/commands/tile-sheet-commands.js tests/tile-sheet-commands.test.mjs
git commit -m "fix: restore terrain-set slots and neighbor overrides on tile/grid delete undo"
```

---

### Task 2: Add the `setTileNeighborSlot` Command Handler

**Files:**
- Create: `js/modes/tiles/application/commands/tile-editor-commands.js`
- Modify: `js/modes/tiles/contributions.js`
- Test: `tests/tile-editor-commands.test.mjs`

**Interfaces:**
- Consumes: `runCommand(services, sheetId, label, apply, revert)` (existing, exported from `tile-sheet-commands.js`); `setSlot(tile, dir, slot)` (existing, from `core/neighbors.js`).
- Produces: `setTileNeighborSlot(services, sheetId, tileId, dir, slot): void`, registered as command id `'tiles.setTileNeighborSlot'` — Task 3's presenter dispatches this by id.

- [ ] **Step 1: Write `js/modes/tiles/application/commands/tile-editor-commands.js`**

```js
// js/modes/tiles/application/commands/tile-editor-commands.js
import { setSlot } from '../../../../core/neighbors.js';
import { runCommand } from './tile-sheet-commands.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
function findTile(sheet, tileId) { return sheet.tiles.find(t => t.id === tileId) ?? null; }

export function setTileNeighborSlot(services, sheetId, tileId, dir, slot) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (!tile) return;
  const before = tile.neighbors ? structuredClone(tile.neighbors) : null;
  runCommand(services, sheetId, 'edit tile neighbor slot',
    sheet => { const t = findTile(sheet, tileId); if (t) setSlot(t, dir, slot); },
    sheet => { const t = findTile(sheet, tileId); if (t) t.neighbors = before ? structuredClone(before) : undefined; });
}
```

- [ ] **Step 2: Register the command in `contributions.js`**

In `js/modes/tiles/contributions.js`, add this import after the existing `terrain-set-commands.js` import block (after the closing `} from './application/commands/terrain-set-commands.js';` line):

```js
import { setTileNeighborSlot } from './application/commands/tile-editor-commands.js';
```

Then add this line to `registerTileCommands`, right after the existing `api.commands.register({ id: 'tiles.setTerrainSetLayer', ... });` line:

```js
  api.commands.register({ id: 'tiles.setTileNeighborSlot', when: whenTiles, execute: (_c, { sheetId, tileId, dir, slot }) => setTileNeighborSlot(services(), sheetId, tileId, dir, slot) });
```

- [ ] **Step 3: Write `tests/tile-editor-commands.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { createBitmap } from '../js/core/pixels.js';
import { setTileNeighborSlot } from '../js/modes/tiles/application/commands/tile-editor-commands.js';

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
}

test('setTileNeighborSlot assigns a "tile" mode slot, and undoes/redoes', () => {
  resetLegacy();
  const tile = makeTile({ id: 't1' });
  const other = makeTile({ id: 't2' });
  const sheet = makeSheet({ tiles: [tile, other] });
  const services = makeServices(makeProject(sheet));

  setTileNeighborSlot(services, 'sheet1', 't1', 'e', { mode: 'tile', tileId: 't2', flipH: true, flipV: false });
  assert.deepEqual(tile.neighbors.e, { mode: 'tile', tileId: 't2', flipH: true, flipV: false });

  services.history.undo();
  assert.equal(tile.neighbors, undefined);

  services.history.redo();
  assert.deepEqual(tile.neighbors.e, { mode: 'tile', tileId: 't2', flipH: true, flipV: false });
});

test('setTileNeighborSlot overwrites one slot and preserves the tile\'s other slots on undo', () => {
  resetLegacy();
  const tile = makeTile({
    id: 't1',
    neighbors: {
      e: { mode: 'same', tileId: null, flipH: false, flipV: false },
      w: { mode: 'empty', tileId: null, flipH: false, flipV: false },
    },
  });
  const sheet = makeSheet({ tiles: [tile] });
  const services = makeServices(makeProject(sheet));

  setTileNeighborSlot(services, 'sheet1', 't1', 'e', { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(tile.neighbors.e, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(tile.neighbors.w, { mode: 'empty', tileId: null, flipH: false, flipV: false });

  services.history.undo();
  assert.deepEqual(tile.neighbors.e, { mode: 'same', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(tile.neighbors.w, { mode: 'empty', tileId: null, flipH: false, flipV: false });
});

test('setTileNeighborSlot is a silent no-op when the tileId does not resolve', () => {
  resetLegacy();
  const sheet = makeSheet({ tiles: [] });
  const services = makeServices(makeProject(sheet));

  assert.doesNotThrow(() => setTileNeighborSlot(services, 'sheet1', 'missing', 'e', { mode: 'empty', tileId: null, flipH: false, flipV: false }));
  assert.equal(services.history.canUndo(), false);
});
```

- [ ] **Step 4: Run the affected tests**

Run: `npm test`
Expected: PASS (full suite grows to 627: 624 from Task 1 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add js/modes/tiles/application/commands/tile-editor-commands.js js/modes/tiles/contributions.js tests/tile-editor-commands.test.mjs
git commit -m "feat: add resolve-by-id setTileNeighborSlot command"
```

---

### Task 3: Extract `tile-editor-geometry.js` and rebuild the presenter

**Files:**
- Create: `js/modes/tiles/application/geometry/tile-editor-geometry.js`
- Create: `js/modes/tiles/presentation/tile-editor-presenter.js`
- Modify: `js/modes/tiles/contributions.js`
- Delete: `js/ui/tileeditor.js`

**Interfaces:**
- Consumes: `setTileNeighborSlot` command id `'tiles.setTileNeighborSlot'` (Task 2); `getEditorHost` from `../../../host/runtime.js` (existing, used by every other migrated tiles presenter).
- Produces: `mountTileEditor(hostEl) -> {show(), hide(), view}` — same public signature `js/ui/tileeditor.js` had; `tile-editor-geometry.js` exports `dirForCell`, `DIR_LABELS`, `computeOffset`, `mapEditorPoint`, `cellAt`, `insideCenter`.

- [ ] **Step 1: Write `js/modes/tiles/application/geometry/tile-editor-geometry.js`**

```js
// js/modes/tiles/application/geometry/tile-editor-geometry.js

// Mirrors core/neighbors.js's private DIR_BY_DELTA table (not exported
// there) -- used here only to figure out which slot a clicked cell
// belongs to.
const DIR_BY_SIGN = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};
export function dirForCell(dx, dy) {
  return DIR_BY_SIGN[`${Math.sign(dx)},${Math.sign(dy)}`];
}

export const DIR_LABELS = {
  nw: 'Northwest', n: 'North', ne: 'Northeast',
  w: 'West', e: 'East',
  sw: 'Southwest', s: 'South', se: 'Southeast',
};

// Sheet-global-to-editor-local offset: the editor's content space is a
// (2*radius+1) x (2*radius+1) grid of `tile`-sized cells, with the CENTER
// cell occupying the tile's own rect -- so the top-left of the content
// grid sits `radius` cells up/left of the tile.
export function computeOffset(tile, radius) {
  return { x: tile.x - radius * tile.w, y: tile.y - radius * tile.h };
}

export function mapEditorPoint(offsetPt, x, y) {
  return { x: x + offsetPt.x, y: y + offsetPt.y };
}

// Editor-local cell lookup: returns {dx, dy} (tile units relative to
// center, 0,0 excluded -- that's the center) or null when (x, y) falls
// outside the content grid.
export function cellAt(tile, radius, contentW, contentH, x, y) {
  if (x < 0 || y < 0 || x >= contentW || y >= contentH) return null;
  const dx = Math.floor(x / tile.w) - radius;
  const dy = Math.floor(y / tile.h) - radius;
  if (dx === 0 && dy === 0) return null;
  return { dx, dy };
}

export function insideCenter(tile, radius, x, y) {
  return x >= radius * tile.w && x < radius * tile.w + tile.w &&
    y >= radius * tile.h && y < radius * tile.h + tile.h;
}
```

- [ ] **Step 2: Write `js/modes/tiles/presentation/tile-editor-presenter.js`**

```js
// js/modes/tiles/presentation/tile-editor-presenter.js
//
// Tile editor: a focused, zoomed-in view of a single tile with a live
// neighbor preview driven by a per-tile "neighbor preset" (core/neighbors.js).
//
// Architecturally this is frameeditor.js's sibling (see sprites mode's
// frame-editor-presenter.js): a SECOND CanvasView, mounted once at boot into
// its own absolutely-positioned child of #canvas-host, shown/hidden rather
// than created/destroyed (CanvasView has no teardown and installs
// window-level key listeners).
//
// Coordinate mapping mirrors frame-editor-presenter.js's, with the editor's
// content space being a (2*radius+1) x (2*radius+1) grid of tiles (in
// tile-sized units) rather than a single frame:
//   - Content size = (2*radius+1)*tileW x (2*radius+1)*tileH. The CENTER
//     tile (the one actually being edited) occupies editor-local
//     [radius*tw, radius*tw+tw) x [radius*th, radius*th+th).
//   - mapPoint(x, y) shifts editor-local pointer coords into sheet-global
//     layer-bitmap coords via application/geometry/tile-editor-geometry.js's
//     pure offset math. getTargetRect() returns the center tile's own rect,
//     so tools.js's target clipping guarantees strokes can only ever affect
//     the center tile's pixels no matter how far a drag strays into
//     neighbor cells.
//   - view.imageToScreen is overridden the same way frame-editor-presenter.js
//     does it: tools.js's marquee selection is stored in sheet-global coords
//     (because of mapPoint), so overlays need to map sheet-global -> screen
//     by inverting the same offset used by mapPoint.
//
// Neighbor cells are NOT separately-edited bitmaps -- they are the CURRENT
// pixels of whichever tile resolveNeighborGrid() resolves each cell to,
// redrawn from a flattened-sheet scratch cache every paint (same cache
// pattern as tile-raster-cache.js), which is what makes the preview live
// while drawing.
//
// Slot clicks (configuring what a neighbor cell shows) vs. drawing strokes
// are routed by geometry alone: a pointerdown INSIDE the center rect starts
// a normal tool stroke (delegated to bindDrawing's onPointer, wrapped); a
// pointerdown OUTSIDE the center rect (anywhere else in the content) is a
// candidate slot click, resolved on pointerup only if the up event lands on
// the same sign-direction cell as the down event (i.e. no drag) -- see
// wrapped view.onPointer below.

import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { CanvasView } from '../../../ui/canvasview.js';
import { bindDrawing } from '../../../ui/tools.js';
import { flattenSheet } from '../../../core/model.js';
import { getPreset, resolveNeighborGrid } from '../../../core/neighbors.js';
import { terrainNeighborPreviewCells } from '../../../core/blob47templates.js';
import { markDefaultAction } from '../../../ui/dialogs.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import {
  dirForCell, DIR_LABELS, computeOffset, mapEditorPoint, cellAt, insideCenter,
} from '../application/geometry/tile-editor-geometry.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

export function mountTileEditor(hostEl) {
  const container = document.createElement('div');
  container.className = 'tile-editor';
  hostEl.appendChild(container);

  // ---- top strip ----
  const strip = document.createElement('div');
  strip.className = 'tile-editor-strip';
  container.appendChild(strip);

  const btnBack = document.createElement('button');
  btnBack.type = 'button'; btnBack.className = 'btn-icon-md'; btnBack.textContent = '⬅'; btnBack.title = 'Back to sheet';

  const nameLabel = document.createElement('span');
  nameLabel.className = 'tile-editor-name';

  const terrainLabel = document.createElement('span');
  terrainLabel.className = 'tile-editor-terrain-label';
  terrainLabel.hidden = true;

  const radiusLabel = document.createElement('label');
  radiusLabel.className = 'tile-editor-radius';
  const radiusSelect = document.createElement('select');
  const opt1 = document.createElement('option'); opt1.value = '0'; opt1.textContent = '1×1 (off)';
  const opt3 = document.createElement('option'); opt3.value = '1'; opt3.textContent = '3×3';
  const opt5 = document.createElement('option'); opt5.value = '2'; opt5.textContent = '5×5';
  radiusSelect.append(opt1, opt3, opt5);
  radiusLabel.append(document.createTextNode('Neighbors '), radiusSelect);

  strip.append(btnBack, nameLabel, terrainLabel, radiusLabel);

  // ---- canvas ----
  const canvasHostDiv = document.createElement('div');
  canvasHostDiv.className = 'tile-editor-canvas';
  container.appendChild(canvasHostDiv);

  const view = new CanvasView(canvasHostDiv);

  let radius = 1; // 0 = 1x1 (off), 1 = 3x3, 2 = 5x5

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
    if (!t) return { x: 0, y: 0 };
    return computeOffset(t, radius);
  }

  // See module comment: overlays (marquee selection) are stored in
  // sheet-global coordinates by tools.js because of mapPoint below, so
  // imageToScreen needs to subtract the editor's offset before zoom/pan.
  view.imageToScreen = (x, y) => {
    const off = offset();
    return { x: (x - off.x) * view.zoom + view.panX, y: (y - off.y) * view.zoom + view.panY };
  };

  function getTargetRect() {
    const r = centerRect();
    return r ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  function mapPoint(x, y) {
    return mapEditorPoint(offset(), x, y);
  }

  bindDrawing(view, getTargetRect, mapPoint, 'tile');

  // ---- flattened-sheet cache (scratch canvas), shared with
  // sprites mode's identical pattern via raster-cache.js. Invalidated on
  // 'pixels'/'project'/'history'; rebuilt lazily on next paint -- this is
  // what makes the neighbor preview live while drawing.
  const flatCache = createRasterCache();
  function invalidateFlat() { flatCache.invalidate(); }
  function getFlatCanvas(sheet) { return flatCache.getCanvas(sheet, s => flattenSheet(s, state.floating)); }

  // Draws `tile`'s current flattened pixels into the neighbor-grid cell at
  // (dx, dy) (tile units relative to center, 0,0 = center), applying flip
  // and (for terrain-set symmetry-derived slots) rotation around that
  // cell's own bounds -- same transform order as tilemode.js's
  // tileThumbnailURL, so a slot previews identically here and in the
  // Autotiles panel. tw/th are the CENTER tile's own size -- a
  // differently-sized neighbor's source rect is stretched into it (an
  // accepted, minor visual quirk for mixed-size neighbors; terrain sets are
  // the real fix, since a terrain set requires uniform tile size).
  function drawTileCell(ctx, flatCanvasEl, tile, dx, dy, flipH, flipV, tw, th, rotate = 0) {
    const destX = (dx + radius) * tw;
    const destY = (dy + radius) * th;
    ctx.save();
    ctx.translate(destX, destY);
    ctx.translate(flipH ? tw : 0, flipV ? th : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (rotate) {
      ctx.translate(tw / 2, th / 2);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(-tw / 2, -th / 2);
    }
    ctx.drawImage(flatCanvasEl, tile.x, tile.y, tile.w, tile.h, 0, 0, tw, th);
    ctx.restore();
  }

  view.onPaint = (ctx) => {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    const tw = t.w, th = t.h;
    const flat = getFlatCanvas(sheet);
    let cells;
    if (t.terrainSetId != null) {
      const ts = sheet.terrainSets.find(x => x.id === t.terrainSetId);
      cells = ts ? terrainNeighborPreviewCells(t, ts) : [];
    } else {
      cells = resolveNeighborGrid(getPreset(t), t.id, radius);
    }

    ctx.save();
    ctx.globalAlpha = 0.85;
    for (const cell of cells) {
      if (cell.tileId == null) continue;
      const nb = sheet.tiles.find(x => x.id === cell.tileId);
      if (!nb) continue;
      drawTileCell(ctx, flat, nb, cell.dx, cell.dy, cell.flipH, cell.flipV, tw, th, cell.rotate);
    }
    ctx.restore();

    // center tile, full alpha, never flipped
    drawTileCell(ctx, flat, t, 0, 0, false, false, tw, th);
  };

  view.onOverlay = (ctx) => {
    const sheet = activeSheet();
    const r = centerRect();
    if (!sheet || !r) return;
    const p0 = view.imageToScreen(r.x, r.y);
    const p1 = view.imageToScreen(r.x + r.w, r.y + r.h);
    ctx.save();
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 2;
    ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    ctx.restore();
  };

  // ---- slot config dialog ----

  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Neighbor slot: <span id="te-slot-dir"></span></h3>
    <div class="row"><label><input type="radio" name="te-mode" value="same"> Same tile (mirrors center)</label></div>
    <div class="row"><label><input type="radio" name="te-mode" value="tile"> Other tile</label></div>
    <div class="row"><label><input type="radio" name="te-mode" value="empty"> Empty</label></div>
    <div class="row"><label>Tile <select id="te-tile-select"></select></label></div>
    <div class="row"><label><input type="checkbox" id="te-fliph"> Flip H</label></div>
    <div class="row"><label><input type="checkbox" id="te-flipv"> Flip V</label></div>
    <div class="row dlg-actions"><button type="button" id="te-ok">OK</button><button type="button" id="te-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
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

  let dialogDir = null;

  function openSlotDialog(dir) {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t || t.terrainSetId != null) return;
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

  markDefaultAction(dlg, teOk);
  teCancel.addEventListener('click', () => dlg.close());
  teOk.addEventListener('click', () => {
    const t = currentTile();
    const sheet = activeSheet();
    if (!t || !sheet || !dialogDir) { dlg.close(); return; }
    const mode = teModeRadios.find(r => r.checked)?.value ?? 'same';
    const tileId = mode === 'tile' ? teTileSelect.value : null;
    const slot = { mode, tileId, flipH: teFlipH.checked, flipV: teFlipV.checked };
    dispatch('tiles.setTileNeighborSlot', { sheetId: sheet.id, tileId: t.id, dir: dialogDir, slot });
    dlg.close();
  });

  // ---- pointer routing: drawing (inside center rect) vs. slot click ----

  function cellAtPoint(x, y) {
    const t = currentTile();
    return t ? cellAt(t, radius, view.width, view.height, x, y) : null;
  }

  function insideCenterPoint(x, y) {
    const t = currentTile();
    return t ? insideCenter(t, radius, x, y) : false;
  }

  const toolPointer = view.onPointer;
  let drawingActive = false;
  let pendingClickDir = null;

  view.onPointer = (ev) => {
    if (ev.type === 'down') {
      if (insideCenterPoint(ev.x, ev.y)) {
        drawingActive = true;
        pendingClickDir = null;
        toolPointer(ev);
      } else {
        drawingActive = false;
        const cell = cellAtPoint(ev.x, ev.y);
        pendingClickDir = cell ? dirForCell(cell.dx, cell.dy) : null;
      }
      return;
    }
    if (drawingActive) {
      toolPointer(ev);
      if (ev.type === 'up') drawingActive = false;
      return;
    }
    if (ev.type === 'up' && pendingClickDir) {
      const cell = cellAtPoint(ev.x, ev.y);
      const upDir = cell ? dirForCell(cell.dx, cell.dy) : null;
      if (upDir && upDir === pendingClickDir) openSlotDialog(pendingClickDir);
      pendingClickDir = null;
    }
    // move events outside the center rect: no drag preview needed for slot clicks.
  };

  // ---- top strip wiring ----

  function updateStrip() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) { nameLabel.textContent = ''; return; }
    const idx = sheet.tiles.indexOf(t);
    nameLabel.textContent = t.name ? `Tile ${idx} (${t.name})` : `Tile ${idx}`;
    radiusSelect.value = String(radius);
    if (t.terrainSetId != null) {
      const ts = sheet.terrainSets.find(x => x.id === t.terrainSetId);
      terrainLabel.textContent = ts ? `Terrain: ${ts.name} — neighbors follow the terrain set automatically` : '';
      terrainLabel.hidden = !ts;
    } else {
      terrainLabel.hidden = true;
    }
  }

  radiusSelect.addEventListener('change', () => {
    const v = parseInt(radiusSelect.value, 10);
    radius = (v === 0 || v === 2) ? v : 1;
    loadContent();
    view.requestRender();
  });

  function backToSheet() {
    state.view = 'sheet';
    emit('view');
  }
  btnBack.addEventListener('click', backToSheet);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.view !== 'tile') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    backToSheet();
  });

  // ---- content sizing / recentering ----

  let loadedTileId = null;
  let loadedRadius = null;

  function loadContent() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    view.setContent({ width: (2 * radius + 1) * t.w, height: (2 * radius + 1) * t.h });
    view.centerFit();
    loadedTileId = t.id;
    loadedRadius = radius;
  }

  // ---- visibility ----

  let visible = false;
  let lastCssW = 0, lastCssH = 0;

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
  function hide() {
    lastCssW = view.cssWidth;
    lastCssH = view.cssHeight;
    container.style.display = 'none';
    visible = false;
  }

  on('project', () => { invalidateFlat(); if (visible) refresh(); });
  on('history', () => { invalidateFlat(); if (visible) refresh(); });
  on('pixels', () => { invalidateFlat(); if (visible) view.requestRender(); });
  on('selection', () => { if (visible) view.requestRender(); });

  return { show, hide, view };
}
```

- [ ] **Step 3: Update `contributions.js`'s import**

In `js/modes/tiles/contributions.js`, change:

```js
import { mountTileEditor } from '../../ui/tileeditor.js';
```

to:

```js
import { mountTileEditor } from './presentation/tile-editor-presenter.js';
```

- [ ] **Step 4: Delete the old file**

```bash
git rm js/ui/tileeditor.js
```

- [ ] **Step 5: Run the affected tests**

Run: `npm test`
Expected: PASS (still 627 — this task adds no new tests; it's a structural move, covered by the smoke check in Task 4).

- [ ] **Step 6: Commit**

```bash
git add js/modes/tiles/application/geometry/tile-editor-geometry.js js/modes/tiles/presentation/tile-editor-presenter.js js/modes/tiles/contributions.js
git commit -m "refactor: absorb js/ui/tileeditor.js into application/geometry + presentation"
```

---

### Task 4: Update architecture tests + docs, run full suite, smoke check

**Files:**
- Modify: `tests/architecture.test.mjs`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing new — this task only updates enforcement/docs and verifies.

- [ ] **Step 1: Add `tile-editor-commands.js` to the browser-globals scan**

In `tests/architecture.test.mjs`, the test `'mode command modules do not access browser UI globals'` has this array (around line 81-87):

```js
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-slot-snapshot.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
    join(root, 'js/modes/tiles/application/commands/autotile-paint-commands.js'),
  ]) {
```

Add `tile-editor-commands.js` to it:

```js
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-slot-snapshot.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
    join(root, 'js/modes/tiles/application/commands/autotile-paint-commands.js'),
    join(root, 'js/modes/tiles/application/commands/tile-editor-commands.js'),
  ]) {
```

- [ ] **Step 2: Update `docs/ARCHITECTURE.md`'s tiles-mode section**

Change (around line 245-249):

```markdown
**Tiles mode** (`js/modes/tiles/`) — this is the mode the autotiles panel
belongs to. It has fully migrated to the Application/Presentation split
(see the Sprites/Maps note below), except for two deliberate exceptions:
the legacy `js/ui/tileeditor.js` absorption planned for sub-phase 3d, and
`terrain-preset-art.js` (below), which by design sits outside both layers:
```

to:

```markdown
**Tiles mode** (`js/modes/tiles/`) — this is the mode the autotiles panel
belongs to. It has fully migrated to the Application/Presentation split
(see the Sprites/Maps note below), except for one deliberate exception:
`terrain-preset-art.js` (below), which by design sits outside both layers:
```

Change the views bullet (around line 258-260):

```markdown
  `#panel-tilelayers` (`presentation/tile-layers-panel.js`); two views —
  `tiles.sheet` (shared canvas) and `tiles.tile` (per-tile zoomed editor,
  `ui/tileeditor.js`).
```

to:

```markdown
  `#panel-tilelayers` (`presentation/tile-layers-panel.js`); two views —
  `tiles.sheet` (shared canvas) and `tiles.tile` (per-tile zoomed editor,
  `presentation/tile-editor-presenter.js`).
```

Update the `terrain-slot-snapshot.js` bullet (around line 307-312):

```markdown
- `application/commands/terrain-slot-snapshot.js` — `captureTerrainSlotState`/
  `restoreTerrainSlotState`, shared by `terrain-set-commands.js` and
  `autotile-paint-commands.js`'s `resolveAutotilePaintConflict`. Captures
  every terrain set's `slots` plus every tile's back-reference fields, since
  `assignSlot` can mutate a *different* terrain set's slots when the tile
  being assigned already belongs to one.
```

to:

```markdown
- `application/commands/terrain-slot-snapshot.js` — `captureTerrainSlotState`/
  `restoreTerrainSlotState`, shared by `terrain-set-commands.js`,
  `autotile-paint-commands.js`'s `resolveAutotilePaintConflict`, and (since
  3d) `tile-sheet-commands.js`'s `deleteTile`/`deleteGrid`/`resizeGridAxis`.
  Captures every terrain set's `slots` plus every tile's back-reference
  fields (`terrainSetId`/`blobIndex`/`duplicateOf`/`neighbors`) — both
  `assignSlot` and `core/model.js`'s `scrubTileReferences` can mutate a
  terrain set or tile other than the one a caller is directly acting on, so
  the snapshot always covers the whole sheet.
```

Add three new bullets at the end of the tiles-mode section, right after the `terrain-preset-art.js` bullet (around line 340, right before the `**Sprites mode**` heading):

```markdown
- `application/commands/tile-editor-commands.js` — one resolve-by-id
  Command Handler, `setTileNeighborSlot`, for the tile editor's manual
  neighbor-slot dialog. Registered by id in `contributions.js`.
- `application/geometry/tile-editor-geometry.js` — pure offset/hit-testing
  math for the tile editor's neighbor grid (`computeOffset`,
  `mapEditorPoint`, `cellAt`, `insideCenter`, `dirForCell`), no DOM or state
  access.
- `presentation/tile-editor-presenter.js` — the tile editor's Humble
  Object: a second `CanvasView` showing a zoomed, single-tile view with a
  live neighbor preview (redrawn from the same flattened-sheet cache
  pattern as `tile-raster-cache.js`) and the neighbor-slot config dialog.
  Dispatches Commands by id; never imports `application/commands/` directly
  (test-enforced).
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS, 627/627.

- [ ] **Step 4: Non-drag Playwright smoke check**

Per [[no-drag-smoke-tests]], use clicks only, no simulated pointer drags. Load the app with `?autotest` (per [[autotest-disable-dialogs]]) so `beforeunload`/`confirm` don't block. Cover:

1. Open a tile sheet with at least 2 tiles, one with a manual neighbor slot already set on another tile pointing at it (or set one via the dialog during the check).
2. Double-click a tile to open the tile editor (`tiles.tile` view). Confirm the strip shows the tile name and the neighbor preview renders.
3. Cycle the "Neighbors" `<select>` through 1×1 / 3×3 / 5×5 and confirm the content re-centers without errors (check via `browser_console_messages` for zero errors after each change).
4. Click an edge cell outside the center tile to open the neighbor-slot dialog; select "Other tile", pick a tile, click OK. Confirm the dialog closes and the neighbor preview updates.
5. Trigger undo (menu or keyboard) and confirm the slot reverts; redo and confirm it re-applies.
6. Assign a terrain set to the tile being edited (via the Autotiles panel) and confirm the neighbor-slot dialog no longer opens on click (per the `t.terrainSetId != null` guard) and the strip shows the "Terrain: ..." label instead.
7. Separately, verify the Task 1 bug fix end-to-end: in the sheet view, delete a tile that's a slot occupant in a terrain set with another surviving tile; undo; open the Autotiles panel and confirm the terrain set still shows the deleted tile's slot as occupied.
8. Click "Back to sheet" (or press Escape) to return to the sheet view.

Report any console errors/warnings encountered.

- [ ] **Step 5: Commit**

```bash
git add tests/architecture.test.mjs docs/ARCHITECTURE.md
git commit -m "docs: update architecture docs and tests for the completed tileeditor.js absorption"
```
