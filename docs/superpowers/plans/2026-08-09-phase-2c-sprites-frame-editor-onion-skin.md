# Phase 2c: Sprites Frame Editor + Onion Skin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `js/ui/frameeditor.js` (the frame editor's zoomed-in single-frame view with onion-skin ghosting) onto the DDD Application/Presentation split established in Phases 2a/2b, extracting the onion-skin and frame-navigation math into pure, unit-tested Application functions and porting the rest as a `presentation/frame-editor-presenter.js` Humble Object.

**Architecture:** Per `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`, pure decision-making logic (which ghost frames to draw, at what tint; the edge-detection trace behind Outline mode; which frame Prev/Next lands on) moves to `js/modes/sprites/application/` as plain functions taking explicit parameters — no legacy `state`, no Canvas/DOM. Everything that stays Canvas/DOM-bound (the second `CanvasView` instance, ghost-canvas caching/compositing, `bindDrawing` integration, show/hide lifecycle, keyboard handling) ports unchanged into `js/modes/sprites/presentation/frame-editor-presenter.js`.

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test`/`node:assert`, no build step, `npm test` runs the full suite.

## Global Constraints

- **No new Command Handlers this phase.** Unlike 2a/2b, onion-skin preferences bypass the undo stack entirely (the original file's own comment: "Onion prefs are a display setting, not editing history... none of this is pushed through state.commands") and `state.editingFrameId`/`state.view` navigation stays legacy ephemeral UI state, read/written exactly as before — selection unification onto `SelectionService` remains deferred to sub-phase 2d, same as 2a/2b.
- `state.onion` stays aliased directly to `project.settings.onion` (`js/app/state.js:117`, confirmed) — untouched by this phase. `js/features/project/project-controller.js`'s "Onion Steps" Project Settings page is a co-owner of `state.onion.stepColors`/`.backColor`/`.aheadColor` and is **explicitly OUT OF SCOPE** — do not touch it. The frame editor's only coupling to it is the loosely-coupled `runAction('edit.onionStepColors')` action-id dispatch, which must keep working unchanged.
- `mountFrameEditor(hostEl)`'s return contract `{ show, hide, view }` must be preserved exactly byte-for-byte in shape — it is consumed by `js/features/workbench/editor-workbench.js` (`frameEditor.show()`, `frameEditor.hide()`, `frameEditor.view`) and registered as the `sprites.frame` view's `create` in `contributions.js`. Neither call site changes in this phase except the import path.
- `CanvasView` (`js/ui/canvasview.js`), `bindDrawing` (`js/ui/tools.js`), `commitFloatIfAny` (`js/ui/floatsession.js`), `flattenSheetLayers` (`js/core/model.js`), `copyRegion` (`js/core/pixels.js`), `runAction` (`js/app/actions.js`) are shared, out-of-scope modules — import only, never modify.
- Pure Application functions never construct a real `ImageData` (unavailable in plain Node) — `traceOutline` returns a plain `{ width, height, data: Uint8ClampedArray }` bitmap, matching `core/pixels.js`'s `copyRegion()` convention; the Presenter wraps it in `new ImageData(...)` at the point of canvas use.
- `tests/architecture.test.mjs`'s banned-globals scan (`js/modes/*/application/**`) and dispatch-by-id-only scan (`js/modes/*/presentation/**`) are generic glob scans that automatically cover any new file under those directories — no enumerated-list edits are needed this phase (unlike 2a/2b's command-file lists).
- No dedicated automated test exists for the ported Presenter file itself (Canvas/DOM-heavy, same as `timeline-presenter.js`/`animations-panel.js` in Phase 2b) — verified via the full `npm test` run plus the manual verification checklist at the end of this plan.
- Follow the established façade-free pattern: this Presenter dispatches nothing (no Commands exist to dispatch), so no `dispatch(id, args)` helper is needed, unlike `frames-panel.js`/`frame-tool-presenter.js`.

---

### Task 1: Pure onion-skin and frame-navigation math

**Files:**
- Create: `js/modes/sprites/application/onion-skin.js`
- Create: `js/modes/sprites/application/frame-navigation.js`
- Test: `tests/onion-skin.test.mjs`
- Test: `tests/frame-navigation.test.mjs`

**Interfaces:**
- Produces (consumed by Task 2's Presenter):
  - `computeOnionGhosts(animation, frameId, onion) -> Array<{ frameId: string, k: number, dir: 'back'|'ahead' }>`
  - `hexToRgb(hex: string) -> [number, number, number]`
  - `resolveStepColor(onion, dir: 'back'|'ahead', k: number) -> [number, number, number]`
  - `traceOutline(region: { width, height, data }, [r, g, b]) -> { width, height, data: Uint8ClampedArray }`
  - `computeNeighborFrame(sheet, frame, animation, dir: -1|1) -> Frame|null`

- [ ] **Step 1: Write `js/modes/sprites/application/onion-skin.js`**

```js
// Pure onion-skin math for the frame editor: which ghost frames to draw, at
// what tint, and the edge-detection trace behind Outline mode. Everything
// here takes plain data (no legacy `state`, no Canvas/DOM), so it unit-tests
// with plain object literals; `traceOutline` returns a plain {width, height,
// data} bitmap rather than a real ImageData (unavailable outside a browser),
// matching core/pixels.js's convention -- callers wrap it in `new
// ImageData(...)` at the point of canvas use.

function wrapIndex(idx, len) { return ((idx % len) + len) % len; }

// Ghost descriptors to draw for editing frame `frameId` of `animation`,
// walking back/ahead by onion.back/onion.ahead steps with loop-wrap when the
// animation loops. Returns [] when onion skin is off, the animation is
// missing/empty, or `frameId` isn't a member of it.
export function computeOnionGhosts(animation, frameId, onion) {
  if (!onion.enabled || (!onion.mask && !onion.outline)) return [];
  if (!animation || !animation.frames.length) return [];
  const pos = animation.frames.findIndex(af => af.frameId === frameId);
  if (pos === -1) return [];
  const len = animation.frames.length;
  const ghosts = [];
  for (let k = 1; k <= onion.back; k++) {
    let idx = pos - k;
    if (idx < 0) { if (!animation.loop) break; idx = wrapIndex(idx, len); }
    ghosts.push({ frameId: animation.frames[idx].frameId, k, dir: 'back' });
  }
  for (let k = 1; k <= onion.ahead; k++) {
    let idx = pos + k;
    if (idx >= len) { if (!animation.loop) break; idx = wrapIndex(idx, len); }
    ghosts.push({ frameId: animation.frames[idx].frameId, k, dir: 'ahead' });
  }
  return ghosts;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Resolves the tint for ghost step `k` (1-based distance) in direction `dir`
// ('back' or 'ahead'): a per-step override wins, else the direction's base
// color.
export function resolveStepColor(onion, dir, k) {
  const override = onion.stepColors[dir][k];
  return hexToRgb(override ?? (dir === 'back' ? onion.backColor : onion.aheadColor));
}

// 1px-thick edge trace of `region`'s alpha silhouette: a pixel is an edge
// pixel if it's opaque and at least one of its 4-neighbors (off-canvas counts
// as transparent) is not. Interior/exterior pixels stay fully transparent, so
// this composites as an outline rather than a fill. `region` is a plain
// {width, height, data: Uint8ClampedArray} RGBA bitmap (e.g. core/pixels.js's
// copyRegion() output).
export function traceOutline(region, [r, g, b]) {
  const { width: w, height: h, data: src } = region;
  const out = new Uint8ClampedArray(src.length);
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : src[(y * w + x) * 4 + 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) === 0) continue;
      const isEdge = alphaAt(x - 1, y) === 0 || alphaAt(x + 1, y) === 0 || alphaAt(x, y - 1) === 0 || alphaAt(x, y + 1) === 0;
      if (!isEdge) continue;
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
```

- [ ] **Step 2: Write `tests/onion-skin.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOnionGhosts, hexToRgb, resolveStepColor, traceOutline } from '../js/modes/sprites/application/onion-skin.js';

function baseOnion(overrides = {}) {
  return {
    enabled: true, mask: true, outline: false, currentAlpha: 1,
    back: 2, ahead: 2, backColor: '#ff0000', aheadColor: '#00ff00',
    stepColors: { back: {}, ahead: {} },
    ...overrides,
  };
}

function anim({ loop = true, ids = ['a', 'b', 'c', 'd'] } = {}) {
  return { loop, frames: ids.map(id => ({ frameId: id, duration: 100 })) };
}

test('computeOnionGhosts returns [] when onion is disabled or both modes are off', () => {
  assert.deepEqual(computeOnionGhosts(anim(), 'b', baseOnion({ enabled: false })), []);
  assert.deepEqual(computeOnionGhosts(anim(), 'b', baseOnion({ mask: false, outline: false })), []);
});

test('computeOnionGhosts returns [] when the animation is missing, empty, or lacks the frame', () => {
  assert.deepEqual(computeOnionGhosts(null, 'b', baseOnion()), []);
  assert.deepEqual(computeOnionGhosts(anim({ ids: [] }), 'b', baseOnion()), []);
  assert.deepEqual(computeOnionGhosts(anim(), 'z', baseOnion()), []);
});

test('computeOnionGhosts walks back/ahead by onion.back/onion.ahead steps', () => {
  const ghosts = computeOnionGhosts(anim(), 'b', baseOnion({ back: 1, ahead: 1 }));
  assert.deepEqual(ghosts, [
    { frameId: 'a', k: 1, dir: 'back' },
    { frameId: 'c', k: 1, dir: 'ahead' },
  ]);
});

test('computeOnionGhosts clamps at the ends of a non-looping animation instead of wrapping', () => {
  const ghosts = computeOnionGhosts(anim({ loop: false }), 'a', baseOnion({ back: 2, ahead: 0 }));
  assert.deepEqual(ghosts, []);
});

test('computeOnionGhosts wraps around the ends of a looping animation', () => {
  const ghosts = computeOnionGhosts(anim({ loop: true }), 'a', baseOnion({ back: 1, ahead: 0 }));
  assert.deepEqual(ghosts, [{ frameId: 'd', k: 1, dir: 'back' }]);
});

test('hexToRgb converts a #rrggbb string to an [r,g,b] array', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [255, 128, 0]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
});

test('resolveStepColor prefers a per-step override over the direction base color', () => {
  const onion = baseOnion({ stepColors: { back: { 1: '#0000ff' }, ahead: {} } });
  assert.deepEqual(resolveStepColor(onion, 'back', 1), [0, 0, 255]);
  assert.deepEqual(resolveStepColor(onion, 'back', 2), hexToRgb('#ff0000'));
  assert.deepEqual(resolveStepColor(onion, 'ahead', 1), hexToRgb('#00ff00'));
});

test('traceOutline traces only opaque pixels with at least one transparent neighbor', () => {
  // 3x3 fully-opaque block: every pixel is on the border except the center.
  const w = 3, h = 3;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  const region = { width: w, height: h, data };
  const traced = traceOutline(region, [10, 20, 30]);
  assert.equal(traced.width, 3);
  assert.equal(traced.height, 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x === 1 && y === 1) {
        assert.equal(traced.data[i + 3], 0, `center pixel (${x},${y}) should be untouched`);
      } else {
        assert.deepEqual(
          [traced.data[i], traced.data[i + 1], traced.data[i + 2], traced.data[i + 3]],
          [10, 20, 30, 255],
        );
      }
    }
  }
});

test('traceOutline leaves fully transparent regions untouched', () => {
  const region = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
  const traced = traceOutline(region, [10, 20, 30]);
  assert.ok(traced.data.every(v => v === 0));
});
```

- [ ] **Step 3: Run the new onion-skin test to verify it passes**

Run: `npm test -- --test-name-pattern="computeOnionGhosts|hexToRgb|resolveStepColor|traceOutline"` (or just `npm test`, since this is a fast full-suite project)
Expected: all `onion-skin.test.mjs` cases PASS.

- [ ] **Step 4: Write `js/modes/sprites/application/frame-navigation.js`**

```js
// Pure sheet-space frame stepping for the frame editor's Prev/Next controls.
// Walks the given animation's frame order when `frame` belongs to it, else
// falls back to sheet frame order. Clamped (no wraparound) at either end.
// `frame` must be the actual object reference held in `sheet.frames` when no
// animation match is found -- the sheet-order fallback locates it via
// `sheet.frames.indexOf(frame)`, matching the original frameeditor.js's
// `currentFrame()`-sourced usage.

export function computeNeighborFrame(sheet, frame, animation, dir) {
  if (animation) {
    const pos = animation.frames.findIndex(af => af.frameId === frame.id);
    if (pos !== -1) {
      const idx = Math.max(0, Math.min(animation.frames.length - 1, pos + dir));
      if (idx === pos) return null;
      const id = animation.frames[idx].frameId;
      return sheet.frames.find(fr => fr.id === id) ?? null;
    }
  }
  const idx2 = sheet.frames.indexOf(frame);
  const ni = Math.max(0, Math.min(sheet.frames.length - 1, idx2 + dir));
  if (ni === idx2) return null;
  return sheet.frames[ni] ?? null;
}
```

- [ ] **Step 5: Write `tests/frame-navigation.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNeighborFrame } from '../js/modes/sprites/application/frame-navigation.js';

function frame(id) { return { id, name: id }; }

test('computeNeighborFrame walks the animation order when the frame belongs to it', () => {
  const sheet = { frames: [frame('a'), frame('b'), frame('c')] };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }, { frameId: 'c' }] };
  assert.equal(computeNeighborFrame(sheet, frame('b'), anim, 1), sheet.frames[2]);
  assert.equal(computeNeighborFrame(sheet, frame('b'), anim, -1), sheet.frames[0]);
});

test('computeNeighborFrame clamps at the ends of the animation order (no wraparound)', () => {
  const sheet = { frames: [frame('a'), frame('b')] };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }] };
  assert.equal(computeNeighborFrame(sheet, sheet.frames[1], anim, 1), null);
  assert.equal(computeNeighborFrame(sheet, sheet.frames[0], anim, -1), null);
});

test('computeNeighborFrame falls back to sheet order when the frame is not in the animation', () => {
  const sheet = { frames: [frame('a'), frame('b'), frame('c')] };
  const anim = { frames: [{ frameId: 'z' }] };
  assert.equal(computeNeighborFrame(sheet, sheet.frames[1], anim, 1), sheet.frames[2]);
});

test('computeNeighborFrame falls back to sheet order when there is no animation', () => {
  const sheet = { frames: [frame('a'), frame('b'), frame('c')] };
  assert.equal(computeNeighborFrame(sheet, sheet.frames[0], null, 1), sheet.frames[1]);
  assert.equal(computeNeighborFrame(sheet, sheet.frames[2], null, 1), null);
});
```

- [ ] **Step 6: Run the new frame-navigation test to verify it passes**

Run: `npm test`
Expected: all `frame-navigation.test.mjs` cases PASS, and the full suite (previously 565 tests) is still green.

- [ ] **Step 7: Commit**

```bash
git add js/modes/sprites/application/onion-skin.js js/modes/sprites/application/frame-navigation.js tests/onion-skin.test.mjs tests/frame-navigation.test.mjs
git commit -m "feat(sprites): extract onion-skin and frame-navigation math into pure Application functions"
```

---

### Task 2: Frame editor Presenter port

**Files:**
- Create: `js/modes/sprites/presentation/frame-editor-presenter.js` (copy of `js/ui/frameeditor.js` with the edits below)
- Read (unmodified, still importable during this task): `js/ui/frameeditor.js`

**Interfaces:**
- Consumes: `computeOnionGhosts`, `resolveStepColor`, `traceOutline` from `../application/onion-skin.js`; `computeNeighborFrame` from `../application/frame-navigation.js` (Task 1).
- Produces: `export function mountFrameEditor(hostEl) -> { show(), hide(), view: CanvasView }` — identical contract to the original, consumed by `js/modes/sprites/contributions.js` and `js/features/workbench/editor-workbench.js` in Task 3.

This task follows the "copy the still-present legacy file verbatim, then apply only the listed changes" pattern used for `timeline-presenter.js`/`animations-panel.js` in Phase 2b: `js/ui/frameeditor.js` stays in place and importable (still wired into `contributions.js`) until Task 3's cutover, so nothing breaks mid-task.

- [ ] **Step 1: Copy the file**

```bash
cp js/ui/frameeditor.js js/modes/sprites/presentation/frame-editor-presenter.js
```
(PowerShell: `Copy-Item js/ui/frameeditor.js js/modes/sprites/presentation/frame-editor-presenter.js`)

- [ ] **Step 2: Edit the header comment**

In `js/modes/sprites/presentation/frame-editor-presenter.js`, replace:

```js
// Frame editor: a focused, zoomed-in view of a single frame with configurable
// onion-skinning against its animation neighbors. Task 16.
//
// Owns a SECOND CanvasView instance (independent of the sheet view's), living
```

with:

```js
// js/modes/sprites/presentation/frame-editor-presenter.js
// Frame editor: a focused, zoomed-in view of a single frame with configurable
// onion-skinning against its animation neighbors.
//
// Owns a SECOND CanvasView instance (independent of the sheet view's), living
```

(Every other line of the header comment block, including the coordinate-mapping explanation, stays byte-for-byte identical.)

- [ ] **Step 3: Edit the imports block**

Replace:

```js
import { state, on, emit, activeSheet, currentContextLayers, markDirty } from '../app/state.js';
import { CanvasView } from './canvasview.js';
import { bindDrawing } from './tools.js';
import { commitFloatIfAny } from './floatsession.js';
import { flattenSheetLayers } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';
import { runAction } from '../app/actions.js';
```

with:

```js
import { state, on, emit, activeSheet, currentContextLayers, markDirty } from '../../../app/state.js';
import { CanvasView } from '../../../ui/canvasview.js';
import { bindDrawing } from '../../../ui/tools.js';
import { commitFloatIfAny } from '../../../ui/floatsession.js';
import { flattenSheetLayers } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { runAction } from '../../../app/actions.js';
import { computeOnionGhosts, resolveStepColor, traceOutline } from '../application/onion-skin.js';
import { computeNeighborFrame } from '../application/frame-navigation.js';
```

- [ ] **Step 4: Delete the now-unused `wrapIndex` helper**

Delete this line entirely (its only two call sites are inside `paintOnion`, which Step 7 replaces with a call into `computeOnionGhosts`):

```js
function wrapIndex(idx, len) { return ((idx % len) + len) % len; }
```

- [ ] **Step 5: Delete the `buildOutlineImageData` function**

Delete this whole function (moved to `application/onion-skin.js` as `traceOutline` in Task 1):

```js
  function buildOutlineImageData(region, [r, g, b]) {
    const { width: w, height: h, data: src } = region;
    const out = new Uint8ClampedArray(src.length);
    const alphaAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : src[(y * w + x) * 4 + 3];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alphaAt(x, y) === 0) continue;
        const isEdge = alphaAt(x - 1, y) === 0 || alphaAt(x + 1, y) === 0 || alphaAt(x, y - 1) === 0 || alphaAt(x, y + 1) === 0;
        if (!isEdge) continue;
        const i = (y * w + x) * 4;
        out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
      }
    }
    return new ImageData(out, w, h);
  }
```

- [ ] **Step 6: Edit `getGhostCanvas`'s outline branch**

Replace:

```js
      if (mode === 'outline') {
        sctx.putImageData(buildOutlineImageData(region, tintRgb), 0, 0);
      } else {
```

with:

```js
      if (mode === 'outline') {
        const traced = traceOutline(region, tintRgb);
        sctx.putImageData(new ImageData(traced.data, traced.width, traced.height), 0, 0);
      } else {
```

- [ ] **Step 7: Replace `paintOnion`'s body**

Replace:

```js
  function paintOnion(ctx, sheet, f) {
    if (!state.onion.enabled || (!state.onion.mask && !state.onion.outline)) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (!anim || !anim.frames.length) return;
    const pos = anim.frames.findIndex(af => af.frameId === f.id);
    if (pos === -1) return;
    const bmp = getFlatBitmap(sheet);
    const len = anim.frames.length;

    for (let k = 1; k <= state.onion.back; k++) {
      let idx = pos - k;
      if (idx < 0) { if (!anim.loop) break; idx = wrapIndex(idx, len); }
      drawGhost(ctx, bmp, f, frameById(sheet, anim.frames[idx].frameId), stepColor('back', k), k, 'back');
    }
    for (let k = 1; k <= state.onion.ahead; k++) {
      let idx = pos + k;
      if (idx >= len) { if (!anim.loop) break; idx = wrapIndex(idx, len); }
      drawGhost(ctx, bmp, f, frameById(sheet, anim.frames[idx].frameId), stepColor('ahead', k), k, 'ahead');
    }
  }
```

with:

```js
  function paintOnion(ctx, sheet, f) {
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    const ghosts = computeOnionGhosts(anim, f.id, state.onion);
    if (!ghosts.length) return;
    const bmp = getFlatBitmap(sheet);
    for (const ghost of ghosts) {
      drawGhost(ctx, bmp, f, frameById(sheet, ghost.frameId), resolveStepColor(state.onion, ghost.dir, ghost.k), ghost.k, ghost.dir);
    }
  }
```

- [ ] **Step 8: Replace `neighborFrame`'s body**

Replace:

```js
  function neighborFrame(dir) {
    const sheet = activeSheet();
    const f = currentFrame();
    if (!sheet || !f) return null;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim) {
      const pos = anim.frames.findIndex(af => af.frameId === f.id);
      if (pos !== -1) {
        const idx = Math.max(0, Math.min(anim.frames.length - 1, pos + dir));
        if (idx === pos) return null;
        return frameById(sheet, anim.frames[idx].frameId);
      }
    }
    const idx2 = sheet.frames.indexOf(f);
    const ni = Math.max(0, Math.min(sheet.frames.length - 1, idx2 + dir));
    if (ni === idx2) return null;
    return sheet.frames[ni] ?? null;
  }
```

with:

```js
  function neighborFrame(dir) {
    const sheet = activeSheet();
    const f = currentFrame();
    if (!sheet || !f) return null;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId) ?? null;
    return computeNeighborFrame(sheet, f, anim, dir);
  }
```

- [ ] **Step 9: Delete the `hexToRgb`/`stepColor` local functions**

Delete this whole block (moved to `application/onion-skin.js` as `hexToRgb`/`resolveStepColor` in Task 1; the comment above it about per-step overrides living on the Onion Steps page stays — only these two function definitions go):

```js
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Resolves the tint for ghost step `k` (1-based distance) in direction
  // `dir` ('back' or 'ahead'): a per-step override from the ⚙ dialog wins,
  // else the direction's base color (backColor/aheadColor) from the toolbar.
  function stepColor(dir, k) {
    const override = state.onion.stepColors[dir][k];
    return hexToRgb(override ?? (dir === 'back' ? state.onion.backColor : state.onion.aheadColor));
  }

```

- [ ] **Step 10: Verify the diff is exactly the intended edits**

Run: `git diff --no-index js/ui/frameeditor.js js/modes/sprites/presentation/frame-editor-presenter.js`
Expected: only the hunks from Steps 2–9 appear — the import path rewrite, the `wrapIndex` deletion, the `buildOutlineImageData` deletion, the `getGhostCanvas` outline branch, `paintOnion`, `neighborFrame`, and the `hexToRgb`/`stepColor` deletion. Everything else (DOM construction, `getFlatBitmap`/`getFlatCanvas`, `drawGhost`, `getGhostCanvas`'s non-outline branch, `view.onPaint`, `loadFrame`/`refresh`/`updateStrip`/`goTo`/`backToSheet`, every `bindOnionField`/`bindOnionAlpha`/`bindOnionCount` call, keyboard handling, `show`/`hide`, the final `on('project'|'history'|'pixels'|'selection', ...)` subscriptions, and the `return { show, hide, view }`) must be byte-for-byte unchanged.

- [ ] **Step 11: Run the full test suite**

Run: `npm test`
Expected: PASS (`js/ui/frameeditor.js` is still the one wired into `contributions.js` at this point, so this run mainly confirms the new file has no syntax errors and Task 1's tests still pass — no behavioral change is live yet).

- [ ] **Step 12: Commit**

```bash
git add js/modes/sprites/presentation/frame-editor-presenter.js
git commit -m "feat(sprites): port frame editor to presentation/frame-editor-presenter.js"
```

---

### Task 3: Cutover and cleanup

**Files:**
- Modify: `js/modes/sprites/contributions.js:6`
- Delete: `js/ui/frameeditor.js`
- Modify: `docs/ARCHITECTURE.md:279-281`

**Interfaces:**
- Consumes: `mountFrameEditor` from Task 2's `js/modes/sprites/presentation/frame-editor-presenter.js`.

- [ ] **Step 1: Swap the import in `contributions.js`**

Replace:

```js
import { mountAnimationsPanel } from './presentation/animations-panel.js';
import { mountTimeline } from './presentation/timeline-presenter.js';
import { mountFrameEditor } from '../../ui/frameeditor.js';
```

with:

```js
import { mountAnimationsPanel } from './presentation/animations-panel.js';
import { mountFrameEditor } from './presentation/frame-editor-presenter.js';
import { mountTimeline } from './presentation/timeline-presenter.js';
```

- [ ] **Step 2: Delete the old file**

```bash
rm js/ui/frameeditor.js
```
(PowerShell: `Remove-Item js/ui/frameeditor.js`)

- [ ] **Step 3: Update the stale sprites-mode paragraph in `docs/ARCHITECTURE.md`**

Replace:

```
**Sprites mode** mirrors this shape (`sprite-sheet-controller.js`,
`frame-panel.js`, reusing `ui/animpanel.js`/`ui/timeline.js`/
`ui/frameeditor.js`). **Maps mode**: `map-editor.js`, `map-panels.js`.
```

with:

```
**Sprites mode** follows the same Application/Presentation split (see
`js/modes/sprites/application/` and `js/modes/sprites/presentation/`):
`frame-tool-presenter.js` + `frame-chrome-geometry.js`/`frame-geometry.js`/
`frame-pixel-motion.js`/`frame-tool-state.js` (frame/strip tool),
`frames-panel.js`, `timeline-presenter.js` + `timeline-playback.js`
(Timeline dock), `animations-panel.js`, and `frame-editor-presenter.js` +
`onion-skin.js`/`frame-navigation.js` (frame editor + onion skin), backed by
Command Handlers under `application/commands/`. **Maps mode**: `map-editor.js`,
`map-panels.js`.
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS, same total count as before this task (no tests reference the deleted file directly — `tests/architecture.test.mjs`'s regex check on `editor-workbench.js` only asserts that file *doesn't* import `ui/frameeditor.js`, which remains trivially true).

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/contributions.js docs/ARCHITECTURE.md js/ui/frameeditor.js
git commit -m "refactor(sprites): cut over sprites.frame view to frame-editor-presenter.js"
```

(`git add` on an already-deleted path stages the removal — no separate `git rm` needed since Step 2 already removed the file from disk.)

---

## Manual verification checklist

Not automated — per project convention, confirm by hand in the running app:

- Double-click a frame (or strip member) on the sheet opens the frame editor; ◀ Prev / ▶ Next step through the owning animation's order when the frame belongs to one, else through sheet order; both buttons disable correctly at the ends.
- ⬅ Back and Escape both return to the sheet view.
- Drawing tools (pencil, eraser, fill, select+move) work identically inside the frame editor as on the sheet, including selection/marquee overlay position while panned/zoomed.
- Onion checkbox, Mask/Outline toggles, Back/Ahead frame-count fields, back/ahead color pickers, and all four per-direction alpha sliders visibly affect the ghost rendering live; toggling/committing any of them does NOT create an undo-stack entry (Ctrl+Z should skip over onion changes) but DOES mark the project dirty.
- ⚙ per-step colors button opens Project Settings on the Onion Steps page; a per-step override there is reflected in the frame editor's ghost tint on next paint.
- Reopening a previously-open frame editor after resizing the window recenters correctly.
- Undo/redo of a pixel edit, frame resize, or animation change made in the frame editor (or on the sheet while the frame editor is open) reflects correctly in the frame editor's own view on refresh.
