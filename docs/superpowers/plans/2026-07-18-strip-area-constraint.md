# Strip Area Constraint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An accepted strip's own layer(s) never carry pixel content outside
the area its own frames currently occupy — painting, copy/cut/paste, and
both move mechanisms (frame-tool drag, move-tool drag) all confine
themselves to the current *segment* (contiguous frame run) being worked on,
resolved from the actual layer/frame in play rather than from ambient
timeline selection. Selecting a leaf layer nested under any animation node
(strip or plain) narrows Alt-modifier "all layers" operations to that
animation's own layers too.

**Architecture:** A single new primitive, `layerAnimationContext(sheet,
layer)` in `core/model.js`, answers "does this layer belong to an
animation's own group, and which animation?" — every other change threads
off that. `core/strips.js` gains segment-geometry helpers
(`segmentMembers`/`segmentBounds`/`segmentOfPoint`) shared by the sheet
view's `getTargetRect`, the move tool's frame-float, and the frame tool's
own drag. `js/ui/tools.js`'s `bindDrawing` freezes its resolved target rect
once per stroke (mirroring how the select tool already does) instead of
re-querying it on every pointer event. `js/ui/floatsession.js` gains an
explicit-layers override and anchor-point threading so float/paste
confinement (already existing machinery — `ctx.targetRect` frozen at
creation, checked at commit) picks up the new segment-aware target for free.
`js/ui/frames.js`'s frame-tool drag becomes pixel-carrying for accepted
strips, reusing the existing `buildMovePatches` eager-move helper with an
explicit layer list instead of ambient `currentContextLayers()`.

**Tech Stack:** Vanilla ES modules, no build step. Tests via `node --test
tests/*.mjs`. Browser verification via a local static server + Playwright
MCP tools — per this project's standing convention, pointer **drags** are
never simulated in Playwright (verified manually instead); clicks and
keyboard shortcuts are fine to automate.

## Global Constraints

- No new dependencies.
- Every mutating UI action must remain undoable through `state.commands`
  (`core/commands.js`), following the codebase's established "eager-mutate
  now, snapshot before/after, `do()`/`undo()` swap" idiom (see
  `buildMovePatches` in `js/ui/frames.js` for the canonical example this
  plan reuses).
- Run `node --test tests/*.mjs` after every task that touches `core/*.js`
  and before every commit; it must stay at 0 failures.
- After every task that touches a `.js` file, run `node --input-type=module
  --check < <file>` on each touched file as a syntax smoke check.
- Scope, per the approved design
  (`docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md`):
  the *area/segment* constraint (painting, moves, merge restriction) is
  **accepted strips only**. The *layer-selection scoping* rule (Alt-modifier
  "all layers" narrowing) is **any animation node, strip or plain**. Floating
  strips and plain non-strip-animation moves are unaffected by both.

---

### Task 1: `core/model.js` — `layerAnimationContext` primitive

**Files:**
- Modify: `js/core/model.js` (add function after `contextLayers`, ~line 270)
- Test: `tests/model.test.mjs`

**Interfaces:**
- Produces: `layerAnimationContext(sheet, layer) → { anim, group } | null` —
  given a layer object (or `null`), resolves the animation that owns it (the
  layer is nested directly under that animation's own group) via
  `findParent`. Returns `null` for a root layer, a layer under a plain
  (non-animation) group, or a `null` layer. Works for both strip and plain
  animations — callers that care about strip-ness check `ctx.anim.strip`
  themselves.
- Consumes (unchanged): `findParent`, already defined in this file.

- [ ] **Step 1: Write failing tests**

Open `tests/model.test.mjs`. Add `layerAnimationContext` to the existing
import list (currently ending `...addGroup, flattenLayers, moveNode,
scrubTileReferences,`):

```js
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, acceptAnimation, flattenSheet, flattenSheetLayers,
  serializeProject, deserializeProject, validateProjectJson, GROUP, LAYER,
  sheetLayers, findGroup, contextLayers, addGroup, flattenLayers, moveNode,
  scrubTileReferences, layerAnimationContext,
} from '../js/core/model.js';
```

Add these new test cases anywhere after the existing `flattenSheet leaves a
floating (not-yet-accepted) strip transparent...` test:

```js
test('layerAnimationContext returns null for a root layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  assert.equal(layerAnimationContext(s, sheetLayers(s)[0]), null);
});

test('layerAnimationContext returns null for a layer under a plain (non-animation) group', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const g = addGroup(s, 'g1');
  const layer = addLayer(s, 'inside', g.id);
  assert.equal(layerAnimationContext(s, layer), null);
});

test('layerAnimationContext returns null for a null layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  assert.equal(layerAnimationContext(s, null), null);
});

test('layerAnimationContext resolves the owning animation for an accepted strip\'s own layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'walk', true);
  acceptAnimation(s, a);
  const group = findGroup(s.layerTree, a.layerGroupId);
  const layer = flattenLayers(group)[0];
  const ctx = layerAnimationContext(s, layer);
  assert.equal(ctx.anim, a);
  assert.equal(ctx.group, group);
});

test('layerAnimationContext also resolves a plain (non-strip) animation\'s own layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'anim_0'); // strip: false
  acceptAnimation(s, a);
  const group = findGroup(s.layerTree, a.layerGroupId);
  const layer = flattenLayers(group)[0];
  const ctx = layerAnimationContext(s, layer);
  assert.equal(ctx.anim, a);
  assert.equal(ctx.anim.strip, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model.test.mjs`
Expected: FAIL — `layerAnimationContext` is not exported / is not a function.

- [ ] **Step 3: Implement `layerAnimationContext`**

In `js/core/model.js`, find:

```js
export function contextLayers(sheet, animId = null) {
  if (!animId) return sheetLayers(sheet);
  const group = animationGroup(sheet, animId);
  return group ? flattenLayers(group) : sheetLayers(sheet);
}
```

Add immediately after it:

```js
// Given a layer, resolves the animation that owns it -- i.e. the layer is
// nested directly under an animation-owned group (group.animationId set).
// Returns null for a root layer, a layer under a plain (non-animation)
// group, or a null layer. A layer can only be nested under an animation-
// owned group after that animation has been accepted (see acceptAnimation)
// -- a floating animation has no group/layer at all, so this never needs to
// special-case "floating". Works for both strip and plain animations;
// callers that care about strip-ness check ctx.anim.strip themselves.
export function layerAnimationContext(sheet, layer) {
  if (!layer) return null;
  const loc = findParent(sheet.layerTree, layer.id);
  const group = loc?.parent;
  if (!group?.animationId) return null;
  const anim = sheet.animations.find(a => a.id === group.animationId);
  return anim ? { anim, group } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model.test.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add js/core/model.js tests/model.test.mjs
git commit -m "$(cat <<'EOF'
feat: add layerAnimationContext to resolve a layer's owning animation

Single primitive every other change in this feature threads off: given
a layer, is it nested under an animation's own group, and which one.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `core/strips.js` — segment geometry helpers

**Files:**
- Modify: `js/core/strips.js` (export `segmentMembers`, add `segmentBounds`,
  `segmentOfPoint`; refactor `segmentAt` to reuse them, ~line 50-76)
- Modify: `js/ui/frames.js` (remove local `segmentMembers`, import from
  strips.js instead, ~line 18, ~line 100-106)
- Test: `tests/strips.segments.test.mjs`

**Interfaces:**
- Produces: `segmentMembers(sheet, anim, run) → Frame[]` — moved here
  verbatim from `js/ui/frames.js` (was a private local function there).
- Produces: `segmentBounds(sheet, anim, run) → {x,y,w,h}` — union bounding
  box of one segment's current member frames.
- Produces: `segmentOfPoint(sheet, anim, x, y) → run | null` — the segment
  (from `segmentsOf(anim)`) whose members contain `(x, y)`, scoped to just
  this one animation (unlike `segmentAt`, which searches every animation on
  the sheet). Returns `null` when the point isn't inside any of this
  animation's own frames.
- `segmentAt(sheet, x, y)` keeps its existing signature/behavior
  (`{rect, frameIds} | null`, searches all strip animations then plain
  frames) but is reimplemented in terms of the three functions above.
- Consumes (unchanged): `segmentsOf`, already defined in this file.

- [ ] **Step 1: Write failing tests for the new exports**

Open `tests/strips.segments.test.mjs`. Add `segmentMembers, segmentBounds,
segmentOfPoint, segmentAt` to the existing import list:

```js
import {
  normalizeBreaks, segmentsOf, segmentOfFrame,
  insertEntry, removeEntry, mergeSegments, transferSegment,
  segmentMembers, segmentBounds, segmentOfPoint, segmentAt,
} from '../js/core/strips.js';
```

Add this helper and these new test cases anywhere after the existing
`entries`/`ids` helpers at the top of the file:

```js
function sheetWith(frames, animations = []) {
  return { width: 256, height: 256, frames, animations };
}
```

```js
test('segmentMembers returns frame objects in order, skipping dangling frameIds', () => {
  const f0 = { id: 'a', x: 0, y: 0, w: 16, h: 16 };
  const f1 = { id: 'b', x: 16, y: 0, w: 16, h: 16 };
  const sheet = sheetWith([f0, f1]);
  const anim = { frames: entries('a', 'zz', 'b'), breaks: [] };
  const run = segmentsOf(anim)[0];
  assert.deepEqual(segmentMembers(sheet, anim, run), [f0, f1]);
});

test("segmentBounds computes the union bbox of a segment's member frames", () => {
  const f0 = { id: 'a', x: 0, y: 0, w: 16, h: 16 };
  const f1 = { id: 'b', x: 16, y: 4, w: 16, h: 20 };
  const sheet = sheetWith([f0, f1]);
  const anim = { frames: entries('a', 'b'), breaks: [] };
  const run = segmentsOf(anim)[0];
  assert.deepEqual(segmentBounds(sheet, anim, run), { x: 0, y: 0, w: 32, h: 24 });
});

test('segmentOfPoint finds the run containing a point, across multiple segments', () => {
  const f0 = { id: 'a', x: 0, y: 0, w: 16, h: 16 };
  const f1 = { id: 'b', x: 100, y: 0, w: 16, h: 16 }; // second segment, moved away
  const sheet = sheetWith([f0, f1]);
  const anim = { frames: entries('a', 'b'), breaks: [1] }; // two segments
  const runs = segmentsOf(anim);
  assert.deepEqual(segmentOfPoint(sheet, anim, 5, 5), runs[0]);
  assert.deepEqual(segmentOfPoint(sheet, anim, 105, 5), runs[1]);
  assert.equal(segmentOfPoint(sheet, anim, 50, 5), null); // gap between segments
});

test("segmentOfPoint never matches a different animation's frames", () => {
  const f0 = { id: 'a', x: 0, y: 0, w: 16, h: 16 };
  const sheet = sheetWith([f0]);
  const anim = { frames: [], breaks: [] }; // this anim owns no frames
  assert.equal(segmentOfPoint(sheet, anim, 5, 5), null);
});

test('segmentAt finds a strip segment at a point, else the topmost plain frame, else null', () => {
  const stripF0 = { id: 's0', x: 0, y: 0, w: 16, h: 16 };
  const stripF1 = { id: 's1', x: 16, y: 0, w: 16, h: 16 };
  const plainF = { id: 'p0', x: 0, y: 32, w: 16, h: 16 };
  const sheet = sheetWith([stripF0, stripF1, plainF],
    [{ strip: true, frames: entries('s0', 's1'), breaks: [] }]);
  assert.deepEqual(segmentAt(sheet, 20, 5), { rect: { x: 0, y: 0, w: 32, h: 16 }, frameIds: ['s0', 's1'] });
  assert.deepEqual(segmentAt(sheet, 5, 35), { rect: { x: 0, y: 32, w: 16, h: 16 }, frameIds: ['p0'] });
  assert.equal(segmentAt(sheet, 200, 200), null);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/strips.segments.test.mjs`
Expected: FAIL — `segmentMembers`/`segmentBounds`/`segmentOfPoint` are not
exported from `strips.js` yet. The `segmentAt` test currently passes
unchanged (it's a characterization test of existing behavior).

- [ ] **Step 3: Add the new exports and refactor `segmentAt`**

In `js/core/strips.js`, find:

```js
// Movable content under a point, for the move tool: the strip SEGMENT whose
// members contain (x, y) — a sub-strip wins over its parent strip by
// construction — else the topmost plain frame. Returns the bounding rect plus
// the member frame ids (so a float commit can move the frames with the
// pixels), or null when the point hits no frame.
export function segmentAt(sheet, x, y) {
  const within = (f) => x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    for (const run of segmentsOf(a)) {
      const members = a.frames.slice(run.start, run.end)
        .map(e => sheet.frames.find(f => f.id === e.frameId))
        .filter(Boolean);
      if (!members.length || !members.some(within)) continue;
      const x0 = Math.min(...members.map(f => f.x));
      const y0 = Math.min(...members.map(f => f.y));
      const x1 = Math.max(...members.map(f => f.x + f.w));
      const y1 = Math.max(...members.map(f => f.y + f.h));
      return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, frameIds: members.map(f => f.id) };
    }
  }
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (within(f)) return { rect: { x: f.x, y: f.y, w: f.w, h: f.h }, frameIds: [f.id] };
  }
  return null;
}
```

Replace it with:

```js
// Frame objects of one segment run, in animation order (=== spatial order per
// the segment invariant). Skips dangling frameIds defensively.
export function segmentMembers(sheet, anim, run) {
  return anim.frames.slice(run.start, run.end)
    .map(e => sheet.frames.find(f => f.id === e.frameId))
    .filter(Boolean);
}

