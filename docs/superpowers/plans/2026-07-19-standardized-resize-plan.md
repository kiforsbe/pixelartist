# Standardized Resize/Transform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify frame resize, tile resize, the selection marquee, and the
floating-selection/Move-tool scale under one shared anchor/modifier system,
matching Photoshop/Affinity conventions (Alt = center anchor, Shift = toggle
proportional lock, both read live every pointer-move).

**Architecture:** One new pure module (`js/core/resizeAnchor.js`) provides
the anchor/lock/proportional-ratio primitives and a full rect-resize
function, consumed directly by frames.js, tilemode.js, and the selection
marquee. The float scale reuses the same primitives but layers its own
rotation-aware affine-transform solve on top (`solveScaleTransform`, added
to `js/core/floating.js`), since a float can't be expressed as a plain
`{x,y,w,h}` rect once it's rotated.

**Tech Stack:** Vanilla JS (ES modules), `node --test` for unit tests, no
build step, no framework.

## Global Constraints

- No DOM/app-state imports in `js/core/resizeAnchor.js` or the new
  `solveScaleTransform` function — pure, `node --test`-able, matching
  `js/ui/dimlabels.js`'s existing convention.
- Every call site reads modifiers via `isCenterAnchorModifier(ev)` /
  `isProportionalModifier(ev)`, never inline `ev.altKey`/`ev.shiftKey` —
  see the design doc's "Configurability" section.
- Modifiers are read live on every pointer-move event (recomputed fresh
  from the immutable pre-drag snapshot each time), never latched at
  drag-start.
- Frame/tile resize stays corner-handle-only (4 handles) — no new edge
  handles are added there.
- `git commit` after each task, following this repo's existing commit
  message style (see recent `git log`).
- Full spec: `docs/superpowers/specs/2026-07-19-standardized-resize-design.md`.

---

## Task 1: `resizeAnchor.js` — the shared pure module

**Files:**
- Create: `js/core/resizeAnchor.js`
- Test: `tests/resizeAnchor.test.mjs`

**Interfaces:**
- Produces: `HANDLES_CORNER` (`['nw','ne','sw','se']`), `HANDLES_ALL`
  (`['nw','n','ne','e','se','s','sw','w']`), `isCenterAnchorModifier(ev)`,
  `isProportionalModifier(ev)`, `handlePoint(rect, handle)`,
  `resolveAnchor(rect, handle, useCenter)`, `isAspectLocked(handle, shiftHeld)`,
  `dominantMagnitude(a, b)`, `resizeRectFromHandle(orig, handle, px, py, opts)`.
  Every later task in this plan imports from this module.

- [ ] **Step 1: Write the failing test file**

