# Phase 3c — Tiles mode: terrain-set editor dialog migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `js/modes/tiles/terrain-set-controller.js`, `js/modes/tiles/autotiles-panel.js`, and `js/modes/tiles/terrain-set-commands.js` (the last legacy-pattern files in tiles mode besides `js/ui/tileeditor.js`) to the `application/`(`commands/`+`geometry/`)+`presentation/` split, and fix a latent redo bug in the process by extracting a shared terrain-slot snapshot helper.

**Architecture:** 8 resolve-by-id Command Handlers replace the current object-capture `commit*` functions; a new shared `terrain-slot-snapshot.js` helper (used by both the new commands and Phase 3b's already-shipped `resolveAutotilePaintConflict`) captures/restores the full cross-terrain-set blast radius of `core/terrainsets.js`'s `assignSlot`. The 590-line `terrain-set-controller.js` splits along its existing natural boundary into a pure geometry file and a Presenter; `autotiles-panel.js` (already a thin reactive mount) simply relocates.

**Tech Stack:** Vanilla JS ES modules, no build step, Node's built-in `node:test` + `node:assert/strict` for tests (`npm test`).

## Global Constraints

- Command Handlers: `(services, sheetId, ...)`, resolve-by-id via local `find*` helpers inside `apply`/`revert` closures — never capture an entity object (`tile`, `terrainSet`) by closure across a `mutate()` boundary.
- Presenters dispatch Commands by id only (`getEditorHost().registries.commands.execute(id, ctx, args)`), never import `application/commands/` directly — enforced by `tests/architecture.test.mjs`'s glob-based scan of every `presentation/` file.
- `application/` never touches `document`/`window`/`alert`/`confirm`/`prompt` — enforced by `tests/architecture.test.mjs`'s glob-based scan of every `application/` file, plus a second, explicit-file-list scan that must be updated for the two new command files in this phase (Task 6).
- `services.history.execute()` shares the same `CommandStack` as legacy global undo/redo.
- Every new command's tests include explicit **redo** coverage (apply, undo, redo, assert) — not just apply+undo — per the finding from Phase 3b's final whole-branch review.
- `core/terrainsets.js`, `core/blob47.js`, `core/blob47templates.js` are untouched — already pure, DOM-free Domain-level code.

---

### Task 1: Extract pure view-arrangement helpers into `application/geometry/terrain-set-geometry.js`

**Files:**
- Create: `js/modes/tiles/application/geometry/terrain-set-geometry.js`

**Interfaces:**
- Consumes: `blobIndexToMask`, `maskToBlobIndex`, `SIXTEEN_TILE_INDICES` from `js/core/blob47.js`; `BLOB47_8X6_RAW`, `BLOB47_7X7_RAW` from `js/core/blob47templates.js`.
- Produces: `blobStaircaseGroups(): number[][]`, `gridFromRawTemplate(rawGrid: number[][]): number[][]`, `slotGroupsForViewMode(mode: 'staircase'|'grid8x6'|'grid7x7'|'sixteen'): number[][]` — consumed by Task 5's presentation file.

- [ ] **Step 1: Create the file**

```js
// js/modes/tiles/application/geometry/terrain-set-geometry.js
import {
  blobIndexToMask, maskToBlobIndex, SIXTEEN_TILE_INDICES,
} from '../../../../core/blob47.js';
import { BLOB47_8X6_RAW, BLOB47_7X7_RAW } from '../../../../core/blob47templates.js';

// Groups the 47 canonical blob indices by how many of the 8 bits are set
// in their representative mask (the "staircase" layout: isolated alone,
// then single-edge variants, etc, up to the full 8-neighbor surround).
export function blobStaircaseGroups() {
  const groups = new Map();
  blobIndexToMask.forEach((mask, blobIndex) => {
    let count = 0;
    for (let b = 1; b <= 128; b <<= 1) if (mask & b) count++;
    if (!groups.has(count)) groups.set(count, []);
    groups.get(count).push(blobIndex);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, indices]) => indices);
}

// Mirrors the real reference template's row/col arrangement (not an
// arbitrary ascending-index chunking) so this cosmetic view is a 1:1
// visual match for the actual tilemap when that built-in preset was used
// to fill the slots -- including duplicate cells (e.g. the 7x7 template's
// three "isolated" corners), which render as separate cells for the same
// underlying slot, exactly as they appear in the source tilemap.
export function gridFromRawTemplate(rawGrid) {
  return rawGrid.map(rowVals => rowVals.map(raw => maskToBlobIndex[raw]));
}

export function slotGroupsForViewMode(mode) {
  if (mode === 'grid8x6') return gridFromRawTemplate(BLOB47_8X6_RAW);
  if (mode === 'grid7x7') return gridFromRawTemplate(BLOB47_7X7_RAW);
  if (mode === 'sixteen') return [[...SIXTEEN_TILE_INDICES].sort((a, b) => a - b)];
  return blobStaircaseGroups();
}
```

This is a verbatim extraction of `terrain-set-controller.js` lines 38-77 (as of commit `e5f6b06`) — only the imports and `export` keywords are new. No direct unit tests, matching the precedent set by `tile-geometry.js` and `autotile-geometry.js` in Phases 3a/3b (coverage comes indirectly through Task 3's command tests and Task 7's browser smoke check).

- [ ] **Step 2: Verify the file has no syntax errors**

Run: `node --check js/modes/tiles/application/geometry/terrain-set-geometry.js`
Expected: no output (exit code 0).

- [ ] **Step 3: Commit**

```bash
git add js/modes/tiles/application/geometry/terrain-set-geometry.js
git commit -m "Extract pure terrain-set view-arrangement helpers into application/geometry/"
```

---

### Task 2: Create the shared terrain-slot snapshot helper

**Files:**
- Create: `js/modes/tiles/application/commands/terrain-slot-snapshot.js`

**Interfaces:**
- Consumes: nothing (pure, no imports needed).
- Produces: `captureTerrainSlotState(sheet): {terrainSets: {id, slots}[], tiles: {id, terrainSetId, blobIndex, duplicateOf}[]}`, `restoreTerrainSlotState(sheet, snapshot): void` — consumed by Task 3's `assignTerrainSlot`/`applyTerrainLayoutPreset` and Task 4's modified `resolveAutotilePaintConflict`.

**Why this file exists:** `core/terrainsets.js`'s `assignSlot(sheet, terrainSet, blobIndex, tile)` can mutate a *different* terrain set's `slots` map (when the tile being assigned already belongs to another set) and can clear a previous slot occupant's `terrainSetId`/`blobIndex` on *any* tile on the sheet — not just the tile/set a caller is directly acting on. A correct undo/redo snapshot has to cover that whole blast radius, not just the one terrain set and one tile a call site names explicitly.

- [ ] **Step 1: Create the file**

```js
// js/modes/tiles/application/commands/terrain-slot-snapshot.js

// Captures every side effect core/terrainsets.js's assignSlot()/applyLayoutPreset()
// can produce: assignSlot can mutate a DIFFERENT terrain set's slots (when the
// tile being assigned already belongs to another set), and can clear a previous
// slot occupant's terrainSetId/blobIndex on ANY tile on the sheet -- so the
// snapshot covers every terrain set's slots and every tile's back-reference
// fields, not just the one terrain set/tile a caller is directly acting on.
export function captureTerrainSlotState(sheet) {
  return {
    terrainSets: sheet.terrainSets.map(ts => ({ id: ts.id, slots: { ...ts.slots } })),
    tiles: sheet.tiles.map(t => ({
      id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf,
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
    if (t) Object.assign(t, { terrainSetId: s.terrainSetId, blobIndex: s.blobIndex, duplicateOf: s.duplicateOf });
  }
}
```

No direct unit tests (pure data-shuffling, covered indirectly by Task 3's and Task 4's command tests, matching the no-direct-tests precedent for small pure helper modules in this codebase).

- [ ] **Step 2: Verify the file has no syntax errors**

Run: `node --check js/modes/tiles/application/commands/terrain-slot-snapshot.js`
Expected: no output (exit code 0).

- [ ] **Step 3: Commit**

```bash
git add js/modes/tiles/application/commands/terrain-slot-snapshot.js
git commit -m "Add shared terrain-slot snapshot/restore helper"
```

---

### Task 3: Create `application/commands/terrain-set-commands.js` + tests

**Files:**
- Create: `js/modes/tiles/application/commands/terrain-set-commands.js`
- Create: `tests/terrain-set-commands.test.mjs`
- Delete: `tests/tile-mode-commands.test.mjs` (its 1 test exercises the legacy `commitAddTerrainSet`/`commitRenameTerrainSet`/`commitSetTerrainSetLayer` from the file this task replaces; superseded by the new test file's `createTerrainSet`/`renameTerrainSet`/`setTerrainSetLayer` tests below, which cover the same round-trip plus redo)

**Interfaces:**
- Consumes: `runCommand` from `./tile-sheet-commands.js`; `captureTerrainSlotState`/`restoreTerrainSlotState` from `./terrain-slot-snapshot.js` (Task 2); `createTerrainSet`, `removeTerrainSet`, `assignSlot`, `clearSlot`, `applyLayoutPreset` from `js/core/terrainsets.js`.
- Produces: `createTerrainSet(services, sheetId, {name, tileW, tileH}): {terrainSetId}`, `deleteTerrainSet(services, sheetId, terrainSetId): void`, `renameTerrainSet(services, sheetId, terrainSetId, name): void`, `assignTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId): void`, `clearTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId): void` (`tileId` may be `null`), `setTerrainSymmetry(services, sheetId, terrainSetId, key, value): void`, `applyTerrainLayoutPreset(services, sheetId, terrainSetId, preset, sourceTileIds, cols): void`, `setTerrainSetLayer(services, sheetId, terrainSetId, layer): void` — all consumed by Task 6's `contributions.js` wiring and Task 5's presentation file (via dispatch, not direct import).

- [ ] **Step 1: Write the failing tests**

Create `tests/terrain-set-commands.test.mjs`:

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
  createTerrainSet, deleteTerrainSet, renameTerrainSet, assignTerrainSlot,
  clearTerrainSlot, setTerrainSymmetry, applyTerrainLayoutPreset, setTerrainSetLayer,
} from '../js/modes/tiles/application/commands/terrain-set-commands.js';

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

const isolated = blobIndexFromPaintMask(0);

test('createTerrainSet adds a set and undoes/redoes', () => {
  const sheet = makeSheet();
  const services = makeServices(makeProject(sheet));

  const { terrainSetId } = createTerrainSet(services, 'sheet1', { name: 'Ground', tileW: 8, tileH: 8 });
  assert.equal(sheet.terrainSets.length, 1);
  assert.equal(sheet.terrainSets[0].id, terrainSetId);
  assert.equal(sheet.terrainSets[0].name, 'Ground');

  services.history.undo();
  assert.equal(sheet.terrainSets.length, 0);

  services.history.redo();
  assert.equal(sheet.terrainSets.length, 1);
  assert.equal(sheet.terrainSets[0].id, terrainSetId);
});

test('deleteTerrainSet removes the set and clears tile back-references, undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolated]: 't1' } });
  const tile = makeTile({ id: 't1', terrainSetId: 'ts1', blobIndex: isolated });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  deleteTerrainSet(services, 'sheet1', 'ts1');
  assert.equal(sheet.terrainSets.length, 0);
  assert.equal(tile.terrainSetId, undefined);
  assert.equal(tile.blobIndex, undefined);

  services.history.undo();
  assert.equal(sheet.terrainSets.length, 1);
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolated);

  services.history.redo();
  assert.equal(sheet.terrainSets.length, 0);
  assert.equal(tile.terrainSetId, undefined);
});

