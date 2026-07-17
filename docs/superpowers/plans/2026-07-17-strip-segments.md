# Strip Segments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make animation strips directly editable on the sheet canvas: "+" insert call-outs, "✂" split into independently movable segments, snap-merge with reordering, edge-grip resize that adds/removes frames, and double-click to open the frame editor.

**Architecture:** One schema addition — strip animations gain `breaks: number[]` (sorted indices into `anim.frames` where a new spatial *segment* starts; playback unaffected). Pure segment/splice math lives in `js/core/strips.js` (node-tested); all UI (hover call-outs, snap ghost, grips) is drawn on the CanvasView overlay and hit-tested in the frame tool's pointer handlers in `js/ui/frames.js`, following the existing eager-mutate + whole-array-snapshot command idiom.

**Tech Stack:** Vanilla ES modules, no deps, no build step. Tests: `node --test` (`npm test`, currently all green / 0 fail). Browser checks: Playwright MCP vs `http://localhost:8080/?autotest` (`npx --yes serve -l 8080 .`).

**Spec:** `docs/superpowers/specs/2026-07-17-strip-segments-design.md`

## Global Constraints

- Windows/PowerShell environment — use PowerShell syntax for all commands; no bash-isms.
- No new dependencies. `js/core/*` stays DOM-free (node tests import it).
- `PROJECT_VERSION` stays 2. `breaks` is optional on load (`?? []`), always written on save.
- Command idiom: `state.commands.push(cmd)` CALLS `cmd.do()` immediately (see `js/core/commands.js:12`), and this codebase eager-mutates before pushing — so every `do()` must be idempotent (whole-array swaps + absolute-position blits, never relative math).
- Segment invariant (every strip op preserves it): within a segment, frames are spatially contiguous left-to-right (`next.x === prev.x + prev.w`, same `y`), spatial order === animation order, all members same `w`/`h`.
- Theme: chrome stroke/fill accent `#4f8cff`, text `#a9c7ff`, dark fill `rgba(20,20,24,.85)`, 11px monospace (matches dimlabels.js); snap highlight `#6adf7a`; break separator `#ffb454` dashed.
- Callout geometry (screen px): radius 8, centers 16px above the strip top edge ("+") / 16px below the bottom edge ("✂"); grips are 6px-wide full-height bars centered on the segment's left/right edges.
- Browser verification per task covers ONLY that task's flows (no re-sweeps); the whole-branch check in Task 8 is the single final gate. Verification claims require actual Playwright output — do not assert without evidence.
- Frequent commits; message style `feat:`/`fix:` matching git log.

---

### Task 1: Pure segment math in core/strips.js

**Files:**
- Modify: `js/core/strips.js` (append new exports)
- Test: `tests/strips.segments.test.mjs` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces (all pure; `anim`-shaped params mean any `{ frames: [{frameId, duration}], breaks?: number[] }`):
  - `normalizeBreaks(breaks, len)` → sorted, deduped, integer breaks clamped to `1..len-1`.
  - `segmentsOf(anim)` → `[{ start, end, index }]` half-open runs over `anim.frames` (empty frames → `[]`; no/empty breaks → one run).
  - `segmentOfFrame(anim, frameId)` → the run containing that frameId, or `null`.
  - `insertEntry(entries, breaks, index, entry, attachLeft)` → `{ entries, breaks }`; when `index` equals a break, `attachLeft: true` means the new entry joins the segment *ending* there (break shifts +1), `false` means it joins the segment *starting* there (break stays).
  - `removeEntry(entries, breaks, index)` → `{ entries, breaks }` (breaks above shift −1; degenerate breaks dropped).
  - `mergeSegments(anim, dragIdx, targetIdx, side)` → `{ frames, breaks }` — segment `dragIdx` spliced out and fused onto segment `targetIdx` (`side: 'before'|'after'` = dragged frames come first/last in the fused run); other segments keep relative order.
  - `transferSegment(src, dst, dragIdx, targetIdx, side)` → `{ src: {frames, breaks}, dst: {frames, breaks} }` — cross-animation version; `src` may come back with zero frames.

- [ ] **Step 1: Write the failing tests**

