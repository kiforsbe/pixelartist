# Animations Phase 1 (Model and Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace strips/segments/accepted animations with a v4 model in which an animation is `auto` (laid out by a deterministic packer, one band of rows per animation) or `manual`. Ship the layout engine, the `animations.*` commands, v2/v3→v4 conversion, layer locking, and Sprite Sheets pinning, with the app working at every task boundary.

**Architecture:** The sheet (layer tree + frame rects + animations) stays the only stored data. A pure planner (`planLayout`, domain layer) computes target positions for every auto frame. A core primitive (`applyLayout`) grows the sheet and moves pixels on every layer, returning an undo record. Every layout-changing command makes its structural change, plans, applies, and records one history step through a shared `runLayoutCommand` helper. The old strip machinery is then deleted from the commands, UI and model, in that order.

**Tech Stack:** Vanilla ES modules (no build step), `node --test`, Windows PowerShell.

**Spec:** `docs/superpowers/specs/2026-10-09-animations-workbench-design.md`. This plan implements §1, §2, §4 and §5. The workbench UI in §3 is Phases 2 and 3.

## Global Constraints

- No new dependencies and no build step. ES modules only.
- Run tests with `node --test tests/<file>.test.mjs` in PowerShell. Run only the files a task touches. Never run the whole suite as a sanity check.
- `PROJECT_VERSION` becomes `4`. The loader accepts versions `2`, `3` and `4`.
- `MAX_DIM = 4096`.
- New setting `sheetMaxWidth`: integer `1..MAX_DIM`, defaulting to `spriteSheetW`.
- `anim.layout` is `'auto'` or `'manual'`. `anim.cell` is `{ w, h }` (auto only) or `null`.
- Layout refusal text, verbatim: `Not enough room on the sheet: raise the maximum sheet width or trim the sheet`.
- Pinned-frame hint, verbatim: `Auto-laid-out — edit in Animations, or Make manual`.
- Converted-layer folder name, verbatim: `Covered by strips (converted)`.
- Presentation code (`**/presentation/**`, `js/components/**`) dispatches commands by id. It never imports `application/commands/**`; `tests/architecture.test.mjs` enforces this.
- A command that can refuse returns `{ ok: false, reason }`, changes nothing and pushes no history entry. On success it returns `{ ok: true, ... }`. Each command is exactly one undo step.
- Commits: run `git commit` only if the user asked for commits in the request that started this execution. Otherwise skip each "Commit" step and leave the work uncommitted. Never push.

## Deviations from the spec (decided while planning)

The final task (T9) writes these back into the spec.

1. **Band width** uses only the columns a band needs: `min(cols, distinct)·cell.w`. Reserving `cols·cell.w` would widen a narrow sheet to `sheetMaxWidth` for a one-frame animation.
2. **Stray-pixel obstacles** are computed exactly, per row, instead of as connected-component bounding boxes. `rowMinX[y]` is the smallest x of a non-empty pixel in row `y` that lies in no frame rect. A band `[0,W)×[y,y+H)` is blocked if `min(rowMinX[y..y+H)) < W`.
3. **Covered pixels** go into a hidden *folder* named `Covered by strips (converted)`, with one hidden layer per source layer. A single layer would lose pixels where two source layers overlap, which D6 forbids.
4. **Command registration:** the `animations.*` ids are registered for both the `sprites` and `animations` modes. The Sprite Sheets workbench needs Make manual, the shared pivot, and deleting an auto frame. The `animations` mode itself arrives in Phase 2; its id is already in the `when` predicate.
5. **`animations.delete` on a manual animation** behaves as `sprites.deleteAnimation` does today: it keeps the frames. Only auto animations delete their unreferenced frames and pixels.
6. **`animations.duplicate`** requires an auto source. A manual source is refused with "Auto-layout this animation first".
7. **`animations.autoLayout`** needs an explicit canvas size when frames differ in size **or pivot**, because equal pivots are an auto invariant. v3 conversion likewise requires equal pivots for `auto`.

## Review Focus

These five conditions are implied by the spec but not exercised by any task's own feature tests. Each line names the task that adds its test.

1. **A v3 strip whose group layers hold pixels outside the strip's frames, or two accepted strips with overlapping frames:** the converted sheet must render pixel-identical to v3. Test in T6 ("converts overlapping accepted strips without changing the render").
2. **Undo then redo of a command that grew the sheet:** sheet size and every layer byte return exactly. Test in T4 ("growth is undone and redone byte-exactly").
3. **Deleting the last entry of an auto animation:** the animation survives with zero frames; later layouts skip it. Tests in T2 ("an auto animation with no frames reserves nothing") and T4 ("deleting the last entry keeps an empty animation").
4. **A sheet narrower than `sheetMaxWidth` with a short band:** the sheet does not widen past the band. Test in T2 ("a short band does not widen a narrow sheet").
5. **Painting, filling or floating on a locked layer:** no pixel changes. Test in T8 ("locked layers are not editable and are skipped by all-layer captures").

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `js/core/model.js` | modify | `locked`, `sheetMaxWidth`, `resizeSheetCanvas`, `normalizeAnimation`, v4 (de)serialization; later removal of animation-group APIs |
| `js/domain/sprites/auto-layout.js` | create | Pure planner: `planLayout`, `distinctFrameIds`, `autoAnimationOf`, `isPinnedFrame`, message constants |
| `js/core/sheet-layout.js` | create | `applyLayout`, `undoLayout`, `redoLayout`: pixel moves across all layers plus sheet growth |
| `js/core/legacy-animations.js` | create | `convertLegacySheet`: v2/v3 strip classification and covered-pixel move |
| `js/modes/sprites/application/commands/animation-layout-commands.js` | create | `runLayoutCommand` and every `animations.*` command |
| `js/modes/sprites/contributions.js` | modify | Register `animations.*`; drop strip commands; route pinned deletes |
| `js/domain/sprites/frames.js` | modify | Gains `frameAt` (moved from frame-geometry) for shared use |
| `js/modes/sprites/application/commands/{frame,frame-metadata,animation-frame,animation-lifecycle,layer}-commands.js` | modify | Pinning refusals; drop strip/group code; `toggleLayerLocked` |
| `js/modes/sprites/presentation/{frame-tool-presenter,frame-overlay-renderer,frames-panel,timeline-presenter}.js` | modify | Strip UI removed; pinned frames; Make manual |
| `js/components/canvas/{drawing-engine,float-session,sheet-overlays}.js`, `js/components/panels/layers-panel.js`, `js/features/workbench/editor-workbench.js`, `js/features/transforms/filter-controller.js`, `js/host/document-helpers.js` | modify | Retire the accept flow and animation layer scoping; lock checks |
| `index.html`, `js/features/project/project-controller.js` | modify | Project Settings field for `sheetMaxWidth` |
| `js/core/strips.js`, `js/domain/sprites/strips.js`, `js/modes/sprites/application/frame-pixel-motion.js`, `js/modes/sprites/application/commands/{strip-commands,animation-commands}.js`, `js/features/animations/commands.js` | delete | Strip machinery and the legacy façade |

---

### Task 1: Model foundations (`locked`, `sheetMaxWidth`, `resizeSheetCanvas`, layout fields)

**Files:**
- Modify: `js/core/model.js` (DEFAULT_SETTINGS at line 14, `MAX_DIM` at line 63, `createLayerNode` at 107, `addAnimation` at 462, `serializeGroup` at 531, `deserializeGroup` at 557, `migrateLegacyLayers` at 575, `serializeProject` at 629, `deserializeProject` at 677, `validateProjectJson` at 745)
- Modify: `index.html:81-84`, `js/features/project/project-controller.js` (lines 84-91, 319, 385-390)
- Test: `tests/sheet-model-foundations.test.mjs` (create)

**Interfaces:**
- Produces:
  - `export const MAX_DIM`
  - `resizeSheetCanvas(sheet, width, height): void`: crops or pads every layer and keeps content at the top-left. Throws outside `1..MAX_DIM`.
  - Layer nodes carry `locked: boolean`.
  - `DEFAULT_SETTINGS.sheetMaxWidth = 256`.
  - `addAnimation(...)` results carry `layout: 'manual', cell: null`.

- [ ] **Step 1: Write the failing tests**

Create `tests/sheet-model-foundations.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, createSheet, createLayerNode, sheetLayers, addAnimation, resizeSheetCanvas,
  serializeProject, deserializeProject, validateProjectJson, DEFAULT_SETTINGS, MAX_DIM,
} from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255];

function roundTrip(project) {
  const { json, images } = serializeProject(project);
  return deserializeProject(JSON.parse(JSON.stringify(json)), new Map(images.map(i => [i.path, i.bitmap])));
}

test('new layers start unlocked', () => {
  assert.equal(createLayerNode('L', 4, 4).locked, false);
});

test('sheetMaxWidth defaults to the default sprite sheet width', () => {
  assert.equal(DEFAULT_SETTINGS.sheetMaxWidth, DEFAULT_SETTINGS.spriteSheetW);
  assert.equal(MAX_DIM, 4096);
});

test('new animations are manual with no cell', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const anim = addAnimation(sheet, 'walk', false, project.settings);
  assert.equal(anim.layout, 'manual');
  assert.equal(anim.cell, null);
});

test('resizeSheetCanvas grows every layer and keeps pixels at their coordinates', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  sheet.layerTree.children.push(createLayerNode('top', 4, 4));
  const [bottom, top] = sheetLayers(sheet);
  setPixel(bottom.bitmap, 3, 3, RED);
  resizeSheetCanvas(sheet, 8, 6);
  assert.deepEqual([sheet.width, sheet.height], [8, 6]);
  for (const l of [bottom, top]) assert.deepEqual([l.bitmap.width, l.bitmap.height], [8, 6]);
  assert.deepEqual(getPixel(bottom.bitmap, 3, 3), RED);
  assert.deepEqual(getPixel(bottom.bitmap, 7, 5), [0, 0, 0, 0]);
});

test('resizeSheetCanvas shrinks by cropping the right and bottom', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const [layer] = sheetLayers(sheet);
  setPixel(layer.bitmap, 1, 1, RED);
  setPixel(layer.bitmap, 6, 6, RED);
  resizeSheetCanvas(sheet, 4, 4);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), RED);
  assert.equal(layer.bitmap.data.length, 4 * 4 * 4);
});

test('resizeSheetCanvas rejects sizes outside 1..MAX_DIM', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  assert.throws(() => resizeSheetCanvas(sheet, 0, 4), /1\.\.4096/);
  assert.throws(() => resizeSheetCanvas(sheet, 4, MAX_DIM + 1), /1\.\.4096/);
});

test('locked and sheetMaxWidth survive a save/load round trip', () => {
  const project = createProject('t');
  project.settings.sheetMaxWidth = 128;
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  sheetLayers(sheet)[0].locked = true;
  const loaded = roundTrip(project);
  assert.equal(loaded.settings.sheetMaxWidth, 128);
  assert.equal(sheetLayers(loaded.sheets[0])[0].locked, true);
});

test('a file without sheetMaxWidth loads with spriteSheetW as the default', () => {
  const project = createProject('t', { ...DEFAULT_SETTINGS, spriteSheetW: 320 });
  delete project.settings.sheetMaxWidth;
  createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const { json, images } = serializeProject(project);
  delete json.settings.sheetMaxWidth;
  json.version = 3; // only pre-v4 files may omit it (Task 6 makes it required for v4)
  const loaded = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.equal(loaded.settings.sheetMaxWidth, 320);
});

test('validateProjectJson rejects an out-of-range sheetMaxWidth', () => {
  const project = createProject('t');
  createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const { json } = serializeProject(project);
  json.settings.sheetMaxWidth = 0;
  assert.match(validateProjectJson(json).error, /sheetMaxWidth/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/sheet-model-foundations.test.mjs`
Expected: FAIL. The import of `resizeSheetCanvas`/`MAX_DIM` reports "does not provide an export named".

- [ ] **Step 3: Implement in `js/core/model.js`**

3a. In `DEFAULT_SETTINGS`, after `durationMs: 100,`, add:

```js
  // Widest the Animations workbench's auto layout may pack a band of frames
  // (js/domain/sprites/auto-layout.js). Files saved before it existed load
  // with spriteSheetW instead (deserializeProject).
  sheetMaxWidth: 256,
```

3b. Change `const MAX_DIM = 4096;` to `export const MAX_DIM = 4096;`.

3c. Replace `createLayerNode`:

```js
export function createLayerNode(name, width, height) {
  return {
    id: newId('ly'), type: LAYER, name, visible: true, opacity: 1, locked: false,
    bitmap: createBitmap(width, height),
  };
}
```

3d. After `sheetLayers` (line 199), add:

```js
// Crops or pads every layer to width x height, keeping content at its
// coordinates (anchored top-left). The auto-layout engine grows a sheet with
// it and undo shrinks the sheet back (js/core/sheet-layout.js).
export function resizeSheetCanvas(sheet, width, height) {
  if (!validImportDimension(width) || !validImportDimension(height))
    throw new Error(`sheet size must be 1..${MAX_DIM}`);
  if (width === sheet.width && height === sheet.height) return;
  const keepW = Math.min(width, sheet.width), keepH = Math.min(height, sheet.height);
  for (const layer of sheetLayers(sheet)) {
    const next = createBitmap(width, height);
    const src = layer.bitmap.data;
    for (let y = 0; y < keepH; y++)
      next.data.set(src.subarray(y * sheet.width * 4, (y * sheet.width + keepW) * 4), y * width * 4);
    layer.bitmap = next;
  }
  sheet.width = width;
  sheet.height = height;
}
```

3e. In `addAnimation`, add `layout: 'manual', cell: null,` to the object literal, after `layerGroupId: null,`.

3f. In `serializeGroup`, change the layer branch's return to:

```js
        return { id: c.id, type: LAYER, name: c.name, visible: c.visible, opacity: c.opacity, locked: !!c.locked, image: path };
```

3g. In `deserializeGroup`, change the layer push to:

```js
      group.children.push({ id: c.id, type: LAYER, name: c.name, visible: c.visible, opacity: c.opacity, locked: !!c.locked, bitmap });
```

3h. In `migrateLegacyLayers`, change the mapped layer to:

```js
      return { id: l.id, type: LAYER, name: l.name, visible: l.visible, opacity: l.opacity, locked: false, bitmap };
```

3i. In `serializeProject`, replace `settings: { ...project.settings },` with:

```js
    settings: { ...project.settings, sheetMaxWidth: project.settings.sheetMaxWidth ?? project.settings.spriteSheetW },
```

3j. In `deserializeProject`'s `settings` object, add `sheetMaxWidth: json.settings.spriteSheetW,` immediately **before** `...json.settings,` so a saved value wins.

3k. In `validateProjectJson`, after the `durationMs` check, add:

```js
  if (json.settings.sheetMaxWidth !== undefined && !validImportDimension(json.settings.sheetMaxWidth))
    return { ok: false, error: `settings.sheetMaxWidth must be an integer in 1..${MAX_DIM}` };
```

- [ ] **Step 4: Add the Project Settings field**

In `index.html`, after the `ps-sprite-lock` button line (line 84), add:

```html
    <span>Max layout width</span><input id="ps-sheet-max-w" type="number" min="1" max="4096" value="256">
    <span style="grid-column: 3 / span 3" class="dlg-hint">Auto-laid-out animations wrap at this width</span>
```

In `js/features/project/project-controller.js`:
- After `const psSpriteH = ...` (line 85), add `const psSheetMaxW = document.getElementById('ps-sheet-max-w');`.
- After `psSpriteH.value = String(settings.spriteSheetH);` (line 320), add `psSheetMaxW.value = String(settings.sheetMaxWidth ?? settings.spriteSheetW);`.
- In the save handler's `dims` object (line 386), add `sheetMaxWidth: sheetDimField(psSheetMaxW),` after the `spriteSheetW/spriteSheetH` line.

`dims` is spread into `afterSettings`, and any `null` field already triggers the "valid positive numbers" alert, so nothing else changes.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test tests/sheet-model-foundations.test.mjs tests/model.test.mjs`
Expected: PASS. `model.test.mjs` must still pass, because every change here is additive.

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add js/core/model.js index.html js/features/project/project-controller.js tests/sheet-model-foundations.test.mjs
git commit -m "feat: add layer lock, sheetMaxWidth and resizeSheetCanvas to the sheet model"
```

---

### Task 2: `planLayout` (pure planner)

**Files:**
- Create: `js/domain/sprites/auto-layout.js`
- Test: `tests/auto-layout.test.mjs` (create)

**Interfaces:**
- Consumes: `sheetLayers` from `js/core/model.js`.
- Produces:
  - `NO_ROOM`: the refusal string from Global Constraints.
  - `PINNED_HINT`: the pinned-frame string.
  - `distinctFrameIds(anim): string[]`, in order of first appearance.
  - `autoAnimationOf(sheet, frameId): anim | null`
  - `isPinnedFrame(sheet, frameId): boolean`
  - `planLayout(sheet, { maxWidth, maxHeight, fresh = new Set(), ignoreRects = [] })` returns either `{ ok: true, rects: Map<frameId,{x,y}>, size: {w,h}, moves: [{frameId, from:{x,y}, to:{x,y}}] }` or `{ ok: false, reason }`.
    - `fresh` names frames whose current rect holds none of their pixels: frames being created, or whose content is being replaced.
    - `ignoreRects` are rects about to be cleared. Pixels inside them are not obstacles.

- [ ] **Step 1: Write the failing tests**

Create `tests/auto-layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel } from '../js/core/pixels.js';
import {
  planLayout, distinctFrameIds, autoAnimationOf, isPinnedFrame, NO_ROOM,
} from '../js/domain/sprites/auto-layout.js';

const RED = [255, 0, 0, 255];

function sheetWith(w, h) {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: w, height: h, kind: 'sprite' });
  return { sheet, layer: sheetLayers(sheet)[0] };
}
function frame(sheet, id, x, y, w = 16, h = 16) {
  const f = { id, name: id, x, y, w, h, pivotX: 0, pivotY: 0 };
  sheet.frames.push(f);
  return f;
}
function anim(sheet, id, frameIds, { layout = 'auto', cell = { w: 16, h: 16 } } = {}) {
  const a = {
    id, name: id, loop: true, baseDuration: 100, layout, cell: layout === 'auto' ? cell : null,
    frames: frameIds.map(frameId => ({ frameId, duration: null, step: null })),
  };
  sheet.animations.push(a);
  return a;
}
const opts = (maxWidth = 64, maxHeight = 4096) => ({ maxWidth, maxHeight });

test('distinctFrameIds keeps the order of first appearance', () => {
  assert.deepEqual(distinctFrameIds({ frames: [{ frameId: 'b' }, { frameId: 'a' }, { frameId: 'b' }] }), ['b', 'a']);
});

test('autoAnimationOf and isPinnedFrame only see auto animations', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 0, 0); frame(sheet, 'm', 16, 0);
  const run = anim(sheet, 'run', ['a']);
  anim(sheet, 'loose', ['m'], { layout: 'manual' });
  assert.equal(autoAnimationOf(sheet, 'a'), run);
  assert.equal(autoAnimationOf(sheet, 'm'), null);
  assert.equal(isPinnedFrame(sheet, 'a'), true);
  assert.equal(isPinnedFrame(sheet, 'm'), false);
});

test('a single auto animation fills a band from the origin in timeline order', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 32, 32); frame(sheet, 'b', 0, 48);
  anim(sheet, 'run', ['b', 'a', 'b']);
  const plan = planLayout(sheet, opts());
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.rects.get('b'), { x: 0, y: 0 });
  assert.deepEqual(plan.rects.get('a'), { x: 16, y: 0 });
  assert.deepEqual(plan.size, { w: 64, h: 64 });
});

test('a band wraps at maxWidth into extra rows', () => {
  const { sheet } = sheetWith(48, 64);
  ['f0', 'f1', 'f2', 'f3', 'f4'].forEach((id, i) => frame(sheet, id, (i % 3) * 16, 32 + Math.floor(i / 3) * 16));
  anim(sheet, 'run', ['f0', 'f1', 'f2', 'f3', 'f4']);
  const plan = planLayout(sheet, opts(48));
  assert.deepEqual(['f0', 'f1', 'f2', 'f3', 'f4'].map(id => plan.rects.get(id)),
    [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 32, y: 0 }, { x: 0, y: 16 }, { x: 16, y: 16 }]);
});

test('bands stack in sheet.animations order', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 40, 40); frame(sheet, 'b', 40, 40); frame(sheet, 'c', 0, 0, 8, 8);
  anim(sheet, 'run', ['a', 'b']);
  anim(sheet, 'idle', ['c'], { cell: { w: 8, h: 8 } });
  const plan = planLayout(sheet, opts());
  assert.deepEqual(plan.rects.get('c'), { x: 0, y: 16 });
});

test('manual frames are obstacles', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'm', 0, 0);
  anim(sheet, 'loose', ['m'], { layout: 'manual' });
  frame(sheet, 'a', 40, 40);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 16 });
});

test('stray pixels outside every frame push a band below them', () => {
  const { sheet, layer } = sheetWith(64, 64);
  setPixel(layer.bitmap, 5, 3, RED);
  frame(sheet, 'a', 32, 32);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 4 });
});

test('stray pixels right of the band width do not block it', () => {
  const { sheet, layer } = sheetWith(64, 64);
  setPixel(layer.bitmap, 40, 0, RED);
  frame(sheet, 'a', 0, 32); frame(sheet, 'b', 16, 32);
  anim(sheet, 'run', ['a', 'b']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 0 });
});

test("an auto frame's own pixels are not obstacles", () => {
  const { sheet, layer } = sheetWith(64, 64);
  frame(sheet, 'a', 32, 32);
  setPixel(layer.bitmap, 33, 33, RED);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 0 });
});

test("fresh frames' rects do not hide strays; ignoreRects do", () => {
  const { sheet, layer } = sheetWith(64, 64);
  frame(sheet, 'n', 0, 0);
  setPixel(layer.bitmap, 2, 2, RED);
  anim(sheet, 'run', ['n']);
  assert.deepEqual(planLayout(sheet, { ...opts(), fresh: new Set(['n']) }).rects.get('n'), { x: 0, y: 3 });
  assert.deepEqual(planLayout(sheet, { ...opts(), fresh: new Set(['n']), ignoreRects: [{ x: 0, y: 0, w: 4, h: 4 }] }).rects.get('n'), { x: 0, y: 0 });
});

test('the sheet grows to fit but never shrinks', () => {
  const tall = sheetWith(64, 16);
  ['a', 'b', 'c', 'd', 'e'].forEach(id => frame(tall.sheet, id, 0, 0));
  anim(tall.sheet, 'run', ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(planLayout(tall.sheet, opts()).size, { w: 64, h: 32 });
  const big = sheetWith(128, 128);
  frame(big.sheet, 'a', 0, 0);
  anim(big.sheet, 'run', ['a']);
  assert.deepEqual(planLayout(big.sheet, opts()).size, { w: 128, h: 128 });
});

test('a short band does not widen a narrow sheet', () => {
  const { sheet } = sheetWith(32, 32);
  frame(sheet, 'a', 0, 0);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts(256)).size, { w: 32, h: 32 });
});

test('an auto animation with no frames reserves nothing', () => {
  const { sheet } = sheetWith(64, 64);
  anim(sheet, 'empty', []);
  frame(sheet, 'a', 40, 40);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 0 });
});

test('refuses when a cell is wider than maxWidth or no room is left below maxHeight', () => {
  const wide = sheetWith(64, 64);
  frame(wide.sheet, 'a', 0, 0, 80, 16);
  anim(wide.sheet, 'run', ['a'], { cell: { w: 80, h: 16 } });
  assert.deepEqual(planLayout(wide.sheet, opts(64)), { ok: false, reason: NO_ROOM });
  const full = sheetWith(64, 16);
  frame(full.sheet, 'm', 0, 0);
  frame(full.sheet, 'a', 32, 0);
  anim(full.sheet, 'run', ['a']);
  assert.deepEqual(planLayout(full.sheet, opts(64, 16)), { ok: false, reason: NO_ROOM });
});

test('moves list only frames that change position, and planning is deterministic', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 0, 0); frame(sheet, 'b', 40, 40);
  anim(sheet, 'run', ['a', 'b']);
  const plan = planLayout(sheet, opts());
  assert.deepEqual(plan.moves, [{ frameId: 'b', from: { x: 40, y: 40 }, to: { x: 16, y: 0 } }]);
  assert.deepEqual(planLayout(sheet, opts()), plan);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/auto-layout.test.mjs`