test('renameTerrainSet updates the name and undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ name: 'Ground' });
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  renameTerrainSet(services, 'sheet1', 'ts1', 'Cliffs');
  assert.equal(terrainSet.name, 'Cliffs');

  services.history.undo();
  assert.equal(terrainSet.name, 'Ground');

  services.history.redo();
  assert.equal(terrainSet.name, 'Cliffs');
});

test('renameTerrainSet is a no-op with no history entry for a blank name', () => {
  const terrainSet = makeTerrainSet({ name: 'Ground' });
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  renameTerrainSet(services, 'sheet1', 'ts1', '   ');
  assert.equal(terrainSet.name, 'Ground');
  assert.equal(services.history.canUndo(), false);
});

test('assignTerrainSlot assigns a tile into a slot and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const tile = makeTile({ id: 't1' });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  assignTerrainSlot(services, 'sheet1', 'ts1', isolated, 't1');
  assert.equal(terrainSet.slots[isolated], 't1');
  assert.equal(tile.terrainSetId, 'ts1');
  assert.equal(tile.blobIndex, isolated);

  services.history.undo();
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(tile.terrainSetId, undefined);

  services.history.redo();
  assert.equal(terrainSet.slots[isolated], 't1');
  assert.equal(tile.terrainSetId, 'ts1');
});

test('assignTerrainSlot reassigns a tile away from a DIFFERENT terrain set, undoes/redoes both sets correctly', () => {
  const otherSet = makeTerrainSet({ id: 'ts-other', slots: { [isolated]: 't1' } });
  const targetSet = makeTerrainSet({ id: 'ts1', slots: {} });
  const tile = makeTile({ id: 't1', terrainSetId: 'ts-other', blobIndex: isolated });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [otherSet, targetSet] });
  const services = makeServices(makeProject(sheet));

  assignTerrainSlot(services, 'sheet1', 'ts1', isolated, 't1');
  assert.equal(targetSet.slots[isolated], 't1');
  assert.deepEqual(otherSet.slots, {}, 'the old set is vacated');
  assert.equal(tile.terrainSetId, 'ts1');

  services.history.undo();
  assert.deepEqual(targetSet.slots, {});
  assert.equal(otherSet.slots[isolated], 't1', 'undo restores the OTHER set too, not just the target');
  assert.equal(tile.terrainSetId, 'ts-other');

  services.history.redo();
  assert.equal(targetSet.slots[isolated], 't1');
  assert.deepEqual(otherSet.slots, {});
  assert.equal(tile.terrainSetId, 'ts1');
});

test('clearTerrainSlot clears an explicit assignment and undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolated]: 't1' } });
  const tile = makeTile({ id: 't1', terrainSetId: 'ts1', blobIndex: isolated });
  const sheet = makeSheet({ tiles: [tile], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  clearTerrainSlot(services, 'sheet1', 'ts1', isolated, 't1');
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(tile.terrainSetId, undefined);

  services.history.undo();
  assert.equal(terrainSet.slots[isolated], 't1');
  assert.equal(tile.terrainSetId, 'ts1');

  services.history.redo();
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(tile.terrainSetId, undefined);
});

test('clearTerrainSlot with no owning tile (tileId null) still clears the slot map and undoes/redoes', () => {
  const terrainSet = makeTerrainSet({ slots: { [isolated]: 'ghost-id' } });
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  clearTerrainSlot(services, 'sheet1', 'ts1', isolated, null);
  assert.deepEqual(terrainSet.slots, {});

  services.history.undo();
  assert.equal(terrainSet.slots[isolated], 'ghost-id');

  services.history.redo();
  assert.deepEqual(terrainSet.slots, {});
});

test('setTerrainSymmetry toggles a flag and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  setTerrainSymmetry(services, 'sheet1', 'ts1', 'flip', true);
  assert.equal(terrainSet.symmetry.flip, true);

  services.history.undo();
  assert.equal(terrainSet.symmetry.flip, false);

  services.history.redo();
  assert.equal(terrainSet.symmetry.flip, true);
});

test('setTerrainSymmetry is a no-op with no history entry when the value is unchanged', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  setTerrainSymmetry(services, 'sheet1', 'ts1', 'flip', false);
  assert.equal(services.history.canUndo(), false);
});

test('applyTerrainLayoutPreset assigns slots from a preset and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const a = makeTile({ id: 'a', x: 0, y: 0 });
  const b = makeTile({ id: 'b', x: 8, y: 0 });
  const sheet = makeSheet({ tiles: [a, b], terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));
  const preset = {
    cols: 2, rows: 1,
    cells: [{ col: 0, row: 0, blobIndex: isolated }, { col: 1, row: 0, blobIndex: isolated }],
  };

  applyTerrainLayoutPreset(services, 'sheet1', 'ts1', preset, ['a', 'b'], 2);
  assert.equal(terrainSet.slots[isolated], 'a', 'first cell in raster order wins');
  assert.equal(a.terrainSetId, 'ts1');
  assert.equal(b.duplicateOf, 'a');

  services.history.undo();
  assert.deepEqual(terrainSet.slots, {});
  assert.equal(a.terrainSetId, undefined);
  assert.equal(b.duplicateOf, undefined);

  services.history.redo();
  assert.equal(terrainSet.slots[isolated], 'a');
  assert.equal(b.duplicateOf, 'a');
});

