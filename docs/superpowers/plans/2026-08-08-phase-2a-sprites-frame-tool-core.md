# Phase 2a (Sprites Mode — Frame/Strip Tool Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the sprite frame/strip tool core — `js/modes/sprites/sprite-sheet-controller.js` (1335 lines), `js/modes/sprites/frame-panel.js`, `js/features/animations/commands.js`, `js/features/animations/frame-metadata.js` — onto the Application/Presentation split defined in `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`, exactly mirroring the shape Phase 1 established for Maps mode. Pure geometry/hit-testing/pixel-motion moves into `js/modes/sprites/application/`, every `state.commands.push(...)` site becomes a registered Command Handler under `js/modes/sprites/application/commands/`, and all pointer/Canvas/dialog/panel code moves into `js/modes/sprites/presentation/` dispatching commands **by id only**.

**Architecture:** Sprites is the second mode to migrate (Maps was the pilot). This is sub-phase **2a of 4** — Sprites mode is roughly 3× the surface area Maps had, so it is decomposed. 2a covers the frame/strip tool core only. Sub-phases 2b/2c (`js/ui/timeline.js`, `js/ui/animpanel.js`, `js/ui/frameeditor.js`) and 2d (shared-UI wiring + migrating `selectedFrameId`/`selectedAnimationId`/`activeLayerId` onto `SelectionService`) are explicitly **out of scope here**. Legacy state fields (`state.selectedFrameId`, `state.selectedAnimationId`, `state.editingFrameId`, `state.view`, `state.activeLayerId`) stay exactly as they are — the new commands and Presenter read/write them in precisely the places today's code does. Only the *tool logic itself* (geometry, commands, drag handling, overlay rendering, dialog) moves.

**Tech Stack:** Vanilla JS, ES modules, `node --test` (no jsdom — only `application/` code is unit-tested; `presentation/` pointer/Canvas behavior is verified manually per project convention).

## Global Constraints

- No build step, no dependencies, no TypeScript, no UI framework (per `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`).
- Domain never imports upward; Application never touches DOM/Canvas (enforced by `tests/architecture.test.mjs`'s banned-globals scan, which already covers `js/modes/*/application/**`); Presentation dispatches by id only, never imports command-handler modules directly (already enforced for `js/modes/*/presentation/**`); no mode imports another mode's application/presentation (already enforced generically). **Creating `js/modes/sprites/application/` and `js/modes/sprites/presentation/` brings all of these enforcements online for sprites for free — no new generic tests needed.**
- `js/host/*` (`ProjectService.mutate(reason, fn)` + its read-only `.project` getter, `HistoryService.execute(command)`, `SelectionService.get/set/clear`, `getEditorHost()` from `js/host/runtime.js`, `CommandRegistry.execute(id, context, args)` from `js/host/contributions/commands.js`) already exists and is proven by Phase 1.
- **`HistoryService`'s stack IS `state.commands`** — `js/bootstrap.js` constructs `new EditorHost({ historyStack: legacyState.commands, ... })`. So `services.history.execute(command)` is literally `state.commands.push(command)`, which calls `command.do()` immediately (`js/core/commands.js`'s `CommandStack.push`). Undo/redo from the existing menus keeps working unchanged, and the "mutate eagerly, then push a command whose `do()` idempotently re-applies the after-snapshot" idiom used throughout the current sprite code stays valid verbatim.
- **Every new Command Handler dual-writes:** route the mutation through `services.projects.mutate()` (host-side transaction + dirty flag) **and** call legacy `markDirty()` from `js/app/state.js` (the title-bar/unsaved-changes guard still reads legacy `state.dirty`; unification is deferred to Phase 4). This matches Maps' `runCommand` precedent exactly.
- **Register every command via `api.commands.register({id, when, execute})` in `contributions.js` — including ones only shared UI calls.** Phase 1 had to fix this after the fact. Here, `js/ui/timeline.js` and `js/ui/tools.js` both call into `js/features/animations/commands.js`; Task 13 turns that file into a thin dispatch-by-id façade rather than letting shared UI import `application/commands/**`.
- **Undo bookkeeping lives in closures, never as stashed properties on domain objects.** No `__`-prefixed fields on frames/animations/sheets. Look the "before" state up via `services.projects.project` (read-only getter) *before* building the command and close over it — the pattern `eraseMapTile`/`deleteMapLayer` already use.
- **`SelectionService.get(document)` returns `null`, not `{}`, when nothing has been recorded.** This plan introduces **zero** new `host.selections.get(` call sites (sprite selection stays on legacy `state.*` until sub-phase 2d), so there is nothing to guard here — but if an implementer adds one, it must be written `(host.selections.get(doc) ?? {}).field`.
- **Command semantics must match the pre-migration code exactly, not be reinvented.** Every command below quotes the real current implementation of any non-obvious semantic (early-return no-ops that skip the undo stack entirely, sheet-bounds refusals, clamping, idempotency guards) and pins it with a test. Phase 1 shipped a real regression by paraphrasing one such semantic from memory.
- Tasks are ordered so `npm test` stays green after every task: pure Application code first, then Command Handlers, then Presentation (renderer → dialog → presenter → panel), then `contributions.js` wiring + old-file deletion, then the architecture test. End-to-end frame-tool behavior is only fully correct after Task 13; pointer-drag gestures are verified by hand, never simulated in Playwright (project convention).
- Out of scope, do not touch: `js/ui/timeline.js`, `js/ui/animpanel.js`, `js/ui/frameeditor.js`, `js/features/project/document-controller.js`, `js/features/project/legacy-state-adapter.js`, `js/ui/panels.js`, `js/ui/previewpanel.js`, `js/modes/sprites/documents.js`, `js/modes/sprites/preview.js`, `js/app/state.js`.

---

## Behavior-preservation notes (read before starting)

Three deliberate, behavior-neutral signature changes are made while moving code. Nothing else changes:

1. `buildMovePatches(sheet, frames, dx, dy, layers)` never reads its `sheet` parameter (verified by reading the whole function body — it only touches `frames`, `dx`, `dy`, `layers`). It becomes `buildMovePatches(frames, dx, dy, layers)`.
2. Its old default parameter `layers = currentContextLayers()` is dropped; the two call sites that relied on the fallback (`commitInsertFrame`, `commitRemoveMember`) pass `stripLayersOf(sheet, anim) ?? currentContextLayers()` explicitly, which is exactly what they already computed.
3. Command Handlers take ids (`sheetId`, `animationId`, `frameId`, `runIndex`) instead of live object references, so the Presenter can dispatch them through `CommandRegistry.execute(id, context, args)` with plain data. `run` objects (`{start, end, index}`) are re-derived inside the handler via `segmentsOf(anim)[runIndex]`; segment membership cannot change mid-drag (nothing mutates the animation between pointerdown and pointerup), so this is equivalent to the captured object today.

Two things this plan intentionally does **not** change:

- `js/features/animations/commands.js` is **not deleted**. `js/ui/timeline.js` (sub-phase 2b) and `js/ui/tools.js` still import `commitBreakApartStrip`/`commitAcceptAnimation` from it. Task 13 rewrites it as a dispatch-by-id façade over the newly registered commands so shared UI never imports `application/commands/**`, and leaves both importers untouched. Sub-phase 2b/2c deletes the façade once its callers dispatch directly.
- `js/features/animations/frame-metadata.js` **is** deleted — `js/modes/sprites/frame-panel.js` is its only importer (verified by repo-wide grep), and that file is itself replaced in Task 12.

---

### Task 1: Frame-tool option state (`application/frame-tool-state.js`)

**Files:**
- Create: `js/modes/sprites/application/frame-tool-state.js`

**Interfaces:**
- Produces: `frameToolOptions` — a plain mutable object `{ snap, gridSize }`, replacing `sprite-sheet-controller.js`'s module-level `const frameToolOptions = { snap: false, gridSize: 8 }`. Written by the tool-options row (Task 11), read by Task 2's snap functions (passed explicitly as a parameter — this module has no logic).
- Consumes: nothing.

Ephemeral UI state, not persisted with the project — exactly like Maps' `mapBrushState`. The initial values `{ snap: false, gridSize: 8 }` are copied verbatim from the current file.

- [ ] **Step 1: Write the implementation** (no test — plain data holder, exercised transitively by Tasks 2 and 11)

```js
// js/modes/sprites/application/frame-tool-state.js
// Frame-tool options (snap checkbox + grid size), shared between the tool
// options row that edits them (presentation) and the snap math that reads
// them (application). Ephemeral UI state: never serialized with the project.
export const frameToolOptions = { snap: false, gridSize: 8 };
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/sprites/application/frame-tool-state.js
git commit -m "feat(sprites): move frame-tool option state into application layer"
```

---

### Task 2: Pure sheet-space frame geometry (`application/frame-geometry.js`)

**Files:**
- Create: `js/modes/sprites/application/frame-geometry.js`
- Test: `tests/frame-geometry.test.mjs`

**Interfaces:**
- Produces: `snapValue(value, options)`, `snapPoint(x, y, options)`, `rectBetween(ax, ay, bx, by, inclusive)`, `snapRect(rect, options)`, `frameAt(sheet, x, y)`, `stripMembers(sheet, animation)`, `clampMoveDelta(sheet, bbox, delta)`, `stripResizeCount(sheet, drag, pointerX)`, `resizeGhostRect(drag)`.
- Consumes: nothing (leaf application module — no imports at all).

Every function takes its data explicitly instead of reading module-level `frameToolOptions`/`activeSheet()`, so all of it unit-tests with plain object literals and zero DOM. `snapValue`/`snapPoint`/`snapRect`/`rectBetween`/`frameAt` are verbatim moves of the same-named functions from `sprite-sheet-controller.js` (lines 56-93) with the implicit `frameToolOptions` read turned into an `options` parameter. `stripMembers` is a verbatim move of `js/features/animations/frame-metadata.js`'s exported `stripMembers`. `clampMoveDelta`, `stripResizeCount` and `resizeGhostRect` extract inline math from `handleUp`, `handleMove` and `resizeGhostRect` respectively — quoted below beside each implementation.

- [ ] **Step 1: Write the failing test**

```js
// tests/frame-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapValue, snapPoint, rectBetween, snapRect, frameAt, stripMembers,
  clampMoveDelta, stripResizeCount, resizeGhostRect,
} from '../js/modes/sprites/application/frame-geometry.js';

test('snapValue passes values through when snapping is off and rounds when on', () => {
  assert.equal(snapValue(13, { snap: false, gridSize: 8 }), 13);
  assert.equal(snapValue(13, { snap: true, gridSize: 8 }), 16);
  assert.equal(snapValue(11, { snap: true, gridSize: 8 }), 8);
  // gridSize below 1 is clamped to 1 (a 0 grid would divide by zero)
  assert.equal(snapValue(13, { snap: true, gridSize: 0 }), 13);
  assert.equal(snapValue(13, undefined), 13);
});

test('snapPoint snaps both axes with the same options', () => {
  assert.deepEqual(snapPoint(13, 3, { snap: true, gridSize: 8 }), { x: 16, y: 0 });
});

test('rectBetween treats points as pixel indices when inclusive, as edges otherwise', () => {
  assert.deepEqual(rectBetween(2, 3, 5, 9, true), { x: 2, y: 3, w: 4, h: 7 });
  assert.deepEqual(rectBetween(5, 9, 2, 3, true), { x: 2, y: 3, w: 4, h: 7 });
  assert.deepEqual(rectBetween(2, 3, 5, 9, false), { x: 2, y: 3, w: 3, h: 6 });
  // degenerate non-inclusive rects are floored to 1x1, never 0
  assert.deepEqual(rectBetween(4, 4, 4, 4, false), { x: 4, y: 4, w: 1, h: 1 });
});

test('snapRect snaps both corners and keeps at least 1x1', () => {
  const rect = { x: 3, y: 3, w: 10, h: 10 };
  assert.equal(snapRect(rect, { snap: false, gridSize: 8 }), rect);
  assert.deepEqual(snapRect(rect, { snap: true, gridSize: 8 }), { x: 0, y: 0, w: 16, h: 16 });
  assert.deepEqual(snapRect({ x: 1, y: 1, w: 1, h: 1 }, { snap: true, gridSize: 8 }), { x: 0, y: 0, w: 1, h: 1 });
});

test('frameAt returns the topmost frame containing a point, else null', () => {
  const under = { id: 'a', x: 0, y: 0, w: 16, h: 16 };
  const over = { id: 'b', x: 8, y: 8, w: 16, h: 16 };
  const sheet = { frames: [under, over] };
  assert.equal(frameAt(sheet, 10, 10), over);
  assert.equal(frameAt(sheet, 2, 2), under);
  assert.equal(frameAt(sheet, 16, 0), null);
  assert.equal(frameAt(sheet, 100, 100), null);
});

test('stripMembers resolves an animation entry list to frame objects, skipping dangling ids', () => {
  const f0 = { id: 'f0' }, f1 = { id: 'f1' };
  const sheet = { frames: [f0, f1] };
  const animation = { frames: [{ frameId: 'f0' }, { frameId: 'gone' }, { frameId: 'f1' }] };
  assert.deepEqual(stripMembers(sheet, animation), [f0, f1]);
});

test('clampMoveDelta keeps the whole bounding box on-sheet', () => {
  const sheet = { width: 64, height: 64 };
  const bbox = { x: 8, y: 8, w: 16, h: 16 };
  assert.deepEqual(clampMoveDelta(sheet, bbox, { dx: 4, dy: 4 }), { dx: 4, dy: 4 });
  assert.deepEqual(clampMoveDelta(sheet, bbox, { dx: -100, dy: -100 }), { dx: -8, dy: -8 });
  assert.deepEqual(clampMoveDelta(sheet, bbox, { dx: 100, dy: 100 }), { dx: 40, dy: 40 });
});

test('stripResizeCount converts pointer travel into a member count, floored at 1 and capped by the sheet', () => {
  const sheet = { width: 64, height: 64 };
  const drag = { side: 'right', fw: 16, bbox: { x: 0, y: 0, w: 32, h: 16 }, count0: 2 };
  assert.equal(stripResizeCount(sheet, drag, 32), 2);
  assert.equal(stripResizeCount(sheet, drag, 48), 3);
  assert.equal(stripResizeCount(sheet, drag, 0), 1);
  // capped: only 4 frames of width 16 fit from x=0 in a 64px sheet
  assert.equal(stripResizeCount(sheet, drag, 1000), 4);
  const left = { side: 'left', fw: 16, bbox: { x: 32, y: 0, w: 32, h: 16 }, count0: 2 };
  assert.equal(stripResizeCount(sheet, left, 16), 3);
  assert.equal(stripResizeCount(sheet, left, -1000), 4);
});

test('resizeGhostRect grows from the dragged end and keeps the opposite edge fixed', () => {
  const bbox = { x: 32, y: 8, w: 32, h: 16 };
  assert.deepEqual(resizeGhostRect({ side: 'right', fw: 16, count: 4, bbox }), { x: 32, y: 8, w: 64, h: 16 });
  assert.deepEqual(resizeGhostRect({ side: 'left', fw: 16, count: 4, bbox }), { x: 0, y: 8, w: 64, h: 16 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frame-geometry.test.mjs`
Expected: FAIL — `js/modes/sprites/application/frame-geometry.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/frame-geometry.js
// Pure sheet-space math for the frame/strip tool. Everything here takes the
// data it needs as explicit parameters (no legacy `state`, no CanvasView, no
// module-level singletons), so it unit-tests with plain object literals.

export function snapValue(value, options) {
  if (!options?.snap) return value;
  const g = Math.max(1, options.gridSize);
  return Math.round(value / g) * g;
}

export function snapPoint(x, y, options) {
  return { x: snapValue(x, options), y: snapValue(y, options) };
}

// Normalizes two points into a rect. `inclusive` treats both points as pixel
// indices (create-drag, matches the select-tool marquee convention: w =
// |dx|+1); non-inclusive treats them as rect EDGE coordinates (resize, since
// frame corners already live in that space: f.x, f.x+f.w, ...).
export function rectBetween(ax, ay, bx, by, inclusive) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  if (inclusive) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export function snapRect(rect, options) {
  if (!options?.snap) return rect;
  const g = Math.max(1, options.gridSize);
  const x0 = Math.round(rect.x / g) * g;
  const y0 = Math.round(rect.y / g) * g;
  const x1 = Math.round((rect.x + rect.w) / g) * g;
  const y1 = Math.round((rect.y + rect.h) / g) * g;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export function frameAt(sheet, x, y) {
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h) return f;
  }
  return null;
}

// An animation's entry list resolved to frame objects, in animation order.
// Skips dangling frameIds defensively.
export function stripMembers(sheet, animation) {
  return animation.frames
    .map(entry => sheet.frames.find(frame => frame.id === entry.frameId))
    .filter(Boolean);
}

// Clamps a common drag delta so the whole bounding box (single frame or every
// strip member) stays fully on-sheet — no pixels are silently clipped by an
// out-of-bounds copy/blit (pixels.js bounds-checks every write/read).
export function clampMoveDelta(sheet, bbox, delta) {
  return {
    dx: Math.max(-bbox.x, Math.min(sheet.width - (bbox.x + bbox.w), delta.dx)),
    dy: Math.max(-bbox.y, Math.min(sheet.height - (bbox.y + bbox.h), delta.dy)),
  };
}

// Pointer travel past the dragged edge, in whole frame widths, added to the
// segment's starting member count. Never below 1, never past the sheet edge.
export function stripResizeCount(sheet, drag, pointerX) {
  const raw = drag.side === 'right'
    ? pointerX - (drag.bbox.x + drag.bbox.w)
    : drag.bbox.x - pointerX;
  let count = drag.count0 + Math.round(raw / drag.fw);
  count = Math.max(1, count);
  if (sheet) {
    const maxCount = drag.side === 'right'
      ? Math.floor((sheet.width - drag.bbox.x) / drag.fw)
      : Math.floor((drag.bbox.x + drag.bbox.w) / drag.fw);
    count = Math.min(count, Math.max(1, maxCount));
  }
  return count;
}

// Ghost rect for an in-progress edge-grip resize: grows/shrinks from the
// dragged end while the opposite edge stays put.
export function resizeGhostRect(drag) {
  const w = drag.count * drag.fw;
  const x = drag.side === 'right' ? drag.bbox.x : drag.bbox.x + drag.bbox.w - w;
  return { x, y: drag.bbox.y, w, h: drag.bbox.h };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frame-geometry.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/frame-geometry.js tests/frame-geometry.test.mjs
git commit -m "feat(sprites): extract pure frame geometry into application layer"
```

