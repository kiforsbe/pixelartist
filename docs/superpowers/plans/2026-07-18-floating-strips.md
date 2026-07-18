# Floating Strips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let new animations/strips start "floating" (previewing whatever's already on the sheet, no layer of their own) until explicitly or automatically accepted, at which point they freeze that content into a private layer and exclusively own their rectangle in the whole-sheet composite; also sync the layers panel with the animation timeline and fix strip shrink to discard (not preserve) removed pixel data.

**Architecture:** `core/model.js` gains the data-model split (`addAnimation` creates a bare floating record; new `acceptAnimation` freezes it into a committed layer) and the compositing change (`flattenSheet` gives accepted strips exclusive ownership of their frame rects). `ui/frames.js` gains the command wrapper (`commitAcceptAnimation`) and its two triggers (Enter-key, and — via `ui/tools.js` — auto-accept on first write). `ui/timeline.js` and `ui/panels.js` get small consistency fixes so the layers panel and the animation timeline stay in sync.

**Tech Stack:** Vanilla ES modules, no build step, no framework. Tests via Node's built-in `node --test` against `tests/model.test.mjs`. Manual/browser verification via a local static server + Playwright MCP tools (matches how this repo has been manually verified previously — no project-specific test-runner skill exists for the UI layer).

## Global Constraints

- No new dependencies; stay within the existing vanilla-ES-modules, no-build-step architecture.
- Every mutating UI action must remain undoable through `state.commands` (the existing `CommandStack` in `core/commands.js`), matching the codebase's established "eager-mutate, snapshot before/after, do()/undo() swap" idiom.
- `state.commands` is a single stack shared across all sheets — any command that touches global UI-selection state (`state.selectedAnimationId`, `state.activeLayerId`, `state.selectedFrameId`) in `do()` must guard with `if (sheet === activeSheet())` before writing those fields, to avoid a stale redo (after a sheet switch) clobbering a different sheet's UI state. `undo()` guards remain equality-checks (`if (state.X === thisCommandsValue)`), which are inherently safe.
- `PROJECT_VERSION` (currently `2`) does not need to change — `layerGroupId: null` was already a representable, gracefully-defaulted (`a.layerGroupId ?? null`) value in `serializeProject`/`deserializeProject`.
- Run `node --test tests/*.mjs` after every task that touches `core/model.js` and before every commit; it must stay at 0 failures.

---

### Task 1: Data model — split `addAnimation` into bare creation + `acceptAnimation` freeze

**Files:**
- Modify: `js/core/model.js` (the `addAnimation` function, ~line 267-296; add new `acceptAnimation` function after it)
- Modify: `js/core/model.js` top imports (~line 1) to add `copyRegion, blitRegion` from `./pixels.js`
- Test: `tests/model.test.mjs`

**Interfaces:**
- Produces: `addAnimation(sheet, name, strip = false) → anim` — now returns `{ id, name, loop: true, strip, breaks: [], frames: [], layerGroupId: null }`, no group/layer created, no sheet mutation beyond pushing `anim` onto `sheet.animations`.
- Produces: `acceptAnimation(sheet, anim) → group` — creates a new group node (with `animationId: anim.id`) containing one new layer, freezes each of `anim.frames`' rectangles from the current `flattenSheet(sheet)` into that layer at the frame's own `(x, y)`, pushes the group into `sheet.layerTree.children`, sets `anim.layerGroupId = group.id`, and returns the group. Assumes `anim.layerGroupId` is currently `null` (caller's responsibility — see Task 5's idempotency guard).
- Consumes (unchanged): `createGroupNode`, `createLayerNode`, `flattenSheet`, `sheetLayers`, `findGroup`, `flattenLayers` — all already in this file.

- [ ] **Step 1: Write failing tests for the new split**

Open `tests/model.test.mjs`. Add `acceptAnimation` to the existing import list (currently `PROJECT_VERSION, DEFAULT_SETTINGS, createProject, createSheet, addLayer, removeLayer, moveLayer, mergeDown, addFrame, removeFrame, addAnimation, flattenSheet, flattenSheetLayers, serializeProject, deserializeProject, validateProjectJson, GROUP, LAYER, sheetLayers, findGroup, contextLayers, addGroup, flattenLayers, moveNode, scrubTileReferences`):

```js
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, acceptAnimation, flattenSheet, flattenSheetLayers,
  serializeProject, deserializeProject, validateProjectJson, GROUP, LAYER,
  sheetLayers, findGroup, contextLayers, addGroup, flattenLayers, moveNode,
  scrubTileReferences,
} from '../js/core/model.js';
```

Then add these new test cases anywhere after the existing `test('frames and animations; removeFrame cleans references', ...)` block:

```js
test('addAnimation creates a floating animation with no layer group yet', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'walk');
  assert.equal(a.layerGroupId, null);
  assert.equal(a.name, 'walk');
  assert.deepEqual(a.frames, []);
  assert.deepEqual(a.breaks, []);
  assert.equal(contextLayers(s, a.id).length, sheetLayers(s).length, 'falls back to whole sheet while floating');
});

test('acceptAnimation freezes the current composite under the animation\'s own frames into a new layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 1, 1, [1, 2, 3, 255]);
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  assert.equal(a.layerGroupId, null, 'floating until accepted');

  acceptAnimation(s, a);
  assert.ok(a.layerGroupId, 'animation has layerGroupId after accept');
  const g = findGroup(s.layerTree, a.layerGroupId);
  assert.equal(g.animationId, a.id);
  assert.equal(flattenLayers(g).length, 1);
  assert.deepEqual(getPixel(flattenLayers(g)[0].bitmap, 1, 1), [1, 2, 3, 255]);
  // mutation on the strip's own layer does not bleed back to the root layer
  setPixel(flattenLayers(g)[0].bitmap, 1, 1, [9, 9, 9, 255]);
  assert.deepEqual(getPixel(sheetLayers(s)[0].bitmap, 1, 1), [1, 2, 3, 255]);
});

test('acceptAnimation with zero frames yields a blank layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [1, 2, 3, 255]);
  const a = addAnimation(s, 'walk'); // plain animation, no frames yet
  acceptAnimation(s, a);
  const g = findGroup(s.layerTree, a.layerGroupId);
  assert.deepEqual(getPixel(flattenLayers(g)[0].bitmap, 0, 0), [0, 0, 0, 0]);
});

test('acceptAnimation only freezes pixels under its own frames, not another animation\'s private layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a1 = addAnimation(s, 'walk', true);
  a1.frames = [{ frameId: f1.id, duration: 100 }];
  acceptAnimation(s, a1);
  setPixel(flattenLayers(findGroup(s.layerTree, a1.layerGroupId))[0].bitmap, 0, 0, [255, 0, 0, 255]);

  const f2 = addFrame(s, { name: 'f1', x: 4, y: 0, w: 4, h: 4 }); // adjacent, non-overlapping rect
  const a2 = addAnimation(s, 'run', true);
  a2.frames = [{ frameId: f2.id, duration: 100 }];
  acceptAnimation(s, a2);
  const g2 = findGroup(s.layerTree, a2.layerGroupId);
  // a2's own frame rect (x:4..8) never touched a1's red pixel at (0,0)
  assert.deepEqual(getPixel(flattenLayers(g2)[0].bitmap, 0, 0), [0, 0, 0, 0]);
});

test('acceptAnimation flattens multiple visible layers (with opacity) under its own frames', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [255, 0, 0, 255]); // opaque red
  const top = addLayer(s, 'top');
  top.opacity = 0.5;
  setPixel(top.bitmap, 0, 0, [0, 0, 255, 255]); // blue @ 50% over red
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  acceptAnimation(s, a);
  const g = findGroup(s.layerTree, a.layerGroupId);
  const groupLayers = flattenLayers(g);
  assert.equal(groupLayers.length, 1);
  assert.equal(groupLayers[0].visible, true);
  assert.equal(groupLayers[0].opacity, 1);
  assert.deepEqual(getPixel(groupLayers[0].bitmap, 0, 0), [128, 0, 128, 255]);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/model.test.mjs`