Create `tests/resizeAnchor.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDLES_CORNER, HANDLES_ALL, isCenterAnchorModifier, isProportionalModifier,
  handlePoint, resolveAnchor, isAspectLocked, dominantMagnitude, resizeRectFromHandle,
} from '../js/core/resizeAnchor.js';

// ---- modifier predicates ----

test('isCenterAnchorModifier reads altKey; isProportionalModifier reads shiftKey', () => {
  assert.equal(isCenterAnchorModifier({ altKey: true }), true);
  assert.equal(isCenterAnchorModifier({ altKey: false }), false);
  assert.equal(isCenterAnchorModifier({}), false);
  assert.equal(isProportionalModifier({ shiftKey: true }), true);
  assert.equal(isProportionalModifier({ shiftKey: false }), false);
  assert.equal(isProportionalModifier({}), false);
});

// ---- isAspectLocked ----

test('isAspectLocked: corner defaults locked, Shift frees it', () => {
  for (const h of HANDLES_CORNER) {
    assert.equal(isAspectLocked(h, false), true, `${h} unlocked by default`);
    assert.equal(isAspectLocked(h, true), false, `${h} Shift should free it`);
  }
});

test('isAspectLocked: edge defaults free, Shift locks it', () => {
  for (const h of ['n', 'e', 's', 'w']) {
    assert.equal(isAspectLocked(h, false), false, `${h} locked by default`);
    assert.equal(isAspectLocked(h, true), true, `${h} Shift should lock it`);
  }
});

// ---- dominantMagnitude ----

test('dominantMagnitude picks the larger absolute value', () => {
  assert.equal(dominantMagnitude(2, 5), 5);
  assert.equal(dominantMagnitude(-2, 5), 5);
  assert.equal(dominantMagnitude(-7, 5), 7);
  assert.equal(dominantMagnitude(3, 3), 3);
});

// ---- handlePoint / resolveAnchor ----

const RECT = { x: 10, y: 10, w: 20, h: 10 }; // edges 10..30, 10..20

test('handlePoint: literal position of each handle', () => {
  assert.deepEqual(handlePoint(RECT, 'nw'), { x: 10, y: 10 });
  assert.deepEqual(handlePoint(RECT, 'se'), { x: 30, y: 20 });
  assert.deepEqual(handlePoint(RECT, 'n'), { x: 20, y: 10 });
  assert.deepEqual(handlePoint(RECT, 'e'), { x: 30, y: 15 });
  assert.deepEqual(handlePoint(RECT, 'w'), { x: 10, y: 15 });
});

test('resolveAnchor: opposite corner/edge midpoint by default', () => {
  assert.deepEqual(resolveAnchor(RECT, 'se', false), { x: 10, y: 10 }); // nw
  assert.deepEqual(resolveAnchor(RECT, 'nw', false), { x: 30, y: 20 }); // se
  assert.deepEqual(resolveAnchor(RECT, 'e', false), { x: 10, y: 15 });  // w midpoint
  assert.deepEqual(resolveAnchor(RECT, 'n', false), { x: 20, y: 20 });  // s midpoint
});

test('resolveAnchor: rect center when useCenter is true, regardless of handle', () => {
  for (const h of HANDLES_ALL) assert.deepEqual(resolveAnchor(RECT, h, true), { x: 20, y: 15 });
});

// ---- resizeRectFromHandle: migrated from the old resizerect.js suite ----
// (corner-handle cases pass shiftHeld: true, since corner-drag is now
// proportional BY DEFAULT -- these tests specifically exercise the old
// "both axes independently follow the pointer" free behavior, which under
// the new default requires Shift.)

const TARGET = { x: 0, y: 0, w: 32, h: 32 };
const ORIG = { x: 8, y: 8, w: 8, h: 8 }; // edges at 8..16

test('corner se, Shift held (free): both axes independently follow the pointer', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG, 'se', 19, 21, { shiftHeld: true, target: TARGET, inclusive: true }),
    { x: 8, y: 8, w: 12, h: 14 },
  );
});

test('corner nw, Shift held (free): opposite corner anchored', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG, 'nw', 4, 6, { shiftHeld: true, target: TARGET, inclusive: true }),
    { x: 4, y: 6, w: 12, h: 10 },
  );
});

test('edge handles move one axis only (default, no modifiers)', () => {
  assert.deepEqual(resizeRectFromHandle(ORIG, 'e', 25, 0, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 18, h: 8 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'n', 0, 2, { target: TARGET, inclusive: true }), { x: 8, y: 2, w: 8, h: 14 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 's', 31, 11, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 8, h: 4 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'w', 10, 31, { target: TARGET, inclusive: true }), { x: 10, y: 8, w: 6, h: 8 });
});

test('drag through the anchor flips and normalizes', () => {
  assert.deepEqual(resizeRectFromHandle(ORIG, 'e', 3, 8, { target: TARGET, inclusive: true }), { x: 4, y: 8, w: 4, h: 8 });
  assert.deepEqual(
    resizeRectFromHandle(ORIG, 'nw', 20, 20, { shiftHeld: true, target: TARGET, inclusive: true }),
    { x: 16, y: 16, w: 4, h: 4 },
  );
});

test('pointer clamped to target; result stays inside', () => {
  const r = resizeRectFromHandle(ORIG, 'se', 99, 99, { shiftHeld: true, target: TARGET, inclusive: true });
  assert.deepEqual(r, { x: 8, y: 8, w: 24, h: 24 });
  const r2 = resizeRectFromHandle(ORIG, 'nw', -5, -5, { shiftHeld: true, target: TARGET, inclusive: true });
  assert.deepEqual(r2, { x: 0, y: 0, w: 16, h: 16 });
});

test('min 1x1 when collapsed onto the anchor', () => {
  assert.equal(resizeRectFromHandle(ORIG, 'w', 15, 8, { target: TARGET, inclusive: true }).w, 1);
  assert.equal(resizeRectFromHandle(ORIG, 'e', 8, 8, { target: TARGET, inclusive: true }).w, 1);
});

test('degenerate edge collision pins INSIDE the fixed edge, never past it', () => {
  assert.deepEqual(resizeRectFromHandle(ORIG, 'w', 16, 8, { target: TARGET, inclusive: true }), { x: 15, y: 8, w: 1, h: 8 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'e', 7, 8, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 1, h: 8 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 'n', 8, 16, { target: TARGET, inclusive: true }), { x: 8, y: 15, w: 8, h: 1 });
  assert.deepEqual(resizeRectFromHandle(ORIG, 's', 8, 7, { target: TARGET, inclusive: true }), { x: 8, y: 8, w: 8, h: 1 });
});

// ---- resizeRectFromHandle: new modifier-behavior coverage ----

const ORIG2 = { x: 10, y: 10, w: 20, h: 10 }; // aspect 2:1

test('corner drag with no modifiers is proportional by default', () => {
  // orig aspect 2:1; pointer implies 40x15 (kx=2, ky=1.5) -> dominant kx=2 wins, both scale x2
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'se', 50, 25, { inclusive: false }),
    { x: 10, y: 10, w: 40, h: 20 },
  );
});

test('corner drag + Shift is free (independent axes)', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'se', 50, 25, { shiftHeld: true, inclusive: false }),
    { x: 10, y: 10, w: 40, h: 15 },
  );
});

test('corner drag + Alt anchors at center, still proportional', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'se', 50, 35, { useCenter: true, inclusive: false }),
    { x: -20, y: -5, w: 80, h: 40 },
  );
});

test('edge drag + Shift scales the other axis to match (aspect locked)', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'e', 50, 0, { shiftHeld: true, inclusive: false }),
    { x: 10, y: 5, w: 40, h: 20 },
  );
});

test('edge drag + Alt anchors that axis at center, other axis untouched', () => {
  assert.deepEqual(
    resizeRectFromHandle(ORIG2, 'e', 50, 0, { useCenter: true, inclusive: false }),
    { x: -10, y: 10, w: 60, h: 10 },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/resizeAnchor.test.mjs` (or `node --test tests/resizeAnchor.test.mjs`)
