# Autotile Panel UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the flat Tiles panel into a Tiles panel and an Autotiles panel, make the blob-47 editor self-explanatory (live thumbnails, mandatory/optional classification, a redesigned tile-picker dialog), add a 7×7 view mode/layout preset, disambiguate "Tile Layers" from the app's real Layers panel, and prefer icons over text on the buttons this round touches.

**Architecture:** Pure UI/data-shape rework on top of Phase B's existing terrain-set/blob-47 model — one new field (`terrainSet.layer`), two newly-exported pure helpers in `js/core/blob47.js` (`enabledGroup`, `applyDescriptor`) plus one new pure function (`classifySlots`), and a split of `js/ui/tilemode.js`'s single `mountTilePanel` into `mountTilePanel` (grids + tile detail) and a new `mountAutotilesPanel` (terrain sets, view modes, Tile Layers). No new modules — all DOM work stays in `tilemode.js`, following the file's existing patterns (mount/render/schedule, `commitX` command wrappers, private flat-canvas cache duplicated per-module).

**Tech Stack:** Vanilla JS (ES modules, no framework/build step), `node --test` for unit tests, manual/Playwright smoke checklist (`tests/smoke.md`) for DOM-only changes.

## Global Constraints

- No new dependencies, no build step — plain ES modules loaded directly by `index.html`.
- Follow the existing icon convention exactly: emoji `textContent` + `title` attribute for the tooltip (see `panels.js`'s Layers panel: `➕`/`📁`/`🗑`/`⬇`).
- `terrainSet.layer` is independent metadata on the *set* — it must never bulk-overwrite a member tile's own `.layer` field.
- "View mode" (Staircase/6×8/7×7/16-tile-only) is purely cosmetic and non-persisted — it must never write to `terrainSet.slots` or any saved preset.
- CSS: `.tile-layer-list` (this round's Tile Layers list) and `.layer-list.layer-tree` (`panels.js`'s real Layers panel) must remain fully separate classes with independent rules — no shared class name.
- No automated tests for DOM-only construction (panel split, thumbnails, picker dialog markup, icon glyphs) — verify via `node --check <file>`, a full `npm test` regression run, and the `tests/smoke.md` checklist items added in Task 10. This matches the codebase's existing convention of not unit-testing `tilemode.js`'s DOM construction.
- Baseline: `npm test` currently reports `150 pass, 0 fail`. Every task must leave this at 150+N pass, 0 fail (N = new tests added by that task).

---

### Task 1: `classifySlots` — mandatory/optional orbit classification

**Files:**
- Modify: `js/core/blob47.js:126` (export `applyDescriptor`), `js/core/blob47.js:141` (export `enabledGroup`), insert new `classifySlots` after `enabledGroup`
- Test: `tests/blob47.test.mjs` (append)

**Interfaces:**
- Consumes: existing private `blobIndexToMask`, `maskToBlobIndex`, `SIXTEEN_TILE_INDICES` (already exported), and the two helpers this task exports.
- Produces: `export function classifySlots(symmetry): Map<number, { mandatory: boolean, orbitRepresentative: number }>` — keyed by blobIndex (0-46). Consumed by Task 6 (`renderTerrainSetEditor`) and Task 8 (tile-picker dialog header).

- [ ] **Step 1: Export the two existing private helpers (no behavior change)**

In `js/core/blob47.js`, change line 126 from:
```js
function applyDescriptor(mask, { rotate, flipH }) {
```
to:
```js
export function applyDescriptor(mask, { rotate, flipH }) {
```
And change line 141 from:
```js
function enabledGroup(symmetry) {
```
to:
```js
export function enabledGroup(symmetry) {
```

- [ ] **Step 2: Write the failing tests**

Append to `tests/blob47.test.mjs`. First, extend the import at the top of the file from:
```js
import {
  maskToBlobIndex, blobIndexToMask, terrainPreviewCells,
  SIXTEEN_TILE_INDICES, sixteenTileBlobIndex, resolveTerrainSlot,
} from '../js/core/blob47.js';
```
to:
```js
import {
  maskToBlobIndex, blobIndexToMask, terrainPreviewCells,
  SIXTEEN_TILE_INDICES, sixteenTileBlobIndex, resolveTerrainSlot, classifySlots,
} from '../js/core/blob47.js';
```
Then append these tests (values below were computed by running the real 47-index table — they are exact, not illustrative):
```js
test('classifySlots: symmetry off -> every index is its own singleton orbit, all mandatory', () => {
  const classification = classifySlots({ flip: false, rotate: false });
  assert.equal(classification.size, 47);
  for (let i = 0; i < 47; i++) {
    const c = classification.get(i);
    assert.equal(c.mandatory, true);
    assert.equal(c.orbitRepresentative, i);
  }
});

test('classifySlots: flip-only pairs mirror-symmetric indices, one mandatory per pair', () => {
  const classification = classifySlots({ flip: true, rotate: false });
  assert.equal([...classification.values()].filter(c => c.mandatory).length, 20);
  // real orbit: blob indices 1 and 5 are E<->W-style mirror images of each other.
  const c1 = classification.get(1);
  const c5 = classification.get(5);
  assert.equal(c1.orbitRepresentative, 1);
  assert.equal(c5.orbitRepresentative, 1);
  assert.equal(c1.mandatory, true);
  assert.equal(c5.mandatory, false);
});

test('classifySlots: rotate-only groups the 4-way rotational orbit of index 1, one mandatory per orbit', () => {
  const classification = classifySlots({ flip: false, rotate: true });
  assert.equal([...classification.values()].filter(c => c.mandatory).length, 15);
  // real orbit: blob indices 1, 2, 5, 13 are 90-degree rotations of each other.
  for (const idx of [1, 2, 5, 13]) assert.equal(classification.get(idx).orbitRepresentative, 1);
  assert.equal(classification.get(1).mandatory, true);
  for (const idx of [2, 5, 13]) assert.equal(classification.get(idx).mandatory, false);
});

test('classifySlots: both flip+rotate enabled composes into larger orbits, one mandatory per orbit', () => {
  const classification = classifySlots({ flip: true, rotate: true });
  assert.equal([...classification.values()].filter(c => c.mandatory).length, 14);
  // real 8-element orbit under the full dihedral group.
  const orbit = [9, 11, 17, 23, 27, 28, 35, 37];
  for (const idx of orbit) assert.equal(classification.get(idx).orbitRepresentative, 9);
  assert.equal(classification.get(9).mandatory, true);
  for (const idx of orbit.filter(i => i !== 9)) assert.equal(classification.get(idx).mandatory, false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `classifySlots is not a function` (or similar import error), since it doesn't exist yet.

- [ ] **Step 4: Implement `classifySlots`**

In `js/core/blob47.js`, insert this new function immediately after the `enabledGroup` function (i.e. after its closing `}` at line 149, before the `// ---------------------------------------------------------------- resolution` comment):
```js
// For each of the 47 blob indices, compute its orbit under the terrain
// set's ENABLED symmetry transforms (flip/rotate) and pick one
// representative per orbit -- preferring a 16-tile-subset member when the
// orbit contains one, else the lowest blobIndex. The representative is
// "mandatory" (draw a real tile for it); every other orbit member is
// "optional" (comes free via resolveTerrainSlot's symmetry fallback once
// the representative is assigned). With symmetry fully off, every orbit is
// a singleton, so all 47 are mandatory.
export function classifySlots(symmetry) {
  const group = enabledGroup(symmetry);
  const classification = new Map();
  const visited = new Set();
  for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
    if (visited.has(blobIndex)) continue;
    const mask = blobIndexToMask[blobIndex];
    const orbit = new Set(group.map(t => maskToBlobIndex[applyDescriptor(mask, t)]));
    const sorted = [...orbit].sort((a, b) => a - b);
    const representative = sorted.find(i => SIXTEEN_TILE_INDICES.has(i)) ?? sorted[0];
    for (const idx of orbit) {
      visited.add(idx);
      classification.set(idx, { mandatory: idx === representative, orbitRepresentative: representative });
    }
  }
  return classification;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: `154 pass, 0 fail` (150 baseline + 4 new).

- [ ] **Step 6: Commit**

```bash
git add js/core/blob47.js tests/blob47.test.mjs
git commit -m "feat: export symmetry helpers and add classifySlots to blob47"
```

---

### Task 2: `terrainSet.layer` field

**Files:**
- Modify: `js/core/terrainsets.js:8`
- Test: `tests/terrainsets.test.mjs:18-24`

**Interfaces:**
- Produces: `createTerrainSet(...)` now returns an object with `layer: null` alongside its existing `id, name, tileW, tileH, slots, symmetry`. Consumed by Task 3 (`exports.js`) and Task 9 (`renderTerrainSetEditor`'s layer `<select>`, `commitSetTerrainSetLayer`).

- [ ] **Step 1: Write the failing test**

In `tests/terrainsets.test.mjs`, change the existing test at line 18:
```js
test('createTerrainSet pushes a set with empty slots and symmetry off', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  assert.equal(s.terrainSets.length, 1);
  assert.deepEqual(ts.slots, {});
  assert.deepEqual(ts.symmetry, { flip: false, rotate: false });
});
```
to add one assertion:
```js
test('createTerrainSet pushes a set with empty slots, symmetry off, and no layer', () => {
  const s = tileSheet();
  const ts = createTerrainSet(s, { name: 'Grass', tileW: 16, tileH: 16 });
  assert.equal(s.terrainSets.length, 1);
  assert.deepEqual(ts.slots, {});
  assert.deepEqual(ts.symmetry, { flip: false, rotate: false });
  assert.equal(ts.layer, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `AssertionError` on `assert.equal(ts.layer, null)` (`ts.layer` is `undefined`).

- [ ] **Step 3: Implement**

In `js/core/terrainsets.js`, change line 8 from:
```js
export function createTerrainSet(sheet, { name, tileW, tileH }) {
  const ts = { id: newId('ts'), name, tileW, tileH, slots: {}, symmetry: { flip: false, rotate: false } };
```
to:
```js
export function createTerrainSet(sheet, { name, tileW, tileH }) {
  const ts = { id: newId('ts'), name, tileW, tileH, slots: {}, symmetry: { flip: false, rotate: false }, layer: null };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `154 pass, 0 fail` (still 154 — this task edits an existing test rather than adding one; Task 1 already brought the count to 154).

- [ ] **Step 5: Commit**

```bash
git add js/core/terrainsets.js tests/terrainsets.test.mjs
git commit -m "feat: add layer field to terrain sets"
```

---

### Task 3: Export `terrainSet.layer` in Tiles JSON

**Files:**
- Modify: `js/app/exports.js:60`
- Test: `tests/exports.test.mjs` (append)

**Interfaces:**
- Consumes: `terrainSet.layer` from Task 2.
- Produces: each entry of `buildTilesJson(sheet).terrainSets[]` gains an optional `layer` string key (omitted when `null`).

- [ ] **Step 1: Write the failing test**

Append to `tests/exports.test.mjs`:
```js
test('buildTilesJson: terrain set layer is included when set, omitted when null', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: undefined, gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined });
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, sheet.tiles[0]);

  let json = buildTilesJson(sheet);
  assert.equal(json.terrainSets[0].layer, undefined);

  ts.layer = 'Ground';
  json = buildTilesJson(sheet);
  assert.equal(json.terrainSets[0].layer, 'Ground');
});
```
(`createProject`, `createSheet`, `createTerrainSet`, `assignSlot`, `buildTilesJson` are all already imported at the top of this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `assert.equal(json.terrainSets[0].layer, 'Ground')` fails (`undefined !== 'Ground'`).

- [ ] **Step 3: Implement**

In `js/app/exports.js`, change line 60 from:
```js
      return { name: ts.name, tileW: ts.tileW, tileH: ts.tileH, slots };