// Union bounding box of one segment's current member frames.
export function segmentBounds(sheet, anim, run) {
  const members = segmentMembers(sheet, anim, run);
  const x0 = Math.min(...members.map(f => f.x));
  const y0 = Math.min(...members.map(f => f.y));
  const x1 = Math.max(...members.map(f => f.x + f.w));
  const y1 = Math.max(...members.map(f => f.y + f.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// The segment of `anim` (its own frames only -- unlike segmentAt below,
// which searches every animation on the sheet) whose members contain
// (x, y), else null.
export function segmentOfPoint(sheet, anim, x, y) {
  const within = (f) => x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h;
  for (const run of segmentsOf(anim)) {
    if (segmentMembers(sheet, anim, run).some(within)) return run;
  }
  return null;
}

// Movable content under a point, for the move tool: the strip SEGMENT whose
// members contain (x, y) — a sub-strip wins over its parent strip by
// construction — else the topmost plain frame. Returns the bounding rect plus
// the member frame ids (so a float commit can move the frames with the
// pixels), or null when the point hits no frame.
export function segmentAt(sheet, x, y) {
  const within = (f) => x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    const run = segmentOfPoint(sheet, a, x, y);
    if (!run) continue;
    return { rect: segmentBounds(sheet, a, run), frameIds: segmentMembers(sheet, a, run).map(f => f.id) };
  }
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (within(f)) return { rect: { x: f.x, y: f.y, w: f.w, h: f.h }, frameIds: [f.id] };
  }
  return null;
}
```

- [ ] **Step 4: Update `js/ui/frames.js` to import `segmentMembers` instead of defining it locally**

Find:

```js
import { findFreeRect, buildStripFrames, segmentsOf, segmentOfFrame, insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks } from '../core/strips.js';
```

Change to:

```js
import { findFreeRect, buildStripFrames, segmentsOf, segmentOfFrame, segmentMembers, insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks } from '../core/strips.js';
```

Find and delete the now-duplicate local definition:

```js
// Frame objects of one segment run, in animation order (=== spatial order per
// the segment invariant). Skips dangling frameIds defensively.
function segmentMembers(sheet, anim, run) {
  return anim.frames.slice(run.start, run.end)
    .map(e => sheet.frames.find(f => f.id === e.frameId))
    .filter(Boolean);
}

```

(Leave the `boundingBoxOf` function immediately below it untouched — it
operates on a plain frame array, not an `(anim, run)` pair, and stays a
private local helper.)

- [ ] **Step 5: Run tests and syntax-check**

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

Run: `node --input-type=module --check < js/core/strips.js && node --input-type=module --check < js/ui/frames.js`
Expected: no output (syntax OK).

- [ ] **Step 6: Commit**

```bash
git add js/core/strips.js js/ui/frames.js tests/strips.segments.test.mjs
git commit -m "$(cat <<'EOF'
refactor: extract segmentMembers/segmentBounds/segmentOfPoint in strips.js

segmentMembers moves out of frames.js (was a private local duplicate)
so the sheet view's future segment-aware getTargetRect and the move
tool can share it. segmentBounds and segmentOfPoint are new,
single-animation-scoped building blocks segmentAt itself now reuses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `js/app/state.js` — `activeLayerScope`

**Files:**
- Modify: `js/app/state.js` (imports ~line 2; add function after
  `currentContextLayers`, ~line 57)

**Interfaces:**
- Consumes: `layerAnimationContext` (Task 1), `flattenLayers`, `sheetLayers`
  (already exported from `core/model.js`).
- Produces: `activeLayerScope() → Layer[]` — layers to sweep for an "all
  layers" operation, anchored to the **currently active layer's own tree
  position** (via `layerAnimationContext`) rather than
  `state.selectedAnimationId`. Narrows to just that layer's own animation
  group (strip or plain) when nested under one; otherwise every layer on the
  sheet (same root fallback as `currentContextLayers`).

- [ ] **Step 1: Update the `core/model.js` import**

Find:

```js
import { createProject, createSheet, DEFAULT_SETTINGS, findLayer, findNode, sheetLayers, contextLayers as modelContextLayers } from '../core/model.js';
```

Change to:

```js
import { createProject, createSheet, DEFAULT_SETTINGS, findLayer, findNode, sheetLayers, contextLayers as modelContextLayers, flattenLayers, layerAnimationContext } from '../core/model.js';
```

- [ ] **Step 2: Add `activeLayerScope`**

Find:

```js
// Layers visible/editable in the current context. When an animation is
// selected, operations that would otherwise affect "all layers" are scoped to
// the layers inside that animation's group.
export function currentContextLayers() {
  const sheet = activeSheet();
  if (!sheet) return [];
  return modelContextLayers(sheet, state.selectedAnimationId);
}
```

Add immediately after it:

```js
// Layers to sweep for an "all layers" operation (Alt+cut/copy, Alt+drag-
// marquee-move) anchored to the CURRENTLY ACTIVE LAYER's own tree position,
// not state.selectedAnimationId -- so it never disagrees with what's
// actually selected in the layers panel. Narrows to just that layer's own
// animation group (strip or plain) when it's nested under one; otherwise the
// whole sheet, same as currentContextLayers()'s root fallback. See
// docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md.
export function activeLayerScope() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const ctx = layerAnimationContext(sheet, activeLayer());
  return ctx ? flattenLayers(ctx.group) : sheetLayers(sheet);
}
```

- [ ] **Step 3: Syntax check and test suite**

Run: `node --input-type=module --check < js/app/state.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures (this function isn't covered by node's test
suite — it depends on live DOM-free but browser-shaped `state`/`activeSheet`
globals not set up in the unit-test harness; it's exercised in Task 9's
browser verification instead).

- [ ] **Step 4: Commit**

```bash
git add js/app/state.js
git commit -m "$(cat <<'EOF'
feat: add activeLayerScope, layer-position-driven "all layers" resolution

Alt-modifier cut/copy/marquee-move currently resolve "all layers" from
state.selectedAnimationId (the timeline dropdown), which can disagree
with which layer is actually selected in the layers panel. This new
helper resolves from the active layer's own tree position instead.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Painting constraint — segment-aware `getTargetRect` + per-stroke freezing

**Files:**
- Modify: `js/ui/tools.js` (`clampPoint`/`maskOutsideTarget`/`finalize` and
  their call sites, ~line 280-520)
- Modify: `js/app/main.js` (imports ~line 1, 4; `bindDrawing` call, ~line
  397-400)

**Interfaces:**
- `getTargetRect` (the callback passed into `bindDrawing`) gains an optional
  `(x, y)` — the point of interest. Existing callbacks (frame editor, tile
  editor) that ignore extra arguments are unaffected.
- Produces (main.js): a named `sheetTargetRect(x, y)` function replacing the
  inline arrow currently passed to `bindDrawing`.
- `clampPoint`/`maskOutsideTarget`/`finalize` (tools.js, private to
  `bindDrawing`) gain a required explicit `target` parameter instead of each
  calling `getTargetRect()` internally — resolved once per stroke at
  `handleDown` and threaded through `handleMove`/`handleUp` via the `stroke`
  object, mirroring how `selStroke.target` already works for the select
  tool.

- [ ] **Step 1: Freeze `clampPoint`/`maskOutsideTarget`/`finalize` on an explicit `target` param**

In `js/ui/tools.js`, find:

```js
  // Clamp an image-space point into getTargetRect(); null when the target is
  // empty (no sheet). Live drawing pre-masks coordinates with this so strokes
  // cannot start or extend outside the editable rect.
  function clampPoint(x, y) {
    const t = getTargetRect();
    if (t.w <= 0 || t.h <= 0) return null;
    return {
      x: Math.max(t.x, Math.min(t.x + t.w - 1, x)),
      y: Math.max(t.y, Math.min(t.y + t.h - 1, y)),
    };
  }

  // Restore `before` pixels outside the target rect within the given step
  // bounds. Catches writes that coordinate clamping alone cannot prevent
  // (brush stamps overflow up to brushSize-1 px past a clamped coordinate;
  // select-move can drag content past the target edge).
  function maskOutsideTarget(bitmap, before, x0, y0, x1, y1) {
    const t = getTargetRect();
    const bx0 = Math.max(0, x0), by0 = Math.max(0, y0);
```

Replace the two function signatures (leave `maskOutsideTarget`'s body below
`const t = getTargetRect();` untouched):

```js
  // Clamp an image-space point into `target`; null when the target is empty
  // (no sheet, or outside any paintable segment). Live drawing pre-masks
  // coordinates with this so strokes cannot start or extend outside the
  // editable rect. `target` is resolved ONCE per stroke at handleDown and
  // threaded through explicitly (not re-queried via getTargetRect() on every
  // event) so a strip with multiple segments can't "flicker" mid-drag if the
  // pointer strays near another segment -- mirrors how the select tool
  // already freezes `selStroke.target` once at handleSelectDown.
  function clampPoint(x, y, target) {
    if (target.w <= 0 || target.h <= 0) return null;
    return {
      x: Math.max(target.x, Math.min(target.x + target.w - 1, x)),
      y: Math.max(target.y, Math.min(target.y + target.h - 1, y)),
    };
  }

  // Restore `before` pixels outside `target` within the given step bounds.
  // Catches writes that coordinate clamping alone cannot prevent (brush
  // stamps overflow up to brushSize-1 px past a clamped coordinate;
  // select-move can drag content past the target edge).
  function maskOutsideTarget(bitmap, before, x0, y0, x1, y1, target) {
    const t = target;
    const bx0 = Math.max(0, x0), by0 = Math.max(0, y0);
```

Now find `finalize`:

```js
  function finalize(layer, before, dirty, label) {
    if (!dirty) return;
    const bmp = layer.bitmap;
    // full extent the stroke may have touched, clamped to bitmap bounds only
    const fx0 = Math.max(dirty.minX, 0), fy0 = Math.max(dirty.minY, 0);
    const fx1 = Math.min(dirty.maxX, bmp.width - 1), fy1 = Math.min(dirty.maxY, bmp.height - 1);
    if (fx1 < fx0 || fy1 < fy0) return;
    const target = getTargetRect();
    const x0 = Math.max(fx0, target.x);
```

Replace the signature and drop the internal `getTargetRect()` call:

```js
  function finalize(layer, before, dirty, label, target) {
    if (!dirty) return;
    const bmp = layer.bitmap;
    // full extent the stroke may have touched, clamped to bitmap bounds only
    const fx0 = Math.max(dirty.minX, 0), fy0 = Math.max(dirty.minY, 0);
    const fx1 = Math.min(dirty.maxX, bmp.width - 1), fy1 = Math.min(dirty.maxY, bmp.height - 1);
    if (fx1 < fx0 || fy1 < fy0) return;
    const x0 = Math.max(fx0, target.x);
```

- [ ] **Step 2: Thread `target` through `handleDown`/`handleMove`/`handleUp`**

Find:

```js
    if (tool === 'fill') {
      // only act when the seed is inside the target; flood a copy of the
      // target region so the fill cannot leak outside it
      const t = getTargetRect();
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const r = floodFill(sub, ev.x - t.x, ev.y - t.y, color, toolOptions.contiguous);
      let dirty = null;
      if (r) {
        blitRegion(layer.bitmap, sub, t.x, t.y);
        dirty = extend(null, t.x + r.x, t.y + r.y, t.x + r.x + r.w - 1, t.y + r.y + r.h - 1);
      }
      finalize(layer, before, dirty, 'fill');
      stroke = null;
      emit('pixels');
      return;
    }
    if (BRUSH_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y);
      if (!p) return;
      drawLine(layer.bitmap, p.x, p.y, p.x, p.y, color, state.brushSize);
      maskOutsideTarget(layer.bitmap, before, p.x, p.y, p.x + state.brushSize - 1, p.y + state.brushSize - 1);
      const dirty = extend(null, p.x, p.y, p.x + state.brushSize - 1, p.y + state.brushSize - 1);
      stroke = { tool, layer, before, color, dirty, last: p };
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y);
      if (!p) return;
      // filled shapes: outline in the pressed button's color, interior in the
      // opposite swatch (left = primary outline / secondary fill, right = swapped)
      const fill = (tool !== 'line' && toolOptions.filled) ? currentColor(ev, true) : null;
      stroke = { tool, layer, before, color, fill, dirty: null, anchor: p };
      emit('pixels');
      return;
    }
  }
```

Replace with:

```js
    if (tool === 'fill') {
      // only act when the seed is inside the target; flood a copy of the
      // target region so the fill cannot leak outside it
      const t = getTargetRect(ev.x, ev.y);
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const r = floodFill(sub, ev.x - t.x, ev.y - t.y, color, toolOptions.contiguous);
      let dirty = null;
      if (r) {
        blitRegion(layer.bitmap, sub, t.x, t.y);
        dirty = extend(null, t.x + r.x, t.y + r.y, t.x + r.x + r.w - 1, t.y + r.y + r.h - 1);
      }
      finalize(layer, before, dirty, 'fill', t);
      stroke = null;
      emit('pixels');
      return;
    }
    if (BRUSH_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      drawLine(layer.bitmap, p.x, p.y, p.x, p.y, color, state.brushSize);
      maskOutsideTarget(layer.bitmap, before, p.x, p.y, p.x + state.brushSize - 1, p.y + state.brushSize - 1, target);
      const dirty = extend(null, p.x, p.y, p.x + state.brushSize - 1, p.y + state.brushSize - 1);
      stroke = { tool, layer, before, color, dirty, last: p, target };
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      // filled shapes: outline in the pressed button's color, interior in the
      // opposite swatch (left = primary outline / secondary fill, right = swapped)
      const fill = (tool !== 'line' && toolOptions.filled) ? currentColor(ev, true) : null;
      stroke = { tool, layer, before, color, fill, dirty: null, anchor: p, target };
      emit('pixels');
      return;
    }
  }
```

Find:

```js
  function handleMove(ev) {
    if (!stroke) return;
    const { tool, layer, before, color } = stroke;
    if (BRUSH_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y);
      if (!p) return;
      const last = stroke.last;
      drawLine(layer.bitmap, last.x, last.y, p.x, p.y, color, state.brushSize);
      const sx0 = Math.min(last.x, p.x), sy0 = Math.min(last.y, p.y);
      const sx1 = Math.max(last.x, p.x) + state.brushSize - 1;
      const sy1 = Math.max(last.y, p.y) + state.brushSize - 1;
      maskOutsideTarget(layer.bitmap, before, sx0, sy0, sx1, sy1);
      stroke.dirty = extend(stroke.dirty, sx0, sy0, sx1, sy1);
      stroke.last = p;
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y);
      if (!p) return;
      blitRegion(layer.bitmap, before, 0, 0);
      const a = stroke.anchor;
      if (tool === 'line') {
        drawLine(layer.bitmap, a.x, a.y, p.x, p.y, color, state.brushSize);
        const sx1 = Math.max(a.x, p.x) + state.brushSize - 1;
        const sy1 = Math.max(a.y, p.y) + state.brushSize - 1;
        maskOutsideTarget(layer.bitmap, before, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1);
      } else if (tool === 'rect') {
```

Replace the two `clampPoint(ev.x, ev.y)` calls and the brush-tool
`maskOutsideTarget` call:

```js
  function handleMove(ev) {
    if (!stroke) return;
    const { tool, layer, before, color } = stroke;
    if (BRUSH_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      const last = stroke.last;
      drawLine(layer.bitmap, last.x, last.y, p.x, p.y, color, state.brushSize);
      const sx0 = Math.min(last.x, p.x), sy0 = Math.min(last.y, p.y);
      const sx1 = Math.max(last.x, p.x) + state.brushSize - 1;
      const sy1 = Math.max(last.y, p.y) + state.brushSize - 1;
      maskOutsideTarget(layer.bitmap, before, sx0, sy0, sx1, sy1, stroke.target);
      stroke.dirty = extend(stroke.dirty, sx0, sy0, sx1, sy1);
      stroke.last = p;
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      blitRegion(layer.bitmap, before, 0, 0);
      const a = stroke.anchor;
      if (tool === 'line') {
        drawLine(layer.bitmap, a.x, a.y, p.x, p.y, color, state.brushSize);
        const sx1 = Math.max(a.x, p.x) + state.brushSize - 1;
        const sy1 = Math.max(a.y, p.y) + state.brushSize - 1;
        maskOutsideTarget(layer.bitmap, before, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1, stroke.target);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1);
      } else if (tool === 'rect') {
```

Find:

```js
  function handleUp(ev) {
    if (!stroke) return;
    handleMove(ev); // commit final pointer position (handles click-without-move too)
    const { tool, layer, before, dirty } = stroke;
    finalize(layer, before, dirty, tool);
    stroke = null;
  }
```

Replace with:

```js
  function handleUp(ev) {
    if (!stroke) return;
    handleMove(ev); // commit final pointer position (handles click-without-move too)
    const { tool, layer, before, dirty, target } = stroke;
    finalize(layer, before, dirty, tool, target);
    stroke = null;
  }
```

- [ ] **Step 3: Thread the down-point into the select tool's `getTargetRect` call**

Find:

```js
  function handleSelectDown(ev) {
    acceptFloatingContextIfAny();
    if (!activeLayer()) return;
    const target = getTargetRect();
```

Replace with:

```js
  function handleSelectDown(ev) {
    acceptFloatingContextIfAny();
    if (!activeLayer()) return;
    const target = getTargetRect(ev.x, ev.y);
```

- [ ] **Step 4: Syntax check `tools.js`**

Run: `node --input-type=module --check < js/ui/tools.js`
Expected: no output (syntax OK). Full behavior is only exercised once
`getTargetRect` becomes segment-aware in the next step — this step alone is
a behavior-preserving refactor (every call site still resolves the same
whole-sheet rect as before, just threaded explicitly instead of re-queried).

- [ ] **Step 5: Make the sheet view's `getTargetRect` segment-aware**

In `js/app/main.js`, find:

```js
import { state, on, emit, activeSheet, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty } from './state.js';
import * as io from './io.js';
import { decodePng } from './pngcodec.js';
import { flattenSheet, createSheet, sheetLayers } from '../core/model.js';
```

Change to:

```js
import { state, on, emit, activeSheet, activeLayer, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty } from './state.js';
import * as io from './io.js';
import { decodePng } from './pngcodec.js';
import { flattenSheet, createSheet, sheetLayers, layerAnimationContext } from '../core/model.js';
import { segmentsOf, segmentOfFrame, segmentOfPoint, segmentBounds } from '../core/strips.js';
```

Find:

```js
// ---- drawing tools + panels ----
mountToolPalette(document.getElementById('tool-panel'));
bindDrawing(canvasView, () => {
  const sheet = activeSheet();
  return sheet ? { x: 0, y: 0, w: sheet.width, h: sheet.height } : { x: 0, y: 0, w: 0, h: 0 };
});
```

Replace with:

```js
// The sheet view's paint/float/paste target: normally the whole sheet, but
// narrowed to the current SEGMENT of an accepted strip's own frames when the
// active layer belongs to one (see docs/superpowers/specs/2026-07-18-strip-
// area-constraint-design.md) -- painting/copy/paste/move on a strip's own
// layer must never touch pixels outside the area its own frames occupy.
// `x, y` is the point of interest (a stroke's down-point, a marquee/frame-
// float's anchor corner, or a paste's original source position) -- when
// omitted (pasting from the OS clipboard, with no natural anchor), falls
// back to the segment of the currently selected frame, else the strip's
// first segment.
function sheetTargetRect(x, y) {
  const sheet = activeSheet();
  if (!sheet) return { x: 0, y: 0, w: 0, h: 0 };
  const whole = { x: 0, y: 0, w: sheet.width, h: sheet.height };
  const ctx = layerAnimationContext(sheet, activeLayer());
  if (!ctx?.anim.strip) return whole;
  const { anim } = ctx;
  let run = (x != null && y != null) ? segmentOfPoint(sheet, anim, x, y)
    : state.selectedFrameId ? segmentOfFrame(anim, state.selectedFrameId) : null;
  if (!run && x == null && y == null) run = segmentsOf(anim)[0] ?? null;
  return run ? segmentBounds(sheet, anim, run) : { x: 0, y: 0, w: 0, h: 0 };
}

// ---- drawing tools + panels ----
mountToolPalette(document.getElementById('tool-panel'));
bindDrawing(canvasView, sheetTargetRect);
```

- [ ] **Step 6: Syntax check and test suite**

Run: `node --input-type=module --check < js/app/main.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add js/ui/tools.js js/app/main.js
git commit -m "$(cat <<'EOF'
feat: constrain painting on an accepted strip's layer to its own segment

bindDrawing's target rect is now resolved once per stroke (frozen,
matching how the select tool already works) instead of re-queried on
every pointer event, and the sheet view's getTargetRect narrows to the
current segment of an accepted strip's own frames when the active
layer belongs to one -- every paint tool (pencil, eraser, fill, line,
rect, ellipse) and the select-tool marquee inherit the constraint for
free through the existing getTargetRect plumbing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `js/ui/floatsession.js` — anchor threading + explicit layer override + Alt-modifier scoping fix

**Files:**
- Modify: `js/ui/floatsession.js` (imports ~line 7; `resolveRegion` ~line
  38-45; `captureLayers` ~line 47-53; `createFloat` ~line 69-83;
  `pasteClipboard` ~line 340-348)

**Interfaces:**
- Produces: `resolveRegion(viewApi, requireSelection, anchor)` — gains a
  third optional `anchor: {x, y} | null` param, used as the point passed to
  `getTargetRect` instead of calling it with no arguments; falls back to the
  current selection's own position when no explicit anchor is given.
- Produces: `captureLayers(sheet, region, allLayers, explicitLayers)` —
  gains a fourth optional param; when given, it's used verbatim instead of
  resolving from `allLayers`. `allLayers` now resolves through the new
  `activeLayerScope()` (Task 3) instead of `currentContextLayers()`.
- Produces: `createFloat({ allLayers, region, frameIds, layers, x, y })` —
  gains `layers` (explicit override, threaded to `captureLayers`) and `x, y`
  (fallback anchor point when there's no `region`/selection to derive one
  from).
- Consumes: `activeLayerScope` (Task 3, replaces `currentContextLayers` in
  this file's import from `../app/state.js`).

- [ ] **Step 1: Swap the `state.js` import**

Find:

```js
import { state, on, emit, activeSheet, activeLayer, markDirty, currentContextLayers } from '../app/state.js';
```

Change to:

```js
import { state, on, emit, activeSheet, activeLayer, markDirty, activeLayerScope } from '../app/state.js';
```

- [ ] **Step 2: Update `resolveRegion` to accept and use an anchor point**

Find:

```js
// region + frozen target for float/cut/copy: the view's selection clamped to
// its target rect, or the whole target rect when there is no selection
function resolveRegion(viewApi, requireSelection = false) {
  const target = viewApi.getTargetRect();
  if (target.w <= 0 || target.h <= 0) return null;
  const sel = viewApi.getSelection();
  if (!sel) return requireSelection ? null : { region: { ...target }, target };
  const region = rectIntersect(sel, target);
  return region ? { region, target } : null;
}
```

Replace with:

```js
// region + frozen target for float/cut/copy: the view's selection clamped to
// its target rect, or the whole target rect when there is no selection.
// `anchor` is the point passed to getTargetRect() to resolve which segment
// of an accepted strip applies (see docs/superpowers/specs/2026-07-18-
// strip-area-constraint-design.md) -- callers with a more specific point
// than the current selection (e.g. createFloat's frame-segment region) pass
// it explicitly; otherwise this falls back to the selection's own corner.
function resolveRegion(viewApi, requireSelection = false, anchor = null) {
  const sel = viewApi.getSelection();
  const point = anchor ?? (sel ? { x: sel.x, y: sel.y } : null);
  const target = viewApi.getTargetRect(point?.x, point?.y);
  if (target.w <= 0 || target.h <= 0) return null;
  if (!sel) return requireSelection ? null : { region: { ...target }, target };
  const region = rectIntersect(sel, target);
  return region ? { region, target } : null;
}
```

Note: `clipboardCapture` (cut/copy) calls `resolveRegion(viewApi, true)`
with no explicit anchor — it needs no change, since `resolveRegion` now
derives the anchor from the active selection automatically.

- [ ] **Step 3: `captureLayers` — explicit layers override + `activeLayerScope`**

Find:

```js
function captureLayers(sheet, region, allLayers) {
  const layers = allLayers ? currentContextLayers() : (activeLayer() ? [activeLayer()] : []);
  return layers.map(l => ({
    layerId: l.id,
    buffer: copyRegion(l.bitmap, region.x, region.y, region.w, region.h),
  }));
}
```

Replace with:

```js
function captureLayers(sheet, region, allLayers, explicitLayers = null) {
  const layers = explicitLayers ?? (allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []));
  return layers.map(l => ({
    layerId: l.id,
    buffer: copyRegion(l.bitmap, region.x, region.y, region.w, region.h),
  }));
}
```

- [ ] **Step 4: `createFloat` — explicit layers + anchor point**

Find:

```js
export function createFloat({ allLayers = false, region = null, frameIds = null } = {}) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return false;
  const rr = resolveRegion(viewApi);
  if (!rr) return false;
  let { region: reg, target } = rr;
  const frameFloat = !!(region && frameIds && !viewApi.getSelection());
  if (frameFloat) {
    const clamped = rectIntersect(region, target);
    if (!clamped) return false;
    reg = clamped;
  }
  const captured = captureLayers(sheet, reg, allLayers);
  if (!captured.length) return false;
