# Dimension Indicators + Marquee Resize Handles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CAD-style dimension/origin indicators for marquee selections, frames, and floats (size, Δ during resize/move, angle during rotate), plus 8 resize handles on the select tool's marquee.

**Architecture:** New pure geometry helper `js/core/resizerect.js` (node-tested) and shared screen-space label renderer `js/ui/dimlabels.js`. The three existing overlays (marquee in tools.js, frame ghost in frames.js, float in tools.js) call the renderer; the select tool gains a `resize` stroke mode.

**Tech Stack:** Vanilla ES modules, no deps. Tests: `node --test` (`npm test`, currently 78/78). Browser checks: Playwright vs `http://localhost:8080/?autotest`.

**Spec:** `docs/superpowers/specs/2026-07-16-dimension-indicators-design.md`

## Global Constraints

- No new dependencies, no build step.
- Labels: 11px monospace, white fill + black 3px outline, fixed screen size; width centered below the bottom edge, height right of the right edge, origin `(x, y)` above the top-left corner; Δ inline (`32 (+8)`); `quiet` variant = same labels, no Δ, 70% alpha; labels clamped into the canvas viewport.
- Marquee resize/move stay un-undoable; min rect 1×1; clamped to the target rect.
- Float indicators display the SCALED CONTENT size (`round(srcRect.w·|sx|)`), not the rotated bbox size; placement uses `floatBounds`.
- Browser verification per task covers ONLY that task's flows (user rule: no redundant smoke re-runs). No consolidated verification task — the whole-branch review is the single final gate.
- Windows/PowerShell environment.

---

### Task 1: Geometry + label helpers

**Files:**
- Create: `js/core/resizerect.js`
- Create: `js/ui/dimlabels.js`
- Test: `tests/resizerect.test.mjs`

**Interfaces:**
- Produces:
  - `resizeRect(orig, handle, px, py, target)` (core/resizerect.js) — `orig` = `{x,y,w,h}`; `handle` ∈ `'nw','n','ne','e','se','s','sw','w'`; `px,py` = pointer PIXEL coords (image space, inclusive semantics: dragging the east edge onto pixel column `px` puts the edge at `px+1`); `target` = clamp rect. Returns a new `{x,y,w,h}`, normalized on flip-through, min 1×1, inside target.
  - `drawRectDims(ctx, view, rect, opts = {})` (ui/dimlabels.js) — `rect` image-space; `opts`: `{dw, dh, dx, dy, quiet, wOverride, hOverride}`. Draws width/height/origin labels as per Global Constraints. Pure drawing, no app-state imports.
  - `drawAngleLabel(ctx, x, y, radians)` — screen position; renders degrees with one decimal, normalized to (−180, 180], e.g. `"45.0°"`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/resizerect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resizeRect } from '../js/core/resizerect.js';

const TARGET = { x: 0, y: 0, w: 32, h: 32 };
const ORIG = { x: 8, y: 8, w: 8, h: 8 }; // edges at 8..16

test('corner se: both axes follow the pointer (inclusive pixel)', () => {
  // pointer on pixel (19, 21) → east edge 20, south edge 22
  assert.deepEqual(resizeRect(ORIG, 'se', 19, 21, TARGET), { x: 8, y: 8, w: 12, h: 14 });
});

test('corner nw: opposite corner anchored', () => {
  // pointer on pixel (4, 6) → west edge 4, north edge 6, east/south stay 16
  assert.deepEqual(resizeRect(ORIG, 'nw', 4, 6, TARGET), { x: 4, y: 6, w: 12, h: 10 });
});

test('edge handles move one axis only', () => {
  assert.deepEqual(resizeRect(ORIG, 'e', 25, 0, TARGET), { x: 8, y: 8, w: 18, h: 8 });
  assert.deepEqual(resizeRect(ORIG, 'n', 0, 2, TARGET), { x: 8, y: 2, w: 8, h: 14 });
  assert.deepEqual(resizeRect(ORIG, 's', 31, 11, TARGET), { x: 8, y: 8, w: 8, h: 4 });
  assert.deepEqual(resizeRect(ORIG, 'w', 10, 31, TARGET), { x: 10, y: 8, w: 6, h: 8 });
});