```
to:
```js
      return { name: ts.name, tileW: ts.tileW, tileH: ts.tileH, slots,
        ...(ts.layer != null ? { layer: ts.layer } : {}) };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `155 pass, 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add js/app/exports.js tests/exports.test.mjs
git commit -m "feat: export terrain set layer in Tiles JSON"
```

---

### Task 4: Split the panel — `mountTilePanel` + new `mountAutotilesPanel`

**Files:**
- Modify: `index.html:45`, `js/app/main.js:10,432`, `js/ui/tilemode.js:1094-1293` (replace)

**Interfaces:**
- Consumes: nothing new — this is a mechanical relocation of existing code within `tilemode.js`.
- Produces: `export function mountAutotilesPanel(el)`, mounted into a new `#panel-autotiles` div. `mountTilePanel(el)` keeps only the grid list and tile-detail block. Both are independently gated on `state.mode === 'tiles'`. `renderTerrainSetEditor`, `buildAddTerrainSetDialog`, `buildTilePickerDialog`, `renderLayoutPresetRow` (lines 894-1071, unchanged in this task) are now called from `mountAutotilesPanel` instead of `mountTilePanel`.

- [ ] **Step 1: Add the new panel div to `index.html`**

Change line 45 from:
```html
    <div id="panel-context" class="panel"></div>
```
to:
```html
    <div id="panel-context" class="panel"></div>
    <div id="panel-autotiles" class="panel"></div>
```