Expected: FAIL — `Cannot find module '../js/core/resizeAnchor.js'`

- [ ] **Step 3: Write the implementation**

Create `js/core/resizeAnchor.js`:

```js
// Shared resize/transform anchor logic: which point stays fixed when you
// drag a corner or edge handle, and how the Photoshop/Affinity-style Alt
// (center anchor) / Shift (aspect lock) modifiers change that. Pure
// geometry, no DOM/app-state imports (node-tested) -- mirrors dimlabels.js's
// convention. Used directly by frames.js, tilemode.js, and tools.js's
// selection marquee (all via resizeRectFromHandle); tools.js's float scale
// reuses resolveAnchor/handlePoint/isAspectLocked/dominantMagnitude but
// solves its own rotation-aware affine transform on top (see
// core/floating.js's solveScaleTransform), since a float can't be
// expressed as a plain {x,y,w,h} rect once it's rotated.
//
// See docs/superpowers/specs/2026-07-19-standardized-resize-design.md for
// the full modifier semantics table and worked math.

export const HANDLES_CORNER = ['nw', 'ne', 'sw', 'se'];
export const HANDLES_ALL = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function isCenterAnchorModifier(ev) { return !!ev.altKey; }
export function isProportionalModifier(ev) { return !!ev.shiftKey; }

// Fractional (fx, fy) position of each handle within a unit rect (0 = min
// edge, 1 = max edge, 0.5 = that axis's own midpoint) -- the single source
// of truth handlePoint and resolveAnchor both derive from.
const HANDLE_FRACTION = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0],
  w: [0, 0.5], e: [1, 0.5],
  sw: [0, 1], s: [0.5, 1], se: [1, 1],
};

function pointAtFraction(rect, fx, fy) {
  return { x: rect.x + fx * rect.w, y: rect.y + fy * rect.h };
}

// The literal point on the rect at this handle.
export function handlePoint(rect, handle) {
  const [fx, fy] = HANDLE_FRACTION[handle];
  return pointAtFraction(rect, fx, fy);
}

// The point that stays fixed during a drag on this handle: the opposite
// corner/edge midpoint by default, or the rect's center when useCenter.
// For an edge handle, "opposite edge midpoint" is already centered on the
// axis that handle doesn't drive -- see resizeRectFromHandle's secondary-
// axis handling below, which relies on this.
export function resolveAnchor(rect, handle, useCenter) {
  if (useCenter) return pointAtFraction(rect, 0.5, 0.5);
  const [fx, fy] = HANDLE_FRACTION[handle];
  return pointAtFraction(rect, 1 - fx, 1 - fy);
}

// Whether THIS drag is aspect-ratio-locked, given the raw Shift state.
// Corner handles default locked (Shift frees them); edge handles default
// free (Shift locks them) -- resolved once here so no caller restates the
// flip.
export function isAspectLocked(handle, shiftHeld) {
  return HANDLES_CORNER.includes(handle) ? !shiftHeld : shiftHeld;
}

// The larger-magnitude of two candidate scale ratios/deltas, sign
// discarded -- "whichever axis moved further drives the size" rule behind
// proportional-lock corner resizing. Callers needing a signed result
// (float scale, whose factor can go negative -- a flip) re-sign per axis
// afterward.
export function dominantMagnitude(a, b) {
  return Math.max(Math.abs(a), Math.abs(b));
}

// orig: the rect BEFORE this drag started (immutable snapshot -- never
// pass a live/previous-frame rect, so live Alt/Shift toggling recomputes
// cleanly with no drift). px, py: current raw pointer position, image-space
// (a pixel index, per canvasview.js's screenToImage). opts:
//   useCenter  - anchor at rect center instead of the opposite corner/edge
//   shiftHeld  - raw modifier state; isAspectLocked resolves what it means
//   target     - optional {x,y,w,h} to clamp the pointer into first
//   inclusive  - true: treat px/py as an INCLUDED pixel index, so the 'e'/
//                's' side gets +1 to become an edge coordinate (matches
//                the old resizerect.js's inclusive-pixel-selection
//                semantics). false (default): px/py ARE already edge
//                coordinates (matches frames.js/tilemode.js's existing
//                convention, where a shape's own x/x+w live in that space).
// Returns the new {x, y, w, h}.
export function resizeRectFromHandle(orig, handle, px, py, opts = {}) {
  const { useCenter = false, shiftHeld = false, target = null, inclusive = false } = opts;
  if (target) {
    px = Math.max(target.x, Math.min(target.x + target.w - 1, px));
    py = Math.max(target.y, Math.min(target.y + target.h - 1, py));
  }
  let ex = px, ey = py;
  if (inclusive) {
    if (handle.includes('e')) ex += 1;
    if (handle.includes('s')) ey += 1;
  }

  const anchor = resolveAnchor(orig, handle, useCenter);
  const drivesX = handle.includes('w') || handle.includes('e');
  const drivesY = handle.includes('n') || handle.includes('s');
  const reach = (a, t) => Math.max(1, (useCenter ? 2 : 1) * Math.abs(t - a));

  let newW = drivesX ? reach(anchor.x, ex) : orig.w;
  let newH = drivesY ? reach(anchor.y, ey) : orig.h;

  if (isAspectLocked(handle, shiftHeld)) {
    const aspectW = Math.max(1, orig.w), aspectH = Math.max(1, orig.h);
    if (HANDLES_CORNER.includes(handle)) {
      const k = dominantMagnitude(newW / aspectW, newH / aspectH);
      newW = aspectW * k;
      newH = aspectH * k;
    } else if (drivesX) {
      newH = aspectH * (newW / aspectW);
    } else if (drivesY) {
      newW = aspectW * (newH / aspectH);
    }
  }
  newW = Math.max(1, Math.round(newW));
  newH = Math.max(1, Math.round(newH));

  // Degenerate collision (the dragged edge landed exactly ON the anchor):
  // t===a has no direction, so fall back to the handle's own low-side
  // membership to pin the sliver INSIDE the original bounds rather than
  // past the anchor.
  const dirFor = (a, t, lowChar) => (t > a ? 1 : t < a ? -1 : (handle.includes(lowChar) ? -1 : 1));
  const rangeFor = (a, t, size, driven, lowChar) => {
    if (!driven) return [a - size / 2, a + size / 2]; // secondary axis: symmetric around anchor
    if (useCenter) return [a - size / 2, a + size / 2];
    const dir = dirFor(a, t, lowChar);
    return dir > 0 ? [a, a + size] : [a - size, a];
  };
  const [x0, x1] = rangeFor(anchor.x, ex, newW, drivesX, 'w');
  const [y0, y1] = rangeFor(anchor.y, ey, newH, drivesY, 'n');

  return {
    x: Math.round(x0), y: Math.round(y0),
    w: Math.max(1, Math.round(x1 - x0)), h: Math.max(1, Math.round(y1 - y0)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: all tests pass, including every new `resizeAnchor.test.mjs` case.

- [ ] **Step 5: Commit**

```bash
git add js/core/resizeAnchor.js tests/resizeAnchor.test.mjs
git commit -m "feat: add resizeAnchor.js, the shared resize/transform anchor module"
```

---

## Task 2: Migrate frames.js to the shared module

**Files:**
- Modify: `js/ui/frames.js`

**Interfaces:**
- Consumes: `HANDLES_CORNER`, `isCenterAnchorModifier(ev)`,
  `isProportionalModifier(ev)`, `resizeRectFromHandle(orig, handle, px, py, opts)`
  from Task 1's `js/core/resizeAnchor.js`.

- [ ] **Step 1: Update the import block**

In `js/ui/frames.js`, the import block currently ends with:

```js
import { registerTool } from './tools.js';
import { drawRectDims, drawChainDims } from './dimlabels.js';

