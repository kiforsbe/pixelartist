# CAD Dimension Lines v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain-text dimension labels with true CAD-style dimension lines (extension lines, arrowed dimension line, value pill), add per-cell chains for strips and a live slice-grid preview.

**Architecture:** `js/ui/dimlabels.js` is rewritten around a pure, node-tested `layoutDimension()` geometry step plus canvas draw functions. `drawRectDims` keeps its signature so the marquee/frame/float call sites change visuals without code changes; frames.js gains a strip width-chain and a live ghost preview for the Slice grid dialog.

**Tech Stack:** Vanilla ES modules, no deps. Tests: `node --test` (`npm test`, currently 85/85). Browser checks: Playwright vs `http://localhost:8080/?autotest`.

**Spec:** `docs/superpowers/specs/2026-07-16-cad-dimension-lines-design.md`

## Global Constraints

- No new dependencies, no build step. `js/ui/dimlabels.js` stays free of app-state imports (node tests import it — no module-level DOM access).
- Theme: lines/arrows/extension lines/markers `#4f8cff`; pill text `#a9c7ff`; pill background `rgba(20,20,24,.85)` with 1px `#4f8cff` border; 11px monospace.
- Geometry constants (screen px): dimension line offset `14 + 20·level` from the shape edge; extension lines 2px gap from the edge, 4px overshoot past the dimension line; arrowheads 6px; pill padding 5×2.
- Too-small rule: pill fits iff `span ≥ pillW + 2·6 + 4`; otherwise arrows flip outside (pointing inward at the extension lines) and the pill sticks out past an end.
- Quiet variant = 70% alpha, no Δ (caller-controlled, as today). Δ stays inline in pill text (`44 (+16)`).
- Pills clamp fully visible into the CSS-px viewport (derive from `ctx.getTransform()` — the overlay ctx is dpr-scaled); lines may clip naturally.
- Browser verification per task covers ONLY that task's flows; no consolidated sweep — the whole-branch review is the single final gate.
- Windows/PowerShell environment.

---

### Task 1: Rewrite dimlabels.js as the dimension-line engine

**Files:**
- Rewrite: `js/ui/dimlabels.js` (full file replacement)
- Test: `tests/dimlayout.test.mjs` (create)

**Interfaces:**
- Consumes: nothing new; existing callers in `js/ui/tools.js` (marquee overlay, float overlay) and `js/ui/frames.js` (frame ghosts + idle label) keep their current calls.
- Produces (exports of `js/ui/dimlabels.js`):
  - `layoutDimension({ a, b, axis, side = 'end', level = 0, pillW = 0, stick = 'b' })` → `{ dim: [p, p], ext: [[p, p], [p, p]], arrowsOutside, pill: {x, y} }` — pure screen-space geometry (see code).
  - `drawDimension(ctx, view, a, b, { axis, side, level, text, alpha, stick })` — one dimension line with extension lines, arrows, pill.
  - `drawRectDims(ctx, view, rect, opts)` — SAME opts as before (`{dw, dh, dx, dy, quiet, wOverride, hOverride}`) plus new optional `wLevel`/`hLevel` (default `opts.level ?? 0`) so Task 2 can put width at level 1 and height at level 0.
  - `drawChainDims(ctx, view, { axis, side, edge, spans, level, alpha })` — `spans = [{from, to, text}]` in IMAGE coords; `edge` = the fixed image coordinate of the shape edge the chain hangs off.
  - `drawAngleLabel(ctx, x, y, radians)` — same signature, pill-styled.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dimlayout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutDimension } from '../js/ui/dimlabels.js';

const A = { x: 100, y: 200 }, B = { x: 180, y: 200 }; // 80px horizontal span

test('h/end level 0: line 14px below, ext gap 2 overshoot 4, pill centered', () => {
  const L = layoutDimension({ a: A, b: B, axis: 'h', pillW: 30 });
  assert.deepEqual(L.dim, [{ x: 100, y: 214 }, { x: 180, y: 214 }]);
  assert.deepEqual(L.ext[0], [{ x: 100, y: 202 }, { x: 100, y: 218 }]);
  assert.deepEqual(L.ext[1], [{ x: 180, y: 202 }, { x: 180, y: 218 }]);
  assert.equal(L.arrowsOutside, false);
  assert.deepEqual(L.pill, { x: 140, y: 214 });
});