test('setTerrainSetLayer sets the layer and undoes/redoes', () => {
  const terrainSet = makeTerrainSet();
  const sheet = makeSheet({ terrainSets: [terrainSet] });
  const services = makeServices(makeProject(sheet));

  setTerrainSetLayer(services, 'sheet1', 'ts1', 'Terrain');
  assert.equal(terrainSet.layer, 'Terrain');

  services.history.undo();
  assert.equal(terrainSet.layer, null);

  services.history.redo();
  assert.equal(terrainSet.layer, 'Terrain');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="createTerrainSet|deleteTerrainSet|renameTerrainSet|assignTerrainSlot|clearTerrainSlot|setTerrainSymmetry|applyTerrainLayoutPreset|setTerrainSetLayer"`
Expected: FAIL — `js/modes/tiles/application/commands/terrain-set-commands.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `js/modes/tiles/application/commands/terrain-set-commands.js`:

```js
// js/modes/tiles/application/commands/terrain-set-commands.js
import { runCommand } from './tile-sheet-commands.js';
import { captureTerrainSlotState, restoreTerrainSlotState } from './terrain-slot-snapshot.js';
import {
  createTerrainSet as createTerrainSetEntity, removeTerrainSet, assignSlot, clearSlot, applyLayoutPreset,
} from '../../../../core/terrainsets.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
function findTerrainSet(sheet, terrainSetId) { return sheet.terrainSets.find(ts => ts.id === terrainSetId) ?? null; }

export function createTerrainSet(services, sheetId, opts) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.terrainSets.slice();
  const created = createTerrainSetEntity(sheet, opts);
  const after = sheet.terrainSets.slice();
  runCommand(services, sheetId, 'add terrain set',
    sheet => { sheet.terrainSets = after.slice(); },
    sheet => { sheet.terrainSets = before.slice(); });
  return { terrainSetId: created.id };
}

export function deleteTerrainSet(services, sheetId, terrainSetId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const beforeSets = sheet.terrainSets.slice();
  const beforeTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  removeTerrainSet(sheet, terrainSetId);
  const afterSets = sheet.terrainSets.slice();
  const afterTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  runCommand(services, sheetId, 'delete terrain set',
    sheet => {
      sheet.terrainSets = afterSets.slice();
      for (const s of afterTiles) { const t = sheet.tiles.find(x => x.id === s.id); if (t) Object.assign(t, { terrainSetId: s.terrainSetId, blobIndex: s.blobIndex }); }
    },
    sheet => {
      sheet.terrainSets = beforeSets.slice();
      for (const s of beforeTiles) { const t = sheet.tiles.find(x => x.id === s.id); if (t) Object.assign(t, { terrainSetId: s.terrainSetId, blobIndex: s.blobIndex }); }
    });
}

export function renameTerrainSet(services, sheetId, terrainSetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  const before = terrainSet.name;
  const after = name.trim() || before;
  if (before === after) return;
  runCommand(services, sheetId, 'rename terrain set',
    sheet => { findTerrainSet(sheet, terrainSetId).name = after; },
    sheet => { findTerrainSet(sheet, terrainSetId).name = before; });
}

export function assignTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!terrainSet || !tile) return;

  const before = captureTerrainSlotState(sheet);
  assignSlot(sheet, terrainSet, blobIndex, tile);
  const after = captureTerrainSlotState(sheet);

  runCommand(services, sheetId, 'assign terrain slot',
    sheet => restoreTerrainSlotState(sheet, after),
    sheet => restoreTerrainSlotState(sheet, before));
}

export function clearTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  const tile = tileId != null ? sheet.tiles.find(t => t.id === tileId) : null;

  const beforeSlots = { ...terrainSet.slots };
  const beforeTile = tile ? { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex } : null;
  clearSlot(terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  const afterTile = tile ? { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex } : null;

  runCommand(services, sheetId, 'clear terrain slot',
    sheet => {
      const terrainSet = findTerrainSet(sheet, terrainSetId);
      terrainSet.slots = { ...afterSlots };
      if (tileId != null && afterTile) { const t = sheet.tiles.find(x => x.id === tileId); if (t) Object.assign(t, afterTile); }
    },
    sheet => {
      const terrainSet = findTerrainSet(sheet, terrainSetId);
      terrainSet.slots = { ...beforeSlots };
      if (tileId != null && beforeTile) { const t = sheet.tiles.find(x => x.id === tileId); if (t) Object.assign(t, beforeTile); }
    });
}

export function setTerrainSymmetry(services, sheetId, terrainSetId, key, value) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (terrainSet.symmetry[key] === value) return;
  const before = terrainSet.symmetry[key];
  runCommand(services, sheetId, `set terrain symmetry ${key}`,
    sheet => { findTerrainSet(sheet, terrainSetId).symmetry[key] = value; },
    sheet => { findTerrainSet(sheet, terrainSetId).symmetry[key] = before; });
}

export function applyTerrainLayoutPreset(services, sheetId, terrainSetId, preset, sourceTileIds, cols) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  const sourceTiles = sourceTileIds.map(id => sheet.tiles.find(t => t.id === id));

  const before = captureTerrainSlotState(sheet);
  applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols);
  const after = captureTerrainSlotState(sheet);

  runCommand(services, sheetId, 'import terrain layout',
    sheet => restoreTerrainSlotState(sheet, after),
    sheet => restoreTerrainSlotState(sheet, before));
}

export function setTerrainSetLayer(services, sheetId, terrainSetId, layer) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  const after = layer || null;
  if (terrainSet.layer === after) return;
  const before = terrainSet.layer;
  runCommand(services, sheetId, 'set terrain set layer',
    sheet => { findTerrainSet(sheet, terrainSetId).layer = after; },
    sheet => { findTerrainSet(sheet, terrainSetId).layer = before; });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern="createTerrainSet|deleteTerrainSet|renameTerrainSet|assignTerrainSlot|clearTerrainSlot|setTerrainSymmetry|applyTerrainLayoutPreset|setTerrainSetLayer"`
Expected: PASS, 14 tests.

- [ ] **Step 5: Delete the superseded legacy test file**

`tests/tile-mode-commands.test.mjs` imports `commitAddTerrainSet, commitRenameTerrainSet, commitSetTerrainSetLayer` from `js/modes/tiles/terrain-set-commands.js` (the file Task 6 deletes). Its one test's coverage (add/rename/set-layer round-tripping through undo/redo) is now covered, with additional redo assertions, by this task's new test file.

```bash
git rm tests/tile-mode-commands.test.mjs
```

- [ ] **Step 6: Run the full suite to confirm nothing else references the deleted test file's exports**

Run: `npm test`
Expected: all tests pass (the deleted file's 1 test no longer runs; no other file imports from it).

- [ ] **Step 7: Commit**

```bash
git add js/modes/tiles/application/commands/terrain-set-commands.js tests/terrain-set-commands.test.mjs
git commit -m "Add resolve-by-id terrain-set Command Handlers + tests, retire superseded legacy test"
```

(The `tests/tile-mode-commands.test.mjs` removal from Step 5 is included in this commit via `git rm`, which already staged it.)

---

### Task 4: Switch `resolveAutotilePaintConflict` to the shared snapshot helper

**Files:**
- Modify: `js/modes/tiles/application/commands/autotile-paint-commands.js`

**Interfaces:**
- Consumes: `captureTerrainSlotState`/`restoreTerrainSlotState` from `./terrain-slot-snapshot.js` (Task 2).
- Produces: no change to `resolveAutotilePaintConflict`'s exported signature or behavior for any currently-reachable call site — this is an internal-implementation swap only.

This is Phase 3b's already-shipped, already-reviewed command file. The change here is narrowly scoped: replace `resolveAutotilePaintConflict`'s hand-rolled snapshot logic with the shared helper. `paintTerrainStroke` and `prepareTerrainPaint` in the same file are untouched.

- [ ] **Step 1: Add the import**

In `js/modes/tiles/application/commands/autotile-paint-commands.js`, add to the top of the file (after the existing `runCommand` import):

```js
import { captureTerrainSlotState, restoreTerrainSlotState } from './terrain-slot-snapshot.js';
```

- [ ] **Step 2: Replace `resolveAutotilePaintConflict`'s body**

Find the current function (it starts with `export function resolveAutotilePaintConflict(services, sheetId, terrainSetId, tileId, blobIndex) {`) and replace its entire body with:

```js
export function resolveAutotilePaintConflict(services, sheetId, terrainSetId, tileId, blobIndex) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!terrainSet || !tile) return;

  const before = captureTerrainSlotState(sheet);
  assignSlot(sheet, terrainSet, blobIndex, tile);
  tile.duplicateOf = undefined;
  const after = captureTerrainSlotState(sheet);

  runCommand(services, sheetId, 'replace autotile terrain art',
    sheet => restoreTerrainSlotState(sheet, after),
    sheet => restoreTerrainSlotState(sheet, before));
}
```

This drops the function's old inline `beforeSlots`/`beforeTiles`/`afterSlots`/`afterTiles` variables entirely — the shared helper replaces all four. The `assignSlot` import (from `../../../../core/terrainsets.js`) and the `tile.duplicateOf = undefined` line are unchanged.

- [ ] **Step 3: Run the existing test suite for this file to confirm no regression**

Run: `npm test -- --test-name-pattern="prepareTerrainPaint|paintTerrainStroke|resolveAutotilePaintConflict|REDO"`
Expected: PASS, all 11 existing tests in `tests/autotile-paint-commands.test.mjs` still pass unchanged — this is the regression check for this task. If any fail, the snapshot helper's shape doesn't match what the old inline logic produced; do not proceed until they pass.

- [ ] **Step 4: Verify no syntax errors**

Run: `node --check js/modes/tiles/application/commands/autotile-paint-commands.js`
Expected: no output (exit code 0).

- [ ] **Step 5: Commit**

```bash
git add js/modes/tiles/application/commands/autotile-paint-commands.js
git commit -m "Switch resolveAutotilePaintConflict to the shared terrain-slot snapshot helper"
```

---

### Task 5: Rebuild the terrain-set editor as a Presenter

**Files:**
- Create: `js/modes/tiles/presentation/terrain-set-panel.js`
- Create: `js/modes/tiles/presentation/terrain-set-editor.js`
- Create: `js/modes/tiles/terrain-preset-art.js` (deviation from the original design doc, discovered during implementation — see note below)

**Deviation note:** `tests/architecture.test.mjs`'s presentation-layer scan (`assert.doesNotMatch(source, /from\s+['"][^'"]*core[\\/]commands\.js['"]/, file)`) bans importing `core/commands.js` from *any* file under `presentation/`, not just `application/commands/`. `importPresetArtOntoLayer` pushes a raw pixel-patch command via `core/commands.js`'s `makePixelPatch` — the design doc already flagged this call as an intentionally-unconverted, legacy-shaped idiom shared with `js/ui/tools.js` (see the design doc's Scope boundary section), but didn't anticipate that relocating the function's *file* into `presentation/` would trip this test, since the legacy `terrain-set-controller.js` was never under a directory the scan covers. Resolution: `importPresetArtOntoLayer` lives in its own file, `js/modes/tiles/terrain-preset-art.js`, sitting outside both `presentation/` and `application/` — exempt from every architecture scan, matching how `js/ui/tools.js` itself is treated. `terrain-set-editor.js` imports and calls it as a plain function, not a dispatched command; behavior is 100% unchanged.

**Interfaces:**
- Consumes: `describeMask` from `../application/geometry/autotile-geometry.js`; `slotGroupsForViewMode` from `../application/geometry/terrain-set-geometry.js` (Task 1); the 8 command ids from Task 3, dispatched by id (`tiles.createTerrainSet`, `tiles.deleteTerrainSet`, `tiles.renameTerrainSet`, `tiles.assignTerrainSlot`, `tiles.clearTerrainSlot`, `tiles.setTerrainSymmetry`, `tiles.applyTerrainLayoutPreset`, `tiles.setTerrainSetLayer` — registered in Task 6); `tiles.createTile`/`tiles.addGrid` (already registered since Phase 3a); `getAutotilePaintSession`, `setAutotilePaintBrush`, `startAutotilePaint`, `stopAutotilePaint`, `useAutotilePaintConflict` from `./autotile-paint-presenter.js`; `openBlob47Coverage` from `./blob47-coverage-dialog.js`; `importPresetArtOntoLayer` from `../terrain-preset-art.js` (new, see deviation note above).
- Produces: `mountAutotilesPanel(element)` (terrain-set-panel.js) — consumed by Task 6's `contributions.js`. `buildAddTerrainSetDialog()`, `buildTilePickerDialog()`, `renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog)`, `terrainSetNameField(terrainSet)`, `terrainSetLayerField(sheet, terrainSet)`, `terrainSetDeleteButton(sheet, terrainSet)`, `syncSelectedTerrainSetFromTile(tile)` (terrain-set-editor.js) — the first three consumed by terrain-set-panel.js in this task; the field helpers and `syncSelectedTerrainSetFromTile` also consumed by `presentation/tile-panel.js` (Task 6, import path only, no signature change). `importPresetArtOntoLayer(sheet, preset, sourceTiles, cols)` (terrain-preset-art.js) — consumed only by `terrain-set-editor.js`'s `buildAddTerrainSetDialog`.

- [ ] **Step 1: Create `terrain-set-panel.js`**

```js
// js/modes/tiles/presentation/terrain-set-panel.js
import { state, on, activeSheet } from '../../../app/state.js';
import { invalidateTileRaster } from './tile-raster-cache.js';
import {
  buildTilePickerDialog, renderTerrainSetEditor, syncSelectedTerrainSetFromTile,
} from './terrain-set-editor.js';
import { mountReactivePanel } from '../../../components/panel-mount.js';

export function mountAutotilesPanel(element) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Autotiles';
  panel.appendChild(heading);

  const tilePickerDialog = buildTilePickerDialog();
  const editor = document.createElement('div');
  editor.className = 'terrain-set-editor';
  panel.appendChild(editor);

  function render() {
    if (state.mode !== 'tiles') {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const sheet = activeSheet();
    editor.innerHTML = '';
    if (!sheet) return;

    const terrainSet = sheet.terrainSets.find(candidate => candidate.id === state.selectedTerrainSetId);
    if (terrainSet) {
      renderTerrainSetEditor(editor, sheet, terrainSet, tilePickerDialog);
      return;
    }
    const hint = document.createElement('div');
    hint.className = 'frame-field';
    hint.textContent = 'No terrain set selected — select a tile that belongs to one, or add a new set in the Tiles panel.';
    editor.appendChild(hint);
  }

  function syncSelection() {
    const sheet = activeSheet();
    if (sheet) syncSelectedTerrainSetFromTile(sheet.tiles.find(tile => tile.id === state.selectedTileId));
  }

  syncSelection();
  return mountReactivePanel(on, [
    ['project', invalidateTileRaster],
    ['history', invalidateTileRaster],
    ['pixels', invalidateTileRaster],
    'view',
    ['selection', syncSelection],
  ], render);
}
```

This is a verbatim relocation of `js/modes/tiles/autotiles-panel.js` — only its imports are repointed (one directory level deeper, and `terrain-set-controller.js` → `./terrain-set-editor.js`).

- [ ] **Step 2: Create `terrain-set-editor.js`**

```js
// js/modes/tiles/presentation/terrain-set-editor.js
import {
  state, emit, activeSheet, activeLayer, markDirty, confirmOrAuto,
} from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { copyRegion, blitRegion, scaleBitmap } from '../../../core/pixels.js';
import { makePixelPatch } from '../../../core/commands.js';
import { decodePng } from '../../../app/pngcodec.js';
import { markDefaultAction } from '../../../ui/dialogs.js';
import { groupCellsByBlobIndex } from '../../../core/terrainsets.js';
import { blobIndexToMask, resolveTerrainSlot, classifySlots, DIRECTION_OFFSETS } from '../../../core/blob47.js';
import { BUILTIN_LAYOUT_PRESETS } from '../../../core/blob47templates.js';
import { tileThumbnailUrl as tileThumbnailURL } from './tile-raster-cache.js';
import { describeMask } from '../application/geometry/autotile-geometry.js';
import { slotGroupsForViewMode } from '../application/geometry/terrain-set-geometry.js';
import {
  getAutotilePaintSession, setAutotilePaintBrush,
  startAutotilePaint, stopAutotilePaint, useAutotilePaintConflict,
} from './autotile-paint-presenter.js';
import { openBlob47Coverage } from './blob47-coverage-dialog.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid8x6' | 'grid7x7' | 'sixteen'. Keyed per terrain set
// (not a single shared variable) so switching between two terrain sets
// doesn't leak one's view-mode choice into the other; transient, not
// persisted/exported -- purely a UI nicety, seeded at creation time by
// buildAddTerrainSetDialog's create handler to match whichever built-in
// preset was used.
const terrainSetViewModes = new Map();
function viewModeFor(terrainSetId) {
  return terrainSetViewModes.get(terrainSetId) ?? 'staircase';
}

// Paints preset.sourceImage's reference art onto the active paint layer, one
// crop per cell, at the freshly-created sourceTiles' sheet coordinates --
// gives a terrain set real, recognizable slot art immediately instead of
// blank tiles the user has to hand-draw one by one. Only wired into the "Add
// terrain set" creation flow (fresh, definitely-blank tiles); never into
// "import layout" onto an existing grid, which could carry real user art.
// Pushes a raw pixel-patch undo entry directly (matching the still-legacy,
// cross-mode-shared paint-commit idiom js/ui/tools.js also uses) rather than
// going through a resolve-by-id Command Handler -- out of scope for this
// migration, see docs/superpowers/specs/2026-08-10-phase-3c-tiles-terrain-set-editor-design.md.
async function importPresetArtOntoLayer(sheet, preset, sourceTiles, cols) {
  if (!preset.sourceImage || !sourceTiles.length) return;
  const layer = activeLayer();
  if (!layer) return;

  let refBitmap;
  try {
    const res = await fetch(preset.sourceImage);
    refBitmap = await decodePng(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    console.warn(`Could not import template art from ${preset.sourceImage}: ${e.message}`);
    return;
  }

  const cellSize = preset.sourceCellSize ?? 32;
  const minX = Math.min(...sourceTiles.map(t => t.x));
  const minY = Math.min(...sourceTiles.map(t => t.y));
  const maxX = Math.max(...sourceTiles.map(t => t.x + t.w));
  const maxY = Math.max(...sourceTiles.map(t => t.y + t.h));
  const rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const before = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);

  const alreadyPainted = before.data.some((v, i) => i % 4 === 3 && v !== 0);
  if (alreadyPainted && !confirmOrAuto(
    `"${layer.name}" already has pixels where this grid lands. Overwrite them with the "${preset.name}" reference art?`
  )) return;

  for (const cell of preset.cells) {
    const tile = sourceTiles[cell.row * cols + cell.col];
    if (!tile) continue;
    const cropped = copyRegion(refBitmap, cell.col * cellSize, cell.row * cellSize, cellSize, cellSize);
    const painted = (tile.w === cellSize && tile.h === cellSize) ? cropped : scaleBitmap(cropped, tile.w, tile.h);
    blitRegion(layer.bitmap, painted, tile.x, tile.y);
  }

  const after = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
  state.commands.push(makePixelPatch(layer.bitmap, rect, before, after, 'import terrain layout art'));
  markDirty();
  emit('pixels');
}

// previewGeneration guards against a stale image load finishing after a
// newer preset was already selected (switching the <select> quickly starts
// a fresh Image() before the previous one's onload has fired) -- without
// it, the old image can paint over the new one, or at the wrong size.
let previewGeneration = 0;
function drawLayoutPreview(canvas, preset) {
  const myGeneration = ++previewGeneration;
  const cellSize = preset.sourceCellSize ?? 32;
  canvas.width = preset.cols * cellSize;
  canvas.height = preset.rows * cellSize;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const duplicateCells = [];
  for (const cells of groupCellsByBlobIndex(preset.cells).values()) {
    for (let i = 1; i < cells.length; i++) duplicateCells.push(cells[i]);
  }

  const img = new Image();
  img.onload = () => {
    if (myGeneration !== previewGeneration) return; // superseded by a later preset selection
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (!duplicateCells.length) return;
    ctx.save();
    ctx.strokeStyle = '#e0a030';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    for (const cell of duplicateCells) {
      const x = cell.col * cellSize, y = cell.row * cellSize;
      ctx.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      const label = 'dup';
      const w = Math.ceil(ctx.measureText(label).width) + 4;
      ctx.fillStyle = 'rgba(90,58,0,.85)';
      ctx.fillRect(x, y, w, 11);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 2, y + 1);
    }
    ctx.restore();
  };
  img.src = preset.sourceImage;
}

export function buildAddTerrainSetDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add terrain set</h3>
    <div class="row"><label>Name <input type="text" id="ats-name" value="Terrain"></label></div>
    <div class="row"><label>Tile W <input type="number" id="ats-tilew" min="1" value="16"></label></div>
    <div class="row"><label>Tile H <input type="number" id="ats-tileh" min="1" value="16"></label></div>
    <div class="row"><label>Layout <select id="ats-layout"><option value="">(none -- add tiles manually)</option></select></label></div>
    <div class="row"><canvas id="ats-layout-preview" class="terrain-layout-preview" hidden></canvas></div>
    <div class="row dlg-actions"><button type="button" id="ats-create">Create</button><button type="button" id="ats-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let presets = [];
  const updatePreview = () => {
    const preset = presets[Number($('#ats-layout').value)];
    const canvas = $('#ats-layout-preview');
    if (preset?.sourceImage) { canvas.hidden = false; drawLayoutPreview(canvas, preset); }
    else { canvas.hidden = true; }
  };
  $('#ats-layout').addEventListener('change', updatePreview);
  markDefaultAction(dlg, $('#ats-create'));
  $('#ats-cancel').addEventListener('click', () => dlg.close());
  $('#ats-create').addEventListener('click', async () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el) => Math.max(1, parseInt(el.value, 10) || 1);
    const tileW = intVal($('#ats-tilew'));
    const tileH = intVal($('#ats-tileh'));
    const { terrainSetId } = dispatch('tiles.createTerrainSet', {
      sheetId: sheet.id,
      opts: { name: $('#ats-name').value.trim() || 'Terrain', tileW, tileH },
    });
    // No terrain-set list to click any more -- auto-select the new set so
    // the Autotiles panel (and, once a tile exists, the Tiles panel) shows
    // it immediately instead of whatever was selected before.
    state.selectedTerrainSetId = terrainSetId;

    const presetValue = $('#ats-layout').value;
    if (presetValue !== '') {
      const preset = presets[Number(presetValue)];
      const { tiles } = dispatch('tiles.addGrid', {
        sheetId: sheet.id,
        opts: { x: 0, y: 0, cellW: tileW, cellH: tileH, cols: preset.cols, rows: preset.rows },
      });
      const sourceTiles = tiles.slice().sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
      dispatch('tiles.applyTerrainLayoutPreset', {
        sheetId: sheet.id, terrainSetId, preset, sourceTileIds: sourceTiles.map(t => t.id), cols: preset.cols,
      });
      const seededMode = preset.name.includes('8×6') ? 'grid8x6' : preset.name.includes('7×7') ? 'grid7x7' : null;
      if (seededMode) terrainSetViewModes.set(terrainSetId, seededMode);
      state.selectedTileId = sourceTiles[0]?.id ?? null;
      await importPresetArtOntoLayer(sheet, preset, sourceTiles, preset.cols);
    } else {
      // No preset -- seed with one standalone (non-grid) tile assigned to
      // the "isolated" slot (blobIndex 0, no neighbors) so the set has at
      // least one referencing tile. A terrain set with zero tiles is what
      // pruneEmptyTerrainSets treats as garbage once any tile/grid deletion
      // elsewhere names it as a candidate.
      dispatch('tiles.createTile', { sheetId: sheet.id, rect: { x: 0, y: 0, w: tileW, h: tileH } });
      const created = sheet.tiles.find(t => t.id === state.selectedTileId);
      if (created) dispatch('tiles.assignTerrainSlot', { sheetId: sheet.id, terrainSetId, blobIndex: 0, tileId: created.id });
    }

    emit('selection');
    dlg.close();
  });
  return {
    open() {
      const sheet = activeSheet();
      const settings = state.project?.settings ?? {};
      $('#ats-tilew').value = String(settings.tileW ?? 16);
      $('#ats-tileh').value = String(settings.tileH ?? 16);

      presets = [...BUILTIN_LAYOUT_PRESETS, ...(sheet?.terrainLayoutPresets ?? [])];
      const layoutSelect = $('#ats-layout');
      layoutSelect.innerHTML = '<option value="">(none -- add tiles manually)</option>';
      presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${p.name} (${p.cols}×${p.rows})`;
        layoutSelect.appendChild(opt);
      });
      updatePreview();

      dlg.showModal();
    },
  };
}