const HANDLE_SCREEN_PX = 6;
const HANDLES = ['nw', 'ne', 'sw', 'se'];
```

Replace with:

```js
import { registerTool } from './tools.js';
import { drawRectDims, drawChainDims } from './dimlabels.js';
import { HANDLES_CORNER, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../core/resizeAnchor.js';

const HANDLE_SCREEN_PX = 6;
```

- [ ] **Step 2: Delete `oppositeCorner`, rename `HANDLES` usages**

Delete this function entirely (currently right before `hitHandle`):

```js
function oppositeCorner(f, handle) {
  const map = {
    nw: { x: f.x + f.w, y: f.y + f.h },
    ne: { x: f.x, y: f.y + f.h },
    sw: { x: f.x + f.w, y: f.y },
    se: { x: f.x, y: f.y },
  };
  return map[handle];
}
```

In `hitHandle`, change `for (const h of HANDLES) {` to `for (const h of HANDLES_CORNER) {`.

In `drawHandles` (further down, right after `const FRAME_HANDLE = '#4f8cff';`), change
`for (const h of HANDLES) {` to `for (const h of HANDLES_CORNER) {`.

- [ ] **Step 3: Update the `resize` drag-start branch**

Find (in the pointer-down handler):

```js
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      anchor: oppositeCorner(selected, handle),
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
```

Replace with:

```js
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
```

(`anchor` is dropped — `resizeRectFromHandle` derives it fresh every move
event from `drag.before` + `drag.handle`, which is what makes live Alt/Shift
toggling work without extra state.)

- [ ] **Step 4: Update the `resize` drag-move branch**

Find:

```js
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false));
```

Replace with:

```js
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    }));
```

- [ ] **Step 5: Run the full suite and confirm no regressions**

Run: `npm test`
Expected: all tests pass (this task touches only UI drag-handling code with
no direct test seam — the check here is that nothing else broke).

- [ ] **Step 6: Commit**

```bash
git add js/ui/frames.js
git commit -m "feat: standardize frame resize on resizeAnchor.js (Alt=center, Shift=free)"
```

---

## Task 3: Migrate tilemode.js to the shared module

**Files:**
- Modify: `js/ui/tilemode.js`

**Interfaces:**
- Consumes: same four exports from `js/core/resizeAnchor.js` as Task 2.

- [ ] **Step 1: Update the import block**

In `js/ui/tilemode.js`, after the existing `tilegrids.js` import block, add a
new import. Current imports end with:

```js
import { newId } from '../core/palettes.js';
import { scrubTileReferences, flattenSheet } from '../core/model.js';
```

Insert directly after:

```js
import { HANDLES_CORNER, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../core/resizeAnchor.js';
```

- [ ] **Step 2: Delete `oppositeCorner`, rename `HANDLES` usages**

Delete this function (currently right before `hitHandle`):

```js
function oppositeCorner(t, handle) {
  const map = {
    nw: { x: t.x + t.w, y: t.y + t.h },
    ne: { x: t.x, y: t.y + t.h },
    sw: { x: t.x + t.w, y: t.y },
    se: { x: t.x, y: t.y },
  };
  return map[handle];
}
```

Also delete the now-unused local `const HANDLES = ['nw', 'ne', 'sw', 'se'];`
right above it.

In `hitHandle`, change `for (const h of HANDLES) {` to `for (const h of HANDLES_CORNER) {`.

In `drawTileHandles` (the function with the comment "Resize-grip squares at
the 4 corners of a standalone selected tile"), change
`for (const h of HANDLES) {` to `for (const h of HANDLES_CORNER) {`.

- [ ] **Step 3: Update the `resize` drag-start branch**

Find (in `handleDown`):

```js
  const handle = hitHandle(view, selected, ev.sx, ev.sy);
  if (handle) {
    drag = {
      kind: 'resize', tile: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      anchor: oppositeCorner(selected, handle),
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
```

Replace with:

```js
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
```

- [ ] **Step 4: Update the `resize` drag-move branch**

Find (in `handleMove`):

```js
  } else if (drag.kind === 'resize') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false);
```

Replace with:

```js
  } else if (drag.kind === 'resize') {
    drag.rect = resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    });
```

- [ ] **Step 5: Run the full suite and confirm no regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add js/ui/tilemode.js
git commit -m "feat: standardize tile resize on resizeAnchor.js (Alt=center, Shift=free)"
```

---

## Task 4: Migrate the selection marquee, retire resizerect.js

**Files:**
- Modify: `js/ui/tools.js`
- Delete: `js/core/resizerect.js`
- Delete: `tests/resizerect.test.mjs` (fully superseded by Task 1's
  `tests/resizeAnchor.test.mjs`, which already covers every case it had)

**Interfaces:**
- Consumes: `HANDLES_ALL`, `isCenterAnchorModifier(ev)`,
  `isProportionalModifier(ev)`, `resizeRectFromHandle(orig, handle, px, py, opts)`
  from `js/core/resizeAnchor.js`.

- [ ] **Step 1: Update the import block**

In `js/ui/tools.js`, find:

```js
import { resizeRect } from '../core/resizerect.js';
```

Replace with:

```js
import { HANDLES_ALL, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../core/resizeAnchor.js';
```

- [ ] **Step 2: Replace the local `SEL_HANDLES` with the shared `HANDLES_ALL`**

Find:

```js
  // 8 handle anchor points on the marquee, image-space EDGE coords
  const SEL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
```

Replace with:

```js
  // 8 handle anchor points on the marquee, image-space EDGE coords
  const SEL_HANDLES = HANDLES_ALL;
```

(Kept as a local alias rather than renaming every call site, to keep this
diff minimal — `SEL_HANDLES` reads clearly in context and the two arrays
are identical in both content and order.)

- [ ] **Step 3: Update the resize-mode pointer-move branch**

Find (in `handleSelectMove`):

```js
    } else if (selStroke.mode === 'resize') {
      // A plain click on a handle must not nudge the rect: the e/s handle
      // centers sit ON the edge coordinate, which resizeRect reads as an
      // inclusive pixel (a no-move click would grow the rect by 1) — only
      // recompute once the pointer has left the pointer-down pixel.
      if (ev.x !== selStroke.anchor.x || ev.y !== selStroke.anchor.y) selStroke.moved = true;
      if (selStroke.moved) selection = resizeRect(selStroke.orig, selStroke.handle, ev.x, ev.y, target);
```

Replace with:

```js
    } else if (selStroke.mode === 'resize') {
      // A plain click on a handle must not nudge the rect: the e/s handle
      // centers sit ON the edge coordinate, which resizeRectFromHandle's
      // `inclusive: true` reads as an inclusive pixel (a no-move click
      // would grow the rect by 1) — only recompute once the pointer has
      // left the pointer-down pixel.
      if (ev.x !== selStroke.anchor.x || ev.y !== selStroke.anchor.y) selStroke.moved = true;
      if (selStroke.moved) selection = resizeRectFromHandle(selStroke.orig, selStroke.handle, ev.x, ev.y, {
        useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev), target, inclusive: true,
      });
```

- [ ] **Step 4: Delete the retired files**

```bash
git rm js/core/resizerect.js tests/resizerect.test.mjs
```

- [ ] **Step 5: Run the full suite and confirm no regressions**

Run: `npm test`
Expected: all tests pass (the removed `resizerect.test.mjs` cases already
live in `tests/resizeAnchor.test.mjs` from Task 1).

- [ ] **Step 6: Commit**

```bash
git add js/ui/tools.js
git commit -m "feat: standardize selection-marquee resize on resizeAnchor.js, retire resizerect.js"
```

---

## Task 5: Float scale — rotation-aware anchor solve

**Files:**
- Modify: `js/core/floating.js`
- Modify: `tests/floating.test.mjs`
- Modify: `js/ui/tools.js`

**Interfaces:**
- Consumes: `resolveAnchor`, `handlePoint`, `isAspectLocked`,
  `dominantMagnitude`, `HANDLES_CORNER` from `js/core/resizeAnchor.js`
  (Task 1); `isCenterAnchorModifier`, `isProportionalModifier` (already
  imported into tools.js by Task 4).
- Produces: `solveScaleTransform({ srcRect, t0, handle, useCenter, shiftHeld, mx, my })`
  → `{ tx, ty, sx, sy, rot }`, consumed by tools.js's float `scale` drag
  branch.

- [ ] **Step 1: Write the failing tests**

In `tests/floating.test.mjs`, update the import at the top from:

```js
import {
  makeTransform, isIdentity, floatBounds, rasterizeFloat, compositeFloatOnLayer,
} from '../js/core/floating.js';
```

to:

```js
import {
  makeTransform, isIdentity, floatBounds, rasterizeFloat, compositeFloatOnLayer,
  solveScaleTransform,
} from '../js/core/floating.js';
```

Then append these tests at the end of the file (after the existing
`compositeFloatOnLayer` test):

```js
// ---- solveScaleTransform ----

function closeTo(actual, expected, eps = 1e-6, msg = '') {
  assert.ok(Math.abs(actual - expected) < eps, `${msg}: ${actual} !~ ${expected}`);
}

test('solveScaleTransform: unrotated corner drag, no modifiers, proportional by default', () => {
  const srcRect = { x: 0, y: 0, w: 20, h: 10 };
  const t0 = makeTransform();
  // grabbed 'se' local (20,10); pivot 'nw' local (0,0) -> world (0,0) at identity
  const r = solveScaleTransform({ srcRect, t0, handle: 'se', useCenter: false, shiftHeld: false, mx: 60, my: 25 });
  // kx = 60/20 = 3, ky = 25/10 = 2.5 -> dominant 3, both axes locked to 3
  closeTo(r.sx, 3, 1e-9, 'sx');
  closeTo(r.sy, 3, 1e-9, 'sy');
  closeTo(r.tx, 20, 1e-9, 'tx');
  closeTo(r.ty, 10, 1e-9, 'ty');
  assert.equal(r.rot, 0);
});

test('solveScaleTransform: Shift frees the corner drag (independent axes)', () => {
  const srcRect = { x: 0, y: 0, w: 20, h: 10 };
  const t0 = makeTransform();
  const r = solveScaleTransform({ srcRect, t0, handle: 'se', useCenter: false, shiftHeld: true, mx: 60, my: 25 });
  closeTo(r.sx, 3, 1e-9, 'sx');
  closeTo(r.sy, 2.5, 1e-9, 'sy');
});

test('solveScaleTransform: rotated 90°, edge drag along the shape\'s LOCAL axis stays fixed at center', () => {
  // Square float, rotated 90°, useCenter (Alt) so the pivot is the buffer
  // center -- world center never moves regardless of rotation, so tx/ty
  // should come back ~0 while sx captures the LOCAL x-axis scale even
  // though the drag reads as vertical on screen (since local +x maps to
  // world +y at a 90° rotation).
  const srcRect = { x: 0, y: 0, w: 20, h: 20 };
  const t0 = { ...makeTransform(), rot: Math.PI / 2 };
  const r = solveScaleTransform({ srcRect, t0, handle: 'e', useCenter: true, shiftHeld: false, mx: 10, my: 40 });
  closeTo(r.sx, 3, 1e-6, 'sx (local x-axis, driven by the visually-vertical drag)');
  assert.equal(r.sy, 1, 'sy untouched -- e handle never drives the local y-axis');
  closeTo(r.tx, 0, 1e-6, 'tx -- center-anchored scale never translates');
  closeTo(r.ty, 0, 1e-6, 'ty -- center-anchored scale never translates');
  assert.equal(r.rot, Math.PI / 2, 'rot carried over from t0 unchanged');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- tests/floating.test.mjs` (or `node --test tests/floating.test.mjs`)
Expected: FAIL — `solveScaleTransform is not a function` (or similar import error).

- [ ] **Step 3: Implement `solveScaleTransform` in floating.js**

In `js/core/floating.js`, update the top import line from:

```js
import { createBitmap, cloneBitmap, blitOver } from './pixels.js';
```

to:

```js
import { createBitmap, cloneBitmap, blitOver } from './pixels.js';
import { resolveAnchor, handlePoint, isAspectLocked, dominantMagnitude, HANDLES_CORNER } from './resizeAnchor.js';
```

Then add this function after `inversePoint` (right before `floatBounds`):

```js
// Rotation-aware scale solve for the float Move-tool's handle drag. t0 is
// the transform BEFORE this drag started (an immutable snapshot -- never
// re-derive from the live/previous-frame transform, so live Alt/Shift
// toggling recomputes cleanly with no drift). mx, my: the live mouse
// position, sheet-space, already pixel-centered by the caller (+0.5,
// matching the convention the rotate-knob code already uses). Returns a
// full new transform {tx, ty, sx, sy, rot} -- rot is always carried over
// from t0 unchanged, since a scale drag never rotates.
export function solveScaleTransform({ srcRect, t0, handle, useCenter, shiftHeld, mx, my }) {
  const { w, h } = srcRect;
  const cx = w / 2, cy = h / 2;
  const localRect = { x: 0, y: 0, w, h };
  const pivot = resolveAnchor(localRect, handle, useCenter);
  const grabbed = handlePoint(localRect, handle);
  const pivotWorld = forwardPoint({ srcRect, transform: t0 }, pivot.x, pivot.y);

  const cos = Math.cos(t0.rot), sin = Math.sin(t0.rot);
  const dx = mx - pivotWorld.x, dy = my - pivotWorld.y;
  const px = dx * cos + dy * sin;   // un-rotate into local, unrotated units
  const py = -dx * sin + dy * cos;

  const hu = grabbed.x - pivot.x, hv = grabbed.y - pivot.y;
  const clampS = (s) => (s < 0 ? -1 : 1) * Math.max(0.01, Math.abs(s));
  let sx = t0.sx, sy = t0.sy;
  if (hu !== 0) sx = clampS(px / hu);
  if (hv !== 0) sy = clampS(py / hv);

  if (isAspectLocked(handle, shiftHeld)) {
    if (HANDLES_CORNER.includes(handle)) {
      const m = dominantMagnitude(sx, sy);
      sx = clampS(Math.sign(sx || 1) * m);
      sy = clampS(Math.sign(sy || 1) * m);
    } else if (hu !== 0) {
      sy = clampS(Math.sign(sy || 1) * Math.abs(sx));
    } else if (hv !== 0) {
      sx = clampS(Math.sign(sx || 1) * Math.abs(sy));
    }
  }

  // Solve tx, ty so the pivot's world position is reproduced exactly under
  // the new (sx, sy): forwardPoint maps the buffer CENTER via translation
  // alone (rotation/scale only offset from center), so back out what the
  // center's world position must be, then convert to tx/ty.
  const offX = pivot.x - cx, offY = pivot.y - cy;
  const rotX = offX * sx * cos - offY * sy * sin;
  const rotY = offX * sx * sin + offY * sy * cos;
  const centerWorldX = pivotWorld.x - rotX;
  const centerWorldY = pivotWorld.y - rotY;

  return {
    tx: centerWorldX - srcRect.x - cx,
    ty: centerWorldY - srcRect.y - cy,
    sx, sy, rot: t0.rot,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests pass, including the 3 new `solveScaleTransform` cases.

- [ ] **Step 5: Commit the pure-logic half**

```bash
git add js/core/floating.js tests/floating.test.mjs
git commit -m "feat: add solveScaleTransform, rotation-aware anchor solve for float scale"
```

- [ ] **Step 6: Wire named handles into tools.js's `handleAnchors`**

In `js/ui/tools.js`, find:

```js
  // 4 corners + 4 edge midpoints in buffer space
  function handleAnchors(float) {
    const { w, h } = float.srcRect;
    return [
      { u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h },
      { u: w / 2, v: 0 }, { u: w, v: h / 2 }, { u: w / 2, v: h }, { u: 0, v: h / 2 },
    ];
  }
```

Replace with:

```js
  // 4 corners + 4 edge midpoints in buffer space, named so handleMoveDown
  // can identify which one was grabbed (needed by solveScaleTransform).
  function handleAnchors(float) {
    const { w, h } = float.srcRect;
    return [
      { handle: 'nw', u: 0, v: 0 }, { handle: 'ne', u: w, v: 0 },
      { handle: 'se', u: w, v: h }, { handle: 'sw', u: 0, v: h },
      { handle: 'n', u: w / 2, v: 0 }, { handle: 'e', u: w, v: h / 2 },
      { handle: 's', u: w / 2, v: h }, { handle: 'w', u: 0, v: h / 2 },
    ];
  }
```

(The `drawHandleSquare` draw loop in `view.onOverlay` just iterates
`.u`/`.v` for all 8 points regardless of order, so this reorder/rename
doesn't affect rendering.)

- [ ] **Step 7: Store the grabbed handle's name in `handleMoveDown`**

Find:

```js
      if (!float.frameIds) for (const a of handleAnchors(float)) {
        const p = toScreen(forwardPoint(float, a.u, a.v));
        if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) {
          moveStroke = { kind: 'scale', t0: { ...float.transform }, anchor: a };
          return;
        }
      }
```

Replace with:

```js
      if (!float.frameIds) for (const a of handleAnchors(float)) {
        const p = toScreen(forwardPoint(float, a.u, a.v));
        if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) {
          moveStroke = { kind: 'scale', t0: { ...float.transform }, handle: a.handle };
          return;
        }
      }
```

- [ ] **Step 8: Rewrite the `scale` branch in `handleMoveMove`**

Find:

```js
    } else { // scale, about the (fixed) float center, in the un-rotated frame
      const { srcRect } = float;
      const cx = srcRect.w / 2, cy = srcRect.h / 2;
      const cSheet = { x: srcRect.x + t0.tx + cx, y: srcRect.y + t0.ty + cy };
      const cos = Math.cos(t0.rot), sin = Math.sin(t0.rot);
      const dx = ev.x + 0.5 - cSheet.x, dy = ev.y + 0.5 - cSheet.y;
      const px = dx * cos + dy * sin;
      const py = -dx * sin + dy * cos;
      const hu = moveStroke.anchor.u - cx, hv = moveStroke.anchor.v - cy;
      const clampS = (s) => (s < 0 ? -1 : 1) * Math.max(0.01, Math.abs(s));
      float.transform = { ...t0 };
      if (hu !== 0) float.transform.sx = clampS(px / hu);
      if (hv !== 0) float.transform.sy = clampS(py / hv);
    }