Expected: FAIL, "Cannot find module .../auto-layout.js".

- [ ] **Step 3: Implement `js/domain/sprites/auto-layout.js`**

```js
// Auto layout: one band of rows per auto animation, stacked down the sheet
// in sheet.animations order, each band at x = 0 and the smallest free y.
// Pure: reads the sheet, never writes it. js/core/sheet-layout.js applies a
// plan. See docs/superpowers/specs/2026-10-09-animations-workbench-design.md §2.
import { sheetLayers } from '../../core/model.js';

export const NO_ROOM = 'Not enough room on the sheet: raise the maximum sheet width or trim the sheet';
export const PINNED_HINT = 'Auto-laid-out — edit in Animations, or Make manual';

export function distinctFrameIds(anim) {
  const seen = new Set();
  const out = [];
  for (const entry of anim.frames) {
    if (seen.has(entry.frameId)) continue;
    seen.add(entry.frameId);
    out.push(entry.frameId);
  }
  return out;
}

export function autoAnimationOf(sheet, frameId) {
  return sheet.animations.find(a => a.layout === 'auto' && a.frames.some(e => e.frameId === frameId)) ?? null;
}

export function isPinnedFrame(sheet, frameId) {
  return !!autoAnimationOf(sheet, frameId);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// rowMinX[y]: smallest x of a non-empty pixel (any layer) in row y that lies
// in no frame rect (fresh frames excluded) and no ignore rect; Infinity if
// none. A band [0, W) x [y, y + H) is blocked iff some row in it has
// rowMinX < W -- exact, and cheap because each row scan stops at the
// current minimum.
function strayRowMinX(sheet, fresh, ignoreRects) {
  const W = sheet.width, H = sheet.height;
  const covered = new Uint8Array(W * H);
  const cover = r => {
    const x0 = Math.max(0, r.x), x1 = Math.min(W, r.x + r.w);
    if (x1 <= x0) return;
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) covered.fill(1, y * W + x0, y * W + x1);
  };
  for (const f of sheet.frames) if (!fresh.has(f.id)) cover(f);
  for (const r of ignoreRects) cover(r);
  const rowMinX = new Array(H).fill(Infinity);
  for (const layer of sheetLayers(sheet)) {
    const d = layer.bitmap.data;
    for (let y = 0; y < H; y++) {
      const limit = Math.min(W, rowMinX[y]);
      for (let x = 0; x < limit; x++) {
        const i = y * W + x;
        if (d[i * 4 + 3] !== 0 && !covered[i]) { rowMinX[y] = x; break; }
      }
    }
  }
  return rowMinX;
}

// Smallest y >= 0 where `band` (x = 0) overlaps no rect and no stray row,
// or null when it would cross maxHeight. Each blocked probe jumps y past
// the blocker, so the loop always advances.
function findBandY(band, rects, rowMinX, maxHeight) {
  let y = 0;
  while (y + band.h <= maxHeight) {
    const probe = { ...band, y };
    let next = y;
    for (const r of rects) if (overlaps(probe, r)) next = Math.max(next, r.y + r.h);
    for (let row = Math.min(y + band.h, rowMinX.length) - 1; row >= y; row--) {
      if (rowMinX[row] < band.w) { next = Math.max(next, row + 1); break; }
    }
    if (next === y) return y;
    y = next;
  }
  return null;
}

export function planLayout(sheet, { maxWidth, maxHeight, fresh = new Set(), ignoreRects = [] }) {
  const framesById = new Map(sheet.frames.map(f => [f.id, f]));
  const autoAnims = sheet.animations.filter(a => a.layout === 'auto' && a.cell);
  const autoIds = new Set(autoAnims.flatMap(a => a.frames.map(e => e.frameId)));
  const obstacles = sheet.frames.filter(f => !autoIds.has(f.id)).map(({ x, y, w, h }) => ({ x, y, w, h }));
  const rowMinX = strayRowMinX(sheet, fresh, ignoreRects);
  const placed = [];
  const rects = new Map();
  let sizeW = sheet.width, sizeH = sheet.height;
  for (const anim of autoAnims) {
    const ids = distinctFrameIds(anim).filter(id => framesById.has(id));
    if (!ids.length) continue;
    const { w: cw, h: ch } = anim.cell;
    if (cw > maxWidth) return { ok: false, reason: NO_ROOM };
    const cols = Math.max(1, Math.floor(maxWidth / cw));
    const band = { x: 0, y: 0, w: Math.min(cols, ids.length) * cw, h: Math.ceil(ids.length / cols) * ch };
    const y = findBandY(band, [...obstacles, ...placed], rowMinX, maxHeight);
    if (y == null) return { ok: false, reason: NO_ROOM };
    band.y = y;
    placed.push(band);
    ids.forEach((id, i) => rects.set(id, { x: (i % cols) * cw, y: y + Math.floor(i / cols) * ch }));
    sizeW = Math.max(sizeW, band.w);
    sizeH = Math.max(sizeH, band.y + band.h);
  }
  const moves = [];
  for (const [frameId, to] of rects) {
    const f = framesById.get(frameId);
    if (f.x !== to.x || f.y !== to.y) moves.push({ frameId, from: { x: f.x, y: f.y }, to });
  }
  return { ok: true, rects, size: { w: sizeW, h: sizeH }, moves };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/auto-layout.test.mjs tests/architecture.test.mjs`
Expected: PASS. The architecture test confirms domain→core imports are allowed.

- [ ] **Step 5: Commit (only if authorized)**

```bash
git add js/domain/sprites/auto-layout.js tests/auto-layout.test.mjs
git commit -m "feat: add the auto-layout planner"
```

---

### Task 3: `applyLayout`, `undoLayout`, `redoLayout`

**Files:**
- Create: `js/core/sheet-layout.js`
- Test: `tests/sheet-layout.test.mjs` (create)

**Interfaces:**
- Consumes: `planLayout`'s ok result shape (T2) and `resizeSheetCanvas` (T1).
- Produces:
  - `applyLayout(sheet, plan, { content = new Map(), clears = [] } = {})` returns either `{ ok: true, record }` or `{ ok: false, reason }`.
    - `content: Map<frameId, Map<layerId, bitmap> | null>`: these frames get the given pixels at their new rect instead of carrying their old ones. `null` (or a missing layer) means blank.
    - `clears: {x,y,w,h}[]`: rects emptied on every editable layer.
    - `record = { sizeBefore, sizeAfter, coords: [{frameId, before:{x,y}, after:{x,y}}], patches: [{layerId, rect, before, after}] }`.
  - `undoLayout(sheet, record)` and `redoLayout(sheet, record)`: restore pixels, frame x/y and sheet size exactly.

- [ ] **Step 1: Write the failing tests**

Create `tests/sheet-layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, sheetLayers, createLayerNode } from '../js/core/model.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { applyLayout, undoLayout, redoLayout } from '../js/core/sheet-layout.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function sheetWith(w, h) {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: w, height: h, kind: 'sprite' });
  return { sheet, layer: sheetLayers(sheet)[0] };
}
function frame(sheet, id, x, y, w = 16, h = 16) {
  const f = { id, name: id, x, y, w, h, pivotX: 0, pivotY: 0 };
  sheet.frames.push(f);
  return f;
}
// entries: [frameId, from, to]
function plan(entries, size) {
  return {
    ok: true, size,
    rects: new Map(entries.map(([id, , to]) => [id, to])),
    moves: entries.filter(([, f, t]) => f.x !== t.x || f.y !== t.y).map(([frameId, from, to]) => ({ frameId, from, to })),
  };
}

test("swapping two frames carries each one's pixels across every layer", () => {
  const { sheet, layer } = sheetWith(32, 16);
  const top = createLayerNode('top', 32, 16);
  sheet.layerTree.children.push(top);
  frame(sheet, 'a', 0, 0); frame(sheet, 'b', 16, 0);
  setPixel(layer.bitmap, 1, 1, RED);
  setPixel(top.bitmap, 17, 2, BLUE);
  const r = applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 16, y: 0 }], ['b', { x: 16, y: 0 }, { x: 0, y: 0 }]], { w: 32, h: 16 }));
  assert.equal(r.ok, true);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), RED);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), NONE);
  assert.deepEqual(getPixel(top.bitmap, 1, 2), BLUE);
  assert.deepEqual(sheet.frames.map(f => [f.id, f.x]), [['a', 16], ['b', 0]]);
});

test('an overlapping shift never clobbers a frame before it is copied', () => {
  const { sheet, layer } = sheetWith(64, 16);
  [['a', RED], ['b', GREEN], ['c', BLUE]].forEach(([id, c], i) => { frame(sheet, id, i * 16, 0); setPixel(layer.bitmap, i * 16, 0, c); });
  applyLayout(sheet, plan(['a', 'b', 'c'].map((id, i) => [id, { x: i * 16, y: 0 }, { x: (i + 1) * 16, y: 0 }]), { w: 64, h: 16 }));
  assert.deepEqual([0, 16, 32, 48].map(x => getPixel(layer.bitmap, x, 0)), [NONE, RED, GREEN, BLUE]);
});

test('growth is applied, and undo/redo restore size, pixels and coords byte-exactly', () => {
  const { sheet, layer } = sheetWith(16, 16);
  frame(sheet, 'a', 0, 0);
  setPixel(layer.bitmap, 3, 3, RED);
  const beforeData = layer.bitmap.data.slice();
  const r = applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 0, y: 16 }]], { w: 16, h: 32 }));
  assert.deepEqual([sheet.height, layer.bitmap.height], [32, 32]);
  assert.deepEqual(getPixel(layer.bitmap, 3, 19), RED);
  const afterData = layer.bitmap.data.slice();
  undoLayout(sheet, r.record);
  assert.equal(sheet.height, 16);
  assert.deepEqual(layer.bitmap.data, beforeData);
  assert.equal(sheet.frames[0].y, 0);
  redoLayout(sheet, r.record);
  assert.deepEqual(layer.bitmap.data, afterData);
  assert.equal(sheet.frames[0].y, 16);
});

test('refuses, changing nothing, when a locked layer has pixels that would move', () => {
  const { sheet, layer } = sheetWith(32, 16);
  layer.locked = true; layer.name = 'Ink';
  frame(sheet, 'a', 0, 0);
  setPixel(layer.bitmap, 2, 2, RED);
  const r = applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 16, y: 0 }]], { w: 32, h: 32 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Ink/);
  assert.deepEqual(getPixel(layer.bitmap, 2, 2), RED);
  assert.deepEqual([sheet.frames[0].x, sheet.height], [0, 16]);
});

test('an empty locked layer is skipped and left untouched', () => {
  const { sheet, layer } = sheetWith(32, 16);
  layer.locked = true;
  const paint = createLayerNode('paint', 32, 16);
  sheet.layerTree.children.push(paint);
  frame(sheet, 'a', 0, 0);
  setPixel(paint.bitmap, 1, 1, RED);
  assert.equal(applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 16, y: 0 }]], { w: 32, h: 16 })).ok, true);
  assert.deepEqual(getPixel(paint.bitmap, 17, 1), RED);
  assert.ok(layer.bitmap.data.every(v => v === 0));
});

test('content replaces a frame, null content blanks it, and clears empty rects', () => {
  const { sheet, layer } = sheetWith(64, 16);
  frame(sheet, 'a', 0, 0); frame(sheet, 'n', 0, 0); frame(sheet, 'z', 0, 0);
  setPixel(layer.bitmap, 1, 1, RED);
  setPixel(layer.bitmap, 40, 1, BLUE);
  setPixel(layer.bitmap, 50, 5, BLUE);
  const stamp = createBitmap(16, 16);
  setPixel(stamp, 0, 0, GREEN);
  const r = applyLayout(sheet,
    plan([['a', { x: 0, y: 0 }, { x: 0, y: 0 }], ['n', { x: 0, y: 0 }, { x: 16, y: 0 }], ['z', { x: 0, y: 0 }, { x: 48, y: 0 }]], { w: 64, h: 16 }),
    { content: new Map([['n', new Map([[layer.id, stamp]])], ['z', null]]), clears: [{ x: 32, y: 0, w: 16, h: 16 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), RED);
  assert.deepEqual(getPixel(layer.bitmap, 16, 0), GREEN);
  assert.deepEqual(getPixel(layer.bitmap, 40, 1), NONE);
  assert.deepEqual(getPixel(layer.bitmap, 50, 5), NONE);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/sheet-layout.test.mjs`
Expected: FAIL, "Cannot find module .../sheet-layout.js".

- [ ] **Step 3: Implement `js/core/sheet-layout.js`**

```js
// Applies an auto-layout plan (js/domain/sprites/auto-layout.js) to a sheet:
// grows it if needed, then moves every carried frame's pixels on every
// editable layer -- copy all, clear all, blit all, so swaps and overlapping
// shifts are safe -- and writes the frames' new x/y. Returns a record that
// undoLayout/redoLayout replay byte-exactly. Locked layers are never
// written; a plan that would move pixels out of one is refused up front.
import { findLayer, sheetLayers, resizeSheetCanvas } from './model.js';
import { copyRegion, blitRegion, fillRegion } from './pixels.js';

const CLEAR = [0, 0, 0, 0];

function hasPixels(bitmap, r) {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(bitmap.width, r.x + r.w), y1 = Math.min(bitmap.height, r.y + r.h);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (bitmap.data[(y * bitmap.width + x) * 4 + 3] !== 0) return true;
  return false;
}

export function applyLayout(sheet, plan, { content = new Map(), clears = [] } = {}) {
  const frames = new Map(sheet.frames.map(f => [f.id, f]));
  const carried = plan.moves
    .filter(m => !content.has(m.frameId))
    .map(m => ({ frame: frames.get(m.frameId), from: m.from, to: m.to }));
  const sources = [...carried.map(m => ({ x: m.from.x, y: m.from.y, w: m.frame.w, h: m.frame.h })), ...clears];
  const written = [...content.keys()].map(id => {
    const f = frames.get(id);
    const to = plan.rects.get(id) ?? f;
    return { id, x: to.x, y: to.y, w: f.w, h: f.h };
  });

  const layers = sheetLayers(sheet);
  for (const layer of layers) {
    if (layer.locked && [...sources, ...written].some(r => hasPixels(layer.bitmap, r)))
      return { ok: false, reason: `Layer "${layer.name}" is locked and has pixels that would move` };
  }

  const sizeBefore = { w: sheet.width, h: sheet.height };
  const sizeAfter = { w: Math.max(sheet.width, plan.size.w), h: Math.max(sheet.height, plan.size.h) };
  resizeSheetCanvas(sheet, sizeAfter.w, sizeAfter.h);

  const editable = layers.filter(l => !l.locked);
  const touched = [...sources, ...carried.map(m => ({ x: m.to.x, y: m.to.y, w: m.frame.w, h: m.frame.h })), ...written];
  const patches = editable.flatMap(layer =>
    touched.map(rect => ({ layerId: layer.id, rect, before: copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h), after: null })));

  for (const layer of editable) {
    const copies = carried.map(m => copyRegion(layer.bitmap, m.from.x, m.from.y, m.frame.w, m.frame.h));
    for (const r of sources) fillRegion(layer.bitmap, r.x, r.y, r.w, r.h, CLEAR);
    carried.forEach((m, i) => blitRegion(layer.bitmap, copies[i], m.to.x, m.to.y));
    for (const r of written) {
      fillRegion(layer.bitmap, r.x, r.y, r.w, r.h, CLEAR);
      const bitmap = content.get(r.id)?.get(layer.id);
      if (bitmap) blitRegion(layer.bitmap, bitmap, r.x, r.y);
    }
  }
  for (const p of patches) {
    const bitmap = findLayer(sheet.layerTree, p.layerId).bitmap;
    p.after = copyRegion(bitmap, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
  }

  const coords = [];
  for (const [id, to] of plan.rects) {
    const f = frames.get(id);
    coords.push({ frameId: id, before: { x: f.x, y: f.y }, after: { x: to.x, y: to.y } });
    f.x = to.x; f.y = to.y;
  }
  return { ok: true, record: { sizeBefore, sizeAfter, coords, patches } };
}

function writeCoords(sheet, record, key) {
  for (const c of record.coords) {
    const f = sheet.frames.find(fr => fr.id === c.frameId);
    if (f) { f.x = c[key].x; f.y = c[key].y; }
  }
}

function blitPatches(sheet, record, key) {
  for (const p of record.patches) {
    const layer = findLayer(sheet.layerTree, p.layerId);
    if (layer) blitRegion(layer.bitmap, p[key], p.rect.x, p.rect.y);
  }
}

export function undoLayout(sheet, record) {
  blitPatches(sheet, record, 'before');
  resizeSheetCanvas(sheet, record.sizeBefore.w, record.sizeBefore.h);
  writeCoords(sheet, record, 'before');
}

export function redoLayout(sheet, record) {
  resizeSheetCanvas(sheet, record.sizeAfter.w, record.sizeAfter.h);
  blitPatches(sheet, record, 'after');
  writeCoords(sheet, record, 'after');
}
```

`writeCoords` looks frames up in `sheet.frames`. A frame that the surrounding command removes is restored by that command's own structural snapshot (T4), not here.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/sheet-layout.test.mjs tests/architecture.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit (only if authorized)**

```bash
git add js/core/sheet-layout.js tests/sheet-layout.test.mjs
git commit -m "feat: add applyLayout with byte-exact undo for auto layout"
```

### Task 4: Layout command helper and the timeline commands (new, addFrame, linkFrame, deleteFrame, moveFrame)

**Files:**
- Create: `js/modes/sprites/application/commands/animation-layout-commands.js`
- Test: `tests/animation-layout-commands.test.mjs` (create)

**Interfaces:**
- Consumes:
  - From T2: `planLayout`, `distinctFrameIds`, `autoAnimationOf`, `NO_ROOM`.
  - From T3: `applyLayout`, `undoLayout`, `redoLayout`.
  - From T1: `MAX_DIM`.
  - `findSpriteSheet` and `runSheetCommand` from `./frame-commands.js`.
  - `addFrame` and `addAnimation(sheet, name, strip, defaults)` from `core/model.js`. T8 later drops the `strip` parameter.
- Produces (all return `{ ok: true, ... } | { ok: false, reason }`):
  - `newAutoAnimation(services, sheetId, { name?, w, h })` returns `{ ok, animationId, frameId }`.
  - `addAutoFrame(services, sheetId, animationId, at, { copyOf } = {})` returns `{ ok, frameId }`.
  - `linkAutoFrame(services, sheetId, animationId, at, frameId)`
  - `deleteAutoFrame(services, sheetId, animationId, index)`
  - `moveAutoFrame(services, sheetId, animationId, from, to)`: `to` is the index after removal, the same convention as `reorderAnimationFrame`.
  - `isFrameReferenced(project, sheet, frameId): boolean`
  - `layoutMaxWidth(settings): number`
  - Constants `NOT_AUTO` and `BAD_SIZE`.
  - Internal helpers reused by T5, all in the same file: `runLayoutCommand(services, sheetId, label, mutate)`, `findAnimation`, `animFrames`, `rectOf`, `frameContent`, `uniqueFrameName`, `sheetDocument`, `validSize`.

- [ ] **Step 1: Write the failing tests**