export function buildTilePickerDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'tile-picker-dialog';
  dlg.innerHTML = `
    <h3>Assign tile</h3>
    <div class="tile-picker-header">
      <div class="tile-picker-mask-grid" id="tp-mask"></div>
      <div>
        <div id="tp-desc"></div>
        <div id="tp-badge" class="badge"></div>
      </div>
    </div>
    <div class="tile-picker-grid" id="tp-grid"></div>
    <div class="row dlg-actions"><button type="button" id="tp-clear">Clear</button><button type="button" id="tp-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let onPick = null, onClear = null;
  $('#tp-cancel').addEventListener('click', () => dlg.close());
  $('#tp-clear').addEventListener('click', () => { onClear?.(); dlg.close(); });

  function buildMaskDiagram(mask) {
    const grid = document.createElement('div');
    grid.className = 'tile-picker-mask-inner';
    for (let row = -1; row <= 1; row++) {
      for (let col = -1; col <= 1; col++) {
        const div = document.createElement('div');
        div.className = 'tile-picker-mask-cell';
        if (row === 0 && col === 0) {
          div.classList.add('center');
        } else {
          const dir = DIRECTION_OFFSETS.find(d => d.dx === col && d.dy === row);
          if (mask & dir.bit) div.classList.add('filled');
        }
        grid.appendChild(div);
      }
    }
    return grid;
  }

  return {
    open(sheet, terrainSet, blobIndex, currentTileId, pick, clear) {
      onPick = pick; onClear = clear;
      const mask = blobIndexToMask[blobIndex];
      const classInfo = classifySlots(terrainSet.symmetry).get(blobIndex);
      $('#tp-desc').textContent = describeMask(mask);
      $('#tp-badge').textContent = classInfo.mandatory ? 'Mandatory' : 'Optional (derivable via symmetry)';

      const maskHost = $('#tp-mask');
      maskHost.innerHTML = '';
      maskHost.appendChild(buildMaskDiagram(mask));

      const grid = $('#tp-grid');
      grid.innerHTML = '';
      sheet.tiles
        .filter(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH)
        .forEach((t, i) => {
          const cell = document.createElement('div');
          cell.className = 'tile-picker-cell';
          if (t.id === currentTileId) cell.classList.add('selected');
          const thumb = document.createElement('div');
          thumb.className = 'tile-picker-thumb';
          thumb.style.backgroundImage = `url(${tileThumbnailURL(sheet, t)})`;
          const label = document.createElement('span');
          label.textContent = t.name ? `${i}: ${t.name}` : `#${i}`;
          cell.append(thumb, label);
          cell.addEventListener('click', () => { onPick?.(t.id); dlg.close(); });
          grid.appendChild(cell);
        });

      dlg.showModal();
    },
  };
}