```

Replace with:

```js
export function createFloat({ allLayers = false, region = null, frameIds = null, layers: explicitLayers = null, x = null, y = null } = {}) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return false;
  const anchor = region ? { x: region.x, y: region.y } : (x != null ? { x, y } : null);
  const rr = resolveRegion(viewApi, false, anchor);
  if (!rr) return false;
  let { region: reg, target } = rr;
  const frameFloat = !!(region && frameIds && !viewApi.getSelection());
  if (frameFloat) {
    const clamped = rectIntersect(region, target);
    if (!clamped) return false;
    reg = clamped;
  }
  const captured = captureLayers(sheet, reg, allLayers, explicitLayers);
  if (!captured.length) return false;
```

(The doc comment immediately above `createFloat` — "region/frameIds: the
move tool passes these when the drag starts on a frame or strip segment..."
— stays accurate as-is; no change needed.)

- [ ] **Step 5: `pasteClipboard` — anchor from the original copy position**

Find:

```js
export function pasteClipboard() {
  if (!clipboard) return;
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const target = viewApi.getTargetRect();
  if (target.w <= 0 || target.h <= 0) return;
  const { srcRect } = clipboard;
```

Replace with:

```js
export function pasteClipboard() {
  if (!clipboard) return;
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const { srcRect } = clipboard;
  // Anchor the confinement lookup at the ORIGINAL copy position -- pasting
  // back into the same strip segment it was copied from is the common case,
  // and more precise than falling back to the currently selected frame.
  const target = viewApi.getTargetRect(srcRect.x, srcRect.y);
  if (target.w <= 0 || target.h <= 0) return;
```

- [ ] **Step 6: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/floatsession.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add js/ui/floatsession.js
git commit -m "$(cat <<'EOF'
feat: confine float/paste commits to the resolved segment; fix Alt-scope

createFloat/resolveRegion now thread an anchor point through to
getTargetRect (the drag's down-point, a frame-segment's own corner, a
paste's original source position) so the EXISTING commit-time
confinement (ctx.targetRect, checked in commitFloatIfAny) picks up the
new segment-aware target for free -- drag, cut, and paste all land
inside the active strip's segment, matching the paint constraint.
Alt+cut/copy and Alt+drag-marquee-move's "all layers" now resolve via
activeLayerScope (the active layer's own tree position) instead of
state.selectedAnimationId, so they can't silently disagree with what's
selected in the layers panel.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `js/ui/tools.js` — move tool's frame-segment drag resolves the dragged strip's own layers

**Files:**
- Modify: `js/ui/tools.js` (imports ~line 14, 22-25; `handleMoveDown`'s
  segment branch ~line 646-656)

**Interfaces:**
- Consumes: `stripOf` (exported from `js/ui/frames.js`, already imported
  into `tools.js` alongside `commitAcceptAnimation`), `animationGroup`,
  `flattenLayers` (`core/model.js`), `createFloat`'s new `layers`/`x`/`y`
  params (Task 5).
- No new exports.

- [ ] **Step 1: Add the needed imports**

Find:

```js
import { flattenSheet } from '../core/model.js';
import { segmentAt } from '../core/strips.js';
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat } from './floatsession.js';
import { commitAcceptAnimation } from './frames.js';
```

Change to:

```js
import { flattenSheet, animationGroup, flattenLayers } from '../core/model.js';
import { segmentAt } from '../core/strips.js';
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat } from './floatsession.js';
import { commitAcceptAnimation, stripOf } from './frames.js';
```

- [ ] **Step 2: Resolve the dragged segment's owning strip's own layers explicitly**

Find:

```js
    // No float yet. On the sheet view with no marquee, a down on a frame or
    // strip segment starts a FRAME-FLOAT: the region's pixels (all layers)
    // float exactly like a selection — live preview, commit on Enter/outside
    // click — but translate-only, and on commit the frame rects move with
    // the pixels. Everything else keeps the classic behavior: cut the
    // selection (or whole target) and drag it.
    if (state.view === 'sheet' && !selection) {
      const seg = segmentAt(sheet, ev.x, ev.y);
      if (seg) {
        if (!createFloat({ allLayers: true, region: seg.rect, frameIds: seg.frameIds })) return;
        moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
    }
    if (!createFloat({ allLayers: !!ev.altKey })) return;
    moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
  }