Create `tests/animation-layout-commands.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { NO_ROOM } from '../js/domain/sprites/auto-layout.js';
import {
  newAutoAnimation, addAutoFrame, linkAutoFrame, deleteAutoFrame, moveAutoFrame,
} from '../js/modes/sprites/application/commands/animation-layout-commands.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function setup({ width = 64, height = 64, maxWidth = 64 } = {}) {
  const project = createProject('t');
  project.settings.sheetMaxWidth = maxWidth;
  const sheet = createSheet(project, { name: 'S', width, height, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
  return {
    project, sheet, services,
    bitmap: () => sheetLayers(sheet)[0].bitmap,
    selection: () => services.selections.get({ kind: 'sprite-sheet', id: sheet.id }) ?? {},
  };
}
// An auto animation "run" with `count` frames, laid out left to right.
function runWith(ctx, count, cell = { w: 16, h: 16 }) {
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run', ...cell });
  const anim = ctx.sheet.animations.at(-1);
  for (let i = 1; i < count; i++) addAutoFrame(ctx.services, ctx.sheet.id, anim.id, i);
  return anim;
}
const entryFrame = (ctx, anim, i) => ctx.sheet.frames.find(f => f.id === anim.frames[i].frameId);

test('new creates an auto animation with one blank frame and selects it; undo/redo keep identity', () => {
  const ctx = setup();
  const r = newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run', w: 16, h: 24 });
  assert.equal(r.ok, true);
  const anim = ctx.sheet.animations[0];
  const frame = ctx.sheet.frames[0];
  assert.deepEqual([anim.layout, anim.cell, anim.frames.length], ['auto', { w: 16, h: 24 }, 1]);
  assert.deepEqual([frame.x, frame.y, frame.w, frame.h], [0, 0, 16, 24]);
  assert.deepEqual([r.animationId, r.frameId], [anim.id, frame.id]);
  assert.deepEqual([ctx.selection().animationId, ctx.selection().frameId], [anim.id, frame.id]);
  ctx.services.history.undo();
  assert.deepEqual([ctx.sheet.animations.length, ctx.sheet.frames.length], [0, 0]);
  ctx.services.history.redo();
  assert.equal(ctx.sheet.animations[0], anim);
  assert.equal(ctx.sheet.frames[0], frame);
});

test('a second animation gets its own band below the first', () => {
  const ctx = setup();
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run', w: 16, h: 16 });
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'idle', w: 8, h: 8 });
  assert.deepEqual([ctx.sheet.frames[1].x, ctx.sheet.frames[1].y], [0, 16]);
});

test('addFrame inserts a blank frame and shifts later frames with their pixels; undo restores', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const first = entryFrame(ctx, anim, 0);
  setPixel(ctx.bitmap(), 2, 2, RED);
  const before = ctx.bitmap().data.slice();
  assert.equal(addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0).ok, true);
  const added = entryFrame(ctx, anim, 0);
  assert.deepEqual([added.x, first.x], [0, 16]);
  assert.deepEqual(getPixel(ctx.bitmap(), 18, 2), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 2, 2), NONE);
  assert.equal(ctx.selection().frameId, added.id);
  ctx.services.history.undo();
  assert.deepEqual(ctx.bitmap().data, before);
  assert.deepEqual([ctx.sheet.frames.length, first.x, anim.frames.length], [1, 0, 1]);
});

test('addFrame with copyOf copies the source pixels; copyOf must be a frame of the animation', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const first = entryFrame(ctx, anim, 0);
  setPixel(ctx.bitmap(), 2, 2, RED);
  addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, { copyOf: first.id });
  const copy = entryFrame(ctx, anim, 1);
  assert.notEqual(copy, first);
  assert.deepEqual(getPixel(ctx.bitmap(), copy.x + 2, copy.y + 2), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 2, 2), RED);
  assert.equal(addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, { copyOf: 'nope' }).ok, false);
});

test('linkFrame inserts another use of a frame, and the sheet follows first appearance', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 17, 1, BLUE);
  assert.equal(linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, f1.id).ok, true);
  assert.deepEqual(anim.frames.map(e => e.frameId), [f1.id, f0.id, f1.id]);
  assert.equal(ctx.sheet.frames.length, 2);
  assert.deepEqual([f1.x, f0.x], [0, 16]);
  assert.deepEqual(getPixel(ctx.bitmap(), 1, 1), BLUE);
  assert.equal(linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, 'nope').ok, false);
});

test('deleteFrame removes an unreferenced frame, clears it, and closes the gap; undo restores', () => {
  const ctx = setup();
  const anim = runWith(ctx, 3);
  const [, f1, f2] = [0, 1, 2].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 17, 1, RED);
  setPixel(ctx.bitmap(), 33, 1, BLUE);
  assert.equal(deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1).ok, true);
  assert.equal(ctx.sheet.frames.includes(f1), false);
  assert.equal(f2.x, 16);
  assert.deepEqual(getPixel(ctx.bitmap(), 17, 1), BLUE);
  assert.deepEqual(getPixel(ctx.bitmap(), 33, 1), NONE);
  ctx.services.history.undo();
  assert.deepEqual([f1.x, f2.x], [16, 32]);
  assert.deepEqual(getPixel(ctx.bitmap(), 17, 1), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 33, 1), BLUE);
});

test('deleteFrame keeps a frame another entry or a map placement still uses', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2, f1.id);
  deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2);
  assert.ok(ctx.sheet.frames.includes(f1));
  ctx.project.maps.push({ id: 'm', name: 'M', layers: [{
    id: 'ml', name: 'L', type: 'sprite', visible: true, locked: false, opacity: 1,
    sprites: [{ id: 'p', sheetId: ctx.sheet.id, assetId: f1.id, kind: 'frame', x: 0, y: 0 }],
  }] });
  deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1);
  assert.ok(ctx.sheet.frames.includes(f1));
  assert.deepEqual(anim.frames.map(e => e.frameId), [f0.id]);
});

test('deleting the last entry keeps an empty animation', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0);
  assert.ok(ctx.sheet.animations.includes(anim));
  assert.deepEqual([anim.frames.length, ctx.sheet.frames.length], [0, 0]);
});

test('moveFrame reorders entries and the frames swap places with their pixels', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 1, 1, RED);
  setPixel(ctx.bitmap(), 17, 1, BLUE);
  assert.equal(moveAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, 1).ok, true);
  assert.deepEqual(anim.frames.map(e => e.frameId), [f1.id, f0.id]);
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 17, 1)], [BLUE, RED]);
  assert.equal(moveAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, 1).ok, true);
  ctx.services.history.undo();
  assert.deepEqual(anim.frames.map(e => e.frameId), [f0.id, f1.id]);
});

test('a layout refusal changes nothing and records no history', () => {
  const ctx = setup({ maxWidth: 64 });
  assert.deepEqual(newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'big', w: 80, h: 16 }), { ok: false, reason: NO_ROOM });
  assert.deepEqual([ctx.sheet.animations.length, ctx.sheet.frames.length], [0, 0]);
  assert.equal(ctx.services.history.canUndo(), false);
});

test('refuses to move pixels out of a locked layer', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  setPixel(ctx.bitmap(), 2, 2, RED);
  Object.assign(sheetLayers(ctx.sheet)[0], { locked: true, name: 'Ink' });
  const r = addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Ink/);
  assert.deepEqual([anim.frames.length, ctx.sheet.frames.length], [1, 1]);
  ctx.services.history.undo();
  assert.equal(ctx.sheet.animations.length, 0); // only "new animation" was recorded
});

test('growth is undone and redone byte-exactly', () => {
  const ctx = setup({ width: 32, height: 16, maxWidth: 32 });
  const anim = runWith(ctx, 2);
  setPixel(ctx.bitmap(), 1, 1, RED);
  const before = ctx.bitmap().data.slice();
  addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2);
  assert.deepEqual([ctx.sheet.height, ctx.bitmap().height], [32, 32]);
  const after = ctx.bitmap().data.slice();
  ctx.services.history.undo();
  assert.equal(ctx.sheet.height, 16);
  assert.deepEqual(ctx.bitmap().data, before);
  ctx.services.history.redo();
  assert.equal(ctx.sheet.height, 32);
  assert.deepEqual(ctx.bitmap().data, after);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/animation-layout-commands.test.mjs`
Expected: FAIL, "Cannot find module .../animation-layout-commands.js".

- [ ] **Step 3: Implement `js/modes/sprites/application/commands/animation-layout-commands.js`**

```js
// js/modes/sprites/application/commands/animation-layout-commands.js
// Layout-changing animation commands (the animations.* ids registered in
// ../../contributions.js). Each one makes its structural change in place,
// plans the auto layout (domain/sprites/auto-layout.js), applies it
// (core/sheet-layout.js) and records everything as ONE history step whose
// do/undo swap structural snapshots and replay the pixel record. A refusal
// rolls the structural change back and returns { ok: false, reason }
// without touching history. See
// docs/superpowers/specs/2026-10-09-animations-workbench-design.md §2.
import { addFrame, addAnimation, sheetLayers, MAX_DIM } from '../../../../core/model.js';
import { createBitmap, copyRegion, blitRegion } from '../../../../core/pixels.js';
import { applyLayout, undoLayout, redoLayout } from '../../../../core/sheet-layout.js';
import { planLayout, distinctFrameIds } from '../../../../domain/sprites/auto-layout.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

export const NOT_AUTO = 'This animation is not auto-laid-out';
export const BAD_SIZE = `Canvas size must be whole numbers in 1..${MAX_DIM}`;
const NO_SUCH = 'No such animation or frame';

export function layoutMaxWidth(settings) {
  return settings?.sheetMaxWidth ?? settings?.spriteSheetW ?? 256;
}

export function sheetDocument(sheet) {
  return { kind: 'sprite-sheet', id: sheet.id };
}

export function validSize(w, h) {
  return [w, h].every(v => Number.isInteger(v) && v >= 1 && v <= MAX_DIM);
}

export function findAnimation(services, sheetId, animationId) {
  return findSpriteSheet(services.projects.project, sheetId)?.animations.find(a => a.id === animationId) ?? null;
}

export function animFrames(sheet, anim) {
  const byId = new Map(sheet.frames.map(f => [f.id, f]));
  return distinctFrameIds(anim).map(id => byId.get(id)).filter(Boolean);
}

export function rectOf(f) {
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

// A frame's current pixels on every layer, for content-replacing writes.
export function frameContent(sheet, frame) {
  return new Map(sheetLayers(sheet).map(l => [l.id, copyRegion(l.bitmap, frame.x, frame.y, frame.w, frame.h)]));
}

// Every layer's pixels of `frame`, re-framed onto a w x h canvas with the
// old content's top-left at (ox, oy) -- cropping or padding as needed.
export function reframedContent(sheet, frame, w, h, ox, oy) {
  return new Map(sheetLayers(sheet).map(l => {
    const bitmap = createBitmap(w, h);
    blitRegion(bitmap, copyRegion(l.bitmap, frame.x, frame.y, frame.w, frame.h), ox, oy);
    return [l.id, bitmap];
  }));
}

export function uniqueFrameName(sheet, base) {
  const names = new Set(sheet.frames.map(f => f.name));
  for (let i = 0; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

// True while any animation entry on the sheet, or any map sprite placement
// of this sheet, still names the frame (maps place frames by id as assetId).
export function isFrameReferenced(project, sheet, frameId) {
  if (sheet.animations.some(a => a.frames.some(e => e.frameId === frameId))) return true;
  return (project?.maps ?? []).some(m => m.layers.some(l => l.type === 'sprite' &&
    (l.sprites ?? []).some(s => s.sheetId === sheet.id && s.kind !== 'animation' && s.assetId === frameId)));
}

function snapshot(sheet) {
  return {
    frames: sheet.frames.slice(),
    frameFields: sheet.frames.map(f => [f, { name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, pivotX: f.pivotX, pivotY: f.pivotY }]),
    animations: sheet.animations.slice(),
    animFields: sheet.animations.map(a => [a, { name: a.name, layout: a.layout, cell: a.cell ? { ...a.cell } : null, frames: a.frames.map(e => ({ ...e })) }]),
  };
}

function restore(sheet, snap) {
  sheet.frames = snap.frames.slice();
  for (const [f, v] of snap.frameFields) Object.assign(f, v);
  sheet.animations = snap.animations.slice();
  for (const [a, v] of snap.animFields) {
    a.name = v.name; a.layout = v.layout; a.cell = v.cell ? { ...v.cell } : null;
    a.frames = v.frames.map(e => ({ ...e }));
  }
}

// mutate(sheet) changes the structure in place and returns either
// { ok: false, reason } or { content?, clears?, selection? }: the frames
// whose pixels are replaced (see applyLayout), the rects to empty, and a
// selection patch applied on do.
export function runLayoutCommand(services, sheetId, label, mutate) {
  const project = services.projects.project;
  const sheet = findSpriteSheet(project, sheetId);
  if (!sheet) return { ok: false, reason: NO_SUCH };
  const doc = sheetDocument(sheet);
  const before = snapshot(sheet);
  const selectionBefore = services.selections?.get(doc) ?? null;
  const change = mutate(sheet) ?? {};
  if (change.ok === false) { restore(sheet, before); return change; }
  const { content = new Map(), clears = [], selection = null } = change;
  const plan = planLayout(sheet, {
    maxWidth: layoutMaxWidth(project.settings), maxHeight: MAX_DIM,
    fresh: new Set(content.keys()), ignoreRects: clears,
  });
  if (!plan.ok) { restore(sheet, before); return plan; }
  const applied = applyLayout(sheet, plan, { content, clears });
  if (!applied.ok) { restore(sheet, before); return applied; }
  const after = snapshot(sheet);
  // HistoryService.execute runs do() immediately; restoring `after` and
  // replaying the record is idempotent, so the net effect is one apply.
  runSheetCommand(services, sheetId, label,
    target => {
      restore(target, after);
      redoLayout(target, applied.record);
      if (selection) services.selections?.patch(selection, doc);
    },
    target => {
      undoLayout(target, applied.record);
      restore(target, before);
      if (selection && selectionBefore) services.selections?.set(selectionBefore, doc);
    });
  return { ok: true };
}

function autoIn(sheet, animationId) {
  const anim = sheet.animations.find(a => a.id === animationId);
  return anim?.layout === 'auto' ? anim : null;
}

function sharedPivot(sheet, anim) {
  const first = animFrames(sheet, anim)[0];
  return { pivotX: first?.pivotX ?? 0, pivotY: first?.pivotY ?? 0 };
}

export function newAutoAnimation(services, sheetId, { name, w, h }) {
  if (!validSize(w, h)) return { ok: false, reason: BAD_SIZE };
  let ids = null;
  const r = runLayoutCommand(services, sheetId, 'new animation', sheet => {
    const anim = addAnimation(sheet, name ?? `anim_${sheet.animations.length}`, false, services.projects.project?.settings);
    anim.layout = 'auto';
    anim.cell = { w, h };
    const frame = addFrame(sheet, { name: uniqueFrameName(sheet, anim.name), x: 0, y: 0, w, h });
    anim.frames.push({ frameId: frame.id, duration: null, step: null });
    ids = { animationId: anim.id, frameId: frame.id };
    return { content: new Map([[frame.id, null]]), selection: ids };
  });
  return r.ok ? { ...r, ...ids } : r;
}

export function addAutoFrame(services, sheetId, animationId, at, { copyOf = null } = {}) {
  let frameId = null;
  const r = runLayoutCommand(services, sheetId, copyOf ? 'duplicate frame' : 'add frame', sheet => {
    const anim = autoIn(sheet, animationId);
    if (!anim) return { ok: false, reason: NOT_AUTO };
    const source = copyOf ? sheet.frames.find(f => f.id === copyOf) : null;
    if (copyOf && (!source || !anim.frames.some(e => e.frameId === copyOf)))
      return { ok: false, reason: 'Can only copy a frame of this animation' };
    const frame = addFrame(sheet, { name: uniqueFrameName(sheet, anim.name), x: 0, y: 0, w: anim.cell.w, h: anim.cell.h, ...sharedPivot(sheet, anim) });
    anim.frames.splice(Math.max(0, Math.min(anim.frames.length, at)), 0, { frameId: frame.id, duration: null, step: null });
    frameId = frame.id;
    return { content: new Map([[frame.id, source ? frameContent(sheet, source) : null]]), selection: { frameId: frame.id } };
  });
  return r.ok ? { ...r, frameId } : r;
}

export function linkAutoFrame(services, sheetId, animationId, at, frameId) {
  return runLayoutCommand(services, sheetId, 'link frame', sheet => {
    const anim = autoIn(sheet, animationId);
    if (!anim) return { ok: false, reason: NOT_AUTO };
    if (!anim.frames.some(e => e.frameId === frameId)) return { ok: false, reason: 'Can only link a frame of this animation' };
    anim.frames.splice(Math.max(0, Math.min(anim.frames.length, at)), 0, { frameId, duration: null, step: null });
    return {};
  });
}

export function deleteAutoFrame(services, sheetId, animationId, index) {
  return runLayoutCommand(services, sheetId, 'delete frame', sheet => {
    const anim = autoIn(sheet, animationId);
    if (!anim) return { ok: false, reason: NOT_AUTO };
    if (!(index >= 0 && index < anim.frames.length)) return { ok: false, reason: NO_SUCH };
    const [entry] = anim.frames.splice(index, 1);
    if (isFrameReferenced(services.projects.project, sheet, entry.frameId)) return {};
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (!frame) return {};
    sheet.frames = sheet.frames.filter(f => f !== frame);
    const selected = services.selections?.get(sheetDocument(sheet))?.frameId === frame.id;
    return { clears: [rectOf(frame)], selection: selected ? { frameId: null } : null };
  });
}

export function moveAutoFrame(services, sheetId, animationId, from, to) {
  const anim = findAnimation(services, sheetId, animationId);
  if (anim?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  if (!(from >= 0 && from < anim.frames.length)) return { ok: false, reason: NO_SUCH };
  const target = Math.max(0, Math.min(anim.frames.length - 1, to));
  if (target === from) return { ok: true };
  return runLayoutCommand(services, sheetId, 'reorder animation frame', sheet => {
    const a = autoIn(sheet, animationId);
    const [entry] = a.frames.splice(from, 1);
    a.frames.splice(target, 0, entry);
    return {};
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test tests/animation-layout-commands.test.mjs tests/architecture.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit (only if authorized)**

```bash
git add js/modes/sprites/application/commands/animation-layout-commands.js tests/animation-layout-commands.test.mjs
git commit -m "feat: add layout-aware animation timeline commands"
```

---

### Task 5: Canvas, layout-mode, ordering and lifecycle commands, plus registration

**Files:**
- Modify: `js/modes/sprites/application/commands/animation-layout-commands.js` (append)
- Modify: `js/modes/sprites/contributions.js` (imports at lines 9-29, new registration function, call it in `registerSpriteContributions` at line 89)
- Test: `tests/animation-layout-lifecycle.test.mjs` (create), `tests/builtinmodes.test.mjs` (append one test)

**Interfaces:**
- Consumes: everything T4 exports, plus `deleteAnimation` from `./animation-lifecycle-commands.js` (used only by the registration's manual branch).
- Produces:
  - `resizeAutoCanvas(services, sheetId, animationId, w, h, anchor = 'c')`, where `anchor` is one of `'nw','n','ne','w','c','e','sw','s','se'`.
  - `autoLayoutAnimation(services, sheetId, animationId, size = null)`. When the frames differ in size or pivot and no size is given, it returns `{ ok: false, reason: SIZE_NEEDED, needsSize: true, suggested: {w,h} }`.
  - `makeManual(services, sheetId, animationId)`
  - `reorderAnimations(services, sheetId, from, to)`
  - `duplicateAnimation(services, sheetId, animationId)`, which returns `{ ok, animationId }`.
  - `deleteAutoAnimation(services, sheetId, animationId)`
  - `setAnimationPivot(services, sheetId, animationId, pivotX, pivotY)`
  - `deleteLaidOutFrame(services, sheetId, frameId)`
  - `SIZE_NEEDED`
  - Command ids, registered with `when: modeId === 'sprites' || modeId === 'animations'`:
    - `animations.new {sheetId,name,w,h}`
    - `animations.addFrame {sheetId,animationId,at,copyOf}`
    - `animations.linkFrame {sheetId,animationId,at,frameId}`
    - `animations.deleteFrame {sheetId,animationId,index}`
    - `animations.moveFrame {sheetId,animationId,from,to}`
    - `animations.resizeCanvas {sheetId,animationId,w,h,anchor}`
    - `animations.autoLayout {sheetId,animationId,size}`
    - `animations.makeManual {sheetId,animationId}`
    - `animations.reorderAnimations {sheetId,from,to}`
    - `animations.duplicate {sheetId,animationId}`
    - `animations.delete {sheetId,animationId}`
    - `animations.setPivot {sheetId,animationId,pivotX,pivotY}`

- [ ] **Step 1: Write the failing tests**

Create `tests/animation-layout-lifecycle.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import {
  newAutoAnimation, addAutoFrame, resizeAutoCanvas, autoLayoutAnimation, makeManual, reorderAnimations,
  duplicateAnimation, deleteAutoAnimation, setAnimationPivot, deleteLaidOutFrame, SIZE_NEEDED,
} from '../js/modes/sprites/application/commands/animation-layout-commands.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function setup({ width = 64, height = 64, maxWidth = 64 } = {}) {
  const project = createProject('t');
  project.settings.sheetMaxWidth = maxWidth;
  const sheet = createSheet(project, { name: 'S', width, height, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
  return {
    project, sheet, services,
    bitmap: () => sheetLayers(sheet)[0].bitmap,
    selection: () => services.selections.get({ kind: 'sprite-sheet', id: sheet.id }) ?? {},
  };
}
function runWith(ctx, count, { name = 'run', w = 16, h = 16 } = {}) {
  newAutoAnimation(ctx.services, ctx.sheet.id, { name, w, h });
  const anim = ctx.sheet.animations.at(-1);
  for (let i = 1; i < count; i++) addAutoFrame(ctx.services, ctx.sheet.id, anim.id, i);
  return anim;
}
const entryFrame = (ctx, anim, i) => ctx.sheet.frames.find(f => f.id === anim.frames[i].frameId);
function manualAnim(sheet, id, frameIds) {
  const a = { id, name: id, loop: true, baseDuration: 100, layout: 'manual', cell: null, frames: frameIds.map(frameId => ({ frameId, duration: null, step: null })) };
  sheet.animations.push(a);
  return a;
}
const fr = (id, x, y, w = 16, h = 16, pivotX = 0, pivotY = 0) => ({ id, name: id, x, y, w, h, pivotX, pivotY });

test('resizeCanvas re-frames every frame around the anchor and shifts the pivot; undo restores', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 0, 0, RED);
  setPixel(ctx.bitmap(), 31, 15, BLUE);
  assert.equal(resizeAutoCanvas(ctx.services, ctx.sheet.id, anim.id, 20, 16, 'c').ok, true);
  assert.deepEqual(anim.cell, { w: 20, h: 16 });
  assert.deepEqual([f0.x, f0.w, f1.x, f1.w, f0.pivotX], [0, 20, 20, 20, 2]);
  assert.deepEqual(getPixel(ctx.bitmap(), 2, 0), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 37, 15), BLUE);
  ctx.services.history.undo();
  assert.deepEqual(anim.cell, { w: 16, h: 16 });
  assert.deepEqual([f0.w, f1.x, f0.pivotX], [16, 16, 0]);
  assert.deepEqual([getPixel(ctx.bitmap(), 0, 0), getPixel(ctx.bitmap(), 31, 15)], [RED, BLUE]);
});

test('resizeCanvas smaller crops around the anchor', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  setPixel(ctx.bitmap(), 1, 1, RED);
  setPixel(ctx.bitmap(), 10, 10, BLUE);
  resizeAutoCanvas(ctx.services, ctx.sheet.id, anim.id, 8, 8, 'nw');
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 10, 10)], [RED, NONE]);
  assert.deepEqual(anim.cell, { w: 8, h: 8 });
});