- [ ] **Step 2: Wire the new mount call in `main.js`**

Change line 10 from:
```js
import { registerTileTool, bindTileTool, mountTilePanel } from '../ui/tilemode.js';
```
to:
```js
import { registerTileTool, bindTileTool, mountTilePanel, mountAutotilesPanel } from '../ui/tilemode.js';
```
Change line 432 from:
```js
mountTilePanel(document.getElementById('panel-context'));
```
to:
```js
mountTilePanel(document.getElementById('panel-context'));
mountAutotilesPanel(document.getElementById('panel-autotiles'));
```

- [ ] **Step 3: Replace `mountTilePanel` (lines 1094-1293) with the trimmed version**

In `js/ui/tilemode.js`, replace the entire `export function mountTilePanel(el) { ... }` (lines 1094-1293) with:
```js
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
  btnAddGrid.textContent = '➕';
  btnAddGrid.title = 'Add grid';
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
        sizeField('W', tile.w, (v) => commitTileSize(sheet, tile, 'w', v)),
        sizeField('H', tile.h, (v) => commitTileSize(sheet, tile, 'h', v)),
      );
    }

    const layerSelect = document.createElement('select');
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
    layerSelect.appendChild(noneOpt);
    sheet.layers.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      layerSelect.appendChild(opt);
    });
    layerSelect.value = tile.layer ?? '';
    layerSelect.addEventListener('change', () => commitTileLayer(tile, layerSelect.value));

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.placeholder = 'tags, comma, separated';
    tagsInput.value = (tile.tags ?? []).join(', ');
    tagsInput.addEventListener('change', () => commitTileTags(tile, tagsInput.value));

    selRow.append(layerSelect, tagsInput);
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

// Shares no DOM with mountTilePanel — mounts into its own #panel-autotiles
// sibling. Owns terrain sets, the terrain-set slot editor, and the Tile
// Layers manager (props/terrain/walls categorization) -- kept separate from
// mountTilePanel because it's the more complex consumer of sheet.layers,
// even though mountTilePanel's own tile-detail layer <select> reads the
// same array.
export function mountAutotilesPanel(el) {
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Autotiles';
  wrap.appendChild(h3);

  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const tilePickerDialog = buildTilePickerDialog();

  const terrainSetList = document.createElement('div');
  terrainSetList.className = 'terrain-set-list';
  wrap.appendChild(terrainSetList);

  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = '➕';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });
  wrap.appendChild(btnAddTerrainSet);

  const terrainSetEditor = document.createElement('div');
  terrainSetEditor.className = 'terrain-set-editor';
  wrap.appendChild(terrainSetEditor);

  const layerList = document.createElement('div');
  layerList.className = 'layer-list';
  wrap.appendChild(layerList);

  const btnAddLayerName = document.createElement('button');
  btnAddLayerName.type = 'button';
  btnAddLayerName.textContent = 'Add Layer Name…';
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
    terrainSetList.innerHTML = '';
    terrainSetEditor.innerHTML = '';
    layerList.innerHTML = '';
    if (!sheet) return;

    for (const ts of sheet.terrainSets) {
      const row = document.createElement('div');
      row.className = 'row terrain-set-row';
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.textContent = `${ts.name} (${ts.tileW}×${ts.tileH})`;
      nameBtn.addEventListener('click', () => {
        state.selectedTerrainSetId = state.selectedTerrainSetId === ts.id ? null : ts.id;
        schedule();
      });
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.textContent = '🗑';
      btnDel.title = 'Delete terrain set';
      btnDel.addEventListener('click', () => {
        commitDeleteTerrainSet(sheet, ts.id);
        if (state.selectedTerrainSetId === ts.id) state.selectedTerrainSetId = null;
      });
      row.append(nameBtn, btnDel);
      terrainSetList.appendChild(row);
    }

    const selectedTerrainSet = sheet.terrainSets.find(ts => ts.id === state.selectedTerrainSetId);
    if (selectedTerrainSet) {
      renderTerrainSetEditor(terrainSetEditor, sheet, selectedTerrainSet, tilePickerDialog);
    }

    sheet.layers.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = name;
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = 'Delete';
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

Note: `layerList`/`btnAddLayerName` above keep their *original* class name (`layer-list`) and copy (`Add Layer Name…`) verbatim — Task 9 does the rename/icon/CSS-decoupling. This task is a pure relocation plus the three icon swaps explicitly listed in the interface (Add Grid, Add Terrain Set, Delete terrain set) since it's already rewriting those exact lines.

- [ ] **Step 4: Verify no syntax errors and no regressions**

Run: `node --check js/ui/tilemode.js`
Expected: no output (valid syntax).

Run: `npm test`
Expected: `155 pass, 0 fail` (unchanged — no test imports `tilemode.js`).

- [ ] **Step 5: Manual smoke check**

Start a static server (e.g. `npx http-server -p 8080` or whatever this repo's existing dev-serve command is) and open `http://localhost:8080/?autotest`. Switch to the Tile Sheets tab: confirm the sidebar now shows two separate panel boxes, "Tiles" (grid list, Add Grid `➕`, tile detail) and "Autotiles" (terrain set list, Add Terrain Set `➕`, terrain-set editor, Tile Layers list still reading "Add Layer Name…" for now). Confirm the browser console has zero errors.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app/main.js js/ui/tilemode.js
git commit -m "feat: split tile panel into separate Tiles and Autotiles panels"
```

---

### Task 5: View modes + real 8×6 / 7×7 layout presets

**Files:**
- Modify: `js/ui/tilemode.js` (import list, `BUILTIN_LAYOUT_PRESETS` array, new helpers near `blobStaircaseGroups`, `renderLayoutPresetRow`, `renderTerrainSetEditor`)

**Interfaces:**
- Consumes: `blobIndexToMask`, `SIXTEEN_TILE_INDICES` (already imported), `maskToBlobIndex` (newly imported this task).
- Produces: a module-level `terrainViewMode` variable and `slotGroupsForViewMode(mode)` helper, consumed by `renderTerrainSetEditor`'s slot-rendering loop (this task and Task 6/7/8, which all edit that same loop in later tasks).

**Correction from the committed spec:** the spec described the existing 6×8 preset as a "deterministic ascending-index ordering, not a byte-for-byte reproduction of any external tool's template" and proposed the new 7×7 preset the same way. The user has since supplied the actual reference template's raw neighbor-bitmask layout for both grid shapes (verified below against this codebase's own `maskToBlobIndex`/`NEIGHBOR_BITS` — every one of the 47 canonical blob indices appears exactly once in each template, with raw byte `255` (full 8-neighbor surround) intentionally repeated as a duplicate cell — 2 duplicates in the 8×6 template, 3 in the 7×7 — which is a known convention in real blob-47 template images, not a data error). This task therefore replaces the ascending 6×8 preset with a corrected **8×6** (cols/rows swapped) preset using the real mapping, and gives the new 7×7 preset the real (non-ascending) mapping too, instead of ascending-index placeholders. This preset data is hardcoded and never serialized to project files, so there is no migration concern — only the in-session dropdown label/shape changes.

- [ ] **Step 1: Import `maskToBlobIndex` and replace `BUILTIN_LAYOUT_PRESETS` with the real reference templates**

In `js/ui/tilemode.js`, change the blob47 import (line 25) from:
```js
import {
  NEIGHBOR_BITS, blobIndexToMask, SIXTEEN_TILE_INDICES, resolveTerrainSlot,
} from '../core/blob47.js';
```
to:
```js
import {
  NEIGHBOR_BITS, blobIndexToMask, maskToBlobIndex, SIXTEEN_TILE_INDICES, resolveTerrainSlot,
} from '../core/blob47.js';
```

Then change `BUILTIN_LAYOUT_PRESETS` (lines 55-64) from:
```js
const BUILTIN_LAYOUT_PRESETS = [
  {
    name: 'Blob-47 (6×8, ascending)', cols: 6, rows: 8,
    cells: Array.from({ length: 47 }, (_, i) => ({ col: i % 6, row: Math.floor(i / 6), blobIndex: i })),
  },
  {
    name: '16-tile (4×4, ascending)', cols: 4, rows: 4,
    cells: Array.from({ length: 16 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), blobIndex: [...SIXTEEN_TILE_INDICES][i] })),
  },
];
```
to:
```js
// Real blob-47 reference templates (raw neighbor bitmasks, top-left to
// bottom-right, using this module's own NEIGHBOR_BITS weights: N=1, NE=2,
// E=4, SE=8, S=16, SW=32, W=64, NW=128). Each raw byte is resolved through
// maskToBlobIndex to its canonical blobIndex -- raw byte 255 (full 8-
// neighbor surround) intentionally repeats (both templates' known
// duplicate-cell convention); every other one of the 47 canonical indices
// appears exactly once per template.
const BLOB47_8X6_RAW = [
  [0, 4, 92, 112, 28, 124, 116, 64],
  [20, 84, 87, 221, 127, 255, 245, 80],
  [29, 117, 85, 95, 247, 215, 209, 1],
  [23, 213, 81, 31, 253, 125, 113, 16],
  [21, 69, 93, 119, 223, 255, 241, 17],
  [5, 68, 71, 193, 7, 199, 197, 65],
];
const BLOB47_7X7_RAW = [
  [0, 4, 84, 92, 124, 116, 80],
  [16, 28, 117, 95, 255, 253, 113],
  [21, 87, 221, 127, 255, 247, 209],
  [29, 125, 119, 199, 215, 213, 81],
  [31, 255, 241, 20, 65, 17, 1],
  [23, 223, 245, 85, 68, 93, 112],
  [5, 71, 197, 69, 64, 7, 193],
];
function cellsFromRawGrid(rawGrid) {
  const cells = [];
  rawGrid.forEach((rowVals, row) => rowVals.forEach((raw, col) => {
    cells.push({ col, row, blobIndex: maskToBlobIndex[raw] });
  }));
  return cells;
}