```

Replace with:

```js
    // No float yet. On the sheet view with no marquee, a down on a frame or
    // strip segment starts a FRAME-FLOAT: the region's pixels float exactly
    // like a selection — live preview, commit on Enter/outside click — but
    // translate-only, and on commit the frame rects move with the pixels.
    // Everything else keeps the classic behavior: cut the selection (or
    // whole target) and drag it.
    if (state.view === 'sheet' && !selection) {
      const seg = segmentAt(sheet, ev.x, ev.y);
      if (seg) {
        // An accepted strip's own segment carries only ITS OWN layer(s) --
        // resolved from the segment's owning strip, never from whatever's
        // ambiently selected in the timeline (see docs/superpowers/specs/
        // 2026-07-18-strip-area-constraint-design.md). A floating strip or a
        // plain frame has no strip-owned layer to resolve, so falls back to
        // today's ambient allLayers:true capture.
        const owner = stripOf(sheet, seg.frameIds[0]);
        const ownGroup = owner?.layerGroupId ? animationGroup(sheet, owner.id) : null;
        const layers = ownGroup ? flattenLayers(ownGroup) : null;
        if (!createFloat({ allLayers: true, region: seg.rect, frameIds: seg.frameIds, layers, x: ev.x, y: ev.y })) return;
        moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
    }
    if (!createFloat({ allLayers: !!ev.altKey, x: ev.x, y: ev.y })) return;
    moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
  }