---

### Task 3: Screen-space chrome/handle geometry (`application/frame-chrome-geometry.js`)

**Files:**
- Create: `js/modes/sprites/application/frame-chrome-geometry.js`
- Test: `tests/frame-chrome-geometry.test.mjs`

**Interfaces:**
- Produces: `HANDLE_SCREEN_PX`, `CALLOUT_R`, `CALLOUT_OFF`, `SNAP_SCREEN_PX`, `hitHandle(toScreen, frame, sx, sy)`, `chromeGeometry(toScreen, sheet, anim, run)`, `hitGrip(grips, sx, sy)`, `hitChrome(geometry, sx, sy)`, `standaloneGripGeometry(toScreen, frame)`, `selectedSegment(sheet, selectedFrameId)`, `findSnap(sheet, drag, zoom)`.
- Consumes: `js/core/resizeAnchor.js`'s `HANDLES_CORNER`; `js/core/strips.js`'s `segmentsOf`, `segmentOfFrame`, `segmentMembers`; `js/domain/sprites/frames.js`'s `frameBounds`; `js/domain/sprites/strips.js`'s `stripForFrame`.

These are verbatim moves of `hitHandle` (line 137), `findSnap` (line 110), `chromeGeometry` (line 822), `hitGrip` (line 849), `hitChrome` (line 856), `standaloneGripGeometry` (line 869) and `selectedSegment` (line 887) from `sprite-sheet-controller.js`. The only change: instead of taking a `view` and calling `view.imageToScreen(x, y)`, they take a **`toScreen(x, y)` projection callback**, and `findSnap` takes a plain `zoom` number instead of `view`. A callback is not a DOM/Canvas global, so this file passes the application-layer banned-globals scan while staying fully unit-testable (tests pass an identity or scaling projector). `selectedSegment` takes `selectedFrameId` instead of reading `state.selectedFrameId`.

Behavior worth pinning explicitly (quoted from the current file, line 828): `const canInsert = b.x + b.w + fw <= sheet.width; // any insert shifts/extends right` — when the segment plus one more frame width would overflow the sheet, `chromeGeometry` emits **no** insert call-outs at all (the split call-outs and grips still appear). And `findSnap` only ever offers targets **within the same animation** (`if (run.index === drag.run.index) continue;` over `segmentsOf(drag.anim)`), because cross-animation merging is disabled — see `docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md`.

- [ ] **Step 1: Write the failing test**

```js
// tests/frame-chrome-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hitHandle, chromeGeometry, hitGrip, hitChrome, standaloneGripGeometry,
  selectedSegment, findSnap, CALLOUT_OFF,
} from '../js/modes/sprites/application/frame-chrome-geometry.js';

// Identity projector: screen space === image space, so expected coordinates
// stay readable. Presentation passes (x, y) => view.imageToScreen(x, y).
const identity = (x, y) => ({ x, y });

test('hitHandle returns the corner handle under the pointer, else null', () => {
  const frame = { x: 10, y: 20, w: 30, h: 40 };
  assert.equal(hitHandle(identity, frame, 10, 20), 'nw');
  assert.equal(hitHandle(identity, frame, 40, 60), 'se');
  assert.equal(hitHandle(identity, frame, 43, 63), 'se'); // within 6px slop
  assert.equal(hitHandle(identity, frame, 25, 40), null);
  assert.equal(hitHandle(identity, null, 10, 20), null);
});

test('chromeGeometry emits insert call-outs above every boundary and split call-outs between members', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 16, y: 0, w: 16, h: 16 },
  ];
  const sheet = { width: 64, height: 64, frames };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [] };
  const run = { start: 0, end: 2, index: 0 };
  const g = chromeGeometry(identity, sheet, anim, run);
  assert.deepEqual(g.bbox, { x: 0, y: 0, w: 32, h: 16 });
  assert.equal(g.fw, 16);
  assert.deepEqual(g.inserts.map(c => c.k), [0, 1, 2]);
  assert.equal(g.inserts[0].cy, 0 - CALLOUT_OFF);
  assert.deepEqual(g.splits.map(c => c.k), [1]);
  assert.deepEqual(g.grips.map(gr => gr.side), ['left', 'right']);
});

test('chromeGeometry suppresses inserts when one more frame width would overflow the sheet', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 16, y: 0, w: 16, h: 16 },
  ];
  const sheet = { width: 32, height: 64, frames };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [] };
  const g = chromeGeometry(identity, sheet, anim, { start: 0, end: 2, index: 0 });
  assert.deepEqual(g.inserts, []);
  assert.deepEqual(g.splits.map(c => c.k), [1]);
});

test('chromeGeometry returns null for an empty segment', () => {
  const sheet = { width: 64, height: 64, frames: [] };
  const anim = { frames: [{ frameId: 'gone' }], breaks: [] };
  assert.equal(chromeGeometry(identity, sheet, anim, { start: 0, end: 1, index: 0 }), null);
});

test('hitGrip and hitChrome prefer call-outs over grips', () => {
  const grips = [
    { side: 'left', x: 0, y: 0, w: 6, h: 16 },
    { side: 'right', x: 30, y: 0, w: 6, h: 16 },
  ];
  assert.deepEqual(hitGrip(grips, 1, 8), { type: 'grip', side: 'left' });
  assert.equal(hitGrip(grips, 15, 8), null);
  const geometry = { inserts: [{ k: 1, cx: 16, cy: -16 }], splits: [{ k: 1, cx: 16, cy: 32 }], grips };
  assert.deepEqual(hitChrome(geometry, 16, -16), { type: 'insert', k: 1 });
  assert.deepEqual(hitChrome(geometry, 16, 32), { type: 'split', k: 1 });
  assert.deepEqual(hitChrome(geometry, 31, 8), { type: 'grip', side: 'right' });
  assert.equal(hitChrome(geometry, 200, 200), null);
});

test('standaloneGripGeometry gives a bare frame the same edge grips a strip has', () => {
  const g = standaloneGripGeometry(identity, { x: 8, y: 4, w: 16, h: 16 });
  assert.deepEqual(g.bbox, { x: 8, y: 4, w: 16, h: 16 });
  assert.equal(g.fw, 16);
  assert.equal(g.fh, 16);
  assert.deepEqual(g.grips, [
    { side: 'left', x: 5, y: 4, w: 6, h: 16 },
    { side: 'right', x: 21, y: 4, w: 6, h: 16 },
  ]);
});

test('selectedSegment resolves the intact-strip segment owning the selected frame', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 16, y: 0, w: 16, h: 16 },
  ];
  const strip = { id: 'an1', strip: true, frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [1] };
  const sheet = { width: 64, height: 64, frames, animations: [strip] };
  assert.deepEqual(selectedSegment(sheet, 'b'), { anim: strip, run: { start: 1, end: 2, index: 1 } });
  assert.equal(selectedSegment(sheet, 'missing'), null);
  const loose = { width: 64, height: 64, frames, animations: [{ id: 'an2', strip: false, frames: [{ frameId: 'a' }] }] };
  assert.equal(selectedSegment(loose, 'a'), null);
});

test('findSnap offers an end-to-end join to another segment of the same animation only', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 40, y: 0, w: 16, h: 16 },
  ];
  const anim = { id: 'an1', strip: true, frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [1] };
  const sheet = { width: 128, height: 64, frames, animations: [anim] };
  const drag = {
    anim, run: { start: 0, end: 1, index: 0 }, members: [frames[0]],
    bbox: { x: 0, y: 0, w: 16, h: 16 }, delta: { dx: 23, dy: 0 },
  };
  const snap = findSnap(sheet, drag, 1);
  assert.equal(snap.side, 'before');
  assert.equal(snap.dx, 24);
  assert.equal(snap.dy, 0);
  assert.equal(snap.run.index, 1);
  // Too far away for the 10px/zoom tolerance
  assert.equal(findSnap(sheet, { ...drag, delta: { dx: 0, dy: 0 } }, 1), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frame-chrome-geometry.test.mjs`
Expected: FAIL — `js/modes/sprites/application/frame-chrome-geometry.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/frame-chrome-geometry.js
// Screen-space geometry + hit-testing for the frame tool's handles and
// in-strip chrome. These need a projection from sheet coordinates to screen
// coordinates, but must not know about CanvasView: callers pass a
// `toScreen(x, y) -> {x, y}` callback (presentation supplies
// `(x, y) => view.imageToScreen(x, y)`), keeping this module pure and
// unit-testable with an identity projector.
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';
import { segmentsOf, segmentOfFrame, segmentMembers } from '../../../core/strips.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';

export const HANDLE_SCREEN_PX = 6;
export const CALLOUT_R = 8;
export const CALLOUT_OFF = 16;
export const SNAP_SCREEN_PX = 10;

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

// Word-style "+" insert call-outs above every frame boundary, "✂" split
// call-outs below interior boundaries, and resize grips on the ends. Any
// insert shifts/extends the segment RIGHT, so all inserts are suppressed
// together when one more frame width would not fit on the sheet.
export function chromeGeometry(toScreen, sheet, anim, run) {
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return null;
  const b = frameBounds(members);
  const fw = members[0].w;
  const n = members.length;
  const canInsert = b.x + b.w + fw <= sheet.width;
  const inserts = [];
  if (canInsert)
    for (let k = 0; k <= n; k++) {
      const p = toScreen(b.x + k * fw, b.y);
      inserts.push({ k, cx: p.x, cy: p.y - CALLOUT_OFF });
    }
  const splits = [];
  for (let k = 1; k < n; k++) {
    const p = toScreen(b.x + k * fw, b.y + b.h);
    splits.push({ k, cx: p.x, cy: p.y + CALLOUT_OFF });
  }
  const p0 = toScreen(b.x, b.y);
  const p1 = toScreen(b.x + b.w, b.y + b.h);
  const grips = [
    { side: 'left', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { side: 'right', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
  ];
  return { members, bbox: b, fw, inserts, splits, grips };
}

export function hitGrip(grips, sx, sy) {
  for (const gr of grips)
    if (sx >= gr.x - 2 && sx <= gr.x + gr.w + 2 && sy >= gr.y && sy <= gr.y + gr.h)
      return { type: 'grip', side: gr.side };
  return null;
}

export function hitChrome(geometry, sx, sy) {
  for (const c of geometry.inserts)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'insert', k: c.k };
  for (const c of geometry.splits)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'split', k: c.k };
  return hitGrip(geometry.grips, sx, sy);
}

// Same edge-grip geometry as chromeGeometry's, but for a single standalone
// (non-strip) frame with no run/segment behind it -- lets a bare frame show
// and hit-test the exact same "drag out" grips an intact strip uses to grow
// itself (the presenter starts that drag with anim: null, promoting the frame
// into a brand-new strip -- see newStripFromFrame).
export function standaloneGripGeometry(toScreen, frame) {
  const b = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const p0 = toScreen(b.x, b.y);
  const p1 = toScreen(b.x + b.w, b.y + b.h);
  const grips = [
    { side: 'left', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { side: 'right', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
  ];
  return { bbox: b, fw: b.w, fh: b.h, grips };
}

// Chrome only ever targets the segment containing the currently SELECTED
// frame — never whatever the pointer happens to be over — so a non-selected
// strip's call-outs/grips can't sit in front of and block the selected
// strip's commands when strips are close together or overlap. A sub-strip
// wins over its parent strip by construction: the selected frame's run IS
// the sub-strip.
export function selectedSegment(sheet, selectedFrameId) {
  const anim = stripForFrame(sheet, selectedFrameId);
  const run = anim ? segmentOfFrame(anim, selectedFrameId) : null;
  return run ? { anim, run } : null;
}

// While dragging a segment, find the best end-to-end join WITHIN THE SAME
// overall strip only -- merging across different strip animations is
// disabled for now (see docs/superpowers/specs/2026-07-18-strip-area-
// constraint-design.md): dragged RIGHT edge to a target's LEFT edge (side
// 'before' — dragged frames come first) or dragged LEFT edge to a target's
// RIGHT edge (side 'after'). Same frame w/h required; snapped position must
// stay on-sheet. Only called when drag.anim is truthy.
export function findSnap(sheet, drag, zoom) {
  const d = drag.bbox;
  const fw = drag.members[0].w, fh = drag.members[0].h;
  const tol = SNAP_SCREEN_PX / zoom;
  const gx = d.x + drag.delta.dx, gy = d.y + drag.delta.dy;
  let best = null;
  for (const run of segmentsOf(drag.anim)) {
    if (run.index === drag.run.index) continue;
    const members = segmentMembers(sheet, drag.anim, run);
    if (!members.length || members[0].w !== fw || members[0].h !== fh) continue;
    const t = frameBounds(members);
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frame-chrome-geometry.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/frame-chrome-geometry.js tests/frame-chrome-geometry.test.mjs
git commit -m "feat(sprites): extract frame handle/chrome geometry into application layer"
```

---

### Task 4: Pixel-carrying move patches (`application/frame-pixel-motion.js`)

**Files:**
- Create: `js/modes/sprites/application/frame-pixel-motion.js`
- Test: `tests/frame-pixel-motion.test.mjs`

**Interfaces:**
- Produces: `stripLayersOf(sheet, anim)`, `buildMovePatches(frames, dx, dy, layers)`.
- Consumes: `js/core/model.js`'s `animationGroup`, `flattenLayers`; `js/core/pixels.js`'s `copyRegion`, `fillRegion`, `blitRegion`.
- Consumed by: Tasks 5 and 6 (both command modules).

Verbatim moves of `stripLayersOf` (line 221) and `buildMovePatches` (line 180) from `sprite-sheet-controller.js`. Two behavior-neutral signature changes, per the Behavior-preservation notes above: the unused `sheet` first parameter is dropped from `buildMovePatches`, and its `layers = currentContextLayers()` default is dropped so this module stays free of legacy-state imports (callers pass `stripLayersOf(sheet, anim) ?? currentContextLayers()` explicitly, exactly what they already computed).

`buildMovePatches` **eagerly mutates** — it moves the pixels and the frames' `x`/`y` before returning. That is deliberate and matches every current caller: the returned `patches`/`afterCoords` are then re-applied idempotently by the command's `do()` (which `CommandStack.push` invokes immediately). The copy-all-then-clear-all-then-blit-all ordering is load-bearing: clearing frame A before copying frame B's original pixels would clobber B when A and B are adjacent or overlapping.

- [ ] **Step 1: Write the failing test**

```js
// tests/frame-pixel-motion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { createLayerNode, createGroupNode } from '../js/core/model.js';
import { stripLayersOf, buildMovePatches } from '../js/modes/sprites/application/frame-pixel-motion.js';

function makeSheet() {
  return {
    id: 'sheet1', width: 32, height: 16, frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
}

test('stripLayersOf returns null for a missing, non-strip, or still-floating animation', () => {
  const sheet = makeSheet();
  assert.equal(stripLayersOf(sheet, null), null);
  assert.equal(stripLayersOf(sheet, { id: 'a1', strip: false, layerGroupId: 'g1' }), null);
  assert.equal(stripLayersOf(sheet, { id: 'a1', strip: true, layerGroupId: null }), null);
});

test('stripLayersOf returns the accepted strip group’s own layers', () => {
  const sheet = makeSheet();
  const group = createGroupNode('strip_0', { animationId: 'a1' });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  const anim = { id: 'a1', strip: true, layerGroupId: group.id, frames: [] };
  sheet.animations.push(anim);
  assert.deepEqual(stripLayersOf(sheet, anim), [layer]);
});

test('buildMovePatches carries pixels with the frame and reports a reversible union patch', () => {
  const layer = { id: 'ly1', bitmap: createBitmap(32, 16) };
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  const frame = { id: 'f1', x: 0, y: 0, w: 8, h: 8 };

  const { patches, ur, beforeCoords, afterCoords } = buildMovePatches([frame], 8, 0, [layer]);

  assert.deepEqual(ur, { x: 0, y: 0, w: 16, h: 8 });
  assert.deepEqual(frame, { id: 'f1', x: 8, y: 0, w: 8, h: 8 });
  assert.deepEqual(getPixel(layer.bitmap, 9, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(beforeCoords, [{ frame, x: 0, y: 0 }]);
  assert.deepEqual(afterCoords, [{ frame, x: 8, y: 0 }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].layer, layer);
});

test('buildMovePatches copies every member before clearing any, so adjacent frames do not clobber', () => {
  const layer = { id: 'ly1', bitmap: createBitmap(32, 16) };
  setPixel(layer.bitmap, 0, 0, [1, 0, 0, 255]);
  setPixel(layer.bitmap, 8, 0, [2, 0, 0, 255]);
  const a = { id: 'a', x: 0, y: 0, w: 8, h: 8 };
  const b = { id: 'b', x: 8, y: 0, w: 8, h: 8 };

  buildMovePatches([a, b], 8, 0, [layer]);

  assert.deepEqual(getPixel(layer.bitmap, 8, 0), [1, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 16, 0), [2, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 0, 0), [0, 0, 0, 0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/frame-pixel-motion.test.mjs`
