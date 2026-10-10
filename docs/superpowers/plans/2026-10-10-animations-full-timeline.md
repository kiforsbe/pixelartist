# Animations Full Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Animations workbench's one-row timeline into the spec's full timeline. It gains:
- layer rows and folders with cel dots,
- an expanded thumbnail mode,
- column gestures and keys,
- per-column duration.

The Layers panel is hidden in this workbench.

**Architecture:**
- **Shared layer tree.** The Layers panel's sheet layer tree (rows, row actions, drag-and-drop, the selected tree node) moves to a shared `js/components/panels/layer-tree.js`. The Layers panel and the timeline both build their rows from it, so the two cannot drift apart. The Layers panel keeps only its maps rows and its composition.
- **Timeline rendering.** The timeline renders one row per visible tree node: a sticky layer header (a shared `.layer-row`) followed by one cel per column. A cel's dot comes from pure helpers: `regionHasPixels` in `core/pixels.js` and `celFilled` in the timeline model.
- **No engine changes.** Gestures dispatch the Phase 1 engine commands (`animations.addFrame` / `linkFrame` / `moveFrame` / `deleteFrame` / `autoLayout`).
- **Shared duration input.** The per-frame duration/step input moves out of the sprites timeline into a shared component that both timelines use.

**Tech Stack:** Vanilla ES modules, no build step; `node --test tests/*.mjs`; fake DOM in `tests/helpers/sprite-context-dom.mjs` (no `closest`, no `replaceWith`, no descendant selectors, `fire()` does not bubble).

**Spec:** `docs/superpowers/specs/2026-10-09-animations-workbench-design.md` (§3 "Timeline", "Right panels"; §5 "Typing targets"; §7 item 3; Implementation notes for Phases 1 and 2). Phase 2 plan: `docs/superpowers/plans/2026-10-09-animations-workbench-shell.md`.

## Global Constraints

- **Rows** follow the sheet's layer tree: top layer first, folders expandable. Each row has visibility, lock, folder expand/collapse, and a name (double-click to rename).
  - Rows can be dragged to reorder or into a folder.
  - Add layer, add folder, delete and opacity all use the existing layer commands.
- **Cels:**
  - A filled dot means the layer has pixels in that frame; a hollow dot means it is empty.
  - A link mark appears on columns that repeat an earlier frame.
  - Clicking a cel selects that frame and that layer.
- **Expanded mode:** a size control widens the columns. Past a threshold, cels show per-layer thumbnails and a composite thumbnail row appears above the layer rows.
- **Gestures** apply only within the tag the column belongs to:
  - `+` between columns inserts a blank frame; Alt+`+` duplicates the frame to its left.
  - Dragging a column header reorders; Ctrl+drag inserts a linked use.
  - Delete removes the selected column.
  - Duration and step per column are editable.
  - On a manual animation, the first insert or reorder offers "Auto-layout this animation".
- **Hidden Layers panel:** the separate Layers panel is not shown in the Animations workbench.
- **Focus gating:** timeline keyboard shortcuts (Delete, arrows) respect the existing focus gating; they are never taken from a typing target.
- **Style:** the app's own panel tokens, controls and icons.
- **`tests/architecture.test.mjs`:** presentation never imports `application/commands`; domain never imports components/host/modes; modes never import sibling modes.
- **No commits** (the owner has not authorized them). Each task's "Commit" step is replaced by a ledger line.
- **Browser check:** no drag simulation; load with `?autotest`; serve with `serve.ps1`.

## Review Focus

1. **A collapsed folder.** Its descendants' rows and cels disappear. The active layer stays active inside the collapsed folder, and expanding the folder restores the rows. *(Task 3 test: "collapsing a folder hides its rows and keeps the active layer")*
2. **Delete while typing or with a marquee.** A Delete typed into a rename or duration input never removes a column. A Delete on the focused timeline never also clears a marquee's pixels on the canvas. *(Task 5 tests: "Delete in an input does not remove a column", "a handled Delete does not clear the canvas selection")*
3. **A drag that crosses tags.** Dropping a column header on another animation's column changes nothing. *(Task 5 test: "a column dropped on another animation is ignored")*
4. **Declining the auto-layout offer.**
   - On a manual animation, a declined offer leaves the animation as it was for insert and link.
   - Reorder still works without layout, through `sprites.reorderAnimationFrame`.
   - When the frames differ in size, accepting the offer lays out at the suggested size.

   *(Task 5 tests)*
5. **The layer tree changes under the timeline.** Adding or deleting a layer, or undoing either, re-renders rows and cels aligned. *(Task 3 test: "adding a layer adds a row with one cel per column")*

---

### Task 1: Cel model

**Files:**
- Modify: `js/core/pixels.js` (add `regionHasPixels`)
- Modify: `js/modes/animations/application/timeline-model.js` (add `celFilled`)
- Test: `tests/pixels-region.test.mjs` (new), `tests/animation-timeline-model.test.mjs`

