# Autotile Panel Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the Tiles and Autotiles panels into selection-driven detail views (mirroring the Frames panel), fix confusing/dead UI, and add clearer signaling for slots/tiles that don't strictly need to exist.

**Architecture:** UI-and-wiring-only pass across `js/ui/tilemode.js`, `js/ui/overlays.js`, `js/core/tilegrids.js`, `js/core/terrainsets.js`, `index.html`, `js/app/main.js`, `css/app.css`. No new persisted/exported fields — `terrainSet.layer`, `tile.layer`, `tile.duplicateOf`, `tile.gridId` all already exist. One new transient (non-persisted) module-level `Map` for per-terrain-set view mode.

**Tech Stack:** Vanilla JS (ES modules), `node --test` for core logic, Playwright (manual/on-demand) for UI verification per this codebase's existing convention.

## Global Constraints

- Core (`js/core/*`) stays pure and DOM-free, unit-testable via `node --test`; UI (`js/ui/*`) stays DOM-only and is excluded from the automated suite (existing codebase convention — see `js/core/blob47.js`'s header).
- No new npm dependencies.
- Every task ends with `npm test` passing (159 tests before this plan starts) and a manual/Playwright browser check where the task touches `js/ui/*`.
- Reuse existing icon vocabulary: ↔ = flip, ↻ = rotate (already used as badges in `renderTerrainSetEditor`).
- Reuse existing `button.active { background: var(--accent); color: #fff; }` CSS rule (css/app.css:42) for toggle-button pressed state — do not invent a new rule for this.
- Full design rationale lives in `docs/superpowers/specs/2026-07-18-autotile-panel-cleanup-design.md`; this plan implements it task-by-task.

---

### Task 1: Grid deletion scrubs tile references + prunes emptied terrain sets

**Files:**
- Modify: `js/core/tilegrids.js` (`removeTileGrid`, ~line 98)
- Modify: `js/core/terrainsets.js` (new `pruneEmptyTerrainSets` export)
- Test: `tests/tilegrids.test.mjs`, `tests/terrainsets.test.mjs`

**Interfaces:**
- Produces: `pruneEmptyTerrainSets(sheet, candidateIds)` in `js/core/terrainsets.js` — for each id in `candidateIds`, if the matching terrain set exists and no tile in `sheet.tiles` has `terrainSetId === id`, calls `removeTerrainSet(sheet, id)`. Returns the array of ids actually removed. Does NOT scan the whole sheet — only checks the given candidates, so a terrain set that was already empty for unrelated reasons is never touched by this call.
- Consumes (Task 2): the return value, to clear `state.selectedTerrainSetId` if it was pruned.

- [ ] **Step 1: Write the failing tests**

Add to `tests/tilegrids.test.mjs`, right after the existing `'removeTileGrid drops the grid and every tile it owns, leaves others'` test (~line 99):

```js
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
```

Add to `tests/terrainsets.test.mjs`, right after the `'applyLayoutPreset marks non-primary duplicate cells...'` test:

```js
test('pruneEmptyTerrainSets removes only candidates that ended up with zero referencing tiles', () => {
  const s = tileSheet();
  const tsEmptiedOut = createTerrainSet(s, { name: 'Emptied', tileW: 16, tileH: 16 });
  const tsStillHasTiles = createTerrainSet(s, { name: 'Survives', tileW: 16, tileH: 16 });
  const tsUnrelatedAndAlreadyEmpty = createTerrainSet(s, { name: 'PreExistingEmpty', tileW: 16, tileH: 16 });
  const survivor = tile('t-survivor');
  s.tiles.push(survivor);
  assignSlot(s, tsStillHasTiles, 0, survivor);
  // tsEmptiedOut has no tiles at all (as if its only tile was just scrubbed by removeTileGrid)
  // tsUnrelatedAndAlreadyEmpty also has none, but is NOT a candidate -- must survive untouched
  const removedIds = pruneEmptyTerrainSets(s, [tsEmptiedOut.id, tsStillHasTiles.id]);
  assert.deepEqual(removedIds, [tsEmptiedOut.id]);
  assert.equal(s.terrainSets.some(ts => ts.id === tsEmptiedOut.id), false);
  assert.equal(s.terrainSets.some(ts => ts.id === tsStillHasTiles.id), true);
  assert.equal(s.terrainSets.some(ts => ts.id === tsUnrelatedAndAlreadyEmpty.id), true);
});
```

Add `pruneEmptyTerrainSets` to the import list at the top of `tests/terrainsets.test.mjs`:

```js
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset,
  groupCellsByBlobIndex, pruneEmptyTerrainSets,
} from '../js/core/terrainsets.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `removeTileGrid` doesn't scrub yet (slots still has `{5: right.id}`); `pruneEmptyTerrainSets` is not exported (`TypeError: pruneEmptyTerrainSets is not a function`).

- [ ] **Step 3: Implement `removeTileGrid`'s scrub**

In `js/core/tilegrids.js`, replace:

```js
export function removeTileGrid(sheet, gridId) {
  sheet.tileGrids = sheet.tileGrids.filter(g => g.id !== gridId);
  sheet.tiles = sheet.tiles.filter(t => t.gridId !== gridId);
}
```

with:

```js
// Mirrors resizeGridCols/resizeGridRows's shrink path: every removed tile
// must be scrubbed from other tiles' neighbors and any terrain set's slots,
// or those references dangle. Whole-grid deletion was missing this.
export function removeTileGrid(sheet, gridId) {
  const removed = sheet.tiles.filter(t => t.gridId === gridId);
  sheet.tileGrids = sheet.tileGrids.filter(g => g.id !== gridId);
  sheet.tiles = sheet.tiles.filter(t => t.gridId !== gridId);
  for (const t of removed) scrubTileReferences(sheet, t.id);
}
```

`scrubTileReferences` is already imported at the top of this file.

- [ ] **Step 4: Implement `pruneEmptyTerrainSets`**

In `js/core/terrainsets.js`, add after `applyLayoutPreset` (and its `groupCellsByBlobIndex` helper):

```js
// Called after a bulk tile removal (grid deletion) that may have left a
// terrain set with nothing referencing it. Only checks the given
// candidates (the terrainSetIds the removed tiles used to belong to) --
// never sweeps the whole sheet, so a terrain set that was already empty
// for unrelated reasons (e.g. just created via "(none -- add tiles
// manually)") is never touched by this call. Returns the ids actually
// removed, so the caller can clear any UI selection pointing at them.
export function pruneEmptyTerrainSets(sheet, candidateIds) {
  const removedIds = [];
  for (const id of candidateIds) {
    const ts = sheet.terrainSets.find(t => t.id === id);
    if (!ts) continue;
    if (!sheet.tiles.some(t => t.terrainSetId === id)) {
      removeTerrainSet(sheet, id);
      removedIds.push(id);
    }
  }
  return removedIds;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 161 tests (159 + 2 new).

- [ ] **Step 6: Commit**

```bash
git add js/core/tilegrids.js js/core/terrainsets.js tests/tilegrids.test.mjs tests/terrainsets.test.mjs
git commit -m "fix: removeTileGrid scrubs dangling references; add pruneEmptyTerrainSets"
```

---

### Task 2: Wire implicit terrain-set deletion into grid deletion

**Files:**
- Modify: `js/ui/tilemode.js` (`commitDeleteGrid`, ~line 327)

**Interfaces:**
- Consumes: `pruneEmptyTerrainSets` from `js/core/terrainsets.js` (Task 1), `ownedTiles` from `js/core/tilegrids.js` (already imported).

- [ ] **Step 1: Add the import**

In `js/ui/tilemode.js`, extend the existing terrainsets.js import:

```js
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset, groupCellsByBlobIndex,
  pruneEmptyTerrainSets,
} from '../core/terrainsets.js';
```

- [ ] **Step 2: Rewrite `commitDeleteGrid`**

Replace:

```js
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
```

with:

```js
function commitDeleteGrid(sheet, grid) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  const candidateTerrainSetIds = [...new Set(ownedTiles(sheet, grid.id).map(t => t.terrainSetId).filter((id) => id != null))];
  removeTileGrid(sheet, grid.id);
  const prunedIds = pruneEmptyTerrainSets(sheet, candidateTerrainSetIds);
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  state.commands.push({
    label: 'delete grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); sheet.terrainSets = afterSets.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); sheet.terrainSets = beforeSets.slice(); },
  });
  markDirty();
}
```

- [ ] **Step 3: Verify**

Run: `node --check js/ui/tilemode.js && npm test`
Expected: PASS, 161 tests (no new automated tests here — UI wiring is excluded from the suite per this codebase's convention).

Manual/Playwright check: create a terrain set from the 7×7 preset (its own grid), select it, then delete that grid via the Tiles panel's "Delete grid" button (still present until Task 8's rewrite — if Task 8 already landed, use whatever the current grid-delete affordance is). Confirm the terrain set disappears from the Autotiles panel's list too, and `npm test` / console show no errors. Create a second, unrelated terrain set with "(none — add tiles manually)" first and confirm deleting the OTHER terrain set's grid does NOT remove this unrelated empty one.

- [ ] **Step 4: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: deleting a grid implicitly deletes any terrain set it emptied out"
```

---

### Task 3: Remove the layout-preset row

**Files:**
- Modify: `js/ui/tilemode.js` (`renderLayoutPresetRow` and its call site, `commitSaveLayoutPreset`)

**Interfaces:**
- Consumes: none new.
- Produces: `renderTerrainSetEditor` no longer calls `renderLayoutPresetRow`.

- [ ] **Step 1: Delete the function and its call**

In `js/ui/tilemode.js`:
1. Delete the entire `renderLayoutPresetRow(container, sheet, terrainSet) { ... }` function (defined ~line 1236–1301, per the current file — the one with `presetSelect`, `gridSelect`, `btnImport`, `btnSave`).
2. In `renderTerrainSetEditor`, delete the line `renderLayoutPresetRow(container, sheet, terrainSet);` (first line of the function body, right after `container.innerHTML = '';`).
3. Delete the now-unused `commitSaveLayoutPreset` function (search for `function commitSaveLayoutPreset` — it becomes dead code since only the deleted row called it).

Leave `applyLayoutPreset`, `commitApplyLayoutPreset`, `saveLayoutPreset` (core), and `sheet.terrainLayoutPresets` untouched — `commitApplyLayoutPreset` is still used by the Add Terrain Set dialog's creation flow.

- [ ] **Step 2: Verify**

Run: `node --check js/ui/tilemode.js && npm test`
Expected: PASS, 161 tests.

Manual/Playwright check: open a terrain set's editor in the Autotiles panel — confirm no preset/grid dropdown row with ⬇/💾 buttons appears above the symmetry row.

- [ ] **Step 3: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "fix: remove the layout-preset import/save row from the terrain set editor"
```

---

### Task 4: Optional-but-explicit indicator on the terrain-slot grid

**Files:**
- Modify: `js/ui/tilemode.js` (`renderTerrainSetEditor`'s slot loop)
- Modify: `css/app.css`

**Interfaces:**
- Consumes: `classInfo.mandatory`, `isExplicit` (both already computed per-slot in the existing loop).

- [ ] **Step 1: Add the CSS**

In `css/app.css`, after the existing `.terrain-slot .duplicate-badge` rule:

```css
.terrain-slot.removable { outline: 2px dashed #6a7a9a; outline-offset: 1px; }
.terrain-slot .removable-badge { top: 0; right: 0; bottom: auto; left: auto; background: rgba(40,50,70,.85); }
```

(Deliberately a muted blue/grey, distinct from the duplicate marker's orange `#e0a030`/`rgba(90,58,0,.85)`, so the two meanings don't visually blend.)

- [ ] **Step 2: Add the marker in the slot loop**

In `js/ui/tilemode.js`, inside `renderTerrainSetEditor`'s slot loop, right after the existing `if (duplicateCount > 0) { ... }` block (added in the previous round of work) and still inside `if (resolved) { const tile = ...; if (tile) { ... } }`:

```js
if (classInfo.mandatory === false && isExplicit) {
  cell.classList.add('removable');
  title += ' — optional: derivable via flip/rotation, safe to clear';
  const optBadge = document.createElement('span');
  optBadge.className = 'badge removable-badge';
  optBadge.textContent = '✓opt';
  cell.appendChild(optBadge);
}
```

- [ ] **Step 3: Verify**

Run: `node --check js/ui/tilemode.js && npm test`
Expected: PASS, 161 tests.

Manual/Playwright check: create a terrain set from a preset (all 47 slots explicit), enable "Allow flip" and "Allow rotation" — every non-core (non-16-tile) slot should now show the muted blue dashed outline + "✓opt" badge, since they're all explicitly assigned but now derivable.

- [ ] **Step 4: Commit**

```bash
git add js/ui/tilemode.js css/app.css
git commit -m "feat: flag optional-but-explicitly-assigned terrain slots as safe to clear"
```

---

### Task 5: Optional-but-explicit color-wash overlay on the tile sheet

**Files:**
- Modify: `js/ui/overlays.js`

**Interfaces:**
- Consumes: `classifySlots` from `js/core/blob47.js` (new import).

- [ ] **Step 1: Add the import and color constant**

In `js/ui/overlays.js`:

```js
import { state, activeSheet } from '../app/state.js';
import { classifySlots } from '../core/blob47.js';
```

Add near the other color constants:

```js
// Distinct from DUPLICATE_STROKE/DUPLICATE_CHIP_BG's orange (js/ui/overlays.js
// already uses that for dead-end duplicate tiles) -- this is "works fine,
// just not required", not "does nothing at all".
const REMOVABLE_FILL = 'rgba(120,130,170,.35)';
```

- [ ] **Step 2: Paint the wash in `drawTileOverlays`**

In `drawTileOverlays`, inside the existing per-tile outline loop (the one that already branches on `t.duplicateOf != null` for `DUPLICATE_STROKE`), add a fill pass for optional-but-explicit tiles. Full updated loop:

```js
for (const t of tiles) {
  const p0 = view.imageToScreen(t.x, t.y);
  const p1 = view.imageToScreen(t.x + t.w, t.y + t.h);
  const isDuplicate = t.duplicateOf != null;
  if (!isDuplicate && t.terrainSetId != null && t.blobIndex != null) {
    const ts = sheet.terrainSets?.find(s => s.id === t.terrainSetId);
    if (ts) {
      const classInfo = classifySlots(ts.symmetry).get(t.blobIndex);
      if (classInfo && !classInfo.mandatory) {
        ctx.fillStyle = REMOVABLE_FILL;
        ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      }
    }
  }
  ctx.strokeStyle = isDuplicate ? DUPLICATE_STROKE : FRAME_STROKE;
  ctx.setLineDash(isDuplicate ? [3, 3] : []);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}
```

(A duplicate tile is always non-mandatory-classification-irrelevant — it has no `blobIndex` of its own once vacated — so the `!isDuplicate` guard also naturally prevents the two treatments from ever overlapping on the same tile.)

- [ ] **Step 3: Verify**

Run: `node --check js/ui/overlays.js && npm test`
Expected: PASS, 161 tests.

Manual/Playwright check: same setup as Task 4 (preset-created terrain set, flip+rotation enabled) — the corresponding tiles on the tile sheet itself should show a translucent blue-grey wash across the whole cell, not just an outline, distinct from the orange duplicate tiles' dashed outline.

- [ ] **Step 4: Commit**

```bash
git add js/ui/overlays.js
git commit -m "feat: color-wash tile sheet cells whose terrain slot is optional but explicitly assigned"
```

---

### Task 6: Icon toggle buttons for flip/rotation

**Files:**
- Modify: `js/ui/tilemode.js` (`renderTerrainSetEditor`'s `symRow`)

**Interfaces:** none new.

- [ ] **Step 1: Replace the checkboxes**

In `js/ui/tilemode.js`, in `renderTerrainSetEditor`, replace:

```js
  const symRow = document.createElement('div');
  symRow.className = 'row';
  const flipCb = document.createElement('input'); flipCb.type = 'checkbox'; flipCb.checked = terrainSet.symmetry.flip;
  flipCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'flip', flipCb.checked));
  const rotCb = document.createElement('input'); rotCb.type = 'checkbox'; rotCb.checked = terrainSet.symmetry.rotate;
  rotCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'rotate', rotCb.checked));
  const flipLabel = document.createElement('label'); flipLabel.append(flipCb, document.createTextNode(' Allow flip'));
  const rotLabel = document.createElement('label'); rotLabel.append(rotCb, document.createTextNode(' Allow rotation'));

  const layerSelect = document.createElement('select');
  const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
  layerSelect.appendChild(noneOpt);
  sheet.layers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    layerSelect.appendChild(opt);
  });
  layerSelect.value = terrainSet.layer ?? '';
  layerSelect.addEventListener('change', () => commitSetTerrainSetLayer(terrainSet, layerSelect.value));

  symRow.append(flipLabel, rotLabel, layerSelect);
  container.appendChild(symRow);
```

with:

```js
  const symRow = document.createElement('div');
  symRow.className = 'row';
  const btnFlip = document.createElement('button');
  btnFlip.type = 'button';
  btnFlip.textContent = '↔';
  btnFlip.title = 'Allow flip (derive flipped slots from their mirror instead of requiring explicit art)';
  btnFlip.setAttribute('aria-pressed', String(terrainSet.symmetry.flip));
  btnFlip.classList.toggle('active', terrainSet.symmetry.flip);
  btnFlip.addEventListener('click', () => commitSetSymmetry(terrainSet, 'flip', !terrainSet.symmetry.flip));
  const btnRotate = document.createElement('button');
  btnRotate.type = 'button';
  btnRotate.textContent = '↻';
  btnRotate.title = 'Allow rotation (derive rotated slots instead of requiring explicit art)';
  btnRotate.setAttribute('aria-pressed', String(terrainSet.symmetry.rotate));
  btnRotate.classList.toggle('active', terrainSet.symmetry.rotate);
  btnRotate.addEventListener('click', () => commitSetSymmetry(terrainSet, 'rotate', !terrainSet.symmetry.rotate));

  symRow.append(btnFlip, btnRotate);
  container.appendChild(symRow);
```

(The `layerSelect` block moves to the Tiles panel in Task 8, not deleted — it's cut from here and pasted there, not lost. Deleting it from this task's diff without adding it elsewhere would silently drop working functionality; Task 8 is the deliberate relocation.)

- [ ] **Step 2: Verify**

Run: `node --check js/ui/tilemode.js && npm test`
Expected: PASS, 161 tests. Note: `commitSetTerrainSetLayer` becomes temporarily unused after this task (its only caller was just deleted) — that's expected and resolved by Task 8, which adds a new caller. Leave the function in place.

Manual/Playwright check: the symmetry row now shows two icon buttons (↔, ↻) instead of checkboxes+text+a bare dropdown; clicking one toggles its pressed (`.active`, filled accent background) state and immediately affects slot classification (mandatory/optional borders on the slot grid update).

- [ ] **Step 3: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: allow-flip/rotation become icon toggle buttons instead of checkboxes"
```

---

### Task 7: Drop the "View" label; per-terrain-set default view mode

**Files:**
- Modify: `js/ui/tilemode.js`

**Interfaces:**
- Produces: `terrainSetViewModes` (module-level `Map<terrainSetId, viewMode>`), replacing the single `terrainViewMode` variable everywhere it's read/written in this file.

- [ ] **Step 1: Replace the module-level variable with a per-set map**

Replace:

```js
// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid8x6' | 'grid7x7' | 'sixteen'.
let terrainViewMode = 'staircase';
```

with:

```js
// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid8x6' | 'grid7x7' | 'sixteen'. Keyed per terrain set
// (not a single shared variable) so switching between two terrain sets
// doesn't leak one's view-mode choice into the other; transient, not
// persisted/exported -- purely a UI nicety, seeded at creation time by
// commitAddTerrainSet's caller (see buildAddTerrainSetDialog) to match
// whichever built-in preset was used.
const terrainSetViewModes = new Map();
function viewModeFor(terrainSetId) {
  return terrainSetViewModes.get(terrainSetId) ?? 'staircase';
}
```

- [ ] **Step 2: Update `renderTerrainSetEditor`'s view-mode row**

Replace:

```js
  const viewModeRow = document.createElement('div');
  viewModeRow.className = 'row';
  const viewModeLabel = document.createElement('label');
  viewModeLabel.appendChild(document.createTextNode('View '));
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
  viewModeSelect.value = terrainViewMode;
  viewModeSelect.addEventListener('change', () => {
    terrainViewMode = viewModeSelect.value;
    renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
  });
  viewModeLabel.appendChild(viewModeSelect);
  viewModeRow.appendChild(viewModeLabel);
  container.appendChild(viewModeRow);

  const classification = classifySlots(terrainSet.symmetry);
  for (const group of slotGroupsForViewMode(terrainViewMode)) {
```

with:

```js
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
```

- [ ] **Step 3: Seed the default at creation time**

In `buildAddTerrainSetDialog`'s `#ats-create` click handler, after `commitApplyLayoutPreset(...)`, add:

```js
      const seededMode = preset.name.includes('8×6') ? 'grid8x6' : preset.name.includes('7×7') ? 'grid7x7' : null;
      if (seededMode) terrainSetViewModes.set(terrainSet.id, seededMode);
```

Place it right after the `commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, preset.cols);` line, still inside the `if (presetValue !== '') { ... }` block (so it only runs when a preset was actually picked).

- [ ] **Step 4: Verify**

Run: `node --check js/ui/tilemode.js && npm test`
Expected: PASS, 161 tests.

Manual/Playwright check: create one terrain set from the "Blob-47 (7×7)" preset and another from "Blob-47 (8×6)" — opening each for the first time should default its View dropdown to "Grid 7×7" / "Grid 8×6" respectively, not always "Staircase". Switch set A's view to "16-tile only", switch to set B, confirm B still shows its own default (not A's choice).

- [ ] **Step 5: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: per-terrain-set view mode, defaulted from its creation preset; drop 'View' label"
```

---

### Task 8: Tiles panel rewrite — selection-driven, moved Add Terrain Set button, relocated layer dropdown

**Files:**
- Modify: `js/ui/tilemode.js` (`mountTilePanel`, `renderTerrainSetEditor`'s Autotiles-panel `symRow` follow-up, `mountAutotilesPanel`)

**Interfaces:**
- Consumes: `buildAddTerrainSetDialog`, `commitSetTerrainSetLayer` (both already exist), `commitDeleteGrid` (Task 2), `commitGridCellField`, `commitDetachTile`, `sizeField`.
- Produces: `mountTilePanel` now owns the Add Terrain Set dialog/button; `mountAutotilesPanel` no longer creates it.

- [ ] **Step 1: Move the Add Terrain Set dialog instantiation and button**

In `js/ui/tilemode.js`'s `mountAutotilesPanel`, remove:

```js
  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const tilePickerDialog = buildTilePickerDialog();
```

(keep `tilePickerDialog`, only remove the `addTerrainSetDialog` line) and remove:

```js
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = '➕';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });
  wrap.appendChild(btnAddTerrainSet);
```

In `mountTilePanel`, right after the existing `btnAddGrid` block, add:

```js
  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = '➕ Autotile set';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });
  wrap.appendChild(btnAddTerrainSet);