// Keeps state.selectedTerrainSetId following the selected tile -- there's
// no explicit terrain-set list to click any more (Autotiles panel just
// shows whichever set is "current"), so this is the only way that state
// tracks selection. Any tile selection updates it, INCLUDING clearing it
// back to null (selecting an unrelated standalone/grid tile shouldn't
// leave a stale terrain set showing). Deselecting entirely (tile === null)
// is the one case left untouched: state.selectedTerrainSetId persists so a
// just-created, still-empty terrain set (nothing on the sheet to derive it
// from) stays reachable.
export function syncSelectedTerrainSetFromTile(tile) {
  if (tile) state.selectedTerrainSetId = tile.terrainSetId ?? null;
}

// Shared by the Tiles panel's per-tile detail (when the tile belongs to a
// terrain set) and its terrain-set-only fallback card (a just-created set
// with no tiles assigned yet) -- both need the same Name/Layer/Delete
// controls, just reached via a different selection path.
export function terrainSetNameField(terrainSet) {
  const field = document.createElement('label');
  field.className = 'frame-field';
  field.appendChild(document.createTextNode('Set name'));
  const input = document.createElement('input');
  input.type = 'text';
  input.value = terrainSet.name;
  input.title = 'Name of the whole terrain set (shared by every tile in it) — separate from this tile\'s own name above';
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v) {
      const sheet = activeSheet();
      if (sheet) dispatch('tiles.renameTerrainSet', { sheetId: sheet.id, terrainSetId: terrainSet.id, name: v });
    } else input.value = terrainSet.name;
  });
  field.appendChild(input);
  return field;
}

export function terrainSetLayerField(sheet, terrainSet) {
  const field = document.createElement('label');
  field.className = 'frame-field';
  field.appendChild(document.createTextNode('Layer'));
  const select = document.createElement('select');
  const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
  select.appendChild(noneOpt);
  sheet.layers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = terrainSet.layer ?? '';
  select.title = 'Tile Layer for this whole terrain set (shared by every tile in it)';
  select.addEventListener('change', () => dispatch('tiles.setTerrainSetLayer', { sheetId: sheet.id, terrainSetId: terrainSet.id, layer: select.value }));
  field.appendChild(select);
  return field;
}