test('level stacks 20px per row', () => {
  const L = layoutDimension({ a: A, b: B, axis: 'h', level: 1, pillW: 10 });
  assert.equal(L.dim[0].y, 234);
});

test("side 'start' flips above with mirrored gap/overshoot", () => {
  const L = layoutDimension({ a: { x: 100, y: 50 }, b: { x: 180, y: 50 }, axis: 'h', side: 'start', pillW: 10 });
  assert.deepEqual(L.dim[0], { x: 100, y: 36 });
  assert.deepEqual(L.ext[0], [{ x: 100, y: 48 }, { x: 100, y: 32 }]);
});

test('v/end: line 14px right of the edge, pill mid-span', () => {
  const L = layoutDimension({ a: { x: 300, y: 100 }, b: { x: 300, y: 160 }, axis: 'v', pillW: 20 });
  assert.deepEqual(L.dim, [{ x: 314, y: 100 }, { x: 314, y: 160 }]);
  assert.deepEqual(L.pill, { x: 314, y: 130 });
});

test('too-small span flips arrows outside and sticks the pill past an end', () => {
  const a = { x: 100, y: 200 }, b = { x: 110, y: 200 }; // 10px span
  const L = layoutDimension({ a, b, axis: 'h', pillW: 30 });
  assert.equal(L.arrowsOutside, true);
  assert.equal(L.pill.y, 214);
  assert.ok(L.pill.x > 110, `pill sticks out right (${L.pill.x})`);
  const L2 = layoutDimension({ a, b, axis: 'h', pillW: 30, stick: 'a' });
  assert.ok(L2.pill.x < 100, `stick 'a' places pill left (${L2.pill.x})`);
});