```js
// tests/strips.segments.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBreaks, segmentsOf, segmentOfFrame,
  insertEntry, removeEntry, mergeSegments, transferSegment,
} from '../js/core/strips.js';

const entries = (...ids) => ids.map(id => ({ frameId: id, duration: 100 }));
const ids = (list) => list.map(e => e.frameId);

test('normalizeBreaks sorts, dedupes, clamps to 1..len-1', () => {
  assert.deepEqual(normalizeBreaks([3, 1, 3, 0, 9, -2, 2.5], 4), [1, 3]);
  assert.deepEqual(normalizeBreaks(undefined, 4), []);
});

test('segmentsOf: no breaks = one run; breaks split into runs with index', () => {
  const anim = { frames: entries('a', 'b', 'c', 'd') };
  assert.deepEqual(segmentsOf(anim), [{ start: 0, end: 4, index: 0 }]);
  anim.breaks = [3];
  assert.deepEqual(segmentsOf(anim), [
    { start: 0, end: 3, index: 0 }, { start: 3, end: 4, index: 1 }]);
  assert.deepEqual(segmentsOf({ frames: [], breaks: [] }), []);
});

test('segmentOfFrame finds the containing run', () => {
  const anim = { frames: entries('a', 'b', 'c', 'd'), breaks: [2] };
  assert.deepEqual(segmentOfFrame(anim, 'c'), { start: 2, end: 4, index: 1 });
  assert.equal(segmentOfFrame(anim, 'zz'), null);
});

test('insertEntry interior: breaks above shift', () => {
  const r = insertEntry(entries('a', 'b', 'c', 'd'), [3], 1, { frameId: 'X', duration: 50 }, false);
  assert.deepEqual(ids(r.entries), ['a', 'X', 'b', 'c', 'd']);
  assert.deepEqual(r.breaks, [4]);
});

test('insertEntry at a break: attachLeft decides which segment grows', () => {
  const e = entries('a', 'b', 'c', 'd');
  // segment end (attachLeft=true): break shifts, X belongs to first segment
  const left = insertEntry(e, [2], 2, { frameId: 'X', duration: 50 }, true);
  assert.deepEqual(ids(left.entries), ['a', 'b', 'X', 'c', 'd']);
  assert.deepEqual(left.breaks, [3]);
  // segment start (attachLeft=false): break stays, X belongs to second segment
  const right = insertEntry(e, [2], 2, { frameId: 'X', duration: 50 }, false);
  assert.deepEqual(right.breaks, [2]);
});

test('removeEntry shifts breaks and drops degenerate ones', () => {
  const r = removeEntry(entries('a', 'b', 'c', 'd'), [2], 3);
  assert.deepEqual(ids(r.entries), ['a', 'b', 'c']);
  assert.deepEqual(r.breaks, [2]);
  // removing the only frame of the trailing segment drops its break
  const r2 = removeEntry(r.entries, r.breaks, 2);
  assert.deepEqual(ids(r2.entries), ['a', 'b']);
  assert.deepEqual(r2.breaks, []);
});

test("mergeSegments 'before': dragged segment's frames come first (C-before-A)", () => {
  // segments: [a,b] and [c,d]; drag idx1 before idx0 → c,d,a,b as ONE segment
  const anim = { frames: entries('a', 'b', 'c', 'd'), breaks: [2] };
  const r = mergeSegments(anim, 1, 0, 'before');
  assert.deepEqual(ids(r.frames), ['c', 'd', 'a', 'b']);
  assert.deepEqual(r.breaks, []);
});

test("mergeSegments 'after' keeps other segments' order and breaks", () => {
  // segments: [a] [b] [c,d]; drag idx0 after idx2 → [b] [c,d,a]
  const anim = { frames: entries('a', 'b', 'c', 'd'), breaks: [1, 2] };
  const r = mergeSegments(anim, 0, 2, 'after');
  assert.deepEqual(ids(r.frames), ['b', 'c', 'd', 'a']);
  assert.deepEqual(r.breaks, [1]);
});

test('transferSegment moves a run across animations; source may empty', () => {
  const src = { frames: entries('c0', 'c1'), breaks: [] };
  const dst = { frames: entries('a0', 'a1'), breaks: [] };
  const r = transferSegment(src, dst, 0, 0, 'before');
  assert.deepEqual(ids(r.src.frames), []);
  assert.deepEqual(ids(r.dst.frames), ['c0', 'c1', 'a0', 'a1']);
  assert.deepEqual(r.dst.breaks, []);
});

test('transferSegment with multi-segment source keeps the rest', () => {
  const src = { frames: entries('s0', 's1', 's2'), breaks: [1] }; // [s0] [s1,s2]
  const dst = { frames: entries('d0'), breaks: [] };
  const r = transferSegment(src, dst, 1, 0, 'after');
  assert.deepEqual(ids(r.src.frames), ['s0']);
  assert.deepEqual(r.src.breaks, []);
  assert.deepEqual(ids(r.dst.frames), ['d0', 's1', 's2']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `normalizeBreaks` etc. not exported from strips.js.

- [ ] **Step 3: Append the implementation to `js/core/strips.js`**

```js
// ---------------------------------------------------------------- segments
// A strip animation may carry `breaks`: sorted indices into anim.frames where
// a new spatial SEGMENT starts. Segments move independently on the sheet;
// playback always uses the full frames order. All helpers below are pure —
// they take/return plain arrays and never touch the sheet.

export function normalizeBreaks(breaks, len) {
  return [...new Set(breaks ?? [])]
    .filter(b => Number.isInteger(b) && b >= 1 && b <= len - 1)
    .sort((a, b) => a - b);
}

export function segmentsOf(anim) {
  const len = anim.frames.length;
  if (len === 0) return [];
  const starts = [0, ...normalizeBreaks(anim.breaks, len)];
  return starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? len, index: i }));
}

export function segmentOfFrame(anim, frameId) {
  const i = anim.frames.findIndex(e => e.frameId === frameId);
  if (i < 0) return null;
  return segmentsOf(anim).find(r => i >= r.start && i < r.end) ?? null;
}

// When `index` lands exactly on a break, the new entry could join the segment
// ending there (attachLeft: break shifts right) or the one starting there
// (break stays). Interior/end-of-array indexes are unaffected by the flag.
export function insertEntry(entries, breaks, index, entry, attachLeft) {
  const out = entries.slice();
  out.splice(index, 0, entry);
  const bs = (breaks ?? []).map(b => (b > index || (b === index && attachLeft)) ? b + 1 : b);
  return { entries: out, breaks: normalizeBreaks(bs, out.length) };
}

export function removeEntry(entries, breaks, index) {
  const out = entries.slice();
  out.splice(index, 1);
  const bs = (breaks ?? []).map(b => (b > index ? b - 1 : b));
  return { entries: out, breaks: normalizeBreaks(bs, out.length) };
}

function runsOf(o) {
  return segmentsOf(o).map(r => o.frames.slice(r.start, r.end));
}

function pack(runs) {
  const frames = runs.flat();
  const breaks = [];
  let acc = 0;
  for (let i = 0; i < runs.length - 1; i++) { acc += runs[i].length; breaks.push(acc); }
  return { frames, breaks };
}