Expected: FAIL — `js/modes/sprites/application/frame-pixel-motion.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/frame-pixel-motion.js
import { animationGroup, flattenLayers } from '../../../core/model.js';
import { copyRegion, fillRegion, blitRegion } from '../../../core/pixels.js';

// The accepted strip's own layers to move pixels on when repositioning
// `anim`'s frames -- null when `anim` is null (a single plain frame, not
// part of an intact strip) or floating (no layer yet), meaning the caller
// falls back to its own metadata-only behavior. See
// docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md.
export function stripLayersOf(sheet, anim) {
  if (!anim?.strip || !anim.layerGroupId) return null;
  const group = animationGroup(sheet, anim.id);
  return group ? flattenLayers(group) : null;
}

// Pixel-carrying shift for one or more frames sharing a common delta.
// For every layer: copy ALL member regions first (their CURRENT pixels),
// THEN clear all of them, THEN blit all of them at their new positions --
// copying before clearing avoids corruption when member frames are adjacent
// (clearing frame A before copying frame B's original pixels would clobber B
// if A and B overlap/touch). Captures a per-layer clone of the UNION of
// every member's before/after rect so undo restores all pixels and all
// frames' x/y in one step.
//
// NOTE: this eagerly applies the move (pixels and frame x/y). Callers push a
// command whose do() re-applies `after` idempotently -- CommandStack.push
// invokes do() immediately, so the net effect is a single applied move.
export function buildMovePatches(frames, dx, dy, layers) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const patches = layers.map((layer) => {
    const before = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    const copies = frames.map(f => copyRegion(layer.bitmap, f.x, f.y, f.w, f.h));
    for (const f of frames) fillRegion(layer.bitmap, f.x, f.y, f.w, f.h, [0, 0, 0, 0]);
    frames.forEach((f, i) => blitRegion(layer.bitmap, copies[i], f.x + dx, f.y + dy));
    const after = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    return { layer, before, after };
  });
  for (const f of frames) { f.x += dx; f.y += dy; }
  const afterCoords = beforeCoords.map(c => ({ frame: c.frame, x: c.x + dx, y: c.y + dy }));
  return { patches, ur, beforeCoords, afterCoords };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/frame-pixel-motion.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/frame-pixel-motion.js tests/frame-pixel-motion.test.mjs
git commit -m "feat(sprites): extract pixel-carrying frame move patches into application layer"
```

---

### Task 5: Frame Command Handlers (`application/commands/frame-commands.js`)

**Files:**
- Create: `js/modes/sprites/application/commands/frame-commands.js`
- Test: `tests/sprite-frame-commands.test.mjs`

**Interfaces:**
- Consumes: `js/host/project-service.js`'s `ProjectService.mutate(reason, fn)` + read-only `.project` getter; `js/host/history-service.js`'s `HistoryService.execute(command)`; `js/core/model.js`'s `addFrame`, `removeFrame`; `js/core/slicing.js`'s `sliceGrid`; `js/core/pixels.js`'s `blitRegion`; Task 4's `stripLayersOf`, `buildMovePatches`; `js/app/state.js`'s `state`, `emit`, `markDirty`.
- Produces: `createFrame(services, sheetId, rect)`, `deleteFrame(services, sheetId, frameId)`, `resizeFrame(services, sheetId, frameId, before, after)`, `moveFrames(services, sheetId, frameIds, dx, dy, animationId)`, `sliceSheetIntoFrames(services, sheetId, options, replace)`. `services` is `{ projects, history }`.

Every handler: (1) resolves the sheet through `services.projects.project` **once, synchronously, before building the command** and closes over what it finds (never stashes `__`-prefixed bookkeeping on the sheet/frame/animation), (2) builds a `{label, do, undo}` command whose `do`/`undo` each re-enter `projects.mutate()` so every history step gets a fresh host transaction + dirty flag, (3) calls `history.execute(command)`, (4) calls legacy `markDirty()` (Global Constraints).

Semantics carried over verbatim from `sprite-sheet-controller.js`, each pinned by a test below:

- `commitCreate` (line 150) names the frame `frame_${sheet.frames.length}` **computed before** the command runs, and its `do()` re-uses the already-created frame object on redo (`if (!created) created = addFrame(...); else if (!sheet.frames.includes(created)) sheet.frames.push(created);`) so the frame keeps its id across undo/redo. It sets `state.selectedFrameId = created.id` and emits `'selection'`.
- `deleteFrame` (line 326) is a **no-op when the frame id is unknown** (`if (!frame) return;` — no undo entry pushed). Undo re-splices the frame at `Math.min(idx, sheet.frames.length)` and restores **every** animation's `frames`/`breaks` from a pre-delete snapshot, because `removeFrame` rewrites all of them.
- `commitResize` (line 315) writes `x/y/w/h` from the `after` rect and restores the `before` rect — the "did anything actually change?" guard lives in the Presenter (`handleUp`), matching today.
- `moveFrames` fuses `commitMoveFrames` (line 205, metadata-only) and `commitMoveFramesWithPixels` (line 232, pixel-carrying) behind the exact decision `handleUp` makes today: `const layers = stripLayersOf(sheet, d.anim); if (layers) commitMoveFramesWithPixels(...) else commitMoveFrames(...)`. Label is `'move strip'` for >1 frame, `'move frame'` otherwise. A zero delta is a no-op with no undo entry (today's `if (dx !== 0 || dy !== 0)` guard in `handleUp`, folded into the handler so every caller gets it).
- `sliceSheetIntoFrames` is the slice-grid dialog's Create handler (line 1227) minus the DOM reads: when `replace` is set it clears `sheet.frames` **and** every animation's `frames`/`breaks` before adding, and the whole thing is one undoable whole-array-snapshot command. It does **not** emit `'selection'` (today's code doesn't).

- [ ] **Step 1: Write the failing test**

```js
// tests/sprite-frame-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { createLayerNode, createGroupNode } from '../js/core/model.js';
import { state } from '../js/app/state.js';
import {
  createFrame, deleteFrame, resizeFrame, moveFrames, sliceSheetIntoFrames,
} from '../js/modes/sprites/application/commands/frame-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function reset() { state.commands = new CommandStack(); state.dirty = false; state.selectedFrameId = null; }

test('createFrame adds a frame, selects it, marks dirty, and is undoable/redoable with a stable id', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();

  createFrame(services, 'sheet1', { x: 4, y: 8, w: 16, h: 16 });
  const sheet = project.sheets[0];
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].name, 'frame_0');
  assert.deepEqual(
    { x: sheet.frames[0].x, y: sheet.frames[0].y, w: sheet.frames[0].w, h: sheet.frames[0].h },
    { x: 4, y: 8, w: 16, h: 16 });
  const id = sheet.frames[0].id;
  assert.equal(state.selectedFrameId, id);
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.frames.length, 0);
  assert.equal(state.selectedFrameId, null);

  services.history.redo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, id);
  assert.equal(state.selectedFrameId, id);
});

test('deleteFrame with an unknown id is a no-op that pushes nothing onto history', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();

  deleteFrame(services, 'sheet1', 'nope');
  assert.equal(services.history.canUndo(), false);
  assert.equal(project.sheets[0].frames.length, 0);
});

test('deleteFrame removes the frame and its animation entries, and undo restores both', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const sheet = project.sheets[0];
  const frameId = sheet.frames[0].id;
  sheet.animations.push({ id: 'an1', name: 'a', strip: true, loop: true, breaks: [], frames: [{ frameId, duration: 100 }], layerGroupId: null });

  deleteFrame(services, 'sheet1', frameId);
  assert.equal(sheet.frames.length, 0);
  assert.equal(sheet.animations[0].frames.length, 0);

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, frameId);
  assert.deepEqual(sheet.animations[0].frames, [{ frameId, duration: 100 }]);
});

test('resizeFrame applies the after rect and undo restores the before rect', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = project.sheets[0].frames[0];

  resizeFrame(services, 'sheet1', frame.id, { x: 0, y: 0, w: 16, h: 16 }, { x: 2, y: 3, w: 20, h: 24 });
  assert.deepEqual({ x: frame.x, y: frame.y, w: frame.w, h: frame.h }, { x: 2, y: 3, w: 20, h: 24 });

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y, w: frame.w, h: frame.h }, { x: 0, y: 0, w: 16, h: 16 });
});

test('moveFrames with a zero delta is a no-op that pushes nothing onto history', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = project.sheets[0].frames[0];
  const undoDepthMarker = services.history.canUndo();
  assert.equal(undoDepthMarker, true);

  moveFrames(services, 'sheet1', [frame.id], 0, 0, null);
  services.history.undo();          // undoes the createFrame, proving nothing was pushed after it
  assert.equal(project.sheets[0].frames.length, 0);
});

test('moveFrames on a plain frame moves metadata only and never touches pixels', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  sheet.layerTree.children.push(layer);
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = sheet.frames[0];

  moveFrames(services, 'sheet1', [frame.id], 16, 0, null);
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 16, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 0, y: 0 });
});

test('moveFrames on an accepted strip carries the strip layer’s pixels and undo restores them', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  const group = createGroupNode('strip_0', { animationId: 'an1' });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = sheet.frames[0];
  sheet.animations.push({ id: 'an1', name: 'strip_0', strip: true, loop: true, breaks: [], frames: [{ frameId: frame.id, duration: 100 }], layerGroupId: group.id });

  moveFrames(services, 'sheet1', [frame.id], 16, 0, 'an1');
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 16, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 0, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);
});

test('sliceSheetIntoFrames appends by default and undo removes exactly the added frames', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 8, h: 8 });
  const sheet = project.sheets[0];

  sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, false);
  assert.equal(sheet.frames.length, 1 + 4);
  assert.equal(sheet.frames[1].name, 'cell_0');

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
});

test('sliceSheetIntoFrames with replace clears existing frames and every animation entry list', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 8, h: 8 });
  const sheet = project.sheets[0];
  const oldFrameId = sheet.frames[0].id;
  sheet.animations.push({ id: 'an1', name: 'a', strip: true, loop: true, breaks: [1], frames: [{ frameId: oldFrameId, duration: 100 }], layerGroupId: null });

  sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, true);
  assert.equal(sheet.frames.length, 4);
  assert.equal(sheet.frames.some(f => f.id === oldFrameId), false);
  assert.deepEqual(sheet.animations[0].frames, []);
  assert.deepEqual(sheet.animations[0].breaks, []);

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, oldFrameId);
  assert.deepEqual(sheet.animations[0].frames, [{ frameId: oldFrameId, duration: 100 }]);
  assert.deepEqual(sheet.animations[0].breaks, [1]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sprite-frame-commands.test.mjs`
Expected: FAIL — `js/modes/sprites/application/commands/frame-commands.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/commands/frame-commands.js
import { addFrame, removeFrame } from '../../../../core/model.js';
import { sliceGrid } from '../../../../core/slicing.js';
import { blitRegion } from '../../../../core/pixels.js';
import { state, emit, markDirty } from '../../../../app/state.js';
import { stripLayersOf, buildMovePatches } from '../frame-pixel-motion.js';

export function findSpriteSheet(project, sheetId) {
  return project?.sheets.find(sheet => sheet.id === sheetId) ?? null;
}

// Every history step re-enters projects.mutate() so the host store gets a
// fresh transaction + dirty flag on do AND undo; markDirty() keeps the legacy
// title-bar/unsaved-changes guard in sync until Phase 4 unifies them.
export function runSheetCommand(services, sheetId, label, apply, revert) {
  const command = {
    label,
    do: () => services.projects.mutate(label, project => apply(findSpriteSheet(project, sheetId), project)),
    undo: () => services.projects.mutate(label, project => revert(findSpriteSheet(project, sheetId), project)),
  };
  services.history.execute(command);
  markDirty();
}

export function createFrame(services, sheetId, rect) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const name = `frame_${sheet.frames.length}`;
  let created = null;
  runSheetCommand(services, sheetId, 'add frame',
    target => {
      if (!created) created = addFrame(target, { name, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      else if (!target.frames.includes(created)) target.frames.push(created);
      state.selectedFrameId = created.id;
    },
    target => {
      target.frames = target.frames.filter(f => f !== created);
      if (state.selectedFrameId === created.id) state.selectedFrameId = null;
    });
  emit('selection');
}

// Shared by the keyboard Delete handler and the frames panel's Delete button.
export function deleteFrame(services, sheetId, frameId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const idx = sheet.frames.indexOf(frame);
  // removeFrame rewrites EVERY animation's entries/breaks, so undo needs a
  // snapshot of all of them, not just the ones referencing this frame.
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = state.selectedFrameId === frameId;
  runSheetCommand(services, sheetId, 'delete frame',
    target => {
      removeFrame(target, frame.id);
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    },
    target => {
      target.frames.splice(Math.min(idx, target.frames.length), 0, frame);
      for (const snap of animSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
      if (wasSelected) state.selectedFrameId = frame.id;
    });
  emit('selection');
}

export function resizeFrame(services, sheetId, frameId, before, after) {
  const frame = findSpriteSheet(services.projects.project, sheetId)?.frames.find(f => f.id === frameId);
  if (!frame) return;
  runSheetCommand(services, sheetId, 'resize frame',
    () => { frame.x = after.x; frame.y = after.y; frame.w = after.w; frame.h = after.h; },
    () => { frame.x = before.x; frame.y = before.y; frame.w = before.w; frame.h = before.h; });
}

// Frames are viewports onto the sheet, so dragging a PLAIN frame or a still-
// FLOATING strip is metadata-only. An ACCEPTED strip owns its own layers, so
// its frames carry their pixels with them instead of leaving them behind.
export function moveFrames(services, sheetId, frameIds, dx, dy, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || (dx === 0 && dy === 0)) return;
  const frames = frameIds.map(id => sheet.frames.find(f => f.id === id)).filter(Boolean);
  if (!frames.length) return;
  const anim = animationId ? sheet.animations.find(a => a.id === animationId) ?? null : null;
  const label = frames.length > 1 ? 'move strip' : 'move frame';
  const layers = stripLayersOf(sheet, anim);

  if (!layers) {
    const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
    runSheetCommand(services, sheetId, label,
      () => { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
      () => { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } });
    return;
  }

  const { patches, ur, beforeCoords, afterCoords } = buildMovePatches(frames, dx, dy, layers);
  runSheetCommand(services, sheetId, label,
    () => {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, ur.x, ur.y);
      for (const c of afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
    () => {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, ur.x, ur.y);
      for (const c of beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    });
}

// Slice-grid dialog's Create action, minus the DOM reads. `options` carries
// cellW/cellH/marginX/marginY/spacingX/spacingY/namePrefix already clamped by
// the dialog; sheetWidth/sheetHeight come from the sheet itself.
export function sliceSheetIntoFrames(services, sheetId, options, replace) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const newFrames = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...options });

  const beforeFrames = sheet.frames.slice();
  const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  if (replace) {
    sheet.frames = [];
    for (const a of sheet.animations) { a.frames = []; a.breaks = []; }
  }
  for (const nf of newFrames) addFrame(sheet, nf);
  const afterFrames = sheet.frames.slice();
  const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));

  runSheetCommand(services, sheetId, 'slice grid',
    target => {
      target.frames = afterFrames.slice();
      for (const snap of afterAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
    },
    target => {
      target.frames = beforeFrames.slice();
      for (const snap of beforeAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sprite-frame-commands.test.mjs`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/commands/frame-commands.js tests/sprite-frame-commands.test.mjs
git commit -m "feat(sprites): add Command Handlers for frame create/delete/resize/move/slice"
```

---

### Task 6: Strip-structure Command Handlers (`application/commands/strip-commands.js`)

**Files:**
- Create: `js/modes/sprites/application/commands/strip-commands.js`
- Test: `tests/sprite-strip-commands.test.mjs`

**Interfaces:**
- Consumes: Task 4's `stripLayersOf`, `buildMovePatches`; Task 5's `findSpriteSheet`, `runSheetCommand` (which is what calls `markDirty()`, so this module does not import it); `js/core/model.js`'s `addFrame`, `removeFrame`, `addAnimation`, `animationGroup`; `js/core/pixels.js`'s `createBitmap`, `copyRegion`, `blitRegion`; `js/core/strips.js`'s `segmentsOf`, `segmentOfFrame`, `segmentMembers`, `insertEntry`, `removeEntry`, `mergeSegments`, `transferSegment`, `normalizeBreaks`; `js/domain/sprites/frames.js`'s `frameBounds`; `js/app/state.js`'s `state`, `emit`, `activeSheet`, `currentContextLayers`.
- Produces: `insertStripFrame(services, sheetId, animationId, runIndex, k)`, `splitStrip(services, sheetId, animationId, index)`, `resizeStripSegment(services, sheetId, animationId, runIndex, side, count)`, `removeStripMember(services, sheetId, animationId, frameId)`, `mergeStripSegments(services, sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy)`, `newStripFromFrame(services, sheetId, frameId, side, count)`.

Every handler resolves `run` from `segmentsOf(anim)[runIndex]` rather than taking a captured object (Behavior-preservation note 3). All six follow today's whole-array-snapshot idiom: mutate eagerly, snapshot before/after, push a command whose `do()`/`undo()` re-apply the snapshots idempotently. Semantics carried over verbatim, each pinned by a test:

- `commitInsertFrame` (line 352) — Word-style insert-column at boundary `k`. **Two silent refusals with no history entry:** `if (!members.length) return;` and `if (b.x + b.w + fw > sheet.width) return;` (an insert always shifts/extends the segment right, so it must fit). `attachLeft = k === members.length`. The new entry's duration is `beforeEntries[index - 1]?.duration ?? beforeEntries[index]?.duration ?? (settings.durationMs ?? 100)`. The tail (`members.slice(k)`) shifts right one frame width **pixel-carrying**, using `stripLayersOf(sheet, anim) ?? currentContextLayers()`. Sets `state.selectedFrameId` to the new frame, emits `'selection'`.
- `commitSplitStrip` (line 409) — pure break insertion. **No-op with no history entry when the break already exists**: `const after = normalizeBreaks([...before, index], anim.frames.length); if (after.length === before.length) return;`. Nothing moves.
- `commitResizeSegment` (line 430) — grow appends blank frames at the dragged end (right: rightward at `bbox.x + bbox.w + j*fw`; left: leftward at `bbox.x - (j+1)*fw`, entries prepended at `run.start`), always pixel-free. Shrink removes frames + entries from that end and, **only once the strip is accepted** (`anim.layerGroupId` set, `layer = group.children[0]`), also clears each removed frame's own pixels from that layer — a floating strip has no layer, so shrink stays pixel-free. Neighbor's duration is copied (`side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start]`). Guard `if (count === count0) return;` (today in `handleUp`, folded into the handler).
- `commitRemoveMember` (line 500) — deletes the frame **and closes the gap**: the rest of its segment (`members.slice(k + 1)`) shifts left one frame width, pixel-carrying. `if (!run) return;`. `removeFrame` keeps every animation's entries/breaks consistent, so before/after snapshots cover all of them.
- `commitMergeSegments` (line 253) — one undoable command = reposition of the dragged members + order/breaks rewrite (+ possible source-animation deletion when it empties). Same-animation merges use `mergeSegments`, cross-animation use `transferSegment`; in practice `findSnap` only ever offers same-animation targets today, but the cross-animation branch is preserved verbatim. When the source strip is accepted, the reposition is pixel-carrying via `buildMovePatches`; otherwise metadata-only. Sets `state.selectedAnimationId = dstAnim.id`, emits `'selection'`.
- `commitNewStripFromFrame` (line 1282) — promotes a standalone frame into a brand-new intact strip: the frame itself becomes member 0 (same id, same position, **renamed** to `${name}_0`), and `count - 1` blank frames are appended in the dragged direction. **No-op with no history entry when `extra <= 0`.** New animation name is `strip_${sheet.animations.length}`. `do()` only reassigns `state.selectedFrameId`/`selectedAnimationId` when `sheet === activeSheet()`; `undo()` reassigns unconditionally (preserved exactly as written today).

- [ ] **Step 1: Write the failing test**

```js
// tests/sprite-strip-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  insertStripFrame, splitStrip, resizeStripSegment, removeStripMember,
  mergeStripSegments, newStripFromFrame,
} from '../js/modes/sprites/application/commands/strip-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject({ width = 64, height = 64 } = {}) {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width, height,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