test('autoLayout lays out a manual animation of equal frames, carrying their pixels', () => {
  const ctx = setup();
  ctx.sheet.frames.push(fr('m0', 40, 40), fr('m1', 0, 40));
  manualAnim(ctx.sheet, 'walk', ['m0', 'm1']);
  setPixel(ctx.bitmap(), 41, 41, RED);
  setPixel(ctx.bitmap(), 1, 41, BLUE);
  assert.equal(autoLayoutAnimation(ctx.services, ctx.sheet.id, 'walk').ok, true);
  const anim = ctx.sheet.animations[0];
  assert.deepEqual([anim.layout, anim.cell], ['auto', { w: 16, h: 16 }]);
  assert.deepEqual(ctx.sheet.frames.map(f => [f.id, f.x, f.y]), [['m0', 0, 0], ['m1', 16, 0]]);
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 17, 1)], [RED, BLUE]);
  ctx.services.history.undo();
  assert.deepEqual([anim.layout, anim.cell, ctx.sheet.frames[0].x], ['manual', null, 40]);
});

test('autoLayout asks for a size when frames differ, then aligns them on their pivots', () => {
  const ctx = setup();
  ctx.sheet.frames.push(fr('a', 0, 32, 16, 16, 8, 16), fr('b', 32, 32, 8, 8, 4, 8));
  manualAnim(ctx.sheet, 'walk', ['a', 'b']);
  const asked = autoLayoutAnimation(ctx.services, ctx.sheet.id, 'walk');
  assert.deepEqual(asked, { ok: false, reason: SIZE_NEEDED, needsSize: true, suggested: { w: 16, h: 16 } });
  assert.equal(ctx.sheet.animations[0].layout, 'manual');
  setPixel(ctx.bitmap(), 36, 39, RED); // b's local (4, 7), just above its pivot
  assert.equal(autoLayoutAnimation(ctx.services, ctx.sheet.id, 'walk', { w: 16, h: 16 }).ok, true);
  const b = ctx.sheet.frames.find(f => f.id === 'b');
  assert.deepEqual([b.x, b.y, b.w, b.h, b.pivotX, b.pivotY], [16, 0, 16, 16, 8, 16]);
  assert.deepEqual(getPixel(ctx.bitmap(), 24, 15), RED);
});

test('autoLayout refuses a frame another auto animation already lays out', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  manualAnim(ctx.sheet, 'other', [run.frames[0].frameId]);
  const r = autoLayoutAnimation(ctx.services, ctx.sheet.id, 'other');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already laid out by "run"/);
});

test('makeManual releases an animation without touching pixels or rects; undo re-pins it', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const f1 = entryFrame(ctx, anim, 1);
  assert.equal(makeManual(ctx.services, ctx.sheet.id, anim.id).ok, true);
  assert.deepEqual([anim.layout, anim.cell, f1.x], ['manual', null, 16]);
  ctx.services.history.undo();
  assert.deepEqual([anim.layout, anim.cell], ['auto', { w: 16, h: 16 }]);
});

test('reorderAnimations swaps band order and moves pixels with it', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  const idle = runWith(ctx, 1, { name: 'idle', w: 8, h: 8 });
  const idleFrame = entryFrame(ctx, idle, 0);
  assert.deepEqual([idleFrame.x, idleFrame.y], [0, 16]);
  setPixel(ctx.bitmap(), 1, 17, BLUE);
  assert.equal(reorderAnimations(ctx.services, ctx.sheet.id, 1, 0).ok, true);
  assert.deepEqual(ctx.sheet.animations, [idle, run]);
  assert.deepEqual([idleFrame.y, entryFrame(ctx, run, 0).y], [0, 8]);
  assert.deepEqual(getPixel(ctx.bitmap(), 1, 1), BLUE);
});

test('duplicate copies an auto animation with its pixels right after the source', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  anim.frames[1].duration = 250;
  setPixel(ctx.bitmap(), 1, 1, RED);
  const r = duplicateAnimation(ctx.services, ctx.sheet.id, anim.id);
  const copy = ctx.sheet.animations[1];
  assert.deepEqual([r.ok, r.animationId, copy.name, copy.layout, copy.frames.length], [true, copy.id, 'run copy', 'auto', 2]);
  assert.equal(copy.frames[1].duration, 250);
  const c0 = entryFrame(ctx, copy, 0);
  assert.notEqual(c0.id, anim.frames[0].frameId);
  assert.equal(c0.y, 16);
  assert.deepEqual(getPixel(ctx.bitmap(), c0.x + 1, c0.y + 1), RED);
  assert.equal(ctx.selection().animationId, copy.id);
});

test('duplicate refuses a manual animation', () => {
  const ctx = setup();
  ctx.sheet.frames.push(fr('m', 0, 0));
  manualAnim(ctx.sheet, 'walk', ['m']);
  assert.equal(duplicateAnimation(ctx.services, ctx.sheet.id, 'walk').ok, false);
});

test('deleting an auto animation removes and clears its own frames and closes the gap; undo restores', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  const idle = runWith(ctx, 1, { name: 'idle' });
  const runFrame = entryFrame(ctx, run, 0), idleFrame = entryFrame(ctx, idle, 0);
  setPixel(ctx.bitmap(), 1, 1, RED);
  setPixel(ctx.bitmap(), 1, 17, BLUE);
  assert.equal(deleteAutoAnimation(ctx.services, ctx.sheet.id, run.id).ok, true);
  assert.deepEqual([ctx.sheet.animations, ctx.sheet.frames.includes(runFrame), idleFrame.y], [[idle], false, 0]);
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 1, 17)], [BLUE, NONE]);
  ctx.services.history.undo();
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 1, 17)], [RED, BLUE]);
});

test('deleting an auto animation keeps frames a map still places', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  const runFrame = entryFrame(ctx, run, 0);
  ctx.project.maps.push({ id: 'm', name: 'M', layers: [{
    id: 'ml', name: 'L', type: 'sprite', visible: true, locked: false, opacity: 1,
    sprites: [{ id: 'p', sheetId: ctx.sheet.id, assetId: runFrame.id, kind: 'frame', x: 0, y: 0 }],
  }] });
  deleteAutoAnimation(ctx.services, ctx.sheet.id, run.id);
  assert.ok(ctx.sheet.frames.includes(runFrame));
});

test('setPivot sets the shared pivot on every frame and undoes', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  setAnimationPivot(ctx.services, ctx.sheet.id, anim.id, 8, 15);
  assert.deepEqual(ctx.sheet.frames.map(f => [f.pivotX, f.pivotY]), [[8, 15], [8, 15]]);
  ctx.services.history.undo();
  assert.deepEqual(ctx.sheet.frames.map(f => [f.pivotX, f.pivotY]), [[0, 0], [0, 0]]);
});

test('deleteLaidOutFrame removes a frame from every animation and relays out', () => {
  const ctx = setup();
  const anim = runWith(ctx, 3);
  const [, f1, f2] = [0, 1, 2].map(i => entryFrame(ctx, anim, i));
  manualAnim(ctx.sheet, 'loose', [f1.id]);
  assert.equal(deleteLaidOutFrame(ctx.services, ctx.sheet.id, f1.id).ok, true);
  assert.equal(ctx.sheet.frames.includes(f1), false);
  assert.deepEqual([anim.frames.length, ctx.sheet.animations[1].frames.length, f2.x], [2, 0, 16]);
});
```

Append to `tests/builtinmodes.test.mjs`:

```js
test('sprites mode registers the animations.* layout commands for both workbenches', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode);
  assert.deepEqual(
    host.registries.commands.list().map(command => command.id).filter(id => id.startsWith('animations.')),
    [
      'animations.addFrame', 'animations.autoLayout', 'animations.delete', 'animations.deleteFrame',
      'animations.duplicate', 'animations.linkFrame', 'animations.makeManual', 'animations.moveFrame',
      'animations.new', 'animations.reorderAnimations', 'animations.resizeCanvas', 'animations.setPivot',
    ],
  );
  const when = host.registries.commands.get('animations.new').when;
  assert.deepEqual([when({ modeId: 'sprites' }), when({ modeId: 'animations' }), when({ modeId: 'tiles' })], [true, true, false]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/animation-layout-lifecycle.test.mjs tests/builtinmodes.test.mjs`
Expected: FAIL. The lifecycle file reports a missing export (`resizeAutoCanvas`). The builtinmodes test fails on `[]` vs. the expected id list.

- [ ] **Step 3: Append the commands to `animation-layout-commands.js`**

Add `autoAnimationOf` to the existing domain import (`import { planLayout, distinctFrameIds, autoAnimationOf } ...`), then append:

```js
export const SIZE_NEEDED = 'Frames differ in size or pivot: choose a canvas size';

const ANCHORS = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0],
  w: [0, 0.5], c: [0.5, 0.5], e: [1, 0.5],
  sw: [0, 1], s: [0.5, 1], se: [1, 1],
};

export function resizeAutoCanvas(services, sheetId, animationId, w, h, anchor = 'c') {
  if (!validSize(w, h)) return { ok: false, reason: BAD_SIZE };
  const current = findAnimation(services, sheetId, animationId);
  if (current?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  if (current.cell.w === w && current.cell.h === h) return { ok: true };
  const [fx, fy] = ANCHORS[anchor] ?? ANCHORS.c;
  return runLayoutCommand(services, sheetId, 'resize animation canvas', sheet => {
    const anim = autoIn(sheet, animationId);
    const ox = Math.floor(fx * (w - anim.cell.w)), oy = Math.floor(fy * (h - anim.cell.h));
    const content = new Map(), clears = [];
    for (const f of animFrames(sheet, anim)) {
      clears.push(rectOf(f));
      content.set(f.id, reframedContent(sheet, f, w, h, ox, oy));
      f.w = w; f.h = h; f.pivotX += ox; f.pivotY += oy;
    }
    anim.cell = { w, h };
    return { content, clears };
  });
}

export function autoLayoutAnimation(services, sheetId, animationId, size = null) {
  if (size && !validSize(size.w, size.h)) return { ok: false, reason: BAD_SIZE };
  const sheet0 = findSpriteSheet(services.projects.project, sheetId);
  const anim0 = sheet0?.animations.find(a => a.id === animationId);
  if (!anim0) return { ok: false, reason: NO_SUCH };
  if (anim0.layout === 'auto') return { ok: false, reason: 'Already auto-laid-out' };
  const frames0 = animFrames(sheet0, anim0);
  if (!frames0.length) return { ok: false, reason: 'The animation has no frames' };
  for (const f of frames0) {
    const other = autoAnimationOf(sheet0, f.id);
    if (other) return { ok: false, reason: `Frame "${f.name}" is already laid out by "${other.name}"` };
  }
  const first = frames0[0];
  const uniform = frames0.every(f => f.w === first.w && f.h === first.h && f.pivotX === first.pivotX && f.pivotY === first.pivotY);
  if (!uniform && !size) {
    return {
      ok: false, reason: SIZE_NEEDED, needsSize: true,
      suggested: { w: Math.max(...frames0.map(f => f.w)), h: Math.max(...frames0.map(f => f.h)) },
    };
  }
  return runLayoutCommand(services, sheetId, 'auto-layout animation', sheet => {
    const anim = sheet.animations.find(a => a.id === animationId);
    const frames = animFrames(sheet, anim);
    const head = frames[0];
    anim.layout = 'auto';
    if (!size || (uniform && size.w === head.w && size.h === head.h)) {
      anim.cell = { w: head.w, h: head.h };
      return {};
    }
    // Every frame's pivot lands on the same point: the first frame's pivot,
    // shifted by centring the first frame on the new canvas.
    const px = head.pivotX + Math.floor((size.w - head.w) / 2);
    const py = head.pivotY + Math.floor((size.h - head.h) / 2);
    const content = new Map(), clears = [];
    for (const f of frames) {
      clears.push(rectOf(f));
      content.set(f.id, reframedContent(sheet, f, size.w, size.h, Math.round(px - f.pivotX), Math.round(py - f.pivotY)));
      f.w = size.w; f.h = size.h; f.pivotX = px; f.pivotY = py;
    }
    anim.cell = { w: size.w, h: size.h };
    return { content, clears };
  });
}

export function makeManual(services, sheetId, animationId) {
  const anim = findAnimation(services, sheetId, animationId);
  if (anim?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  const cell = { ...anim.cell };
  runSheetCommand(services, sheetId, 'make animation manual',
    target => { const a = target.animations.find(x => x.id === animationId); a.layout = 'manual'; a.cell = null; },
    target => { const a = target.animations.find(x => x.id === animationId); a.layout = 'auto'; a.cell = { ...cell }; });
  return { ok: true };
}

export function reorderAnimations(services, sheetId, from, to) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || !(from >= 0 && from < sheet.animations.length)) return { ok: false, reason: NO_SUCH };
  const target = Math.max(0, Math.min(sheet.animations.length - 1, to));
  if (target === from) return { ok: true };
  return runLayoutCommand(services, sheetId, 'reorder animations', s => {
    const [anim] = s.animations.splice(from, 1);
    s.animations.splice(target, 0, anim);
    return {};
  });
}

export function duplicateAnimation(services, sheetId, animationId) {
  const source = findAnimation(services, sheetId, animationId);
  if (!source) return { ok: false, reason: NO_SUCH };
  if (source.layout !== 'auto') return { ok: false, reason: 'Auto-layout this animation first' };
  let copyId = null;
  const r = runLayoutCommand(services, sheetId, 'duplicate animation', sheet => {
    const src = sheet.animations.find(a => a.id === animationId);
    const copy = addAnimation(sheet, `${src.name} copy`, false, services.projects.project?.settings);
    sheet.animations.splice(sheet.animations.indexOf(copy), 1);
    sheet.animations.splice(sheet.animations.indexOf(src) + 1, 0, copy);
    Object.assign(copy, {
      loop: src.loop, baseDuration: src.baseDuration, baseFps: src.baseFps, baseStep: src.baseStep,
      layout: 'auto', cell: { ...src.cell },
    });
    const ids = new Map(), content = new Map();
    for (const f of animFrames(sheet, src)) {
      const nf = addFrame(sheet, { name: uniqueFrameName(sheet, copy.name), x: 0, y: 0, w: f.w, h: f.h, pivotX: f.pivotX, pivotY: f.pivotY });
      ids.set(f.id, nf.id);
      content.set(nf.id, frameContent(sheet, f));
    }
    copy.frames = src.frames.filter(e => ids.has(e.frameId)).map(e => ({ ...e, frameId: ids.get(e.frameId) }));
    copyId = copy.id;
    return { content, selection: { animationId: copy.id } };
  });
  return r.ok ? { ...r, animationId: copyId } : r;
}