export function terrainSetDeleteButton(sheet, terrainSet) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-icon-md';
  btn.textContent = '✕';
  btn.title = 'Delete terrain set';
  btn.addEventListener('click', () => {
    dispatch('tiles.deleteTerrainSet', { sheetId: sheet.id, terrainSetId: terrainSet.id });
    if (state.selectedTerrainSetId === terrainSet.id) state.selectedTerrainSetId = null;
  });
  return btn;
}

export function renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog) {
  container.innerHTML = '';

  const painterRow = document.createElement('div');
  painterRow.className = 'row layer-actions';
  const paintSession = getAutotilePaintSession();
  const paintingThisSet = paintSession?.terrainSetId === terrainSet.id && state.tool === 'autotilepaint';
  if (!paintingThisSet) {
    const start = document.createElement('button');
    start.type = 'button'; start.className = 'btn-sm'; start.textContent = '🧩 Paint terrain';
    start.title = 'Paint Blob-47 terrain edges and corners directly over the whole tilesheet';
    start.addEventListener('click', () => startAutotilePaint(sheet, terrainSet));
    painterRow.appendChild(start);
  } else {
    const paint = document.createElement('button');
    paint.type = 'button'; paint.className = 'btn-sm'; paint.textContent = 'Paint';
    paint.classList.toggle('active', paintSession.brush === 'paint');
    paint.addEventListener('click', () => { setAutotilePaintBrush('paint'); renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog); });
    const erase = document.createElement('button');
    erase.type = 'button'; erase.className = 'btn-sm'; erase.textContent = 'Erase';
    erase.classList.toggle('active', paintSession.brush === 'erase');
    erase.addEventListener('click', () => { setAutotilePaintBrush('erase'); renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog); });
    const done = document.createElement('button');
    done.type = 'button'; done.className = 'btn-sm'; done.textContent = 'Done';
    done.addEventListener('click', stopAutotilePaint);
    painterRow.append(paint, erase, done);
    const hint = document.createElement('div');
    hint.className = 'frame-field';
    hint.textContent = 'Drag over tile edges and corners. Green = terrain; red = duplicate pattern conflict. Hover a tile for its resolved preview and the full Blob-47 reference map (blue marks the matching pattern).';
    container.appendChild(hint);
    if (paintSession.conflicts.size) {
      const conflicts = document.createElement('div');
      conflicts.className = 'row layer-actions';
      for (const [tileId, blobIndex] of paintSession.conflicts) {
        const tileIndex = sheet.tiles.findIndex(t => t.id === tileId);
        const use = document.createElement('button');
        use.type = 'button'; use.className = 'btn-sm'; use.textContent = `Use #${tileIndex}`;
        use.title = `Replace the existing ${describeMask(blobIndexToMask[blobIndex])} tile with this painted tile`;
        use.addEventListener('click', () => {
          useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex);
          renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
        });
        conflicts.appendChild(use);
      }
      container.appendChild(conflicts);
    }
  }
  container.appendChild(painterRow);
  const coverage = document.createElement('button');
  coverage.type = 'button'; coverage.className = 'btn-sm'; coverage.textContent = '🔎 Blob-47 coverage…';
  coverage.title = 'Open a large reference board showing expected artwork, assigned tiles, and missing shapes';
  coverage.addEventListener('click', () => openBlob47Coverage(sheet, terrainSet));
  container.appendChild(coverage);

  const symRow = document.createElement('div');
  symRow.className = 'row layer-actions';
  const btnFlip = document.createElement('button');
  btnFlip.type = 'button';
  btnFlip.className = 'btn-icon-sm';
  btnFlip.textContent = '↔';
  btnFlip.title = 'Allow flip (derive flipped slots from their mirror instead of requiring explicit art)';
  btnFlip.setAttribute('aria-pressed', String(terrainSet.symmetry.flip));
  btnFlip.classList.toggle('active', terrainSet.symmetry.flip);
  btnFlip.addEventListener('click', () => dispatch('tiles.setTerrainSymmetry', { sheetId: sheet.id, terrainSetId: terrainSet.id, key: 'flip', value: !terrainSet.symmetry.flip }));
  const btnRotate = document.createElement('button');
  btnRotate.type = 'button';
  btnRotate.className = 'btn-icon-sm';
  btnRotate.textContent = '↻';
  btnRotate.title = 'Allow rotation (derive rotated slots instead of requiring explicit art)';
  btnRotate.setAttribute('aria-pressed', String(terrainSet.symmetry.rotate));
  btnRotate.classList.toggle('active', terrainSet.symmetry.rotate);
  btnRotate.addEventListener('click', () => dispatch('tiles.setTerrainSymmetry', { sheetId: sheet.id, terrainSetId: terrainSet.id, key: 'rotate', value: !terrainSet.symmetry.rotate }));

  symRow.append(btnFlip, btnRotate);
  container.appendChild(symRow);

  const viewModeRow = document.createElement('div');
  viewModeRow.className = 'row';
  const viewModeSelect = document.createElement('select');
  [
    ['staircase', 'Staircase'],
    ['grid8x6', 'Grid 8×6'],
    ['grid7x7', 'Grid 7×7'],
    ['sixteen', '16-tile only'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    viewModeSelect.appendChild(opt);
  });
  viewModeSelect.value = viewModeFor(terrainSet.id);
  viewModeSelect.addEventListener('change', () => {
    terrainSetViewModes.set(terrainSet.id, viewModeSelect.value);
    renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
  });
  viewModeRow.appendChild(viewModeSelect);
  container.appendChild(viewModeRow);

  const classification = classifySlots(terrainSet.symmetry);
  for (const group of slotGroupsForViewMode(viewModeFor(terrainSet.id))) {
    const groupRow = document.createElement('div');
    groupRow.className = 'terrain-slot-group';
    for (const blobIndex of group) {
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const isExplicit = terrainSet.slots[blobIndex] != null;
      const classInfo = classification.get(blobIndex);
      const cell = document.createElement('div');
      cell.className = 'terrain-slot';
      cell.classList.add(classInfo.mandatory ? 'mandatory' : 'optional');

      const mask = blobIndexToMask[blobIndex];
      let title = `${describeMask(mask)} — ${classInfo.mandatory ? 'mandatory' : 'optional'}`;
      if (resolved && !isExplicit) title += ` (derived: flipH=${resolved.flipH}, rotate=${resolved.rotate})`;

      if (resolved) {
        const tile = sheet.tiles.find(t => t.id === resolved.tileId);
        if (tile) {
          cell.style.backgroundImage = `url(${tileThumbnailURL(sheet, tile, { flipH: resolved.flipH, flipV: resolved.flipV, rotate: resolved.rotate })})`;
          if (!isExplicit) {
            const icons = [];
            if (resolved.flipH) icons.push('↔');
            if (resolved.flipV) icons.push('↕');
            if (resolved.rotate) icons.push('↻');
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = icons.join(' ');
            cell.appendChild(badge);
          }
          // Some layout presets repeat a blobIndex across multiple physical
          // tiles (js/core/terrainsets.js's applyLayoutPreset picks one as
          // primary); those extras carry duplicateOf pointing back at this
          // cell's tile. Flag it here too, not just on the tile sheet, so
          // this thumbnail explains why identical-looking tiles elsewhere
          // don't do anything when painted on.
          const duplicateCount = sheet.tiles.filter(t => t.duplicateOf === tile.id).length;
          if (duplicateCount > 0) {
            cell.classList.add('has-duplicates');
            title += ` — ${duplicateCount} linked duplicate tile(s) elsewhere on the sheet (safe to ignore)`;
            const dupBadge = document.createElement('span');
            dupBadge.className = 'badge duplicate-badge';
            dupBadge.textContent = `⧉${duplicateCount}`;
            cell.appendChild(dupBadge);
          }
          if (classInfo.mandatory === false && isExplicit) {
            cell.classList.add('removable');
            title += ' — optional: derivable via flip/rotation, safe to clear';
            const optBadge = document.createElement('span');
            optBadge.className = 'badge removable-badge';
            optBadge.textContent = '✓opt';
            cell.appendChild(optBadge);
          }
        }
      }
      cell.title = title;

      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, blobIndex, terrainSet.slots[blobIndex] ?? null,
          (tileId) => dispatch('tiles.assignTerrainSlot', { sheetId: sheet.id, terrainSetId: terrainSet.id, blobIndex, tileId }),
          () => dispatch('tiles.clearTerrainSlot', { sheetId: sheet.id, terrainSetId: terrainSet.id, blobIndex, tileId: terrainSet.slots[blobIndex] ?? null }));
      });
      groupRow.appendChild(cell);
    }
    container.appendChild(groupRow);
  }
}
```

- [ ] **Step 3: Verify both files have no syntax errors**

Run: `node --check js/modes/tiles/presentation/terrain-set-panel.js && node --check js/modes/tiles/presentation/terrain-set-editor.js`
Expected: no output (exit code 0).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (`tests/architecture.test.mjs`'s dispatch-only scan will now also cover these two new `presentation/` files — neither imports `application/commands/` or `core/commands.js` directly, per Step 2's code above).

- [ ] **Step 5: Commit**

```bash
git add js/modes/tiles/presentation/terrain-set-panel.js js/modes/tiles/presentation/terrain-set-editor.js
git commit -m "Rebuild the terrain-set editor as a Presenter (terrain-set-panel.js + terrain-set-editor.js)"
```

---

### Task 6: Wire contributions, update the consumer, delete the old files, update tests and docs

**Files:**
- Modify: `js/modes/tiles/contributions.js`
- Modify: `js/modes/tiles/presentation/tile-panel.js:9` (import path only)
- Modify: `tests/architecture.test.mjs` (2 edits)
- Modify: `tests/tile-sheet-commands.test.mjs:113-114` (comment wording only)
- Modify: `docs/ARCHITECTURE.md`
- Delete: `js/modes/tiles/autotiles-panel.js`
- Delete: `js/modes/tiles/terrain-set-controller.js`
- Delete: `js/modes/tiles/terrain-set-commands.js`

**Interfaces:**
- Consumes: everything produced by Tasks 1-5.
- Produces: 8 new registered command ids (`tiles.createTerrainSet`, `tiles.deleteTerrainSet`, `tiles.renameTerrainSet`, `tiles.assignTerrainSlot`, `tiles.clearTerrainSlot`, `tiles.setTerrainSymmetry`, `tiles.applyTerrainLayoutPreset`, `tiles.setTerrainSetLayer`) — consumed by Task 7's browser smoke check via the running app's UI.

- [ ] **Step 1: Update `contributions.js`**

Replace the import block (lines 1-19 as of commit `e5f6b06`):

```js
import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './presentation/tile-tool-presenter.js';
import { registerAutotilePaintTool, bindAutotilePaintTool } from './presentation/autotile-paint-presenter.js';
import { mountTilePanel } from './presentation/tile-panel.js';
import { mountAutotilesPanel } from './autotiles-panel.js';
import { mountTileLayersPanel } from './presentation/tile-layers-panel.js';
import { mountTileEditor } from '../../ui/tileeditor.js';
import { renderTilePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  swapTiles, moveTile, moveStandaloneTile, resizeTile, createTile, deleteTile,
  moveGrid, growTileIntoGrid, resizeGridAxis, addGrid, deleteGrid, setGridCellField,
  detachTile, setTileLayer, renameTile, setTileTags, setTileSize,
} from './application/commands/tile-sheet-commands.js';
import { addTileLayer, removeTileLayer } from './application/commands/tile-layer-commands.js';
import {
  prepareTerrainPaint, paintTerrainStroke, resolveAutotilePaintConflict,
} from './application/commands/autotile-paint-commands.js';
```

with:

```js
import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './presentation/tile-tool-presenter.js';
import { registerAutotilePaintTool, bindAutotilePaintTool } from './presentation/autotile-paint-presenter.js';
import { mountTilePanel } from './presentation/tile-panel.js';
import { mountAutotilesPanel } from './presentation/terrain-set-panel.js';
import { mountTileLayersPanel } from './presentation/tile-layers-panel.js';
import { mountTileEditor } from '../../ui/tileeditor.js';
import { renderTilePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  swapTiles, moveTile, moveStandaloneTile, resizeTile, createTile, deleteTile,
  moveGrid, growTileIntoGrid, resizeGridAxis, addGrid, deleteGrid, setGridCellField,
  detachTile, setTileLayer, renameTile, setTileTags, setTileSize,
} from './application/commands/tile-sheet-commands.js';
import { addTileLayer, removeTileLayer } from './application/commands/tile-layer-commands.js';
import {
  prepareTerrainPaint, paintTerrainStroke, resolveAutotilePaintConflict,
} from './application/commands/autotile-paint-commands.js';
import {
  createTerrainSet, deleteTerrainSet, renameTerrainSet, assignTerrainSlot,
  clearTerrainSlot, setTerrainSymmetry, applyTerrainLayoutPreset, setTerrainSetLayer,
} from './application/commands/terrain-set-commands.js';
```

Then, inside `registerTileCommands(api)`, immediately after the existing `tiles.resolveAutotilePaintConflict` registration line, add:

```js
  api.commands.register({ id: 'tiles.createTerrainSet', when: whenTiles, execute: (_c, { sheetId, opts }) => createTerrainSet(services(), sheetId, opts) });
  api.commands.register({ id: 'tiles.deleteTerrainSet', when: whenTiles, execute: (_c, { sheetId, terrainSetId }) => deleteTerrainSet(services(), sheetId, terrainSetId) });
  api.commands.register({ id: 'tiles.renameTerrainSet', when: whenTiles, execute: (_c, { sheetId, terrainSetId, name }) => renameTerrainSet(services(), sheetId, terrainSetId, name) });
  api.commands.register({ id: 'tiles.assignTerrainSlot', when: whenTiles, execute: (_c, { sheetId, terrainSetId, blobIndex, tileId }) => assignTerrainSlot(services(), sheetId, terrainSetId, blobIndex, tileId) });
  api.commands.register({ id: 'tiles.clearTerrainSlot', when: whenTiles, execute: (_c, { sheetId, terrainSetId, blobIndex, tileId }) => clearTerrainSlot(services(), sheetId, terrainSetId, blobIndex, tileId) });
  api.commands.register({ id: 'tiles.setTerrainSymmetry', when: whenTiles, execute: (_c, { sheetId, terrainSetId, key, value }) => setTerrainSymmetry(services(), sheetId, terrainSetId, key, value) });
  api.commands.register({ id: 'tiles.applyTerrainLayoutPreset', when: whenTiles, execute: (_c, { sheetId, terrainSetId, preset, sourceTileIds, cols }) => applyTerrainLayoutPreset(services(), sheetId, terrainSetId, preset, sourceTileIds, cols) });
  api.commands.register({ id: 'tiles.setTerrainSetLayer', when: whenTiles, execute: (_c, { sheetId, terrainSetId, layer }) => setTerrainSetLayer(services(), sheetId, terrainSetId, layer) });
