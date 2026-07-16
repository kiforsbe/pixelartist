# Floating Selection Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework content moving around a floating-selection engine: move-tool drags cut pixels into a floating buffer with live move/scale/rotate, committed on Enter/tool-switch (Escape cancels), plus an internal cut/copy/paste clipboard; the select tool becomes selection-only.

**Architecture:** New pure core module `js/core/floating.js` (float model, nearest-neighbor rasterizer). `state.floating` holds the single active float; `flattenSheet(sheet, floating)` composites it at its layer's z-position so every renderer shows it without bitmap mutation. New `js/ui/floatsession.js` owns the float lifecycle as stepwise commands on the main `CommandStack`; the move tool in `js/ui/tools.js` provides the pointer gestures.

**Tech Stack:** Vanilla ES modules, no dependencies. Tests: `node --test` (`npm test`). App served statically; browser verification via Playwright against `http://localhost:8080/?autotest`.

**Spec:** `docs/superpowers/specs/2026-07-16-floating-selection-design.md`

## Global Constraints

- No new dependencies, no build step.
- All rasterization is nearest-neighbor from the ORIGINAL float buffers (no cumulative resampling).
- Exactly 0 or 1 float exists at a time (`state.floating`).
- Every float lifecycle change is one command on `state.commands` (stepwise undo/redo).
- Alt is the all-layers modifier (drag start, Ctrl+Alt+X, Ctrl+Alt+C).
- Browser smoke verification is limited to selection/move-related behavior only (user instruction).
- Windows/PowerShell environment: no bash syntax in commands; `npm test` and `git` work as-is.

---

### Task 1: Plumbing — `blitOver`, pointer `altKey`, project-identity guard

**Files:**
- Modify: `js/core/pixels.js` (add `blitOver` after `blitRegion`, ~line 113)
- Modify: `js/ui/canvasview.js:244,258,269` (add `altKey` to pointer payloads)
- Modify: `js/ui/tools.js:228-238` (project-identity guard in `bindDrawing`'s `on('project')` cleanup)
- Test: `tests/pixels.blitover.test.mjs` (create)

**Interfaces:**
- Produces: `blitOver(dst, src, dx, dy)` — source-over alpha blend of bitmap `src` onto `dst` at offset (may be negative; out-of-bounds pixels skipped). Pointer events now carry `altKey: boolean`. `bindDrawing`'s selection/stroke reset now only fires when `state.project` object identity changes (markDirty's `'project'` emits no longer wipe selection).

- [ ] **Step 1: Write the failing test**