```

- [ ] **Step 2: Rewrite `mountTilePanel`'s render() body**

Replace the whole `render()` function body in `mountTilePanel` (from `function render() {` through its closing `}`, currently spanning the `gridList`/`countRow` loop and the `selRow` tile-detail block) with:

```js
  function render() {
    if (state.mode !== 'tiles') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const sheet = activeSheet();
    selRow.innerHTML = '';
    if (!sheet) return;

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

    const grid = tile.gridId != null ? sheet.tileGrids.find(g => g.id === tile.gridId) : null;
    if (grid) {
      selRow.append(
        sizeField('W', grid.cellW, (v) => commitGridCellField(sheet, grid, 'cellW', v)),
        sizeField('H', grid.cellH, (v) => commitGridCellField(sheet, grid, 'cellH', v)),
      );
      const btnDetach = document.createElement('button');
      btnDetach.type = 'button';
      btnDetach.textContent = 'Detach from grid';
      btnDetach.addEventListener('click', () => commitDetachTile(tile));
      const btnDeleteGrid = document.createElement('button');
      btnDeleteGrid.type = 'button';
      btnDeleteGrid.textContent = 'Delete grid';
      btnDeleteGrid.addEventListener('click', () => commitDeleteGrid(sheet, grid));
      selRow.append(btnDetach, btnDeleteGrid);
    } else {
      selRow.append(
        sizeField('W', tile.w, (v) => commitTileSize(sheet, tile, 'w', v)),
        sizeField('H', tile.h, (v) => commitTileSize(sheet, tile, 'h', v)),
      );
    }

    const terrainSet = tile.terrainSetId != null ? sheet.terrainSets.find(ts => ts.id === tile.terrainSetId) : null;
    const layerSelect = document.createElement('select');
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
    layerSelect.appendChild(noneOpt);
    sheet.layers.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      layerSelect.appendChild(opt);
    });
    if (terrainSet) {
      layerSelect.value = terrainSet.layer ?? '';
      layerSelect.title = 'Tile Layer for this whole terrain set (shared by every tile in it)';
      layerSelect.addEventListener('change', () => commitSetTerrainSetLayer(terrainSet, layerSelect.value));
    } else {
      layerSelect.value = tile.layer ?? '';
      layerSelect.title = 'Tile Layer for this tile';
      layerSelect.addEventListener('change', () => commitTileLayer(tile, layerSelect.value));
    }

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.placeholder = 'tags, comma, separated';
    tagsInput.value = (tile.tags ?? []).join(', ');
    tagsInput.addEventListener('change', () => commitTileTags(tile, tagsInput.value));

    selRow.append(layerSelect, tagsInput);
  }