// Frames laid out left-to-right at 16x16 starting at x0, plus one intact
// strip animation ('an1') owning them in order.
function addStrip(sheet, ids, { breaks = [], x0 = 0 } = {}) {
  ids.forEach((id, index) => sheet.frames.push({ id, name: id, x: x0 + index * 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }));
  const anim = {
    id: 'an1', name: 'strip_0', loop: true, strip: true, breaks: breaks.slice(),
    frames: ids.map(id => ({ frameId: id, duration: 100 })), layerGroupId: null, baseDuration: 100,
  };
  sheet.animations.push(anim);
  return anim;
}

function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
  state.selectedFrameId = null;
  state.selectedAnimationId = null;
}

const frameIds = anim => anim.frames.map(entry => entry.frameId);

test('splitStrip adds a break, and re-splitting the same boundary is a no-op with no history entry', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c']);

  splitStrip(services, 'sheet1', 'an1', 1);
  assert.deepEqual(anim.breaks, [1]);
  assert.equal(state.dirty, true);

  splitStrip(services, 'sheet1', 'an1', 1);
  assert.deepEqual(anim.breaks, [1]);

  services.history.undo();
  assert.deepEqual(anim.breaks, []);
  assert.equal(services.history.canUndo(), false);
});

test('insertStripFrame inserts a blank frame at the boundary and shifts the tail right', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);

  insertStripFrame(services, 'sheet1', 'an1', 0, 1);

  assert.equal(sheet.frames.length, 3);
  const inserted = sheet.frames[2];
  assert.deepEqual({ x: inserted.x, y: inserted.y, w: inserted.w, h: inserted.h }, { x: 16, y: 0, w: 16, h: 16 });
  assert.deepEqual(frameIds(anim), ['a', inserted.id, 'b']);
  assert.equal(anim.frames[1].duration, 100);
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 32);
  assert.equal(state.selectedFrameId, inserted.id);

  services.history.undo();
  assert.equal(sheet.frames.length, 2);
  assert.deepEqual(frameIds(anim), ['a', 'b']);
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 16);
});

test('insertStripFrame refuses (no history entry) when one more frame width would overflow the sheet', () => {
  const project = makeProject({ width: 32 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);

  insertStripFrame(services, 'sheet1', 'an1', 0, 1);

  assert.equal(sheet.frames.length, 2);
  assert.deepEqual(frameIds(anim), ['a', 'b']);
  assert.equal(services.history.canUndo(), false);
});

test('resizeStripSegment grows by appending blank frames at the dragged end with the neighbour duration', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 4);

  assert.equal(sheet.frames.length, 4);
  assert.equal(anim.frames.length, 4);
  assert.deepEqual(sheet.frames.slice(2).map(f => f.x), [32, 48]);
  assert.deepEqual(anim.frames.map(e => e.duration), [100, 100, 100, 100]);

  services.history.undo();
  assert.equal(sheet.frames.length, 2);
  assert.equal(anim.frames.length, 2);
});

test('resizeStripSegment shrinks from the dragged end and undo restores the removed frames', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c', 'd']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 2);

  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b']);
  assert.deepEqual(frameIds(anim), ['a', 'b']);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(frameIds(anim), ['a', 'b', 'c', 'd']);
});

test('resizeStripSegment with an unchanged count is a no-op with no history entry', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  addStrip(project.sheets[0], ['a', 'b']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 2);
  assert.equal(services.history.canUndo(), false);
});

test('removeStripMember deletes the frame and closes the gap by shifting the tail left', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c']);

  removeStripMember(services, 'sheet1', 'an1', 'b');

  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'c']);
  assert.deepEqual(frameIds(anim), ['a', 'c']);
  assert.equal(sheet.frames.find(f => f.id === 'c').x, 16);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b', 'c']);
  assert.deepEqual(frameIds(anim), ['a', 'b', 'c']);
  assert.equal(sheet.frames.find(f => f.id === 'c').x, 32);
});

test('mergeStripSegments fuses two segments of one animation and repositions the dragged members', () => {
  const project = makeProject({ width: 128 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b'], { breaks: [1] });
  sheet.frames.find(f => f.id === 'b').x = 40;

  mergeStripSegments(services, 'sheet1', 'an1', 0, 'an1', 1, 'before', 24, 0);

  assert.deepEqual(frameIds(anim), ['a', 'b']);
  assert.deepEqual(anim.breaks, []);
  assert.equal(sheet.frames.find(f => f.id === 'a').x, 24);
  assert.equal(state.selectedAnimationId, 'an1');

  services.history.undo();
  assert.deepEqual(anim.breaks, [1]);
  assert.equal(sheet.frames.find(f => f.id === 'a').x, 0);
});

test('newStripFromFrame promotes a standalone frame into a strip and renames it', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'right', 3);

  assert.equal(sheet.animations.length, 1);
  const anim = sheet.animations[0];
  assert.equal(anim.name, 'strip_0');
  assert.equal(anim.strip, true);
  assert.equal(sheet.frames.length, 3);
  assert.deepEqual(sheet.frames.map(f => f.name), ['strip_0_0', 'strip_0_1', 'strip_0_2']);
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 16, 32]);
  assert.deepEqual(frameIds(anim), ['f1', sheet.frames[1].id, sheet.frames[2].id]);
  assert.equal(state.selectedAnimationId, anim.id);

  services.history.undo();
  assert.equal(sheet.animations.length, 0);
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].name, 'frame_0');
});

test('newStripFromFrame is a no-op with no history entry when the count would add nothing', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  project.sheets[0].frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'right', 1);

  assert.equal(project.sheets[0].animations.length, 0);
  assert.equal(services.history.canUndo(), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sprite-strip-commands.test.mjs`
Expected: FAIL — `js/modes/sprites/application/commands/strip-commands.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/commands/strip-commands.js
import { addFrame, removeFrame, addAnimation, animationGroup } from '../../../../core/model.js';
import { createBitmap, copyRegion, blitRegion } from '../../../../core/pixels.js';
import {
  segmentsOf, segmentOfFrame, segmentMembers,
  insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks,
} from '../../../../core/strips.js';
import { frameBounds } from '../../../../domain/sprites/frames.js';
import { state, emit, activeSheet, currentContextLayers } from '../../../../app/state.js';
import { stripLayersOf, buildMovePatches } from '../frame-pixel-motion.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function resolve(services, sheetId, animationId, runIndex) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId) ?? null;
  const run = anim && runIndex != null ? segmentsOf(anim)[runIndex] ?? null : null;
  return { sheet, anim, run };
}

function defaultDuration(services) {
  return services.projects.project?.settings?.durationMs ?? 100;
}

// Word-style insert-column at boundary k of a segment (0=before first,
// n=after last): the tail shifts right one frame width (pixel-carrying), a
// blank frame fills the gap, an animation entry lands at the matching order
// index with its neighbor's duration.
export function insertStripFrame(services, sheetId, animationId, runIndex, k) {
  const { sheet, anim, run } = resolve(services, sheetId, animationId, runIndex);
  if (!sheet || !anim || !run) return;
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const fw = members[0].w, fh = members[0].h;
  const b = frameBounds(members);
  if (b.x + b.w + fw > sheet.width) return;
  const index = run.start + k;
  const attachLeft = k === members.length;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();

  const tail = members.slice(k);
  const mv = tail.length ? buildMovePatches(tail, fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
  const frame = addFrame(sheet, {
    name: `${anim.name}_${anim.frames.length}`,
    x: b.x + k * fw, y: b.y, w: fw, h: fh,
  });
  const duration = beforeEntries[index - 1]?.duration ?? beforeEntries[index]?.duration ?? defaultDuration(services);
  const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, attachLeft);
  anim.frames = r.entries;
  anim.breaks = r.breaks;

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();

  runSheetCommand(services, sheetId, 'insert frame',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = frame.id;
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    });
  emit('selection');
}

// Split = add a break. Nothing moves; the dashed separator marks the cut
// until one side is dragged away.
export function splitStrip(services, sheetId, animationId, index) {
  const { anim } = resolve(services, sheetId, animationId, null);
  if (!anim) return;
  const before = (anim.breaks ?? []).slice();
  const after = normalizeBreaks([...before, index], anim.frames.length);
  if (after.length === before.length) return;
  runSheetCommand(services, sheetId, 'split strip',
    () => { anim.breaks = after.slice(); },
    () => { anim.breaks = before.slice(); });
}

// Resize = add/remove whole frames at the dragged end. Grow appends blank
// frames (right: rightward; left: leftward, prepended in order) -- always a
// pure array operation, no pixel effects. Shrink removes frames + entries
// from that end and, once the strip is accepted (has its own layer), also
// clears the removed frame's own pixels from it: each strip owns its own
// layer, so there's no shared underlying sheet art left to preserve for a
// future regrow. A floating strip has no layer yet, so shrink stays
// pixel-free too. Neighbor's duration is copied.
export function resizeStripSegment(services, sheetId, animationId, runIndex, side, count) {
  const { sheet, anim, run } = resolve(services, sheetId, animationId, runIndex);
  if (!sheet || !anim || !run) return;
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const count0 = members.length;
  if (count === count0) return;
  const fw = members[0].w, fh = members[0].h;
  const bbox = frameBounds(members);
  const delta = count - count0;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();
  const beforeSelected = state.selectedFrameId;
  const neighbor = side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start];
  const duration = neighbor?.duration ?? defaultDuration(services);

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

  runSheetCommand(services, sheetId, 'resize strip',
    target => {
      target.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = afterSelected;
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
    },
    target => {
      target.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      state.selectedFrameId = beforeSelected;
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, p.before, p.x, p.y);
    });
  emit('selection');
}

// Delete on a strip member removes the frame AND closes the gap: the rest of
// its segment shifts left one frame width. removeFrame keeps every
// animation's entries/breaks consistent; snapshots cover them all for undo.
export function removeStripMember(services, sheetId, animationId, frameId) {
  const { sheet, anim } = resolve(services, sheetId, animationId, null);
  if (!sheet || !anim) return;
  const run = segmentOfFrame(anim, frameId);
  if (!run) return;
  const members = segmentMembers(sheet, anim, run);
  const index = anim.frames.findIndex(e => e.frameId === frameId);
  const k = index - run.start;
  const fw = members[0].w;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = state.selectedFrameId === frameId;

  const tail = members.slice(k + 1);
  const mv = tail.length ? buildMovePatches(tail, -fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
  removeFrame(sheet, frameId);

  const afterSheetFrames = sheet.frames.slice();
  const afterAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));

  runSheetCommand(services, sheetId, 'remove strip frame',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = afterSheetFrames.slice();
      for (const s of afterAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = beforeSheetFrames.slice();
      for (const s of beforeAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (wasSelected) state.selectedFrameId = frameId;
    });
  emit('selection');
}

// Snap-merge: one undoable command = reposition of the dragged members +
// order/breaks rewrite (+ possible source-animation deletion). Whole-array
// snapshots keep do()/undo() idempotent per the codebase idiom.
export function mergeStripSegments(services, sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy) {
  const { sheet, anim: srcAnim, run: srcRun } = resolve(services, sheetId, animationId, runIndex);
  const { anim: dstAnim, run: dstRun } = resolve(services, sheetId, targetAnimationId, targetRunIndex);
  if (!sheet || !srcAnim || !dstAnim || !srcRun || !dstRun) return;
  const members = segmentMembers(sheet, srcAnim, srcRun);
  if (!members.length) return;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: state.selectedAnimationId,
  };
  // findSnap only ever offers same-strip targets now (cross-animation
  // merging is disabled), so this is always same-strip pixel motion when the
  // strip is accepted; stripLayersOf returns null for a floating strip,
  // falling back to a metadata-only reposition.
  const layers = stripLayersOf(sheet, srcAnim);
  const mv = layers ? buildMovePatches(members, dx, dy, layers) : null;
  const coords = mv ? null : members.map(f => ({ frame: f, x: f.x, y: f.y }));
  if (!mv) for (const f of members) { f.x += dx; f.y += dy; }
  if (sameAnim) {
    const r = mergeSegments(srcAnim, srcRun.index, dstRun.index, side);
    srcAnim.frames = r.frames; srcAnim.breaks = r.breaks;
  } else {
    const r = transferSegment(srcAnim, dstAnim, srcRun.index, dstRun.index, side);
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

  runSheetCommand(services, sheetId, 'merge strips',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; }
      }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      target.animations = after.animations.slice();
      state.selectedAnimationId = dstAnim.id;
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      srcAnim.frames = before.srcFrames.map(e => ({ ...e })); srcAnim.breaks = before.srcBreaks.slice();
      dstAnim.frames = before.dstFrames.map(e => ({ ...e })); dstAnim.breaks = before.dstBreaks.slice();
      target.animations = before.animations.slice();
      state.selectedAnimationId = before.selectedAnimationId;
    });
  emit('selection');
}

// Dragging a standalone (non-strip) frame's own edge grip promotes it into a
// brand-new intact-strip animation: the frame itself becomes member 0 (kept
// at its own id/position -- never duplicated), renamed to match the new
// strip, and `count - 1` additional blank frames are appended in the dragged
// direction, exactly like growing an existing strip via the grip.
export function newStripFromFrame(services, sheetId, frameId, side, count) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!sheet || !frame) return;
  const extra = count - 1;
  if (extra <= 0) return;
  const fw = frame.w, fh = frame.h;
  const duration = defaultDuration(services);
  const name = `strip_${sheet.animations.length}`;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();
  const beforeFrameName = frame.name;
  const beforeSelectedAnimationId = state.selectedAnimationId;

  const anim = addAnimation(sheet, name, true, services.projects.project?.settings);
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

  runSheetCommand(services, sheetId, 'new strip from frame',
    target => {
      target.frames = afterSheetFrames.slice();
      target.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(e => ({ ...e }));
      frame.name = afterFrameName;
      if (target === activeSheet()) {
        state.selectedFrameId = frameId;
        state.selectedAnimationId = animId;
      }
    },
    target => {
      target.frames = beforeSheetFrames.slice();
      target.animations = beforeAnimations.slice();
      frame.name = beforeFrameName;
      state.selectedFrameId = frameId;
      state.selectedAnimationId = beforeSelectedAnimationId;
    });
  emit('selection');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sprite-strip-commands.test.mjs`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/commands/strip-commands.js tests/sprite-strip-commands.test.mjs
git commit -m "feat(sprites): add Command Handlers for strip insert/split/resize/remove/merge/promote"
```

---

### Task 7: Frame/strip field-edit Command Handlers (`application/commands/frame-metadata-commands.js`)

**Files:**
- Create: `js/modes/sprites/application/commands/frame-metadata-commands.js`
- Test: `tests/sprite-frame-metadata-commands.test.mjs`

**Interfaces:**
- Consumes: Task 2's `stripMembers`; Task 5's `findSpriteSheet`, `runSheetCommand`; `js/core/strips.js`'s `segmentsOf`, `segmentMembers`; `js/domain/sprites/frames.js`'s `frameBounds`.
- Produces: `setFrameField(services, sheetId, frameId, key, value)`, `moveStripTo(services, sheetId, animationId, nextX, nextY)`, `setStripFrameSize(services, sheetId, animationId, key, value)`, `setStripPivot(services, sheetId, animationId, key, value)`.

Direct port of `js/features/animations/frame-metadata.js` (which Task 13 deletes). Two changes: `state.commands.push(...)` + `markDirty()` becomes Task 5's `runSheetCommand` (which does both plus the host transaction), and the `members` array parameter becomes an `animationId` the handler resolves via `stripMembers(sheet, animation)` — exactly the array today's only caller (`frame-panel.js`'s `renderStripDetail`) passes in.

Semantics carried over verbatim, each pinned by a test:

- `commitFrameField` — **no-op with no history entry when the value is unchanged**: `const before = frame[key]; if (before === value) return;`.
- `moveStripTo` — clamps the delta so the strip's whole bounding box stays on-sheet (`dx = Math.max(-bounds.x, Math.min(sheet.width - bounds.x - bounds.w, Math.round(nextX) - bounds.x))`, same for `dy`) and is a **no-op when `dx === 0 && dy === 0`**. Metadata only — pixels never move (this is the panel's numeric field, not a drag).
- `setStripFrameSize` — `next = Math.max(1, Math.round(value))`, then clamped: for `'w'`, per **segment**, `Math.min(next, Math.floor((sheet.width - runMembers[0].x) / runMembers.length))`; for `'h'`, per **frame**, `Math.min(next, sheet.height - frame.y)`. Then `next = Math.max(1, next)`, and **no-op when every member already has that value**. Applying `'w'` re-lays-out each segment left-to-right from its own first member's `x`.
- `setStripPivot` — **no-op when every member already has that pivot value**.

- [ ] **Step 1: Write the failing test**