```js
// tests/pixels.blitover.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel, blitOver } from '../js/core/pixels.js';

test('opaque source pixel replaces destination', () => {
  const dst = createBitmap(4, 4), src = createBitmap(2, 2);
  setPixel(dst, 1, 1, [0, 0, 255, 255]);
  setPixel(src, 0, 0, [255, 0, 0, 255]);
  blitOver(dst, src, 1, 1);
  assert.deepEqual(getPixel(dst, 1, 1), [255, 0, 0, 255]);
});

test('transparent source pixel leaves destination untouched (unlike blitRegion)', () => {
  const dst = createBitmap(4, 4), src = createBitmap(2, 2);
  setPixel(dst, 2, 2, [0, 0, 255, 255]);
  blitOver(dst, src, 1, 1); // src all transparent
  assert.deepEqual(getPixel(dst, 2, 2), [0, 0, 255, 255]);
});

test('semi-transparent source blends source-over', () => {
  const dst = createBitmap(1, 1), src = createBitmap(1, 1);
  setPixel(dst, 0, 0, [0, 0, 0, 255]);
  setPixel(src, 0, 0, [255, 255, 255, 128]);
  blitOver(dst, src, 0, 0);
  const p = getPixel(dst, 0, 0);
  assert.equal(p[3], 255);
  assert.ok(p[0] > 120 && p[0] < 136, `blended red ${p[0]}`); // ~128
});

test('negative offsets and overflow are clipped safely', () => {
  const dst = createBitmap(2, 2), src = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(src, x, y, [9, 9, 9, 255]);
  blitOver(dst, src, -1, -1);
  assert.deepEqual(getPixel(dst, 0, 0), [9, 9, 9, 255]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `blitOver` is not exported.

- [ ] **Step 3: Implement `blitOver` in `js/core/pixels.js`** (after `blitRegion`)

```js
// Source-over alpha blend of `src` onto `dst` at (dx, dy) — unlike blitRegion
// (raw replace, transparent pixels erase), this composites: transparent source
// pixels leave dst untouched. Out-of-bounds writes are skipped.
export function blitOver(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const p = getPixel(src, x, y);
      if (!p || p[3] === 0) continue;
      const q = getPixel(dst, dx + x, dy + y);
      if (!q) continue;
      const sa = p[3] / 255, da = q[3] / 255;
      const oa = sa + da * (1 - sa);
      const mix = (sc, dc) => oa === 0 ? 0 : Math.round((sc * sa + dc * da * (1 - sa)) / oa);
      setPixel(dst, dx + x, dy + y, [mix(p[0], q[0]), mix(p[1], q[1]), mix(p[2], q[2]), Math.round(oa * 255)]);
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass (61 existing + 4 new).

- [ ] **Step 5: Add `altKey` to CanvasView pointer payloads**

In `js/ui/canvasview.js`, all three `this.onPointer({...})` calls (lines 244, 258, 269) gain `altKey: e.altKey` alongside the existing `shiftKey: e.shiftKey`:

```js
this.onPointer({ type: 'down', x: img.x, y: img.y, sx, sy, buttons: e.buttons, shiftKey: e.shiftKey, altKey: e.altKey });
```

(same for `'move'` and `'up'`).

- [ ] **Step 6: Project-identity guard in `bindDrawing`**

In `js/ui/tools.js`, replace the `on('project', ...)` block inside `bindDrawing` (lines 228–238):

```js
  // A project switch (New/Open) invalidates any selection or in-progress
  // stroke — bitmaps and layer ids from the old project are gone. Guard on
  // project IDENTITY: markDirty() also emits 'project' after every committed
  // command, and that must NOT wipe a live selection or pending float.
  let lastProject = state.project;
  on('project', () => {
    if (state.project === lastProject) return;
    lastProject = state.project;
    selection = null;
    stroke = null;
    selStroke = null;
    moveStroke = null;
    view.requestRender();
  });
```

Then in `handleMoveUp` (~line 625), the ordering workaround is obsolete: replace the `markDirty(); state.commands.push(cmd);` tail and its long comment with the normal order:

```js
    state.commands.push(cmd);
    markDirty();
```

(delete the 6-line comment above it that starts `// markDirty() (via the on('project', ...) cleanup above)`).

- [ ] **Step 7: Verify + commit**

Run: `npm test` → all pass.
```
git add -A; git commit -m "feat: blitOver, pointer altKey, project-identity guard for selection state"
```

---

### Task 2: `js/core/floating.js` — float model + rasterizer

**Files:**
- Create: `js/core/floating.js`
- Test: `tests/floating.test.mjs`

**Interfaces:**
- Consumes: `createBitmap`, `cloneBitmap`, `blitOver` from `js/core/pixels.js`.
- Produces (all exported from `js/core/floating.js`):
  - Float shape (plain object, held later in `state.floating`): `{ sheetId, srcRect: {x,y,w,h}, cut: bool, layers: [{layerId, buffer}], transform: {tx,ty,sx,sy,rot} }` — `buffer` is a `srcRect`-sized bitmap snapshot, treated as immutable; `rot` in radians; transform is about the buffer center.
  - `makeTransform() → {tx:0,ty:0,sx:1,sy:1,rot:0}`
  - `isIdentity(t) → bool`
  - `forwardPoint(float, u, v) → {x, y}` — buffer space → sheet space (float math, not rounded)
  - `inversePoint(float, x, y) → {u, v}` — sheet space → buffer space
  - `floatBounds(float) → {x, y, w, h}` — integer axis-aligned bbox in sheet space
  - `rasterizeFloat(float) → [{layerId, bitmap, x, y}]` — nearest-neighbor raster per layer, single-slot memoized on (float identity, transform values)
  - `compositeFloatOnLayer(layerBitmap, floating, layerId) → bitmap | null` — clone of `layerBitmap` with that layer's raster blended over, or null when `floating` is null / has no buffer for `layerId`

- [ ] **Step 1: Write the failing tests**

```js
// tests/floating.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTransform, isIdentity, floatBounds, rasterizeFloat, compositeFloatOnLayer,
} from '../js/core/floating.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

function makeFloat({ w = 4, h = 4, x = 2, y = 3, paint }) {
  const buffer = createBitmap(w, h);
  if (paint) paint(buffer);
  return {
    sheetId: 'sh1', srcRect: { x, y, w, h }, cut: true,
    layers: [{ layerId: 'ly1', buffer }], transform: makeTransform(),
  };
}

test('identity: bounds equal srcRect, raster round-trips the buffer', () => {
  const f = makeFloat({ paint: (b) => { setPixel(b, 1, 2, RED); } });
  assert.deepEqual(floatBounds(f), { x: 2, y: 3, w: 4, h: 4 });
  const [r] = rasterizeFloat(f);
  assert.equal(r.layerId, 'ly1');
  assert.deepEqual({ x: r.x, y: r.y }, { x: 2, y: 3 });
  assert.deepEqual(getPixel(r.bitmap, 1, 2), RED);
  assert.deepEqual(getPixel(r.bitmap, 0, 0), CLEAR);
});

test('translate: bounds and raster shift by (tx, ty)', () => {
  const f = makeFloat({ paint: (b) => setPixel(b, 0, 0, RED) });
  f.transform = { ...makeTransform(), tx: 5, ty: -2 };
  assert.deepEqual(floatBounds(f), { x: 7, y: 1, w: 4, h: 4 });
  const [r] = rasterizeFloat(f);
  assert.deepEqual(getPixel(r.bitmap, 0, 0), RED);
});

test('rotate 90°: asymmetric pattern lands rotated, bounds swap dimensions', () => {
  // 4x2 buffer, red at (0,0) (top-left)
  const buffer = createBitmap(4, 2);
  setPixel(buffer, 0, 0, RED);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 4, h: 2 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: { ...makeTransform(), rot: Math.PI / 2 } };
  const b = floatBounds(f);
  assert.deepEqual({ w: b.w, h: b.h }, { w: 2, h: 4 }); // 4x2 → 2x4
  const [r] = rasterizeFloat(f);
  // top-left of the buffer rotates to the top-right of the rotated raster
  assert.deepEqual(getPixel(r.bitmap, r.bitmap.width - 1, 0), RED);
});

test('scale 2x: nearest-neighbor duplicates each pixel into a 2x2 block', () => {
  const buffer = createBitmap(2, 2);
  setPixel(buffer, 0, 0, RED);
  setPixel(buffer, 1, 1, BLUE);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 2, h: 2 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: { ...makeTransform(), sx: 2, sy: 2 } };
  const b = floatBounds(f);
  assert.deepEqual({ w: b.w, h: b.h }, { w: 4, h: 4 });
  const [r] = rasterizeFloat(f);
  for (const [px, py] of [[0, 0], [1, 0], [0, 1], [1, 1]])
    assert.deepEqual(getPixel(r.bitmap, px, py), RED, `red block at ${px},${py}`);
  for (const [px, py] of [[2, 2], [3, 3]])
    assert.deepEqual(getPixel(r.bitmap, px, py), BLUE, `blue block at ${px},${py}`);
});

test('negative scale flips (pull-through)', () => {
  const buffer = createBitmap(2, 1);
  setPixel(buffer, 0, 0, RED);
  setPixel(buffer, 1, 0, BLUE);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 2, h: 1 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: { ...makeTransform(), sx: -1 } };
  const [r] = rasterizeFloat(f);
  assert.deepEqual(getPixel(r.bitmap, 0, 0), BLUE);
  assert.deepEqual(getPixel(r.bitmap, 1, 0), RED);
});

test('raster always resamples from the original buffer (no cumulative loss)', () => {
  const buffer = createBitmap(3, 3);
  setPixel(buffer, 1, 1, RED);
  const f = { sheetId: 's', srcRect: { x: 0, y: 0, w: 3, h: 3 }, cut: true,
    layers: [{ layerId: 'L', buffer }], transform: makeTransform() };
  f.transform = { ...f.transform, sx: 0.4, sy: 0.4 }; // shrink (lossy if baked)
  rasterizeFloat(f);
  f.transform = { ...f.transform, sx: 1, sy: 1 };      // back to identity
  const [r] = rasterizeFloat(f);
  assert.deepEqual(getPixel(r.bitmap, 1, 1), RED);     // undamaged
});

test('isIdentity + memo returns same result object for unchanged transform', () => {
  const f = makeFloat({});
  assert.equal(isIdentity(f.transform), true);
  f.transform = { ...f.transform, tx: 1 };
  assert.equal(isIdentity(f.transform), false);
  const a = rasterizeFloat(f);
  const b = rasterizeFloat(f);
  assert.equal(a, b); // memoized
});

test('compositeFloatOnLayer blends raster over a clone; null when no buffer for layer', () => {
  const layerBmp = createBitmap(8, 8);
  setPixel(layerBmp, 0, 0, BLUE);
  const f = makeFloat({ paint: (b) => setPixel(b, 0, 0, RED) }); // srcRect at (2,3)
  const out = compositeFloatOnLayer(layerBmp, f, 'ly1');
  assert.deepEqual(getPixel(out, 2, 3), RED);          // float pixel
  assert.deepEqual(getPixel(out, 0, 0), BLUE);         // untouched clone
  assert.deepEqual(getPixel(layerBmp, 2, 3), CLEAR);   // original NOT mutated
  assert.equal(compositeFloatOnLayer(layerBmp, f, 'nope'), null);
  assert.equal(compositeFloatOnLayer(layerBmp, null, 'ly1'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `js/core/floating.js` not found.

- [ ] **Step 3: Implement `js/core/floating.js`**

```js
// Floating selection model: pixels cut (or pasted) into per-layer buffers
// that hover over the sheet under a shared transform until committed.
//
// Float shape (held in state.floating, exactly 0 or 1 app-wide):
//   { sheetId, srcRect: {x,y,w,h}, cut, layers: [{layerId, buffer}],
//     transform: {tx, ty, sx, sy, rot} }
// `buffer` is a srcRect-sized bitmap snapshot treated as IMMUTABLE: every
// raster resamples nearest-neighbor from it via the inverse transform, so
// repeated transforms never degrade the pixels. The transform scales/rotates
// about the buffer center, then translates by (tx, ty) from srcRect.
import { createBitmap, cloneBitmap, blitOver } from './pixels.js';

// Absorbs float-math noise (cos(PI/2) ≈ 6e-17) so exact-looking transforms
// (90° rotations, integer scales) rasterize deterministically.
const EPS = 1e-6;

export function makeTransform() { return { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 }; }

export function isIdentity(t) {
  return t.tx === 0 && t.ty === 0 && t.sx === 1 && t.sy === 1 && t.rot === 0;
}

export function forwardPoint(float, u, v) {
  const { srcRect, transform: t } = float;
  const cx = srcRect.w / 2, cy = srcRect.h / 2;
  const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
  const dx = (u - cx) * t.sx, dy = (v - cy) * t.sy;
  return {
    x: srcRect.x + t.tx + cx + dx * cos - dy * sin,
    y: srcRect.y + t.ty + cy + dx * sin + dy * cos,
  };
}

export function inversePoint(float, x, y) {
  const { srcRect, transform: t } = float;
  const cx = srcRect.w / 2, cy = srcRect.h / 2;
  const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
  const dx = x - (srcRect.x + t.tx + cx);
  const dy = y - (srcRect.y + t.ty + cy);
  const rx = dx * cos + dy * sin;   // un-rotate
  const ry = -dx * sin + dy * cos;
  return { u: rx / t.sx + cx, v: ry / t.sy + cy };
}

export function floatBounds(float) {
  const { w, h } = float.srcRect;
  const pts = [
    forwardPoint(float, 0, 0), forwardPoint(float, w, 0),
    forwardPoint(float, 0, h), forwardPoint(float, w, h),
  ];
  const x0 = Math.floor(Math.min(...pts.map(p => p.x)) + EPS);
  const y0 = Math.floor(Math.min(...pts.map(p => p.y)) + EPS);
  const x1 = Math.ceil(Math.max(...pts.map(p => p.x)) - EPS);
  const y1 = Math.ceil(Math.max(...pts.map(p => p.y)) - EPS);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Single-slot memo: repaints during pan/zoom re-request the same raster many
// times per transform value; drags invalidate it by changing the transform.
let memo = null;

export function rasterizeFloat(float) {
  const t = float.transform;
  const key = `${t.tx},${t.ty},${t.sx},${t.sy},${t.rot}`;
  if (memo && memo.float === float && memo.key === key) return memo.result;
  const b = floatBounds(float);
  const result = float.layers.map(({ layerId, buffer }) => {
    const out = createBitmap(Math.max(1, b.w), Math.max(1, b.h));
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) {
        const { u, v } = inversePoint(float, b.x + x + 0.5, b.y + y + 0.5);
        const su = Math.floor(u + EPS), sv = Math.floor(v + EPS);
        if (su < 0 || sv < 0 || su >= buffer.width || sv >= buffer.height) continue;
        const i = (sv * buffer.width + su) * 4, o = (y * out.width + x) * 4;
        out.data[o] = buffer.data[i]; out.data[o + 1] = buffer.data[i + 1];
        out.data[o + 2] = buffer.data[i + 2]; out.data[o + 3] = buffer.data[i + 3];
      }
    return { layerId, bitmap: out, x: b.x, y: b.y };
  });
  memo = { float, key, result };
  return result;
}

export function compositeFloatOnLayer(layerBitmap, floating, layerId) {
  if (!floating) return null;
  const r = rasterizeFloat(floating).find(e => e.layerId === layerId);
  if (!r) return null;
  const out = cloneBitmap(layerBitmap);
  blitOver(out, r.bitmap, r.x, r.y);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass. If the rotate-90° test disagrees by one pixel column, the bug is a missing `EPS` in `floatBounds`/`rasterizeFloat` — do not weaken the test.

- [ ] **Step 5: Commit**

```
git add js/core/floating.js tests/floating.test.mjs; git commit -m "feat: floating-selection core model and nearest-neighbor rasterizer"
```

---

### Task 3: Float-aware rendering — `flattenSheet`, `state.floating`, all call sites, thumbnails

**Files:**
- Modify: `js/app/state.js:26` (add `floating: null` to state)
- Modify: `js/core/model.js:73-77` (`flattenSheet` optional `floating` param)
- Modify: `js/app/main.js:381` (scratch flatten passes `state.floating`)
- Modify: `js/ui/frameeditor.js:138`, `js/ui/tileeditor.js:156`, `js/ui/timeline.js:239`, `js/ui/tools.js:415` (pass `state.floating`)
- Modify: `js/ui/panels.js:502,559` (thumbnails composite the float)
- Test: `tests/flatten.floating.test.mjs`

**Interfaces:**
- Consumes: `compositeFloatOnLayer` from Task 2.
- Produces: `flattenSheet(sheet, floating = null)` — when `floating.sheetId === sheet.id`, each layer that has a float buffer is composited WITH its raster (source-over) before the layer's own opacity composite; z-order therefore correct. `state.floating` exists (null until Task 5 populates it).

- [ ] **Step 1: Write the failing test**

```js
// tests/flatten.floating.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSheet } from '../js/core/model.js';
import { makeTransform } from '../js/core/floating.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];

function sheetWith2Layers() {
  const l1 = { id: 'l1', visible: true, opacity: 1, bitmap: createBitmap(8, 8) };
  const l2 = { id: 'l2', visible: true, opacity: 1, bitmap: createBitmap(8, 8) };
  return { id: 'sh', width: 8, height: 8, layers: [l1, l2] };
}

function floatFor(layerId, color) {
  const buffer = createBitmap(2, 2);
  setPixel(buffer, 0, 0, color);
  return { sheetId: 'sh', srcRect: { x: 4, y: 4, w: 2, h: 2 }, cut: false,
    layers: [{ layerId, buffer }], transform: makeTransform() };
}

test('null floating: unchanged behavior', () => {
  const sheet = sheetWith2Layers();
  setPixel(sheet.layers[0].bitmap, 1, 1, RED);
  assert.deepEqual(getPixel(flattenSheet(sheet), 1, 1), RED);
  assert.deepEqual(getPixel(flattenSheet(sheet, null), 1, 1), RED);
});

test('float composites at its layer z-position (upper layer covers lower float)', () => {
  const sheet = sheetWith2Layers();
  setPixel(sheet.layers[1].bitmap, 4, 4, GREEN);   // upper layer opaque at (4,4)
  const flat = flattenSheet(sheet, floatFor('l1', RED)); // float on LOWER layer, same spot
  assert.deepEqual(getPixel(flat, 4, 4), GREEN);   // upper layer wins
});

test('float on upper layer shows over lower content', () => {
  const sheet = sheetWith2Layers();
  setPixel(sheet.layers[0].bitmap, 4, 4, GREEN);
  const flat = flattenSheet(sheet, floatFor('l2', RED));
  assert.deepEqual(getPixel(flat, 4, 4), RED);
});

test('hidden layer hides its float; other-sheet float ignored', () => {
  const sheet = sheetWith2Layers();
  sheet.layers[1].visible = false;
  assert.deepEqual(getPixel(flattenSheet(sheet, floatFor('l2', RED)), 4, 4), [0, 0, 0, 0]);
  const foreign = floatFor('l1', RED);
  foreign.sheetId = 'other';
  assert.deepEqual(getPixel(flattenSheet(sheet, foreign), 4, 4), [0, 0, 0, 0]);
});

test('layer opacity applies to float pixels too', () => {
  const sheet = sheetWith2Layers();
  sheet.layers[1].opacity = 0.5;
  const flat = flattenSheet(sheet, floatFor('l2', RED));
  const p = getPixel(flat, 4, 4);
  assert.ok(p[3] > 120 && p[3] < 136, `alpha ${p[3]} should be ~128`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `flattenSheet` ignores the second argument (z-position test fails or float pixel absent).

- [ ] **Step 3: Implement float-aware `flattenSheet`** in `js/core/model.js`

Add import at top: `import { compositeFloatOnLayer } from './floating.js';`
Replace `flattenSheet`:

```js
export function flattenSheet(sheet, floating = null) {
  const out = createBitmap(sheet.width, sheet.height);
  const hasFloat = floating && floating.sheetId === sheet.id;
  for (const l of sheet.layers) {
    if (!l.visible) continue;
    const withFloat = hasFloat ? compositeFloatOnLayer(l.bitmap, floating, l.id) : null;
    compositeOver(out, withFloat ?? l.bitmap, l.opacity);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Add `floating` to state + thread through call sites**

`js/app/state.js` — in the `state` object after `commands: new CommandStack(),` add:

```js
  floating: null,             // active floating selection (core/floating.js shape) or null
```

Call sites (each becomes `flattenSheet(sheet, state.floating)`; all files already import `state` except `js/core/model.js`, which must NOT — core stays state-free):
- `js/app/main.js:381` (scratch): `const bitmap = flattenSheet(sheet, state.floating);`
- `js/ui/frameeditor.js:138`: `flatBitmap = flattenSheet(sheet, state.floating);`
- `js/ui/tileeditor.js:156`: `flatBitmap = flattenSheet(sheet, state.floating);`
- `js/ui/timeline.js:239`: `flatBmp = flattenSheet(sheet, state.floating);`
- `js/ui/tools.js:415` (eyedropper): `const flat = flattenSheet(sheet, state.floating);`
- `js/app/main.js:624` (PNG export): leave as `flattenSheet(sheet)` — Task 5 auto-commits any float before export.

Thumbnails in `js/ui/panels.js` — add import `import { compositeFloatOnLayer } from '../core/floating.js';` and in BOTH `renderList()` (line 502) and `redrawThumbs()` (line 559) replace `drawFit(thumb, layer.bitmap)` / `drawFit(canvas, layer.bitmap)` with:

```js
      const fl = state.floating?.sheetId === sheet.id ? state.floating : null;
      drawFit(thumb, (fl && compositeFloatOnLayer(layer.bitmap, fl, layer.id)) || layer.bitmap);
```

(in `redrawThumbs` the canvas variable is `canvas`, guarded by `if (canvas)` — keep that guard).

- [ ] **Step 6: Verify + commit**

Run: `npm test` → all pass (no behavior change yet: `state.floating` is always null).
```
git add -A; git commit -m "feat: float-aware flattenSheet and render call sites"
```

---

### Task 4: Select tool becomes selection-only

**Files:**
- Modify: `js/ui/tools.js:428-501` (`handleSelectDown`/`handleSelectMove`/`handleSelectUp`)

**Interfaces:**
- Consumes: existing `insideRect`, `clampRectToTarget`, `selection`, `selStroke` locals in `bindDrawing`.
- Produces: dragging from inside the marquee translates the RECT only (shape preserved, clamped to the target rect); pixels are never touched; no undo command is pushed (marquee state has never been undo-tracked). The `mode: 'move'` content-drag path is deleted.

- [ ] **Step 1: Replace the three select handlers** in `js/ui/tools.js`

```js
  // ---- select (marquee only — the move tool is the only content mover) ----

  function insideRect(px, py, r) {
    return !!r && px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h;
  }

  function handleSelectDown(ev) {
    if (!activeLayer()) return;
    const target = getTargetRect();
    if (insideRect(ev.x, ev.y, selection)) {
      // drag the marquee rect itself — shape preserved, contents untouched
      selStroke = { mode: 'moverect', target, anchor: { x: ev.x, y: ev.y }, orig: { x: selection.x, y: selection.y } };
    } else {
      selection = null;
      selStroke = { mode: 'new', target, anchor: { x: ev.x, y: ev.y } };
    }
    view.requestRender();
  }

  function handleSelectMove(ev) {
    if (!selStroke) return;
    const target = selStroke.target;
    if (selStroke.mode === 'new') {
      const a = selStroke.anchor;
      const cx = Math.max(target.x, Math.min(target.x + target.w - 1, ev.x));
      const cy = Math.max(target.y, Math.min(target.y + target.h - 1, ev.y));
      const ax = Math.max(target.x, Math.min(target.x + target.w - 1, a.x));
      const ay = Math.max(target.y, Math.min(target.y + target.h - 1, a.y));
      const x0 = Math.min(ax, cx), x1 = Math.max(ax, cx);
      const y0 = Math.min(ay, cy), y1 = Math.max(ay, cy);
      selection = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    } else { // moverect
      const dx = ev.x - selStroke.anchor.x, dy = ev.y - selStroke.anchor.y;
      selection = clampRectToTarget(
        { x: selStroke.orig.x + dx, y: selStroke.orig.y + dy, w: selection.w, h: selection.h },
        target,
      );
    }
    view.requestRender();
  }

  function handleSelectUp(ev) {
    if (!selStroke) return;
    handleSelectMove(ev);
    if (selStroke.mode === 'new' && (!selection || selection.w <= 0 || selection.h <= 0)) selection = null;
    selStroke = null;
    view.requestRender();
  }
```

Notes: `clampRectToTarget` already exists (line ~533) but is defined below the select handlers — it's function-declaration hoisted within `bindDrawing`, so referencing it here is fine. The old handlers' `cloneBitmap/copyRegion/fillRegion/blitRegion` content-move code and their `emit('pixels')` calls are all removed (a rect change needs only `view.requestRender()`).

- [ ] **Step 2: Verify**

Run: `npm test` → all pass (select handlers have no node coverage; this catches import/syntax errors).

Browser check (scoped): serve, open `http://localhost:8080/?autotest`, then with Playwright: draw pixels with pencil, select tool `M`, drag a marquee over them, drag from inside it — assert via `browser_evaluate` that the flattened pixel at the original location is UNCHANGED and the marquee rect moved (the overlay is view-local; assert pixels via `flattenSheet` import and rect via dragging again from the new location). No console errors.

- [ ] **Step 3: Commit**

```
git add js/ui/tools.js; git commit -m "fix: select tool only selects; marquee drag moves the rect, not contents"
```

---

### Task 5: `js/ui/floatsession.js` — lifecycle commands, view registry, keys, auto-commit

**Files:**
- Create: `js/ui/floatsession.js`
- Modify: `js/ui/tools.js` (bindDrawing registers its view; `isTypingTarget` moves to floatsession; Escape guard)
- Modify: `js/app/main.js` (init call; `viewKind` args; save/export commit hooks; autosave skip)
- Modify: `js/ui/frameeditor.js:128`, `js/ui/tileeditor.js:145` (`viewKind`/`unmapPoint` args)

**Interfaces:**
- Consumes: Task 2 exports; `state`, `on`, `emit`, `activeSheet`, `activeLayer`, `markDirty` from state.js; pixels.js helpers.
- Produces (exported from `js/ui/floatsession.js`):
  - `registerFloatView(viewKind, { getSelection, setSelection, getTargetRect })` — called by `bindDrawing`; `viewKind` ∈ `'sheet' | 'frame' | 'tile'` matching `state.view`.
  - `createFloat({ allLayers }) → bool` — cut the active view's selection (or whole target) into `state.floating`; pushes a `'float selection'` command.
  - `commitFloatIfAny()` — pushes `'commit float'` (raster composited into layers, clamped to the creation-time target rect; selection = committed bbox). Identity-transform cut floats degrade to `cancelFloatIfAny()`.
  - `cancelFloatIfAny()` — pushes `'cancel float'` (buffers restored to srcRect for cut floats; paste floats just disappear; selection = srcRect for cut floats).
  - `pushTransformCommand(before, after)` — no-op when equal; else `'transform float'` command.
  - `cutSelection(allLayers)`, `copySelection(allLayers)`, `pasteClipboard()`.
  - `initFloatSession()` — installs auto-commit hooks + the capture-phase keydown (Enter/Escape/Ctrl+X/C/V). Called once from main.js.
  - `isTypingTarget(el)` — moved here from tools.js (tools.js re-imports it; floatsession must never import tools.js — that would be a cycle).
- `bindDrawing(view, getTargetRect, mapPoint, viewKind = 'sheet', unmapPoint = null)` — new params. `unmapPoint(x, y)` maps sheet-global → view-local content coords (inverse of `mapPoint`), used by overlay drawing in Task 6.

- [ ] **Step 1: Create `js/ui/floatsession.js`**

```js
// Floating-selection session: owns state.floating's lifecycle (create /
// transform / commit / cancel), the internal clipboard, and the global
// keyboard bindings (Enter/Escape commit/cancel, Ctrl+X/C/V clipboard).
// Pointer GESTURES (drag/scale/rotate) live in tools.js's move tool; every
// state change funnels through here so stepwise undo and auto-commit stay
// consistent. This module must never import tools.js (tools.js imports us).
import { state, on, emit, activeSheet, activeLayer, markDirty } from '../app/state.js';
import { copyRegion, fillRegion, blitRegion, blitOver, cloneBitmap, createBitmap } from '../core/pixels.js';
import { makeTransform, isIdentity, rasterizeFloat, floatBounds } from '../core/floating.js';

const views = new Map(); // viewKind ('sheet'|'frame'|'tile') -> {getSelection, setSelection, getTargetRect}
let floatCtx = null;     // { viewKind, targetRect } frozen at float creation (frame-editor confinement)
let clipboard = null;    // { srcRect, layers: [{layerId, buffer}] }

export function registerFloatView(viewKind, api) { views.set(viewKind, api); }
function activeView() { return views.get(state.view) ?? null; }
function sheetById(id) { return state.project?.sheets.find(s => s.id === id) ?? null; }
function layerIn(sheet, layerId) { return sheet.layers.find(l => l.id === layerId) ?? null; }

export function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

function rectIntersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

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

function captureLayers(sheet, region, allLayers) {
  const layers = allLayers ? sheet.layers.slice() : (activeLayer() ? [activeLayer()] : []);
  return layers.map(l => ({
    layerId: l.id,
    buffer: copyRegion(l.bitmap, region.x, region.y, region.w, region.h),
  }));
}

export function createFloat({ allLayers = false } = {}) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return false;
  const rr = resolveRegion(viewApi);
  if (!rr) return false;
  const { region, target } = rr;
  const captured = captureLayers(sheet, region, allLayers);
  if (!captured.length) return false;
  const float = {
    sheetId: sheet.id, srcRect: { ...region }, cut: true,
    layers: captured, transform: makeTransform(),
  };
  const ctx = { viewKind: state.view, targetRect: { ...target } };
  const prevSelection = viewApi.getSelection();
  state.commands.push({
    label: 'float selection',
    do() {
      for (const { layerId } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, region.x, region.y, region.w, region.h, [0, 0, 0, 0]);
      }
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null); // float outline replaces the marquee
      emit('pixels');
    },
    undo() {
      for (const { layerId, buffer } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, region.x, region.y);
      }
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(prevSelection ? { ...prevSelection } : null);
      emit('pixels');
    },
  });
  markDirty();
  return true;
}

export function commitFloatIfAny() {
  const float = state.floating;
  if (!float) return;
  const ctx = floatCtx;
  const sheet = sheetById(float.sheetId);
  if (!sheet || !ctx) { state.floating = null; floatCtx = null; return; }
  // Untouched cut float: committing would restore the source exactly —
  // degrade to cancel so history gets one clean reversal, not a no-op patch.
  if (float.cut && isIdentity(float.transform)) { cancelFloatIfAny(); return; }

  const rect = rectIntersect(floatBounds(float), ctx.targetRect); // confinement
  const patches = [];
  if (rect) {
    for (const r of rasterizeFloat(float)) {
      const layer = layerIn(sheet, r.layerId);
      if (!layer) continue;
      const before = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
      const after = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
      blitOver(after, r.bitmap, r.x - rect.x, r.y - rect.y);
      patches.push({ layer, before, after });
    }
  }
  const sel = rect ? { ...rect } : null;
  state.commands.push({
    label: 'commit float',
    do() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, rect.x, rect.y);
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(sel ? { ...sel } : null);
      emit('pixels');
    },
    undo() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, rect.x, rect.y);
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null);
      emit('pixels');
    },
  });
  markDirty();
}

export function cancelFloatIfAny() {
  const float = state.floating;
  if (!float) return;
  const ctx = floatCtx;
  const sheet = sheetById(float.sheetId);
  if (!sheet || !ctx) { state.floating = null; floatCtx = null; return; }
  state.commands.push({
    label: 'cancel float',
    do() {
      if (float.cut) for (const { layerId, buffer } of float.layers) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, float.srcRect.x, float.srcRect.y);
      }
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(float.cut ? { ...float.srcRect } : null);
      emit('pixels');
    },
    undo() {
      if (float.cut) for (const { layerId } of float.layers) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, float.srcRect.x, float.srcRect.y, float.srcRect.w, float.srcRect.h, [0, 0, 0, 0]);
      }
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null);
      emit('pixels');
    },
  });
  markDirty();
}

export function pushTransformCommand(before, after) {
  const float = state.floating;
  if (!float) return;
  if (before.tx === after.tx && before.ty === after.ty && before.sx === after.sx
    && before.sy === after.sy && before.rot === after.rot) return;
  state.commands.push({
    label: 'transform float',
    do() { float.transform = { ...after }; emit('pixels'); },
    undo() { float.transform = { ...before }; emit('pixels'); },
  });
  // no markDirty: bitmaps unchanged; state.dirty is already true from creation
}

// ---- clipboard ----

function clipboardCapture(allLayers, clearSource) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const rr = resolveRegion(viewApi, true); // cut/copy require a marquee
  if (!rr) return;
  const { region } = rr;
  const captured = captureLayers(sheet, region, allLayers);
  if (!captured.length) return;
  clipboard = { srcRect: { ...region }, layers: captured };
  if (!clearSource) return;
  state.commands.push({
    label: 'cut',
    do() {
      for (const { layerId } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, region.x, region.y, region.w, region.h, [0, 0, 0, 0]);
      }
      emit('pixels');
    },
    undo() {
      for (const { layerId, buffer } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, region.x, region.y);
      }
      emit('pixels');
    },
  });
  markDirty();
}

export function cutSelection(allLayers = false) { clipboardCapture(allLayers, true); }
export function copySelection(allLayers = false) { clipboardCapture(allLayers, false); }

export function pasteClipboard() {
  if (!clipboard) return;
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const target = viewApi.getTargetRect();
  if (target.w <= 0 || target.h <= 0) return;
  const { srcRect } = clipboard;
  // land on the source position while it still intersects the target,
  // otherwise centered in the target
  const pos = rectIntersect(srcRect, target)
    ? { x: srcRect.x, y: srcRect.y }
    : { x: target.x + Math.floor((target.w - srcRect.w) / 2), y: target.y + Math.floor((target.h - srcRect.h) / 2) };
  // buffers reattach to their original layers when those still exist;
  // otherwise flatten them (captured z-order) onto the active layer
  let layers = clipboard.layers
    .filter(e => layerIn(sheet, e.layerId))
    .map(e => ({ layerId: e.layerId, buffer: cloneBitmap(e.buffer) }));
  if (!layers.length) {
    const flat = createBitmap(srcRect.w, srcRect.h);
    for (const e of clipboard.layers) blitOver(flat, e.buffer, 0, 0);
    const al = activeLayer();
    if (!al) return;
    layers = [{ layerId: al.id, buffer: flat }];
  }
  const float = {
    sheetId: sheet.id, srcRect: { x: pos.x, y: pos.y, w: srcRect.w, h: srcRect.h },
    cut: false, layers, transform: makeTransform(),
  };
  const ctx = { viewKind: state.view, targetRect: { ...target } };
  const prevSelection = viewApi.getSelection();
  // switch to the move tool BEFORE pushing: the on('tool') auto-commit hook
  // skips 'move', so the fresh float survives its own tool switch
  if (state.tool !== 'move') { state.tool = 'move'; emit('tool'); }
  state.commands.push({
    label: 'paste',
    do() {
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null);
      emit('pixels');
    },
    undo() {
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(prevSelection ? { ...prevSelection } : null);
      emit('pixels');
    },
  });
}

// ---- auto-commit hooks + keyboard ----

function onKeydown(e) {
  if (document.querySelector('dialog[open]')) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (key === 'x') { e.preventDefault(); cutSelection(e.altKey); return; }
    if (key === 'c') { e.preventDefault(); copySelection(e.altKey); return; }
    if (key === 'v') { e.preventDefault(); pasteClipboard(); return; }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !state.floating) return;
  // capture-phase + stopImmediatePropagation: Escape must cancel the float
  // WITHOUT also exiting the frame editor or clearing a marquee (their own
  // window listeners run in the bubble phase)
  if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); commitFloatIfAny(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelFloatIfAny(); }
}

export function initFloatSession() {
  on('tool', () => { if (state.tool !== 'move') commitFloatIfAny(); });
  on('view', () => {
    if (!state.floating || !floatCtx) return;
    if (state.activeSheetId !== state.floating.sheetId || state.view !== floatCtx.viewKind) commitFloatIfAny();
  });
  // project REPLACEMENT (New/Open) drops the float without a command — the
  // command stack was cleared and the old bitmaps are gone
  let lastProject = state.project;
  on('project', () => {
    if (state.project === lastProject) return;
    lastProject = state.project;
    state.floating = null;
    floatCtx = null;
  });
  window.addEventListener('keydown', onKeydown, true);
}
```

- [ ] **Step 2: Wire registration + init**

`js/ui/tools.js`:
- Remove the local `isTypingTarget` (lines 69–73); add `import { registerFloatView, isTypingTarget } from './floatsession.js';`
- `bindDrawing` signature: `export function bindDrawing(view, getTargetRect, mapPoint, viewKind = 'sheet', unmapPoint = null)`. First lines of the body add:

```js
  registerFloatView(viewKind, {
    getSelection: () => (selection ? { ...selection } : null),
    setSelection: (r) => { selection = r ? { ...r } : null; view.requestRender(); },
    getTargetRect,
  });
```

- In the window Escape handler at the bottom of `bindDrawing` (line ~684), add a float guard as the first check inside the handler:

```js
    if (state.floating) return; // floatsession's capture handler owns Escape while floating
```

`js/ui/frameeditor.js:128`: `bindDrawing(view, getTargetRect, mapPoint, 'frame', unmapPoint);` where next to the existing `mapPoint` definition add the inverse (frame-local ↔ sheet-global; mirror the exact offsets `mapPoint` uses — if `mapPoint` is `(x, y) => ({ x: x + f.x, y: y + f.y })` then):

```js
  const unmapPoint = (x, y) => { const f = frame(); return { x: x - f.x, y: y - f.y }; };
```

(read the file's actual `mapPoint` and invert precisely — same accessor it uses for the frame rect).

`js/ui/tileeditor.js:145`: same pattern — `bindDrawing(view, getTargetRect, mapPoint, 'tile', unmapPoint)` with `unmapPoint` inverting its `mapPoint` offsets.

`js/app/main.js`:
- `import { initFloatSession, commitFloatIfAny } from '../ui/floatsession.js';`
- After `bindDrawing(canvasView, ...)` (line ~419) nothing extra (default `viewKind` `'sheet'`).
- Call `initFloatSession();` once, right after `mountToolPalette(...)`/`bindDrawing` setup.
- `doSave()` (line 559): first line becomes `commitFloatIfAny();`
- Both Save As handlers (lines 581, 594): `commitFloatIfAny();` as first statement inside the try-preceding body (right after `dlgSaveAs.close();`).
- All three export handlers (lines 620, 628, 636): `commitFloatIfAny();` right after `dlgExport.close();`.
- Autosave (line 652): `if (state.dirty && state.project && !state.floating) io.autosave(state.project).catch(() => {});`

- [ ] **Step 3: Verify + commit**

Run: `npm test` → all pass.
Browser check (scoped): load `?autotest`; in `browser_evaluate` import `floatsession.js`, call `createFloat({})` with the move tool NOT involved (directly), assert `state.floating` set, source region cleared, undo restores, redo re-floats; `commitFloatIfAny()` clears it; Escape/Enter keys via dispatched KeyboardEvent. No console errors.

```
git add -A; git commit -m "feat: floatsession lifecycle commands, clipboard, auto-commit hooks"
```

---

### Task 6: Move tool gestures + overlay handles

**Files:**
- Modify: `js/ui/tools.js` — replace `handleMoveDown/Move/Up` (lines ~539-633) and `view.onOverlay` (lines ~667-682); remove the now-unused `shiftRegion` import and `moveBounds` helper; remove the "All layers" checkbox row (lines 147-154, 164) — Alt replaces it.

**Interfaces:**
- Consumes: `createFloat`, `commitFloatIfAny`, `pushTransformCommand` from floatsession; `forwardPoint`, `inversePoint` from `core/floating.js`; `state.floating`; pointer `altKey`/`sx`/`sy`; `unmapPoint` param from Task 5.
- Produces: move tool = float gestures only. `moveStroke` local becomes `{ kind: 'translate'|'scale'|'rotate', t0, ... }`. Overlay renders the float outline + 8 scale handles + rotation knob when floating, marquee ants otherwise (both mapped through `unmapPoint` so the frame/tile editors draw them correctly).

- [ ] **Step 1: Replace the move-tool section** (everything from the `// ---- move ----` comment through `handleMoveUp`, KEEPING `rectClamp` and `clampRectToTarget` which the select tool still uses; `moveBounds` is deleted):

```js
  // ---- move (floating selection) ----
  //
  // The move tool never edits bitmaps directly: pointer-down cuts the region
  // into state.floating (floatsession command), and every gesture only
  // mutates float.transform live, pushing one transform command per completed
  // drag. Enter/Escape/tool-switch commit or cancel via floatsession.

  const HANDLE_PX = 5;    // half-size of a scale handle hit box, screen px
  const KNOB_OFFSET = 20; // rotation knob distance beyond top-center, screen px
  const KNOB_R = 7;

  // sheet-global point -> screen px (view content space may be frame/tile-local)
  function toScreen(p) {
    const q = unmapPoint ? unmapPoint(p.x, p.y) : p;
    return view.imageToScreen(q.x, q.y);
  }

  // 4 corners + 4 edge midpoints in buffer space
  function handleAnchors(float) {
    const { w, h } = float.srcRect;
    return [
      { u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h },
      { u: w / 2, v: 0 }, { u: w, v: h / 2 }, { u: w / 2, v: h }, { u: 0, v: h / 2 },
    ];
  }

  function floatCenter(float) {
    return forwardPoint(float, float.srcRect.w / 2, float.srcRect.h / 2);
  }

  function knobScreenPos(float) {
    const pTop = toScreen(forwardPoint(float, float.srcRect.w / 2, 0));
    const pC = toScreen(floatCenter(float));
    const dx = pTop.x - pC.x, dy = pTop.y - pC.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: pTop.x + (dx / len) * KNOB_OFFSET, y: pTop.y + (dy / len) * KNOB_OFFSET };
  }

  function handleMoveDown(ev) {
    const sheet = activeSheet();
    if (!sheet) return;
    const float = state.floating;
    if (float && float.sheetId === sheet.id) {
      const knob = knobScreenPos(float);
      if (Math.hypot(ev.sx - knob.x, ev.sy - knob.y) <= KNOB_R + 2) {
        const c = floatCenter(float);
        moveStroke = {
          kind: 'rotate', t0: { ...float.transform },
          center: c, angle0: Math.atan2(ev.y + 0.5 - c.y, ev.x + 0.5 - c.x),
        };
        return;
      }
      for (const a of handleAnchors(float)) {
        const p = toScreen(forwardPoint(float, a.u, a.v));
        if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) {
          moveStroke = { kind: 'scale', t0: { ...float.transform }, anchor: a };
          return;
        }
      }
      const { u, v } = inversePoint(float, ev.x + 0.5, ev.y + 0.5);
      if (u >= 0 && v >= 0 && u < float.srcRect.w && v < float.srcRect.h) {
        moveStroke = { kind: 'translate', t0: { ...float.transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
      commitFloatIfAny(); // pressed outside: commit; next press starts fresh
      return;
    }
    // no float yet: cut selection (or whole target) into one, then drag it
    if (!createFloat({ allLayers: !!ev.altKey })) return;
    moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
  }

  function handleMoveMove(ev) {
    if (!moveStroke || !state.floating) return;
    const float = state.floating;
    const t0 = moveStroke.t0;
    if (moveStroke.kind === 'translate') {
      float.transform.tx = t0.tx + Math.round(ev.x - moveStroke.anchor.x);
      float.transform.ty = t0.ty + Math.round(ev.y - moveStroke.anchor.y);
    } else if (moveStroke.kind === 'rotate') {
      const c = moveStroke.center;
      float.transform.rot = t0.rot + (Math.atan2(ev.y + 0.5 - c.y, ev.x + 0.5 - c.x) - moveStroke.angle0);
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
    emit('pixels');
  }

  function handleMoveUp(ev) {
    if (!moveStroke) return;
    handleMoveMove(ev);
    const t0 = moveStroke.t0;
    moveStroke = null;
    if (state.floating) pushTransformCommand(t0, { ...state.floating.transform });
  }
```

Imports at the top of tools.js: add `forwardPoint`, `inversePoint` to the `core/floating.js` import (create it), add `createFloat, commitFloatIfAny, pushTransformCommand` to the floatsession import; DELETE the `shiftRegion` import (`js/core/moveregion.js` stays — it has tests — but tools.js no longer uses it).

- [ ] **Step 2: Replace `view.onOverlay`**

```js
  view.onOverlay = (ctx) => {
    const float = state.floating;
    const sheet = activeSheet();
    if (float && sheet && float.sheetId === sheet.id && state.tool === 'move') {
      const { w, h } = float.srcRect;
      const corners = [[0, 0], [w, 0], [w, h], [0, h]]
        .map(([u, v]) => toScreen(forwardPoint(float, u, v)));
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (const [color, off] of [['#fff', 0], ['#000', 4]]) {
        ctx.strokeStyle = color;
        ctx.lineDashOffset = off;
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(p.x + 0.5, p.y + 0.5) : ctx.moveTo(p.x + 0.5, p.y + 0.5)));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const a of handleAnchors(float)) {
        const p = toScreen(forwardPoint(float, a.u, a.v));
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.fillRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
        ctx.strokeRect(p.x - HANDLE_PX + 0.5, p.y - HANDLE_PX + 0.5, HANDLE_PX * 2 - 1, HANDLE_PX * 2 - 1);
      }
      const knob = knobScreenPos(float);
      const top = toScreen(forwardPoint(float, w / 2, 0));
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(knob.x, knob.y); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc(knob.x, knob.y, KNOB_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
      return;
    }
    if (!selection) return;
    const p0 = toScreen({ x: selection.x, y: selection.y });
    const p1 = toScreen({ x: selection.x + selection.w, y: selection.y + selection.h });
    ctx.save();
    ctx.lineWidth = 1;
    const rw = p1.x - p0.x, rh = p1.y - p0.y;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 0;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, rw - 1, rh - 1);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = 4;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, rw - 1, rh - 1);
    ctx.restore();
  };
```

(Note: the marquee branch now routes through `toScreen` — this also fixes the pre-existing frame-editor marquee offset bug, since `selection` is sheet-global but the editor's `imageToScreen` expects frame-local coords.)

- [ ] **Step 3: Remove the "All layers" checkbox** from `mountToolPalette` (the `allLayersRow` block, lines 147-154, the `allLayersRow.style.display` line in `refresh()` (line 164), and `allLayers: false` from `toolOptions` (line 41)).

- [ ] **Step 4: Verify (browser, scoped to move/float) + npm test**

Run: `npm test` → all pass.
Playwright against `?autotest`, all steps asserting via `state`/`flattenSheet` reads and zero console errors:
1. Pencil-draw pixels; move tool `V`; drag → `state.floating` set, source hole visible in flatten, float follows.
2. Enter → committed at new spot; `Ctrl+Z` ×3 steps back through commit → transform → float; `Ctrl+Y` forward again.
3. New drag then Escape → pixels restored exactly.
4. Scale via corner-handle drag (dispatch pointer events at handle's screen pos) → `transform.sx/sy` change; rotate via knob → `rot` changes; commit → flatten shows transformed pixels.
5. Alt+drag with 2 layers → `state.floating.layers.length === 2`.
6. Frame editor: float a region, drag partially outside the frame, Enter → committed pixels clipped to frame rect.

- [ ] **Step 5: Commit**

```
git add -A; git commit -m "feat: move tool floats selections with move/scale/rotate handles"
```

---

### Task 7: Clipboard browser verification (cut/copy/paste)

The clipboard implementation shipped in Task 5; this task verifies it end-to-end in the browser and fixes anything found. (Kept separate so Task 6's gesture work lands first — paste switches to the move tool and needs its overlay.)

**Files:**
- Modify (fixes only, if verification finds issues): `js/ui/floatsession.js`

- [ ] **Step 1: Browser verification (scoped)** — Playwright on `?autotest`:
1. Draw, marquee-select, `Ctrl+C`, `Ctrl+V` → float created (`cut: false`), source intact, tool switched to move; drag elsewhere; Enter → both copies present.
2. `Ctrl+X` → source cleared, one undo step restores it; `Ctrl+V` after panning selection elsewhere → pastes at source position; Enter.
3. `Ctrl+Alt+C` with 2 layers → paste creates a 2-buffer float; commit affects both layers.
4. Delete the captured layer (via Layers panel) then `Ctrl+V` → buffers flatten onto the active layer.
5. Undo chain: paste-undo removes float, cut-undo restores pixels. Zero console errors.

- [ ] **Step 2: Commit (only if fixes were needed)**

```
git add -A; git commit -m "fix: clipboard verification fixes"
```

---

### Task 8: Docs + final verification

**Files:**
- Modify: `README.md` (tools table, editing shortcuts), `tests/smoke.md` (items 10, 64-67 rewritten; new items; pass count)

**Interfaces:** none (docs).

- [ ] **Step 1: README updates**

Tools table — replace the `M` and `V` rows:

```markdown
| `M` | Select (marquee) — selection only: dragging from inside the marquee moves the rectangle (shape preserved), never the pixels |
| `V` | Move (✋) — cuts the selection (or whole layer if none) into a floating selection with move/scale/rotate handles; hold `Alt` at drag start to float all layers. Nothing is rendered to the image until committed |
```

Editing table — add rows:

```markdown
| `Enter` | Commit the floating selection (render it to the layer(s)); switching tools/sheets/views also commits |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut / copy the marquee selection to the internal clipboard / paste as a new floating selection (`+Alt`: all layers) |
```

Update the `Escape` row to: `Clear the active marquee selection, or cancel a pending floating selection (restores the cut-out pixels); back out of the frame editor or tile editor to the sheet view`.

Add a short paragraph after the shortcuts section:

```markdown
## Floating selections

The move tool never edits pixels directly. Dragging cuts the selection (or
the whole layer) into a floating selection — outlined with scale handles and
a rotation knob — that hovers over the image. Move, scale, and rotate it
freely (always resampled nearest-neighbor from the original pixels), then
commit with `Enter` (or by switching tool/sheet/view) or cancel with
`Escape`. Every step (float, each transform, commit/cancel, cut, paste) is
individually undoable. In the frame/tile editors, committed pixels are
clipped to the frame/tile rect.
```

- [ ] **Step 2: smoke.md updates (ONLY selection/move areas)**

Item 10 becomes:

```markdown
10. [A] Select tool (`M`): drag a marquee; dragging from inside it moves the
    RECTANGLE only (contents stay put — verify pixels unchanged); `Escape`
    clears the marquee.
```

Items 64–67 (section 16) become:

```markdown
64. [A] Move tool (✋, `V`), no marquee: drag on the canvas — the whole
    target region floats (source hole appears, outline + handles shown);
    the layer bitmap is NOT modified beyond the source cut until commit.
    `Enter` commits at the new position; stepwise undo: Ctrl+Z undoes the
    commit, then the drag, then the float itself.
65. [A] Move tool with a marquee: only the selected region floats; drag,
    then `Escape` — pixels restored exactly to the original spot.
66. [A] Transform handles: drag a corner handle (scale, incl. pull-through
    flip), drag the rotation knob (free rotate); commit renders the
    nearest-neighbor result; each completed drag is one undo step.
67. [A] `Alt`+drag floats ALL layers (one buffer per layer); commit writes
    each layer; single-layer default otherwise. In the frame editor a
    committed float is clipped to the frame rect.
```

Append after 68:

```markdown
69. [A] Clipboard: `Ctrl+C` copies the marquee selection, `Ctrl+V` pastes a
    floating copy (source intact) that commits on `Enter` or tool switch.
    `Ctrl+X` cuts (one undo step); `Ctrl+Alt+C`/`Ctrl+Alt+X` capture all
    layers. Paste lands at the source position when visible, else centered.
70. [A] Auto-commit: with a float pending, pressing `B` (pencil) commits it
    first; switching sheets or opening the frame editor also commits.
```

Update the pass-criteria test count to the number `npm test` actually reports after all tasks (expect 61 + ~13 new = run and read the real number).

- [ ] **Step 3: Final verification**

Run: `npm test` → all pass; note the count.
Browser: run smoke items 10 and 64–70 (the changed area only, per user instruction). Zero console errors.

- [ ] **Step 4: Commit**

```
git add -A; git commit -m "feat: floating-selection docs; smoke items for select/move/clipboard"
```