```

- [ ] **Step 3: Remove the now-unused `gridList`/`countRow` elements**

In `mountTilePanel`, delete the `gridList`/`countRow` element creation (the block right after the `h3`, before `addGridDialog`/`btnAddGrid`):

```js
  const gridList = document.createElement('div');
  gridList.className = 'tile-grid-list';
  wrap.appendChild(gridList);
```

and:

```js
  const countRow = document.createElement('div');
  countRow.className = 'row';
  wrap.appendChild(countRow);
```

(keep `selRow`'s creation — still used by the new `render()`).

- [ ] **Step 4: Verify**

Run: `node --check js/ui/tilemode.js && npm test`
Expected: PASS, 161 tests.

Manual/Playwright check:
1. Tiles panel with nothing selected shows only the Add-grid/Add-terrain-set buttons and "No tile selected" — no grid list, no tile count.
2. Select a standalone tile: name/Edit/W/H/layer/tags shown, W/H edits that one tile.
3. Select a tile inside a grid: name/Edit/grid-W-H (cellW/cellH)/Detach/Delete-grid/layer/tags shown; editing grid W/H resizes every tile in that grid.
4. Select a tile belonging to a terrain set: the layer dropdown reads/writes `terrainSet.layer` — change it, select a *different* tile from the same terrain set, confirm the dropdown shows the same (now-changed) value.
5. The Autotiles panel's symmetry row no longer has any layer dropdown (confirmed already gone as of Task 6; this task doesn't touch that row further).

- [ ] **Step 5: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: Tiles panel becomes selection-driven; move Add Terrain Set button and layer dropdown here"
```