```js
// tests/sprite-frame-metadata-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  setFrameField, moveStripTo, setStripFrameSize, setStripPivot,
} from '../js/modes/sprites/application/commands/frame-metadata-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject({ width = 64, height = 64 } = {}) {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width, height,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function addStrip(sheet, ids, { breaks = [] } = {}) {
  ids.forEach((id, index) => sheet.frames.push({ id, name: id, x: index * 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }));
  const anim = {
    id: 'an1', name: 'strip_0', loop: true, strip: true, breaks: breaks.slice(),
    frames: ids.map(id => ({ frameId: id, duration: 100 })), layerGroupId: null, baseDuration: 100,
  };
  sheet.animations.push(anim);
  return anim;
}

function reset() { state.commands = new CommandStack(); state.dirty = false; }

test('setFrameField edits one field, is undoable, and no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  setFrameField(services, 'sheet1', 'f1', 'name', 'hero');
  assert.equal(sheet.frames[0].name, 'hero');
  assert.equal(state.dirty, true);

  setFrameField(services, 'sheet1', 'f1', 'name', 'hero');
  services.history.undo();
  assert.equal(sheet.frames[0].name, 'frame_0');
  assert.equal(services.history.canUndo(), false);
});

test('moveStripTo clamps the strip bounding box to the sheet', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  moveStripTo(services, 'sheet1', 'an1', 100, 0);
  assert.deepEqual(sheet.frames.map(f => f.x), [32, 48]);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 16]);
});

test('moveStripTo is a no-op with no history entry when nothing would move', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  addStrip(project.sheets[0], ['a', 'b']);

  moveStripTo(services, 'sheet1', 'an1', 0, 0);
  assert.equal(services.history.canUndo(), false);
});

test('setStripFrameSize w clamps per segment and re-lays the segment out left to right', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  setStripFrameSize(services, 'sheet1', 'an1', 'w', 100);
  assert.deepEqual(sheet.frames.map(f => f.w), [32, 32]);
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 32]);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.w), [16, 16]);
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 16]);
});

test('setStripFrameSize h clamps each frame to the sheet height and no-ops when already set', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  setStripFrameSize(services, 'sheet1', 'an1', 'h', 100);
  assert.deepEqual(sheet.frames.map(f => f.h), [64, 64]);

  setStripFrameSize(services, 'sheet1', 'an1', 'h', 100);
  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.h), [16, 16]);
  assert.equal(services.history.canUndo(), false);
});

test('setStripPivot applies to every member and no-ops when they already match', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  setStripPivot(services, 'sheet1', 'an1', 'pivotX', 8);
  assert.deepEqual(sheet.frames.map(f => f.pivotX), [8, 8]);

  setStripPivot(services, 'sheet1', 'an1', 'pivotX', 8);
  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.pivotX), [0, 0]);
  assert.equal(services.history.canUndo(), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sprite-frame-metadata-commands.test.mjs`
Expected: FAIL — `js/modes/sprites/application/commands/frame-metadata-commands.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/commands/frame-metadata-commands.js
import { segmentsOf, segmentMembers } from '../../../../core/strips.js';
import { frameBounds } from '../../../../domain/sprites/frames.js';
import { stripMembers } from '../frame-geometry.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function resolveStrip(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const animation = sheet?.animations.find(a => a.id === animationId) ?? null;
  const members = sheet && animation ? stripMembers(sheet, animation) : [];
  return { sheet, animation, members };
}

export function setFrameField(services, sheetId, frameId, key, value) {
  const frame = findSpriteSheet(services.projects.project, sheetId)?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const before = frame[key];
  if (before === value) return;
  runSheetCommand(services, sheetId, `edit frame ${key}`,
    () => { frame[key] = value; },
    () => { frame[key] = before; });
}

// Whole-member x/y/w/h/pivot snapshot before and after `mutate`, so any strip
// geometry edit becomes one reversible command regardless of how many frames
// it touched.
function commitStripEdit(services, sheetId, label, members, mutate) {
  const snapshot = () => members.map(frame =>
    [frame.x, frame.y, frame.w, frame.h, frame.pivotX, frame.pivotY]);
  const apply = values => members.forEach((frame, index) => {
    [frame.x, frame.y, frame.w, frame.h, frame.pivotX, frame.pivotY] = values[index];
  });
  const before = snapshot();
  mutate();
  const after = snapshot();
  runSheetCommand(services, sheetId, label, () => apply(after), () => apply(before));
}

export function moveStripTo(services, sheetId, animationId, nextX, nextY) {
  const { sheet, members } = resolveStrip(services, sheetId, animationId);
  if (!sheet || !members.length) return;
  const bounds = frameBounds(members);
  const dx = Math.max(-bounds.x, Math.min(sheet.width - bounds.x - bounds.w, Math.round(nextX) - bounds.x));
  const dy = Math.max(-bounds.y, Math.min(sheet.height - bounds.y - bounds.h, Math.round(nextY) - bounds.y));
  if (dx === 0 && dy === 0) return;
  commitStripEdit(services, sheetId, 'move strip', members, () => {
    for (const frame of members) { frame.x += dx; frame.y += dy; }
  });
}

export function setStripFrameSize(services, sheetId, animationId, key, value) {
  const { sheet, animation, members } = resolveStrip(services, sheetId, animationId);
  if (!sheet || !animation || !members.length) return;
  let next = Math.max(1, Math.round(value));
  if (key === 'w') {
    for (const run of segmentsOf(animation)) {
      const runMembers = segmentMembers(sheet, animation, run);
      if (runMembers.length) next = Math.min(next, Math.floor((sheet.width - runMembers[0].x) / runMembers.length));
    }
  } else {
    for (const frame of members) next = Math.min(next, sheet.height - frame.y);
  }
  next = Math.max(1, next);
  if (members.every(frame => frame[key] === next)) return;
  commitStripEdit(services, sheetId, `strip frame ${key}`, members, () => {
    if (key === 'w') {
      for (const run of segmentsOf(animation)) {
        const runMembers = segmentMembers(sheet, animation, run);
        let x = runMembers[0]?.x ?? 0;
        for (const frame of runMembers) { frame.x = x; frame.w = next; x += next; }
      }
    } else {
      for (const frame of members) frame.h = next;
    }
  });
}

export function setStripPivot(services, sheetId, animationId, key, value) {
  const { members } = resolveStrip(services, sheetId, animationId);
  if (!members.length) return;
  if (members.every(frame => frame[key] === value)) return;
  commitStripEdit(services, sheetId, 'strip pivot', members, () => {
    for (const frame of members) frame[key] = value;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sprite-frame-metadata-commands.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/commands/frame-metadata-commands.js tests/sprite-frame-metadata-commands.test.mjs
git commit -m "feat(sprites): move frame/strip field-edit commands into the application layer"
```

---

### Task 8: Animation Command Handlers (`application/commands/animation-commands.js`)

**Files:**
- Create: `js/modes/sprites/application/commands/animation-commands.js`
- Test: `tests/sprite-animation-commands.test.mjs`