**Interfaces:**
- Produces: `regionHasPixels(bmp, x, y, w, h) → boolean` (any non-zero alpha inside the rect, clipped to the bitmap); `celFilled(sheet, layer, frameId) → boolean` (false for an unknown frame).

- [ ] **Step 1: Write the failing tests**

`tests/pixels-region.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, regionHasPixels } from '../js/core/pixels.js';

test('regionHasPixels sees a pixel inside the rect only', () => {
  const bmp = createBitmap(8, 8);
  setPixel(bmp, 5, 5, [1, 2, 3, 255]);
  assert.equal(regionHasPixels(bmp, 4, 4, 2, 2), true);
  assert.equal(regionHasPixels(bmp, 0, 0, 5, 5), false);
});

test('regionHasPixels clips a rect that leaves the bitmap', () => {
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 3, 0, [0, 0, 0, 1]);
  assert.equal(regionHasPixels(bmp, 2, -2, 10, 3), true);
  assert.equal(regionHasPixels(bmp, 10, 10, 2, 2), false);
});
```

Append to `tests/animation-timeline-model.test.mjs` (add `celFilled` to its import):

```js
test('celFilled reads the layer bitmap inside the frame rect', () => {
  const layer = { bitmap: { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) } };
  layer.bitmap.data[(0 * 4 + 3) * 4 + 3] = 255; // pixel (3,0)
  const sheet = { frames: [{ id: 'l', x: 0, y: 0, w: 2, h: 2 }, { id: 'r', x: 2, y: 0, w: 2, h: 2 }] };
  assert.equal(celFilled(sheet, layer, 'l'), false);
  assert.equal(celFilled(sheet, layer, 'r'), true);
  assert.equal(celFilled(sheet, layer, 'nope'), false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/pixels-region.test.mjs tests/animation-timeline-model.test.mjs`
Expected: FAIL — `regionHasPixels` / `celFilled` not exported.

- [ ] **Step 3: Implement**

`js/core/pixels.js`:

```js
// True when any pixel of the (clipped) rect has non-zero alpha.
export function regionHasPixels(bmp, x, y, w, h) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y);
  const x1 = Math.min(bmp.width, x + w), y1 = Math.min(bmp.height, y + h);
  for (let py = y0; py < y1; py++) {
    for (let i = (py * bmp.width + x0) * 4 + 3, px = x0; px < x1; px++, i += 4) {
      if (bmp.data[i] !== 0) return true;
    }
  }
  return false;
}
```

`timeline-model.js`:

```js
import { regionHasPixels } from '../../../core/pixels.js';

// A cel is filled when the layer has pixels inside the frame's rect.
export function celFilled(sheet, layer, frameId) {
  const f = sheet.frames.find(fr => fr.id === frameId);
  return !!f && regionHasPixels(layer.bitmap, f.x, f.y, f.w, f.h);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/pixels-region.test.mjs tests/animation-timeline-model.test.mjs tests/architecture.test.mjs`
Expected: PASS.

- [ ] **Step 5: Ledger line** (no commit).

---

### Task 2: Shared layer tree

The sheet half of `layers-panel.js` moves to `js/components/panels/layer-tree.js`, keeping its behavior. The function bodies move verbatim, except that the panel-local `selectedNodeId` becomes module state, so the Layers panel and the timeline share one selected tree node. The Layers panel keeps the maps rows and actions, the action definitions (`layer.add`, `layer.addGroup`, `layer.delete`, `layer.mergeDown`; their sheet branches call the shared functions), the thumbnail redraw subscription and its mount.

**Files:**
- Create: `js/components/panels/layer-tree.js`
- Modify: `js/components/panels/layers-panel.js`
- Test: `tests/layer-tree.test.mjs` (new); existing `tests/layers-panel-opacity.test.mjs`, `tests/float-structural-transition.test.mjs` and the tests that use `tests/helpers/phase4-final-fix-fixtures.mjs` must stay green unchanged.