Expected: FAIL — `acceptAnimation` is not exported / is not a function. The pre-existing tests still pass at this point (implementation hasn't changed yet).

- [ ] **Step 3: Add `copyRegion`/`blitRegion` to model.js's pixels import**

In `js/core/model.js`, change:

```js
import { createBitmap, cloneBitmap, getPixel, setPixel } from './pixels.js';
```

to:

```js
import { createBitmap, cloneBitmap, getPixel, setPixel, copyRegion, blitRegion } from './pixels.js';
```

- [ ] **Step 4: Replace `addAnimation` and add `acceptAnimation`**

Find the current `addAnimation` (~line 267-296):

```js
export function addAnimation(sheet, name, strip = false) {
  // Each animation owns a dedicated group under the root, seeded from the
  // sheet's OWN root-level layers only -- sheetLayers() flattens the WHOLE
  // tree, which would wrongly pull in every OTHER animation's private
  // layers too (they live in their own group, nested under root just like
  // this new one is about to be). A single root layer is copied as-is
  // (name/visible/opacity preserved); multiple root layers are flattened
  // into one first, since a new animation starts from one merged snapshot
  // of the base art, not a full copy of an unrelated layer stack.
  const group = createGroupNode(name);
  const rootLayers = sheet.layerTree.children.filter(n => n.type === LAYER);
  const copy = createLayerNode(
    rootLayers.length === 1 ? rootLayers[0].name : 'Layer 1',
    sheet.width, sheet.height,
  );
  if (rootLayers.length === 1) {
    copy.bitmap = cloneBitmap(rootLayers[0].bitmap);
    copy.visible = rootLayers[0].visible;
    copy.opacity = rootLayers[0].opacity;
  } else if (rootLayers.length > 1) {
    copy.bitmap = flattenSheetLayers(rootLayers, sheet.width, sheet.height);
  }
  group.children.push(copy);
  sheet.layerTree.children.push(group);

  const anim = { id: newId('an'), name, loop: true, strip, breaks: [], frames: [], layerGroupId: group.id };
  group.animationId = anim.id;
  sheet.animations.push(anim);
  return anim;
}
```

Replace it with:

```js
// A new animation starts FLOATING: no group, no layer, layerGroupId null.
// It previews whatever's already on the sheet under its own frames (see
// contextLayers()'s null-group fallback and flattenSheet()'s exclusive-
// compositing skip for floating strips below) until acceptAnimation() is
// called -- explicitly (Enter key, frames.js) or automatically (first
// paint stroke, tools.js). This lets a strip be freely repositioned/resized
// to align with existing imported artwork before committing to a layer.
export function addAnimation(sheet, name, strip = false) {
  const anim = { id: newId('an'), name, loop: true, strip, breaks: [], frames: [], layerGroupId: null };
  sheet.animations.push(anim);
  return anim;
}

// Promotes a floating animation into a committed one: freezes whatever's
// currently visible under each of its own frames (i.e. flattenSheet(sheet)
// cropped to that frame's rect -- for an accepted strip elsewhere this
// already respects that strip's own exclusive ownership, so overlapping an
// already-accepted strip freezes ITS content, not something hidden below
// it) into one brand-new layer, then wires the group in. Caller's
// responsibility to only call this once, while anim.layerGroupId is still
// null -- see commitAcceptAnimation's idempotency guard in ui/frames.js.
export function acceptAnimation(sheet, anim) {
  const group = createGroupNode(anim.name, { animationId: anim.id });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  const flat = flattenSheet(sheet);
  for (const entry of anim.frames) {
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (!frame) continue;
    const region = copyRegion(flat, frame.x, frame.y, frame.w, frame.h);
    blitRegion(layer.bitmap, region, frame.x, frame.y);
  }
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  anim.layerGroupId = group.id;
  return group;
}
```

Note: `acceptAnimation` calls `flattenSheet`, which is already defined earlier in this same file (~line 229, well above `addAnimation`) — no ordering issue either way, since function declarations are hoisted within the module regardless.

- [ ] **Step 5: Fix the four pre-existing tests that assumed the old `addAnimation` behavior**

In `tests/model.test.mjs`, find `test('moveNode prevents invalid moves', ...)` (~line 61-82). Change:

```js
  const a = addAnimation(s, 'walk');
  const ag = findGroup(s.layerTree, a.layerGroupId);
```

to:

```js
  const a = addAnimation(s, 'walk');
  acceptAnimation(s, a);
  const ag = findGroup(s.layerTree, a.layerGroupId);
```

Delete the entire `test('addAnimation creates a group with a copy of current layers', ...)` block (~line 315-329) — it's now covered by the new `acceptAnimation freezes the current composite...` test added in Step 1.

Find `test('contextLayers scopes to animation group or returns all layers', ...)` (~line 331-344). Replace it with:

```js
test('contextLayers scopes to animation group or returns all layers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  addLayer(s, 'global');
  const beforeAnim = sheetLayers(s).map(l => l.id);
  const a = addAnimation(s, 'walk');
  acceptAnimation(s, a);
  // 2 root layers + the single (blank, since the animation has no frames yet) layer created for the new anim group
  assert.equal(contextLayers(s).length, 3);
  // scoped to the animation, only its own (single) layer is returned
  assert.equal(contextLayers(s, a.id).length, 1);
  const animLayerIds = new Set(contextLayers(s, a.id).map(l => l.id));
  // animation layers are independent copies with new ids, not the originals
  for (const id of animLayerIds) assert.ok(!beforeAnim.includes(id));
});
```

Delete both `test('addAnimation copies only root-level layers, never another animation\'s private layers', ...)` (~line 357-369) and `test('addAnimation flattens multiple root layers into one for the new group', ...)` (~line 371-385) — they're now covered by the new `acceptAnimation only freezes pixels under its own frames...` and `acceptAnimation flattens multiple visible layers...` tests added in Step 1.

- [ ] **Step 6: Run the full test suite**

Run: `node --test tests/model.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add js/core/model.js tests/model.test.mjs
git commit -m "$(cat <<'EOF'
feat: split addAnimation into bare creation + acceptAnimation freeze

New animations start floating (no layer group) until explicitly or
automatically accepted, so a strip can be freely repositioned over
existing artwork before committing to its own layer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Exclusive compositing — accepted strips own their frame rects

**Files:**
- Modify: `js/core/model.js` (`flattenSheet`, ~line 229-231, now after Task 1's edits)
- Test: `tests/model.test.mjs`

**Interfaces:**
- Consumes: `acceptAnimation`, `addAnimation`, `addFrame` (Task 1), `findGroup`, `flattenLayers`, `sheetLayers`, `flattenSheetLayers`, `copyRegion`, `blitRegion` (all already in `core/model.js`).
- Produces: `flattenSheet(sheet, floating = null)` — same signature as before, but now for each accepted strip (`anim.strip && anim.layerGroupId`), the pixels within that strip's own frame rects come exclusively from that strip's own layer group (hard-replaced, not alpha-blended over whatever's underneath), while everything outside any accepted strip's frame rects composites as before. Floating strips (no `layerGroupId`) are unaffected — their frame rects keep showing whatever's normally there.

- [ ] **Step 1: Write a failing test for exclusive compositing**

In `tests/model.test.mjs`, add after the existing `test('flattenSheet composites visible layers only', ...)` block:

```js
test('flattenSheet gives an accepted strip exclusive, opaque ownership of its own frame rects', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [255, 0, 0, 255]); // root pixel under the strip's frame
  setPixel(sheetLayers(s)[0].bitmap, 8, 0, [0, 255, 0, 255]); // root pixel OUTSIDE the strip's frame

  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  acceptAnimation(s, a); // freezes root's (0,0) red pixel into the strip's own layer

  // erase the strip's own copy of that pixel so it's transparent on the strip's layer
  const g = findGroup(s.layerTree, a.layerGroupId);
  setPixel(flattenLayers(g)[0].bitmap, 0, 0, [0, 0, 0, 0]);

  const flat = flattenSheet(s);
  // inside the strip's own frame rect: transparent strip pixel wins -- root's red does NOT show through
  assert.deepEqual(getPixel(flat, 0, 0), [0, 0, 0, 0]);
  // outside the strip's frame rect: root layer composites normally
  assert.deepEqual(getPixel(flat, 8, 0), [0, 255, 0, 255]);
});