```

- [ ] **Step 3: Verify the `frames.js` ↔ `tools.js` circular import still resolves cleanly**

`tools.js` already imports `commitAcceptAnimation` from `./frames.js`
(established and verified safe in an earlier feature); this step just adds
one more named import (`stripOf`) from the same already-circular edge, so no
new risk, but confirm in-browser per that precedent:

```bash
python -m http.server 8833 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8833/index.html
```

Expected: `200`. Then navigate to `http://localhost:8833/index.html?autotest`
with the Playwright MCP tools and check
`mcp__plugin_playwright_playwright__browser_console_messages` at
`level: "warning"` with `all: true`.
Expected: `Total messages: 0 (Errors: 0, Warnings: 0)`. Stop the server
afterward.

- [ ] **Step 4: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/tools.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add js/ui/tools.js
git commit -m "$(cat <<'EOF'
feat: move tool's frame-segment drag resolves the dragged strip's own layers

Previously resolved via currentContextLayers() (state.selectedAnimationId,
the timeline dropdown), which could disagree with the strip actually
being dragged. Now resolved directly from the segment's owning strip.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `js/ui/frames.js` — pixel-carrying frame-tool drag

**Files:**
- Modify: `js/ui/frames.js` (imports ~line 16; new `stripLayersOf` helper
  and `commitMoveFramesWithPixels`, after `commitMoveFrames` ~line 241;
  `handleUp`'s `d.kind === 'move'` branch ~line 663-672; `buildMovePatches`
  ~line 208-227 and its two other call sites in `commitInsertFrame` ~line
  346 and `commitRemoveMember` ~line 495)