**Interfaces:**
- Consumes: Task 5's `findSpriteSheet`, `runSheetCommand`; `js/core/model.js`'s `acceptAnimation` (imported aliased as `acceptAnimationOnSheet` to avoid shadowing this module's own export); `js/app/state.js`'s `state`, `emit`, `activeSheet`.
- Produces: `breakApartStrip(services, sheetId, animationId)`, `acceptAnimation(services, sheetId, animationId)`.

Direct port of `js/features/animations/commands.js`'s `commitBreakApartStrip`/`commitAcceptAnimation`. Task 13 rewrites that file as a dispatch-by-id façade (it is **not** deleted — `js/ui/timeline.js` and `js/ui/tools.js` still import from it, and both are out of scope until sub-phases 2b/2c).

Semantics carried over verbatim, each pinned by a test:

- `commitBreakApartStrip` — `do()` sets `animation.strip = false; animation.breaks = [];`, `undo()` restores `strip = true` and the snapshotted breaks. Does **not** emit `'selection'`.
- `commitAcceptAnimation` — **idempotency guard `if (animation.layerGroupId) return;` with no history entry.** `acceptAnimation` from `core/model.js` runs eagerly (it freezes the visible pixels under each frame into one brand-new layer, appends the group to `sheet.layerTree.children`, and sets `anim.layerGroupId`); the pushed command's `do()` re-applies that idempotently and `undo()` detaches the group and restores the previously active layer id. `groupIndex` is captured before the command so `undo`/`redo` re-insert the group at the same tree position. `state.activeLayerId` is only reassigned when `sheet === activeSheet()` on `do`, and on `undo` only when it still points at the animation's layer. Emits `'selection'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/sprite-animation-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { breakApartStrip, acceptAnimation } from '../js/modes/sprites/application/commands/animation-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [{ id: 'a', name: 'a', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }],
    animations: [{
      id: 'an1', name: 'strip_0', loop: true, strip: true, breaks: [1],
      frames: [{ frameId: 'a', duration: 100 }], layerGroupId: null, baseDuration: 100,
    }],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
  state.activeLayerId = null;
}

test('breakApartStrip clears the strip flag and its breaks, and undo restores both', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const anim = project.sheets[0].animations[0];

  breakApartStrip(services, 'sheet1', 'an1');
  assert.equal(anim.strip, false);
  assert.deepEqual(anim.breaks, []);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(anim.strip, true);
  assert.deepEqual(anim.breaks, [1]);
});

test('acceptAnimation gives a floating animation its own layer group and undo detaches it', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = sheet.animations[0];

  acceptAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.layerTree.children.length, 1);
  const group = sheet.layerTree.children[0];
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(group.animationId, 'an1');
  assert.equal(state.activeLayerId, group.children[0].id);

  services.history.undo();
  assert.equal(anim.layerGroupId, null);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(state.activeLayerId, null);

  services.history.redo();
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(sheet.layerTree.children[0], group);
});

test('acceptAnimation is a no-op with no history entry once the animation is already accepted', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  project.sheets[0].animations[0].layerGroupId = 'already';

  acceptAnimation(services, 'sheet1', 'an1');
  assert.equal(services.history.canUndo(), false);
  assert.equal(project.sheets[0].layerTree.children.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sprite-animation-commands.test.mjs`
Expected: FAIL — `js/modes/sprites/application/commands/animation-commands.js` does not exist.

- [ ] **Step 3: Write the implementation**

```js
// js/modes/sprites/application/commands/animation-commands.js
import { acceptAnimation as acceptAnimationOnSheet } from '../../../../core/model.js';
import { state, emit, activeSheet } from '../../../../app/state.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function findAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  return { sheet, animation: sheet?.animations.find(a => a.id === animationId) ?? null };
}

// Break apart = the animation keeps its frame entries but stops owning frame
// geometry: members move individually and become resizable again.
export function breakApartStrip(services, sheetId, animationId) {
  const { animation } = findAnimation(services, sheetId, animationId);
  if (!animation) return;
  const beforeBreaks = (animation.breaks ?? []).slice();
  runSheetCommand(services, sheetId, 'break apart strip',
    () => { animation.strip = false; animation.breaks = []; },
    () => { animation.strip = true; animation.breaks = beforeBreaks.slice(); });
}

// Promotes a floating animation into a committed one by freezing whatever is
// currently visible under its own frames into a brand-new layer group.
// core/model.js's acceptAnimation runs eagerly here; the pushed command's
// do() re-applies it idempotently.
export function acceptAnimation(services, sheetId, animationId) {
  const { sheet, animation } = findAnimation(services, sheetId, animationId);
  if (!sheet || !animation) return;
  if (animation.layerGroupId) return;
  const beforeActiveLayerId = state.activeLayerId;
  const group = acceptAnimationOnSheet(sheet, animation);
  const animationLayerId = group.children[0].id;
  const groupIndex = sheet.layerTree.children.indexOf(group);

  runSheetCommand(services, sheetId, 'accept animation',
    target => {
      animation.layerGroupId = group.id;
      if (!target.layerTree.children.includes(group)) {
        target.layerTree.children.splice(Math.min(groupIndex, target.layerTree.children.length), 0, group);
      }
      if (target === activeSheet()) state.activeLayerId = animationLayerId;
    },
    target => {
      animation.layerGroupId = null;
      target.layerTree.children = target.layerTree.children.filter(child => child !== group);
      if (state.activeLayerId === animationLayerId) state.activeLayerId = beforeActiveLayerId;
    });
  emit('selection');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sprite-animation-commands.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add js/modes/sprites/application/commands/animation-commands.js tests/sprite-animation-commands.test.mjs
git commit -m "feat(sprites): move break-apart/accept-animation commands into the application layer"
```

---

### Task 9: Overlay Renderer (`presentation/frame-overlay-renderer.js`)

**Files:**
- Create: `js/modes/sprites/presentation/frame-overlay-renderer.js`

**Interfaces:**
- Consumes: Task 2's `resizeGhostRect`; Task 3's `chromeGeometry`, `standaloneGripGeometry`, `selectedSegment`, `CALLOUT_R`; `js/core/slicing.js`'s `sliceGrid`; `js/core/strips.js`'s `segmentsOf`, `segmentOfFrame`, `segmentMembers`; `js/core/resizeAnchor.js`'s `HANDLES_CORNER`; `js/domain/sprites/frames.js`'s `frameBounds`; `js/domain/sprites/strips.js`'s `stripForFrame`; `js/ui/dimlabels.js`'s `drawRectDims`, `drawChainDims`.
- Produces: `paintFrameToolGhost(ctx, view, sheet, { tool, drag, slicePreview })`, `paintStripChrome(ctx, view, sheet, { tool, drag, hover, selectedFrameId })`.

Straight move of every drawing function from `sprite-sheet-controller.js` (`strokeGhostRect` 726, `drawHandles` 742, `drawStripDims` 756, `drawSlicePreview` 774, `drawCallout` 913, `drawGrips` 928, `drawChrome` 938, `drawStandaloneStripGrips` 958, `drawBreakSeparators` 967, `drawFrameToolGhost` 992, `drawStripChrome` 1068). Two mechanical changes: the module-level `drag`/`hover`/`slicePreviewOpts` singletons and the legacy `state.mode`/`state.tool`/`state.selectedFrameId`/`activeSheet()` reads become **explicit parameters**, and `boundingBoxOf` is called by its real name `frameBounds`. The `state.mode !== 'sprites'` guard moves up into the Presenter's thin wrapper (Task 11), since mode is not this module's concern. This is the only new sprites file allowed to touch `CanvasRenderingContext2D` per the architecture test — it owns Canvas drawing.

Ordering that must be preserved exactly: `paintFrameToolGhost` draws the slice preview **regardless of the active tool** (the dialog can be open while another tool is selected), then break separators only for `frametool`, then the in-progress drag ghost. `paintStripChrome` is chained by `contributions.js` as the **final** overlay layer so selection chrome renders above the frame/tile label overlays.

- [ ] **Step 1: Write the implementation** (no automated test — Canvas drawing is verified manually per project convention)

```js
// js/modes/sprites/presentation/frame-overlay-renderer.js
// All Canvas drawing for the frame tool: create/move/resize ghosts, CAD
// dimension labels, corner handles, in-strip call-outs/grips, break
// separators, and the live Slice-grid preview. Every piece of state it needs
// (active drag, hovered chrome part, current tool, selected frame, slice
// preview options) arrives as a parameter -- this module owns no state.
import { sliceGrid } from '../../../core/slicing.js';
import { segmentsOf, segmentOfFrame, segmentMembers } from '../../../core/strips.js';
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';
import { drawRectDims, drawChainDims } from '../../../ui/dimlabels.js';
import { resizeGhostRect } from '../application/frame-geometry.js';
import { chromeGeometry, standaloneGripGeometry, selectedSegment, CALLOUT_R } from '../application/frame-chrome-geometry.js';

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

// Strip dimensions: level-0 width chain (one dimension per member, in x
// order) below the bbox, level-1 overall width, single level-0 height
// (members share it), origin marker on the bbox. dx/dy shift everything to
// the drag-ghost position; opts carries quiet/dx/dy for drawRectDims.
function drawStripDims(ctx, view, members, dx, dy, opts = {}) {
  const bbox = frameBounds(members);
  const r = { x: bbox.x + dx, y: bbox.y + dy, w: bbox.w, h: bbox.h };
  const alpha = opts.quiet ? 0.7 : 1;
  const sorted = members.slice().sort((m, n) => m.x - n.x);
  drawChainDims(ctx, view, {
    axis: 'h', edge: r.y + r.h,
    spans: sorted.map(m => ({ from: m.x + dx, to: m.x + m.w + dx, text: `${m.w}` })),
    alpha,
  });
  drawRectDims(ctx, view, r, { ...opts, wLevel: 1, hLevel: 0 });
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

function drawCallout(ctx, c, glyph, active) {
  ctx.beginPath();
  ctx.arc(c.cx, c.cy, CALLOUT_R, 0, Math.PI * 2);
  ctx.fillStyle = active ? '#4f8cff' : 'rgba(20,20,24,.85)';
  ctx.fill();
  ctx.strokeStyle = '#4f8cff';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = active ? '#fff' : '#a9c7ff';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, c.cx, c.cy + 0.5);
}

function drawGrips(ctx, grips, hover) {
  for (const gr of grips) {
    const active = hover?.type === 'grip' && hover.side === gr.side;
    ctx.globalAlpha = active ? 1 : 0.7;
    ctx.fillStyle = '#4f8cff';
    ctx.fillRect(gr.x, gr.y, gr.w, gr.h);
    ctx.globalAlpha = 1;
  }
}

function drawChrome(ctx, view, sheet, drag, hover, selectedFrameId) {
  if (drag) return;
  const sel = selectedSegment(sheet, selectedFrameId);
  if (!sel) return;
  const g = chromeGeometry((x, y) => view.imageToScreen(x, y), sheet, sel.anim, sel.run);
  if (!g) return;
  ctx.save();
  for (const c of g.inserts)
    drawCallout(ctx, c, '+', hover?.type === 'insert' && hover.k === c.k);
  for (const c of g.splits)
    drawCallout(ctx, c, '✂', hover?.type === 'split' && hover.k === c.k);
  drawGrips(ctx, g.grips, hover);
  ctx.restore();
}

// "Drag out as a new strip" chrome for a selected standalone frame: reuses
// an intact strip's own edge-grip look and geometry so grabbing an edge and
// dragging away reads as exactly the same gesture as growing an existing
// strip -- because that's literally what the presenter does with it.
function drawStandaloneStripGrips(ctx, view, frame, drag, hover) {
  if (drag) return;
  const g = standaloneGripGeometry((x, y) => view.imageToScreen(x, y), frame);
  ctx.save();
  drawGrips(ctx, g.grips, hover);
  ctx.restore();
}

// A split whose halves haven't moved yet is invisible geometry — mark it.
function drawBreakSeparators(ctx, view, sheet) {
  ctx.save();
  ctx.strokeStyle = '#ffb454';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    const runs = segmentsOf(a);
    for (let i = 1; i < runs.length; i++) {
      const prev = segmentMembers(sheet, a, runs[i - 1]);
      const next = segmentMembers(sheet, a, runs[i]);
      if (!prev.length || !next.length) continue;
      const pl = prev[prev.length - 1], nf = next[0];
      if (nf.x !== pl.x + pl.w || nf.y !== pl.y) continue;
      const p0 = view.imageToScreen(nf.x, nf.y);
      const p1 = view.imageToScreen(nf.x, nf.y + nf.h);
      ctx.beginPath();
      ctx.moveTo(p0.x + 0.5, p0.y);
      ctx.lineTo(p1.x + 0.5, p1.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function paintFrameToolGhost(ctx, view, sheet, { tool, drag, slicePreview }) {
  if (!sheet) return;

  if (slicePreview) drawSlicePreview(ctx, view, sheet, slicePreview);
  if (tool === 'frametool') drawBreakSeparators(ctx, view, sheet);
  if (!drag) return;

  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'move' && drag.bbox) {
    const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
    const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
    if (drag.snap) ctx.strokeStyle = '#6adf7a';
    // Single frame or strip: the bbox already covers just the grabbed
    // frame in the non-strip case, so this one branch handles both.
    strokeGhostRect(ctx, view, { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h });
  }
  else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'stripresize') strokeGhostRect(ctx, view, resizeGhostRect(drag));
  ctx.restore();

  if (drag.kind === 'create' && drag.rect) {
    drawRectDims(ctx, view, drag.rect);
  } else if (drag.kind === 'move' && drag.bbox) {
    const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
    const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
    if (drag.members.length > 1) {
      drawStripDims(ctx, view, drag.members, dx, dy, { dx, dy });
    } else {
      const r = { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h };
      drawRectDims(ctx, view, r, { dx, dy });
    }
  } else if (drag.kind === 'resize' && drag.rect) {
    drawRectDims(ctx, view, drag.rect, {
      dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h,
    });
  } else if (drag.kind === 'stripresize') {
    const r = resizeGhostRect(drag);
    drawChainDims(ctx, view, {
      axis: 'h', edge: r.y + r.h,
      spans: Array.from({ length: drag.count }, (_, i) =>
        ({ from: r.x + i * drag.fw, to: r.x + (i + 1) * drag.fw, text: `${drag.fw}` })),
    });
    const df = drag.count - drag.count0;
    drawRectDims(ctx, view, r, {
      wLevel: 1, hLevel: 0,
      wOverride: `${r.w}${df ? ` (${df > 0 ? '+' : ''}${df}f)` : ''}`,
    });
  }

  if (drag.kind === 'move' && drag.snap) {
    const jx = drag.snap.side === 'before'
      ? drag.bbox.x + drag.snap.dx + drag.bbox.w   // dragged right edge
      : drag.bbox.x + drag.snap.dx;                 // dragged left edge
    const jy = drag.bbox.y + drag.snap.dy;
    const p0 = view.imageToScreen(jx, jy);
    const p1 = view.imageToScreen(jx, jy + drag.bbox.h);
    ctx.save();
    ctx.strokeStyle = '#6adf7a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.restore();
  }
}

// Selection chrome — the idle dims, resize handles, and the strip call-outs/
// grips — must render above EVERYTHING on the sheet overlay (including the
// frame/tile label overlays chained after the frame tool), so contributions.js
// chains this as the final overlay layer instead of drawing it inside
// paintFrameToolGhost.
export function paintStripChrome(ctx, view, sheet, { tool, drag, hover, selectedFrameId }) {
  if (tool !== 'frametool' || !sheet) return;
  const selected = sheet.frames.find(f => f.id === selectedFrameId);
  const strip = selected ? stripForFrame(sheet, selected.id) : null;
  if (selected && !drag) {
    const run = strip ? segmentOfFrame(strip, selected.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : null;
    // A 1-member strip degenerates to the plain single-frame case (no
    // chain, no level-1 row) — matching the drag path's members.length gate.
    if (members && members.length > 1) drawStripDims(ctx, view, members, 0, 0, { quiet: true });
    else drawRectDims(ctx, view, selected, { quiet: true });
  }
  // No resize handles on intact-strip members.
  if (selected && !strip) {
    drawHandles(ctx, view, selected);
    drawStandaloneStripGrips(ctx, view, selected, drag, hover);
  }
  drawChrome(ctx, view, sheet, drag, hover, selectedFrameId);
}
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/sprites/presentation/frame-overlay-renderer.js
git commit -m "feat(sprites): add presentation-layer frame overlay renderer"
```

---

### Task 10: Slice-grid dialog (`presentation/slice-grid-dialog.js`)

**Files:**
- Create: `js/modes/sprites/presentation/slice-grid-dialog.js`

**Interfaces:**
- Consumes: `js/app/state.js`'s `state`, `activeSheet`; `js/host/runtime.js`'s `getEditorHost`; `js/ui/dialogs.js`'s `markDefaultAction`.
- Produces: `buildSliceDialog()` → `{ open() }`, `setSlicePreviewView(view)`, `slicePreviewOptions()`.
- Dispatches (by id, never by import): `sprites.sliceGrid` with `{ sheetId, options, replace }`.

Move of `buildSliceDialog` (line 1191) plus the `slicePreviewOpts`/`sheetViewForPreview` module state (lines 45-46) that only the dialog writes. The only behavioral change is that the Create button dispatches `sprites.sliceGrid` instead of building a `state.commands` entry inline; `sheetWidth`/`sheetHeight` are no longer passed in `options` because the handler reads them off the sheet it resolves (Task 5).

`slicePreviewOptions()` returns the live preview options (or `null` when the dialog is closed) so the Presenter can hand them to the renderer each frame — replacing the renderer's old direct read of the module-level `slicePreviewOpts`.

- [ ] **Step 1: Write the implementation** (no automated test — DOM dialog, verified manually)

```js
// js/modes/sprites/presentation/slice-grid-dialog.js
import { state, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { markDefaultAction } from '../../../ui/dialogs.js';

// Live Slice-grid preview: the dialog's current values while it is open, else
// null. The sheet view handle lets dialog input events trigger repaints.
let slicePreviewOpts = null;
let sheetViewForPreview = null;

export function slicePreviewOptions() { return slicePreviewOpts; }
export function setSlicePreviewView(view) { sheetViewForPreview = view; }

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it — this file lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  return getEditorHost()?.registries.commands.execute(id, { modeId: state.mode }, args);
}

export function buildSliceDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Slice grid</h3>
    <div class="row"><label>Cell W <input type="number" id="sg-cellw" min="1" value="16"></label></div>
    <div class="row"><label>Cell H <input type="number" id="sg-cellh" min="1" value="16"></label></div>
    <div class="row"><label>Margin X <input type="number" id="sg-marginx" min="0" value="0"></label></div>
    <div class="row"><label>Margin Y <input type="number" id="sg-marginy" min="0" value="0"></label></div>
    <div class="row"><label>Spacing X <input type="number" id="sg-spacingx" min="0" value="0"></label></div>
    <div class="row"><label>Spacing Y <input type="number" id="sg-spacingy" min="0" value="0"></label></div>
    <div class="row"><label>Prefix <input type="text" id="sg-prefix" value="frame"></label></div>
    <div class="row"><label><input type="checkbox" id="sg-replace"> Replace existing frames</label></div>
    <div class="row dlg-actions"><button type="button" id="sg-create">Create</button><button type="button" id="sg-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
  const readPreview = () => ({
    cellW: intVal($('#sg-cellw'), 1), cellH: intVal($('#sg-cellh'), 1),
    marginX: intVal($('#sg-marginx'), 0), marginY: intVal($('#sg-marginy'), 0),
    spacingX: intVal($('#sg-spacingx'), 0), spacingY: intVal($('#sg-spacingy'), 0),
  });
  for (const id of ['#sg-cellw', '#sg-cellh', '#sg-marginx', '#sg-marginy', '#sg-spacingx', '#sg-spacingy'])
    $(id).addEventListener('input', () => {
      if (!slicePreviewOpts) return;
      slicePreviewOpts = readPreview();
      sheetViewForPreview?.requestRender();
    });
  dlg.addEventListener('close', () => {
    slicePreviewOpts = null;
    sheetViewForPreview?.requestRender();
  });
  markDefaultAction(dlg, $('#sg-create'));
  $('#sg-cancel').addEventListener('click', () => dlg.close());
  $('#sg-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const options = { ...readPreview(), namePrefix: $('#sg-prefix').value.trim() || 'frame' };
    dispatch('sprites.sliceGrid', { sheetId: sheet.id, options, replace: $('#sg-replace').checked });
    dlg.close();
  });
  return {
    open() {
      slicePreviewOpts = readPreview();
      dlg.showModal();
      sheetViewForPreview?.requestRender();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/sprites/presentation/slice-grid-dialog.js
git commit -m "feat(sprites): move the slice-grid dialog into the presentation layer"
```

---

### Task 11: Presenter (`presentation/frame-tool-presenter.js`)

**Files:**
- Create: `js/modes/sprites/presentation/frame-tool-presenter.js`

**Interfaces:**
- Consumes: Tasks 1-3's `frameToolOptions` and geometry; Task 9's `paintFrameToolGhost`, `paintStripChrome`; Task 10's `buildSliceDialog`, `setSlicePreviewView`, `slicePreviewOptions`; `js/app/state.js`'s `state`, `on`, `emit`, `activeSheet`; `js/host/runtime.js`'s `getEditorHost`; `js/ui/tools.js`'s `registerTool`; `js/core/resizeAnchor.js`'s `isCenterAnchorModifier`, `isProportionalModifier`, `resizeRectFromHandle`; `js/domain/sprites/strips.js`'s `stripForFrame`; `js/core/strips.js`'s `segmentOfFrame`, `segmentMembers`; `js/domain/sprites/frames.js`'s `frameBounds`.
- Produces: `registerFrameTool()`, `bindFrameTool(view)`, `drawStripChrome(ctx, view)` — the **same three exported names and signatures the old controller had**, so `contributions.js` (Task 13) changes only its import path and its command registrations.
- **Command-id contract this Presenter dispatches against** (Task 13 must register every one of these, with exactly these arg shapes):
  - `sprites.createFrame` `{ sheetId, rect }`
  - `sprites.deleteFrame` `{ sheetId, frameId }`
  - `sprites.resizeFrame` `{ sheetId, frameId, before, after }`
  - `sprites.moveFrames` `{ sheetId, frameIds, dx, dy, animationId }`
  - `sprites.sliceGrid` `{ sheetId, options, replace }` (dispatched by Task 10's dialog)
  - `sprites.insertStripFrame` `{ sheetId, animationId, runIndex, k }`
  - `sprites.splitStrip` `{ sheetId, animationId, index }`
  - `sprites.resizeStripSegment` `{ sheetId, animationId, runIndex, side, count }`
  - `sprites.removeStripMember` `{ sheetId, animationId, frameId }`
  - `sprites.mergeStripSegments` `{ sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy }`
  - `sprites.newStripFromFrame` `{ sheetId, frameId, side, count }`
  - `sprites.acceptAnimation` `{ sheetId, animationId }`
  - (`sprites.setFrameField`, `sprites.moveStripTo`, `sprites.setStripFrameSize`, `sprites.setStripPivot`, `sprites.breakApartStrip` are dispatched by Task 12's panel and Task 13's façade, not by this file.)

This file contains **zero imports from `application/commands/**`**, satisfying `tests/architecture.test.mjs`'s existing rule. Selection stays on legacy `state.selectedFrameId`/`state.selectedAnimationId`/`state.editingFrameId`/`state.view` exactly where today's code reads and writes them — migrating those to `SelectionService` is sub-phase 2d.

One behavioral consolidation, already noted in Task 5: today's `handleUp` guards the move commit with `if (dx !== 0 || dy !== 0)`; that guard now lives inside the `moveFrames` handler, so the Presenter dispatches unconditionally and the handler no-ops. Net behavior identical, and it means the panel and any future caller get the same guard for free.

- [ ] **Step 1: Write the implementation** (pointer/keyboard wiring — verified manually, matching project convention for drag interactions; no automated test)

```js
// js/modes/sprites/presentation/frame-tool-presenter.js
// Humble Object for the frame/strip tool: binds pointer + keyboard events,
// calls pure Application-layer geometry for every decision, dispatches
// Commands BY ID, and delegates all drawing to frame-overlay-renderer.js.
//
// API shape mirrors ui/tools.js's split between "mount UI" and "bind a
// CanvasView": registerFrameTool() adds the palette button + its tool-options
// row (snap checkbox, grid size, slice button) and the Delete/Enter key
// handlers; bindFrameTool(view) wraps the view's existing onPointer/onOverlay,
// so it must run after bindDrawing() has installed its own.
import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { registerTool } from '../../../ui/tools.js';
import { isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../../core/resizeAnchor.js';
import { segmentOfFrame, segmentMembers } from '../../../core/strips.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';
import { frameToolOptions } from '../application/frame-tool-state.js';
import {
  snapPoint, snapRect, rectBetween, frameAt, clampMoveDelta, stripResizeCount,
} from '../application/frame-geometry.js';
import {
  hitHandle, hitGrip, hitChrome, chromeGeometry, standaloneGripGeometry, selectedSegment, findSnap,
} from '../application/frame-chrome-geometry.js';
import { paintFrameToolGhost, paintStripChrome } from './frame-overlay-renderer.js';
import { buildSliceDialog, setSlicePreviewView, slicePreviewOptions } from './slice-grid-dialog.js';

// In-progress drag state (create/move/resize/stripresize), module-scoped like
// ui/tools.js's `selection`/`stroke` — there is only ever one frame-tool drag
// at a time. `lastClick` is the previous pointerdown's { frameId, t } for
// double-click detection; `hover` is the chrome part under the pointer.
let drag = null;
let lastClick = null;
let hover = null;

// Set once by registerFrameTool() (which builds the dialog before the tool
// palette can render its options row); the button just defers to whatever's
// there.
let sliceDialogApi = null;

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// Sheet-space -> screen-space projector handed to the Application layer's
// chrome geometry, so it never has to know about CanvasView.
function projector(view) { return (x, y) => view.imageToScreen(x, y); }

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly — this Presenter lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args);
}

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet();
  if (!sheet) return;
  const toScreen = projector(view);
  if (state.tool === 'frametool') {
    // Chrome is always visible for the selected segment, so hit-test it
    // directly at the down position — no dependence on hover state.
    const sel = selectedSegment(sheet, state.selectedFrameId);
    const g = sel && chromeGeometry(toScreen, sheet, sel.anim, sel.run);
    const part = g && hitChrome(g, ev.sx, ev.sy);
    if (part?.type === 'grip') {
      const members = g.members;
      drag = {
        kind: 'stripresize', anim: sel.anim, run: sel.run, side: part.side,
        fw: g.fw, fh: members[0].h, bbox: g.bbox,
        count0: members.length, count: members.length,
      };
      view.requestRender();
      return;
    }
    if (part?.type === 'insert') {
      dispatch('sprites.insertStripFrame', { sheetId: sheet.id, animationId: sel.anim.id, runIndex: sel.run.index, k: part.k });
      view.requestRender();
      return;
    }
    if (part?.type === 'split') {
      dispatch('sprites.splitStrip', { sheetId: sheet.id, animationId: sel.anim.id, index: sel.run.start + part.k });
      view.requestRender();
      return;
    }
  }
  // Double-click (two downs on the same frame within 350ms) opens the frame
  // editor and points the timeline at the frame's animation.
  const clickHit = frameAt(sheet, ev.x, ev.y);
  const now = performance.now();
  if (clickHit && lastClick && lastClick.frameId === clickHit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    state.editingFrameId = clickHit.id;
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === clickHit.id)) ?? null;
    state.selectedAnimationId = owner ? owner.id : null;
    state.view = 'frame';
    emit('view');
    emit('selection');
    return;
  }
  lastClick = clickHit ? { frameId: clickHit.id, t: now } : null;
  const selected = sheet.frames.find(f => f.id === state.selectedFrameId) || null;
  // Intact-strip members have no resize handles: skip hit detection entirely
  // rather than just refusing the resulting drag, so a pointer-down on a
  // handle-shaped spot falls through to the move/create checks below.
  const handle = (selected && !stripForFrame(sheet, selected.id)) ? hitHandle(toScreen, selected, ev.sx, ev.sy) : null;
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
  // Standalone frame's own "drag out as a new strip" grip -- checked after
  // corner handles (so a corner still resizes) but before the plain move/
  // create checks below. Reuses the 'stripresize' drag kind with anim: null
  // to mean "no strip exists yet"; the ghost/dims are anim-agnostic already,
  // so only handleUp branches (newStripFromFrame vs resizeStripSegment).
  if (selected && !stripForFrame(sheet, selected.id)) {
    const sg = standaloneGripGeometry(toScreen, selected);
    const gripHit = hitGrip(sg.grips, ev.sx, ev.sy);
    if (gripHit) {
      drag = {
        kind: 'stripresize', anim: null, run: null, frame: selected, side: gripHit.side,
        fw: sg.fw, fh: sg.fh, bbox: sg.bbox, count0: 1, count: 1,
      };
      view.requestRender();
      return;
    }
  }
  const hit = frameAt(sheet, ev.x, ev.y);
  if (hit) {
    // Selecting a frame also selects its owning animation (or clears the
    // animation selection when the frame is standalone), so the timeline
    // and layers panel never keep a stale animation highlighted.
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === hit.id)) ?? null;
    const ownerId = owner ? owner.id : null;
    const frameChanged = state.selectedFrameId !== hit.id;
    const animChanged = state.selectedAnimationId !== ownerId;
    if (frameChanged) state.selectedFrameId = hit.id;
    if (animChanged) state.selectedAnimationId = ownerId;
    if (frameChanged || animChanged) emit('selection');
    // If `hit` belongs to an intact strip, the drag targets every member of
    // the grabbed SEGMENT together (move-as-unit); otherwise just the frame.
    const strip = stripForFrame(sheet, hit.id);
    const run = strip ? segmentOfFrame(strip, hit.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : [hit];
    drag = {
      kind: 'move', frame: hit, anim: strip, run, members, snap: null,
      bbox: frameBounds(members),
      anchor: { x: ev.x, y: ev.y }, delta: { dx: 0, dy: 0 },
    };
    view.requestRender();
    return;
  }
  if (state.selectedFrameId !== null || state.selectedAnimationId !== null) {
    state.selectedFrameId = null;
    state.selectedAnimationId = null;
    emit('selection');
  }
  drag = { kind: 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) { updateHover(ev, view); return; }
  if (drag.kind === 'create') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true), frameToolOptions);
  } else if (drag.kind === 'move') {
    const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y), frameToolOptions);
    drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
    const sheet = activeSheet();
    drag.snap = (drag.anim && sheet && (drag.delta.dx !== 0 || drag.delta.dy !== 0)) ? findSnap(sheet, drag, view.zoom) : null;
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    }), frameToolOptions);
  } else if (drag.kind === 'stripresize') {
    drag.count = stripResizeCount(activeSheet(), drag, ev.x);
  }
  view.requestRender();
}

function handleUp(ev, view) {
  if (!drag) return;
  handleMove(ev, view);
  const sheet = activeSheet();
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
    if (d.snap) {
      dispatch('sprites.mergeStripSegments', {
        sheetId: sheet.id, animationId: d.anim.id, runIndex: d.run.index,
        targetAnimationId: d.snap.anim.id, targetRunIndex: d.snap.run.index,
        side: d.snap.side, dx: d.snap.dx, dy: d.snap.dy,
      });
      return;
    }
    // Clamp the common delta so the whole bounding box (single frame or every
    // strip member) stays fully on-sheet. A zero delta is a no-op inside the
    // moveFrames handler, so no guard is needed here.
    const { dx, dy } = clampMoveDelta(sheet, d.bbox, d.delta);
    dispatch('sprites.moveFrames', {
      sheetId: sheet.id, frameIds: d.members.map(f => f.id), dx, dy,
      animationId: d.anim ? d.anim.id : null,
    });
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      dispatch('sprites.resizeFrame', { sheetId: sheet.id, frameId: d.frame.id, before: d.before, after: r });
    return;
  }
  if (d.kind === 'stripresize') {
    if (d.count === d.count0) return;
    if (d.anim) dispatch('sprites.resizeStripSegment', { sheetId: sheet.id, animationId: d.anim.id, runIndex: d.run.index, side: d.side, count: d.count });
    else dispatch('sprites.newStripFromFrame', { sheetId: sheet.id, frameId: d.frame.id, side: d.side, count: d.count });
    return;
  }
}

function updateHover(ev, view) {
  let next = null;
  const sheet = activeSheet();
  if (sheet && state.mode === 'sprites' && state.tool === 'frametool' && !drag) {
    const toScreen = projector(view);
    const sel = selectedSegment(sheet, state.selectedFrameId);
    if (sel) {
      const g = chromeGeometry(toScreen, sheet, sel.anim, sel.run);
      if (g) next = hitChrome(g, ev.sx, ev.sy);
    } else {
      const selectedFrame = sheet.frames.find(f => f.id === state.selectedFrameId);
      if (selectedFrame && !stripForFrame(sheet, selectedFrame.id))
        next = hitGrip(standaloneGripGeometry(toScreen, selectedFrame).grips, ev.sx, ev.sy);
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(hover)) {
    hover = next;
    view.requestRender();
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
  registerTool({ id: 'frametool', icon: '🖼', key: 'f', isAvailable: () => state.mode === 'sprites' }, buildOptionsRow);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'frametool' || state.mode !== 'sprites') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripForFrame(sheet, state.selectedFrameId);
    if (strip) dispatch('sprites.removeStripMember', { sheetId: sheet.id, animationId: strip.id, frameId: state.selectedFrameId });
    else dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId: state.selectedFrameId });
  });

  // Accepts whichever animation is currently selected in the timeline dock,
  // if it's still floating -- works for plain animations too, not just
  // strips, since it keys off state.selectedAnimationId rather than the
  // selected frame (a plain animation's frames aren't reliably discoverable
  // via stripForFrame(), which requires strip: true).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'frametool' || state.mode !== 'sprites') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedAnimationId) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim && !anim.layerGroupId) dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: anim.id });
  });
}

function drawFrameToolGhost(ctx, view) {
  if (state.mode !== 'sprites') return;
  paintFrameToolGhost(ctx, view, activeSheet(), {
    tool: state.tool, drag, slicePreview: slicePreviewOptions(),
  });
}

export function drawStripChrome(ctx, view) {
  if (state.mode !== 'sprites') return;
  paintStripChrome(ctx, view, activeSheet(), {
    tool: state.tool, drag, hover, selectedFrameId: state.selectedFrameId,
  });
}

export function bindFrameTool(view) {
  setSlicePreviewView(view);
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'sprites' && state.tool === 'frametool') {
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

  on('project', () => { if (drag) { drag = null; view.requestRender(); } });
  on('tool', () => { if (state.tool !== 'frametool' && drag) { drag = null; view.requestRender(); } });
}
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/sprites/presentation/frame-tool-presenter.js
git commit -m "feat(sprites): add frame-tool Presenter dispatching commands by id"
```

---

### Task 12: Frames panel (`presentation/frames-panel.js`)

**Files:**
- Create: `js/modes/sprites/presentation/frames-panel.js` (replacement for `js/modes/sprites/frame-panel.js`, which Task 13 deletes)

**Interfaces:**
- Consumes: Task 2's `stripMembers`; `js/app/state.js`'s `state`, `on`, `emit`, `activeSheet`; `js/host/runtime.js`'s `getEditorHost`; `js/core/strips.js`'s `segmentsOf`; `js/domain/sprites/strips.js`'s `stripForFrame`; `js/domain/sprites/frames.js`'s `frameBounds`.
- Produces: `mountFramesPanel(element)` → `{ dispose() }` — same exported name/signature/return contract as today, registered identically in `contributions.js` (Task 13) under panel id `sprites.frames`.
- Dispatches (by id): `sprites.setFrameField`, `sprites.moveStripTo`, `sprites.setStripFrameSize`, `sprites.setStripPivot`, `sprites.breakApartStrip`, `sprites.removeStripMember`, `sprites.deleteFrame`.

Straight port of `js/modes/sprites/frame-panel.js`: every DOM-building function, the microtask-batched `scheduleRender`, and the four `on(...)` subscriptions are unchanged. The only differences are that each of the seven mutating callbacks becomes a `dispatch(id, args)` instead of a direct import from `js/features/animations/*` or the old controller, and `stripMembers` now comes from the mode's own application layer. Argument shapes match the Presenter's contract in Task 11 exactly.

- [ ] **Step 1: Write the implementation** (no automated test — DOM panel, verified manually; `tests/panels.test.mjs` covers the shared layers panel, not this one)

```js
// js/modes/sprites/presentation/frames-panel.js
import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { segmentsOf } from '../../../core/strips.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripMembers } from '../application/frame-geometry.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly — this panel lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args);
}

function numericField(labelText, value, { step, onCommit }) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  if (step != null) input.step = String(step);
  input.value = String(value);
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => onCommit(Number(input.value)));
  label.appendChild(input);
  return label;
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

  const breakApartButton = document.createElement('button');
  breakApartButton.type = 'button';
  breakApartButton.className = 'btn-icon-md';
  breakApartButton.textContent = '✂';
  breakApartButton.title = 'Break apart';
  breakApartButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripForFrame(sheet, state.selectedFrameId);
    if (strip) dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: strip.id });
  });

  function actionsRow(sheet, frame, inStrip) {
    const actions = document.createElement('div');
    actions.className = 'row';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn-icon-md';
    editButton.textContent = '✎';
    editButton.title = 'Edit';
    editButton.addEventListener('click', () => {
      state.editingFrameId = frame.id;
      state.view = 'frame';
      emit('view');
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn-icon-md';
    deleteButton.textContent = '🗑';
    deleteButton.title = inStrip ? 'Delete frame' : 'Delete';
    deleteButton.addEventListener('click', () => {
      const strip = stripForFrame(sheet, frame.id);
      if (strip) dispatch('sprites.removeStripMember', { sheetId: sheet.id, animationId: strip.id, frameId: frame.id });
      else dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId: frame.id });
    });

    actions.append(editButton, deleteButton);
    if (inStrip) actions.appendChild(breakApartButton);
    return actions;
  }

  function renderFrameDetail(sheet, frame) {
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const setField = (key, value) => dispatch('sprites.setFrameField', { sheetId: sheet.id, frameId: frame.id, key, value });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = frame.name;
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (value) setField('name', value);
      else nameInput.value = frame.name;
    });

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', frame.x, { onCommit: value => setField('x', Math.round(value)) }),
      numericField('Y', frame.y, { onCommit: value => setField('y', Math.round(value)) }),
      numericField('W', frame.w, { onCommit: value => setField('w', Math.max(1, Math.round(value))) }),
      numericField('H', frame.h, { onCommit: value => setField('h', Math.max(1, Math.round(value))) }),
      numericField('PivotX', frame.pivotX, { step: 0.5, onCommit: value => setField('pivotX', value) }),
      numericField('PivotY', frame.pivotY, { step: 0.5, onCommit: value => setField('pivotY', value) }),
    );

    row.append(nameInput, fields, actionsRow(sheet, frame, false));
    list.appendChild(row);
  }

  function renderStripDetail(sheet, animation, selectedFrame) {
    const members = stripMembers(sheet, animation);
    if (!members.length) return;
    const bounds = frameBounds(members);
    const segmentCount = segmentsOf(animation).length;
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const title = document.createElement('div');
    title.className = 'frame-field';
    title.textContent = `Strip · ${members.length} frames${segmentCount > 1 ? ` · ${segmentCount} sub-strips` : ''}`;

    const args = extra => ({ sheetId: sheet.id, animationId: animation.id, ...extra });
    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', bounds.x, { onCommit: value => dispatch('sprites.moveStripTo', args({ x: value, y: bounds.y })) }),
      numericField('Y', bounds.y, { onCommit: value => dispatch('sprites.moveStripTo', args({ x: bounds.x, y: value })) }),
      numericField('W', members[0].w, { onCommit: value => dispatch('sprites.setStripFrameSize', args({ key: 'w', value })) }),
      numericField('H', members[0].h, { onCommit: value => dispatch('sprites.setStripFrameSize', args({ key: 'h', value })) }),
      numericField('PivotX', members[0].pivotX, { step: 0.5, onCommit: value => dispatch('sprites.setStripPivot', args({ key: 'pivotX', value })) }),
      numericField('PivotY', members[0].pivotY, { step: 0.5, onCommit: value => dispatch('sprites.setStripPivot', args({ key: 'pivotY', value })) }),
    );

    row.append(title, fields, actionsRow(sheet, selectedFrame, true));
    list.appendChild(row);
  }

  function render() {
    if (state.mode !== 'sprites') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    list.innerHTML = '';
    const sheet = activeSheet();
    const frame = sheet?.frames.find(candidate => candidate.id === state.selectedFrameId) ?? null;
    if (!sheet) return;
    if (!frame) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = 'No frame selected — click one with the frame tool.';
      list.appendChild(hint);
      return;
    }
    const strip = stripForFrame(sheet, frame.id);
    if (strip) renderStripDetail(sheet, strip, frame);
    else renderFrameDetail(sheet, frame);
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  const subscriptions = [
    on('project', scheduleRender),
    on('history', scheduleRender),
    on('view', scheduleRender),
    on('selection', scheduleRender),
  ];
  render();
  return { dispose() { subscriptions.forEach(dispose => dispose()); } };
}
```

- [ ] **Step 2: Commit**

```bash
git add js/modes/sprites/presentation/frames-panel.js
git commit -m "feat(sprites): move the Frames panel into the presentation layer, dispatching by id"
```

---

### Task 13: Wire contributions, convert the animations façade, delete the old files

**Files:**
- Modify: `js/modes/sprites/contributions.js`
- Modify: `js/features/animations/commands.js` (rewritten as a dispatch-by-id façade — **not** deleted)
- Modify: `tests/architecture.test.mjs` (two existing path references only; the new enforcement test lands in Task 14)
- Delete: `js/modes/sprites/sprite-sheet-controller.js`, `js/modes/sprites/frame-panel.js`, `js/features/animations/frame-metadata.js`

**Interfaces:**
- Consumes: Task 5's 5 handlers, Task 6's 6 handlers, Task 7's 4 handlers, Task 8's 2 handlers (imported **here**, not in `presentation/` — `contributions.js` sits outside `presentation/`, so this import is architecturally allowed); Task 11's `registerFrameTool`, `bindFrameTool`, `drawStripChrome`; Task 12's `mountFramesPanel`; `js/host/runtime.js`'s `getEditorHost`.
- Produces: the same public contribution ids as today — `sprites.preview`, `sprites.frame-tools`, `sprites.frames`, `sprites.animations`, `sprites.timeline`, `sprites.sheet`, `sprites.frame` — required by `tests/builtinmodes.test.mjs`'s exact-id, exact-order assertions, which must keep passing unchanged. Newly produces **17** `EditorHost` Command contributions matching the id/args contract Task 11's Presenter, Task 10's dialog, and Task 12's panel dispatch against.

The current `contributions.js` (verified by reading the file directly) is:

```js
import { registerFrameTool, bindFrameTool, drawStripChrome } from './sprite-sheet-controller.js';
import { mountFramesPanel } from './frame-panel.js';
import { mountAnimationsPanel } from '../../ui/animpanel.js';
import { mountTimeline } from '../../ui/timeline.js';
import { mountFrameEditor } from '../../ui/frameeditor.js';
import { renderSpritePreview } from './preview.js';

export function registerSpriteContributions(api) {
  api.previews.register({ id: 'sprites.preview', order: 10, when: keys => keys.modeId === 'sprites', render: renderSpritePreview });
  api.tools.register({
    id: 'sprites.frame-tools', label: 'Sprite frame tools', order: 10,
    createController({ canvasView }) {
      registerFrameTool();
      bindFrameTool(canvasView);
      return {
        decorateOverlay() {
          const prior = canvasView.onOverlay;
          canvasView.onOverlay = ctx => { prior(ctx); drawStripChrome(ctx, canvasView); };
        },
      };
    },
  });

  const whenSprites = keys => keys.modeId === 'sprites';
  api.panels.register({ id: 'sprites.frames', title: 'Frames', region: 'right', order: 10, mountPoint: 'panel-context', persistent: true, when: whenSprites, create: mountFramesPanel });
  api.panels.register({ id: 'sprites.animations', title: 'Animations', region: 'right', order: 20, mountPoint: 'panel-animation', persistent: true, when: whenSprites, create: mountAnimationsPanel });
  api.panels.register({ id: 'sprites.timeline', title: 'Timeline', region: 'bottom', order: 10, mountPoint: 'timeline-dock', useMountPointDirect: true, persistent: true, when: whenSprites, create: mountTimeline });

  api.views.register({ id: 'sprites.sheet', order: 10, create: (_host, { canvasView }) => ({ view: canvasView }) });
  api.views.register({ id: 'sprites.frame', order: 20, create: (_host, { canvasHost }) => mountFrameEditor(canvasHost) });
}
```

Everything below `registerSpriteCommands(api)` is preserved byte-for-byte from that file — same ids, `order`s, titles, regions, `mountPoint`s, the `decorateOverlay` chaining that keeps strip chrome as the topmost overlay layer, and the `sprites.timeline`/`sprites.animations`/`sprites.frame` registrations still pointing at `js/ui/timeline.js`, `js/ui/animpanel.js`, `js/ui/frameeditor.js` (sub-phases 2b/2c own those). Only the two import paths change and the command block is added.

- [ ] **Step 1: Rewrite `js/modes/sprites/contributions.js`**

```js
// js/modes/sprites/contributions.js
import { registerFrameTool, bindFrameTool, drawStripChrome } from './presentation/frame-tool-presenter.js';
import { mountFramesPanel } from './presentation/frames-panel.js';
import { mountAnimationsPanel } from '../../ui/animpanel.js';
import { mountTimeline } from '../../ui/timeline.js';
import { mountFrameEditor } from '../../ui/frameeditor.js';
import { renderSpritePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  createFrame, deleteFrame, resizeFrame, moveFrames, sliceSheetIntoFrames,
} from './application/commands/frame-commands.js';
import {
  insertStripFrame, splitStrip, resizeStripSegment, removeStripMember,
  mergeStripSegments, newStripFromFrame,
} from './application/commands/strip-commands.js';
import {
  setFrameField, moveStripTo, setStripFrameSize, setStripPivot,
} from './application/commands/frame-metadata-commands.js';
import { breakApartStrip, acceptAnimation } from './application/commands/animation-commands.js';

function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }

// Registered by id so presentation/ (the Presenter, the slice dialog, the
// Frames panel) and shared UI (js/features/animations/commands.js's façade)
// can dispatch through getEditorHost().registries.commands.execute(id,
// context, args) instead of importing these Command Handlers directly. This
// file lives outside presentation/, so importing application/commands/ here
// is fine; tests/architecture.test.mjs only bans that import from
// presentation/**.
function registerSpriteCommands(api) {
  const whenSprites = keys => keys.modeId === 'sprites';
  const command = (id, execute) => api.commands.register({ id, when: whenSprites, execute });

  command('sprites.createFrame', (_context, { sheetId, rect }) => createFrame(services(), sheetId, rect));
  command('sprites.deleteFrame', (_context, { sheetId, frameId }) => deleteFrame(services(), sheetId, frameId));
  command('sprites.resizeFrame', (_context, { sheetId, frameId, before, after }) => resizeFrame(services(), sheetId, frameId, before, after));
  command('sprites.moveFrames', (_context, { sheetId, frameIds, dx, dy, animationId }) => moveFrames(services(), sheetId, frameIds, dx, dy, animationId));
  command('sprites.sliceGrid', (_context, { sheetId, options, replace }) => sliceSheetIntoFrames(services(), sheetId, options, replace));

  command('sprites.insertStripFrame', (_context, { sheetId, animationId, runIndex, k }) => insertStripFrame(services(), sheetId, animationId, runIndex, k));
  command('sprites.splitStrip', (_context, { sheetId, animationId, index }) => splitStrip(services(), sheetId, animationId, index));
  command('sprites.resizeStripSegment', (_context, { sheetId, animationId, runIndex, side, count }) => resizeStripSegment(services(), sheetId, animationId, runIndex, side, count));
  command('sprites.removeStripMember', (_context, { sheetId, animationId, frameId }) => removeStripMember(services(), sheetId, animationId, frameId));
  command('sprites.mergeStripSegments', (_context, { sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy }) =>
    mergeStripSegments(services(), sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy));
  command('sprites.newStripFromFrame', (_context, { sheetId, frameId, side, count }) => newStripFromFrame(services(), sheetId, frameId, side, count));

  command('sprites.setFrameField', (_context, { sheetId, frameId, key, value }) => setFrameField(services(), sheetId, frameId, key, value));
  command('sprites.moveStripTo', (_context, { sheetId, animationId, x, y }) => moveStripTo(services(), sheetId, animationId, x, y));
  command('sprites.setStripFrameSize', (_context, { sheetId, animationId, key, value }) => setStripFrameSize(services(), sheetId, animationId, key, value));
  command('sprites.setStripPivot', (_context, { sheetId, animationId, key, value }) => setStripPivot(services(), sheetId, animationId, key, value));

  command('sprites.breakApartStrip', (_context, { sheetId, animationId }) => breakApartStrip(services(), sheetId, animationId));
  command('sprites.acceptAnimation', (_context, { sheetId, animationId }) => acceptAnimation(services(), sheetId, animationId));
}

export function registerSpriteContributions(api) {
  registerSpriteCommands(api);

  api.previews.register({ id: 'sprites.preview', order: 10, when: keys => keys.modeId === 'sprites', render: renderSpritePreview });
  api.tools.register({
    id: 'sprites.frame-tools', label: 'Sprite frame tools', order: 10,
    createController({ canvasView }) {
      registerFrameTool();
      bindFrameTool(canvasView);
      return {
        decorateOverlay() {
          const prior = canvasView.onOverlay;
          canvasView.onOverlay = ctx => { prior(ctx); drawStripChrome(ctx, canvasView); };
        },
      };
    },
  });

  const whenSprites = keys => keys.modeId === 'sprites';
  api.panels.register({ id: 'sprites.frames', title: 'Frames', region: 'right', order: 10, mountPoint: 'panel-context', persistent: true, when: whenSprites, create: mountFramesPanel });
  api.panels.register({ id: 'sprites.animations', title: 'Animations', region: 'right', order: 20, mountPoint: 'panel-animation', persistent: true, when: whenSprites, create: mountAnimationsPanel });
  api.panels.register({ id: 'sprites.timeline', title: 'Timeline', region: 'bottom', order: 10, mountPoint: 'timeline-dock', useMountPointDirect: true, persistent: true, when: whenSprites, create: mountTimeline });

  api.views.register({ id: 'sprites.sheet', order: 10, create: (_host, { canvasView }) => ({ view: canvasView }) });
  api.views.register({ id: 'sprites.frame', order: 20, create: (_host, { canvasHost }) => mountFrameEditor(canvasHost) });
}
```

- [ ] **Step 2: Rewrite `js/features/animations/commands.js` as a dispatch-by-id façade**

`js/ui/timeline.js:19` (`commitBreakApartStrip(anim)` at line 470) and `js/ui/tools.js:25` (`commitAcceptAnimation(sheet, anim)` at line 429) are the two remaining importers, and both files are out of scope for this sub-phase. Keeping their import path stable while routing through the registry means shared UI never imports `application/commands/**` — the Phase 1 lesson — without touching either file. Sub-phase 2b/2c deletes this façade once `timeline.js`/`animpanel.js` dispatch directly.

Replace the whole file with:

```js
// js/features/animations/commands.js
// Legacy façade: js/ui/timeline.js and js/ui/tools.js still call these two by
// import. The handlers themselves now live in js/modes/sprites/application/
// commands/animation-commands.js and are registered as host Commands by
// js/modes/sprites/contributions.js, so this file only dispatches by id —
// shared UI must never import a mode's command handlers directly. Delete this
// file once both callers dispatch for themselves (sub-phase 2b/2c).
import { activeSheet } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';

// Context is pinned to 'sprites' rather than the live state.mode: both of
// these are inherently sprite-sheet operations (the caller already resolved a
// sprite sheet), and the registered commands' `when` predicate requires it.
function dispatch(id, args) {
  return getEditorHost()?.registries.commands.execute(id, { modeId: 'sprites' }, args);
}

export function commitBreakApartStrip(animation) {
  const sheet = activeSheet();
  if (!sheet || !animation) return;
  dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: animation.id });
}

export function commitAcceptAnimation(sheet, animation) {
  if (!sheet || !animation) return;
  dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: animation.id });
}
```

- [ ] **Step 3: Update the two existing `tests/architecture.test.mjs` path references**

Both tests `readFile` the now-deleted `sprite-sheet-controller.js` and would throw `ENOENT`. Repoint them at the new Presenter (same intent, new home) — and widen the second regex so it also catches the renamed `frames-panel`.

Replace:

```js
    join(root, 'js/modes/sprites/sprite-sheet-controller.js'),
```

with:

```js
    join(root, 'js/modes/sprites/presentation/frame-tool-presenter.js'),
```

and replace:

```js
  const spriteController = await readFile(join(root, 'js/modes/sprites/sprite-sheet-controller.js'), 'utf8');
  assert.doesNotMatch(spriteController, /frame-panel/);
```

with:

```js
  const spriteController = await readFile(join(root, 'js/modes/sprites/presentation/frame-tool-presenter.js'), 'utf8');
  assert.doesNotMatch(spriteController, /frames?-panel/);
```

- [ ] **Step 4: Delete the old files**

```bash
git rm js/modes/sprites/sprite-sheet-controller.js js/modes/sprites/frame-panel.js js/features/animations/frame-metadata.js
```

- [ ] **Step 5: Confirm nothing still references the deleted modules**

Run (PowerShell):

```powershell
Select-String -Path js\**\*.js,tests\*.mjs -Pattern 'sprite-sheet-controller|frame-panel|frame-metadata' -SimpleMatch
```

Expected: no matches. If any appear, fix the referencing file (it should only ever be one of the files this task already rewrites).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: All tests pass, including `tests/builtinmodes.test.mjs`'s exact-id/exact-order assertions, `tests/contributions.test.mjs`, and `tests/architecture.test.mjs`.

- [ ] **Step 7: Commit**

```bash
git add js/modes/sprites/contributions.js js/features/animations/commands.js tests/architecture.test.mjs
git commit -m "feat(sprites): wire contributions to the new application/presentation split, remove the old controller/panel"
```

---

### Task 14: Architecture enforcement + final verification

**Files:**
- Modify: `tests/architecture.test.mjs`

**Interfaces:**
- Consumes: the existing `jsFiles`/`root` helpers already defined in that file.

The three generic tests (`application-layer code ... never touches DOM or Canvas rendering`, `presentation-layer mode code dispatches commands by id only`, `modes never import sibling modes`) already scope to `js/modes/*/application/**` and `js/modes/*/presentation/**` — creating those folders in Tasks 1-12 brought sprites under all of them with zero edits. Add exactly **one** sprites-specific test, mirroring the existing tiles-specific and maps-specific ones, so the four new command modules get a clearer failure message than the generic scan gives.

- [ ] **Step 1: Add the test**

Insert immediately after the existing `'map command modules do not access browser UI globals'` test:

```js
test('sprite command modules do not access browser UI globals', async () => {
  for (const file of [
    join(root, 'js/modes/sprites/application/commands/frame-commands.js'),
    join(root, 'js/modes/sprites/application/commands/strip-commands.js'),
    join(root, 'js/modes/sprites/application/commands/frame-metadata-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-commands.js'),
  ]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:document|window|prompt|alert|confirm)\b/, file);
  }
});
```

- [ ] **Step 2: Run the architecture suite**

Run: `node --test tests/architecture.test.mjs`
Expected: PASS. If the generic `application-layer code... never touches DOM` test fails against `js/modes/sprites/application/**`, a Canvas/DOM call leaked into Tasks 1-8 — fix the offending file rather than weakening the test. If `presentation-layer mode code dispatches commands by id only` fails, some file under `js/modes/sprites/presentation/**` is importing `application/commands/**`; replace that import with a `getEditorHost().registries.commands.execute(id, context, args)` dispatch.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 100% pass, with no reduction in test count versus the pre-Phase-2a baseline — plus this plan's additions (9 + 8 + 4 + 9 + 10 + 6 + 3 = **49** new tests across 7 new test files, and 1 new architecture test).

- [ ] **Step 4: Commit**

```bash
git add tests/architecture.test.mjs
git commit -m "test(architecture): enforce sprites application layer stays free of browser globals"
```

- [ ] **Step 5: Manual verification checklist (report to user, do not attempt to automate)**

Per project convention, pointer-drag interactions are not simulated in Playwright for this app. After all tasks land, ask the user to manually verify in a running instance (`./serve.ps1`, then load with `?autotest` if dialogs get in the way):

**Frame basics**
- Sprites mode, frame tool: drag on empty sheet to create a frame; click a frame to select it; drag it to move; drag a corner handle to resize; press Delete to remove it.
- Toggle the Snap checkbox and change the Grid size, then repeat create/move/resize — positions should quantize to the grid.
- Double-click a frame: the frame editor opens and the timeline points at that frame's animation.
- Click empty space: selection clears (Frames panel shows the "No frame selected" hint).

**Strips**
- Select a standalone frame, drag its left/right edge grip outward: it becomes a new strip named `strip_N` with the extra blank frames, and the frame is renamed `strip_N_0`.
- On an intact strip: click a "+" call-out to insert a frame (tail shifts right); click a "✂" call-out to split (dashed orange separator appears); drag an end grip to grow/shrink; drag one sub-strip so its edge meets another sub-strip's edge — the green snap line appears and releasing merges them.
- Verify the "+" call-outs disappear entirely when the strip is one frame width away from the sheet's right edge.
- Press Delete on a strip member: the frame goes and the rest of its segment closes the gap.
- Press Enter with a floating animation selected: it gets accepted (a layer group appears in the layers panel); pressing Enter again does nothing.
- Accept a strip, then drag it: its pixels move with it (they don't stay behind). Undo restores both pixels and positions.

**Panel + dialog**
- Frames panel: edit name/X/Y/W/H/Pivot on a plain frame; edit X/Y/W/H/Pivot on a strip; use the ✂ break-apart button; use the ✎ edit and 🗑 delete buttons.
- Re-entering the same value in a numeric field must **not** add an undo step.
- Tool options ▦ button opens the Slice-grid dialog: typing in the size/margin/spacing fields updates the live dashed preview on the canvas; Create adds the frames (one undo step); Cancel/Escape clears the preview.
- Slice with "Replace existing frames" checked, then undo — the original frames **and** every animation's frame list come back.

**Cross-cutting**
- Undo/redo repeatedly across a mix of all of the above; the title bar's unsaved-changes indicator reacts to every edit.
- Timeline dock and Animations panel still work (they were not touched by this sub-phase) — in particular timeline's break-apart button and auto-accept-on-first-paint-stroke, which now route through the new façade.
- Save and reload a project containing strips, sub-strips and accepted animations; confirm nothing is lost and no `__`-prefixed fields appear in the saved JSON.

---

## Self-Review

**Spec coverage.** Every file named in this sub-phase's scope is accounted for:

| In-scope source | Disposition |
|---|---|
| `js/modes/sprites/sprite-sheet-controller.js` (1335 lines) | Split across Tasks 1-3 (geometry), 4 (pixel motion), 5-6 (commands), 9 (renderer), 10 (slice dialog), 11 (Presenter); deleted in Task 13 |
| `js/modes/sprites/frame-panel.js` | Replaced by Task 12's `presentation/frames-panel.js`; deleted in Task 13 |
| `js/features/animations/frame-metadata.js` | Ported to Task 7; deleted in Task 13 (sole importer was `frame-panel.js`) |
| `js/features/animations/commands.js` | Ported to Task 8; rewritten as a dispatch-by-id façade in Task 13 (kept, because out-of-scope `js/ui/timeline.js` + `js/ui/tools.js` still import it) |
| `js/modes/sprites/contributions.js` | Rewritten in Task 13 — 17 command registrations added, all pre-existing panel/tool/view/preview ids, orders and titles preserved byte-for-byte, `timeline`/`animations`/`sprites.frame` still pointing at `js/ui/*` |
| New tests | Tasks 2-8 add 7 files / 49 tests; Task 14 adds 1 architecture test |

Out-of-scope files confirmed untouched by every task above: `js/ui/timeline.js`, `js/ui/animpanel.js`, `js/ui/frameeditor.js`, `js/ui/tools.js`, `js/ui/panels.js`, `js/ui/previewpanel.js`, `js/features/project/*`, `js/app/state.js`, `js/modes/sprites/documents.js`, `js/modes/sprites/preview.js`, `js/modes/sprites/index.js`. The only shared-file edits are the two path references in `tests/architecture.test.mjs` (Task 13 Step 3), which are forced by deleting the file they point at.

**Phase-1 lessons applied.** (1) Every non-obvious semantic is quoted from the real current source with a line number and pinned by a named test — the eight silent no-op/refusal guards (`commitFrameField` unchanged-value, `commitSplitStrip` duplicate-break, `commitInsertFrame` empty-segment and sheet-overflow, `commitResizeSegment` unchanged-count, `commitNewStripFromFrame` `extra <= 0`, `commitAcceptAnimation` already-accepted, `moveStripTo`/`setStripFrameSize`/`setStripPivot` no-change) each have a `canUndo() === false` assertion, because those are exactly the class of behavior Phase 1 lost. (2) All 17 commands are registered in `contributions.js` from the start, including the two that only shared UI reaches (`sprites.breakApartStrip`, `sprites.acceptAnimation`), and the shared caller goes through a dispatch façade rather than a direct import. (3) This plan adds **zero** `selections.get(` call sites, so the `?? {}` trap cannot bite; noted explicitly in Global Constraints for any implementer who adds one. (4) No `__`-prefixed stashing anywhere — every erase/delete/replace closes over a value looked up via `services.projects.project` before the command is built. (5) Every handler dual-writes through `runSheetCommand` (`projects.mutate()` + `markDirty()`). (6) Task order keeps `npm test` green: pure application (1-4) → commands (5-8) → presentation (9-12) → wiring/deletion (13) → enforcement (14).

**Placeholder scan.** No `TBD`, `TODO`, `...`, or "same as Task N" references. Every task carries complete, final source — including the ~200-line renderer and ~330-line Presenter, quoted in full rather than diffed. The one place a task references another's code is by **imported symbol name**, never "copy the code from above".

**Type/signature consistency** (checked pairwise across tasks):
- `services` is `{ projects, history }` everywhere it appears (Tasks 5, 6, 7, 8 consume it; Task 13's `services()` constructs it; Tasks 5-8's tests construct the same shape).
- `runSheetCommand(services, sheetId, label, apply, revert)` with `apply`/`revert` receiving `(sheet, project)` — defined once in Task 5, used identically in Tasks 6, 7 (via `commitStripEdit`), and 8.
- `findSpriteSheet(project, sheetId)` — defined once in Task 5, imported by Tasks 6, 7, 8.
- `toScreen(x, y) -> {x, y}` — produced by Task 11's `projector(view)` and Task 9's inline `(x, y) => view.imageToScreen(x, y)`; consumed by every Task 3 function that needs screen space.
- `frameToolOptions` (`{ snap, gridSize }`) — Task 1 defines, Task 2's `snapValue`/`snapPoint`/`snapRect` take it as `options`, Task 11 passes it and its options row writes it.
- `drag` shape is identical between Task 11 (producer) and Task 9 (consumer) for all four kinds; `stripResizeCount`/`resizeGhostRect` (Task 2) read only `{ side, fw, bbox, count, count0 }`, and `findSnap` (Task 3) reads only `{ anim, run, members, bbox, delta }` — both subsets the Presenter always populates for the relevant kind.
- Command args: the 17 `{ ... }` shapes in Task 13's registrations were checked one-by-one against Task 11's contract list, Task 10's `sprites.sliceGrid` dispatch, and Task 12's seven panel dispatches; the destructured field names and their order into each positional handler call match Tasks 5-8's exported signatures exactly.
- Two intentional signature corrections were applied consistently rather than left inconsistent: `buildMovePatches` lost its unused `sheet` parameter and its `currentContextLayers()` default (documented in Behavior-preservation notes, applied in Task 4 and honoured at both call sites in Task 6); Task 6's Interfaces block was corrected to drop `markDirty` from its consumed list, since `runSheetCommand` — not `strip-commands.js` — is what calls it.

**Known judgement calls flagged for the reader.** (a) Keeping `js/features/animations/commands.js` as a façade rather than deleting it is the one place this plan deviates from "delete the old file", and it is driven purely by the 2b/2c scope boundary. (b) The façade pins its dispatch context to `{ modeId: 'sprites' }` rather than `state.mode`, so `js/ui/tools.js`'s auto-accept-on-first-paint-stroke cannot be silently swallowed by the `when` predicate if it ever fires while another mode is nominally active — behavior-preserving relative to today's direct call. (c) `moveFrames` absorbs the Presenter's old `if (dx !== 0 || dy !== 0)` guard so every caller inherits it.