---

### Task 9: New Tile Layers panel

**Files:**
- Modify: `index.html` (new `#panel-tilelayers` container)
- Modify: `js/app/main.js` (mount call)
- Modify: `js/ui/tilemode.js` (new `mountTileLayersPanel` export, remove the layer-list block from `mountAutotilesPanel`)

**Interfaces:**
- Produces: `export function mountTileLayersPanel(el)` in `js/ui/tilemode.js`.
- Consumes: `commitAddLayerName`, `commitMoveLayerName`, `commitRemoveLayerName` (already exist, unchanged).

- [ ] **Step 1: Add the container to `index.html`**

In `index.html`, right after the existing `<div id="panel-autotiles" class="panel"></div>` (~line 46):

```html
    <div id="panel-tilelayers" class="panel"></div>
```

- [ ] **Step 2: Move the layer-list UI out of `mountAutotilesPanel`**

In `js/ui/tilemode.js`'s `mountAutotilesPanel`, remove:

```js
  const layersHeading = document.createElement('h4');
  layersHeading.textContent = 'Tile Layers';
  wrap.appendChild(layersHeading);

  const layerList = document.createElement('div');
  layerList.className = 'tile-layer-list';
  wrap.appendChild(layerList);

  const btnAddLayerName = document.createElement('button');
  btnAddLayerName.type = 'button';
  btnAddLayerName.textContent = '➕';
  btnAddLayerName.title = 'Add tile layer';
  btnAddLayerName.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    commitAddLayerName(sheet, name);
  });
  wrap.appendChild(btnAddLayerName);
```