test('flattenSheet leaves a floating (not-yet-accepted) strip transparent to whatever is underneath', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [255, 0, 0, 255]);
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  // not accepted -- a.layerGroupId is still null
  assert.deepEqual(getPixel(flattenSheet(s), 0, 0), [255, 0, 0, 255]);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/model.test.mjs`
Expected: FAIL on `flattenSheet gives an accepted strip exclusive...` — the root's red pixel currently still shows through (alpha-blended, not replaced) at (0,0) since `flattenSheet` doesn't yet special-case accepted strips. The "leaves a floating strip transparent" test already passes (nothing to break yet for floating strips).

- [ ] **Step 3: Rewrite `flattenSheet`**

Find (~line 229-231, may have shifted slightly after Task 1):

```js
export function flattenSheet(sheet, floating = null) {
  return flattenSheetLayers(sheetLayers(sheet), sheet.width, sheet.height, floating, sheet.id);
}
```

Replace with:

```js
export function flattenSheet(sheet, floating = null) {
  const acceptedStrips = sheet.animations
    .filter(a => a.strip && a.layerGroupId)
    .map(a => ({ anim: a, group: findGroup(sheet.layerTree, a.layerGroupId) }))
    .filter(s => s.group);

  const stripLayerIds = new Set();
  for (const { group } of acceptedStrips) for (const l of flattenLayers(group)) stripLayerIds.add(l.id);

  // Everything except an accepted strip's own layers composites normally.
  const baseLayers = sheetLayers(sheet).filter(l => !stripLayerIds.has(l.id));
  const out = flattenSheetLayers(baseLayers, sheet.width, sheet.height, floating, sheet.id);

  // Each accepted strip then exclusively (hard-replace, not alpha-blend)
  // owns its own frame rects: opaque to whatever's on `out` underneath,
  // genuinely transparent (not a peek-through) wherever the strip itself
  // has none of its own content.
  for (const { anim, group } of acceptedStrips) {
    const stripComposite = flattenSheetLayers(flattenLayers(group), sheet.width, sheet.height, floating, sheet.id);
    for (const entry of anim.frames) {
      const frame = sheet.frames.find(f => f.id === entry.frameId);
      if (!frame) continue;
      const region = copyRegion(stripComposite, frame.x, frame.y, frame.w, frame.h);
      blitRegion(out, region, frame.x, frame.y);
    }
  }
  return out;
}
```

`flattenSheetLayers` itself is unchanged — `timeline.js`/`frameeditor.js` call it directly with an already-context-scoped layer list (`currentContextLayers()`), which was never mixing strip + root layers together, so they're unaffected by this change.

- [ ] **Step 4: Run the full test suite**

Run: `node --test tests/model.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add js/core/model.js tests/model.test.mjs
git commit -m "$(cat <<'EOF'
feat: give accepted strips exclusive compositing over their own frame rects

flattenSheet now hard-replaces (not alpha-blends) each accepted strip's
own frame rectangles with that strip's own composite, so nothing
underneath bleeds through even where the strip itself is transparent.
Floating strips are unaffected -- they keep previewing whatever's
underneath, which is the desired pre-accept behavior.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `frames.js` — strip creation no longer eagerly creates a layer group