test('fits threshold is pillW + 2*arrow + 4 exactly', () => {
  // pillW 20 → threshold 36
  assert.equal(layoutDimension({ a: { x: 0, y: 0 }, b: { x: 36, y: 0 }, axis: 'h', pillW: 20 }).arrowsOutside, false);
  assert.equal(layoutDimension({ a: { x: 0, y: 0 }, b: { x: 35, y: 0 }, axis: 'h', pillW: 20 }).arrowsOutside, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `layoutDimension` is not exported.

- [ ] **Step 3: Rewrite `js/ui/dimlabels.js`** (full replacement)

```js
// CAD-style dimension lines for rectangular overlays: extension lines
// normal to the measured edge, an arrowed dimension line between them, and
// the value in a bordered pill centered ON the line. Dimension rows stack
// outward via `level` so sub-part chains (level 0) and overall dimensions
// (level 1) coexist. When a span is too small for its pill, the arrows flip
// outside and the pill sticks out past an end — classic CAD. Frame-overlay
// blue theme. Pure drawing/geometry — all inputs via arguments, no
// app-state imports (node tests import this file).

const DIM_STROKE = '#4f8cff';   // lines, arrows, extension lines, markers
const DIM_TEXT = '#a9c7ff';     // pill text
const PILL_BG = 'rgba(20,20,24,.85)';
const FONT = '11px monospace';
const TEXT_H = 11;
const BASE_OFFSET = 14;         // level-0 dimension-line distance from the shape
const LEVEL_STEP = 20;          // additional distance per level
const EXT_GAP = 2;              // extension-line gap from the shape edge
const EXT_OVER = 4;             // extension-line overshoot past the dimension line
const ARROW = 6;                // arrowhead length
const PILL_PAD_X = 5, PILL_PAD_Y = 2;
const PILL_H = TEXT_H + PILL_PAD_Y * 2;
const MARGIN = 2;               // viewport clamp margin

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function delta(d) { return d ? ` (${signed(d)})` : ''; }

// ---- pure layout (node-tested) ----
//
// a/b: screen-space span endpoints ON the shape edge (a before b along the
// measured axis). axis 'h' measures a horizontal span, 'v' a vertical one.
// side: which side of the shape the dimension line sits — 'end' (default) =
// below ('h') / right ('v'); 'start' = above / left. level stacks rows
// outward. pillW (full pill width) decides the too-small arrow flip; stick
// picks which end the pill sticks out past when it doesn't fit.
export function layoutDimension({ a, b, axis, side = 'end', level = 0, pillW = 0, stick = 'b' }) {
  const sign = side === 'start' ? -1 : 1;
  const off = (BASE_OFFSET + level * LEVEL_STEP) * sign;
  const gap = EXT_GAP * sign;
  const over = EXT_OVER * sign;
  const span = axis === 'h' ? b.x - a.x : b.y - a.y;
  const fits = span >= pillW + 2 * ARROW + 4;
  if (axis === 'h') {
    const lineY = a.y + off;
    return {
      dim: [{ x: a.x, y: lineY }, { x: b.x, y: lineY }],
      ext: [
        [{ x: a.x, y: a.y + gap }, { x: a.x, y: lineY + over }],
        [{ x: b.x, y: b.y + gap }, { x: b.x, y: lineY + over }],
      ],
      arrowsOutside: !fits,
      pill: fits
        ? { x: (a.x + b.x) / 2, y: lineY }
        : (stick === 'b'
          ? { x: b.x + ARROW + 4 + pillW / 2, y: lineY }
          : { x: a.x - ARROW - 4 - pillW / 2, y: lineY }),
    };
  }
  const lineX = a.x + off;
  return {
    dim: [{ x: lineX, y: a.y }, { x: lineX, y: b.y }],
    ext: [
      [{ x: a.x + gap, y: a.y }, { x: lineX + over, y: a.y }],
      [{ x: b.x + gap, y: b.y }, { x: lineX + over, y: b.y }],
    ],
    arrowsOutside: !fits,
    pill: fits
      ? { x: lineX, y: (a.y + b.y) / 2 }
      : (stick === 'b'
        ? { x: lineX, y: b.y + ARROW + 4 + PILL_H / 2 }
        : { x: lineX, y: a.y - ARROW - 4 - PILL_H / 2 }),
  };
}

// ---- draw helpers ----

// The overlay ctx is dpr-scaled (CSS px); canvas.width/height are DEVICE px
// — divide the transform's scale back out to get the CSS viewport.
function viewportCss(ctx) {
  const t = ctx.getTransform();
  return { w: ctx.canvas.width / (t.a || 1), h: ctx.canvas.height / (t.d || 1) };
}

function line(ctx, p, q) {
  ctx.beginPath();
  ctx.moveTo(p.x + 0.5, p.y + 0.5);
  ctx.lineTo(q.x + 0.5, q.y + 0.5);
  ctx.stroke();
}

// Filled triangular arrowhead: tip at `tip`, body extending along (ux, uy).
function arrow(ctx, tip, ux, uy) {
  const px = -uy, py = ux;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x + ux * ARROW + px * (ARROW / 3), tip.y + uy * ARROW + py * (ARROW / 3));
  ctx.lineTo(tip.x + ux * ARROW - px * (ARROW / 3), tip.y + uy * ARROW - py * (ARROW / 3));
  ctx.closePath();
  ctx.fill();
}

// Rounded pill with border + centered text at (cx, cy), clamped fully into
// the viewport. ctx.font must NOT be assumed — set here.
function drawPill(ctx, text, cx, cy, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  const w = Math.ceil(ctx.measureText(text).width) + PILL_PAD_X * 2;
  const v = viewportCss(ctx);
  const x = Math.max(MARGIN, Math.min(v.w - MARGIN - w, cx - w / 2));
  const y = Math.max(MARGIN, Math.min(v.h - MARGIN - PILL_H, cy - PILL_H / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, PILL_H, PILL_H / 2);
  ctx.fillStyle = PILL_BG;
  ctx.fill();
  ctx.strokeStyle = DIM_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = DIM_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + PILL_H / 2 + 0.5);
  ctx.restore();
}

export function drawDimension(ctx, view, a, b, { axis, side = 'end', level = 0, text = '', alpha = 1, stick = 'b' } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  const pillW = Math.ceil(ctx.measureText(text).width) + PILL_PAD_X * 2;
  const L = layoutDimension({ a, b, axis, side, level, pillW, stick });
  ctx.strokeStyle = DIM_STROKE;
  ctx.fillStyle = DIM_STROKE;
  ctx.lineWidth = 1;
  line(ctx, L.ext[0][0], L.ext[0][1]);
  line(ctx, L.ext[1][0], L.ext[1][1]);
  line(ctx, L.dim[0], L.dim[1]);
  // Arrow tips always touch the extension lines (the dim endpoints); bodies
  // point inward when the pill fits, outward when the arrows flipped.
  const ux = axis === 'h' ? 1 : 0, uy = axis === 'h' ? 0 : 1;
  const s = L.arrowsOutside ? -1 : 1;
  arrow(ctx, L.dim[0], ux * s, uy * s);
  arrow(ctx, L.dim[1], -ux * s, -uy * s);
  ctx.restore();
  drawPill(ctx, text, L.pill.x, L.pill.y, alpha);
}

// Small blue right-angle marker just outside the rect's top-left corner,
// with the origin pill to its right.
function drawOriginMarker(ctx, p, text, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = DIM_STROKE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p.x + 8, p.y - 3.5);
  ctx.lineTo(p.x - 3.5, p.y - 3.5);
  ctx.lineTo(p.x - 3.5, p.y + 8);
  ctx.stroke();
  ctx.restore();
  drawPill(ctx, text, p.x + 12, p.y - 3 - PILL_H / 2, alpha);
}

// rect: image-space {x,y,w,h}. opts: {dw, dh, dx, dy, quiet, wOverride,
// hOverride, level, wLevel, hLevel}. quiet renders at 70% alpha; callers
// simply omit deltas when idle. wLevel/hLevel let strip callers stack the
// width dimension outside a chain while the height stays at level 0.
export function drawRectDims(ctx, view, rect, opts = {}) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  const alpha = opts.quiet ? 0.7 : 1;
  const w = opts.wOverride ?? rect.w;
  const h = opts.hOverride ?? rect.h;
  drawDimension(ctx, view, { x: p0.x, y: p1.y }, { x: p1.x, y: p1.y }, {
    axis: 'h', level: opts.wLevel ?? opts.level ?? 0, text: `${w}${delta(opts.dw)}`, alpha,
  });
  drawDimension(ctx, view, { x: p1.x, y: p0.y }, { x: p1.x, y: p1.y }, {
    axis: 'v', level: opts.hLevel ?? opts.level ?? 0, text: `${h}${delta(opts.dh)}`, alpha,
  });
  const originText = `(${rect.x}, ${rect.y})`
    + ((opts.dx || opts.dy) ? ` (${signed(opts.dx || 0)}, ${signed(opts.dy || 0)})` : '');
  drawOriginMarker(ctx, p0, originText, alpha);
}

// One dimension per span along a shared edge. spans: [{from, to, text}] in
// IMAGE coords along `axis`; edge: the fixed image coordinate of the shape
// edge the chain hangs off (bottom y / right x for side 'end', top y /
// left x for side 'start').
export function drawChainDims(ctx, view, { axis, side = 'end', edge, spans, level = 0, alpha = 1 }) {
  for (const s of spans) {
    const a = axis === 'h' ? view.imageToScreen(s.from, edge) : view.imageToScreen(edge, s.from);
    const b = axis === 'h' ? view.imageToScreen(s.to, edge) : view.imageToScreen(edge, s.to);
    drawDimension(ctx, view, a, b, { axis, side, level, text: s.text, alpha });
  }
}

// Angle readout for rotation gestures, pill anchored right of (x, y).
export function drawAngleLabel(ctx, x, y, radians) {
  let deg = (radians * 180 / Math.PI) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  ctx.save();
  ctx.font = FONT;
  const w = Math.ceil(ctx.measureText(`${deg.toFixed(1)}°`).width) + PILL_PAD_X * 2;
  ctx.restore();
  drawPill(ctx, `${deg.toFixed(1)}°`, x + w / 2, y);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass (85 existing + 6 new = 91). The old `resizerect`/other suites must stay green — nothing else changed.

- [ ] **Step 5: Browser check (this task's flows only)**

All existing call sites now render the new visuals. Serve (`python -m http.server 8080` background if not running), Playwright on `?autotest`:
1. Select tool, drag a marquee → dimension lines below/right with arrows + centered pills, origin marker + `(x, y)` pill at top-left (screenshot).
2. Resize via a handle → pill shows `44 (+16)`-style Δ (screenshot mid-drag).
3. Tiny marquee (e.g. 3×3 at low zoom) → arrows outside, pill stuck out (screenshot).
4. Frame tool create-drag → same visuals on the ghost.
5. Move tool: float a selection → pills + origin marker on the float bounds; rotate → angle pill near the knob.
6. Zero console errors.

- [ ] **Step 6: Commit**

```
git add js/ui/dimlabels.js tests/dimlayout.test.mjs
git commit -m "feat: CAD dimension lines - extension lines, arrows, value pills"
```

---

### Task 2: Strip width chains (frames.js)

**Files:**
- Modify: `js/ui/frames.js` (imports; `drawFrameToolGhost`; new `drawStripDims`)

**Interfaces:**
- Consumes: `drawChainDims`, `drawRectDims` (with `wLevel`/`hLevel`) from Task 1; existing `boundingBoxOf(frames)`, `stripOf(sheet, frameId)`, `drag` state (`kind: 'move'`, `drag.members`, `drag.bbox`, `drag.delta`).
- Produces: intact strips render a level-0 per-member width chain below the bbox + level-1 overall width + single level-0 height + origin marker — both idle (quiet) and during strip moves (with `(+dx, +dy)`).

- [ ] **Step 1: Extend the dimlabels import**

```js
import { drawRectDims, drawChainDims } from './dimlabels.js';
```

- [ ] **Step 2: Add `drawStripDims`** (near `drawFrameToolGhost`)

```js
// Strip dimensions: level-0 width chain (one dimension per member, in x
// order) below the bbox, level-1 overall width, single level-0 height
// (members share it), origin marker on the bbox. dx/dy shift everything to
// the drag-ghost position; opts carries quiet/dx/dy for drawRectDims.
function drawStripDims(ctx, view, members, dx, dy, opts = {}) {
  const bbox = boundingBoxOf(members);
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
```

- [ ] **Step 3: Wire it into `drawFrameToolGhost`**

Move branch — replace the current `drag.kind === 'move'` label call:

```js
    } else if (drag.kind === 'move' && drag.bbox) {
      if (drag.members.length > 1) {
        drawStripDims(ctx, view, drag.members, drag.delta.dx, drag.delta.dy,
          { dx: drag.delta.dx, dy: drag.delta.dy });
      } else {
        const r = { x: drag.bbox.x + drag.delta.dx, y: drag.bbox.y + drag.delta.dy, w: drag.bbox.w, h: drag.bbox.h };
        drawRectDims(ctx, view, r, { dx: drag.delta.dx, dy: drag.delta.dy });
      }
    }
```

Idle branch — replace the current selected-frame block:

```js
  if (state.tool === 'frametool') {
    const selected = sheet.frames.find(f => f.id === state.selectedFrameId);
    const strip = selected ? stripOf(sheet, selected.id) : null;
    if (selected && !drag) {
      if (strip) {
        const members = sheet.frames.filter(f => strip.frames.some(af => af.frameId === f.id));
        drawStripDims(ctx, view, members, 0, 0, { quiet: true });
      } else {
        drawRectDims(ctx, view, selected, { quiet: true });
      }
    }
    // No resize handles on intact-strip members.
    if (selected && !strip) drawHandles(ctx, view, selected);
  }
```

- [ ] **Step 4: Verify**

`npm test` → 91/91 (syntax check).
Browser (strip flows only): sprite mode, Frames panel "New strip…" (e.g. 4 frames of 16×16); frame tool, click a member → width chain (four `16` pills at level 0) + overall `64` at level 1 + one height `16` + origin pill, all quiet (screenshot). Drag the strip → same dims on the ghost with origin `(+dx, +dy)` (screenshot mid-drag). A single (non-strip) frame still shows the plain rect dims. Zero console errors.

- [ ] **Step 5: Commit**

```
git add js/ui/frames.js
git commit -m "feat: per-member width chains for intact strips"
```

---

### Task 3: Slice-grid live preview + docs

**Files:**
- Modify: `js/ui/frames.js` (`buildSliceDialog`, `bindFrameTool`, `drawFrameToolGhost`, `mountFramesPanel` slice-button wiring)
- Modify: `README.md`, `tests/smoke.md`

**Interfaces:**
- Consumes: `drawChainDims` (Task 1), `sliceGrid` from `js/core/slicing.js` (already imported in frames.js), `strokeGhostRect`, module-scoped `drag`-style state pattern.
- Produces: while the Slice grid dialog is open, the sheet view shows a live ghost grid with top-edge column-width and left-edge row-height chains (level 0) plus overall region dims (level 1). `buildSliceDialog()` now returns `{ open }` instead of the raw dialog.

- [ ] **Step 1: Module state + view handle**

Near the top of frames.js (next to `let drag = null;`):

```js
// Live Slice-grid preview: dialog's current values while it is open, else
// null. The sheet view handle lets dialog input events trigger repaints.
let slicePreviewOpts = null;
let sheetViewForPreview = null;
```

In `bindFrameTool(view)`, first line of the body: `sheetViewForPreview = view;`

- [ ] **Step 2: Dialog wiring in `buildSliceDialog`**

After the existing `$` helper, add:

```js
  const readPreview = () => {
    const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
    return {
      cellW: intVal($('#sg-cellw'), 1), cellH: intVal($('#sg-cellh'), 1),
      marginX: intVal($('#sg-marginx'), 0), marginY: intVal($('#sg-marginy'), 0),
      spacingX: intVal($('#sg-spacingx'), 0), spacingY: intVal($('#sg-spacingy'), 0),
    };
  };
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
```

Change the function's return from `return dlg;` to:

```js
  return {
    open() {
      slicePreviewOpts = readPreview();
      dlg.showModal();
      sheetViewForPreview?.requestRender();
    },
  };
```

In `mountFramesPanel` (slice-button wiring, ~line 604-608):

```js
  const sliceDialog = buildSliceDialog();
  btnSlice.addEventListener('click', () => sliceDialog.open());
```

(`$('#sg-create')`'s `dlg.close()` and `$('#sg-cancel')`'s `dlg.close()` both fire the `close` listener — no extra clearing needed.)

- [ ] **Step 3: Preview drawing**

New function next to `drawFrameToolGhost`, and call it at the top of `drawFrameToolGhost` right after the mode/sheet guards:

```js
  if (slicePreviewOpts) drawSlicePreview(ctx, view, sheet);
```

```js
// Ghost grid + CAD chains for the open Slice-grid dialog: cell outlines in
// the standard dashed ghost style; level-0 chains along the TOP edge (one
// dimension per column width) and LEFT edge (one per row height); level-1
// overall region dimensions. Uses core sliceGrid so the preview always
// matches exactly what Create would produce. Degenerate inputs draw nothing.
function drawSlicePreview(ctx, view, sheet) {
  const o = slicePreviewOpts;
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
```

- [ ] **Step 4: Docs**

README — in the `M` tools-table row and the "Floating selections" paragraph, replace "CAD-style size/origin labels" / "CAD-style labels" phrasing with "CAD-style dimension lines (arrowed, with value pills)". Read the current text and keep everything else.

tests/smoke.md — amend wording only (no renumbering):
- Item 10: "...while dragging, CAD dimension lines (extension lines, arrows, value pills) show origin, W×H, and Δ; idle selection shows the quiet variant."
- Item 21: "...Move shows origin (+dx, +dy); create/resize drags show W×H pills with Δ on arrowed dimension lines."
- Item 23 (slice grid), append: "While the dialog is open, a live ghost grid previews the cells with per-column/per-row dimension chains and overall dims; the preview updates as inputs change and disappears on Cancel."
- Item 66: "...scale shows W×H pills with Δ (scaled content size); rotate shows an angle pill near the knob."
- Add to item 20 or the strips item 59 (whichever reads better): "An intact strip selected with the frame tool shows a per-member width chain plus overall width."

- [ ] **Step 5: Verify**

`npm test` → 91/91.
Browser (slice-preview flows only): sprite mode → Frames panel "Slice grid…" → ghost grid + top/left chains + overall dims appear behind the dialog (screenshot); change Cell W input → preview updates live (screenshot); Cancel → preview gone; reopen and Create → frames created as before (previewed geometry matches), dialog closes, preview gone. Zero console errors.

- [ ] **Step 6: Commit**

```
git add -A
git commit -m "feat: live slice-grid preview with dimension chains; docs"
```