// side 'before' = dragged frames precede the target run in the fused segment
// (the "drop C's right end at A's left end" case); 'after' = they follow it.
export function mergeSegments(anim, dragIdx, targetIdx, side) {
  const runs = runsOf(anim);
  const [dragged] = runs.splice(dragIdx, 1);
  const t = targetIdx > dragIdx ? targetIdx - 1 : targetIdx;
  runs[t] = side === 'before' ? [...dragged, ...runs[t]] : [...runs[t], ...dragged];
  return pack(runs);
}

export function transferSegment(src, dst, dragIdx, targetIdx, side) {
  const sRuns = runsOf(src);
  const [dragged] = sRuns.splice(dragIdx, 1);
  const dRuns = runsOf(dst);
  dRuns[targetIdx] = side === 'before'
    ? [...dragged, ...dRuns[targetIdx]] : [...dRuns[targetIdx], ...dragged];
  return { src: pack(sRuns), dst: pack(dRuns) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all green (existing suite + the 10 new tests).

- [ ] **Step 5: Commit**

```powershell
git add js/core/strips.js tests/strips.segments.test.mjs
git commit -m "feat: pure segment math for strip breaks (segmentsOf/insert/remove/merge/transfer)"
```

---

### Task 2: Model plumbing — breaks survive save/load, delete, slice, break-apart

**Files:**
- Modify: `js/core/model.js` (addAnimation, removeFrame, serializeProject, deserializeProject)
- Modify: `js/ui/frames.js` (commitBreakApartStrip, buildSliceDialog snapshots, deleteFrame snapshots)
- Test: `tests/model.test.mjs` (append)

**Interfaces:**
- Consumes: `removeEntry` from `js/core/strips.js` (Task 1).
- Produces: every animation object now reliably has `breaks: number[]` (new, loaded, or legacy-defaulted); `removeFrame(sheet, frameId)` keeps breaks consistent; existing anim-snapshot commands snapshot breaks too.

- [ ] **Step 1: Write the failing tests** (append to `tests/model.test.mjs`)

```js
test('addAnimation initializes breaks; serialize/deserialize round-trips them', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 32, height: 32, kind: 'sprite' });
  const a = addAnimation(s, 'walk', true);
  assert.deepEqual(a.breaks, []);
  const f1 = addFrame(s, { name: 'f1', x: 0, y: 0, w: 8, h: 8 });
  const f2 = addFrame(s, { name: 'f2', x: 8, y: 0, w: 8, h: 8 });
  a.frames = [{ frameId: f1.id, duration: 100 }, { frameId: f2.id, duration: 100 }];
  a.breaks = [1];
  const { json, images } = serializeProject(p);
  assert.deepEqual(json.sheets[0].animations[0].breaks, [1]);
  const imagesByPath = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(json, imagesByPath);
  assert.deepEqual(p2.sheets[0].animations[0].breaks, [1]);
});

test('deserializeProject defaults missing breaks to []', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 32, height: 32, kind: 'sprite' });
  addAnimation(s, 'walk', true);
  const { json, images } = serializeProject(p);
  delete json.sheets[0].animations[0].breaks; // legacy file
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual(p2.sheets[0].animations[0].breaks, []);
});

test('removeFrame adjusts breaks (shift down, drop degenerate)', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 64, height: 32, kind: 'sprite' });
  const fs = [0, 1, 2, 3].map(i => addFrame(s, { name: `f${i}`, x: i * 8, y: 0, w: 8, h: 8 }));
  const a = addAnimation(s, 'walk', true);
  a.frames = fs.map(f => ({ frameId: f.id, duration: 100 }));
  a.breaks = [2];
  removeFrame(s, fs[0].id);          // segments [0,1][2,3] → remove f0 → [1][2,3]
  assert.deepEqual(a.breaks, [1]);
  removeFrame(s, fs[1].id);          // [1][2,3] → remove f1 → break shifts to 0, normalize drops it
  assert.deepEqual(a.frames.map(e => e.frameId), [fs[2].id, fs[3].id]);
  assert.deepEqual(a.breaks, []);    // one segment [2,3]
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `a.breaks` is `undefined` after `addAnimation`, and serialize drops/aliases it.

- [ ] **Step 3: Implement in `js/core/model.js`**

Import at top (model.js currently imports from pixels/palettes/floating only):

```js
import { removeEntry } from './strips.js';
```

`addAnimation` (`js/core/model.js:97`):

```js
export function addAnimation(sheet, name, strip = false) {
  const anim = { id: newId('an'), name, loop: true, strip, breaks: [], frames: [] };
  sheet.animations.push(anim);
  return anim;
}
```

`removeFrame` (`js/core/model.js:91`):

```js
export function removeFrame(sheet, frameId) {
  sheet.frames = sheet.frames.filter(f => f.id !== frameId);
  for (const a of sheet.animations) {
    let i;
    while ((i = a.frames.findIndex(af => af.frameId === frameId)) !== -1) {
      const r = removeEntry(a.frames, a.breaks, i);
      a.frames = r.entries;
      a.breaks = r.breaks;
    }
  }
}
```

`serializeProject` animations line (`js/core/model.js:129`):

```js
animations: s.animations.map(a => ({ ...a, frames: a.frames.map(x => ({ ...x })), breaks: (a.breaks ?? []).slice() })),
```

`deserializeProject` animations line (`js/core/model.js:152`):

```js
animations: (s.animations ?? []).map(a => ({ ...a, strip: a.strip ?? false, breaks: a.breaks ?? [] })),
```

- [ ] **Step 4: Update the three anim-snapshot sites in `js/ui/frames.js` to carry breaks**

`commitBreakApartStrip` (`js/ui/frames.js:657`) — dissolving a strip also clears its segmentation:

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

`deleteFrame` (`js/ui/frames.js:203`) — snapshot shape gains breaks:

```js
const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
```

and in its `undo()`:

```js
for (const snap of animSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
```

(`do()` already routes through `removeFrame`, which now maintains breaks.)

`buildSliceDialog` create handler (`js/ui/frames.js:577-596`) — the replace path clears breaks and both snapshots carry them:

```js
const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
if (replace) {
  sheet.frames = [];
  for (const a of sheet.animations) { a.frames = []; a.breaks = []; }
}
for (const nf of newFrames) addFrame(sheet, nf);
const afterFrames = sheet.frames.slice();
const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
```

and both `do()`/`undo()` restore `snap.anim.breaks = snap.breaks.slice();` alongside frames.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: Commit**

```powershell
git add js/core/model.js js/ui/frames.js tests/model.test.mjs
git commit -m "feat: breaks field on animations - init, save/load, removeFrame + snapshot upkeep"
```

---

### Task 3: Segment-scoped move + break separators

**Files:**
- Modify: `js/ui/frames.js` (imports, handleDown move branch, idle overlay, new helper + separator renderer)

**Interfaces:**
- Consumes: `segmentsOf`, `segmentOfFrame` (Task 1).
- Produces: `segmentMembers(sheet, anim, run)` → frame objects of a run in animation order (module-local helper reused by Tasks 4-7); `drag` for moves gains `{ anim, run, snap: null }` fields (Task 4 fills `snap`).

- [ ] **Step 1: Extend imports in `js/ui/frames.js`**

```js
import { findFreeRect, buildStripFrames, segmentsOf, segmentOfFrame, insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks } from '../core/strips.js';
```

(Later tasks use the extra names; importing once here avoids churn.)

- [ ] **Step 2: Add the helper next to `stripOf` (`js/ui/frames.js:90`)**

```js
// Frame objects of one segment run, in animation order (=== spatial order per
// the segment invariant). Skips dangling frameIds defensively.
function segmentMembers(sheet, anim, run) {
  return anim.frames.slice(run.start, run.end)
    .map(e => sheet.frames.find(f => f.id === e.frameId))
    .filter(Boolean);
}
```

- [ ] **Step 3: Scope the move drag to the segment** — in `handleDown` (`js/ui/frames.js:246-259`) replace the strip/members lines:

```js
const strip = stripOf(sheet, hit.id);
const run = strip ? segmentOfFrame(strip, hit.id) : null;
const members = run ? segmentMembers(sheet, strip, run) : [hit];
drag = {
  kind: 'move', frame: hit, anim: strip, run, members, snap: null,
  bbox: boundingBoxOf(members),
  anchor: { x: ev.x, y: ev.y }, delta: { dx: 0, dy: 0 },
};
```

- [ ] **Step 4: Scope the idle overlay dims to the segment** — in `drawFrameToolGhost` (`js/ui/frames.js:426-438`):

```js
if (state.tool === 'frametool') {
  const selected = sheet.frames.find(f => f.id === state.selectedFrameId);
  const strip = selected ? stripOf(sheet, selected.id) : null;
  if (selected && !drag) {
    const run = strip ? segmentOfFrame(strip, selected.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : null;
    if (members && members.length > 1) drawStripDims(ctx, view, members, 0, 0, { quiet: true });
    else drawRectDims(ctx, view, selected, { quiet: true });
  }
  if (selected && !strip) drawHandles(ctx, view, selected);
}
```

- [ ] **Step 5: Draw dashed separators at breaks between still-adjacent segments** — add above `drawFrameToolGhost` and call it inside `drawFrameToolGhost` right after the `slicePreviewOpts` line, gated on `state.tool === 'frametool'`:

```js
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
```

Call site in `drawFrameToolGhost` (after the slice-preview call):

```js
if (state.tool === 'frametool') drawBreakSeparators(ctx, view, sheet);
```

- [ ] **Step 6: Node tests still green**

Run: `npm test`
Expected: PASS (no core changes; this catches accidental import/syntax breakage — frames.js isn't node-imported, so also open the app and check the console for module errors).

- [ ] **Step 7: Browser check (only this task's flows)**

```powershell
# terminal 1 (background): npx --yes serve -l 8080 .
# Playwright against http://localhost:8080/?autotest
```

- New strip… (4 frames) → drag a member: whole strip still moves as one (single segment), CAD chain shows 4 members.
- No visual separator yet (no breaks exist) — sheet renders clean, console error-free.

- [ ] **Step 8: Commit**

```powershell
git add js/ui/frames.js
git commit -m "feat: segment-scoped strip move and break separators"
```

---

### Task 4: Snap-merge — reorder within and across strip animations

**Files:**
- Modify: `js/ui/frames.js` (extract `buildMovePatches`, snap detection in `handleMove`, snapped ghost, merge commit in `handleUp`)

**Interfaces:**
- Consumes: `segmentMembers`, `drag.anim/run/snap` (Task 3); `mergeSegments`, `transferSegment` (Task 1).
- Produces: `buildMovePatches(sheet, frames, dx, dy)` → `{ patches, ur, beforeCoords, afterCoords }` (eagerly applies the move; reused by Tasks 5-6); `drag.snap = { anim, run, side, dx, dy, err } | null`.

- [ ] **Step 1: Extract the patch builder from `commitMoveFrames` (`js/ui/frames.js:157-190`)**

```js
// Pixel-carrying move of `frames` by (dx, dy), applied EAGERLY (bitmaps and
// frame coords are mutated before this returns). Returns everything a command
// needs to re-apply/undo idempotently. Copy-all-then-clear-then-blit so
// adjacent members never clobber each other.
function buildMovePatches(sheet, frames, dx, dy) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const patches = sheet.layers.map((layer) => {
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

function commitMoveFrames(sheet, frames, dx, dy) {
  const mv = buildMovePatches(sheet, frames, dx, dy);
  const cmd = {
    label: frames.length > 1 ? 'move strip' : 'move frame',
    do() {
      for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
      for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
    undo() {
      for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
      for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
  };
  state.commands.push(cmd);
  markDirty();
}
```

- [ ] **Step 2: Snap detection** — add near `boundingBoxOf`:

```js
const SNAP_SCREEN_PX = 10;

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

Wire into `handleMove`'s move branch (`js/ui/frames.js:269-271`):

```js
} else if (drag.kind === 'move') {
  const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y));
  drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
  const sheet = activeSheet();
  drag.snap = (drag.anim && sheet) ? findSnap(view, sheet, drag) : null;
}
```

- [ ] **Step 3: Snapped ghost + junction highlight** — in `drawFrameToolGhost`'s move branches, use the snapped delta and color:

```js
else if (drag.kind === 'move' && drag.bbox) {
  const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
  const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
  if (drag.snap) ctx.strokeStyle = '#6adf7a';
  strokeGhostRect(ctx, view, { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h });
}
```

and in the dims block below, pass the same effective dx/dy to `drawStripDims`/`drawRectDims`. Additionally, when snapped, draw a solid 2px `#6adf7a` vertical line at the junction edge (the shared edge between ghost and target bbox):

```js
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
```

- [ ] **Step 4: Merge commit** — add after `commitMoveFrames`:

```js
// Snap-merge: one undoable command = pixel move of the dragged members +
// order/breaks rewrite (+ possible source-animation deletion). Whole-array
// snapshots keep do()/undo() idempotent per the codebase idiom.
function commitMergeSegments(sheet, d, snap) {
  const srcAnim = d.anim, dstAnim = snap.anim;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: state.selectedAnimationId,
  };
  const mv = buildMovePatches(sheet, d.members, snap.dx, snap.dy);
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
      for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
      for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      sheet.animations = after.animations.slice();
      state.selectedAnimationId = dstAnim.id;
    },
    undo() {
      for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
      for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
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

Wire into `handleUp`'s move branch (`js/ui/frames.js:292-300`):

```js
if (d.kind === 'move') {
  if (d.snap) { commitMergeSegments(sheet, d, d.snap); return; }
  const dx = Math.max(-d.bbox.x, Math.min(sheet.width - (d.bbox.x + d.bbox.w), d.delta.dx));
  const dy = Math.max(-d.bbox.y, Math.min(sheet.height - (d.bbox.y + d.bbox.h), d.delta.dy));
  if (dx !== 0 || dy !== 0) commitMoveFrames(sheet, d.members, dx, dy);
  return;
}
```

- [ ] **Step 5: Node tests + browser check**

Run: `npm test` → PASS.

Browser (`?autotest`) — this task's flows only:
- Create strips A and C (New strip…, 4 frames each, 16×16). Draw a distinct pixel in A's first frame and C's first frame (pencil) so order is visible.
- Drag C so its right edge approaches A's left edge → ghost turns green and snaps; release → single animation "A" with 8 timeline cells, C gone from the animation picker; C's art moved next to A; frames panel shows 8 frames total unchanged in count.
- Undo → C is back as its own animation, art back at original position. Redo → merged again.
- Same-animation case: split isn't available until Task 6, so verify via two strips only (same-anim reorder is exercised in Task 8's final gate once split exists).

- [ ] **Step 6: Commit**

```powershell
git add js/ui/frames.js
git commit -m "feat: end-to-end snap-merge of strip segments with reorder and cross-anim transfer"
```

---

### Task 5: Hover chrome + "+" insert call-outs

**Files:**
- Modify: `js/ui/frames.js` (hover state, chrome geometry/hit-test/draw, insert command, handleDown/handleMove wiring)

**Interfaces:**
- Consumes: `segmentMembers`, `buildMovePatches`, `insertEntry`, `segmentsOf`.
- Produces: module-local `hover` state + `chromeGeometry(view, sheet, anim, run)` → `{ members, bbox, fw, inserts: [{k, cx, cy}], splits: [{k, cx, cy}], grips: [] }` (splits populated here, consumed in Task 6; grips added in Task 7); `commitInsertFrame(sheet, anim, run, k)`.

- [ ] **Step 1: Add hover state + geometry + hit-test + draw** (below the `drawStripDims` helper):

```js
// ------------------------------------------------------- in-strip chrome
// Hovering a strip segment (frame tool, idle) shows Word-style "+" insert
// call-outs above every frame boundary, "✂" split call-outs below interior
// boundaries (Task 6), and resize grips on the ends (Task 7). All geometry is
// computed in screen space per render; hits are tested on pointer-down before
// frame hit-testing.
const CALLOUT_R = 8;
const CALLOUT_OFF = 16;
let hover = null; // { animId, runIndex, part } | null; part from hitChrome()

function chromeGeometry(view, sheet, anim, run) {
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return null;
  const b = boundingBoxOf(members);
  const fw = members[0].w;
  const n = members.length;
  const canInsert = b.x + b.w + fw <= sheet.width; // any insert shifts/extends right
  const inserts = [];
  if (canInsert)
    for (let k = 0; k <= n; k++) {
      const p = view.imageToScreen(b.x + k * fw, b.y);
      inserts.push({ k, cx: p.x, cy: p.y - CALLOUT_OFF });
    }
  const splits = [];
  for (let k = 1; k < n; k++) {
    const p = view.imageToScreen(b.x + k * fw, b.y + b.h);
    splits.push({ k, cx: p.x, cy: p.y + CALLOUT_OFF });
  }
  return { members, bbox: b, fw, inserts, splits, grips: [] };
}

function hitChrome(g, sx, sy) {
  for (const c of g.inserts)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'insert', k: c.k };
  for (const c of g.splits)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'split', k: c.k };
  return null;
}

function updateHover(ev, view) {
  let next = null;
  const sheet = activeSheet();
  if (sheet && state.mode === 'sprites' && state.tool === 'frametool' && !drag) {
    outer: for (const a of sheet.animations) {
      if (!a.strip) continue;
      for (const run of segmentsOf(a)) {
        const g = chromeGeometry(view, sheet, a, run);
        if (!g) continue;
        const p0 = view.imageToScreen(g.bbox.x, g.bbox.y);
        const p1 = view.imageToScreen(g.bbox.x + g.bbox.w, g.bbox.y + g.bbox.h);
        const pad = CALLOUT_OFF + CALLOUT_R;
        if (ev.sx >= p0.x - pad && ev.sx <= p1.x + pad && ev.sy >= p0.y - pad && ev.sy <= p1.y + pad) {
          next = { animId: a.id, runIndex: run.index, part: hitChrome(g, ev.sx, ev.sy) };
          break outer;
        }
      }
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(hover)) {
    hover = next;
    view.requestRender();
  }
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

function drawChrome(ctx, view, sheet) {
  if (!hover || drag) return;
  const anim = sheet.animations.find(a => a.id === hover.animId);
  const run = anim?.strip ? segmentsOf(anim)[hover.runIndex] : null;
  if (!run) { hover = null; return; }
  const g = chromeGeometry(view, sheet, anim, run);
  if (!g) return;
  ctx.save();
  for (const c of g.inserts)
    drawCallout(ctx, c, '+', hover.part?.type === 'insert' && hover.part.k === c.k);
  for (const c of g.splits)
    drawCallout(ctx, c, '✂', hover.part?.type === 'split' && hover.part.k === c.k);
  ctx.restore();
}
```

Call `drawChrome(ctx, view, sheet)` at the END of `drawFrameToolGhost` (chrome renders on top), gated the same as the separators: `if (state.tool === 'frametool') drawChrome(ctx, view, sheet);`

- [ ] **Step 2: Wire hover updates** — `handleMove` (`js/ui/frames.js:265`) currently early-returns; route idle moves to the tracker:

```js
function handleMove(ev, view) {
  if (!drag) { updateHover(ev, view); return; }
  ...
}
```

Also clear hover when a drag starts: first line of `handleDown`: `if (hover) { hover = null; }` is NOT needed globally — instead, `drawChrome` already no-ops during drag; leave hover as-is so it reappears after the drag.

- [ ] **Step 3: Insert command**:

```js
// Word-style insert-column at boundary k of a segment (0=before first,
// n=after last): the tail shifts right one frame width (pixel-carrying), a
// blank frame fills the gap, an animation entry lands at the matching order
// index with its neighbor's duration.
function commitInsertFrame(sheet, anim, run, k) {
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const fw = members[0].w, fh = members[0].h;
  const b = boundingBoxOf(members);
  if (b.x + b.w + fw > sheet.width) return;
  const index = run.start + k;
  const attachLeft = k === members.length;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();

  const tail = members.slice(k);
  const mv = tail.length ? buildMovePatches(sheet, tail, fw, 0) : null;
  const frame = addFrame(sheet, {
    name: `${anim.name}_${anim.frames.length}`,
    x: b.x + k * fw, y: b.y, w: fw, h: fh,
  });
  const duration = beforeEntries[index - 1]?.duration ?? beforeEntries[index]?.duration
    ?? (state.project?.settings?.durationMs ?? 100);
  const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, attachLeft);
  anim.frames = r.entries;
  anim.breaks = r.breaks;

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();

  state.commands.push({
    label: 'insert frame',
    do() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = frame.id;
    },
    undo() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    },
  });
  markDirty();
  emit('selection');
}
```

- [ ] **Step 4: Chrome clicks in `handleDown`** — insert at the very top of `handleDown`, after the `sheet` guard (`js/ui/frames.js:228-230`):

```js
if (hover?.part && state.tool === 'frametool') {
  const anim = sheet.animations.find(a => a.id === hover.animId);
  const run = anim?.strip ? segmentsOf(anim)[hover.runIndex] : null;
  if (anim && run) {
    const g = chromeGeometry(view, sheet, anim, run);
    const part = g && hitChrome(g, ev.sx, ev.sy); // re-verify at the down position
    if (part?.type === 'insert') { commitInsertFrame(sheet, anim, run, part.k); view.requestRender(); return; }
    if (part?.type === 'split') { commitSplitStrip(anim, run.start + part.k); view.requestRender(); return; } // Task 6
  }
}
```

Until Task 6 lands, add the stub `function commitSplitStrip() {} // replaced in Task 6 (split call-out)` next to `commitInsertFrame` so the file loads clean.

- [ ] **Step 5: Node tests + browser check**

Run: `npm test` → PASS.

Browser (`?autotest`) — this task's flows only:
- New strip… (4 frames). Hover the strip → five "+" call-outs appear above (start, 3 boundaries, end); moving the pointer off hides them.
- Draw a recognizable pixel in frame 2. Click the "+" between frames 1 and 2 → strip is 5 frames wide; the art that was in frame 2 is now in frame 3 (shifted right, pixels carried); timeline shows 5 cells; new cell's duration equals its left neighbor's.
- Click "+" at the far end → 6 frames, no pixel movement.
- Undo twice → back to 4 frames, art back in frame 2.
- Park a strip flush against the sheet's right edge → no "+" call-outs appear on it.

- [ ] **Step 6: Commit**

```powershell
git add js/ui/frames.js
git commit -m "feat: hover chrome with + insert call-outs for strip segments"
```

---

### Task 6: "✂" split + Delete closes the gap

**Files:**
- Modify: `js/ui/frames.js` (split command replacing the Task 5 stub, Delete-key routing, remove-member command)

**Interfaces:**
- Consumes: hover chrome + `commitSplitStrip` call site (Task 5), `buildMovePatches` (Task 4), `removeEntry`, `segmentOfFrame`.
- Produces: `commitSplitStrip(anim, index)`; `commitRemoveMember(sheet, anim, frameId)`.

- [ ] **Step 1: Split command** (replaces the Task 5 stub):

```js
// Split = add a break. Nothing moves; the dashed separator (Task 3) marks the
// cut until one side is dragged away.
function commitSplitStrip(anim, index) {
  const before = (anim.breaks ?? []).slice();
  const after = normalizeBreaks([...before, index], anim.frames.length);
  if (after.length === before.length) return;
  state.commands.push({
    label: 'split strip',
    do() { anim.breaks = after.slice(); },
    undo() { anim.breaks = before.slice(); },
  });
  markDirty();
}
```

- [ ] **Step 2: Remove-member command (delete-column)**:

```js
// Delete on a strip member removes the frame AND closes the gap: the rest of
// its segment shifts left one frame width. model.removeFrame keeps every
// animation's entries/breaks consistent; snapshots cover them all for undo.
function commitRemoveMember(sheet, anim, frameId) {
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
  const mv = tail.length ? buildMovePatches(sheet, tail, -fw, 0) : null;
  removeFrame(sheet, frameId);

  const afterSheetFrames = sheet.frames.slice();
  const afterAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));

  state.commands.push({
    label: 'remove strip frame',
    do() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = afterSheetFrames.slice();
      for (const s of afterAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    },
    undo() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = beforeSheetFrames.slice();
      for (const s of beforeAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (wasSelected) state.selectedFrameId = frameId;
    },
  });
  markDirty();
  emit('selection');
}
```

Note: `removeFrame` here is the import from `../core/model.js` already present at the top of frames.js.

- [ ] **Step 3: Route the Delete key** — in `registerFrameTool`'s keydown handler (`js/ui/frames.js:468-475`):

```js
const sheet = activeSheet();
if (!sheet || !state.selectedFrameId) return;
const strip = stripOf(sheet, state.selectedFrameId);
if (strip) commitRemoveMember(sheet, strip, state.selectedFrameId);
else deleteFrame(sheet, state.selectedFrameId);
```

- [ ] **Step 4: Node tests + browser check**

Run: `npm test` → PASS.

Browser (`?autotest`) — this task's flows only:
- New strip… (4 frames), draw distinct pixels in frames 0-3. Hover → "✂" call-outs below the 3 interior boundaries.
- Click "✂" at boundary 2 → orange dashed separator appears there; timeline still shows 4 cells (playback order unchanged).
- Drag the right half away → only frames 2-3 move (segment-scoped move from Task 3 now visibly exercised); drag it back edge-to-edge → green snap, release → separator gone, single segment again (same-animation merge from Task 4 now exercised; reorder by snapping the right half to the LEFT end and confirm timeline order flips to 2,3,0,1).
- Select frame 1, press Delete → strip closes to 3 frames, frame 2's art shifts left into the gap; undo restores.

- [ ] **Step 5: Commit**

```powershell
git add js/ui/frames.js
git commit -m "feat: scissors split call-out and gap-closing delete for strip segments"
```

---

### Task 7: Edge-grip resize adds/removes frames

**Files:**
- Modify: `js/ui/frames.js` (grips in chromeGeometry/hitChrome/drawChrome, `stripresize` drag kind, resize command, ghost)

**Interfaces:**
- Consumes: chrome plumbing (Task 5), `insertEntry`/`removeEntry`, `drawChainDims`/`drawRectDims` (existing imports).
- Produces: `commitResizeSegment(sheet, d)`; `drag.kind === 'stripresize'` with `{ anim, run, side, fw, fh, bbox, count0, count }`.

- [ ] **Step 1: Grips in the chrome** — extend `chromeGeometry` (replace `grips: []`):

```js
const p0 = view.imageToScreen(b.x, b.y);
const p1 = view.imageToScreen(b.x + b.w, b.y + b.h);
const grips = [
  { side: 'left', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
  { side: 'right', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
];
return { members, bbox: b, fw, inserts, splits, grips };
```

`hitChrome` gains (after the splits loop):

```js
for (const gr of g.grips)
  if (sx >= gr.x - 2 && sx <= gr.x + gr.w + 2 && sy >= gr.y && sy <= gr.y + gr.h)
    return { type: 'grip', side: gr.side };
```

`drawChrome` gains (before `ctx.restore()`):

```js
for (const gr of g.grips) {
  const active = hover.part?.type === 'grip' && hover.part.side === gr.side;
  ctx.globalAlpha = active ? 1 : 0.7;
  ctx.fillStyle = '#4f8cff';
  ctx.fillRect(gr.x, gr.y, gr.w, gr.h);
  ctx.globalAlpha = 1;
}
```

- [ ] **Step 2: Start the drag** — in the Task 5 chrome-click block in `handleDown`, add before the insert/split branches:

```js
if (part?.type === 'grip') {
  const members = g.members;
  drag = {
    kind: 'stripresize', anim, run, side: part.side,
    fw: g.fw, fh: members[0].h, bbox: g.bbox,
    count0: members.length, count: members.length,
  };
  view.requestRender();
  return;
}
```

- [ ] **Step 3: Track the drag** — add a branch to `handleMove`:

```js
} else if (drag.kind === 'stripresize') {
  const sheet = activeSheet();
  const raw = drag.side === 'right'
    ? ev.x - (drag.bbox.x + drag.bbox.w)
    : drag.bbox.x - ev.x;
  let count = drag.count0 + Math.round(raw / drag.fw);
  count = Math.max(1, count);
  if (sheet) {
    const maxCount = drag.side === 'right'
      ? Math.floor((sheet.width - drag.bbox.x) / drag.fw)
      : Math.floor((drag.bbox.x + drag.bbox.w) / drag.fw);
    count = Math.min(count, Math.max(1, maxCount));
  }
  drag.count = count;
}
```

- [ ] **Step 4: Ghost + dims** — in `drawFrameToolGhost`, add to the dashed-ghost section and the dims section:

```js
else if (drag.kind === 'stripresize') strokeGhostRect(ctx, view, resizeGhostRect(drag));
```

with helper + dims:

```js
function resizeGhostRect(d) {
  const w = d.count * d.fw;
  const x = d.side === 'right' ? d.bbox.x : d.bbox.x + d.bbox.w - w;
  return { x, y: d.bbox.y, w, h: d.bbox.h };
}
```

```js
else if (drag.kind === 'stripresize') {
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
```

- [ ] **Step 5: Commit the resize** — `handleUp` gains:

```js
if (d.kind === 'stripresize') {
  if (d.count !== d.count0) commitResizeSegment(sheet, d);
  return;
}
```

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

- [ ] **Step 6: Node tests + browser check**

Run: `npm test` → PASS.

Browser (`?autotest`) — this task's flows only:
- New strip… (3 frames). Hover → blue grip bars on both ends.
- Drag right grip +2 frames: ghost quantizes in whole-frame steps with `(+2f)` in the level-1 pill; release → 5 frames, 5 timeline cells, new cells share the neighbor duration.
- Draw art in the last frame; drag right grip −1: frame gone from strip+timeline but its pixels still visible on the sheet; drag right grip +1 → re-adopted with the art intact.
- Drag left grip +1: strip extends LEFT; the new frame is FIRST in the timeline.
- Try shrinking below 1 frame → clamps at 1. Grip drag near sheet edge → clamps at bounds.
- Undo chain walks each resize back.

- [ ] **Step 7: Commit**

```powershell
git add js/ui/frames.js
git commit -m "feat: strip edge-grip resize adds/removes whole frames"
```

---

### Task 8: Double-click to edit, timeline gating, docs, final gate

**Files:**
- Modify: `js/ui/frames.js` (dblclick detection in handleDown)
- Modify: `js/ui/timeline.js` (gate reorder/remove/add for intact strips)
- Modify: `tests/smoke.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: n/a (final task).

- [ ] **Step 1: Double-click in `handleDown`** — module-level `let lastClick = null;` next to `let drag = null;`. Insert AFTER the chrome-click block (chrome wins over dblclick) and BEFORE the resize-handle check:

```js
// Double-click (two downs on the same frame within 350ms) opens the frame
// editor and points the timeline at the frame's animation.
const clickHit = frameAt(sheet, ev.x, ev.y);
const now = performance.now();
if (clickHit && lastClick && lastClick.frameId === clickHit.id && now - lastClick.t < 350) {
  lastClick = null;
  drag = null;
  state.editingFrameId = clickHit.id;
  const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === clickHit.id));
  if (owner) state.selectedAnimationId = owner.id;
  state.view = 'frame';
  emit('view');
  emit('selection');
  return;
}
lastClick = clickHit ? { frameId: clickHit.id, t: now } : null;
```

- [ ] **Step 2: Timeline gating** — in `js/ui/timeline.js`:

`buildCell` (`js/ui/timeline.js:385-448`): only wire structural affordances for non-strips —

```js
cell.draggable = !anim.strip;
```

wrap the remove button so strips don't get one:

```js
const controls = document.createElement('div');
controls.className = 'timeline-cell-controls';
controls.append(durationInput);
if (!anim.strip) controls.append(btnRemove);
```

and guard the drop handler's top: `if (anim.strip) return;` in `dragover` and `drop` (before `e.preventDefault()`).

`render()` (`js/ui/timeline.js:479`): intact strips can't take arbitrary frames —

```js
btnAddFrame.disabled = !anim || !state.selectedFrameId || !!anim.strip;
```

- [ ] **Step 3: Update `tests/smoke.md`** — add a "Strip segments" section listing the new manual smoke items (insert +, split ✂, segment move, same-anim snap-reorder, cross-anim merge incl. source-animation deletion, grip resize grow/shrink both ends, Delete closes gap, dblclick opens editor, timeline gating, save/load round-trips breaks). Match the file's existing item format.

- [ ] **Step 4: Update `README.md`** — the strip paragraph around line 125 documents `strip: true`; extend it with `breaks` (project-internal, optional, segments = spatial sub-strips, playback unaffected) and a short user-facing bullet for the new canvas interactions wherever the README lists frame-tool features.

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: PASS, all green.

- [ ] **Step 6: FINAL GATE — whole-branch browser verification** (the single consolidated sweep; per-task checks above never repeat each other):

The A/B/C acceptance scenario end-to-end at `http://localhost:8080/?autotest`:
1. Create strips A, B, C (4 frames each, 16×16); draw distinct art in each strip's frame 0.
2. Double-click a frame of B with the frame tool → frame editor opens on it, Back to sheet returns, timeline shows B selected.
3. Drag C so its right end meets A's left end → green snap → release → animation picker no longer lists C; "A" has 8 cells ordered C0..C3, A0..A3 (verify via the art drawn in step 1 and cell thumbnails).
4. Split A at its midpoint (✂) → separator; drag the right half elsewhere; insert "+" a frame into the left half; Delete a frame of the right half; grip-resize the left half +1.
5. Timeline for A: no ✕ buttons, cells not draggable, Add-frame disabled; durations still editable.
6. Save (packed), reload the page, open the file → segmentation (separator/detached half) and order survive.
7. Undo repeatedly until the project is back to three 4-frame strips — every step walks back cleanly.
8. Console shows no errors throughout.

- [ ] **Step 7: Commit**

```powershell
git add js/ui/frames.js js/ui/timeline.js tests/smoke.md README.md
git commit -m "feat: dblclick-to-edit, strip timeline gating; strip-segments smoke items + docs"
```