const BUILTIN_LAYOUT_PRESETS = [
  {
    name: 'Blob-47 (8×6)', cols: 8, rows: 6,
    cells: cellsFromRawGrid(BLOB47_8X6_RAW),
  },
  {
    name: 'Blob-47 (7×7)', cols: 7, rows: 7,
    cells: cellsFromRawGrid(BLOB47_7X7_RAW),
  },
  {
    name: '16-tile (4×4, ascending)', cols: 4, rows: 4,
    cells: Array.from({ length: 16 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), blobIndex: [...SIXTEEN_TILE_INDICES][i] })),
  },
];
```

- [ ] **Step 1b: Verify the reference templates cover all 47 blob indices exactly once (plus the known 255 duplicate)**

Run this one-off check (not a permanent test — the codebase doesn't unit-test `tilemode.js`'s private data, and this constant is verified once at authoring time):
```bash
node -e "
import('./js/core/blob47.js').then(({ maskToBlobIndex }) => {
  const grids = {
    '8x6': [[0,4,92,112,28,124,116,64],[20,84,87,221,127,255,245,80],[29,117,85,95,247,215,209,1],[23,213,81,31,253,125,113,16],[21,69,93,119,223,255,241,17],[5,68,71,193,7,199,197,65]],
    '7x7': [[0,4,84,92,124,116,80],[16,28,117,95,255,253,113],[21,87,221,127,255,247,209],[29,125,119,199,215,213,81],[31,255,241,20,65,17,1],[23,223,245,85,68,93,112],[5,71,197,69,64,7,193]],
  };
  for (const [name, grid] of Object.entries(grids)) {
    const indices = grid.flat().map(raw => maskToBlobIndex[raw]);
    const distinct = new Set(indices);
    const missing = Array.from({length:47}, (_,i)=>i).filter(i => !distinct.has(i));
    console.log(name, 'cells:', indices.length, 'distinct blobIndex:', distinct.size, 'missing:', missing);
  }
});
"
```
Expected: both lines show `distinct blobIndex: 47` and `missing: []` (48/49 cells covering all 47 indices, with the documented 255 duplicate accounting for the extra cell(s)).

- [ ] **Step 2: Add the view-mode state and slot-grouping helper**

Immediately after `blobStaircaseGroups()` (after its closing `}` at line 42, before `describeMask`), insert:
```js
// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid6x8' | 'grid7x7' | 'sixteen'.
let terrainViewMode = 'staircase';