**Interfaces:**
- Produces, from `layer-tree.js`:
  - `commandPrefix() → 'sprites' | 'tiles' | 'maps'` (animations maps to sprites)
  - `layerTreeRows(tree) → [{ node, depth }]` (top node first; children of a folder whose `open !== false`)
  - `selectedNodeId() → string | null`
  - `selectTreeNode(sheet, node)` (a layer also becomes the active `layerId`; a folder clears it)
  - `addSheetLayer()`, `addSheetGroup()`, `deleteSheetNode()`, `mergeSheetLayerDown()` (the bodies of today's sheet branches)
  - `buildLayerRow(node, depth, { thumbs = null, onChange })` → `.layer-row` element. It carries the same children, classes, handlers and `dataset.nodeId` as today. `thumbs` is a `Map` the caller redraws from, or null for no thumbnail. `onChange()` is called wherever the panel called `renderList()`.
  - `attachLayerTreeDrop(listEl)` (today's list-level dragover/dragleave/drop)
  - `drawLayerThumb(canvas, sheet, layer)`.

- [ ] **Step 1: Write the failing test** — `tests/layer-tree.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, sheetLayers, findNode } from '../js/core/model.js';
import { layerTreeRows, buildLayerRow, selectTreeNode, selectedNodeId, addSheetLayer } from '../js/components/panels/layer-tree.js';

installSpriteContextDom();
globalThis.alert = () => {};
const host = new EditorHost(); setEditorHost(host);
for (const mode of [spriteMode, animationsMode]) host.registerMode(mode);
host.start('sprites');

function setup() {
  const project = createProject('Tree');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  host.setProject(project);
  host.history.clear();
  const bottom = sheetLayers(sheet)[0];
  const groupId = host.registries.commands.execute('sprites.addGroup', { modeId: 'sprites' }, { sheetId: sheet.id, targetGroupId: null });
  const inner = host.registries.commands.execute('sprites.addLayer', { modeId: 'sprites' }, { sheetId: sheet.id, targetGroupId: groupId });
  return { sheet, bottom, group: findNode(sheet.layerTree, groupId), inner: findNode(sheet.layerTree, inner) };
}

test('layerTreeRows lists the top node first and skips a collapsed folder', () => {
  const { sheet, bottom, group, inner } = setup();
  assert.deepEqual(layerTreeRows(sheet.layerTree).map(r => [r.node.id, r.depth]), [[group.id, 0], [inner.id, 1], [bottom.id, 0]]);
  group.open = false;
  assert.deepEqual(layerTreeRows(sheet.layerTree).map(r => r.node.id), [group.id, bottom.id]);
});

test('a folder selected in one tree is where the next layer is added', () => {
  const { sheet, group } = setup();
  selectTreeNode(sheet, group);
  assert.equal(selectedNodeId(), group.id);
  assert.equal(host.selections.get().layerId ?? null, null);
  const before = group.children.length;
  addSheetLayer();
  assert.equal(group.children.length, before + 1);
});

test('a row visibility button toggles the layer as one undoable step', () => {
  const { bottom } = setup();
  const row = buildLayerRow(bottom, 0, { onChange() {} });
  row.querySelectorAll('button').find(b => b.title === 'Toggle visibility').fire('click');
  assert.equal(bottom.visible, false);
  host.history.undo();
  assert.equal(bottom.visible, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/layer-tree.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the move**

In `layer-tree.js` (header comment: "The sheet layer tree shared by the Layers panel and the Animations timeline: rows, row actions, drag-and-drop, and the one selected tree node."), move these verbatim from `layers-panel.js`:
- `dispatch`, `currentModeId`, `commandPrefix`
- the thumbnail scratch canvas, `LAYER_THUMB_SIZE`, `drawFit` (renamed `drawLayerThumbFit`, module-private)
- `sheetDocument`, `countNodes`, `autoName`, `isDescendant`
- `targetGroupForInsert`
- the sheet branches of `doAddLayer` / `doAddGroup` / `doDelete` (as `addSheetLayer` / `addSheetGroup` / `deleteSheetNode`)
- `doMergeDown` (as `mergeSheetLayerDown`), `doMove`, `doToggleVisible`, `startRename`
- `scheduleNameSelect` with its pending timer
- the drag-and-drop helpers (`clearDropIndicators`, `getDropPosition`, `applyDropIndicator`, `performMove`, the row dragstart/dragend handlers, and the list dragover/dragleave/drop handlers, which become `attachLayerTreeDrop(list)`)
- `selectGroupNode` / `selectLayerNode` (merged as `selectTreeNode`)
- `renderGroup` / `renderLayer` (as `buildLayerRow`, which returns the row instead of appending it, and recurses nowhere; the caller walks `layerTreeRows`).

Add:

```js
let selected = null;       // the selected tree node (a layer or a folder)
export function selectedNodeId() {
  const sheet = activeSheet();
  if (!sheet) return null;
  if (selected && !findNode(sheet.layerTree, selected)) selected = null;
  return selected ?? (getEditorHost().selections.get(sheetDocument(sheet)) ?? {}).layerId ?? null;
}

export function layerTreeRows(tree) {
  const rows = [];
  (function walk(group, depth) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const node = group.children[i];
      rows.push({ node, depth });
      if (node.type === 'group' && node.open !== false) walk(node, depth + 1);
    }
  })(tree, 0);
  return rows;
}
```

`selectTreeNode(sheet, node)` sets `selected = node.id`. It also patches the sheet selection's `layerId`: `node.id` for a layer, `null` for a folder. Every former read of the panel's `selectedNodeId` variable reads `selectedNodeId()`, and every write goes through `selected = …`.

`layers-panel.js` then becomes:
- the maps rows (`renderMapLayer`) and maps branches,
- `renderList()` (maps: as today; sheets: validate the active layer as today, then `for (const { node, depth } of layerTreeRows(sheet.layerTree)) list.appendChild(buildLayerRow(node, depth, { thumbs: thumbCanvases, onChange: renderList }))`),
- `attachLayerTreeDrop(list)`,
- the four `defineAction`s (each `run` checks `commandPrefix() === 'maps'` for the maps branch, else calls the shared sheet function),
- the thumbnail redraw (it uses `drawLayerThumb`) and the store/history subscriptions.

The panel's `renderListUnlessNameClickPending` asks the shared module `nameClickPending()` (export it from `layer-tree.js`).

- [ ] **Step 4: Run to verify it passes, with the existing Layers tests**

Run: `node --test tests/layer-tree.test.mjs tests/layers-panel-opacity.test.mjs tests/float-structural-transition.test.mjs tests/architecture.test.mjs`, then the whole suite `node --test tests/*.mjs` (the phase4 fixtures are shared by several files).
Expected: PASS, suite green.

- [ ] **Step 5: Ledger line.**

---

### Task 3: Layer rows and cels in the timeline; Layers panel hidden

**Files:**
- Modify: `js/modes/animations/presentation/animation-timeline-presenter.js`
- Modify: `js/components/panels/layers-panel.js` (hide in animations mode)
- Modify: `css/app.css`
- Test: `tests/animation-timeline.test.mjs`, `tests/layers-panel-opacity.test.mjs`

**Interfaces:**
- Consumes: `layerTreeRows`, `buildLayerRow`, `attachLayerTreeDrop`, `selectTreeNode`, `addSheetLayer`, `addSheetGroup`, `deleteSheetNode` (Task 2); `celFilled` (Task 1).
- Produces:
  - DOM: one `.anim-tl-layer` row per tree row. It holds an `.anim-tl-head` (sticky; contains the shared `.layer-row`), then one `.anim-tl-cel` per column. A layer's cel has a `.anim-tl-dot` child with class `filled` or `empty`; a folder's cel has no dot.
  - The cel of the selected column and active layer carries `selected`; every cel of the selected column carries `col-selected`.
  - The link mark (`.anim-tl-linked`) moves to the `.anim-tl-num` of a linked column.
  - Header buttons titled 'Add layer', 'Add folder' and 'Delete layer or folder'.

- [ ] **Step 1: Write the failing tests** — append to `tests/animation-timeline.test.mjs` (add `addLayer`-free helpers; `reset()` already builds the sheet with one layer holding a red pixel at (1,1), inside frame A):

```js
const layerRows = () => dock.querySelectorAll('.anim-tl-layer');
const celsOf = row => row.querySelectorAll('.anim-tl-cel');

test('each layer row has one cel per column, with a filled dot where the layer has pixels', async () => {
  await reset();
  assert.equal(layerRows().length, 1);
  const dots = celsOf(layerRows()[0]).map(c => c.querySelector('.anim-tl-dot').classList.contains('filled'));
  assert.deepEqual(dots, [true, false, false]);
});

test('clicking a cel selects that frame and that layer', async () => {
  const { sheet, b } = await reset();
  const layer = sheetLayers(sheet)[0];
  host.selections.patch({ layerId: null });
  celsOf(layerRows()[0])[1].fire('click');
  const sel = host.selections.get();
  assert.equal(sel.frameId, b.id); assert.equal(sel.entryIndex, 1); assert.equal(sel.layerId, layer.id);
  await tick();
  assert.equal(celsOf(layerRows()[0])[1].classList.contains('selected'), true);
});

test('adding a layer adds a row with one cel per column', async () => {
  await reset();
  byTitle('Add layer').fire('click');
  await tick();
  assert.equal(layerRows().length, 2);
  assert.equal(celsOf(layerRows()[0]).length, 3);
  host.history.undo(); await tick();
  assert.equal(layerRows().length, 1);
});

test('collapsing a folder hides its rows and keeps the active layer', async () => {
  const { sheet } = await reset();
  byTitle('Add folder').fire('click'); await tick();
  const folder = sheet.layerTree.children.find(n => n.type === 'group');
  byTitle('Add layer').fire('click'); await tick(); // added into the selected folder
  const inner = folder.children[0];
  assert.equal(host.selections.get().layerId, inner.id);
  assert.equal(layerRows().length, 3);
  layerRows()[0].querySelector('.tree-toggle').fire('click'); await tick();
  assert.equal(layerRows().length, 2);
  assert.equal(host.selections.get().layerId, inner.id);
});

test('a linked column shows its link mark on the frame number', async () => {
  const { run, a } = await reset();
  run.frames.push({ frameId: a.id, duration: null }); host.history.execute({ do() {}, undo() {} });
  await tick();
  assert.ok(dock.querySelectorAll('.anim-tl-num')[2].querySelector('.anim-tl-linked'));
});
```

Append to `tests/layers-panel-opacity.test.mjs`:

```js
test('the Layers panel is hidden in the Animations workbench', async () => {
  host.activateMode('animations'); await Promise.resolve();
  assert.equal(panel.hidden, true);
  host.activateMode('sprites'); await Promise.resolve();
  assert.equal(panel.hidden, false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/animation-timeline.test.mjs tests/layers-panel-opacity.test.mjs`
Expected: FAIL — no `.anim-tl-layer` rows, no 'Add layer' button, panel not hidden.

- [ ] **Step 3: Implement**

Layers panel: at the top of `renderList()`, add `el.hidden = currentModeId() === 'animations';`. Rendering continues while the panel is hidden, so its actions and thumbnails stay current.

Timeline:
- The grid gains a sticky corner cell (`.anim-tl-corner`) at the start of the tags and numbers rows, the same width as the heads.
- The Phase 2 composite `.anim-tl-cells` row stays (Task 4 makes it expanded-only).
- After it, for each `{ node, depth }` of `layerTreeRows(s.layerTree)`:

```js
const line = document.createElement('div');
line.className = 'anim-tl-row anim-tl-layer';
const head = document.createElement('div');
head.className = 'anim-tl-head';
head.appendChild(buildLayerRow(node, depth, { thumbs: null, onChange: () => panel.scheduleRender() }));
line.appendChild(head);
cols.forEach((column, i) => line.appendChild(buildCel(s, node, column, i === selectedIndex)));
layersBox.appendChild(line);
```

`buildCel`:

```js
function buildCel(s, node, column, colSelected) {
  const cel = document.createElement('div');
  const layerSelected = node.type === 'layer' && node.id === selection().layerId;
  cel.className = 'anim-tl-cel' + (colSelected ? ' col-selected' : '') + (colSelected && layerSelected ? ' selected' : '');
  if (node.type === 'layer') {
    const dot = document.createElement('span');
    dot.className = 'anim-tl-dot ' + (celFilled(s, node, column.frameId) ? 'filled' : 'empty');
    cel.appendChild(dot);
  }
  cel.addEventListener('click', () => {
    stopPlaying();
    if (node.type === 'layer') selectTreeNode(s, node);
    select(column);
  });
  return cel;
}
```

- `attachLayerTreeDrop(layersBox)` is called once at mount.
- The link mark moves from the composite cell to the `.anim-tl-num` (`num.appendChild(link)` when `column.linked`).
- Header: after ✕, a separator and three `iconButton`s: ➕ 'Add layer' → `addSheetLayer()`, 📁 'Add folder' → `addSheetGroup()`, 🗑 'Delete layer or folder' → `deleteSheetNode()`. All three are disabled without a sheet.
- Update the file header comment.

CSS:

```css
.anim-tl-layer { align-items: stretch; }
.anim-tl-head, .anim-tl-corner { position: sticky; left: 0; z-index: 1; flex: none; width: 180px; background: var(--bg2); }
.anim-tl-head .layer-row { padding: 1px 3px; }
.anim-tl-cel { flex: none; box-sizing: border-box; width: 40px; display: flex; align-items: center; justify-content: center;
  border-left: 1px solid var(--border); cursor: pointer; }
.anim-tl-cel.col-selected { background: var(--bg3); }
.anim-tl-cel.selected { outline: 1px solid var(--accent); outline-offset: -1px; }
.anim-tl-dot { width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box; border: 1.5px solid #9a9ca8; }
.anim-tl-dot.filled { background: #d7d9e0; border-color: #d7d9e0; }
.anim-tl-num { position: relative; }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/animation-timeline.test.mjs tests/layers-panel-opacity.test.mjs tests/layer-tree.test.mjs tests/architecture.test.mjs`
Expected: PASS (the Phase 2 timeline tests included).

- [ ] **Step 5: Ledger line.**

---

### Task 4: Expanded mode

**Files:**
- Modify: `js/modes/animations/presentation/animation-timeline-presenter.js`, `css/app.css`
- Test: `tests/animation-timeline.test.mjs`

**Interfaces:**
- Produces:
  - A header range input `.anim-tl-size` (min 16, max 64, step 4; default 24) whose value is the column width in px. It is stored in `localStorage['pixelartist.animTimelineColumn']`, with every access wrapped in try/catch.
  - `EXPAND_AT = 40`. At or above it, the composite `.anim-tl-cells` row renders and each layer cel holds an `.anim-tl-cel-thumb` canvas (the layer's pixels in that frame) instead of a dot.
  - Below it, neither the composite row nor the thumbnails exist.

- [ ] **Step 1: Write the failing tests** — append:

```js
const sizeInput = () => dock.querySelector('.anim-tl-size');

test('the compact timeline shows dots and no composite row', async () => {
  await reset();
  sizeInput().value = '24'; sizeInput().fire('input'); await tick();
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 0);
  assert.ok(celsOf(layerRows()[0])[0].querySelector('.anim-tl-dot'));
});

test('widening past the threshold shows per-layer thumbnails and the composite row', async () => {
  await reset();
  sizeInput().value = '48'; sizeInput().fire('input'); await tick();
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 3);
  const cel = celsOf(layerRows()[0])[0];
  assert.ok(cel.querySelector('.anim-tl-cel-thumb'));
  assert.equal(cel.querySelector('.anim-tl-dot'), null);
  assert.equal(cel.style.width, '48px');
});
```

The Phase 2 tests that click or inspect `.anim-tl-cell` (the "tags and cells", "clicking a cell of another animation", "+ Frame … selected" tests) start with the timeline expanded. `reset()` sets `sizeInput().value = '48'; sizeInput().fire('input')` before its `await tick()`, and the two compact tests above set 24 themselves.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/animation-timeline.test.mjs`
Expected: FAIL — no `.anim-tl-size`.

- [ ] **Step 3: Implement**

- Replace the `COL_W` constant with a `colW` variable, read at mount:

```js
const COL_KEY = 'pixelartist.animTimelineColumn';
function storedColumnWidth() {
  try { const v = Number(localStorage.getItem(COL_KEY)); return v >= 16 && v <= 64 ? v : 24; } catch { return 24; }
}
```

- The size input's `input` handler sets `colW`, stores it in try/catch, and calls `panel.scheduleRender()`.
- Every tag, number, composite cell and cel gets `style.width = colW + 'px'`, and tags use `span.length * colW`.
- The composite row is built only when `colW >= EXPAND_AT`. Its cell thumbnail canvas is sized `colW - 8`.
- In expanded mode a layer cel holds:

```js
const thumb = document.createElement('canvas');
thumb.className = 'anim-tl-cel-thumb';
thumb.width = thumb.height = colW - 8;
const f = s.frames.find(fr => fr.id === column.frameId);
if (f) drawFit(thumb, copyRegion(node.bitmap, f.x, f.y, f.w, f.h));
```

CSS: `.anim-tl-cel-thumb { image-rendering: pixelated; }`, and `.anim-tl-size { width: 80px; }`. The `.anim-tl-cel`/`.anim-tl-num`/`.anim-tl-cell` CSS widths are removed, since inline widths win.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/animation-timeline.test.mjs`
Expected: PASS.

- [ ] **Step 5: Ledger line.**

---

### Task 5: Gestures and keys

**Files:**
- Modify: `js/modes/animations/presentation/animation-timeline-presenter.js`, `css/app.css`
- Modify: `js/components/canvas/drawing-engine.js` (a Delete already handled by a focused panel is not also a canvas delete)
- Test: `tests/animation-timeline.test.mjs`, `tests/drawing-engine-delete.test.mjs` (new, or an existing drawing-engine Delete test file if one covers that handler — check with `git grep -l "key: 'Delete'" tests` first)

**Interfaces:**
- Produces:
  - `.anim-tl-gap` buttons (title 'Insert a blank frame here (Alt: duplicate the frame to the left)'). One sits at the left edge of each number cell (`at = column.index`), plus one at the right edge of each animation's last number cell (`at = length`).
  - Draggable `.anim-tl-num` headers.
  - Grid keydown: Delete removes the selected column; ArrowLeft and ArrowRight step. The grid is focusable (`tabIndex = 0`).
- Consumes: `confirmOrAuto` (`platform/browser/autotest.js`), `dispatchLayout`.

Manual-animation rule (spec: "offers Auto-layout this animation"):

```js
// True once `anim` is auto. A manual animation is offered an auto-layout;
// when its frames differ, the suggested (largest) size is used.
function ensureAuto(s, anim) {
  if (anim.layout === 'auto') return true;
  if (!confirmOrAuto(`"${anim.name}" is laid out by hand. Auto-layout it first?`)) return false;
  let result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id });
  if (result?.needsSize) result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id, size: result.suggested });
  return !!result?.ok;
}
```

The gestures:
- **Insert** (gap click): `ensureAuto` first. When it is declined, nothing happens. Then `animations.addFrame { at, copyOf: e.altKey ? anim.frames[at - 1]?.frameId ?? null : null }`, and the new column is selected.
- **Reorder** (drop without Ctrl): on an auto animation, `animations.moveFrame { from, to }`. On a manual one, `ensureAuto` first: accepted → `animations.moveFrame`; declined → `sprites.reorderAnimationFrame { fromIndex, toIndex }`.
- **Linked insert** (drop with Ctrl): `ensureAuto` first; declined → nothing. Accepted → `animations.linkFrame { at, frameId }`.
- **Index math:** `to` is computed as in the sprites timeline: `toIndex = index + (before ? 0 : 1); if (from < toIndex) toIndex -= 1`. A linked insert uses `at = index + (before ? 0 : 1)` with no removal shift.
- **Tag boundary:** a header dragged over a column of another animation gets no `preventDefault` in dragover, and the drop handler also checks the animation id, so the drop does nothing.
- **Drag source:** recorded in a closure variable `dragColumn = { animationId, index, frameId }` at dragstart. `dataTransfer.setData('text/plain', …)` is still set so Firefox starts the drag.

Keys:

```js
grid.tabIndex = 0;
grid.addEventListener('keydown', e => {
  if (isTypingTarget(e.target)) return;
  if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); removeSelected(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});
```

`removeSelected` is the existing ✕ handler body, extracted. `isTypingTarget` is the one `drawing-engine.js` uses; move it to `js/components/dom-utils.js` if it is module-private there (export it from there, and import it in both places).

`drawing-engine.js`: in the window keydown handler, add `if (e.defaultPrevented) return;` as the first line.

- [ ] **Step 1: Write the failing tests** — append to `tests/animation-timeline.test.mjs` (import `globalThis.confirm` control: `confirmOrAuto` calls `confirm` outside autotest; set `let confirmAnswer = true; globalThis.confirm = () => confirmAnswer;` at the top of the file):

```js
const nums = () => dock.querySelectorAll('.anim-tl-num');
const gaps = () => dock.querySelectorAll('.anim-tl-gap');
const grid = () => dock.querySelector('.anim-tl-grid');

test('a gap inserts a blank frame there; Alt duplicates the frame to its left', async () => {
  const { run, a } = await reset();
  gaps()[1].fire('click', { altKey: false }); // between A and B
  assert.equal(run.frames.length, 3);
  assert.notEqual(run.frames[1].frameId, a.id);
  await tick();
  gaps()[1].fire('click', { altKey: true });
  assert.equal(run.frames.length, 4);
  const dup = run.frames[1].frameId;
  assert.notEqual(dup, a.id);
});

test('dragging a header onto another column of its animation reorders it', async () => {
  const { run, a, b } = await reset();
  nums()[0].fire('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: { getData: () => '' } });
  assert.deepEqual(run.frames.map(e => e.frameId), [b.id, a.id]);
});

test('Ctrl+drop inserts a linked use of the dragged frame', async () => {
  const { run, a } = await reset();
  nums()[0].fire('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: true, dataTransfer: { getData: () => '' } });
  assert.equal(run.frames.length, 3);
  assert.equal(run.frames[2].frameId, a.id);
});

test('a column dropped on another animation is ignored', async () => {
  const { run, jump } = await reset();
  nums()[0].fire('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } });
  nums()[2].fire('drop', { clientX: 0, ctrlKey: false, dataTransfer: { getData: () => '' } });
  assert.equal(run.frames.length, 2); assert.equal(jump.frames.length, 1);
});

test('Delete on the focused timeline removes the selected column', async () => {
  const { run } = await reset();
  let prevented = false;
  grid().fire('keydown', { key: 'Delete', target: grid(), preventDefault() { prevented = true; } });
  assert.equal(run.frames.length, 1);
  assert.equal(prevented, true);
});

test('Delete in an input does not remove a column', async () => {
  const { run } = await reset();
  const input = document.createElement('input');
  grid().fire('keydown', { key: 'Delete', target: input });
  assert.equal(run.frames.length, 2);
});

test('ArrowRight on the timeline steps to the next column', async () => {
  const { b } = await reset();
  grid().fire('keydown', { key: 'ArrowRight', target: grid() });
  assert.equal(host.selections.get().frameId, b.id);
});

test('a manual animation is offered auto-layout before an insert; declining changes nothing', async () => {
  const { run } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  confirmAnswer = false;
  gaps()[1].fire('click', {});
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  confirmAnswer = true;
  gaps()[1].fire('click', {});
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
});

test('declining the offer still reorders a manual animation without layout', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  confirmAnswer = false;
  nums()[0].fire('dragstart', { dataTransfer: { setData() {}, effectAllowed: '' } });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: { getData: () => '' } });
  confirmAnswer = true;
  assert.equal(run.layout, 'manual');
  assert.deepEqual(run.frames.map(e => e.frameId), [b.id, a.id]);
});
```

(The drop handler computes before/after from the number cell's own `getBoundingClientRect()`; the fake DOM's rect is `{ left: 0, width: 240 }`, so `clientX: 200` is the right half ("after") and `clientX: 0` the left half.)

`tests/drawing-engine-delete.test.mjs` (only if no existing file covers the window Delete handler; otherwise append there, reusing its fixture):

```js
test('a Delete already handled elsewhere does not clear the canvas selection', () => {
  // fixture: select tool, a marquee over a painted pixel on the sheet view
  window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Delete', defaultPrevented: true }));
  assert.equal(getPixel(layer.bitmap, 1, 1)[3], 255);
});
```

Build that fixture from the existing drawing-engine test helpers (`git grep -l "createDrawingEngine\|bindDrawing" tests`); if none can host it in under ~30 lines, rule it and cover the guard with a direct assertion that the handler returns before reading the selection.

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/animation-timeline.test.mjs`
Expected: FAIL — no gaps, headers not draggable, no keydown handler.

- [ ] **Step 3: Implement** the gaps, header drag/drop, keys, `ensureAuto` and the drawing-engine guard as specified above. CSS:

```css
.anim-tl-gap { position: absolute; top: 0; bottom: 0; left: -5px; width: 10px; padding: 0; border: 0; background: transparent;
  color: transparent; font-size: 10px; cursor: pointer; z-index: 2; }
.anim-tl-gap.end { left: auto; right: -5px; }
.anim-tl-gap:hover { color: var(--accent); background: var(--bg3); }
.anim-tl-num[draggable="true"] { cursor: grab; }
.anim-tl-num.drag-before { box-shadow: inset 2px 0 0 var(--accent); }
.anim-tl-num.drag-after { box-shadow: inset -2px 0 0 var(--accent); }
.anim-tl-grid:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
```

- [ ] **Step 4: Run to verify they pass**

Run: `node --test tests/animation-timeline.test.mjs tests/drawing-engine-delete.test.mjs tests/architecture.test.mjs`, then `node --test tests/*.mjs`.
Expected: PASS, suite green.

- [ ] **Step 5: Ledger line.**

---

### Task 6: Per-column duration

**Files:**
- Create: `js/components/panels/frame-duration-input.js`
- Modify: `js/modes/sprites/presentation/timeline-presenter.js` (uses it; behavior unchanged)
- Modify: `js/modes/animations/presentation/animation-timeline-presenter.js`
- Test: `tests/animation-timeline.test.mjs`; the existing sprites timeline tests (`git grep -l "setAnimationFrameDuration\|timeline-cell-ms-caption\|stepInput" tests`) stay green.

**Interfaces:**
- Produces: `buildFrameDurationInput(sheet, anim, entry, index, dispatch) → HTMLElement[]`. It returns the controls the sprites cell appends today:
  - fps-primary animations: a step input plus an `.timeline-cell-ms-caption` span;
  - otherwise: a duration input.

  Each `change` clamps to ≥ 1 and dispatches `sprites.setAnimationFrameStep` or `sprites.setAnimationFrameDuration` exactly as today. Clicks stop propagation.
- The animations timeline header shows `.anim-tl-duration`: a label "Frame" followed by these controls for the selected column. It is empty when no column is selected.

- [ ] **Step 1: Write the failing test** — append:

```js
test('the header edits the selected column\'s duration as one undoable step', async () => {
  const { run } = await reset();
  const input = dock.querySelector('.anim-tl-duration').querySelector('input');
  input.value = '250'; input.fire('change');
  assert.equal(run.frames[0].duration, 250);
  host.history.undo();
  assert.equal(run.frames[0].duration, null);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test tests/animation-timeline.test.mjs` → FAIL (no `.anim-tl-duration`).

- [ ] **Step 3: Implement**:
  - Move the `if (anim.baseFps != null) … else …` block of the sprites `buildCell` into `buildFrameDurationInput`. The sprites cell becomes `controls.append(...buildFrameDurationInput(sheet, anim, entry, index, dispatch))`.
  - In the animations timeline, `render()` refills `durationBox` from the selected column: `const col = cols[selectedIndex]`. When `col` exists, it finds `anim` by `col.animationId` and appends `buildFrameDurationInput(s, anim, anim.frames[col.index], col.index, dispatch)`.
  - CSS: `.anim-tl-duration { display: flex; align-items: center; gap: 4px; font-size: 11px; } .anim-tl-duration input { width: 52px; }`.

- [ ] **Step 4: Run** `node --test tests/animation-timeline.test.mjs` plus the sprites timeline test files found above → PASS.

- [ ] **Step 5: Ledger line.**

---

### Task 7: Docs and browser check

**Files:**
- Modify: `README.md` ("Animations workbench" section: rows, cels, expanded mode, gestures, keys, Layers panel hidden).
- Modify: `docs/ARCHITECTURE.md`:
  - module counts (re-count with PowerShell, `(Get-ChildItem -Recurse -File js/<layer> -Filter *.js).Count`),
  - `components/panels/layer-tree.js`,
  - `components/panels/frame-duration-input.js`,
  - the animations row of the modes table.
- Modify: the spec, appending `## Implementation notes (Phase 3)` with the rulings.

- [ ] **Step 1: Browser check (no drags).** Start `serve.ps1` if it is not running and load `/?autotest`. Then:
  1. Click the Animations tab.
  2. Confirm the Layers panel is gone and the timeline has a layer row with dots.
  3. Create an animation if none exists.
  4. Click a gap `+`, then confirm the new column.
  5. Paint a pixel and confirm its cel dot fills.
  6. Undo.
  7. Widen the size control past 40 and confirm the thumbnails and the composite row.
  8. Click Add folder, then collapse it.
  9. Focus the timeline, press ArrowRight, then Delete.
  10. Check the console for errors.
- [ ] **Step 2: Docs** as listed.
- [ ] **Step 3: Ledger line.**