**Interfaces:**
- Produces: `stripLayersOf(sheet, anim) → Layer[] | null` — the accepted
  strip's own layers to move pixels on; `null` when `anim` is `null` (a
  single plain frame, not part of an intact strip) or floating (no layer
  yet), meaning the caller falls back to its own pre-existing behavior.
- Produces: `commitMoveFramesWithPixels(sheet, frames, dx, dy, layers)` —
  pixel-carrying counterpart to `commitMoveFrames`, reusing
  `buildMovePatches`'s eager copy/clear/blit.
- Modifies: `buildMovePatches(sheet, frames, dx, dy, layers =
  currentContextLayers())` — gains an explicit `layers` parameter.

- [ ] **Step 1: Add `flattenLayers` to the `core/model.js` import**

Find:

```js
import { addFrame, removeFrame, addAnimation, renameAnimation, animationGroup, acceptAnimation } from '../core/model.js';
```

Change to:

```js
import { addFrame, removeFrame, addAnimation, renameAnimation, animationGroup, acceptAnimation, flattenLayers } from '../core/model.js';
```

- [ ] **Step 2: `buildMovePatches` gains an explicit `layers` parameter**

Find:

```js
function buildMovePatches(sheet, frames, dx, dy) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const patches = currentContextLayers().map((layer) => {
```

Change to:

```js
function buildMovePatches(sheet, frames, dx, dy, layers = currentContextLayers()) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const patches = layers.map((layer) => {
```

- [ ] **Step 3: Add `stripLayersOf` and `commitMoveFramesWithPixels`**

Find:

```js
// Metadata-only move: frames are viewports onto the sheet, so dragging them
// with the frame tool never moves or clears pixels — exactly like dragging a
// selection marquee. Use the move tool to move the underlying content.
function commitMoveFrames(sheet, frames, dx, dy) {
  const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const cmd = {
    label: frames.length > 1 ? 'move strip' : 'move frame',
    do() { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
    undo() { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } },
  };
  state.commands.push(cmd);
  markDirty();
}
```

Replace with:

```js
// Metadata-only move: frames are viewports onto the sheet, so dragging a
// PLAIN frame or a still-FLOATING strip with the frame tool never moves or
// clears pixels. An ACCEPTED strip's own frames use
// commitMoveFramesWithPixels below instead -- see stripLayersOf's callers.
function commitMoveFrames(sheet, frames, dx, dy) {
  const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const cmd = {
    label: frames.length > 1 ? 'move strip' : 'move frame',
    do() { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
    undo() { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } },
  };
  state.commands.push(cmd);
  markDirty();
}

// The accepted strip's own layers to move pixels on when repositioning
// `anim`'s frames -- null when `anim` is null (a single plain frame, not
// part of an intact strip) or floating (no layer yet), meaning the caller
// falls back to its own pre-existing metadata-only behavior. See
// docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md.
function stripLayersOf(sheet, anim) {
  if (!anim?.strip || !anim.layerGroupId) return null;
  const group = animationGroup(sheet, anim.id);
  return group ? flattenLayers(group) : null;
}

// Pixel-carrying counterpart to commitMoveFrames, for frames belonging to an
// ACCEPTED strip: reuses buildMovePatches's eager copy/clear/blit (already
// used by commitInsertFrame/commitRemoveMember's tail-shift below) so the
// strip's own layers move together with its frames, instead of leaving
// pixels behind at the old position.
function commitMoveFramesWithPixels(sheet, frames, dx, dy, layers) {
  const { patches, ur, beforeCoords, afterCoords } = buildMovePatches(sheet, frames, dx, dy, layers);
  const cmd = {
    label: frames.length > 1 ? 'move strip' : 'move frame',
    do() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, ur.x, ur.y);
      for (const c of afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
    undo() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, ur.x, ur.y);
      for (const c of beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
  };
  state.commands.push(cmd);
  markDirty();
}
```

- [ ] **Step 4: Use it at the frame-tool drag's `handleUp` call site**

Find:

```js
  if (d.kind === 'move') {
    if (d.snap) { commitMergeSegments(sheet, d, d.snap); return; }
    // Clamp the common delta so the whole bounding box (single frame or
    // every strip member) stays fully on-sheet — no pixels are silently
    // clipped by out-of-bounds copy/blit (pixels.js bounds-checks every
    // write/read).
    const dx = Math.max(-d.bbox.x, Math.min(sheet.width - (d.bbox.x + d.bbox.w), d.delta.dx));
    const dy = Math.max(-d.bbox.y, Math.min(sheet.height - (d.bbox.y + d.bbox.h), d.delta.dy));
    if (dx !== 0 || dy !== 0) commitMoveFrames(sheet, d.members, dx, dy);
    return;
  }
```

Replace with:

```js
  if (d.kind === 'move') {
    if (d.snap) { commitMergeSegments(sheet, d, d.snap); return; }
    // Clamp the common delta so the whole bounding box (single frame or
    // every strip member) stays fully on-sheet — no pixels are silently
    // clipped by out-of-bounds copy/blit (pixels.js bounds-checks every
    // write/read).
    const dx = Math.max(-d.bbox.x, Math.min(sheet.width - (d.bbox.x + d.bbox.w), d.delta.dx));
    const dy = Math.max(-d.bbox.y, Math.min(sheet.height - (d.bbox.y + d.bbox.h), d.delta.dy));
    if (dx !== 0 || dy !== 0) {
      const layers = stripLayersOf(sheet, d.anim);
      if (layers) commitMoveFramesWithPixels(sheet, d.members, dx, dy, layers);
      else commitMoveFrames(sheet, d.members, dx, dy);
    }
    return;
  }
```

- [ ] **Step 5: Scope `commitInsertFrame`/`commitRemoveMember`'s tail-shift to the strip's own layers too**

Both already receive `anim` as a parameter, so both can resolve the same
way instead of falling back to ambient `currentContextLayers()`.

Find (inside `commitInsertFrame`):

```js
  const tail = members.slice(k);
  const mv = tail.length ? buildMovePatches(sheet, tail, fw, 0) : null;
```

Change to:

```js
  const tail = members.slice(k);
  const mv = tail.length ? buildMovePatches(sheet, tail, fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
```

Find (inside `commitRemoveMember`):

```js
  const tail = members.slice(k + 1);
  const mv = tail.length ? buildMovePatches(sheet, tail, -fw, 0) : null;
```

Change to:

```js
  const tail = members.slice(k + 1);
  const mv = tail.length ? buildMovePatches(sheet, tail, -fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
```

- [ ] **Step 6: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/frames.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add js/ui/frames.js
git commit -m "$(cat <<'EOF'
feat: frame-tool drag carries an accepted strip's own pixels

commitMoveFrames stays metadata-only for plain frames and floating
strips; an accepted strip's own frames now use the new
commitMoveFramesWithPixels, reusing buildMovePatches's existing
eager-move machinery scoped to that strip's own layers -- so dragging
a strip's frames with the frame tool no longer orphans its pixels at
the old position. commitInsertFrame/commitRemoveMember's tail-shifts
are scoped the same way instead of ambient currentContextLayers().

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `js/ui/frames.js` — restrict merging to the same strip; make it pixel-carrying

**Files:**
- Modify: `js/ui/frames.js` (`findSnap` ~line 124-152, `commitMergeSegments`
  ~line 247-292)

**Interfaces:**
- `findSnap(view, sheet, drag)` — now only considers segments belonging to
  `drag.anim` itself; cross-animation snap candidates are never found. Same
  return shape (`{anim, run, side, dx, dy, err} | null`), but `anim` is
  always `=== drag.anim` now.
- `commitMergeSegments(sheet, d, snap)` — same signature/behavior, but now
  moves the pixel content of `d.members` when `srcAnim` is an accepted
  strip, using `stripLayersOf`/`buildMovePatches` (Task 7).

- [ ] **Step 1: Restrict `findSnap` to the dragged strip's own segments**

Find:

```js
// While dragging a segment, find the best end-to-end join: dragged RIGHT edge
// to a target's LEFT edge (side 'before' — dragged frames come first) or
// dragged LEFT edge to a target's RIGHT edge (side 'after'). Same frame w/h
// required; snapped position must stay on-sheet.
function findSnap(view, sheet, drag) {
  const d = drag.bbox;
  const fw = drag.members[0].w, fh = drag.members[0].h;
  const tol = SNAP_SCREEN_PX / view.zoom;
  const gx = d.x + drag.delta.dx, gy = d.y + drag.delta.dy;
  let best = null;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    for (const run of segmentsOf(a)) {
      if (a === drag.anim && run.index === drag.run.index) continue;
      const members = segmentMembers(sheet, a, run);
      if (!members.length || members[0].w !== fw || members[0].h !== fh) continue;
      const t = boundingBoxOf(members);
      const cands = [
        { side: 'before', dx: t.x - d.w - d.x, dy: t.y - d.y,
          err: Math.hypot(gx + d.w - t.x, gy - t.y) },
        { side: 'after', dx: t.x + t.w - d.x, dy: t.y - d.y,
          err: Math.hypot(gx - (t.x + t.w), gy - t.y) },
      ];
      for (const c of cands) {
        if (c.err > tol) continue;
        if (d.x + c.dx < 0 || d.x + c.dx + d.w > sheet.width) continue;
        if (d.y + c.dy < 0 || d.y + c.dy + d.h > sheet.height) continue;
        if (!best || c.err < best.err) best = { anim: a, run, side: c.side, dx: c.dx, dy: c.dy, err: c.err };
      }
    }
  }
  return best;
}
```

Replace with:

```js
// While dragging a segment, find the best end-to-end join WITHIN THE SAME
// overall strip only -- merging across different strip animations is
// disabled for now (see docs/superpowers/specs/2026-07-18-strip-area-
// constraint-design.md): dragged RIGHT edge to a target's LEFT edge (side
// 'before' — dragged frames come first) or dragged LEFT edge to a target's
// RIGHT edge (side 'after'). Same frame w/h required; snapped position must
// stay on-sheet. Only called when drag.anim is truthy (see handleMove).
function findSnap(view, sheet, drag) {
  const d = drag.bbox;
  const fw = drag.members[0].w, fh = drag.members[0].h;
  const tol = SNAP_SCREEN_PX / view.zoom;
  const gx = d.x + drag.delta.dx, gy = d.y + drag.delta.dy;
  let best = null;
  for (const run of segmentsOf(drag.anim)) {
    if (run.index === drag.run.index) continue;
    const members = segmentMembers(sheet, drag.anim, run);
    if (!members.length || members[0].w !== fw || members[0].h !== fh) continue;
    const t = boundingBoxOf(members);
    const cands = [
      { side: 'before', dx: t.x - d.w - d.x, dy: t.y - d.y,
        err: Math.hypot(gx + d.w - t.x, gy - t.y) },
      { side: 'after', dx: t.x + t.w - d.x, dy: t.y - d.y,
        err: Math.hypot(gx - (t.x + t.w), gy - t.y) },
    ];
    for (const c of cands) {
      if (c.err > tol) continue;
      if (d.x + c.dx < 0 || d.x + c.dx + d.w > sheet.width) continue;
      if (d.y + c.dy < 0 || d.y + c.dy + d.h > sheet.height) continue;
      if (!best || c.err < best.err) best = { anim: drag.anim, run, side: c.side, dx: c.dx, dy: c.dy, err: c.err };
    }
  }
  return best;
}
```

- [ ] **Step 2: Make `commitMergeSegments` pixel-carrying**

Find:

```js
function commitMergeSegments(sheet, d, snap) {
  const srcAnim = d.anim, dstAnim = snap.anim;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: state.selectedAnimationId,
  };
  const coords = d.members.map(f => ({ frame: f, x: f.x, y: f.y }));
  for (const f of d.members) { f.x += snap.dx; f.y += snap.dy; }
  if (sameAnim) {
    const r = mergeSegments(srcAnim, d.run.index, snap.run.index, snap.side);
    srcAnim.frames = r.frames; srcAnim.breaks = r.breaks;
  } else {
    const r = transferSegment(srcAnim, dstAnim, d.run.index, snap.run.index, snap.side);
    srcAnim.frames = r.src.frames; srcAnim.breaks = r.src.breaks;
    dstAnim.frames = r.dst.frames; dstAnim.breaks = r.dst.breaks;
    if (srcAnim.frames.length === 0)
      sheet.animations = sheet.animations.filter(a => a !== srcAnim);
  }
  const after = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: srcAnim.breaks.slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: dstAnim.breaks.slice(),
    animations: sheet.animations.slice(),
  };
  state.commands.push({
    label: 'merge strips',
    do() {
      for (const c of coords) { c.frame.x = c.x + snap.dx; c.frame.y = c.y + snap.dy; }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      sheet.animations = after.animations.slice();
      state.selectedAnimationId = dstAnim.id;
    },
    undo() {
      for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; }
      srcAnim.frames = before.srcFrames.map(e => ({ ...e })); srcAnim.breaks = before.srcBreaks.slice();
      dstAnim.frames = before.dstFrames.map(e => ({ ...e })); dstAnim.breaks = before.dstBreaks.slice();
      sheet.animations = before.animations.slice();
      state.selectedAnimationId = before.selectedAnimationId;
    },
  });
  markDirty();
  emit('selection');
}
```