export function deleteAutoAnimation(services, sheetId, animationId) {
  if (findAnimation(services, sheetId, animationId)?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  return runLayoutCommand(services, sheetId, 'delete animation', sheet => {
    const anim = sheet.animations.find(a => a.id === animationId);
    sheet.animations = sheet.animations.filter(a => a !== anim);
    const clears = [];
    for (const f of animFrames(sheet, anim)) {
      if (isFrameReferenced(services.projects.project, sheet, f.id)) continue;
      clears.push(rectOf(f));
      sheet.frames = sheet.frames.filter(x => x !== f);
    }
    const selected = services.selections?.get(sheetDocument(sheet))?.animationId === animationId;
    return { clears, selection: selected ? { animationId: null, frameId: null } : null };
  });
}

export function setAnimationPivot(services, sheetId, animationId, pivotX, pivotY) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (anim?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  const frames = animFrames(sheet, anim);
  if (frames.every(f => f.pivotX === pivotX && f.pivotY === pivotY)) return { ok: true };
  const before = frames.map(f => [f.pivotX, f.pivotY]);
  runSheetCommand(services, sheetId, 'set animation pivot',
    () => frames.forEach(f => { f.pivotX = pivotX; f.pivotY = pivotY; }),
    () => frames.forEach((f, i) => { [f.pivotX, f.pivotY] = before[i]; }));
  return { ok: true };
}

// Sprite Sheets' Delete on a pinned frame: the frame leaves every animation
// and the sheet, and its rect is cleared (otherwise its pixels would become
// stray obstacles for every later layout).
export function deleteLaidOutFrame(services, sheetId, frameId) {
  return runLayoutCommand(services, sheetId, 'delete frame', sheet => {
    const frame = sheet.frames.find(f => f.id === frameId);
    if (!frame) return { ok: false, reason: NO_SUCH };
    sheet.frames = sheet.frames.filter(f => f !== frame);
    for (const a of sheet.animations) a.frames = a.frames.filter(e => e.frameId !== frameId);
    const selected = services.selections?.get(sheetDocument(sheet))?.frameId === frameId;
    return { clears: [rectOf(frame)], selection: selected ? { frameId: null } : null };
  });
}
```

- [ ] **Step 4: Register the commands in `js/modes/sprites/contributions.js`**

Add the imports (next to the other `application/commands` imports):

```js
import {
  newAutoAnimation, addAutoFrame, linkAutoFrame, deleteAutoFrame, moveAutoFrame, resizeAutoCanvas,
  autoLayoutAnimation, makeManual, reorderAnimations, duplicateAnimation, deleteAutoAnimation, setAnimationPivot,
} from './application/commands/animation-layout-commands.js';
```

and add `findSpriteSheet` to the existing `frame-commands.js` import list. After `registerSpriteCommands`, add:

```js
// Layout-aware animation commands. Registered once, for both workbenches:
// the Animations workbench (mode 'animations') is built on them, and Sprite
// Sheets needs Make manual, the shared pivot and auto-frame delete.
function registerAnimationLayoutCommands(api) {
  const when = keys => keys.modeId === 'sprites' || keys.modeId === 'animations';
  const command = (id, execute) => api.commands.register({ id, when, execute });
  command('animations.new', (_c, { sheetId, name, w, h }) => newAutoAnimation(services(), sheetId, { name, w, h }));
  command('animations.addFrame', (_c, { sheetId, animationId, at, copyOf }) => addAutoFrame(services(), sheetId, animationId, at, { copyOf }));
  command('animations.linkFrame', (_c, { sheetId, animationId, at, frameId }) => linkAutoFrame(services(), sheetId, animationId, at, frameId));
  command('animations.deleteFrame', (_c, { sheetId, animationId, index }) => deleteAutoFrame(services(), sheetId, animationId, index));
  command('animations.moveFrame', (_c, { sheetId, animationId, from, to }) => moveAutoFrame(services(), sheetId, animationId, from, to));
  command('animations.resizeCanvas', (_c, { sheetId, animationId, w, h, anchor }) => resizeAutoCanvas(services(), sheetId, animationId, w, h, anchor));
  command('animations.autoLayout', (_c, { sheetId, animationId, size }) => autoLayoutAnimation(services(), sheetId, animationId, size));
  command('animations.makeManual', (_c, { sheetId, animationId }) => makeManual(services(), sheetId, animationId));
  command('animations.reorderAnimations', (_c, { sheetId, from, to }) => reorderAnimations(services(), sheetId, from, to));
  command('animations.duplicate', (_c, { sheetId, animationId }) => duplicateAnimation(services(), sheetId, animationId));
  // A manual animation keeps its frames, exactly like sprites.deleteAnimation.
  command('animations.delete', (_c, { sheetId, animationId }) => {
    const anim = findSpriteSheet(services().projects.project, sheetId)?.animations.find(a => a.id === animationId);
    if (anim?.layout === 'auto') return deleteAutoAnimation(services(), sheetId, animationId);
    deleteAnimation(services(), sheetId, animationId);
    return { ok: true };
  });
  command('animations.setPivot', (_c, { sheetId, animationId, pivotX, pivotY }) => setAnimationPivot(services(), sheetId, animationId, pivotX, pivotY));
}
```

In `registerSpriteContributions`, call `registerAnimationLayoutCommands(api);` right after `registerSpriteCommands(api);`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `node --test tests/animation-layout-lifecycle.test.mjs tests/animation-layout-commands.test.mjs tests/builtinmodes.test.mjs tests/architecture.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit (only if authorized)**

```bash
git add js/modes/sprites/application/commands/animation-layout-commands.js js/modes/sprites/contributions.js tests/animation-layout-lifecycle.test.mjs tests/builtinmodes.test.mjs
git commit -m "feat: add canvas, layout-mode and lifecycle animation commands and register animations.*"
```

---

### Task 6: Save format v4 and v2/v3 conversion

**Files:**
- Create: `js/core/legacy-animations.js`
- Modify: `js/core/model.js` (`PROJECT_VERSION` at line 13, `serializeGroup`, `serializeProject`, `deserializeProject`, `validateProjectJson`; add `normalizeAnimation` and `clearGroupOwnership`)
- Test: `tests/legacy-animation-conversion.test.mjs` (create); update `tests/model.test.mjs`

**Interfaces:**
- Consumes: `newId` (`core/palettes.js`) and `createBitmap` (`core/pixels.js`). `legacy-animations.js` must **not** import `model.js`, because `model.js` imports it.
- Produces:
  - `convertLegacySheet(sheet): void`. It runs on a freshly deserialized pre-v4 sheet that still carries `strip`, `breaks`, `layerGroupId` and `group.animationId`.
  - `COVERED_FOLDER_NAME`
  - `normalizeAnimation(a)`, exported from `model.js`: the v4 animation shape, with no `strip`, `breaks` or `layerGroupId`.
  - `PROJECT_VERSION === 4`.

- [ ] **Step 1: Write the failing tests**

Create `tests/legacy-animation-conversion.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deserializeProject, serializeProject, flattenSheetLayers, sheetLayers, validateProjectJson, PROJECT_VERSION,
} from '../js/core/model.js';
import { createBitmap, setPixel, getPixel, copyRegion, blitRegion } from '../js/core/pixels.js';
import { COVERED_FOLDER_NAME } from '../js/core/legacy-animations.js';

const W = 64, H = 32;
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function v3Project(build) {
  const images = new Map();
  const layer = (id, pixels = []) => {
    const bitmap = createBitmap(W, H);
    for (const [x, y, c] of pixels) setPixel(bitmap, x, y, c);
    const path = `images/s/${id}.png`;
    images.set(path, bitmap);
    return { id, type: 'layer', name: id, visible: true, opacity: 1, image: path };
  };
  const group = (id, children, animationId = null) => ({ id, type: 'group', name: id, animationId, open: true, children });
  const { frames, animations, children } = build({ layer, group });
  const json = {
    version: 3, name: 'p',
    settings: { spriteSheetW: W, spriteSheetH: H, tileSheetW: 16, tileSheetH: 16, tileW: 16, tileH: 16, frameW: 16, frameH: 16, durationMs: 100 },
    sheets: [{ id: 's', name: 's', kind: 'sprite', width: W, height: H, frames, animations, layerTree: group('root', children) }],
    maps: [], palettes: [],
  };
  return { json, images };
}
const fr = (id, x, y, w = 16, h = 16, pivotX = 0, pivotY = 0) => ({ id, name: id, x, y, w, h, pivotX, pivotY });
const strip = (id, frameIds, extra = {}) => ({
  id, name: id, loop: true, strip: true, breaks: [], layerGroupId: null, baseDuration: 100,
  frames: frameIds.map(frameId => ({ frameId, duration: null, step: null })), ...extra,
});
const load = p => deserializeProject(p.json, p.images);

// The v3 compositor, kept as the reference the conversion must match:
// non-strip layers everywhere, then each accepted strip's own layers
// hard-replace its frame rects (later strips win). Call BEFORE load(),
// which converts the bitmaps in place.
function v3Render({ json, images }) {
  const s = json.sheets[0];
  const layers = [];
  (function walk(node, owner) {
    for (const c of node.children) {
      if (c.type === 'layer') layers.push({ ...c, bitmap: images.get(c.image), owner });
      else walk(c, c.animationId ?? owner);
    }
  })(s.layerTree, null);
  const accepted = s.animations.filter(a => a.strip && a.layerGroupId);
  const out = flattenSheetLayers(layers.filter(l => !accepted.some(a => a.id === l.owner)), s.width, s.height);
  for (const a of accepted) {
    const own = flattenSheetLayers(layers.filter(l => l.owner === a.id), s.width, s.height);
    for (const e of a.frames) {
      const f = s.frames.find(x => x.id === e.frameId);
      blitRegion(out, copyRegion(own, f.x, f.y, f.w, f.h), f.x, f.y);
    }
  }
  return out;
}
const render = sheet => flattenSheetLayers(sheetLayers(sheet), sheet.width, sheet.height);

test('an accepted, contiguous, ordered strip becomes auto and stays where it was', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 16, 16), fr('b', 32, 16)],
    animations: [strip('run', ['a', 'b'], { layerGroupId: 'g' })],
    children: [layer('base'), group('g', [layer('ink')], 'run')],
  }))).sheets[0];
  const run = sheet.animations[0];
  assert.deepEqual([run.layout, run.cell], ['auto', { w: 16, h: 16 }]);
  assert.equal(['strip', 'breaks', 'layerGroupId'].some(k => k in run), false);
  assert.deepEqual(sheet.frames.map(f => [f.x, f.y]), [[16, 16], [32, 16]]);
});

for (const [label, frames, extra] of [
  ['has breaks', [fr('a', 0, 0), fr('b', 16, 0)], { layerGroupId: 'g', breaks: [1] }],
  ['is floating', [fr('a', 0, 0), fr('b', 16, 0)], { layerGroupId: null }],
  ['is not a strip', [fr('a', 0, 0), fr('b', 16, 0)], { layerGroupId: 'g', strip: false }],
  ['mixes sizes', [fr('a', 0, 0), fr('b', 16, 0, 8, 16)], { layerGroupId: 'g' }],
  ['has a gap', [fr('a', 0, 0), fr('b', 20, 0)], { layerGroupId: 'g' }],
  ['runs right to left', [fr('a', 16, 0), fr('b', 0, 0)], { layerGroupId: 'g' }],
  ['spans two rows', [fr('a', 0, 0), fr('b', 16, 16)], { layerGroupId: 'g' }],
  ['has differing pivots', [fr('a', 0, 0), fr('b', 16, 0, 16, 16, 8, 8)], { layerGroupId: 'g' }],
]) {
  test(`a v3 animation that ${label} converts to manual`, () => {
    const sheet = load(v3Project(({ layer, group }) => ({
      frames, animations: [strip('run', ['a', 'b'], extra)],
      children: [layer('base'), group('g', [layer('ink')], 'run')],
    }))).sheets[0];
    assert.deepEqual([sheet.animations[0].layout, sheet.animations[0].cell], ['manual', null]);
  });
}

test('a frame two qualifying strips share is auto only in the first', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('b', 16, 0)],
    animations: [strip('run', ['a', 'b'], { layerGroupId: 'g1' }), strip('walk', ['a', 'b'], { layerGroupId: 'g2' })],
    children: [group('g1', [layer('ink1')], 'run'), group('g2', [layer('ink2')], 'walk')],
  }))).sheets[0];
  assert.deepEqual(sheet.animations.map(a => a.layout), ['auto', 'manual']);
});

test('animation-owned groups become plain folders', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0)], animations: [strip('run', ['a'], { layerGroupId: 'g' })],
    children: [group('g', [layer('ink')], 'run')],
  }))).sheets[0];
  (function walk(node) {
    assert.equal('animationId' in node, false);
    for (const c of node.children) if (c.type === 'group') walk(c);
  })(sheet.layerTree);
  assert.equal(sheet.layerTree.children.some(c => c.id === 'g'), true);
});

test('pixels a v3 strip hid move to a hidden covered folder; the render is unchanged', () => {
  const p = v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('b', 16, 0)],
    animations: [strip('run', ['a', 'b'], { layerGroupId: 'g' })],
    children: [
      layer('base', [[2, 2, RED], [40, 2, RED]]),                  // (2,2) lies under the strip
      group('g', [layer('ink', [[3, 3, BLUE], [50, 20, BLUE]])], 'run'), // (50,20) lies outside its frames
    ],
  }));
  const expected = v3Render(p);
  const sheet = load(p).sheets[0];
  assert.deepEqual(render(sheet).data, expected.data);
  const folder = sheet.layerTree.children[0];
  assert.equal(folder.name, COVERED_FOLDER_NAME);
  assert.deepEqual(folder.children.map(l => [l.name, l.visible]), [['base', false], ['ink', false]]);
  assert.deepEqual(getPixel(folder.children[0].bitmap, 2, 2), RED);
  assert.deepEqual(getPixel(folder.children[1].bitmap, 50, 20), BLUE);
  const base = sheetLayers(sheet).find(l => l.name === 'base' && l.visible);
  assert.deepEqual([getPixel(base.bitmap, 2, 2), getPixel(base.bitmap, 40, 2)], [NONE, RED]);
});

test('converts overlapping accepted strips without changing the render', () => {
  const p = v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('c', 8, 0)],
    animations: [strip('run', ['a'], { layerGroupId: 'g1' }), strip('walk', ['c'], { layerGroupId: 'g2' })],
    children: [
      layer('base', [[12, 12, BLUE], [30, 30, BLUE]]),
      group('g1', [layer('ink1', [[2, 2, RED], [10, 2, RED]])], 'run'),
      group('g2', [layer('ink2', [[10, 3, GREEN], [2, 3, GREEN]])], 'walk'),
    ],
  }));
  const expected = v3Render(p);
  assert.deepEqual(render(load(p).sheets[0]).data, expected.data);
});

test('no covered folder is created when a strip hid nothing', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0)], animations: [strip('run', ['a'], { layerGroupId: 'g' })],
    children: [layer('base', [[40, 2, RED]]), group('g', [layer('ink', [[1, 1, BLUE]])], 'run')],
  }))).sheets[0];
  assert.equal(sheet.layerTree.children.some(c => c.name === COVERED_FOLDER_NAME), false);
});

test('v4 saves layout, cell, locked and sheetMaxWidth and loads them back', () => {
  const project = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('b', 16, 0)], animations: [strip('run', ['a', 'b'], { layerGroupId: 'g' })],
    children: [layer('base'), group('g', [layer('ink')], 'run')],
  })));
  sheetLayers(project.sheets[0])[0].locked = true;
  const { json, images } = serializeProject(project);
  assert.equal(json.version, PROJECT_VERSION);
  assert.equal(PROJECT_VERSION, 4);
  const saved = json.sheets[0].animations[0];
  assert.deepEqual([saved.layout, saved.cell, 'strip' in saved, 'animationId' in json.sheets[0].layerTree], ['auto', { w: 16, h: 16 }, false, false]);
  const again = deserializeProject(JSON.parse(JSON.stringify(json)), new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual([again.sheets[0].animations[0].layout, again.sheets[0].animations[0].cell], ['auto', { w: 16, h: 16 }]);
  assert.equal(sheetLayers(again.sheets[0])[0].locked, true);
  assert.equal(again.settings.sheetMaxWidth, W);
});

test('v4 requires sheetMaxWidth; unknown versions are rejected', () => {
  const p = v3Project(({ layer }) => ({ frames: [], animations: [], children: [layer('base')] }));
  p.json.version = 4;
  assert.match(validateProjectJson(p.json).error, /sheetMaxWidth/);
  p.json.version = 5;
  assert.match(validateProjectJson(p.json).error, /unsupported version 5/);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/legacy-animation-conversion.test.mjs`
Expected: FAIL, "Cannot find module .../legacy-animations.js".

- [ ] **Step 3: Implement `js/core/legacy-animations.js`**

```js
// v2/v3 -> v4 animation conversion, run once by deserializeProject on files
// saved before auto layout. Strips, breaks, accepted/floating animations and
// animation-owned layer groups are gone in v4; this decides which old
// animations become `auto` and makes sure nothing that rendered differently
// in v3 renders differently now. Deliberately imports nothing from
// model.js (model.js imports this). See the animations workbench design §1.
import { createBitmap } from './pixels.js';
import { newId } from './palettes.js';

export const COVERED_FOLDER_NAME = 'Covered by strips (converted)';

function layersUnder(node, out = []) {
  for (const c of node.children ?? []) {
    if (c.type === 'layer') out.push(c);
    else layersUnder(c, out);
  }
  return out;
}

function groupsUnder(node, out = []) {
  if (node.type !== 'group') return out;
  out.push(node);
  for (const c of node.children ?? []) groupsUnder(c, out);
  return out;
}

// An accepted strip with no breaks whose frames are equal-sized, share a
// pivot, sit edge to edge in one row in timeline order, appear once each,
// and are not already claimed by an earlier auto animation.
function qualifiesForAuto(anim, frames, claimed) {
  if ((anim.breaks ?? []).length) return false;
  const list = (anim.frames ?? []).map(e => frames.get(e.frameId));
  if (!list.length || list.some(f => !f)) return false;
  if (new Set(list.map(f => f.id)).size !== list.length) return false;
  const [first] = list;
  return list.every((f, i) => !claimed.has(f.id) &&
    f.w === first.w && f.h === first.h && f.y === first.y && f.x === first.x + i * first.w &&
    f.pivotX === first.pivotX && f.pivotY === first.pivotY);
}

// v3 showed, at each pixel, the composite of the LAST accepted strip whose
// frames cover it -- or, outside every accepted strip's frames, the
// composite of all non-strip layers. Any non-empty pixel a layer could not
// show is moved (never deleted) into a hidden copy of that layer under one
// hidden folder, so the converted sheet renders identically.
function moveCoveredPixels(sheet, accepted, groups, frames) {
  if (!accepted.length) return;
  const W = sheet.width, H = sheet.height;
  const owner = new Int32Array(W * H).fill(-1);
  accepted.forEach((anim, s) => {
    for (const e of anim.frames) {
      const f = frames.get(e.frameId);
      if (!f) continue;
      const x0 = Math.max(0, f.x), x1 = Math.min(W, f.x + f.w);
      if (x1 <= x0) continue;
      for (let y = Math.max(0, f.y); y < Math.min(H, f.y + f.h); y++) owner.fill(s, y * W + x0, y * W + x1);
    }
  });
  const layerOwner = new Map();
  accepted.forEach((anim, s) => { for (const l of layersUnder(groups.get(anim.layerGroupId))) layerOwner.set(l, s); });
  let folder = null;
  for (const layer of layersUnder(sheet.layerTree)) {
    const own = layerOwner.get(layer) ?? -1;
    const d = layer.bitmap.data;
    let target = null;
    for (let p = 0; p < W * H; p++) {
      if (d[p * 4 + 3] === 0 || owner[p] === own) continue;
      if (!target) {
        folder ??= { id: newId('gp'), type: 'group', name: COVERED_FOLDER_NAME, open: false, children: [] };
        target = { id: newId('ly'), type: 'layer', name: layer.name, visible: false, opacity: layer.opacity, locked: false, bitmap: createBitmap(W, H) };
        folder.children.push(target);
      }
      target.bitmap.data.set(d.subarray(p * 4, p * 4 + 4), p * 4);
      d.fill(0, p * 4, p * 4 + 4);
    }
  }
  if (folder) sheet.layerTree.children.unshift(folder); // children[0] composites first: the bottom
}

export function convertLegacySheet(sheet) {
  const frames = new Map(sheet.frames.map(f => [f.id, f]));
  const groups = new Map(groupsUnder(sheet.layerTree).map(g => [g.id, g]));
  const accepted = sheet.animations.filter(a => a.strip && a.layerGroupId && groups.has(a.layerGroupId));
  moveCoveredPixels(sheet, accepted, groups, frames);
  const claimed = new Set();
  for (const anim of sheet.animations) {
    const auto = accepted.includes(anim) && qualifiesForAuto(anim, frames, claimed);
    anim.layout = auto ? 'auto' : 'manual';
    anim.cell = null;
    if (!auto) continue;
    const first = frames.get(anim.frames[0].frameId);
    anim.cell = { w: first.w, h: first.h };
    for (const e of anim.frames) claimed.add(e.frameId);
  }
}
```

- [ ] **Step 4: Wire v4 into `js/core/model.js`**

4a. Change `export const PROJECT_VERSION = 3;` to `export const PROJECT_VERSION = 4;`, and add `import { convertLegacySheet } from './legacy-animations.js';` to the imports.

4b. Add after `addAnimation`:

```js
// The v4 animation shape: strips, breaks and animation-owned layer groups
// are gone (js/core/legacy-animations.js converts older files). Used for
// both save and load so neither direction can leak a legacy field.
export function normalizeAnimation(a) {
  const { strip: _strip, breaks: _breaks, layerGroupId: _layerGroupId, ...rest } = a;
  const auto = a.layout === 'auto' && a.cell?.w >= 1 && a.cell?.h >= 1;
  return {
    ...rest,
    frames: (a.frames ?? []).map(e => ({ ...e })),
    layout: auto ? 'auto' : 'manual',
    cell: auto ? { w: a.cell.w, h: a.cell.h } : null,
  };
}

function clearGroupOwnership(group) {
  delete group.animationId;
  for (const c of group.children ?? []) if (c.type === GROUP) clearGroupOwnership(c);
}
```

4c. In `serializeGroup`, delete `animationId: group.animationId ?? null,` so the line reads `id: group.id, type: group.type, name: group.name, open: group.open ?? true,`.

4d. In `serializeProject`, replace the `animations: s.animations.map(a => ({ ...a, ... }))` line with:

```js
      animations: s.animations.map(normalizeAnimation),
```

4e. In `deserializeProject`, change the sheet mapper so it builds the sheet, converts it, then normalizes it. Replace `return { id: s.id, ..., layerTree, };` (lines 714-729) with:

```js
      const sheet = {
        id: s.id, name: s.name, width: s.width, height: s.height, kind: s.kind,
        ...(() => {
          if (s.kind !== 'tile') return { tileGrids: null, tiles: null, terrainSets: null, terrainLayoutPresets: null, tileLayerNames: null };
          if (!s.tiles && s.tile) return { ...migrateLegacyTile(s), terrainSets: [], terrainLayoutPresets: [], tileLayerNames: [] };
          return {
            tileGrids: s.tileGrids ?? [], tiles: s.tiles ?? [],
            terrainSets: s.terrainSets ?? [], terrainLayoutPresets: s.terrainLayoutPresets ?? [],
            // Without a tree, saved `layers` are legacy pixels, not tile names.
            tileLayerNames: s.layerTree ? (s.layers ?? []) : [],
          };
        })(),
        frames: s.frames ?? [],
        animations: (s.animations ?? []).map(a => ({ ...a, frames: (a.frames ?? []).map(e => ({ ...e })) })),
        layerTree,
      };
      if (json.version < 4) convertLegacySheet(sheet);
      sheet.animations = sheet.animations.map(normalizeAnimation);
      clearGroupOwnership(sheet.layerTree);
      return sheet;
```

`deserializeGroup` keeps reading `animationId`, because `convertLegacySheet` needs it. `clearGroupOwnership` then removes it.

4f. In `validateProjectJson`, replace the version check with:

```js
  if (![2, 3, PROJECT_VERSION].includes(json.version))
    return { ok: false, error: `unsupported version ${json.version} (expected ${PROJECT_VERSION})` };
```

and replace the T1 `sheetMaxWidth` check with:

```js
  if ((json.version >= 4 || json.settings.sheetMaxWidth !== undefined) && !validImportDimension(json.settings.sheetMaxWidth))
    return { ok: false, error: `settings.sheetMaxWidth must be an integer in 1..${MAX_DIM}` };
```

- [ ] **Step 5: Run the new tests**

Run: `node --test tests/legacy-animation-conversion.test.mjs tests/sheet-model-foundations.test.mjs`
Expected: PASS.

- [ ] **Step 6: Update `tests/model.test.mjs` for the v4 shape**

Run: `node --test tests/model.test.mjs` and list every failing test name from the full output. Fix each failure by these rules only. Do not change product code to satisfy an old assertion.

- An expected `version: 3` / `PROJECT_VERSION` value of 3 → `4`.
- An expected serialized or deserialized animation containing `strip`, `breaks` or `layerGroupId` → drop those keys and add `layout: 'manual', cell: null`. Use `layout: 'auto'` with the frames' cell when the fixture is an accepted, contiguous strip per the T6 rules.
- An expected serialized or deserialized group containing `animationId` → drop the key.
- An expected serialized layer object without `locked` → add `locked: false`.
- A test whose purpose was "v3 accepted strip keeps its layerGroupId through save/load" → rewrite it to assert the T6 conversion result (layout and cell), or delete it if `legacy-animation-conversion.test.mjs` already covers the same case.

These named tests need these exact changes:

- `'project carries required settings; version 3'`: rename it to `'project carries required settings; version 4'` and assert `p.version === 4`.
- `'animations carry strip flag; serialize round-trips settings and strip'`: rename it to `'animations save as manual; serialize round-trips settings'`. Delete the two `strip` assertions, change `json.version` to `4`, and add `assert.deepEqual([p2.sheets[0].animations[0].layout, p2.sheets[0].animations[0].cell, 'strip' in p2.sheets[0].animations[0]], ['manual', null, false]);`. Leave the `addAnimation(s, 'walk', true)` call alone; T8 changes that signature.
- `'addAnimation initializes breaks; serialize/deserialize round-trips them'` and `'deserializeProject defaults missing breaks to []'`: delete both. Breaks no longer survive a save, and `legacy-animation-conversion.test.mjs` covers the v3 cases.

Rerun until the file passes.

- [ ] **Step 7: Run every test file that loads projects**

Run: `node --test tests/model.test.mjs tests/zip.test.mjs tests/autosave-idb.test.mjs tests/file-controller.test.mjs`
(Skip any of these names that does not exist; list the matching files with `Get-ChildItem tests -Filter *file*`.)
Expected: PASS. Report every failing test name if any fail.

- [ ] **Step 8: Commit (only if authorized)**

```bash
git add js/core/legacy-animations.js js/core/model.js tests/legacy-animation-conversion.test.mjs tests/model.test.mjs
git commit -m "feat: save format v4 with v2/v3 strip conversion"
```

### Task 7: Retire the strip commands and strip UI; pin auto-laid-out frames in Sprite Sheets

**Files:**
- Delete:
  - `js/modes/sprites/application/commands/strip-commands.js`
  - `js/modes/sprites/application/commands/animation-commands.js`
  - `js/modes/sprites/application/frame-pixel-motion.js`
  - `js/domain/sprites/strips.js`
  - `js/core/strips.js`
- Delete tests:
  - `tests/sprite-strip-commands.test.mjs`
  - `tests/sprite-animation-commands.test.mjs`
  - `tests/strips.segments.test.mjs`
  - `tests/strips.test.mjs`
  - `tests/frame-pixel-motion.test.mjs`
- Modify:
  - `js/core/model.js` (`removeFrame` at 438, the `removeEntry` import at line 4)
  - `js/domain/sprites/frames.js`
  - `js/modes/sprites/application/{frame-geometry,frame-chrome-geometry}.js`
  - `js/modes/sprites/application/commands/{frame-commands,frame-metadata-commands,animation-frame-commands}.js`
  - `js/modes/sprites/contributions.js`
  - `js/modes/sprites/presentation/{frame-tool-presenter,frame-overlay-renderer,frames-panel,timeline-presenter}.js`
  - `js/components/canvas/{drawing-engine,sheet-overlays}.js`
  - `js/features/workbench/editor-workbench.js`
  - `js/features/animations/commands.js`
- Test:
  - `tests/pinned-frame-guards.test.mjs` (create)
  - Edit `tests/{sprite-domain,frame-geometry,frame-chrome-geometry,sprite-frame-metadata-commands,sprite-frame-commands,builtinmodes,model}.test.mjs`

**Interfaces:**
- Consumes: `isPinnedFrame(sheet, frameId)`, `autoAnimationOf(sheet, frameId)` and `PINNED_HINT` from T2, plus `deleteLaidOutFrame` from T5.
- Produces:
  - `frameAt(sheet, x, y)` in `js/domain/sprites/frames.js`. `frame-geometry.js` re-exports it.
  - `moveFrames(services, sheetId, frameIds, dx, dy)`: metadata only. It drops the `animationId` parameter.
  - These refuse pinned frames with `{ ok: false, reason: PINNED_HINT }`:
    - `moveFrames` and `resizeFrame`
    - `setFrameField` for the keys `x`, `y`, `w`, `h`, `pivotX` and `pivotY`
  - `addAnimationFrame`, `removeAnimationFrame` and `reorderAnimationFrame` refuse an auto animation with `{ ok: false, reason: AUTO_TIMELINE }`.
  - `drawFrameChrome(ctx, view)` from `frame-tool-presenter.js` replaces `drawStripChrome`.
  - `sprites.deleteFrame` routes a pinned frame to `deleteLaidOutFrame`.
  - 11 `sprites.*` ids are gone:
    - `acceptAnimation`, `breakApartStrip`
    - `insertStripFrame`, `mergeStripSegments`, `newStripFromFrame`, `removeStripMember`, `resizeStripSegment`, `splitStrip`
    - `moveStripTo`, `setStripFrameSize`, `setStripPivot`

- [ ] **Step 1: Write the failing tests**

Create `tests/pinned-frame-guards.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { PINNED_HINT } from '../js/domain/sprites/auto-layout.js';
import { newAutoAnimation } from '../js/modes/sprites/application/commands/animation-layout-commands.js';
import { createFrame, moveFrames, resizeFrame } from '../js/modes/sprites/application/commands/frame-commands.js';
import { setFrameField } from '../js/modes/sprites/application/commands/frame-metadata-commands.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration,
} from '../js/modes/sprites/application/commands/animation-frame-commands.js';

const RED = [255, 0, 0, 255];

function setup() {
  const project = createProject('t');
  project.settings.sheetMaxWidth = 64;
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
  const { animationId } = newAutoAnimation(services, sheet.id, { name: 'run', w: 16, h: 16 });
  const anim = sheet.animations[0];
  return { project, sheet, services, anim, animationId, pinned: sheet.frames[0] };
}

test('a pinned frame cannot be moved or resized; a plain frame still moves', () => {
  const { sheet, services, pinned } = setup();
  assert.deepEqual(moveFrames(services, sheet.id, [pinned.id], 4, 0), { ok: false, reason: PINNED_HINT });
  assert.deepEqual(resizeFrame(services, sheet.id, pinned.id, { x: 0, y: 0, w: 16, h: 16 }, { x: 0, y: 0, w: 8, h: 8 }), { ok: false, reason: PINNED_HINT });
  assert.deepEqual([pinned.x, pinned.w], [0, 16]);
  services.history.undo(); // the only recorded step is "new animation"
  assert.equal(services.history.canUndo(), false);
  services.history.redo();
  createFrame(services, sheet.id, { x: 40, y: 40, w: 8, h: 8 });
  const plain = sheet.frames.at(-1);
  moveFrames(services, sheet.id, [plain.id], 2, 0);
  assert.equal(plain.x, 42);
});

test('setFrameField refuses geometry on a pinned frame but still renames it', () => {
  const { sheet, services, pinned } = setup();
  for (const key of ['x', 'y', 'w', 'h', 'pivotX', 'pivotY'])
    assert.deepEqual(setFrameField(services, sheet.id, pinned.id, key, 3), { ok: false, reason: PINNED_HINT });
  setFrameField(services, sheet.id, pinned.id, 'name', 'hero');
  assert.equal(pinned.name, 'hero');
});

test('the plain timeline commands refuse an auto animation; timing edits still apply', () => {
  const { sheet, services, anim, pinned } = setup();
  for (const r of [
    addAnimationFrame(services, sheet.id, anim.id, pinned.id),
    removeAnimationFrame(services, sheet.id, anim.id, 0),
    reorderAnimationFrame(services, sheet.id, anim.id, 0, 0),
  ]) assert.equal(r.ok, false);
  assert.equal(anim.frames.length, 1);
  setAnimationFrameDuration(services, sheet.id, anim.id, 0, 250);
  assert.equal(anim.frames[0].duration, 250);
});

test('sprites.deleteFrame routes a pinned frame to the layout-aware delete', () => {
  const host = new EditorHost();
  setEditorHost(host);
  host.registerMode(spriteMode);
  const project = createProject('t');
  project.settings.sheetMaxWidth = 64;
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite' });
  host.setProject(project);
  host.store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const run = (id, args) => host.registries.commands.execute(id, { modeId: 'sprites' }, { sheetId: sheet.id, ...args });
  const { animationId } = run('animations.new', { name: 'run', w: 16, h: 16 });
  run('animations.addFrame', { animationId, at: 1 });
  const [f0, f1] = sheet.frames;
  setPixel(sheetLayers(sheet)[0].bitmap, 17, 1, RED);
  run('sprites.deleteFrame', { frameId: f0.id });
  assert.deepEqual([sheet.frames, f1.x], [[f1], 0]);
  assert.deepEqual(getPixel(sheetLayers(sheet)[0].bitmap, 1, 1), RED);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/pinned-frame-guards.test.mjs`
Expected: FAIL. `moveFrames` returns `undefined` instead of the refusal, and the deleteFrame routing test leaves `f0` in place.

- [ ] **Step 3: Simplify `removeFrame` in `js/core/model.js`**

Delete `import { removeEntry } from './strips.js';` and replace `removeFrame` with:

```js
export function removeFrame(sheet, frameId) {
  sheet.frames = sheet.frames.filter(f => f.id !== frameId);
  for (const a of sheet.animations) a.frames = a.frames.filter(e => e.frameId !== frameId);
}
```

- [ ] **Step 4: Rewrite `js/modes/sprites/application/commands/frame-commands.js`**

Replace the whole file with:

```js
import { addFrame, removeFrame } from '../../../../core/model.js';
import { sliceGrid } from '../../../../core/slicing.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';
import { isPinnedFrame, PINNED_HINT } from '../../../../domain/sprites/auto-layout.js';

export function findSpriteSheet(project, sheetId) {
  return project?.sheets.find(sheet => sheet.id === sheetId) ?? null;
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function runSheetCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSpriteSheet(project, sheetId), apply, revert);
}

export function createFrame(services, sheetId, rect) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const doc = sheetDocument(sheet);
  const name = `frame_${sheet.frames.length}`;
  let created = null;
  runSheetCommand(services, sheetId, 'add frame',
    target => {
      if (!created) created = addFrame(target, { name, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      else if (!target.frames.includes(created)) target.frames.push(created);
      services.selections.set({ ...services.selections.get(doc), frameId: created.id }, doc);
    },
    target => {
      target.frames = target.frames.filter(f => f !== created);
      if (services.selections.get(doc)?.frameId === created.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    });
}

// A plain (unpinned) frame's delete. contributions.js routes pinned frames
// to animation-layout-commands.js's deleteLaidOutFrame instead.
export function deleteFrame(services, sheetId, frameId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.frames.indexOf(frame);
  // removeFrame rewrites EVERY animation's entries, so undo needs a snapshot
  // of all of them, not just the ones referencing this frame.
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));
  const wasSelected = services.selections.get(doc)?.frameId === frameId;
  runSheetCommand(services, sheetId, 'delete frame',
    target => {
      removeFrame(target, frame.id);
      if (services.selections.get(doc)?.frameId === frame.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    },
    target => {
      target.frames.splice(Math.min(idx, target.frames.length), 0, frame);
      for (const snap of animSnapshots) snap.anim.frames = snap.frames.slice();
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), frameId: frame.id }, doc);
    });
}

export function resizeFrame(services, sheetId, frameId, before, after) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  if (isPinnedFrame(sheet, frameId)) return { ok: false, reason: PINNED_HINT };
  runSheetCommand(services, sheetId, 'resize frame',
    () => { frame.x = after.x; frame.y = after.y; frame.w = after.w; frame.h = after.h; },
    () => { frame.x = before.x; frame.y = before.y; frame.w = before.w; frame.h = before.h; });
  return { ok: true };
}

// Frames are viewports onto the sheet, so moving one is metadata-only. An
// auto-laid-out ("pinned") frame's rect belongs to its layout and is refused.
export function moveFrames(services, sheetId, frameIds, dx, dy) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || (dx === 0 && dy === 0)) return;
  const frames = frameIds.map(id => sheet.frames.find(f => f.id === id)).filter(Boolean);
  if (!frames.length) return;
  if (frames.some(f => isPinnedFrame(sheet, f.id))) return { ok: false, reason: PINNED_HINT };
  const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  runSheetCommand(services, sheetId, frames.length > 1 ? 'move frames' : 'move frame',
    () => { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
    () => { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } });
  return { ok: true };
}

// Slice-grid dialog's Create action, minus the DOM reads. `options` carries
// cellW/cellH/marginX/marginY/spacingX/spacingY/namePrefix already clamped by
// the dialog; sheetWidth/sheetHeight come from the sheet itself.
export function sliceSheetIntoFrames(services, sheetId, options, replace) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const newFrames = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...options });

  const beforeFrames = sheet.frames.slice();
  const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));
  if (replace) {
    sheet.frames = [];
    for (const a of sheet.animations) a.frames = [];
  }
  for (const nf of newFrames) addFrame(sheet, nf);
  const afterFrames = sheet.frames.slice();
  const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));

  runSheetCommand(services, sheetId, 'slice grid',
    target => {
      target.frames = afterFrames.slice();
      for (const snap of afterAnimSnapshots) snap.anim.frames = snap.frames.slice();
    },
    target => {
      target.frames = beforeFrames.slice();
      for (const snap of beforeAnimSnapshots) snap.anim.frames = snap.frames.slice();
    });
}
```

- [ ] **Step 5: Rewrite `frame-metadata-commands.js` and guard `animation-frame-commands.js`**

Replace `js/modes/sprites/application/commands/frame-metadata-commands.js` with:

```js
import { isPinnedFrame, PINNED_HINT } from '../../../../domain/sprites/auto-layout.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

const GEOMETRY_KEYS = new Set(['x', 'y', 'w', 'h', 'pivotX', 'pivotY']);

// A pinned frame keeps its name editable; its rect and pivot belong to the
// auto layout (the shared pivot is animations.setPivot).
export function setFrameField(services, sheetId, frameId, key, value) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  if (GEOMETRY_KEYS.has(key) && isPinnedFrame(sheet, frameId)) return { ok: false, reason: PINNED_HINT };
  const before = frame[key];
  if (before === value) return { ok: true };
  runSheetCommand(services, sheetId, `edit frame ${key}`,
    () => { frame[key] = value; },
    () => { frame[key] = before; });
  return { ok: true };
}
```

In `animation-frame-commands.js`, add below the imports:

```js
export const AUTO_TIMELINE = 'This animation is auto-laid-out: use the animations.* frame commands';
```

then, in `addAnimationFrame`, `removeAnimationFrame` and `reorderAnimationFrame`, replace `if (!anim) return;` with:

```js
  if (!anim) return;
  if (anim.layout === 'auto') return { ok: false, reason: AUTO_TIMELINE };
```

and end each of those three functions with `return { ok: true };` after the `commitFramesChange(...)` call. `setAnimationFrameDuration` and `setAnimationFrameStep` stay unchanged: timing never moves pixels.

- [ ] **Step 6: Move `frameAt` and shrink the frame geometry modules**

Append to `js/domain/sprites/frames.js`:

```js
// The topmost frame (last in sheet.frames) containing the pixel (x, y).
export function frameAt(sheet, x, y) {
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h) return f;
  }
  return null;
}
```

In `js/modes/sprites/application/frame-geometry.js`:
- Delete the `frameAt` function, `stripMembers`, `stripResizeCount` and `resizeGhostRect`.
- Add `export { frameAt } from '../../../domain/sprites/frames.js';` under the `rectBetween` re-export.
- Change the header comment's "frame/strip tool" to "frame tool".
- `snapValue`, `snapPoint`, `snapRect` and `clampMoveDelta` stay.

Replace `js/modes/sprites/application/frame-chrome-geometry.js` with:

```js
// Screen-space hit-testing for the frame tool's corner handles. Callers pass a
// `toScreen(x, y) -> {x, y}` projector (presentation supplies
// `(x, y) => view.imageToScreen(x, y)`), keeping this module pure.
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';

export const HANDLE_SCREEN_PX = 6;

export function hitHandle(toScreen, frame, sx, sy) {
  if (!frame) return null;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? frame.x : frame.x + frame.w;
    const iy = h[0] === 'n' ? frame.y : frame.y + frame.h;
    const p = toScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}
```

- [ ] **Step 7: Rewrite `js/modes/sprites/presentation/frame-tool-presenter.js`**

Replace the whole file with:

```js
// js/modes/sprites/presentation/frame-tool-presenter.js
// Humble Object for the frame tool: binds pointer + keyboard events, calls
// pure Application-layer geometry for every decision, dispatches Commands BY
// ID, and delegates all drawing to frame-overlay-renderer.js.
//
// registerFrameTool() adds the palette button + its tool-options row (snap
// checkbox, grid size, slice button) and the Delete key handler;
// bindFrameTool(view) wraps the view's existing onPointer/onOverlay, so it
// must run after bindDrawing() has installed its own.
//
// A frame an auto-laid-out animation places ("pinned", see
// domain/sprites/auto-layout.js) selects and opens like any other, but never
// drags or resizes here: its rect belongs to the layout.
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { registerTool } from '../../../components/tool-palette.js';
import { isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../../core/resizeAnchor.js';
import { isPinnedFrame } from '../../../domain/sprites/auto-layout.js';
import { frameToolOptions } from '../application/frame-tool-state.js';
import { snapPoint, snapRect, rectBetween, frameAt, clampMoveDelta } from '../application/frame-geometry.js';
import { hitHandle } from '../application/frame-chrome-geometry.js';
import { paintFrameToolGhost, paintFrameChrome } from './frame-overlay-renderer.js';
import { buildSliceDialog, setSlicePreviewView, slicePreviewOptions } from './slice-grid-dialog.js';
import { bindDragCancelGuard } from '../../../components/canvas/drag-cancel-guard.js';

// In-progress drag state (create/move/resize), module-scoped like
// drawing-engine.js's `selection`/`stroke` -- there is only ever one
// frame-tool drag at a time. `lastClick` is the previous pointerdown's
// { frameId, t } for double-click detection.
let drag = null;
let lastClick = null;

// Set once by registerFrameTool() (which builds the dialog before the tool
// palette can render its options row); the button just defers to whatever's
// there.
let sliceDialogApi = null;

function projector(view) { return (x, y) => view.imageToScreen(x, y); }

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- tests/architecture.test.mjs bans
// presentation-layer code from importing anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function currentModeId() { return getEditorHost().store.getState().session.activeModeId; }
function currentToolId() { return getEditorHost().store.getState().session.activeToolId; }
function storeOn(event, handler) {
  const store = getEditorHost().store;
  if (event === 'project') return store.subscribe(s => s.project.model, handler);
  if (event === 'tool') return store.subscribe(s => s.session.activeToolId, handler);
  throw new Error(`storeOn: unsupported event "${event}"`);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
function sheetSelection(sheet) {
  return getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
}
function setSheetSelection(sheet, patch) {
  getEditorHost().selections.set({ ...sheetSelection(sheet), ...patch }, sheetDocument(sheet));
}
function ownerAnimationId(sheet, frameId) {
  return sheet.animations.find(a => a.frames.some(e => e.frameId === frameId))?.id ?? null;
}

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet('sprite');
  if (!sheet) return;
  const hit = frameAt(sheet, ev.x, ev.y);
  // Double-click (two downs on the same frame within 350ms) opens the frame
  // editor and points the timeline at the frame's animation.
  const now = performance.now();
  if (hit && lastClick && lastClick.frameId === hit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    setSheetSelection(sheet, { animationId: ownerAnimationId(sheet, hit.id), editingFrameId: hit.id });
    getEditorHost().store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
    return;
  }
  lastClick = hit ? { frameId: hit.id, t: now } : null;
  const selected = sheet.frames.find(f => f.id === sheetSelection(sheet).frameId) || null;
  // Pinned frames have no resize handles: skip the hit test entirely so a
  // down on a handle-shaped spot falls through to the select checks below.
  const handle = (selected && !isPinnedFrame(sheet, selected.id)) ? hitHandle(projector(view), selected, ev.sx, ev.sy) : null;
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
  if (hit) {
    // Selecting a frame also selects its owning animation (or clears it for
    // a standalone frame), so the timeline never keeps a stale animation.
    const ownerId = ownerAnimationId(sheet, hit.id);
    const current = sheetSelection(sheet);
    if (current.frameId !== hit.id || current.animationId !== ownerId) setSheetSelection(sheet, { frameId: hit.id, animationId: ownerId });
    if (!isPinnedFrame(sheet, hit.id)) {
      drag = {
        kind: 'move', frame: hit, bbox: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
        anchor: { x: ev.x, y: ev.y }, delta: { dx: 0, dy: 0 },
      };
    }
    view.requestRender();
    return;
  }
  const cleared = sheetSelection(sheet);
  if (cleared.frameId != null || cleared.animationId != null) setSheetSelection(sheet, { frameId: null, animationId: null });
  drag = { kind: 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) return;
  if (drag.kind === 'create') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true), frameToolOptions);
  } else if (drag.kind === 'move') {
    const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y), frameToolOptions);
    drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    }), frameToolOptions);
  }
  view.requestRender();
}

function handleUp(ev, view) {
  if (!drag) return;
  handleMove(ev, view);
  const sheet = activeSheet('sprite');
  const d = drag;
  drag = null;
  view.requestRender();
  if (!sheet) return;

  if (d.kind === 'create') {
    const moved = ev.x !== d.anchor.x || ev.y !== d.anchor.y;
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1)
      dispatch('sprites.createFrame', { sheetId: sheet.id, rect: d.rect });
    return;
  }
  if (d.kind === 'move') {
    // Keep the whole frame on-sheet. A zero delta is a no-op in moveFrames.
    const { dx, dy } = clampMoveDelta(sheet, d.bbox, d.delta);
    dispatch('sprites.moveFrames', { sheetId: sheet.id, frameIds: [d.frame.id], dx, dy });
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      dispatch('sprites.resizeFrame', { sheetId: sheet.id, frameId: d.frame.id, before: d.before, after: r });
  }
}

// ------------------------------------------------------------- tool options row

function buildOptionsRow(optionsRow) {
  // Three controls (Snap checkbox, grid size, slice-grid button) don't fit on
  // one row in the 112px-wide tool palette -- split into stacked rows,
  // grouping the snap checkbox with its grid-size field (they're read
  // together) and giving the slice action its own row.
  const snapRow = document.createElement('label');
  snapRow.className = 'tool-option-row';
  const snapInput = document.createElement('input');
  snapInput.type = 'checkbox';
  snapInput.checked = frameToolOptions.snap;
  snapInput.addEventListener('change', () => { frameToolOptions.snap = snapInput.checked; });
  snapRow.append(document.createTextNode('Snap'), snapInput);

  const sizeRow = document.createElement('div');
  sizeRow.className = 'tool-option-row';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number'; sizeInput.min = '1'; sizeInput.value = String(frameToolOptions.gridSize);
  sizeInput.addEventListener('change', () => {
    let v = parseInt(sizeInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    sizeInput.value = String(v);
    frameToolOptions.gridSize = v;
  });
  sizeRow.append(document.createTextNode('Grid'), sizeInput);

  const sliceRow = document.createElement('div');
  sliceRow.className = 'tool-option-row';
  const sliceBtn = document.createElement('button');
  sliceBtn.type = 'button';
  sliceBtn.className = 'btn-icon-md';
  sliceBtn.textContent = '▦';
  sliceBtn.title = 'Slice grid…';
  sliceBtn.addEventListener('click', () => sliceDialogApi?.open());
  sliceRow.append(document.createTextNode('Slice'), sliceBtn);

  optionsRow.append(snapRow, sizeRow, sliceRow);
  return [snapRow, sizeRow, sliceRow];
}

// ------------------------------------------------------------- public API

export function registerFrameTool() {
  sliceDialogApi = buildSliceDialog();
  registerTool({ id: 'frametool', icon: '🖼', key: 'f', isAvailable: () => currentModeId() === 'sprites' }, buildOptionsRow);

  // contributions.js routes a pinned frame's delete through the layout.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (currentToolId() !== 'frametool' || currentModeId() !== 'sprites') return;
    const sheet = activeSheet('sprite');
    const frameId = sheet ? (sheetSelection(sheet).frameId ?? null) : null;
    if (frameId) dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId });
  });
}

function drawFrameToolGhost(ctx, view) {
  if (currentModeId() !== 'sprites') return;
  paintFrameToolGhost(ctx, view, activeSheet('sprite'), { drag, slicePreview: slicePreviewOptions() });
}

// Chained by contributions.js as the final sheet-overlay layer so selection
// chrome sits above the frame/tile label overlays.
export function drawFrameChrome(ctx, view) {
  if (currentModeId() !== 'sprites') return;
  const sheet = activeSheet('sprite');
  paintFrameChrome(ctx, view, sheet, {
    tool: currentToolId(), drag, selectedFrameId: sheet ? (sheetSelection(sheet).frameId ?? null) : null,
  });
}

export function bindFrameTool(view) {
  setSlicePreviewView(view);
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (currentModeId() === 'sprites' && currentToolId() === 'frametool') {
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
    drawFrameToolGhost(ctx, view);
  };

  bindDragCancelGuard(storeOn, {
    isToolActive: () => currentToolId() === 'frametool',
    hasDrag: () => !!drag,
    cancel: () => { drag = null; },
    requestRender: () => view.requestRender(),
  });
}
```

- [ ] **Step 8: Rewrite `js/modes/sprites/presentation/frame-overlay-renderer.js`**

Replace the whole file with:

```js
// js/modes/sprites/presentation/frame-overlay-renderer.js
// All Canvas drawing for the frame tool: create/move/resize ghosts, CAD
// dimension labels, corner handles, the pinned-frame hint, and the live
// Slice-grid preview. Every piece of state it needs arrives as a parameter
// -- this module owns no state.
import { sliceGrid } from '../../../core/slicing.js';
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';
import { isPinnedFrame, PINNED_HINT } from '../../../domain/sprites/auto-layout.js';
import { drawRectDims, drawChainDims } from '../../../components/canvas/dim-labels.js';

const FRAME_HANDLE = '#4f8cff';

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

function drawHandles(ctx, view, f) {
  ctx.fillStyle = FRAME_HANDLE;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? f.x : f.x + f.w;
    const iy = h[0] === 'n' ? f.y : f.y + f.h;
    const p = view.imageToScreen(ix, iy);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
}

// Above a selected pinned frame: why it has no handles, and where to go.
function drawPinnedHint(ctx, view, frame) {
  const p = view.imageToScreen(frame.x, frame.y);
  ctx.save();
  ctx.font = '11px sans-serif';
  const w = Math.ceil(ctx.measureText(PINNED_HINT).width) + 8;
  const h = 16;
  const x = Math.max(0, Math.min(view.cssWidth - w, p.x));
  const y = Math.max(0, p.y - h - 4);
  ctx.fillStyle = 'rgba(20,20,24,.85)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d8ccff';
  ctx.textBaseline = 'middle';
  ctx.fillText(PINNED_HINT, x + 4, y + h / 2);
  ctx.restore();
}

// Ghost grid + CAD chains for the open Slice-grid dialog: cell outlines in
// the standard dashed ghost style; level-0 chains along the TOP edge (one
// dimension per column width) and LEFT edge (one per row height); level-1
// overall region dimensions. Uses core sliceGrid so the preview always
// matches exactly what Create would produce. Degenerate inputs draw nothing.
function drawSlicePreview(ctx, view, sheet, o) {
  if (o.cellW < 1 || o.cellH < 1) return;
  let cells;
  try {
    cells = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...o });
  } catch {
    return;
  }
  if (!cells.length) return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const c of cells) strokeGhostRect(ctx, view, c);
  ctx.restore();
  const firstRow = cells.filter(c => c.y === cells[0].y);
  const firstCol = cells.filter(c => c.x === cells[0].x);
  drawChainDims(ctx, view, {
    axis: 'h', side: 'start', edge: cells[0].y,
    spans: firstRow.map(c => ({ from: c.x, to: c.x + c.w, text: `${c.w}` })),
  });
  drawChainDims(ctx, view, {
    axis: 'v', side: 'start', edge: cells[0].x,
    spans: firstCol.map(c => ({ from: c.y, to: c.y + c.h, text: `${c.h}` })),
  });
  const lastX = Math.max(...firstRow.map(c => c.x + c.w));
  const lastY = Math.max(...firstCol.map(c => c.y + c.h));
  drawChainDims(ctx, view, {
    axis: 'h', side: 'start', edge: cells[0].y, level: 1,
    spans: [{ from: cells[0].x, to: lastX, text: `${lastX - cells[0].x}` }],
  });
  drawChainDims(ctx, view, {
    axis: 'v', side: 'start', edge: cells[0].x, level: 1,
    spans: [{ from: cells[0].y, to: lastY, text: `${lastY - cells[0].y}` }],
  });
}

export function paintFrameToolGhost(ctx, view, sheet, { drag, slicePreview }) {
  if (!sheet) return;
  if (slicePreview) drawSlicePreview(ctx, view, sheet, slicePreview);
  if (!drag) return;

  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'move') strokeGhostRect(ctx, view, { ...drag.bbox, x: drag.bbox.x + drag.delta.dx, y: drag.bbox.y + drag.delta.dy });
  else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  ctx.restore();

  if (drag.kind === 'create' && drag.rect) {
    drawRectDims(ctx, view, drag.rect);
  } else if (drag.kind === 'move') {
    const { dx, dy } = drag.delta;
    drawRectDims(ctx, view, { ...drag.bbox, x: drag.bbox.x + dx, y: drag.bbox.y + dy }, { dx, dy });
  } else if (drag.kind === 'resize' && drag.rect) {
    drawRectDims(ctx, view, drag.rect, { dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h });
  }
}

// Selection chrome -- idle dims, resize handles or the pinned hint -- must
// render above EVERYTHING on the sheet overlay (including the frame/tile
// label overlays chained after the frame tool), so contributions.js chains
// this as the final overlay layer instead of drawing it inside
// paintFrameToolGhost.
export function paintFrameChrome(ctx, view, sheet, { tool, drag, selectedFrameId }) {
  if (tool !== 'frametool' || !sheet) return;
  const selected = sheet.frames.find(f => f.id === selectedFrameId);
  if (!selected) return;
  const pinned = isPinnedFrame(sheet, selected.id);
  if (!drag) drawRectDims(ctx, view, selected, { quiet: true });
  if (pinned) { if (!drag) drawPinnedHint(ctx, view, selected); }
  else drawHandles(ctx, view, selected);
}
```

- [ ] **Step 9: Rewrite `js/modes/sprites/presentation/frames-panel.js`**

Replace the whole file with:

```js
// js/modes/sprites/presentation/frames-panel.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { autoAnimationOf, PINNED_HINT } from '../../../domain/sprites/auto-layout.js';
import { mountStorePanel } from '../../../components/panel-mount.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- tests/architecture.test.mjs bans
// presentation-layer code from importing anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function numericField(labelText, value, { step, disabled = false, onCommit }) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  if (step != null) input.step = String(step);
  input.value = String(value);
  input.disabled = disabled;
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => onCommit(Number(input.value)));
  label.appendChild(input);
  return label;
}

function iconButton(text, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-icon-md';
  button.textContent = text;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

export function mountFramesPanel(element) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Frames';
  panel.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'frame-list';
  panel.appendChild(list);

  function actionsRow(sheet, frame, auto) {
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(
      iconButton('✎', 'Edit', () => {
        const host = getEditorHost();
        host.selections.patch({ editingFrameId: frame.id }, sheetDocument(sheet));
        host.store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
      }),
      // contributions.js routes a pinned frame's delete through the layout.
      iconButton('🗑', 'Delete', () => dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId: frame.id })),
    );
    if (auto) {
      const makeManual = document.createElement('button');
      makeManual.type = 'button';
      makeManual.textContent = 'Make manual';
      makeManual.title = `Stop auto-laying-out "${auto.name}"; its frames stay where they are`;
      makeManual.addEventListener('click', () => dispatch('animations.makeManual', { sheetId: sheet.id, animationId: auto.id }));
      actions.appendChild(makeManual);
    }
    return actions;
  }

  function renderFrameDetail(sheet, frame) {
    const auto = autoAnimationOf(sheet, frame.id);
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const setField = (key, value) => dispatch('sprites.setFrameField', { sheetId: sheet.id, frameId: frame.id, key, value });
    // A pinned frame's pivot is its animation's shared pivot.
    const setPivot = (key, value) => (auto
      ? dispatch('animations.setPivot', {
        sheetId: sheet.id, animationId: auto.id,
        pivotX: key === 'pivotX' ? value : frame.pivotX, pivotY: key === 'pivotY' ? value : frame.pivotY,
      })
      : setField(key, value));

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = frame.name;
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (value) setField('name', value);
      else nameInput.value = frame.name;
    });

    const pinned = !!auto;
    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', frame.x, { disabled: pinned, onCommit: value => setField('x', Math.round(value)) }),
      numericField('Y', frame.y, { disabled: pinned, onCommit: value => setField('y', Math.round(value)) }),
      numericField('W', frame.w, { disabled: pinned, onCommit: value => setField('w', Math.max(1, Math.round(value))) }),
      numericField('H', frame.h, { disabled: pinned, onCommit: value => setField('h', Math.max(1, Math.round(value))) }),
      numericField('PivotX', frame.pivotX, { step: 0.5, onCommit: value => setPivot('pivotX', value) }),
      numericField('PivotY', frame.pivotY, { step: 0.5, onCommit: value => setPivot('pivotY', value) }),
    );

    row.append(nameInput, fields);
    if (pinned) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = PINNED_HINT;
      row.appendChild(hint);
    }
    row.appendChild(actionsRow(sheet, frame, auto));
    list.appendChild(row);
  }

  function render() {
    if (getEditorHost().store.getState().session.activeModeId !== 'sprites') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    list.innerHTML = '';
    const sheet = activeSheet('sprite');
    if (!sheet) return;
    const selectedFrameId = getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null;
    const frame = sheet.frames.find(candidate => candidate.id === selectedFrameId) ?? null;
    if (!frame) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = 'No frame selected — click one with the frame tool.';
      list.appendChild(hint);
      return;
    }
    renderFrameDetail(sheet, frame);
  }

  const host = getEditorHost();
  const panelMount = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeViewId,
    s => s.session.activeDocument,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render);
  const disposeHistory = host.history.subscribe(() => panelMount.scheduleRender());
  return { ...panelMount, dispose() { disposeHistory(); panelMount.dispose(); } };
}
```

- [ ] **Step 10: Point the timeline at the auto-aware commands**

In `js/modes/sprites/presentation/timeline-presenter.js`:

1. Update the header comment so that "a horizontal strip of frame cells" no longer implies strips. Replace line 120's comment and line 121 with:

```js
  // Visible only for an auto-laid-out animation.
  const btnMakeManual = document.createElement('button'); btnMakeManual.type = 'button'; btnMakeManual.textContent = 'Make manual'; btnMakeManual.title = 'Stop auto-laying-out this animation; its frames stay where they are';
```

and change `btnBreakApart` to `btnMakeManual` in the `header.append(...)` call (line 135).

2. Replace the `btnDeleteAnim` click handler body (lines 333-341) with:

```js
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    if (!sheet || !anim) return;
    const message = anim.layout === 'auto' ? `Delete animation "${anim.name}" and its frames?` : `Delete animation "${anim.name}"?`;
    if (!confirmOrAuto(message)) return;
    stopPlaying();
    // Settle any float first: an auto delete clears and moves pixels.
    commitFloatIfAny();
    dispatch('animations.delete', { sheetId: sheet.id, animationId: anim.id });
```

3. Replace the `btnBreakApart` click handler (lines 356-361) with:

```js
  btnMakeManual.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    const anim = currentAnim();
    if (!sheet || anim?.layout !== 'auto') return;
    dispatch('animations.makeManual', { sheetId: sheet.id, animationId: anim.id });
  });
```

4. In `buildCell`:
   - Change `cell.draggable = !anim.strip;` to `cell.draggable = true;`.
   - Delete `if (anim.strip) return;` from both the `dragover` and the `drop` listeners.
   - Replace the remove button's click handler and the `if (!anim.strip) controls.append(btnRemove);` line with:

```js
    btnRemove.addEventListener('click', (e) => {
      e.stopPropagation();
      if (anim.layout === 'auto') dispatch('animations.deleteFrame', { sheetId: sheet.id, animationId: anim.id, index });
      else dispatch('sprites.removeAnimationFrame', { sheetId: sheet.id, animationId: anim.id, index });
    });
    controls.append(btnRemove);
```

   - In the `drop` listener, replace the final `dispatch('sprites.reorderAnimationFrame', ...)` line with:

```js
      if (anim.layout === 'auto') dispatch('animations.moveFrame', { sheetId: sheet.id, animationId: anim.id, from: fromIndex, to: toIndex });
      else dispatch('sprites.reorderAnimationFrame', { sheetId: sheet.id, animationId: anim.id, fromIndex, toIndex });
```

5. In `render()`, replace the `btnAddFrame.disabled` and `btnBreakApart.hidden` lines with:

```js
    btnAddFrame.disabled = !anim || !currentSelection().frameId || anim.layout === 'auto';
    btnMakeManual.hidden = anim?.layout !== 'auto';
```

- [ ] **Step 11: Update the sprite contributions**

In `js/modes/sprites/contributions.js`:
- Change line 2 to import `drawFrameChrome` instead of `drawStripChrome`.
- Delete the `strip-commands.js` and `animation-commands.js` imports.
- Reduce the `frame-metadata-commands.js` import to `{ setFrameField }`.
- `findSpriteSheet` is already imported from `frame-commands.js` (T5 added it). Add:

```js
import { isPinnedFrame } from '../../domain/sprites/auto-layout.js';
```

- Add `deleteLaidOutFrame` to the `animation-layout-commands.js` import.

Then in `registerSpriteCommands`:
- Delete the six strip-command lines (50-56), the three `moveStripTo`/`setStripFrameSize`/`setStripPivot` lines (59-61), and the `breakApartStrip`/`acceptAnimation` lines (63-64).
- Replace the `sprites.deleteFrame` and `sprites.moveFrames` registrations with:

```js
  // A pinned frame's delete goes through the layout: it leaves every
  // animation and its rect is cleared, so later layouts see no stray pixels.
  command('sprites.deleteFrame', (_context, { sheetId, frameId }) => {
    const sheet = findSpriteSheet(services().projects.project, sheetId);
    return sheet && isPinnedFrame(sheet, frameId)
      ? deleteLaidOutFrame(services(), sheetId, frameId)
      : deleteFrame(services(), sheetId, frameId);
  });
  command('sprites.moveFrames', (_context, { sheetId, frameIds, dx, dy }) => moveFrames(services(), sheetId, frameIds, dx, dy));
```

- In `decorateOverlay`, change `drawStripChrome(ctx, canvasView)` to `drawFrameChrome(ctx, canvasView)`.

- [ ] **Step 12: Retire the accept flow and strip scoping in shared canvas code**

`js/components/canvas/drawing-engine.js`:
- Line 32 becomes `import { flattenSheet } from '../../core/model.js';`.
- Delete lines 33 (`segmentAt`), 35 (`commitAcceptAnimation`) and 36 (`stripOf`), then add:

```js
import { frameAt } from '../../domain/sprites/frames.js';
import { isPinnedFrame } from '../../domain/sprites/auto-layout.js';
```

- Delete `acceptFloatingContextIfAny` with its comment (lines 281-295), and its two calls (`handleDown` line 300, `handleSelectDown` line 608).
- Replace the frame-float block (the comment at 741-746 through the closing `}` of `if (activeViewKind() === 'sheet' && !selection) {` at 763) with:

```js
    // No float yet. On the sheet view with no marquee, a down on a frame
    // starts a FRAME-FLOAT: its pixels float exactly like a selection --
    // live preview, commit on Enter/outside click -- but translate-only, and
    // on commit the frame rect moves with the pixels. A pinned frame's rect
    // belongs to its auto layout, so the move tool leaves it alone.
    // Everything else keeps the classic behavior: cut the selection (or
    // whole target) and drag it.
    if (activeViewKind() === 'sheet' && !selection) {
      const frame = frameAt(sheet, ev.x, ev.y);
      if (frame && isPinnedFrame(sheet, frame.id)) return;
      if (frame) {
        const region = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        if (!createFloat({ allLayers: true, region, frameIds: [frame.id], x: ev.x, y: ev.y })) return;
        moveStroke = { kind: 'translate', t0: { ...activeFloating().transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
    }
```

`js/features/workbench/editor-workbench.js`:
- Line 1 becomes `import { flattenSheet } from '../../core/model.js';`.
- Delete line 2.
- Replace the `sheetTargetRect` comment and function (lines 218-240) with:

```js
  // The sheet view's paint/float/paste target: the whole sheet. (Accepted
  // strips used to narrow it to their own frames; v4 has no layer ownership.)
  function sheetTargetRect() {
    const sheet = activeSheet();
    return sheet ? { x: 0, y: 0, w: sheet.width, h: sheet.height } : { x: 0, y: 0, w: 0, h: 0 };
  }
```

`js/components/canvas/sheet-overlays.js`:
- Add `import { isPinnedFrame } from '../../domain/sprites/auto-layout.js';`.
- Replace `const FLOATING_STROKE = '#e0a030';` with `const PINNED_STROKE = '#9d7cff';`.
- Delete `isFloatingFrame` and its comment (lines 59-65).
- In `drawSpriteOverlays`, replace the `floating` lines with:

```js
      const pinned = isPinnedFrame(sheet, f.id);
```

```js
      ctx.strokeStyle = pinned ? PINNED_STROKE : FRAME_STROKE;
      ctx.setLineDash([]);
```

`js/features/animations/commands.js`:
- Delete `commitAcceptAnimation`.
- Rewrite the header comment to say that only `layers-panel.js` still imports this file (for `commitDeleteAnimation`), and that T8 deletes it.

- [ ] **Step 13: Delete the strip modules and their tests; trim the remaining tests**

```powershell
Remove-Item js/modes/sprites/application/commands/strip-commands.js, js/modes/sprites/application/commands/animation-commands.js, js/modes/sprites/application/frame-pixel-motion.js, js/domain/sprites/strips.js, js/core/strips.js
Remove-Item tests/sprite-strip-commands.test.mjs, tests/sprite-animation-commands.test.mjs, tests/strips.segments.test.mjs, tests/strips.test.mjs, tests/frame-pixel-motion.test.mjs
```

Then edit these tests:

- `tests/sprite-domain.test.mjs`: delete the `stripForFrame` import and the test `'stripForFrame returns only intact strip animations containing the frame'`.
- `tests/frame-geometry.test.mjs`: delete these tests and their names from the import:
  - `'stripMembers resolves an animation entry list to frame objects, skipping dangling ids'`
  - `'stripResizeCount converts pointer travel into a member count, floored at 1 and capped by the sheet'`
  - `'resizeGhostRect grows from the dragged end and keeps the opposite edge fixed'`

  The `frameAt` test keeps importing `frameAt` from `frame-geometry.js`, which now re-exports it.
- `tests/frame-chrome-geometry.test.mjs`: change the import to `import { hitHandle } from '../js/modes/sprites/application/frame-chrome-geometry.js';`. Keep the `identity` helper and the `hitHandle` test, and delete every other test.
- `tests/sprite-frame-metadata-commands.test.mjs`: delete the five `moveStripTo`, `setStripFrameSize` and `setStripPivot` tests, and remove those names from its import.
- `tests/sprite-frame-commands.test.mjs`:
  - Delete `"moveFrames on an accepted strip carries the strip layer's pixels and undo restores them"` and `'moveFrames carries pixels for multiple accepted-strip frames and undoes'`.
  - In the remaining `moveFrames(...)` calls, drop any trailing animation-id argument.
  - Remove imports that become unused.
- `tests/model.test.mjs`: delete `'removeFrame adjusts breaks (shift down, drop degenerate)'`.
- `tests/builtinmodes.test.mjs`: replace the expected `sprites.*` list with:

```js
    [
      'sprites.addAnimationFrame', 'sprites.addGroup', 'sprites.addLayer', 'sprites.createFrame',
      'sprites.deleteAnimation', 'sprites.deleteFrame', 'sprites.deleteNode', 'sprites.dragMoveNode',
      'sprites.mergeDown', 'sprites.moveFrames', 'sprites.moveNode', 'sprites.newAnimation',
      'sprites.removeAnimationFrame', 'sprites.renameAnimation', 'sprites.renameNode',
      'sprites.reorderAnimationFrame', 'sprites.resizeFrame', 'sprites.setAnimationBaseDuration',
      'sprites.setAnimationFrameDuration', 'sprites.setAnimationFrameStep', 'sprites.setFrameField',
      'sprites.setLayerOpacity', 'sprites.sliceGrid', 'sprites.toggleAnimationLoop', 'sprites.toggleLayerVisible',
    ],
```

- [ ] **Step 14: Prove nothing still references the retired code**

Run:

```powershell
Get-ChildItem -Recurse js, tests -Include *.js, *.mjs | Select-String -Pattern "strips\.js|strip-commands|animation-commands\.js|frame-pixel-motion|stripForFrame|segmentAt|segmentsOf|segmentOf|stripMembers|drawStripChrome|isFloatingFrame|commitAcceptAnimation|acceptFloatingContextIfAny|breakApartStrip|\.strip\b|\.breaks\b"
```

Expected: no output, except in these places:
- `model.js`: `a.strip && a.layerGroupId` inside `flattenSheet`, which T8 rewrites.
- `legacy-animations.js` and `legacy-animation-conversion.test.mjs`: conversion input.
- The `model.test.mjs` strip/accept tests, which T8 deletes.

Two stale comments will also show up. Reword them:
- `js/modes/sprites/application/commands/animation-lifecycle-commands.js` above `newAnimation`: delete the sentence "Mirrors strip-commands.js's newStripFromFrame: ..." but keep its point, rewritten as "Only touch selection while this command's own sheet is on screen (history is one global stack shared by every sheet); remember the index at undo time so a redo reinserts at the same spot."
- `js/core/tilegrids.js` line 5: replace "Mirrors js/core/strips.js's role for animation strips:" with "Like domain/sprites/auto-layout.js for animations:".

Fix any other hit.

- [ ] **Step 15: Run the tests for everything touched**

Run:
`node --test tests/pinned-frame-guards.test.mjs tests/sprite-frame-commands.test.mjs tests/sprite-frame-metadata-commands.test.mjs tests/sprite-animation-frame-commands.test.mjs tests/sprite-domain.test.mjs tests/frame-geometry.test.mjs tests/frame-chrome-geometry.test.mjs tests/builtinmodes.test.mjs tests/architecture.test.mjs tests/model.test.mjs tests/frame-editor-context.test.mjs tests/float-structural-transition.test.mjs tests/animation-layout-commands.test.mjs tests/animation-layout-lifecycle.test.mjs`

Expected: PASS. If any test fails, report every failing test name from the full output.

- [ ] **Step 16: Boot check in the browser**

Serve with `serve.ps1` in the background, then report its PID and the matching `Stop-Process -Id <PID> -Force` command. Load `index.html?autotest` and confirm the sprite workbench renders with no console errors. Select the frame tool and click a frame once. Do **not** simulate drags: frame moves, resizes and timeline reordering are for the user to check by hand. List those for the user in the task report.

- [ ] **Step 17: Commit (only if authorized)**

```bash
git add -A js tests
git commit -m "refactor: retire strips; pin auto-laid-out frames in Sprite Sheets"
```

### Task 8: Retire animation-owned layer groups from the model; wire up layer locking

**Files:**
- Delete: `js/features/animations/commands.js`
- Modify:
  - `js/core/model.js`
  - `js/host/document-helpers.js`
  - `js/components/canvas/{drawing-engine,float-session}.js`
  - `js/features/transforms/filter-controller.js`
  - `js/components/panels/layers-panel.js`
  - `js/modes/sprites/presentation/timeline-presenter.js`
  - `js/modes/sprites/application/commands/{layer-commands,animation-lifecycle-commands,animation-layout-commands}.js`
  - `js/modes/tiles/application/commands/layer-commands.js`
  - `js/modes/sprites/contributions.js`
- Test:
  - `tests/layer-locking.test.mjs` (create)
  - Edit `tests/{model,frame-editor-context,float-structural-transition,sprite-animation-lifecycle-commands,sprites-layer-commands,tiles-layer-commands,builtinmodes,exports,sheet-model-foundations}.test.mjs`

**Interfaces:**
- Consumes: the v4 shapes from T6. Loaded groups never carry `animationId`, and animations never carry `layerGroupId`.
- Produces:
  - `addAnimation(sheet, name, defaults = {})`, with the `strip` parameter removed.
  - `createGroupNode(name, { open = true } = {})`.
  - `flattenSheet(sheet, floating, overrideLayers)`: a plain composite of every visible layer.
  - `activeEditableLayer()`: the active layer, or `null` when it is locked.
  - `currentContextLayers()`: every layer of the active sheet.
  - `activeLayerScope()`: every unlocked layer of the active sheet.
  - `toggleLayerLocked(services, sheetId, layerId)`, registered as `sprites.toggleLayerLocked`.
  - Removed from `model.js`: `animationGroup`, `contextLayers`, `layerAnimationContext`, `acceptAnimation`.

- [ ] **Step 1: Write the failing tests**

Create `tests/layer-locking.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, addLayer, sheetLayers } from '../js/core/model.js';
import { activeLayer, activeEditableLayer, activeLayerScope, currentContextLayers } from '../js/host/document-helpers.js';
import { toggleLayerLocked } from '../js/modes/sprites/application/commands/layer-commands.js';

test('toggleLayerLocked locks and unlocks a layer as one undo step each', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
  const layer = sheetLayers(sheet)[0];
  toggleLayerLocked(services, sheet.id, layer.id);
  assert.equal(layer.locked, true);
  services.history.undo();
  assert.equal(layer.locked, false);
  services.history.redo();
  assert.equal(layer.locked, true);
});

test('locked layers are not editable and are skipped by all-layer captures', () => {
  const host = new EditorHost();
  setEditorHost(host);
  host.registerMode(spriteMode);
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const top = addLayer(sheet, 'top');
  const base = sheetLayers(sheet)[0];
  host.setProject(project);
  host.store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  host.selections.patch({ layerId: top.id });
  assert.equal(activeEditableLayer(), top);
  top.locked = true;
  assert.equal(activeLayer(), top, 'a locked layer can still be selected');
  assert.equal(activeEditableLayer(), null, 'painting, filling, filters and floats get no target');
  assert.deepEqual(activeLayerScope(), [base], 'all-layer moves and filters skip it');
  assert.deepEqual(currentContextLayers(), [base, top], 'it still renders');
});

test('the sprites mode registers sprites.toggleLayerLocked', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode);
  assert.ok(host.registries.commands.get('sprites.toggleLayerLocked'));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/layer-locking.test.mjs`
Expected: FAIL. `toggleLayerLocked` and `activeEditableLayer` are not exported.

- [ ] **Step 3: Remove the animation-group APIs from `js/core/model.js`**

1. Rewrite the tree-model comment (lines 99-105) to read:

```js
// A sheet stores its layers inside a hierarchical `layerTree` of group
// nodes (folders) and leaf layer nodes. Read them through
// `sheetLayers(sheet)`; animations do not own layers.
```

2. Replace `createGroupNode` with:

```js
export function createGroupNode(name, { open = true } = {}) {
  return { id: newId('gp'), type: GROUP, name, open, children: [] };
}
```

3. In `moveNode`, delete the animation-owned-group guard (the comment plus `if (dstParent.animationId && node.type !== LAYER) return;`, lines 303-305).

4. Replace `flattenSheet` (and its exclusive-strip pass) with:

```js
export function flattenSheet(sheet, floating = null, overrideLayers = null) {
  return flattenSheetLayers(withOverrides(sheetLayers(sheet), overrideLayers), sheet.width, sheet.height, floating, sheet.id);
}
```

5. Delete the `// ---- animation layer groups` section: `animationGroup`, `contextLayers` and `layerAnimationContext`.

6. Replace the floating-animation comment above `addAnimation`, and `addAnimation` itself, with:

```js
// A new animation is manual with no frames. `defaults` seeds the base-
// duration fields from the project's own default (project.settings, see the
// Animation-panel design doc); omitting it (e.g. direct unit-test calls)
// falls back to ms-100/unset.
export function addAnimation(sheet, name, defaults = {}) {
  const anim = {
    id: newId('an'), name, loop: true, frames: [], layout: 'manual', cell: null,
    baseDuration: defaults.durationMs ?? 100,
    baseFps: defaults.baseFps,
    baseStep: defaults.baseStep,
  };
  sheet.animations.push(anim);
  return anim;
}
```

7. Delete `acceptAnimation` and its comment.

8. Replace `renameAnimation` with:

```js
export function renameAnimation(sheet, animId, name) {
  const anim = sheet.animations.find(a => a.id === animId);
  if (!anim) return false;
  anim.name = name;
  return true;
}
```

9. In `migrateLegacyLayers` (the root group built for pre-tree files), delete `animationId: null,` from the object literal.

10. `deserializeGroup` keeps reading `animationId`, because `convertLegacySheet` needs it. `clearGroupOwnership` strips it afterwards.

11. Run `Select-String -Path js/core/model.js -Pattern 'copyRegion|blitRegion|findGroup'`. Remove any name in the `pixels.js` import line that no longer has a use. `findGroup` stays exported.

- [ ] **Step 4: Update every `addAnimation` call to the new signature**

Run:

```powershell
Get-ChildItem -Recurse js, tests -Include *.js, *.mjs | Select-String -Pattern "addAnimation\([^)]*,\s*(true|false)\s*[,)]"
```

In each hit, delete the boolean argument. That turns `addAnimation(x, name, false, settings)` into `addAnimation(x, name, settings)`, and `addAnimation(s, 'walk', true)` into `addAnimation(s, 'walk')`. The production hits are:
- `animation-lifecycle-commands.js` (`newAnimation`)
- `animation-layout-commands.js` (`newAutoAnimation` and `duplicateAnimation`)

The test hits are in `exports`, `model` and `sheet-model-foundations`. Rerun the command; expect no output.

- [ ] **Step 5: Scope the document helpers to the whole sheet and add the lock gate**

Replace `js/host/document-helpers.js` lines 1-2 and 30-42 so that the file reads:

```js
import { getEditorHost } from './runtime.js';
import { findLayer, sheetLayers } from '../core/model.js';
```

(`sheetDocument`, `activeSheet`, `activeMap` and `activeLayer` stay as they are.)

```js
// The layer an edit may write into: the active layer unless it is locked.
// Every pixel-writing path (paint, fill, select-delete, floats, paste,
// filters) resolves its target through this, never through activeLayer().
export function activeEditableLayer() {
  const layer = activeLayer();
  return layer && !layer.locked ? layer : null;
}

// Every layer of the active sheet, bottom first: what the sheet renders.
// (Animations used to scope this to their own layer group.)
export function currentContextLayers() {
  const sheet = activeSheet();
  return sheet ? sheetLayers(sheet) : [];
}

// The layers an "all layers" edit touches: every unlocked layer.
export function activeLayerScope() {
  const sheet = activeSheet();
  return sheet ? sheetLayers(sheet).filter(l => !l.locked) : [];
}
```

- [ ] **Step 6: Route every pixel-writing path through the lock gate**

`js/components/canvas/drawing-engine.js`:
- Import `activeEditableLayer` alongside `activeSheet` and `activeLayer` (line 20).
- In `handleDown`, change `const layer = activeLayer();` to `const layer = activeEditableLayer();`.
- In `handleSelectDown`, change `if (!activeLayer()) return;` to `if (!activeEditableLayer()) return;`.
- In the select-tool Delete key handler, change `const layer = activeLayer();` to `const layer = activeEditableLayer();`.

`js/components/canvas/float-session.js`:
- Change line 16 to `import { activeSheet, activeEditableLayer, activeLayerScope } from '../../host/document-helpers.js';`.
- Replace every remaining `activeLayer()` call with `activeEditableLayer()`: `captureLayers` (line 78) and the paste targets (lines 401, 410, 451).

`js/features/transforms/filter-controller.js`:
- Change line 5 to `import { activeSheet, activeEditableLayer, activeLayerScope, currentContextLayers } from '../../host/document-helpers.js';`.
- Replace `activeLayer()` with `activeEditableLayer()` at lines 95, 124, 348 and 610, and in the `isEnabled` checks at lines 314, 586 and 1001.

Then run `Select-String -Path js/components/canvas/drawing-engine.js, js/components/canvas/float-session.js, js/features/transforms/filter-controller.js -Pattern 'activeLayer\(\)'`. Expected: no output.

- [ ] **Step 7: Add the layer lock command**

In `js/modes/sprites/application/commands/layer-commands.js`:
- Delete the animation-group sentences from the comment above `deleteNode` (lines 102-106), and delete `if (node.type === 'group' && node.animationId) return;`.
- Replace `renameNode` with:

```js
export function renameNode(services, sheetId, nodeId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const node = findNode(sheet.layerTree, nodeId);
  if (!node || node.name === name) return;
  const before = node.name;
  runCommand(services, sheetId, node.type === 'group' ? 'rename group' : 'rename layer',
    sheet => { findNode(sheet.layerTree, nodeId).name = name; },
    sheet => { findNode(sheet.layerTree, nodeId).name = before; });
}
```

- Append:

```js
// A locked layer still renders and can be selected, but no edit writes to
// it (see activeEditableLayer in host/document-helpers.js) and auto layout
// refuses to move its pixels (core/sheet-layout.js).
export function toggleLayerLocked(services, sheetId, layerId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const layer = sheet ? findNode(sheet.layerTree, layerId) : null;
  if (!layer || layer.type !== 'layer') return;
  const before = !!layer.locked;
  runCommand(services, sheetId, before ? 'unlock layer' : 'lock layer',
    s => { findNode(s.layerTree, layerId).locked = !before; },
    s => { findNode(s.layerTree, layerId).locked = before; });
}
```

In `js/modes/tiles/application/commands/layer-commands.js`, make the same `deleteNode` and `renameNode` changes. Tiles gets no lock command.

In `js/modes/sprites/contributions.js`:
- Add `toggleLayerLocked` to the `layer-commands.js` import.
- After `sprites.toggleLayerVisible`, register:

```js
  command('sprites.toggleLayerLocked', (_context, { sheetId, layerId }) => toggleLayerLocked(services(), sheetId, layerId));
```

In `js/modes/sprites/application/commands/animation-lifecycle-commands.js`:
- Change the model import to `import { addAnimation, renameAnimation as renameAnimationOnSheet } from '../../../../core/model.js';`.
- Change the `newAnimation` comment's first sentences to "A new animation is manual with zero frames."
- Replace `deleteAnimation` and its comment with:

```js
// Deleting a manual animation keeps its frames: they are viewports onto the
// sheet that other animations or maps may still use. (Auto animations go
// through animation-layout-commands.js's deleteAutoAnimation instead.)
export function deleteAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = services.selections.get(doc)?.animationId === animationId;
  runSheetCommand(services, sheetId, 'delete animation',
    target => {
      target.animations = target.animations.filter(a => a.id !== animationId);
      if (services.selections.get(doc)?.animationId === animationId) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    },
    target => {
      target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), animationId }, doc);
    });
}
```

- [ ] **Step 8: Strip animation ownership from the layers panel and timeline; add the lock button**

`js/components/panels/layers-panel.js`:

1. Delete line 9 (the `commitDeleteAnimation` import). Line 10 becomes `import { findNode, findParent, sheetLayers, flattenLayers, findGroup } from '../../core/model.js';`.

2. Delete:
   - `currentAnimationId()` (lines 111-114).
   - The `lastSyncedAnimationId` comment and declaration (lines 120-125).
   - The `if (g.animationId) { ... }` branch in the delete handler (lines 228-242).
   - The drop guard comment and `if (srcNode.type === 'group' && destParent.animationId) return;` (lines 437-438).
   - `syncFromAnimationSelection` with its comment (lines 658-674), and its call in `renderList` (line 688).

3. Replace `selectGroupNode` and `selectLayerNode` (and the comments above them) with:

```js
  function selectGroupNode(group) {
    selectedNodeId = group.id;
    const sheet = activeSheet();
    if (sheet) setSheetSelection(sheet, { layerId: null });
  }

  function selectLayerNode(layer) {
    const sheet = activeSheet();
    selectedNodeId = layer.id;
    if (sheet) setSheetSelection(sheet, { layerId: layer.id });
  }
```

4. The group icon becomes `icon.textContent = '📁';`.

5. In `renderList`, replace the stale-layer fallback lines with:

```js
    if (currentId && !findNode(sheet.layerTree, currentId)) {
      setSheetSelection(sheet, { layerId: sheetLayers(sheet)[0]?.id ?? null });
    }
```

6. In the comment above `defineAction('layer.add', ...)`, delete the sentences about `animationId`, from "Groups only ever gain an animationId" through "no isAvailable gating needed."

7. In `renderLayer`, after the `visBtn` block, add:

```js
    // Locking is a sprite-sheet feature (tile sheets share this panel but
    // register no toggleLayerLocked command).
    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.textContent = layer.locked ? '🔒' : '🔓';
    lockBtn.title = layer.locked ? 'Unlock layer' : 'Lock layer';
    lockBtn.hidden = currentModeId() !== 'sprites';
    lockBtn.addEventListener('click', (e) => { e.stopPropagation(); dispatch('sprites.toggleLayerLocked', { sheetId: activeSheet().id, layerId: layer.id }); });
    lockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
```

   and change that function's `row.append(spacer, thumb, visBtn, nameEl, opacityInput);` to `row.append(spacer, thumb, visBtn, lockBtn, nameEl, opacityInput);`.

`js/modes/sprites/presentation/timeline-presenter.js`:
- Line 17 becomes `import { flattenSheetLayers, effectiveDuration } from '../../../core/model.js';`.
- Replace the `animSelect` change listener (lines 294-314) with:

```js
  animSelect.addEventListener('change', () => {
    stopPlaying();
    position = 0; acc = 0;
    setSelection({ animationId: animSelect.value || null });
    render();
  });
```

Delete `js/features/animations/commands.js`:

```powershell
Remove-Item js/features/animations/commands.js
```

If `js/features/animations` is now empty, remove the directory too.

- [ ] **Step 9: Update the tests that built animation-owned groups**

`tests/model.test.mjs`:
- Remove `acceptAnimation`, `contextLayers` and `layerAnimationContext` from the import.
- In `'moveNode reorders layers and moves between groups'`, delete the animation-owned-group block (the `// only layer nodes may be moved into an animation-owned group` comment through the `g3` assertion).
- Replace `'addAnimation creates a floating animation with no layer group yet'` with:

```js
test('addAnimation creates a manual animation with no frames and no legacy fields', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'walk');
  assert.deepEqual([a.name, a.frames, a.layout, a.cell], ['walk', [], 'manual', null]);
  assert.equal(['strip', 'breaks', 'layerGroupId'].some(k => k in a), false);
});
```

- Delete these tests:
  - every test whose name starts with `acceptAnimation` (4 tests)
  - `'flattenSheet gives an accepted strip exclusive, opaque ownership of its own frame rects'`
  - `'flattenSheet leaves a floating (not-yet-accepted) strip transparent to whatever is underneath'`
  - every test whose name starts with `layerAnimationContext` (5 tests)
  - `'contextLayers scopes to animation group or returns all layers'`

`tests/frame-editor-context.test.mjs`:
- Change the model import to `import { createProject, createSheet, addFrame, addAnimation, createLayerNode, sheetLayers } from '../js/core/model.js';`.
- In `reset()`, replace the animation/accept/pixel lines (26-34) with:

```js
  const first = addAnimation(sheet, 'First'), second = addAnimation(sheet, 'Second');
  for (const anim of [first, second]) anim.frames = [{ frameId: a.id, duration: 100 }, { frameId: b.id, duration: 100 }];
  const layer = sheetLayers(sheet)[0];
  const other = createLayerNode('Other', sheet.width, sheet.height);
  sheet.layerTree.children.push(other);
  setPixel(layer.bitmap, 0, 0, red); setPixel(layer.bitmap, 8, 0, blue);
```

- In `'same-frame animation/layer change invalidates raster context without resetting pan'`, insert `setPixel(other.bitmap, 0, 0, blue); // a silent edit only a fresh raster shows` immediately before the `host.selections.patch(...)` line.
- In `'same-frame animation/layer change settles the old layer float before further editing'`, change the last assertion to `assert.deepEqual(getPixel(other.bitmap, 0, 0), [0, 0, 0, 0]);`.

`tests/float-structural-transition.test.mjs`:
- Remove `acceptAnimation` and `animationGroup` from the import.
- In `reset()`, replace lines 31-33 with:

```js
  const anim = addAnimation(sheet, 'Anim');
  anim.frames = [{ frameId: frame.id, duration: 100 }];
  const group = createGroupNode('Group'), dest = createLayerNode('Dest', sheet.width, sheet.height);
  group.children.push(dest); sheet.layerTree.children.push(group);
```

- Delete the `for (const source of ['timeline', 'layers panel']) { test(... animation delete settles its accepted-layer float ...) }` loop. Deleting an animation no longer deletes layers.
- Keep `mountTimeline(timeline)` and `clickButton`. The remaining layer-delete and merge-down tests still use the panel buttons.

`tests/sprite-animation-lifecycle-commands.test.mjs`:
- In `makeProject()`, drop `strip`, `breaks` and `layerGroupId` from the animation literal, add `layout: 'manual', cell: null`, and drop `animationId: null` from the root group.
- Replace `'deleteAnimation removes the animation and tears down its layer group; undo restores both at their original positions'` with:

```js
test('deleteAnimation removes the animation, keeps its frames and layers, and undo restores it at its index', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  const group = { id: 'g1', type: 'group', name: 'walk', open: true, children: [] };
  sheet.layerTree.children.push(group);
  services.selections.set({ animationId: 'an1' }, doc);
  deleteAnimation(services, 'sheet1', 'an1');
  assert.deepEqual([sheet.animations.length, sheet.frames.length, sheet.layerTree.children[0]], [0, 1, group]);
  assert.equal(services.selections.get(doc)?.animationId, null);
  services.history.undo();
  assert.equal(sheet.animations[0].id, 'an1');
  assert.equal(services.selections.get(doc)?.animationId, 'an1');
});
```

- In `'deleteAnimation restores a new unaccepted animation with null ownership through undo/redo'`, rename it to `'deleteAnimation restores a new animation through undo/redo'`. Delete its two `layerGroupId` assertions and its `layerTree.children.length` assertion.

`tests/sprites-layer-commands.test.mjs` and `tests/tiles-layer-commands.test.mjs`:
- Delete `'deleteNode refuses to delete an animation-owned group (out of scope; handled by sprites.deleteAnimation elsewhere)'` and `'renameNode syncs the matching animations entry name for an animation-owned group, and undoes'`.
- Drop `animationId: null` from each file's `makeGroup` default.

`tests/sprite-animation-frame-commands.test.mjs`:
- In `makeProject()`, replace `layerGroupId: null,` with `layout: 'manual', cell: null,`.
- Drop `strip`/`breaks` if present, and drop `animationId: null` from the root group.

`tests/builtinmodes.test.mjs`: insert `'sprites.toggleLayerLocked'` between `'sprites.toggleAnimationLoop'` and `'sprites.toggleLayerVisible'` in the expected list.

- [ ] **Step 10: Prove the retired APIs are gone**

Run:

```powershell
Get-ChildItem -Recurse js, tests -Include *.js, *.mjs | Select-String -Pattern "acceptAnimation|animationGroup|contextLayers\(|layerAnimationContext|layerGroupId|commitDeleteAnimation|features/animations/commands|\.animationId\b"
```

Expected: hits only in these places:
- `legacy-animations.js` and `legacy-animation-conversion.test.mjs` (conversion input).
- `model.js` `deserializeGroup`/`clearGroupOwnership`/`normalizeAnimation` (conversion plumbing).
- `currentContextLayers(` call sites.
- Selection-state reads of `selection.animationId` / `?.animationId` in presenters (the selected animation, unrelated to group ownership).

Fix anything else.

- [ ] **Step 11: Run the tests for everything touched**

Run:
`node --test tests/layer-locking.test.mjs tests/model.test.mjs tests/frame-editor-context.test.mjs tests/float-structural-transition.test.mjs tests/sprite-animation-lifecycle-commands.test.mjs tests/sprite-animation-frame-commands.test.mjs tests/sprites-layer-commands.test.mjs tests/tiles-layer-commands.test.mjs tests/builtinmodes.test.mjs tests/architecture.test.mjs tests/exports.test.mjs tests/export-filenames.test.mjs tests/animationExport.test.mjs tests/sheet-model-foundations.test.mjs tests/legacy-animation-conversion.test.mjs tests/animation-layout-commands.test.mjs tests/animation-layout-lifecycle.test.mjs tests/pinned-frame-guards.test.mjs`

Also run every test file that imports `document-helpers`, `float-session` or `filter-controller`. List them with:

```powershell
Get-ChildItem tests -Filter *.mjs | Select-String -Pattern "document-helpers|float-session|filter-controller" -List | ForEach-Object Path
```

Expected: PASS. If any fail, report every failing test name.

- [ ] **Step 12: Boot check in the browser**

Serve with `serve.ps1` (report the PID and the `Stop-Process -Id <PID> -Force` command). Load `index.html?autotest`, open the Layers panel, click a layer's 🔓 button, and confirm it turns 🔒 with no console errors. Clicking is allowed; no drags. Leave painting on the locked layer for the user to check by hand, and say so in the report.

- [ ] **Step 13: Commit (only if authorized)**

```bash
git add -A js tests
git commit -m "refactor: drop animation-owned layer groups; add layer locking"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/superpowers/specs/2026-10-09-animations-workbench-design.md`

No tests: this task changes documentation only.

- [ ] **Step 1: Find the stale passages**

```powershell
Select-String -Path README.md, docs/ARCHITECTURE.md -Pattern "strip|accept|floating anim|break apart|layer group|segment" -CaseSensitive:$false
```

- [ ] **Step 2: Rewrite each hit to the v4 model**

Replace every description of strips, segments, breaks, Accept/Enter, floating animations, Break apart and animation-owned layer groups with:

- **Animations** are `auto` or `manual`.
  - An auto animation is laid out by the packer: one band of rows per animation, in `sheet.animations` order. The band is at most `settings.sheetMaxWidth` wide, and the sheet grows downward when it runs out of room.
  - A manual animation's frames are free rects.
- **Auto frames are pinned in Sprite Sheets.** They select and open, but don't move or resize there. **Make manual** releases them without moving a pixel.
- **Layers** can be locked (🔒). A locked layer renders but takes no edits. Auto layout refuses to move pixels out of it and names the layer.
- **Older files (v2/v3)** convert on load:
  - Accepted, contiguous, equal-size, equal-pivot strips become auto.
  - Everything else becomes manual.
  - Pixels a strip used to hide go into a hidden `Covered by strips (converted)` folder, so the sheet looks exactly as before.
- **In `ARCHITECTURE.md`**, name the new modules and their layers:
  - `domain/sprites/auto-layout.js` (pure planner)
  - `core/sheet-layout.js` (pixel moves and growth)
  - `core/legacy-animations.js` (conversion)
  - `modes/sprites/application/commands/animation-layout-commands.js` (`runLayoutCommand` plus the `animations.*` commands)

- [ ] **Step 3: Record the planning deviations in the spec**

Append a section `## Implementation notes (Phase 1)` to the spec, containing the seven numbered items from this plan's "Deviations from the spec" section, verbatim.

- [ ] **Step 4: Commit (only if authorized)**

```bash
git add README.md docs/ARCHITECTURE.md docs/superpowers/specs/2026-10-09-animations-workbench-design.md
git commit -m "docs: describe auto/manual animations, pinning, locking and v4 conversion"
```