```

Replace with:

```js
    } else { // scale
      float.transform = solveScaleTransform({
        srcRect: float.srcRect, t0, handle: moveStroke.handle,
        useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
        mx: ev.x + 0.5, my: ev.y + 0.5,
      });
    }
```

- [ ] **Step 9: Update tools.js's imports**

Find:

```js
import { forwardPoint, inversePoint, floatBounds } from '../core/floating.js';
```

Replace with:

```js
import { forwardPoint, inversePoint, floatBounds, solveScaleTransform } from '../core/floating.js';
```

(`HANDLES_ALL`, `isCenterAnchorModifier`, `isProportionalModifier`,
`resizeRectFromHandle` are already imported from `../core/resizeAnchor.js`
as of Task 4 — no change needed to that line.)

- [ ] **Step 10: Run the full suite and confirm no regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add js/ui/tools.js
git commit -m "feat: standardize float scale on resizeAnchor.js (corner-anchored by default, Alt=center)"
```

---

## Self-Review

**Spec coverage:**
- Modifier semantics table (default proportional/free per handle type,
  Alt=center, Shift flip, live per-move recompute) → `isAspectLocked`,
  `isCenterAnchorModifier`, `isProportionalModifier`, and every call site
  reading them fresh in `handleMove`/`handleMoveMove` (Tasks 1-5).
- Shared architecture (`resolveAnchor`, `isAspectLocked`,
  `dominantMagnitude`, `resizeRectFromHandle`) → Task 1, reused without
  restatement by Tasks 2-5.
- Frame/tile/selection integration → Tasks 2, 3, 4.
- Float rotation-aware solve, including the pivot-stays-fixed math → Task 5,
  with a dedicated rotated-case test.
- Configurability (named predicates, no inline `ev.altKey`/`ev.shiftKey`)
  → enforced throughout; `resizeAnchor.js` is the only place reading the
  raw event fields.
- `resizerect.js` retirement, test migration → Task 4.
- Out-of-scope items (grid/strip grow-shrink, frame/tile edge handles,
  float rotation gesture, settings UI, Playwright drag simulation) →
  untouched by every task; no plan step adds any of them.

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code.

**Type consistency:** `resizeRectFromHandle(orig, handle, px, py, opts)`
signature matches across Task 1's definition and Tasks 2/3/4's call sites.
`solveScaleTransform({ srcRect, t0, handle, useCenter, shiftHeld, mx, my })`
matches across Task 5's definition, its tests, and its tools.js call site.
Field names (`handle`, `useCenter`, `shiftHeld`, `target`, `inclusive`) are
consistent everywhere they appear.