Replace with:

```js
function commitMergeSegments(sheet, d, snap) {
  const srcAnim = d.anim, dstAnim = snap.anim;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: state.selectedAnimationId,
  };
  // findSnap only ever offers same-strip targets now (cross-animation
  // merging is disabled -- see findSnap), so this is always same-strip
  // pixel motion when the strip is accepted; stripLayersOf returns null for
  // a floating strip, falling back to the old metadata-only reposition.
  const layers = stripLayersOf(sheet, srcAnim);
  const mv = layers ? buildMovePatches(sheet, d.members, snap.dx, snap.dy, layers) : null;
  const coords = mv ? null : d.members.map(f => ({ frame: f, x: f.x, y: f.y }));
  if (!mv) for (const f of d.members) { f.x += snap.dx; f.y += snap.dy; }
  if (sameAnim) {
    const r = mergeSegments(srcAnim, d.run.index, snap.run.index, snap.side);
    srcAnim.frames = r.frames; srcAnim.breaks = r.breaks;
  } else {
    const r = transferSegment(srcAnim, dstAnim, d.run.index, snap.run.index, snap.side);
    srcAnim.frames = r.src.frames; srcAnim.breaks = r.src.breaks;
    dstAnim.frames = r.dst.frames; dstAnim.breaks = r.dst.breaks;
    if (srcAnim.frames.length === 0)
      sheet.animations = sheet.animations.filter(a => a !== srcAnim);
  }
  const after = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: srcAnim.breaks.slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: dstAnim.breaks.slice(),
    animations: sheet.animations.slice(),
  };
  state.commands.push({
    label: 'merge strips',
    do() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x + snap.dx; c.frame.y = c.y + snap.dy; }
      }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      sheet.animations = after.animations.slice();
      state.selectedAnimationId = dstAnim.id;
    },
    undo() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      srcAnim.frames = before.srcFrames.map(e => ({ ...e })); srcAnim.breaks = before.srcBreaks.slice();
      dstAnim.frames = before.dstFrames.map(e => ({ ...e })); dstAnim.breaks = before.dstBreaks.slice();
      sheet.animations = before.animations.slice();
      state.selectedAnimationId = before.selectedAnimationId;
    },
  });
  markDirty();
  emit('selection');
}
```

(`transferSegment`'s cross-animation branch is now unreachable — `snap.anim`
is always `=== d.anim` per `findSnap`'s restriction — but is left in place
rather than deleted, since the restriction is explicitly "for now".)

- [ ] **Step 3: Syntax check and test suite**

Run: `node --input-type=module --check < js/ui/frames.js`
Expected: no output (syntax OK).

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add js/ui/frames.js
git commit -m "$(cat <<'EOF'
feat: restrict strip-segment merging to the same overall strip; carry pixels

findSnap no longer searches other strip animations for a merge target
-- cross-animation merging is disabled for now. With that restriction
every reachable merge is same-strip, so commitMergeSegments now moves
pixel content the same way commitMoveFramesWithPixels does, instead of
only repositioning the frame metadata.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: End-to-end browser verification

**Files:** none (verification only — no code changes).

- [ ] **Step 1: Start a local static server**

```bash
python -m http.server 8844 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8844/index.html
```

Expected: `200`.

- [ ] **Step 2: Load the app and confirm a clean console**

Navigate to `http://localhost:8844/index.html?autotest` with
`mcp__plugin_playwright_playwright__browser_navigate`. Then
`mcp__plugin_playwright_playwright__browser_console_messages` with
`level: "warning"`, `all: true`.
Expected: `Total messages: 0 (Errors: 0, Warnings: 0)`.

Override `alert` so the "last layer in this group" guard can't block
automation:

```js
() => { window.alert = (m) => { window.__lastAlert = m; }; }
```

- [ ] **Step 3: Create and accept a strip, verify its segment bounds**

```js
() => {
  Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'New strip…').click();
}
```

```js
() => { document.querySelector('#strip-create').click(); }
```

Dispatch a real click (via `browser_click`, not synthesized events) on the
canvas at the new strip's first frame to auto-accept it (same pattern as the
floating-strips plan's Task 11 Step 4). Then confirm via state inspection:

```js
async () => {
  const stateMod = await import('/js/app/state.js');
  const modelMod = await import('/js/core/model.js');
  const stripsMod = await import('/js/core/strips.js');
  const sheet = stateMod.activeSheet();
  const anim = sheet.animations[0];
  const ctx = modelMod.layerAnimationContext(sheet, stateMod.activeLayer());
  return { accepted: !!anim.layerGroupId, ctxMatchesAnim: ctx?.anim === anim };
}
```

Expected: `{ accepted: true, ctxMatchesAnim: true }`.

- [ ] **Step 4: Verify painting is constrained to the strip's own segment**

With the accepted strip's layer active (from Step 3) and the pencil tool
selected, use `browser_evaluate` to directly exercise the pixel-writing path
at a point OUTSIDE the strip's frames (e.g. far to the right of the sheet)
by dispatching a single click there, then inspect the layer's bitmap at that
point:

```js
async () => {
  const stateMod = await import('/js/app/state.js');
  const sheet = stateMod.activeSheet();
  const layer = stateMod.activeLayer();
  const pixelsMod = await import('/js/core/pixels.js');
  return { before: pixelsMod.getPixel(layer.bitmap, 200, 200) };
}
```

Then dispatch a click at the canvas position corresponding to sheet pixel
(200, 200) — well outside any of this strip's frames — and re-check the same
pixel is still transparent (unpainted), confirming the stroke was clamped to
the segment and never reached that point. Compare against a click clearly
INSIDE the strip's own frame rect, which should paint successfully.

- [ ] **Step 5: Verify Alt+copy/paste scoping (layer-selection scoping rule)**

Select a layer nested under the accepted strip's group directly in the
layers panel (not via the timeline dropdown), draw one pixel, then Alt+copy
and inspect `clipboard` — or more directly, inspect via state:

```js
async () => {
  const stateMod = await import('/js/app/state.js');
  const sheet = stateMod.activeSheet();
  const modelMod = await import('/js/core/model.js');
  const ctx = modelMod.layerAnimationContext(sheet, stateMod.activeLayer());
  return { activeLayerBelongsToAnim: ctx?.anim.id };
}
```

Confirm this matches the accepted strip's own animation id regardless of
`state.selectedAnimationId`'s current value (set it to something else first,
e.g. `'(none)'`, and confirm the layer-selection-scoping resolution still
reports the correct animation).

- [ ] **Step 6: Run the full automated test suite one more time**

Run: `node --test tests/*.mjs`
Expected: PASS, 0 failures.

- [ ] **Step 7: Stop the local server**

```bash
pkill -f "http.server 8844"
```

- [ ] **Step 8: Manual-only follow-ups (do not simulate drags in Playwright)**

Note in the final report, for the user to verify by hand:
- Dragging an accepted strip's frames with the **frame tool** carries its
  own pixels to the new position (was previously metadata-only).
- Dragging an accepted strip's segment with the **move tool** carries only
  that strip's own layer(s), not a different animation's or root's pixels,
  regardless of what's selected in the timeline dropdown.
- Snapping two segments of the **same** strip together still merges and now
  carries pixels; dragging a segment near a **different** strip's segment no
  longer offers a snap target at all.
- Pasting (Ctrl+V) while an accepted strip's layer is active lands only
  within its current segment's bounds, even if the paste's original source
  position was outside it.

- [ ] **Step 9: No commit for this task** (verification only). If any step
surfaces a bug, fix it in the relevant earlier task's files, re-run that
task's tests, and re-run this verification task from Step 1.