function ascendingIndices() {
  return Array.from({ length: blobIndexToMask.length }, (_, i) => i);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function slotGroupsForViewMode(mode) {
  if (mode === 'grid6x8') return chunk(ascendingIndices(), 6);
  if (mode === 'grid7x7') return chunk(ascendingIndices(), 7);
  if (mode === 'sixteen') return [[...SIXTEEN_TILE_INDICES].sort((a, b) => a - b)];
  return blobStaircaseGroups();
}
```

- [ ] **Step 3: Icon-ify Import/Save buttons in `renderLayoutPresetRow`**

In `renderLayoutPresetRow` (around line 979), change:
```js
  const btnImport = document.createElement('button');
  btnImport.type = 'button';
  btnImport.textContent = 'Import from layout…';
```
to:
```js
  const btnImport = document.createElement('button');
  btnImport.type = 'button';
  btnImport.textContent = '⬇';
  btnImport.title = 'Import from layout';
```
And change:
```js
  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.textContent = 'Save current as preset…';
```
to:
```js
  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.textContent = '💾';
  btnSave.title = 'Save current as preset';
```

- [ ] **Step 4: Add the view-mode `<select>` and wire it into the slot loop in `renderTerrainSetEditor`**

In `renderTerrainSetEditor` (around line 1015), after the existing `symRow` block (ends at `container.appendChild(symRow);`, line 1028) and before the `for (const group of blobStaircaseGroups())` loop, insert:
```js
  const viewModeRow = document.createElement('div');
  viewModeRow.className = 'row';
  const viewModeLabel = document.createElement('label');
  viewModeLabel.appendChild(document.createTextNode('View '));
  const viewModeSelect = document.createElement('select');
  [
    ['staircase', 'Staircase'],
    ['grid6x8', 'Grid 6×8'],
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
```
Then change the slot loop from:
```js
  for (const group of blobStaircaseGroups()) {
```
to:
```js
  for (const group of slotGroupsForViewMode(terrainViewMode)) {
```

- [ ] **Step 5: Verify no syntax errors and no regressions**

Run: `node --check js/ui/tilemode.js`
Expected: no output.

Run: `npm test`
Expected: `155 pass, 0 fail`.

- [ ] **Step 6: Manual smoke check**

At `http://localhost:8080/?autotest`, open a terrain set's editor. Confirm a "View" dropdown appears above the slot grid with 4 options; switching to "Grid 7×7" rearranges the same 47 slots into rows of 7 (last row has 5, this is the cosmetic view mode, unrelated to the real 7×7 layout preset below); switching to "16-tile only" shows a single row of 16 slots; switching back to "Staircase" restores the original grouping. Confirm the layout-preset dropdown (Import/Save row) now lists "Blob-47 (8×6) (8×6)" (renamed/reshaped from the old "6×8, ascending") and "Blob-47 (7×7) (7×7)", and the Import/Save buttons show `⬇`/`💾` icons with hover tooltips. If a matching 8×6 or 7×7 tile grid with real tile art is available, importing either preset should place visually-continuous terrain tiles into their slots (not an arbitrary ascending jumble) — this is the concrete signal that the real reference mapping was wired correctly. Zero console errors.

- [ ] **Step 7: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: add terrain-set view modes and real 8x6/7x7 layout presets"
```

---

### Task 6: Mandatory vs optional slot classification (wired into the UI)

**Files:**
- Modify: `js/ui/tilemode.js` (import list, `renderTerrainSetEditor`), `css/app.css:116-117`

**Interfaces:**
- Consumes: `classifySlots` from Task 1.
- Produces: each `.terrain-slot` cell carries `.mandatory` or `.optional` (renamed from `.core`/`.derived`), computed from the terrain set's current symmetry settings, independent of current fill state.

- [ ] **Step 1: Import `classifySlots`**

In `js/ui/tilemode.js`, change the blob47 import (lines 24-26) from:
```js
import {
  NEIGHBOR_BITS, blobIndexToMask, SIXTEEN_TILE_INDICES, resolveTerrainSlot,
} from '../core/blob47.js';
```
to:
```js
import {
  NEIGHBOR_BITS, blobIndexToMask, SIXTEEN_TILE_INDICES, resolveTerrainSlot, classifySlots,
} from '../core/blob47.js';
```

- [ ] **Step 2: Compute classification once per render and apply it to each cell**

In `renderTerrainSetEditor`, immediately before the `for (const group of slotGroupsForViewMode(terrainViewMode)) {` loop, insert:
```js
  const classification = classifySlots(terrainSet.symmetry);
```
Then inside the loop, change:
```js
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const isExplicit = terrainSet.slots[blobIndex] != null;
      const cell = document.createElement('div');
      cell.className = 'terrain-slot';
      if (SIXTEEN_TILE_INDICES.has(blobIndex)) cell.classList.add('core');
      if (resolved && !isExplicit) cell.classList.add('derived');

      const mask = blobIndexToMask[blobIndex];
      let title = describeMask(mask);
      if (resolved && !isExplicit) title += ` (derived: flipH=${resolved.flipH}, rotate=${resolved.rotate})`;
      cell.title = title;
```
to:
```js
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const isExplicit = terrainSet.slots[blobIndex] != null;
      const classInfo = classification.get(blobIndex);
      const cell = document.createElement('div');
      cell.className = 'terrain-slot';
      cell.classList.add(classInfo.mandatory ? 'mandatory' : 'optional');

      const mask = blobIndexToMask[blobIndex];
      let title = `${describeMask(mask)} — ${classInfo.mandatory ? 'mandatory' : 'optional'}`;
      if (resolved && !isExplicit) title += ` (derived: flipH=${resolved.flipH}, rotate=${resolved.rotate})`;
      cell.title = title;
```

- [ ] **Step 3: Rename the CSS classes**

In `css/app.css`, change lines 116-117 from:
```css
.terrain-slot.core { border-color: #4f8cff; border-width: 2px; }
.terrain-slot.derived { border-style: dashed; }
```
to:
```css
.terrain-slot.mandatory { border-color: #4f8cff; border-width: 2px; }
.terrain-slot.optional { border-style: dashed; }
```

- [ ] **Step 4: Verify no syntax errors and no regressions**

Run: `node --check js/ui/tilemode.js`
Expected: no output.

Run: `npm test`
Expected: `155 pass, 0 fail`.

- [ ] **Step 5: Manual smoke check**

At `http://localhost:8080/?autotest`, open a terrain set with both "Allow flip" and "Allow rotation" off: every slot shows the solid mandatory border (47 of them). Toggle "Allow rotation" on: several slots switch to the dashed optional border immediately, regardless of whether they currently have a tile assigned. Hovering a slot shows "mandatory"/"optional" in its tooltip. Zero console errors.

- [ ] **Step 6: Commit**

```bash
git add js/ui/tilemode.js css/app.css
git commit -m "feat: classify terrain slots as mandatory/optional from symmetry"
```

---

### Task 7: Live tile thumbnails + flip/rotate icon overlay

**Files:**
- Modify: `js/ui/tilemode.js` (import list, new private helpers, `renderTerrainSetEditor`, `mountAutotilesPanel` event wiring), `css/app.css:115,118`

**Interfaces:**
- Consumes: `flattenSheet` from `js/core/model.js` (not yet imported in `tilemode.js`).
- Produces: `tileThumbnailURL(sheet, tile, { flipH, flipV, rotate }): string` (private to `tilemode.js`), consumed by this task's slot cells and by Task 8's tile-picker dialog.

- [ ] **Step 1: Import `flattenSheet`**

In `js/ui/tilemode.js`, change line 19 from:
```js
import { scrubTileReferences } from '../core/model.js';
```
to:
```js
import { scrubTileReferences, flattenSheet } from '../core/model.js';
```

- [ ] **Step 2: Add the flat-canvas cache and thumbnail helper**

Insert this new private section immediately before `function renderLayoutPresetRow(container, sheet, terrainSet) {` (line 958):
```js
// ---------------------------------------------------------------- thumbnails

// Flattened-sheet scratch-canvas cache, mirroring tileeditor.js's
// getFlatCanvas (this codebase duplicates the pattern per-module rather
// than sharing it -- see tileeditor.js:166's comment). Invalidated
// explicitly by mountAutotilesPanel on 'pixels'/'project'/'history'.
let flatSheetRef = null;
let flatBitmap = null;
let flatDirty = true;
function invalidateFlat() { flatDirty = true; }
function getFlatBitmap(sheet) {
  if (flatDirty || flatSheetRef !== sheet || !flatBitmap) {
    flatBitmap = flattenSheet(sheet, state.floating);
    flatSheetRef = sheet;
    flatDirty = false;
  }
  return flatBitmap;
}
let flatCanvas = null;
let flatCanvasSrc = null;
function getFlatCanvas(sheet) {
  const bmp = getFlatBitmap(sheet);
  if (flatCanvasSrc !== bmp) {
    if (!flatCanvas || flatCanvas.width !== bmp.width || flatCanvas.height !== bmp.height) {
      flatCanvas = document.createElement('canvas');
      flatCanvas.width = bmp.width;
      flatCanvas.height = bmp.height;
    }
    const c = flatCanvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
    flatCanvasSrc = bmp;
  }
  return flatCanvas;
}

// Crops tile.w x tile.h from the flattened sheet, applies flipH/flipV/rotate,
// and returns a data URL. Cached by tile id + transform key so redraws
// within the same paint cycle don't re-crop identical thumbnails.
const thumbnailCache = new Map();
function tileThumbnailURL(sheet, tile, { flipH = false, flipV = false, rotate = 0 } = {}) {
  const flat = getFlatCanvas(sheet);
  const key = `${tile.id}|${flipH}|${flipV}|${rotate}`;
  const cached = thumbnailCache.get(key);
  if (cached && cached.src === flat) return cached.url;

  const scratch = document.createElement('canvas');
  scratch.width = tile.w;
  scratch.height = tile.h;
  const ctx = scratch.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.translate(flipH ? tile.w : 0, flipV ? tile.h : 0);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  if (rotate) {
    ctx.translate(tile.w / 2, tile.h / 2);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.translate(-tile.w / 2, -tile.h / 2);
  }
  ctx.drawImage(flat, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
  ctx.restore();
  const url = scratch.toDataURL();
  thumbnailCache.set(key, { url, src: flat });
  return url;
}
```

- [ ] **Step 3: Use the thumbnail + icon overlay in `renderTerrainSetEditor`**

Change:
```js
      if (resolved) {
        const tile = sheet.tiles.find(t => t.id === resolved.tileId);
        if (tile) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = (resolved.flipH || resolved.flipV) ? 'F' : (resolved.rotate ? `${resolved.rotate}°` : '');
          cell.appendChild(badge);
        }
      }
```
to:
```js
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
        }
      }
```

- [ ] **Step 4: Invalidate the flat-canvas cache on pixel/project/history changes in `mountAutotilesPanel`**

Change the event wiring at the bottom of `mountAutotilesPanel`:
```js
  on('project', schedule);
  on('history', schedule);
  on('view', schedule);
  on('selection', schedule);
  render();
}
```
to:
```js
  on('project', () => { invalidateFlat(); schedule(); });
  on('history', () => { invalidateFlat(); schedule(); });
  on('pixels', () => { invalidateFlat(); schedule(); });
  on('view', schedule);
  on('selection', schedule);
  render();
}
```

- [ ] **Step 5: CSS — remove the `background-size: cover` special-case dependency (already present) and confirm badge positioning still applies**

No CSS change is required: `.terrain-slot` already has `background-size: cover` (line 115) from Phase B, and `.terrain-slot .badge` (line 118) still applies since the badge is still an appended `<span>`. Skip this step if `css/app.css:115,118` already read exactly as shown — confirm with:

Run: `grep -n "terrain-slot" css/app.css` (or open the file) and verify lines 115 and 118 are unchanged from before this task.

- [ ] **Step 6: Verify no syntax errors and no regressions**

Run: `node --check js/ui/tilemode.js`
Expected: no output.

Run: `npm test`
Expected: `155 pass, 0 fail`.

- [ ] **Step 7: Manual smoke check**

At `http://localhost:8080/?autotest`, assign a tile with visible pixels to a terrain slot: the slot cell now shows the tile's actual cropped pixels instead of a blank box. With "Allow flip" or "Allow rotation" enabled, a slot that resolves via symmetry (not an explicit assignment) shows both the derived thumbnail AND a small `↔`/`↕`/`↻` icon overlay; an explicitly-assigned slot shows the thumbnail with no icon overlay. Draw a new stroke on the tile's pixels — the terrain-set editor's thumbnail for that slot updates on the next re-render (selection/project event), confirming the cache invalidates. Zero console errors.

- [ ] **Step 8: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: show live tile thumbnails and flip/rotate icons in terrain slots"
```

---

### Task 8: Tile-picker dialog redesign

**Files:**
- Modify: `js/ui/tilemode.js` (import list, `buildTilePickerDialog`, its caller in `renderTerrainSetEditor`), `css/app.css` (append new rules)

**Interfaces:**
- Consumes: `classifySlots` (Task 1/6), `tileThumbnailURL` (Task 7), `DIRECTION_OFFSETS` and `blobIndexToMask` from `blob47.js`.
- Produces: `tilePickerDialog.open(sheet, terrainSet, blobIndex, currentTileId, pick, clear)` — signature gains a `blobIndex` parameter (previously `open(sheet, terrainSet, currentTileId, pick, clear)`).

- [ ] **Step 1: Import `DIRECTION_OFFSETS`**

Change the blob47 import (from Task 6) from:
```js
import {
  NEIGHBOR_BITS, blobIndexToMask, SIXTEEN_TILE_INDICES, resolveTerrainSlot, classifySlots,
} from '../core/blob47.js';
```
to:
```js
import {
  NEIGHBOR_BITS, blobIndexToMask, SIXTEEN_TILE_INDICES, resolveTerrainSlot, classifySlots,
  DIRECTION_OFFSETS,
} from '../core/blob47.js';
```

- [ ] **Step 2: Replace `buildTilePickerDialog`**

Replace the entire function (originally lines 926-956, now shifted by earlier tasks — locate it by its `function buildTilePickerDialog() {` signature) with:
```js
function buildTilePickerDialog() {
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
    <div class="row"><button type="button" id="tp-clear">Clear</button><button type="button" id="tp-cancel">Cancel</button></div>
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
```

- [ ] **Step 3: Update the caller in `renderTerrainSetEditor`**

Change:
```js
      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, terrainSet.slots[blobIndex] ?? null,
          (tileId) => {
            const tile = sheet.tiles.find(t => t.id === tileId);
            if (tile) commitAssignSlot(sheet, terrainSet, blobIndex, tile);
          },
          () => {
            const owner = sheet.tiles.find(t => t.id === terrainSet.slots[blobIndex]);
            commitClearSlot(terrainSet, blobIndex, owner);
          });
      });
```
to:
```js
      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, blobIndex, terrainSet.slots[blobIndex] ?? null,
          (tileId) => {
            const tile = sheet.tiles.find(t => t.id === tileId);
            if (tile) commitAssignSlot(sheet, terrainSet, blobIndex, tile);
          },
          () => {
            const owner = sheet.tiles.find(t => t.id === terrainSet.slots[blobIndex]);
            commitClearSlot(terrainSet, blobIndex, owner);
          });
      });
```

- [ ] **Step 4: Add CSS for the new dialog markup**

Append to the `/* tiles panel */` block in `css/app.css` (after line 118):
```css
.tile-picker-header { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
.tile-picker-mask-inner { display: grid; grid-template-columns: repeat(3, 12px); grid-template-rows: repeat(3, 12px); gap: 1px; }
.tile-picker-mask-cell { background: #222; border: 1px solid #444; }
.tile-picker-mask-cell.center { background: #4f8cff; }
.tile-picker-mask-cell.filled { background: #8bc34a; }
.tile-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, 64px); gap: 6px; max-height: 320px; overflow-y: auto; margin-bottom: 8px; }
.tile-picker-cell { display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer; padding: 3px; border-radius: 3px; border: 1px solid transparent; }
.tile-picker-cell:hover { background: var(--bg3); }
.tile-picker-cell.selected { border-color: #4f8cff; }
.tile-picker-thumb { width: 48px; height: 48px; background-size: cover; background-color: #222; border: 1px solid #444; }
.tile-picker-cell span { font-size: 10px; color: #9a9ca8; }
```

- [ ] **Step 5: Verify no syntax errors and no regressions**

Run: `node --check js/ui/tilemode.js`
Expected: no output.

Run: `npm test`
Expected: `155 pass, 0 fail`.

- [ ] **Step 6: Manual smoke check**

At `http://localhost:8080/?autotest`, click an empty terrain slot (e.g. one requiring N+E neighbors): the dialog opens showing "N + E" (or similar) text, a "Mandatory"/"Optional" label, and a 3×3 diagram with the center cell and the N/E cells shaded, without needing to hover anything. The body shows a grid of clickable tile thumbnails (not a dropdown) filtered to the terrain set's tile size; clicking one assigns it and closes the dialog immediately. A tile with fully transparent pixels still shows in the grid (its thumbnail looks blank, but the header diagram still communicates intent). "Clear" and "Cancel" still work. Zero console errors.

- [ ] **Step 7: Commit**

```bash
git add js/ui/tilemode.js css/app.css
git commit -m "feat: redesign tile-picker dialog with mask diagram and thumbnail grid"
```

---

### Task 9: Tile Layers manager disambiguation

**Files:**
- Modify: `js/ui/tilemode.js` (`mountAutotilesPanel`'s layer-list section, new `commitSetTerrainSetLayer`, `renderTerrainSetEditor`'s `symRow`), `css/app.css` (append)

**Interfaces:**
- Consumes: `terrainSet.layer` (Task 2).
- Produces: `commitSetTerrainSetLayer(terrainSet, layer)` (mirrors `commitTileLayer`), a `.tile-layer-list` CSS class fully independent of `panels.js`'s `.layer-list.layer-tree`.

- [ ] **Step 1: Add `commitSetTerrainSetLayer`**

In `js/ui/tilemode.js`, immediately after `commitTileLayer` (ends at line 562, `markDirty(); }`), insert:
```js
function commitSetTerrainSetLayer(terrainSet, layer) {
  const after = layer || null;
  if (terrainSet.layer === after) return;
  const before = terrainSet.layer;
  state.commands.push({
    label: 'set terrain set layer',
    do() { terrainSet.layer = after; },
    undo() { terrainSet.layer = before; },
  });
  markDirty();
}
```

- [ ] **Step 2: Rename the Tile Layers section's copy, class, and button icons in `mountAutotilesPanel`**

Change:
```js
  const layerList = document.createElement('div');
  layerList.className = 'layer-list';
  wrap.appendChild(layerList);

  const btnAddLayerName = document.createElement('button');
  btnAddLayerName.type = 'button';
  btnAddLayerName.textContent = 'Add Layer Name…';
  btnAddLayerName.addEventListener('click', () => {
```
to:
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
```
And change the per-row buttons inside `render()`:
```js
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = 'Delete';
      btnDel.addEventListener('click', () => commitRemoveLayerName(sheet, name));
```
to:
```js
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑'; btnUp.title = 'Move up';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓'; btnDown.title = 'Move down';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = '🗑'; btnDel.title = 'Delete';
      btnDel.addEventListener('click', () => commitRemoveLayerName(sheet, name));
```

- [ ] **Step 3: Add the terrain set's own Layer `<select>` in `renderTerrainSetEditor`**

Change the `symRow` construction:
```js
  const symRow = document.createElement('div');
  symRow.className = 'row';
  const flipCb = document.createElement('input'); flipCb.type = 'checkbox'; flipCb.checked = terrainSet.symmetry.flip;
  flipCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'flip', flipCb.checked));
  const rotCb = document.createElement('input'); rotCb.type = 'checkbox'; rotCb.checked = terrainSet.symmetry.rotate;
  rotCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'rotate', rotCb.checked));
  const flipLabel = document.createElement('label'); flipLabel.append(flipCb, document.createTextNode(' Allow flip'));
  const rotLabel = document.createElement('label'); rotLabel.append(rotCb, document.createTextNode(' Allow rotation'));
  symRow.append(flipLabel, rotLabel);
  container.appendChild(symRow);
```
to:
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

- [ ] **Step 4: Add the `.tile-layer-list` CSS rule (fully independent of `.layer-list`)**

Append to the `/* tiles panel */` block in `css/app.css` (after the rules added in Task 8):
```css
.tile-layer-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
```

- [ ] **Step 5: Verify no syntax errors and no regressions**

Run: `node --check js/ui/tilemode.js`
Expected: no output.

Run: `npm test`
Expected: `155 pass, 0 fail`.

- [ ] **Step 6: Manual smoke check**

At `http://localhost:8080/?autotest`, confirm the Autotiles panel's layer section now reads "Tile Layers" with an icon-only `➕` Add button (tooltip "Add tile layer"), and each row's ↑/↓/🗑 buttons show tooltips on hover. Confirm the app's actual Layers panel (left of the canvas, pixel-compositing layers) is completely unaffected — still says "Layers", still uses its own `➕`/`📁`/`🗑`/`⬇` buttons. Open a terrain set: a new Layer dropdown appears next to "Allow flip"/"Allow rotation", listing the Tile Layers names plus "(none)"; selecting one and reselecting a different terrain set (or reloading the panel) preserves the choice; the terrain set's member tiles' own Layer dropdowns (in the Tiles panel) are unaffected by this selection. Zero console errors.

- [ ] **Step 7: Commit**

```bash
git add js/ui/tilemode.js css/app.css
git commit -m "feat: disambiguate Tile Layers from the real Layers panel, add per-set layer"
```

---

### Task 10: Smoke checklist additions

**Files:**
- Modify: `tests/smoke.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add new checklist items**

In `tests/smoke.md`, after item 34 (ends `...and "No tile selected".`), insert:
```markdown
34b. [A] The Tile Sheets tab shows two separate sidebar panels: "Tiles"
    (grid list, Add Grid, tile detail) and "Autotiles" (terrain sets, view
    modes, Tile Layers) — both hidden while on the Sprite Sheets tab.
```

After item 48 (ends `...(blue, thicker) border.`), insert:
```markdown
48b. [A] Terrain-set editor's "View" dropdown (Staircase / Grid 6×8 / Grid
    7×7 / 16-tile only) rearranges the same 47 slots on screen without
    changing any slot's assignment (cosmetic only); the layout-preset
    dropdown (Import/Save row) lists "Blob-47 (8×6)" (the corrected/renamed
    former "6×8, ascending" built-in) and "Blob-47 (7×7)" alongside the
    4×4 16-tile built-in — both now use the real reference template
    mapping rather than ascending index order, so importing a matching
    grid of real terrain art places visually-continuous tiles into their
    slots.
48c. [A] Toggling "Allow flip"/"Allow rotation" immediately reclassifies
    each slot as mandatory (solid border) or optional (dashed border)
    based on symmetry alone, independent of whether the slot currently has
    a tile assigned. A filled slot shows the actual tile's cropped pixels
    as its background, with a small ↔/↕/↻ icon overlay only when that
    fill came from symmetry (not an explicit assignment).
```

After item 49 (ends `...; "Clear" empties it again.`), insert:
```markdown
49b. [A] Opening the tile picker for an unfilled slot shows, without
    hovering: the slot's direction description (e.g. "N + E"), a
    Mandatory/Optional label, and a 3×3 diagram shading which neighbor
    cells are filled. The body is a clickable grid of live tile thumbnails
    (not a dropdown); clicking one assigns it immediately and closes the
    dialog. A tile with fully transparent pixels still appears in the grid.
```

After item 55 (ends `...selected it had.`), insert:
```markdown
55b. [A] The Tile Layers section (in the Autotiles panel) reads "Tile
    Layers", with an icon-only Add button and hover tooltips on its
    add/up/down/delete controls; it is visually and structurally
    independent from the app's real Layers panel. A terrain set's own
    Layer dropdown (next to its symmetry checkboxes) sets that set's
    layer without changing any member tile's own Layer selection.
```

After item 57 (ends `...has no \`neighbors\` key.`), insert:
```markdown
57b. [A] Tiles JSON export: a terrain set with a Layer selected includes a
    `layer` key in its `terrainSets[]` entry; omitted when the set has no
    layer selected.
```

- [ ] **Step 2: Commit**

```bash
git add tests/smoke.md
git commit -m "docs: add smoke checklist items for autotile panel UX changes"
```

---

## Plan self-review notes

- **Spec coverage:** every spec section maps to a task — panel split (4), view modes/8×6/7×7 (5), mandatory/optional (1+6), thumbnails/icons (7), picker dialog (8), Tile Layers disambiguation (2+9), export shape (3), testing plan (1/2/3 tests + 10 smoke items). The spec's own testing-plan line about "a case where the representative must prefer a 16-tile-subset member over a lower raw index" was checked empirically against the real 47-index table (via a throwaway Node script) — no such case exists for blob-47's actual canonical table (the 16-tile preference and plain lowest-index tie-break always agree). Task 1's tests therefore verify the real orbits/representatives directly with concrete, verified numbers instead of asserting an unreachable branch.
- **Post-approval correction (Task 5):** after the spec was approved, the user supplied the actual external reference template's raw-bitmask layout for both grid shapes, superseding the spec's "ascending index, ⁠not a claimed external match" framing for the *existing* 6×8 preset as well as the new one. Verified programmatically (Task 5, Step 1b) that both supplied templates cover all 47 canonical blob indices exactly once, with the documented `255` duplicate accounting for the extra cell(s) — not a transcription error. Task 5 now corrects the existing preset (renamed/reshaped 6×8→8×6) in addition to adding the real 7×7 one; this is hardcoded, non-persisted data, so there's no save-format migration to worry about.
- **Placeholder scan:** no TBD/TODO; every step has complete code.
- **Type/interface consistency:** `tilePickerDialog.open`'s signature change (added `blobIndex`) is introduced and consumed within the same task (8) — no stale caller elsewhere. `classifySlots`'s return shape (`{ mandatory, orbitRepresentative }`) is used identically in Task 6 and Task 8.