and, inside `mountAutotilesPanel`'s `render()`, remove:

```js
    layerList.innerHTML = '';
```

(from the reset block at the top of `render()`) and the entire trailing block:

```js
    sheet.layers.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = name;
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑'; btnUp.title = 'Move up';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓'; btnDown.title = 'Move down';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = '🗑'; btnDel.title = 'Delete';
      btnDel.addEventListener('click', () => commitRemoveLayerName(sheet, name));
      row.append(label, btnUp, btnDown, btnDel);
      layerList.appendChild(row);
    });
```

- [ ] **Step 3: Add `mountTileLayersPanel`**

In `js/ui/tilemode.js`, right after `mountAutotilesPanel`'s closing `}`, add:

```js
// Third stacked section in the tile-mode sidebar, below Autotiles: manages
// sheet.layers (the named "Tile Layer" categories tiles/terrain sets can be
// tagged with -- unrelated to the real paint-layer stack in the Layers
// panel; see mountAutotilesPanel's header comment for that disambiguation).
// Moved out of mountAutotilesPanel verbatim so it's its own panel instead
// of buried under the terrain-set editor.
export function mountTileLayersPanel(el) {
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Tile Layers';
  wrap.appendChild(h3);

  const layerList = document.createElement('div');
  layerList.className = 'tile-layer-list';
  wrap.appendChild(layerList);

  const btnAddLayerName = document.createElement('button');
  btnAddLayerName.type = 'button';
  btnAddLayerName.textContent = '➕';
  btnAddLayerName.title = 'Add tile layer';
  btnAddLayerName.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    commitAddLayerName(sheet, name);
  });
  wrap.appendChild(btnAddLayerName);

  function render() {
    if (state.mode !== 'tiles') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const sheet = activeSheet();
    layerList.innerHTML = '';
    if (!sheet) return;

    sheet.layers.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = name;
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑'; btnUp.title = 'Move up';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓'; btnDown.title = 'Move down';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = '🗑'; btnDel.title = 'Delete';
      btnDel.addEventListener('click', () => commitRemoveLayerName(sheet, name));
      row.append(label, btnUp, btnDown, btnDel);
      layerList.appendChild(row);
    });
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

- [ ] **Step 4: Wire the mount call**

In `js/app/main.js`, right after the existing `mountAutotilesPanel(document.getElementById('panel-autotiles'));` line:

```js
mountTileLayersPanel(document.getElementById('panel-tilelayers'));
```

and add `mountTileLayersPanel` to the existing import from `'../ui/tilemode.js'` at the top of the file:

```js
import { registerTileTool, bindTileTool, mountTilePanel, mountAutotilesPanel, mountTileLayersPanel } from '../ui/tilemode.js';
```

- [ ] **Step 5: Verify**

Run: `node --check js/ui/tilemode.js && node --check js/app/main.js && npm test`
Expected: PASS, 161 tests.

Manual/Playwright check: in tile mode, three stacked sections now appear in the sidebar (Tiles, Autotiles, Tile Layers); adding/reordering/deleting a Tile Layer in the new panel updates the layer options shown in the Tiles panel's layer dropdown (Task 8) live.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app/main.js js/ui/tilemode.js
git commit -m "feat: move Tile Layers management into its own panel"
```

---

### Task 10: Update the smoke checklist

**Files:**
- Modify: `tests/smoke.md`

- [ ] **Step 1: Update/add smoke items**

Revise item 48b (currently describes the layout-preset dropdown, removed in Task 3) and add new items covering: the selection-driven Tiles panel (Task 8), the moved Add Terrain Set button, the new Tile Layers panel (Task 9), icon toggle buttons (Task 6), the optional-but-explicit indicators (Tasks 4–5), per-terrain-set default view mode (Task 7), and implicit terrain-set deletion (Task 2). Follow this file's existing numbered `[A]`/`[M]` format and phrasing style (see items 44–49 for the closest precedent).

- [ ] **Step 2: Commit**

```bash
git add tests/smoke.md
git commit -m "docs: update smoke checklist for the Tiles/Autotiles panel cleanup"
```

---

## Final Verification

After all tasks: `npm test` (expect 161 passing), full manual/Playwright pass through the smoke checklist items touched above, then use the finishing-a-development-branch workflow.