test('drag through the anchor flips and normalizes', () => {
  // 'e' dragged left past the west edge (8): pointer pixel 3 → edge 4;
  // normalized rect spans 4..8
  assert.deepEqual(resizeRect(ORIG, 'e', 3, 8, TARGET), { x: 4, y: 8, w: 4, h: 8 });
  // 'nw' dragged past the se corner: west/north candidates land AT pixel 20,
  // fixed edges stay 16 → normalized 16..20
  assert.deepEqual(resizeRect(ORIG, 'nw', 20, 20, TARGET), { x: 16, y: 16, w: 4, h: 4 });
});

test('pointer clamped to target; result stays inside', () => {
  const r = resizeRect(ORIG, 'se', 99, 99, TARGET);
  assert.deepEqual(r, { x: 8, y: 8, w: 24, h: 24 }); // east/south edge at 32
  const r2 = resizeRect(ORIG, 'nw', -5, -5, TARGET);
  assert.deepEqual(r2, { x: 0, y: 0, w: 16, h: 16 });
});

test('min 1x1 when collapsed onto the anchor', () => {
  // 'w' dragged onto the east edge pixel (15 → edge 15, east edge 16)
  const r = resizeRect(ORIG, 'w', 15, 8, TARGET);
  assert.equal(r.w, 1);
  // 'e' dragged onto the west edge: pointer 8 → edge 9 → width 1
  assert.deepEqual(resizeRect(ORIG, 'e', 8, 8, TARGET).w, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — module `js/core/resizerect.js` not found.

- [ ] **Step 3: Implement `js/core/resizerect.js`**

```js
// Resize a rect by dragging one of 8 handles ('nw','n','ne','e','se','s',
// 'sw','w'), pointer given as PIXEL coords (inclusive: dragging the east
// edge onto pixel column px puts the edge at px+1, matching the marquee
// creation convention w = |dx|+1). Flip-through normalizes (the formerly
// fixed edge becomes a boundary), result is min 1x1 and inside `target`.
export function resizeRect(orig, handle, px, py, target) {
  px = Math.max(target.x, Math.min(target.x + target.w - 1, px));
  py = Math.max(target.y, Math.min(target.y + target.h - 1, py));
  let x0 = orig.x, x1 = orig.x + orig.w;
  let y0 = orig.y, y1 = orig.y + orig.h;
  if (handle.includes('w')) x0 = px;
  if (handle.includes('e')) x1 = px + 1;
  if (handle.includes('n')) y0 = py;
  if (handle.includes('s')) y1 = py + 1;
  const nx0 = Math.min(x0, x1), ny0 = Math.min(y0, y1);
  const nx1 = Math.max(x0, x1), ny1 = Math.max(y0, y1);
  return { x: nx0, y: ny0, w: Math.max(1, nx1 - nx0), h: Math.max(1, ny1 - ny0) };
}
```

- [ ] **Step 4: Implement `js/ui/dimlabels.js`**

```js
// CAD-style dimension labels for rectangular overlays: width centered below
// the bottom edge, height right of the right edge, origin "(x, y)" above the
// top-left corner. Fixed screen-size text, white with a black outline so it
// reads over any pixel content; positions clamped into the canvas viewport
// so labels stay visible when the rect edge is off-screen. Pure drawing —
// all inputs via arguments, no app-state imports.

const FONT = '11px monospace';
const PAD = 4;      // gap between rect edge and label, screen px
const MARGIN = 2;   // viewport clamp margin

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function delta(d) { return d ? ` (${signed(d)})` : ''; }

function drawLabel(ctx, text, x, y, { align = 'center', baseline = 'top', alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function clampX(ctx, x) { return Math.max(MARGIN, Math.min(ctx.canvas.width - MARGIN, x)); }
function clampY(ctx, y) { return Math.max(12, Math.min(ctx.canvas.height - MARGIN, y)); }

// rect: image-space {x,y,w,h}. opts: {dw, dh, dx, dy, quiet, wOverride, hOverride}.
// quiet renders at 70% alpha; callers simply omit deltas when idle.
export function drawRectDims(ctx, view, rect, opts = {}) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  const alpha = opts.quiet ? 0.7 : 1;
  const w = opts.wOverride ?? rect.w;
  const h = opts.hOverride ?? rect.h;
  const originText = `(${rect.x}, ${rect.y})`
    + ((opts.dx || opts.dy) ? ` (${signed(opts.dx || 0)}, ${signed(opts.dy || 0)})` : '');
  drawLabel(ctx, originText, clampX(ctx, p0.x), clampY(ctx, p0.y - PAD),
    { align: 'left', baseline: 'bottom', alpha });
  drawLabel(ctx, `${w}${delta(opts.dw)}`, clampX(ctx, (p0.x + p1.x) / 2), clampY(ctx, p1.y + PAD),
    { align: 'center', baseline: 'top', alpha });
  drawLabel(ctx, `${h}${delta(opts.dh)}`, clampX(ctx, p1.x + PAD), clampY(ctx, (p0.y + p1.y) / 2),
    { align: 'left', baseline: 'middle', alpha });
}

// Angle readout for rotation gestures, at a screen position (near the knob).
export function drawAngleLabel(ctx, x, y, radians) {
  let deg = (radians * 180 / Math.PI) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  drawLabel(ctx, `${deg.toFixed(1)}°`, clampX(ctx, x), clampY(ctx, y),
    { align: 'left', baseline: 'middle' });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all pass (78 existing + 6 new). No browser check needed here — nothing calls the drawing helper yet.

- [ ] **Step 6: Commit**

```
git add js/core/resizerect.js js/ui/dimlabels.js tests/resizerect.test.mjs
git commit -m "feat: resizeRect geometry helper and CAD dimension-label renderer"
```

---

### Task 2: Select tool — resize handles + indicators

**Files:**
- Modify: `js/ui/tools.js` (imports; `handleSelectDown/Move`; overlay marquee branch)

**Interfaces:**
- Consumes: `resizeRect` (core/resizerect.js), `drawRectDims` (ui/dimlabels.js), existing `HANDLE_PX`, `toScreen`, `clampRectToTarget`, per-view `selection`/`selStroke`.
- Produces: select-tool marquee with 8 resize handles; `selStroke` gains `mode: 'resize'` (`{mode:'resize', target, handle, orig}`); overlay draws handles + dimension labels.

- [ ] **Step 1: Add imports to tools.js**

```js
import { resizeRect } from '../core/resizerect.js';
import { drawRectDims, drawAngleLabel } from './dimlabels.js';
```

(`drawAngleLabel` is used by Task 4; importing it now is fine, or defer to Task 4 — implementer's choice, but no unused-import lint exists either way. Prefer importing only `drawRectDims` now.)

- [ ] **Step 2: Marquee handle helpers** (inside `bindDrawing`, next to the select handlers)

```js
  // 8 handle anchor points on the marquee, image-space EDGE coords
  const SEL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  function selHandlePoint(sel, h) {
    const x = h.includes('w') ? sel.x : h.includes('e') ? sel.x + sel.w : sel.x + sel.w / 2;
    const y = h.includes('n') ? sel.y : h.includes('s') ? sel.y + sel.h : sel.y + sel.h / 2;
    return { x, y };
  }
  function hitSelHandle(ev) {
    if (!selection) return null;
    for (const h of SEL_HANDLES) {
      const p = toScreen(selHandlePoint(selection, h));
      if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) return h;
    }
    return null;
  }
```

- [ ] **Step 3: Wire resize mode into the select handlers**

In `handleSelectDown`, before the `insideRect` check:

```js
    const handle = hitSelHandle(ev);
    if (handle) {
      selStroke = { mode: 'resize', target, handle, orig: { ...selection } };
      view.requestRender();
      return;
    }
```

In `handleSelectMove`, add a branch between `'new'` and the `else` (make the moverect branch `else if (selStroke.mode === 'moverect')` and add):

```js
    } else if (selStroke.mode === 'resize') {
      selection = resizeRect(selStroke.orig, selStroke.handle, ev.x, ev.y, target);
```

`handleSelectUp` needs no change (non-`'new'` modes already just clear the stroke).

- [ ] **Step 4: Overlay — handles + labels in the marquee branch**

Extract the handle-square drawing used by the float branch into a shared local (inside `bindDrawing`):

```js
  function drawHandleSquare(ctx, p) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.fillRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
    ctx.strokeRect(p.x - HANDLE_PX + 0.5, p.y - HANDLE_PX + 0.5, HANDLE_PX * 2 - 1, HANDLE_PX * 2 - 1);
  }
```

(replace the float branch's inline fillRect/strokeRect pair with a call to it). Then extend the marquee branch (after the existing ants `strokeRect` calls, before `ctx.restore()` or after it — keep `ctx.save()`/`restore()` hygiene):

```js
    if (state.tool === 'select') {
      for (const h of SEL_HANDLES) drawHandleSquare(ctx, toScreen(selHandlePoint(selection, h)));
      if (selStroke?.mode === 'resize') {
        drawRectDims(ctx, view, selection, {
          dw: selection.w - selStroke.orig.w, dh: selection.h - selStroke.orig.h,
        });
      } else if (selStroke?.mode === 'moverect') {
        drawRectDims(ctx, view, selection, {
          dx: selection.x - selStroke.orig.x, dy: selection.y - selStroke.orig.y,
        });
      } else if (selStroke?.mode === 'new') {
        drawRectDims(ctx, view, selection);
      } else {
        drawRectDims(ctx, view, selection, { quiet: true });
      }
    }
```

Note: the marquee overlay branch runs for ANY tool when a selection exists (ants stay visible); handles and labels are gated on `state.tool === 'select'` per the spec.

- [ ] **Step 5: Verify**

`npm test` → 84/84 (78 + 6 from Task 1).
Browser (THIS task's flows only): `?autotest`, select tool; drag a new marquee → labels show origin/W/H matching `state`-read rect; grab the `se` handle, drag → rect resizes (assert selection rect via a moverect-independent read: re-drag or expose via pixel checks — simplest is asserting the resize visually via screenshot plus asserting the rect indirectly: after resizing, switch to move tool, float, and check `state.floating.srcRect` matches the resized rect); drag inside → moverect still works; labels during each mode (screenshot). Escape mid-resize must not crash (orig snapshot pattern). Zero console errors.

- [ ] **Step 6: Commit**

```
git add js/ui/tools.js
git commit -m "feat: marquee resize handles and CAD dimension labels for the select tool"
```

---

### Task 3: Frame tool indicators

**Files:**
- Modify: `js/ui/frames.js` (import; `drawFrameToolGhost`)

**Interfaces:**
- Consumes: `drawRectDims` from `js/ui/dimlabels.js`; existing `drag` module state (`kind: 'create'|'move'|'resize'`, `drag.rect`, `drag.before`, `drag.bbox`, `drag.delta`), `stripOf`, selected frame.
- Produces: dimension labels on frame create/resize/move ghosts and a quiet label on the selected frame (frame tool active, idle).

- [ ] **Step 1: Add import**

```js
import { drawRectDims } from './dimlabels.js';
```

- [ ] **Step 2: Extend `drawFrameToolGhost`**

Inside the `if (drag)` block, after the existing ghost strokes (still inside `ctx.save()`/`restore()` is fine — dimlabels does its own save/restore):

```js
    if (drag.kind === 'create' && drag.rect) {
      drawRectDims(ctx, view, drag.rect);
    } else if (drag.kind === 'move' && drag.bbox) {
      const r = { x: drag.bbox.x + drag.delta.dx, y: drag.bbox.y + drag.delta.dy, w: drag.bbox.w, h: drag.bbox.h };
      drawRectDims(ctx, view, r, { dx: drag.delta.dx, dy: drag.delta.dy });
    } else if (drag.kind === 'resize' && drag.rect) {
      drawRectDims(ctx, view, drag.rect, {
        dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h,
      });
    }
```

In the idle branch (`if (state.tool === 'frametool')`, where handles are drawn), add a quiet label for the selected frame — shown for strip members too (labels are informational; only HANDLES are strip-gated):

```js
    const selected = sheet.frames.find(f => f.id === state.selectedFrameId);
    if (selected && !drag) drawRectDims(ctx, view, selected, { quiet: true });
    // No resize handles on intact-strip members.
    if (selected && !stripOf(sheet, selected.id)) drawHandles(ctx, view, selected);
```

(adjust the existing lines rather than duplicating the `selected` lookup).

- [ ] **Step 3: Verify**

`npm test` → 84/84.
Browser (frame flows only): sprite mode, frame tool `F`; create-drag a frame → labels live during drag; select it → quiet label; corner-resize → `W (+n)` style deltas; drag-move → origin `(x, y) (+dx, +dy)`. Zero console errors.

- [ ] **Step 4: Commit**

```
git add js/ui/frames.js
git commit -m "feat: CAD dimension labels for frame create/resize/move"
```

---

### Task 4: Float overlay indicators + docs

**Files:**
- Modify: `js/ui/tools.js` (float overlay branch; imports)
- Modify: `README.md`, `tests/smoke.md`

**Interfaces:**
- Consumes: `drawRectDims`/`drawAngleLabel` (dimlabels.js), `floatBounds` (core/floating.js — ADD to the existing floating.js import in tools.js), `moveStroke` (same closure), `knobScreenPos`.
- Produces: float overlay shows origin + scaled content size (via `wOverride`/`hOverride`), Δ during scale, `(+dx, +dy)` during translate, angle label near the knob during rotate (and when idle with `rot ≠ 0`).

- [ ] **Step 1: Extend the float overlay branch** (in `view.onOverlay`, after the knob drawing, before `ctx.restore()`; dimlabels manages its own ctx state):

```js
      const t = float.transform;
      const bounds = floatBounds(float);
      const scaledW = Math.round(float.srcRect.w * Math.abs(t.sx));
      const scaledH = Math.round(float.srcRect.h * Math.abs(t.sy));
      const opts = { wOverride: scaledW, hOverride: scaledH };
      if (moveStroke?.kind === 'translate') {
        opts.dx = t.tx - moveStroke.t0.tx;
        opts.dy = t.ty - moveStroke.t0.ty;
      } else if (moveStroke?.kind === 'scale') {
        opts.dw = scaledW - Math.round(float.srcRect.w * Math.abs(moveStroke.t0.sx));
        opts.dh = scaledH - Math.round(float.srcRect.h * Math.abs(moveStroke.t0.sy));
      } else if (!moveStroke) {
        opts.quiet = true;
      }
      drawRectDims(ctx, view, bounds, opts);
      if (moveStroke?.kind === 'rotate' || (!moveStroke && t.rot !== 0)) {
        drawAngleLabel(ctx, knob.x + KNOB_R + 4, knob.y, t.rot);
      }
```

(`knob` is already computed in this branch. During a rotate drag the rect labels render without deltas — `opts` has none — which is the intended quiet-ish treatment; alpha stays 1 during the drag, which is fine.)

Update the tools.js floating.js import to include `floatBounds`:

```js
import { forwardPoint, inversePoint, floatBounds } from '../core/floating.js';
```

And add `drawRectDims, drawAngleLabel` to the dimlabels import (from Task 2 there is already an import line — extend it).

- [ ] **Step 2: Docs**

README tools table, `M` row — replace with:

```markdown
| `M` | Select (marquee) — selection only: drag inside moves the rectangle, drag a corner/edge handle resizes it (8 handles); CAD-style size/origin labels show W×H, origin, and Δ while dragging |
```

README "Floating selections" section — append to the paragraph:

```markdown
While a float is pending, CAD-style labels show its origin and scaled size
(with Δ during a scale drag) and the rotation angle in degrees during a
rotate; the same labels appear on marquee drags and frame create/resize/move.
```

tests/smoke.md — minimal extensions (no renumbering):
- Item 10, append: `Corner/edge handles (8) resize the marquee; while dragging, CAD labels show origin, W×H, and Δ; idle selection shows a quiet origin+size label.`
- Item 21 (frame drag-move), append: `Move shows origin (+dx, +dy) labels; create/resize drags show W×H with Δ.`
- Item 66 (float transforms), append: `Scale shows W×H with Δ (scaled content size, not bbox); rotate shows a live angle readout near the knob.`

- [ ] **Step 3: Verify**

`npm test` → 84/84.
Browser (float label flows only): move tool, float a selection → quiet origin+size label; translate drag → `(+dx, +dy)`; scale drag via corner handle → `W (+n)`; rotate via knob → angle label tracks; commit → labels gone (marquee quiet label appears via select?? — no: after commit the tool is still move; no labels expected unless float exists — confirm no stray labels). Zero console errors.

- [ ] **Step 4: Commit**

```
git add -A
git commit -m "feat: float dimension/angle indicators; docs for dimension labels"
```