**Files:**
- Modify: `js/ui/frames.js` (`commitNewStrip` ~line 1300-1358, `commitNewStripFromFrame` ~line 1368-1434 — line numbers as of the current committed state, before this task's edits)

**Interfaces:**
- Consumes: `addAnimation(sheet, name, strip)` (Task 1's new signature — no longer returns a seeded group).
- No change to either function's own external signature or call sites (`commitNewStrip(sheet, name, x, y, frameW, frameH, count, duration)`, `commitNewStripFromFrame(sheet, frame, side, count)`).
- Removes the `animationGroup` import usage from these two functions specifically (Task 7 still needs `animationGroup` for a different purpose, so the import itself stays).

- [ ] **Step 1: Simplify `commitNewStrip`**

Find the current function:

```js
function commitNewStrip(sheet, name, x, y, frameW, frameH, count, duration) {
  const beforeFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();
  const beforeActiveLayerId = state.activeLayerId;

  const descriptors = buildStripFrames(name, x, y, frameW, frameH, count);
  const frames = descriptors.map(d => addFrame(sheet, d));
  const anim = addAnimation(sheet, name, true);
  anim.frames = frames.map(f => ({ frameId: f.id, duration }));
  // addAnimation seeds the new strip's group with exactly one layer -- make
  // it the active layer too, or drawing right after creating the strip
  // would silently target whatever layer was active before (a DIFFERENT
  // animation's own private layer, or root), invisible in this strip's own
  // context until the user happened to reselect the right layer by hand.
  const group = animationGroup(sheet, anim.id);
  const animLayerId = group.children[0].id;
  const groupIdx = sheet.layerTree.children.indexOf(group);

  const afterFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(f => ({ ...f }));
  const firstFrameId = frames[0].id;
  const animId = anim.id;
  const createdIds = new Set(frames.map(f => f.id));

  const cmd = {
    label: 'new strip',
    do() {
      sheet.frames = afterFrames.slice();
      sheet.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(f => ({ ...f }));
      // Undo pulled the private group back out of the layer tree (below) --
      // redo needs to put it back at its original position.
      if (!sheet.layerTree.children.includes(group))
        sheet.layerTree.children.splice(Math.min(groupIdx, sheet.layerTree.children.length), 0, group);
      // state.commands is a single global stack shared by every sheet, so a
      // redo can replay this do() while a DIFFERENT sheet is now active --
      // only touch the global selection/active-layer state when this
      // command's own sheet is still the one on screen, or we'd point
      // activeLayerId/selectedAnimationId at ids from a sheet that isn't showing.
      if (sheet === activeSheet()) {
        state.selectedFrameId = firstFrameId;
        state.selectedAnimationId = animId;
        state.activeLayerId = animLayerId;
      }
    },
    undo() {
      sheet.frames = beforeFrames.slice();
      sheet.animations = beforeAnimations.slice();
      sheet.layerTree.children = sheet.layerTree.children.filter(c => c !== group);
      if (createdIds.has(state.selectedFrameId)) state.selectedFrameId = null;
      if (state.selectedAnimationId === animId) state.selectedAnimationId = null;
      if (state.activeLayerId === animLayerId) state.activeLayerId = beforeActiveLayerId;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}
```

Replace it with:

```js
// A new strip starts FLOATING (see addAnimation/acceptAnimation in
// core/model.js) -- no layer group yet, so there's nothing to add to or
// remove from sheet.layerTree here. Its frames simply preview whatever's
// already on the sheet underneath until it's accepted (Enter key or first
// paint stroke -- see commitAcceptAnimation below and tools.js's hook).
function commitNewStrip(sheet, name, x, y, frameW, frameH, count, duration) {
  const beforeFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();

  const descriptors = buildStripFrames(name, x, y, frameW, frameH, count);
  const frames = descriptors.map(d => addFrame(sheet, d));
  const anim = addAnimation(sheet, name, true);
  anim.frames = frames.map(f => ({ frameId: f.id, duration }));

  const afterFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(f => ({ ...f }));
  const firstFrameId = frames[0].id;
  const animId = anim.id;
  const createdIds = new Set(frames.map(f => f.id));

  const cmd = {
    label: 'new strip',
    do() {
      sheet.frames = afterFrames.slice();
      sheet.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(f => ({ ...f }));
      // state.commands is a single global stack shared by every sheet, so a
      // redo can replay this do() while a DIFFERENT sheet is now active --
      // only touch the global selection state when this command's own sheet
      // is still the one on screen, or we'd point selectedAnimationId at an
      // id from a sheet that isn't showing.
      if (sheet === activeSheet()) {
        state.selectedFrameId = firstFrameId;
        state.selectedAnimationId = animId;
      }
    },
    undo() {
      sheet.frames = beforeFrames.slice();
      sheet.animations = beforeAnimations.slice();
      if (createdIds.has(state.selectedFrameId)) state.selectedFrameId = null;
      if (state.selectedAnimationId === animId) state.selectedAnimationId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}
```

- [ ] **Step 2: Simplify `commitNewStripFromFrame`**

Find the current function:

```js
function commitNewStripFromFrame(sheet, frame, side, count) {
  const extra = count - 1;
  if (extra <= 0) return;
  const fw = frame.w, fh = frame.h;
  const duration = state.project?.settings?.durationMs ?? 100;
  const name = `strip_${sheet.animations.length}`;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();
  const beforeFrameName = frame.name;
  const beforeSelectedAnimationId = state.selectedAnimationId;
  const beforeActiveLayerId = state.activeLayerId;

  const anim = addAnimation(sheet, name, true);
  frame.name = `${name}_0`;
  const entries = [{ frameId: frame.id, duration }];
  for (let j = 0; j < extra; j++) {
    const x = side === 'right' ? frame.x + (j + 1) * fw : frame.x - (j + 1) * fw;
    const nf = addFrame(sheet, { name: `${name}_${j + 1}`, x, y: frame.y, w: fw, h: fh });
    if (side === 'right') entries.push({ frameId: nf.id, duration });
    else entries.unshift({ frameId: nf.id, duration });
  }
  anim.frames = entries;
  // See commitNewStrip's matching comment: without this, drawing right
  // after dragging a frame out into a strip would silently target whatever
  // layer was active before (a different strip's own private layer, or
  // root) -- invisible in this new strip's own context.
  const group = animationGroup(sheet, anim.id);
  const animLayerId = group.children[0].id;
  const groupIdx = sheet.layerTree.children.indexOf(group);

  const afterSheetFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(e => ({ ...e }));
  const afterFrameName = frame.name;
  const animId = anim.id;
  const frameId = frame.id;

  state.commands.push({
    label: 'new strip from frame',
    do() {
      sheet.frames = afterSheetFrames.slice();
      sheet.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(e => ({ ...e }));
      frame.name = afterFrameName;
      // See commitNewStrip's matching comments on both blocks below.
      if (!sheet.layerTree.children.includes(group))
        sheet.layerTree.children.splice(Math.min(groupIdx, sheet.layerTree.children.length), 0, group);
      if (sheet === activeSheet()) {
        state.selectedFrameId = frameId;
        state.selectedAnimationId = animId;
        state.activeLayerId = animLayerId;
      }
    },
    undo() {
      sheet.frames = beforeSheetFrames.slice();
      sheet.animations = beforeAnimations.slice();
      frame.name = beforeFrameName;
      sheet.layerTree.children = sheet.layerTree.children.filter(c => c !== group);
      state.selectedFrameId = frameId;
      state.selectedAnimationId = beforeSelectedAnimationId;
      if (state.activeLayerId === animLayerId) state.activeLayerId = beforeActiveLayerId;
    },
  });
  markDirty();
  emit('selection');
}
```

Replace it with:

```js
function commitNewStripFromFrame(sheet, frame, side, count) {
  const extra = count - 1;
  if (extra <= 0) return;
  const fw = frame.w, fh = frame.h;
  const duration = state.project?.settings?.durationMs ?? 100;
  const name = `strip_${sheet.animations.length}`;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();
  const beforeFrameName = frame.name;
  const beforeSelectedAnimationId = state.selectedAnimationId;

  const anim = addAnimation(sheet, name, true);
  frame.name = `${name}_0`;
  const entries = [{ frameId: frame.id, duration }];
  for (let j = 0; j < extra; j++) {
    const x = side === 'right' ? frame.x + (j + 1) * fw : frame.x - (j + 1) * fw;
    const nf = addFrame(sheet, { name: `${name}_${j + 1}`, x, y: frame.y, w: fw, h: fh });
    if (side === 'right') entries.push({ frameId: nf.id, duration });
    else entries.unshift({ frameId: nf.id, duration });
  }
  anim.frames = entries;

  const afterSheetFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(e => ({ ...e }));
  const afterFrameName = frame.name;
  const animId = anim.id;
  const frameId = frame.id;

  state.commands.push({
    label: 'new strip from frame',
    do() {
      sheet.frames = afterSheetFrames.slice();
      sheet.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(e => ({ ...e }));
      frame.name = afterFrameName;
      if (sheet === activeSheet()) {
        state.selectedFrameId = frameId;
        state.selectedAnimationId = animId;
      }
    },
    undo() {
      sheet.frames = beforeSheetFrames.slice();
      sheet.animations = beforeAnimations.slice();
      frame.name = beforeFrameName;
      state.selectedFrameId = frameId;
      state.selectedAnimationId = beforeSelectedAnimationId;
    },
  });
  markDirty();
  emit('selection');
}
```

- [ ] **Step 3: Confirm the app still loads with no console errors**

Run: `node --input-type=module --check < js/ui/frames.js`
Expected: no output (syntax OK). Full browser verification happens in Task 11.

- [ ] **Step 4: Run the test suite (no regressions expected — these functions aren't unit tested directly)**

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add js/ui/frames.js
git commit -m "$(cat <<'EOF'
feat: new strips start floating instead of eagerly creating a layer group

commitNewStrip/commitNewStripFromFrame no longer look up or manage a
seeded layer group -- addAnimation doesn't create one anymore (Task 1).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `timeline.js` — plain "New Animation" starts floating; export `commitDeleteAnimation`

**Files:**
- Modify: `js/ui/timeline.js` (`commitNewAnimation` ~line 109-153, `commitDeleteAnimation` ~line 155-181 — line numbers as of the current committed state)

**Interfaces:**
- Consumes: `addAnimation(sheet, name)` (Task 1's new signature).
- Produces: `export function commitDeleteAnimation(sheet, animId)` — same body as before (already handles `anim.layerGroupId ? ... : null` gracefully for a floating animation with no group), now exported for Task 8 (`panels.js`) to import.
- No behavior change needed in `commitDeleteAnimation`'s body itself — it already works correctly for a floating (no-group) animation.

- [ ] **Step 1: Simplify `commitNewAnimation`**

Find the current function:

```js
function commitNewAnimation(sheet) {
  const name = `anim_${sheet.animations.length}`;
  const beforeActiveLayerId = state.activeLayerId;
  let anim = null;
  let idx = -1;
  let group = null;
  let animLayerId = null;
  let groupIdx = -1;
  const cmd = {
    label: 'new animation',
    do() {
      if (!anim) {
        // addAnimation seeds the new animation's group with exactly one
        // layer -- see commitNewStrip's matching comment in frames.js:
        // without activating it, drawing right after "New Animation" would
        // silently target whatever layer was active before.
        anim = addAnimation(sheet, name);
        idx = sheet.animations.indexOf(anim);
        group = animationGroup(sheet, anim.id);
        animLayerId = group.children[0].id;
        groupIdx = sheet.layerTree.children.indexOf(group);
      } else {
        if (!sheet.animations.includes(anim)) sheet.animations.splice(Math.min(idx, sheet.animations.length), 0, anim);
        if (!sheet.layerTree.children.includes(group))
          sheet.layerTree.children.splice(Math.min(groupIdx, sheet.layerTree.children.length), 0, group);
      }
      // state.commands is a single global stack shared by every sheet -- only
      // touch selection/active-layer state while this command's own sheet is
      // still the one on screen (see frames.js's matching comment).
      if (sheet === activeSheet()) {
        state.selectedAnimationId = anim.id;
        state.activeLayerId = animLayerId;
      }
    },
    undo() {
      idx = sheet.animations.indexOf(anim);
      sheet.animations = sheet.animations.filter(a => a !== anim);
      sheet.layerTree.children = sheet.layerTree.children.filter(c => c !== group);
      if (state.selectedAnimationId === anim.id) state.selectedAnimationId = null;
      if (state.activeLayerId === animLayerId) state.activeLayerId = beforeActiveLayerId;
    },
  };
  state.commands.push(cmd);
  markDirty();
}
```

Replace it with:

```js
// A new animation starts FLOATING too (see addAnimation/acceptAnimation in
// core/model.js) -- no layer group until accepted. Unlike a strip, a plain
// animation has zero frames at creation, so there's nothing to preview yet;
// acceptance (Enter key or first paint stroke, once frames are assigned)
// just yields a blank layer.
function commitNewAnimation(sheet) {
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  const cmd = {
    label: 'new animation',
    do() {
      if (!anim) { anim = addAnimation(sheet, name); idx = sheet.animations.indexOf(anim); }
      else if (!sheet.animations.includes(anim)) sheet.animations.splice(Math.min(idx, sheet.animations.length), 0, anim);
      // state.commands is a single global stack shared by every sheet -- only
      // touch selection state while this command's own sheet is still the
      // one on screen (see frames.js's matching comment on commitNewStrip).
      if (sheet === activeSheet()) state.selectedAnimationId = anim.id;
    },
    undo() {
      idx = sheet.animations.indexOf(anim);
      sheet.animations = sheet.animations.filter(a => a !== anim);
      if (state.selectedAnimationId === anim.id) state.selectedAnimationId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
}
```

- [ ] **Step 2: Export `commitDeleteAnimation`**

Find:

```js
function commitDeleteAnimation(sheet, animId) {
```

Change to:

```js
export function commitDeleteAnimation(sheet, animId) {
```

The function body is unchanged.

- [ ] **Step 3: Check whether `animationGroup` is still used elsewhere in this file**

Run: `grep -n "animationGroup" js/ui/timeline.js`
Expected: no matches (its only use was in the code just removed). If so, remove it from the import line — find:

```js
import { addAnimation, animationGroup, contextLayers, flattenSheetLayers, findParent, renameAnimation } from '../core/model.js';
```

and change to:

```js
import { addAnimation, contextLayers, flattenSheetLayers, findParent, renameAnimation } from '../core/model.js';
```

- [ ] **Step 4: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/timeline.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add js/ui/timeline.js
git commit -m "$(cat <<'EOF'
feat: plain "New Animation" starts floating too; export commitDeleteAnimation

commitDeleteAnimation is exported so panels.js (Task 8) can reuse it
for the layers panel's "delete an animation's group node" action
instead of duplicating the logic.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `frames.js` — `commitAcceptAnimation` command + Enter-key trigger

**Files:**
- Modify: `js/ui/frames.js` (imports ~line 15-21; new function after `commitBreakApartStrip` ~line 1440-1448; `registerFrameTool()` ~line 1062-1075 — line numbers as of the state after Task 3)

**Interfaces:**
- Consumes: `acceptAnimation(sheet, anim)` (Task 1).
- Produces: `export function commitAcceptAnimation(sheet, anim)` — idempotent (no-op if `anim.layerGroupId` is already set), pushes one undoable command that wires the group `acceptAnimation` already created into `sheet.layerTree` and activates its layer (guarded by the same cross-sheet `sheet === activeSheet()` check used elsewhere in this file). Exported for Task 6 (`tools.js`'s auto-accept hook).

- [ ] **Step 1: Add `acceptAnimation` to the model.js import**

Find:

```js
import { addFrame, removeFrame, addAnimation, renameAnimation, animationGroup } from '../core/model.js';
```

Change to:

```js
import { addFrame, removeFrame, addAnimation, renameAnimation, animationGroup, acceptAnimation } from '../core/model.js';
```

- [ ] **Step 2: Add `commitAcceptAnimation`**

Find `commitBreakApartStrip` (added in an earlier session, currently ~line 1436-1448):

```js
export function commitBreakApartStrip(anim) {
  const beforeBreaks = (anim.breaks ?? []).slice();
  state.commands.push({
    label: 'break apart strip',
    do() { anim.strip = false; anim.breaks = []; },
    undo() { anim.strip = true; anim.breaks = beforeBreaks.slice(); },
  });
  markDirty();
}
```

Add this new function immediately after it:

```js
// Promotes a floating animation (no layer group yet -- see addAnimation/
// acceptAnimation in core/model.js) into a committed one: freezes whatever's
// currently visible under its own frames into a brand-new private layer,
// then activates that layer -- same reasoning as commitNewStrip used to
// apply at creation time, before strips started floating. Idempotent (a
// no-op once already accepted) so this Enter-key trigger and tools.js's
// auto-accept-on-first-paint hook can't double-fire against each other.
// Exported for tools.js's hook.
export function commitAcceptAnimation(sheet, anim) {
  if (anim.layerGroupId) return;
  const beforeActiveLayerId = state.activeLayerId;

  const group = acceptAnimation(sheet, anim);
  const animLayerId = group.children[0].id;
  const groupIdx = sheet.layerTree.children.indexOf(group);

  state.commands.push({
    label: 'accept animation',
    do() {
      anim.layerGroupId = group.id;
      if (!sheet.layerTree.children.includes(group))
        sheet.layerTree.children.splice(Math.min(groupIdx, sheet.layerTree.children.length), 0, group);
      if (sheet === activeSheet()) state.activeLayerId = animLayerId;
    },
    undo() {
      anim.layerGroupId = null;
      sheet.layerTree.children = sheet.layerTree.children.filter(c => c !== group);
      if (state.activeLayerId === animLayerId) state.activeLayerId = beforeActiveLayerId;
    },
  });
  markDirty();
  emit('selection');
}
```

- [ ] **Step 3: Add the Enter-key trigger to `registerFrameTool()`**

Find:

```js
export function registerFrameTool() {
  registerTool({ id: 'frametool', icon: '🖼', key: 'f', isAvailable: () => state.mode === 'sprites' }, buildOptionsRow);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'frametool' || state.mode !== 'sprites') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripOf(sheet, state.selectedFrameId);
    if (strip) commitRemoveMember(sheet, strip, state.selectedFrameId);
    else deleteFrame(sheet, state.selectedFrameId);
  });
}
```

Replace with:

```js
export function registerFrameTool() {
  registerTool({ id: 'frametool', icon: '🖼', key: 'f', isAvailable: () => state.mode === 'sprites' }, buildOptionsRow);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'frametool' || state.mode !== 'sprites') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripOf(sheet, state.selectedFrameId);
    if (strip) commitRemoveMember(sheet, strip, state.selectedFrameId);
    else deleteFrame(sheet, state.selectedFrameId);
  });

  // Accepts whichever animation is currently selected in the timeline dock,
  // if it's still floating -- works for plain animations too, not just
  // strips, since it keys off state.selectedAnimationId rather than the
  // selected frame (a plain animation's frames aren't reliably discoverable
  // via stripOf(), which requires strip: true).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'frametool' || state.mode !== 'sprites') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedAnimationId) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim && !anim.layerGroupId) commitAcceptAnimation(sheet, anim);
  });
}
```

- [ ] **Step 4: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/frames.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add js/ui/frames.js
git commit -m "$(cat <<'EOF'
feat: add commitAcceptAnimation with an Enter-key trigger

Accepting a floating animation freezes whatever's currently visible
under its own frames into a new layer and activates it. Enter accepts
whichever animation is selected in the timeline, while the frame tool
is active. tools.js's auto-accept hook (next task) is the other trigger.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `tools.js` — auto-accept a floating animation on first write

**Files:**
- Modify: `js/ui/tools.js` (imports ~line 14-26; `handleDown` ~line 360-362; `handleSelectDown` ~line 496-497 — line numbers as of the current committed state)

**Interfaces:**
- Consumes: `commitAcceptAnimation(sheet, anim)` (Task 5, exported from `./frames.js`). This creates a circular import (`frames.js` already imports `registerTool` from `./tools.js`) — safe under ES modules because both sides only reference the circularly-imported binding inside function bodies invoked later, never at module top-level evaluation time. Verified in Task 6's Step 4.
- No new exports from `tools.js`.

- [ ] **Step 1: Import `commitAcceptAnimation`**

Find:

```js
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat } from './floatsession.js';
```

Add a new import line right after it:

```js
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat } from './floatsession.js';
import { commitAcceptAnimation } from './frames.js';
```

- [ ] **Step 2: Add the shared auto-accept helper**

Find (inside `export function bindDrawing(...)`, right before `handleDown`):

```js
  // ---- pencil / eraser / fill / line / rect / ellipse ----

  function handleDown(ev) {
    const layer = activeLayer();
    if (!layer) return;
```

Replace with:

```js
  // If the currently selected animation is floating (no layer yet -- see
  // acceptAnimation in core/model.js), accept it before resolving the
  // active layer to write into, so drawing "just works" without the user
  // needing to explicitly accept first (Enter key, frames.js's
  // registerFrameTool). No-ops for read-only tools (eyedropper doesn't call
  // this), tile mode (state.selectedAnimationId isn't used there), or
  // when nothing is selected/already accepted.
  function acceptFloatingContextIfAny() {
    const sheet = activeSheet();
    if (!sheet || !state.selectedAnimationId) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim && !anim.layerGroupId) commitAcceptAnimation(sheet, anim);
  }

  // ---- pencil / eraser / fill / line / rect / ellipse ----

  function handleDown(ev) {
    acceptFloatingContextIfAny();
    const layer = activeLayer();
    if (!layer) return;
```

- [ ] **Step 3: Hook `handleSelectDown` (the move tool) too**

Find:

```js
  function handleSelectDown(ev) {
    if (!activeLayer()) return;
```

Replace with:

```js
  function handleSelectDown(ev) {
    acceptFloatingContextIfAny();
    if (!activeLayer()) return;
```

- [ ] **Step 4: Verify the circular import resolves cleanly**

Start a local static server and load the app, checking for console errors (an import-time circular-dependency failure would show up as a module load error):

```bash
python -m http.server 8811 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8811/index.html
```

Expected: `200`. Then use the Playwright MCP tools to navigate to `http://localhost:8811/index.html?autotest` and check `mcp__plugin_playwright_playwright__browser_console_messages` at `level: "warning"` with `all: true`.
Expected: `Total messages: 0 (Errors: 0, Warnings: 0)` — confirms both `frames.js` and `tools.js` loaded without a circular-import error. Stop the server afterward (`pkill -f "http.server 8811"`).

- [ ] **Step 5: Run the test suite**

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add js/ui/tools.js
git commit -m "$(cat <<'EOF'
feat: auto-accept a floating animation on the first paint/move stroke

Drawing or moving content in a floating animation's context accepts it
first, so the stroke lands on a real layer instead of silently no-oping
against a null activeLayer().

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `frames.js` — strip shrink clears (not preserves) the removed area's pixels

**Files:**
- Modify: `js/ui/frames.js` (imports ~line 15-21; `commitResizeSegment` ~line 402-461 — line numbers as of the state after Task 5)

**Interfaces:**
- Consumes: `animationGroup(sheet, animId)` (already imported), `createBitmap`, `copyRegion`, `blitRegion` from `core/pixels.js`.
- No change to `commitResizeSegment`'s external signature (`commitResizeSegment(sheet, d)`).

- [ ] **Step 1: Add `createBitmap` to the pixels import**

Find:

```js
import { copyRegion, fillRegion, blitRegion } from '../core/pixels.js';
```

Change to:

```js
import { createBitmap, copyRegion, fillRegion, blitRegion } from '../core/pixels.js';
```

- [ ] **Step 2: Rewrite `commitResizeSegment`**

Find the current function:

```js
// Resize = add/remove whole frames at the dragged end. Grow appends blank
// frames (right: rightward; left: leftward, prepended in order). Shrink
// removes frames + entries from that end; PIXELS STAY on the sheet by design
// (growing back re-adopts the art). Neighbor's duration is copied.
function commitResizeSegment(sheet, d) {
  const { anim, run, side, fw, fh, bbox } = d;
  const delta = d.count - d.count0;
  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();
  const beforeSelected = state.selectedFrameId;
  const neighbor = side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start];
  const duration = neighbor?.duration ?? (state.project?.settings?.durationMs ?? 100);

  if (delta > 0) {
    for (let j = 0; j < delta; j++) {
      const x = side === 'right' ? bbox.x + bbox.w + j * fw : bbox.x - (j + 1) * fw;
      const frame = addFrame(sheet, {
        name: `${anim.name}_${anim.frames.length}`, x, y: bbox.y, w: fw, h: fh,
      });
      const index = side === 'right' ? run.end + j : run.start;
      const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, side === 'right');
      anim.frames = r.entries;
      anim.breaks = r.breaks;
    }
  } else {
    for (let j = 0; j < -delta; j++) {
      const index = side === 'right' ? run.end - 1 - j : run.start;
      const frameId = anim.frames[index].frameId;
      sheet.frames = sheet.frames.filter(f => f.id !== frameId);
      const r = removeEntry(anim.frames, anim.breaks, index);
      anim.frames = r.entries;
      anim.breaks = r.breaks;
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    }
  }

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();
  const afterSelected = state.selectedFrameId;

  state.commands.push({
    label: 'resize strip',
    do() {
      sheet.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = afterSelected;
    },
    undo() {
      sheet.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      state.selectedFrameId = beforeSelected;
    },
  });
  markDirty();
  emit('selection');
}
```

Replace it with:

```js
// Resize = add/remove whole frames at the dragged end. Grow appends blank
// frames (right: rightward; left: leftward, prepended in order) -- always a
// pure array operation, no pixel effects. Shrink removes frames + entries
// from that end and, once the strip is accepted (has its own layer -- see
// acceptAnimation in core/model.js), also clears the removed frame's own
// pixels from it: each strip now owns its own layer, so there's no shared
// underlying sheet art left to preserve for a future regrow the way there
// used to be before strips had layers of their own. A floating strip has no
// layer yet, so shrink stays pixel-free too. Neighbor's duration is copied.
function commitResizeSegment(sheet, d) {
  const { anim, run, side, fw, fh, bbox } = d;
  const delta = d.count - d.count0;
  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();
  const beforeSelected = state.selectedFrameId;
  const neighbor = side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start];
  const duration = neighbor?.duration ?? (state.project?.settings?.durationMs ?? 100);

  const group = anim.layerGroupId ? animationGroup(sheet, anim.id) : null;
  const layer = group ? group.children[0] : null;
  const clearPatches = [];

  if (delta > 0) {
    for (let j = 0; j < delta; j++) {
      const x = side === 'right' ? bbox.x + bbox.w + j * fw : bbox.x - (j + 1) * fw;
      const frame = addFrame(sheet, {
        name: `${anim.name}_${anim.frames.length}`, x, y: bbox.y, w: fw, h: fh,
      });
      const index = side === 'right' ? run.end + j : run.start;
      const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, side === 'right');
      anim.frames = r.entries;
      anim.breaks = r.breaks;
    }
  } else {
    for (let j = 0; j < -delta; j++) {
      const index = side === 'right' ? run.end - 1 - j : run.start;
      const frameId = anim.frames[index].frameId;
      const frame = sheet.frames.find(f => f.id === frameId);
      if (layer && frame) {
        clearPatches.push({ x: frame.x, y: frame.y, before: copyRegion(layer.bitmap, frame.x, frame.y, fw, fh) });
      }
      sheet.frames = sheet.frames.filter(f => f.id !== frameId);
      const r = removeEntry(anim.frames, anim.breaks, index);
      anim.frames = r.entries;
      anim.breaks = r.breaks;
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    }
    if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
  }

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();
  const afterSelected = state.selectedFrameId;

  state.commands.push({
    label: 'resize strip',
    do() {
      sheet.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = afterSelected;
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
    },
    undo() {
      sheet.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      state.selectedFrameId = beforeSelected;
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, p.before, p.x, p.y);
    },
  });
  markDirty();
  emit('selection');
}
```

- [ ] **Step 3: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/frames.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add js/ui/frames.js
git commit -m "$(cat <<'EOF'
feat: shrinking an accepted strip clears the removed frame's own pixels

Each strip owns its own layer now, so there's no shared underlying
sheet art left to preserve for a future regrow the way the old
"pixels stay on the sheet" design required. Floating strips (no
layer yet) are unaffected -- shrink stays a pure array operation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `panels.js` — deleting an animation's group node deletes the whole animation

**Files:**
- Modify: `js/ui/panels.js` (imports ~line 3; `doDelete`'s group branch ~line 465-536 — line numbers as of the current committed state)

**Interfaces:**
- Consumes: `commitDeleteAnimation(sheet, animId)` (Task 4, exported from `./timeline.js`). No circular import risk: neither `panels.js` nor `timeline.js` currently imports from the other in either direction.

- [ ] **Step 1: Import `commitDeleteAnimation`**

Find:

```js
import { state, on, emit, activeSheet, activeLayer, markDirty, confirmOrAuto } from '../app/state.js';
```

Add a new import line right after it:

```js
import { state, on, emit, activeSheet, activeLayer, markDirty, confirmOrAuto } from '../app/state.js';
import { commitDeleteAnimation } from './timeline.js';
```

- [ ] **Step 2: Replace the group-deletion branch in `doDelete`**

Find:

```js
    if (selectedNodeId) {
      const g = findGroup(sheet.layerTree, selectedNodeId);
      if (g) {
        if (g.animationId && !confirmOrAuto(`Delete group "${g.name}"? Its animation will keep its frames but lose its layer group.`)) return;
        else if (!g.animationId && !confirmOrAuto(`Delete group "${g.name}" and its contents?`)) return;
        const loc = findParent(sheet.layerTree, g.id);
        if (!loc) return;
        const parent = loc.parent;
        const beforeChildren = parent.children.slice();
        const beforeActive = state.activeLayerId;
        const cmd = {
          label: 'delete group',
          do() {
            parent.children = parent.children.filter(c => c.id !== g.id);
            if (g.animationId) {
              const anim = sheet.animations.find(a => a.id === g.animationId);
              if (anim) anim.layerGroupId = null;
            }
            selectedNodeId = state.activeLayerId;
          },
          undo() {
            parent.children = beforeChildren.slice();
            if (g.animationId) {
              const anim = sheet.animations.find(a => a.id === g.animationId);
              if (anim) anim.layerGroupId = g.id;
            }
            selectedNodeId = g.id;
            state.activeLayerId = beforeActive;
          },
        };
        state.commands.push(cmd);
        markDirty();
      }
    }
```

Replace it with:

```js
    if (selectedNodeId) {
      const g = findGroup(sheet.layerTree, selectedNodeId);
      if (g) {
        if (g.animationId) {
          const anim = sheet.animations.find(a => a.id === g.animationId);
          if (!confirmOrAuto(`Delete animation "${anim?.name ?? g.name}" and its frames?`)) return;
          commitDeleteAnimation(sheet, g.animationId);
          // commitDeleteAnimation lives in timeline.js and has no knowledge
          // of this panel's own local selectedNodeId -- clear it so a stale
          // id (pointing at the now-deleted group) doesn't linger, matching
          // the layer-delete branch above which resets it after its own
          // deletion too. No explicit renderList() call needed here: like
          // every other branch in this function, commitDeleteAnimation's own
          // markDirty() already triggers this panel's on('project', renderList).
          selectedNodeId = null;
          return;
        }
        if (!confirmOrAuto(`Delete group "${g.name}" and its contents?`)) return;
        const loc = findParent(sheet.layerTree, g.id);
        if (!loc) return;
        const parent = loc.parent;
        const beforeChildren = parent.children.slice();
        const beforeActive = state.activeLayerId;
        const cmd = {
          label: 'delete group',
          do() {
            parent.children = parent.children.filter(c => c.id !== g.id);
            selectedNodeId = state.activeLayerId;
          },
          undo() {
            parent.children = beforeChildren.slice();
            selectedNodeId = g.id;
            state.activeLayerId = beforeActive;
          },
        };
        state.commands.push(cmd);
        markDirty();
      }
    }
```

- [ ] **Step 3: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/panels.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add js/ui/panels.js
git commit -m "$(cat <<'EOF'
feat: deleting an animation's group node in the layers panel deletes the animation

Previously this only detached the group, leaving the animation and its
frames alive with no layer. Now it fully deletes the animation via the
same commitDeleteAnimation the timeline dock's Delete button uses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `panels.js` — selecting an animation's group node selects it in the timeline

**Files:**
- Modify: `js/ui/panels.js` (`renderGroup` ~line 818-868 — line numbers as of the state after Task 8)

**Interfaces:**
- No new imports needed (`state`, `emit` already imported).
- Produces a new local helper `selectGroupNode(group)` within the same closure as `renderGroup`, used by both of that function's click handlers.

- [ ] **Step 1: Add the shared selection helper and wire it into both click handlers**

Find:

```js
  function renderGroup(group, depth) {
    const sheet = activeSheet();
```

Replace with:

```js
  // Selecting an animation's group node also selects that animation in the
  // timeline dock, so the two panels stay in sync.
  function selectGroupNode(group) {
    selectedNodeId = group.id;
    state.activeLayerId = null;
    if (group.animationId) { state.selectedAnimationId = group.animationId; emit('selection'); }
  }

  function renderGroup(group, depth) {
    const sheet = activeSheet();
```

Then find:

```js
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      scheduleNameSelect(() => { selectedNodeId = group.id; state.activeLayerId = null; });
    });
```

Replace with:

```js
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      scheduleNameSelect(() => selectGroupNode(group));
    });
```

Then find:

```js
    row.append(toggle, icon, nameEl);
    row.addEventListener('click', () => { selectedNodeId = group.id; state.activeLayerId = null; renderList(); });
    list.appendChild(row);
```

Replace with:

```js
    row.append(toggle, icon, nameEl);
    row.addEventListener('click', () => { selectGroupNode(group); renderList(); });
    list.appendChild(row);
```

- [ ] **Step 2: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/panels.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 3: Commit**

```bash
git add js/ui/panels.js
git commit -m "$(cat <<'EOF'
feat: selecting an animation's group node syncs the timeline dock

Clicking a layers-panel group row that belongs to an animation now
also sets state.selectedAnimationId, so the timeline dropdown follows.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `overlays.js` — dashed outline for floating (unaccepted) frames

**Files:**
- Modify: `js/ui/overlays.js` (constants ~line 9-24; new helper + `drawSpriteOverlays` ~line 51-71 — line numbers as of the current committed state)

**Interfaces:**
- No new imports needed (`state`, `activeSheet` already imported).
- Produces a new local (unexported) helper `isFloatingFrame(sheet, frame)`.

- [ ] **Step 1: Add the `FLOATING_STROKE` constant**

Find:

```js
const FRAME_STROKE = '#4f8cff';
const FRAME_FILL = 'rgba(79,140,255,.15)';
```

Change to:

```js
const FRAME_STROKE = '#4f8cff';
const FRAME_FILL = 'rgba(79,140,255,.15)';
const FLOATING_STROKE = '#e0a030';
```

- [ ] **Step 2: Add the `isFloatingFrame` helper and use it in `drawSpriteOverlays`**

Find:

```js
function drawSpriteOverlays(view, ctx, sheet) {
  const frames = sheet.frames;
  if (!frames.length) return;

  if (state.overlays.labels) {
    ctx.save();
    frames.forEach((f) => {
      const selected = f.id === state.selectedFrameId;
      const p0 = view.imageToScreen(f.x, f.y);
      const p1 = view.imageToScreen(f.x + f.w, f.y + f.h);
      const w = p1.x - p0.x, h = p1.y - p0.y;
      if (selected) {
        ctx.fillStyle = FRAME_FILL;
        ctx.fillRect(p0.x, p0.y, w, h);
      }
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = FRAME_STROKE;
      ctx.strokeRect(p0.x, p0.y, w, h);
    });
    ctx.restore();
  }
```

Replace with:

```js
// A frame belongs to a floating (not-yet-accepted) animation when some
// animation references it but hasn't been frozen into its own layer yet --
// see acceptAnimation in core/model.js.
function isFloatingFrame(sheet, frame) {
  const anim = sheet.animations.find(a => a.frames.some(af => af.frameId === frame.id));
  return !!anim && !anim.layerGroupId;
}

function drawSpriteOverlays(view, ctx, sheet) {
  const frames = sheet.frames;
  if (!frames.length) return;

  if (state.overlays.labels) {
    ctx.save();
    frames.forEach((f) => {
      const selected = f.id === state.selectedFrameId;
      const floating = isFloatingFrame(sheet, f);
      const p0 = view.imageToScreen(f.x, f.y);
      const p1 = view.imageToScreen(f.x + f.w, f.y + f.h);
      const w = p1.x - p0.x, h = p1.y - p0.y;
      if (selected) {
        ctx.fillStyle = FRAME_FILL;
        ctx.fillRect(p0.x, p0.y, w, h);
      }
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = floating ? FLOATING_STROKE : FRAME_STROKE;
      ctx.setLineDash(floating ? [4, 4] : []);
      ctx.strokeRect(p0.x, p0.y, w, h);
    });
    ctx.restore();
  }
```

`ctx.restore()` already reverts `setLineDash` along with every other context property changed since the matching `ctx.save()`, so no separate reset is needed after the loop.

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < js/ui/overlays.js`
Expected: no output (syntax OK).

- [ ] **Step 4: Commit**

```bash
git add js/ui/overlays.js
git commit -m "$(cat <<'EOF'
feat: dashed outline distinguishes a floating strip from an accepted one

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: End-to-end browser verification

**Files:** none (verification only — no code changes).

- [ ] **Step 1: Start a local static server**

```bash
python -m http.server 8811 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8811/index.html
```

Expected: `200`.

- [ ] **Step 2: Load the app and confirm a clean console**

Use `mcp__plugin_playwright_playwright__browser_navigate` to `http://localhost:8811/index.html?autotest` (the `?autotest` query suppresses confirm/beforeunload dialogs that would otherwise block automated interaction — see `js/app/state.js`'s `AUTOTEST` flag).

Then call `mcp__plugin_playwright_playwright__browser_console_messages` with `level: "warning"`, `all: true`.
Expected: `Total messages: 0 (Errors: 0, Warnings: 0)`.

Every interaction below uses `mcp__plugin_playwright_playwright__browser_evaluate` with a DOM-query-based function body (finding buttons by `textContent`, elements by class) rather than element refs from a snapshot — refs are per-navigation and won't still be valid by the time this plan is executed, but text/class-based queries will. `doDelete`'s `confirmOrAuto` calls (`js/app/state.js`: `confirmOrAuto = (msg) => AUTOTEST || confirm(msg)`) already auto-pass without prompting, since navigating with `?autotest` sets `AUTOTEST`. Only override `alert` (used directly, not through `confirmOrAuto`, by the unrelated "last layer in this group" guard) so an unexpected one can't block automation:

```js
() => { window.alert = (m) => { window.__lastAlert = m; }; }
```

- [ ] **Step 3: Create a strip and verify it floats (no layer group) with a dashed outline**

```js
() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'New strip…');
  btn.click();
}
```

```js
() => {
  const create = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Create');
  create.click();
}
```

```js
() => {
  const dock = document.querySelector('#timeline-dock');
  const animName = dock.querySelector('select').selectedOptions[0].textContent;
  const groupRows = Array.from(document.querySelectorAll('.group-row')).map(r => r.textContent);
  return { animName, hasGroupYet: groupRows.some(r => r.includes(animName)) };
}
```

Expected: `hasGroupYet: false` — the strip has no layer group yet (floating). Then take a screenshot via `mcp__plugin_playwright_playwright__browser_take_screenshot` and visually confirm the new strip's frames show a dashed amber outline (`#e0a030`) instead of the solid blue (`#4f8cff`) outline on any pre-existing frames.

- [ ] **Step 4: Verify auto-accept on first paint stroke**

Select the pencil tool and click once on the canvas at a point inside the floating strip's first frame (a single click, not a drag — this project's convention is to never simulate pointer drags in Playwright):

```js
() => {
  const pencilBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '✏️');
  pencilBtn.click();
}
```

Use `mcp__plugin_playwright_playwright__browser_click` on the sheet canvas element at a screen coordinate inside the floating strip's first frame (read the frame's screen position from the Step 3 screenshot). Then re-check the layers panel:

```js
() => {
  const dock = document.querySelector('#timeline-dock');
  const animName = dock.querySelector('select').selectedOptions[0].textContent;
  const groupRows = Array.from(document.querySelectorAll('.group-row')).map(r => r.textContent);
  return groupRows.some(r => r.includes(animName));
}
```

Expected: `true` — the strip now has a group row, auto-accepted by the paint stroke. Take another screenshot and confirm this strip's outline is now solid blue, not dashed.

- [ ] **Step 5: Verify Enter-key accept on a second new strip**

Repeat Step 3's two clicks to create a second (still-floating) strip. Select the frame tool and click one of its frames (`browser_click` on the canvas at that frame's screen position), then dispatch Enter:

```js
() => {
  const frameBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '🖼');
  frameBtn.click();
}
```

```js
() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}
```

Re-check group rows as in Step 4. Expected: the second strip also now has a group row — accepted via Enter without any paint stroke.

- [ ] **Step 6: Verify exclusive compositing**

The "New strip…" dialog auto-places the strip via `findFreeRect` (no position field to choose one directly), so paint the root layer's test color AFTER the strip exists, at its now-visible screen position, rather than trying to pre-place it underneath a strip whose location isn't yet known:

1. Create a floating strip (Step 3's two clicks). Take a screenshot to read its frame's screen rect.
2. Deselect the animation so painting targets the root layer instead of auto-accepting the floating strip:
   ```js
   () => {
     const dock = document.querySelector('#timeline-dock');
     const sel = dock.querySelector('select');
     sel.value = '';
     sel.dispatchEvent(new Event('change', { bubbles: true }));
   }
   ```
3. Select the pencil tool and `browser_click` on the canvas at a point inside the floating strip's frame (from the Step 1 screenshot) — this paints bright green (set primary color first if needed) onto the root layer, visible through the still-floating strip.
4. Re-select the strip's animation in the timeline dropdown (same pattern as step 2, with the strip's own id/name instead of `''`), then accept it via Enter (frame tool active, one of its frames selected) — this freezes the just-painted green into the strip's own layer.
5. Select the eraser tool and `browser_click` at that same canvas position — this now targets the strip's own (just-accepted) layer, erasing that spot back to transparent.
6. Take a screenshot via `mcp__plugin_playwright_playwright__browser_take_screenshot` and visually confirm the erased spot shows checkerboard/transparent — NOT the green reappearing from the root layer underneath, which is what the old (pre-Task-2) alpha-blended compositing would have shown.

- [ ] **Step 7: Verify strip shrink clears pixels**

With an accepted strip selected (frame tool), drag its right edge grip to shrink it by one frame, then drag it back out to grow it by one frame again. (Per this project's convention, don't simulate this drag in Playwright — perform Step 7 as a manual check in a real browser session instead, or skip automated verification here and note it as a manual follow-up in the final report.) If performed manually: confirm the regrown frame's pixels are blank (checkerboard), not the original art reappearing — visually, via screenshot, before-shrink vs. after-regrow.

- [ ] **Step 8: Verify layers-panel delete/select sync**

```js
() => {
  const groupRow = document.querySelector('.group-row');
  groupRow.click();
  const dock = document.querySelector('#timeline-dock');
  return { groupText: groupRow.textContent, timelineSelected: dock.querySelector('select').selectedOptions[0].textContent };
}
```

Expected: `timelineSelected` matches the animation name shown in `groupText` — clicking the group row selected that animation in the timeline dropdown too. Then:

```js
() => {
  const dock = document.querySelector('#timeline-dock');
  const nameBefore = dock.querySelector('select').selectedOptions[0].textContent;
  const delBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === '🗑');
  delBtn.click();
  const optionsAfter = Array.from(dock.querySelector('select').options).map(o => o.textContent);
  return { nameBefore, stillPresent: optionsAfter.includes(nameBefore) };
}
```

Expected: `stillPresent: false` — `confirmOrAuto` auto-passed (per the `?autotest` behavior noted above) and `commitDeleteAnimation` (Task 8) fully removed the animation, so it's gone from the timeline dropdown's own option list too, not just detached from its layer group as the old behavior would have left it.

- [ ] **Step 9: Run the full automated test suite one more time**

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 10: Stop the local server**

```bash
pkill -f "http.server 8811"
```

- [ ] **Step 11: No commit for this task** (verification only). If any step surfaces a bug, fix it in the relevant earlier task's files, re-run that task's tests, and re-run this verification task from Step 1.