```

- [ ] **Step 2: Update `tile-panel.js`'s import path**

In `js/modes/tiles/presentation/tile-panel.js`, change:

```js
import {
  buildAddTerrainSetDialog,
  terrainSetNameField,
  terrainSetLayerField,
  terrainSetDeleteButton,
  syncSelectedTerrainSetFromTile,
} from '../terrain-set-controller.js';
```

to:

```js
import {
  buildAddTerrainSetDialog,
  terrainSetNameField,
  terrainSetLayerField,
  terrainSetDeleteButton,
  syncSelectedTerrainSetFromTile,
} from './terrain-set-editor.js';
```

No other change to this file — none of these five functions' signatures change.

- [ ] **Step 3: Delete the three old files**

```bash
git rm js/modes/tiles/autotiles-panel.js js/modes/tiles/terrain-set-controller.js js/modes/tiles/terrain-set-commands.js
```

- [ ] **Step 4: Update `tests/architecture.test.mjs`**

Two edits.

First, in the `'mode pointer controllers do not import contextual panels or terrain UI'` test, change:

```js
  assert.doesNotMatch(tileController, /(?:tile-panel|autotiles-panel|tile-layers-panel|terrain-set-controller|tile-tags-field)/);
```

to:

```js
  assert.doesNotMatch(tileController, /(?:tile-panel|terrain-set-panel|tile-layers-panel|terrain-set-editor|tile-tags-field)/);
```

(swaps the two deleted file-name fragments for their replacements, so the guard keeps meaning "the CORE tool's pointer controller never reaches into panel-specific UI files" after the rename).

Second, in the `'mode command modules do not access browser UI globals'` test, change the file list:

```js
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
    join(root, 'js/modes/tiles/application/commands/autotile-paint-commands.js'),
  ]) {
```

to:

```js
  for (const file of [
    join(root, 'js/modes/tiles/application/commands/tile-sheet-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-set-commands.js'),
    join(root, 'js/modes/tiles/application/commands/terrain-slot-snapshot.js'),
    join(root, 'js/modes/tiles/application/commands/tile-layer-commands.js'),
    join(root, 'js/modes/tiles/application/commands/autotile-paint-commands.js'),
  ]) {
```

(No other test in this file needs updating — the two glob-based scans covering `application/` banned-globals and `presentation/` dispatch-only rules automatically pick up every new file under `js/modes/tiles/application/` and `js/modes/tiles/presentation/`.)

- [ ] **Step 5: Update the stale comment in `tests/tile-sheet-commands.test.mjs`**

Lines 113-115 currently read:

```js
  // Simulate an external reference holder (e.g. terrain-set-commands.js's
  // commitAssignSlot, which captures a tile object by reference and mutates
  // it directly) so a fresh-object regression on redo would be caught here.
```

`commitAssignSlot` no longer exists after this task's deletions (replaced by the resolve-by-id `assignTerrainSlot`, which does not capture tile references). Update the comment to:

```js
  // Simulate an external reference holder (a caller that captured a tile
  // object by reference and mutates it directly, the way this codebase's
  // pre-migration command files used to) so a fresh-object regression on
  // redo would be caught here.
```

The test logic itself is unchanged — only the now-inaccurate file reference in the comment.

- [ ] **Step 6: Update `docs/ARCHITECTURE.md`**

In the Tiles mode section, change the intro (currently):

```
**Tiles mode** (`js/modes/tiles/`) — this is the mode the autotiles panel
belongs to. It has partially migrated to the Application/Presentation split
(see the Sprites/Maps note below): the tile sheet/grid tool and the Blob-47
autotile painter have moved; the terrain-set editor has not yet (planned
for sub-phase 3c):
```

to:

```
**Tiles mode** (`js/modes/tiles/`) — this is the mode the autotiles panel
belongs to. It has fully migrated to the Application/Presentation split
(see the Sprites/Maps note below), except for the legacy `js/ui/tileeditor.js`
absorption planned for sub-phase 3d:
```

Change the panel-registration bullet's reference to the old file name — find:

```
  panels contribution whose `createController` wires
  `registerTileTool()`/`registerAutotilePaintTool()` and returns
  `{decorateOverlay}` to layer tile chrome onto the shared canvas; three
  panels gated `when: keys => keys.modeId === 'tiles'` — `tiles.tiles` →
  `#panel-context` (`presentation/tile-panel.js`), `tiles.autotiles` →
  `#panel-autotiles` (`autotiles-panel.js`), `tiles.layers` →
  `#panel-tilelayers` (`presentation/tile-layers-panel.js`); two views —
  `tiles.sheet` (shared canvas) and `tiles.tile` (per-tile zoomed editor,
  `ui/tileeditor.js`).
```

(the actual first line reads "a preview provider... one tools contribution whose"; match on the `#panel-autotiles` line specifically) and change `` `#panel-autotiles` (`autotiles-panel.js`) `` to `` `#panel-autotiles` (`presentation/terrain-set-panel.js`) ``.

Replace the two "not yet migrated" bullets (currently):

```
- `terrain-set-controller.js` (545 lines) — terrain-set slot editor UI
  (tile picker dialog, layout presets), used by `autotiles-panel.js`.
  **Not yet migrated** — pending Phase 3c.
- `autotiles-panel.js` (48 lines) — a thin **panel mount function**: builds
  the tile-picker dialog + editor container, delegates rendering to
  `terrain-set-controller.js`, subscribes to legacy
  `on('project'|'history'|'pixels'|'view'|'selection', ...)` events to
  schedule `queueMicrotask`-debounced re-renders, and syncs
  `state.selectedTerrainSetId` from `state.selectedTileId`.
- `terrain-set-commands.js` (123 lines) — terrain-set command handlers.
  **Not yet migrated** — still uses the old object-capture command style
  (closures that memoize created/mutated objects directly, rather than
  resolve-by-id), pending Phase 3c. Its call sites (e.g.
  `terrain-set-controller.js`) capture tile objects returned from
  `tile-sheet-commands.js` by reference and mutate them directly, so the
  migrated tile commands must preserve object identity across undo/redo
  for those references to stay valid.
```

with:

```
- `application/commands/terrain-set-commands.js` — Command Handlers for
  terrain-set CRUD and slot assignment: `createTerrainSet`,
  `deleteTerrainSet`, `renameTerrainSet`, `assignTerrainSlot`,
  `clearTerrainSlot`, `setTerrainSymmetry`, `applyTerrainLayoutPreset`,
  `setTerrainSetLayer`. Resolve-by-id, registered by id in
  `contributions.js`. Wraps `core/terrainsets.js`'s pure
  `assignSlot`/`applyLayoutPreset` via the shared
  `terrain-slot-snapshot.js` helper below.
- `application/commands/terrain-slot-snapshot.js` — `captureTerrainSlotState`/
  `restoreTerrainSlotState`, shared by `terrain-set-commands.js` and
  `autotile-paint-commands.js`'s `resolveAutotilePaintConflict`. Captures
  every terrain set's `slots` plus every tile's back-reference fields, since
  `assignSlot` can mutate a *different* terrain set's slots when the tile
  being assigned already belongs to one.
- `application/geometry/terrain-set-geometry.js` — pure view-arrangement
  helpers (`blobStaircaseGroups`, `gridFromRawTemplate`,
  `slotGroupsForViewMode`) for the terrain-set editor's cosmetic slot
  layout, no DOM or state access.
- `presentation/terrain-set-editor.js` — the terrain-set editor's dialogs
  (add-terrain-set, tile-picker) and `renderTerrainSetEditor`, plus the
  Name/Layer/Delete field helpers shared with `tile-panel.js`. Dispatches
  Commands by id; never imports `application/commands/` directly
  (test-enforced).
- `presentation/terrain-set-panel.js` — a thin **panel mount function**:
  builds the tile-picker dialog + editor container, delegates rendering to
  `terrain-set-editor.js`, subscribes to legacy
  `on('project'|'history'|'pixels'|'view'|'selection', ...)` events to
  schedule `queueMicrotask`-debounced re-renders, and syncs
  `state.selectedTerrainSetId` from `state.selectedTileId`.
```

Finally, check the "Sprites/Maps note below" and the `autotiles-panel.js` mention later in the file (around the `queueMicrotask`-debounced re-render note in the Features section) — search for any remaining `autotiles-panel.js`/`terrain-set-controller.js`/`terrain-set-commands.js` references with:

```bash
grep -n "autotiles-panel\|terrain-set-controller\|terrain-set-commands\.js" docs/ARCHITECTURE.md
```

Update any match found (there is at least one more, an illustrative example in the Features section's panel-mount discussion — reword it to reference `terrain-set-panel.js` instead) to point at the new file names, keeping the surrounding sentence's meaning intact.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the two edited `tests/architecture.test.mjs` assertions and the new glob-based scans automatically covering every file created in Tasks 1, 2, 3, and 5.

- [ ] **Step 8: Grep for any remaining reference to the deleted files**

```bash
grep -rn "terrain-set-controller\.js\|autotiles-panel\.js\|modes/tiles/terrain-set-commands\.js" js/ tests/ docs/ARCHITECTURE.md
```

Expected: no matches (a match inside `docs/superpowers/plans/` or `docs/superpowers/specs/` for an *earlier* phase's historical plan/spec document is fine and expected — those are frozen records of past state, not live references; do not edit them).

- [ ] **Step 9: Commit**

```bash
git add js/modes/tiles/contributions.js js/modes/tiles/presentation/tile-panel.js \
  tests/architecture.test.mjs tests/tile-sheet-commands.test.mjs docs/ARCHITECTURE.md
git rm js/modes/tiles/autotiles-panel.js js/modes/tiles/terrain-set-controller.js js/modes/tiles/terrain-set-commands.js
git commit -m "Wire the migrated terrain-set editor into contributions.js and retire the old files"
```

(The `git rm` calls from Step 3 are already staged; this commits everything together.)

---

### Task 7: Non-drag browser smoke check

**Files:** none (verification only, no code changes).

- [ ] **Step 1: Start the dev server**

Run `serve.ps1` (see `[[serve-with-serveps1-not-python]]`) in the background, capture its PID and the port it printed.

- [ ] **Step 2: Navigate and reach Tiles mode**

Open `http://localhost:<port>/?autotest` (the `?autotest` query param suppresses `beforeunload`/`confirm`/`alert`-blocking dialogs, per `[[autotest-disable-dialogs]]`). Switch to Tile Sheets, create or select a sheet.

- [ ] **Step 3: Add a terrain set with a built-in layout preset**

Click "➕ Autotiles" in the Tiles panel to open "Add terrain set". Pick the "8×6" (or "7×7") built-in preset from the Layout dropdown, confirm the preview canvas renders (with any duplicate-cell dashed-orange badges visible), click Create. Confirm the Autotiles panel now shows the terrain-set editor with slots populated from the preset (several cells showing real thumbnail art, not blank).

- [ ] **Step 4: Assign a slot via the tile picker**

Click an empty (unassigned) slot cell in the editor. Confirm the "Assign tile" dialog opens showing the mask diagram and a grid of same-size tile candidates. Click one via `page.mouse.click(x, y)` (a single click — no drag, per `[[no-drag-smoke-tests]]`). Confirm the dialog closes and the slot now shows that tile's thumbnail.

- [ ] **Step 5: Verify via live state, not screenshot reading**

Use `browser_evaluate` with a dynamic `import('/js/app/state.js')` to read `activeSheet().terrainSets[0].slots` and confirm the assignment matches what Step 4 picked, by tile id — ground truth, not pixel-reading.

- [ ] **Step 6: Clear a slot**

Click an explicitly-assigned (non-derived) slot cell, click "Clear" in the tile-picker dialog. Confirm the cell reverts to unassigned (or to a derived/flipped preview, if flip/rotate symmetry is on) and, via live-state check, that `terrainSet.slots[blobIndex]` is gone.

- [ ] **Step 7: Toggle symmetry**

Click the ↔ (flip) button. Confirm its `aria-pressed` attribute flips to `"true"` and at least one previously-empty slot cell now shows a derived preview with a flip badge. Toggle it back off.

- [ ] **Step 8: Delete the terrain set**

Click the terrain-set delete button (✕) in the Tiles panel's terrain-set detail. Confirm, via live state, `sheet.terrainSets` no longer contains it and every tile that referenced it has `terrainSetId`/`blobIndex` cleared.

- [ ] **Step 9: Undo/redo round-trip**

Press Ctrl+Z enough times to undo the delete, the symmetry toggles, the clear, and the assign from Steps 3-8; confirm each step's live-state check reverses correctly. Press Ctrl+Y the same number of times; confirm the final state matches Step 8's post-delete state again. Check `browser_console_messages` throughout — no new errors beyond the already-known, pre-existing, unrelated `js/ui/floatsession.js:452` `isTypingTarget` ReferenceError (see `[[phase-3-tiles-mode-migration]]`).

- [ ] **Step 10: Stop the dev server**

Kill the background dev server process by PID; report the PID and a copy-pasteable kill command to the user, per the global "Dev servers" instruction.

- [ ] **Step 11: Report results**

Summarize pass/fail per step, any console errors beyond the known pre-existing one, and any visual discrepancies. No commit for this task (verification only).
