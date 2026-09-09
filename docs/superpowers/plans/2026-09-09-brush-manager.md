# Brush Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's single-integer brush with a mask × ink brush engine and a managed, portable brush library.

**Architecture:** Four pure `js/core/` modules hold the model, the transforms, the ramp detection and the inks, with no DOM, so they test directly under `node --test`. A stroke runs in two phases — a mask phase that produces stamp positions, then an ink pass that writes each covered pixel exactly once. `js/features/brushes/` owns the library, the manager dialog and the file glue. `js/core/pixels.js` gains an optional ink hook; its existing signatures keep working so the compositing and snapping callers are untouched.

**Tech Stack:** Vanilla ES modules, no build step. `node --test` for tests. Native `<dialog>`, `localStorage` via `BrowserPreferences`. Existing helpers: `flipBitmap` / `blitRegion` / `getPixel` / `setPixel` (`js/core/pixels.js`), `nearestColor` (`js/core/palettes.js`), `CommandStack` / `makePixelPatch` (`js/core/commands.js`), `encodePng` / `decodePng` (`js/core/pngcodec.js`), `makeDialogMovable` / `centerDialog` / `closeOnEscape` / `markDefaultAction` (`js/components/dialogs.js`), `confirmOrAuto` (`js/platform/browser/autotest.js`).

**Spec:** `docs/superpowers/specs/2026-09-09-brush-manager-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

- **Masks are 1-bit.** No feathering, no alpha ramp, no anti-aliasing. A mask pixel is covered or it is not.
- **Palette closure.** When the active palette is `indexed`, every value an ink writes is an entry of that palette, routed through `nearestColor` from `js/core/palettes.js`.
- **`ramp-shade` never interpolates.** It moves between existing palette entries only. A ramp of 4 entries has exactly 4 reachable values.
- **Dither uses two palette entries**, never a blend of them.
- **Opacity does not invent colors** in its default mode. It maps to a Bayer threshold pattern. `trueAlpha: true` is opt-in and off by default.
- **Opacity quantizes to the pattern's levels.** A 4×4 Bayer matrix offers 17 densities; the 0–100 slider snaps to the nearest.
- **Rotation is quarter turns only** (0/90/180/270) plus flips. Lossless permutations. Arbitrary angles are excluded.
- **Pressure is honored only when `pointerType === 'pen'`.** A mouse reports constant 0.5.
- **Every pressure target quantizes to an integer.** No fractional brush size, no continuous opacity.
- **Brush edits never enter project history.** They undo on the manager's local `CommandStack`. Palettes and their ramps undo at `PROJECT_SCOPE`. The two never mix.
- **`spacing` and `scatter` are integers in pixels**, never percentages of brush size.
- **Stroke randomness is seeded**, fixed at pointer-down, and derived from `(seed, stampIndex)` rather than call order, so re-rasterizing a prefix reproduces it exactly.
- **`stamp` ink requires a `custom` mask.** With a square or circle mask it falls back to `solid`.
- **`js/bootstrap.js` must stay at or under 60 lines** (asserted by `tests/architecture.test.mjs`). It is currently 41.
- **Windows/PowerShell environment.** Use PowerShell syntax for shell commands.
- **Commits:** each task ends with a commit step, but per the user's standing git rule, only run `git commit` if the user has authorized commits for the execution session. Otherwise leave the work uncommitted and say so.

## File Structure

**Create — pure core (no DOM, `node --test`):**

| File | Responsibility |
|---|---|
| `js/core/brushes.js` | Brush model: `createBrush`, `normalizeBrush`, built-ins, validation, mask rasterization, lossless transforms, pressure mapping |
| `js/core/brush-stroke.js` | Seeded PRNG and the mask phase: turning a pointer path into stamp placements |
| `js/core/ramps.js` | Ramp detection over a palette |
| `js/core/dither.js` | Bayer threshold patterns and opacity→density |
| `js/core/brush-ink.js` | The six inks, as per-stroke ink objects |
| `js/core/brush-io.js` | PNG and JSON brush formats |

**Create — features (DOM):**

| File | Responsibility |
|---|---|
| `js/features/brushes/brush-library.js` | localStorage-backed library |
| `js/features/brushes/brush-manager.js` | The manager dialog and its local undo stack |
| `js/features/brushes/brush-files.js` | Browser file import/export glue |

**Modify:**

| File | Change |
|---|---|
| `js/core/pixels.js` | Optional ink hook on the primitives; mask-aware `stamp` |
| `js/core/palettes.js` | Additive `ramps: []` field, `normalizePalette` |
| `js/core/model.js` | Serialize/deserialize `brushes` and palette `ramps` |
| `js/features/palettes/palette-commands.js` | Named-ramp commands at `PROJECT_SCOPE` |
| `js/components/canvas/canvas-view.js` | Forward `pressure` and `pointerType` |
| `js/components/canvas/drawing-engine.js` | Mask phase + ink pass; widen scatter overflow bounds |
| `js/components/tool-palette.js` | Brush picker strip; size input drives `mask.size` |
| `js/host/editor-store.js` | `brushSize` → `brush` |
| `js/features/shell/menu-controller.js` | `edit.brushes` menu item |
| `js/bootstrap.js` | Mount the brush manager |

---

### Task 1: Brush model — `js/core/brushes.js`

The shape, its normalizer, the built-ins and validation. Deliberately excludes rasterization (Task 2) so this task's diff is purely about data.

**Files:**
- Create: `js/core/brushes.js`
- Test: `tests/brushes.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DEFAULT_BRUSH` — the square-1 solid brush
  - `createBrush({ name, mask, ink, pressure }) -> Brush`
  - `normalizeBrush(raw) -> Brush` — accepts partial or legacy objects, fills every field
  - `BUILTIN_BRUSHES: Brush[]` — square 1/2/3, circle 3/5
  - `validateBrush(brush) -> { ok, reason }` — enforces the `stamp`-needs-`custom` rule
  - `newBrushId() -> string`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brushes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrush, normalizeBrush, validateBrush, BUILTIN_BRUSHES, DEFAULT_BRUSH,
} from '../js/core/brushes.js';

test('createBrush fills every field with retro-safe defaults', () => {
  const b = createBrush({ name: 'Test' });
  assert.equal(b.name, 'Test');
  assert.equal(b.mask.kind, 'square');
  assert.equal(b.mask.size, 1);
  assert.equal(b.mask.spacing, 1);
  assert.equal(b.mask.scatter, 0);
  assert.equal(b.mask.rotate, 0);
  assert.equal(b.mask.flipH, false);
  assert.equal(b.mask.rotateJitter, false);
  assert.equal(b.ink.kind, 'solid');
  assert.equal(b.ink.opacity, 100);
  assert.equal(b.ink.trueAlpha, false);
  assert.equal(b.ink.jitter, 0);
  assert.equal(b.pressure.target, 'none');
  assert.ok(b.id);
});

test('normalizeBrush accepts a partial object and never returns undefined fields', () => {
  const b = normalizeBrush({ name: 'Partial', mask: { kind: 'circle', size: 5 } });
  assert.equal(b.mask.kind, 'circle');
  assert.equal(b.mask.size, 5);
  assert.equal(b.mask.spacing, 1);
  assert.equal(b.ink.kind, 'solid');
  assert.equal(b.pressure.target, 'none');
});

test('normalizeBrush clamps size to 1..16 and spacing to at least 1', () => {
  assert.equal(normalizeBrush({ mask: { size: 99 } }).mask.size, 16);
  assert.equal(normalizeBrush({ mask: { size: 0 } }).mask.size, 1);
  assert.equal(normalizeBrush({ mask: { spacing: 0 } }).mask.spacing, 1);
  assert.equal(normalizeBrush({ mask: { scatter: -3 } }).mask.scatter, 0);
});

test('normalizeBrush snaps rotate to a quarter turn', () => {
  assert.equal(normalizeBrush({ mask: { rotate: 37 } }).mask.rotate, 0);
  assert.equal(normalizeBrush({ mask: { rotate: 90 } }).mask.rotate, 90);
  assert.equal(normalizeBrush({ mask: { rotate: 450 } }).mask.rotate, 90);
});

test('validateBrush rejects stamp ink on a non-custom mask', () => {
  const bad = normalizeBrush({ mask: { kind: 'square' }, ink: { kind: 'stamp' } });
  assert.equal(validateBrush(bad).ok, false);
  const good = normalizeBrush({
    mask: { kind: 'custom', bitmap: { width: 1, height: 1, bits: [1] } },
    ink: { kind: 'stamp' },
  });
  assert.equal(validateBrush(good).ok, true);
});

test('built-ins are all valid and include the default square 1', () => {
  for (const b of BUILTIN_BRUSHES) assert.equal(validateBrush(b).ok, true, b.name);
  assert.equal(DEFAULT_BRUSH.mask.size, 1);
  assert.equal(DEFAULT_BRUSH.ink.kind, 'solid');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brushes.test.mjs`
Expected: FAIL — cannot find module `../js/core/brushes.js`.

- [ ] **Step 3: Implement `js/core/brushes.js`**

```js
// js/core/brushes.js
// Brush model. Pure data + validation; no DOM, no host access.
//
// A brush is two independent axes: a MASK (which pixels a stroke touches) and
// an INK (what value is written there). Keeping them separate is what lets a
// handful of masks and inks combine into a large brush vocabulary.

export const MASK_KINDS = ['square', 'circle', 'custom'];
export const INK_KINDS = ['solid', 'ramp-shade', 'dither', 'stamp', 'lock-alpha', 'replace'];
export const PRESSURE_TARGETS = ['none', 'size', 'opacity', 'shade-step'];
export const PRESSURE_CURVES = ['linear', 'soft', 'hard'];
export const MAX_MASK_SIZE = 16;

let idCounter = 0;
export function newBrushId() {
  idCounter += 1;
  return `brush_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Quarter turns only. Anything that is not already a multiple of 90 is not
// representable losslessly, so it snaps to 0 rather than being resampled.
function normalizeRotate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const r = ((Math.round(n) % 360) + 360) % 360;
  return r % 90 === 0 ? r : 0;
}

function normalizeMask(raw = {}) {
  return {
    kind: oneOf(raw.kind, MASK_KINDS, 'square'),
    size: clampInt(raw.size, 1, MAX_MASK_SIZE, 1),
    bitmap: raw.bitmap ?? null,
    colors: raw.colors ?? null,
    spacing: clampInt(raw.spacing, 1, 64, 1),
    scatter: clampInt(raw.scatter, 0, 64, 0),
    rotate: normalizeRotate(raw.rotate),
    flipH: !!raw.flipH,
    flipV: !!raw.flipV,
    rotateJitter: !!raw.rotateJitter,
  };
}

function normalizeInk(raw = {}) {
  return {
    kind: oneOf(raw.kind, INK_KINDS, 'solid'),
    opacity: clampInt(raw.opacity, 0, 100, 100),
    trueAlpha: !!raw.trueAlpha,
    jitter: clampInt(raw.jitter, 0, 8, 0),
    pattern: raw.pattern ?? 'bayer4',
    rampName: raw.rampName ?? null,
    replaceColor: raw.replaceColor ?? null,
  };
}

function normalizePressure(raw = {}) {
  return {
    target: oneOf(raw.target, PRESSURE_TARGETS, 'none'),
    min: clampInt(raw.min, 0, 100, 1),
    max: clampInt(raw.max, 0, 100, 8),
    curve: oneOf(raw.curve, PRESSURE_CURVES, 'linear'),
  };
}

export function normalizeBrush(raw = {}) {
  return {
    id: raw.id ?? newBrushId(),
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Brush',
    mask: normalizeMask(raw.mask),
    ink: normalizeInk(raw.ink),
    pressure: normalizePressure(raw.pressure),
  };
}

export function createBrush({ name = 'Brush', mask, ink, pressure } = {}) {
  return normalizeBrush({ name, mask, ink, pressure });
}

// `stamp` ink paints the mask's own color payload, so it is meaningless
// without one. The manager blocks the combination rather than saving a brush
// that would silently behave as `solid`.
export function validateBrush(brush) {
  if (brush.ink.kind === 'stamp' && brush.mask.kind !== 'custom') {
    return { ok: false, reason: 'Stamp ink requires a custom mask' };
  }
  if (brush.mask.kind === 'custom' && !brush.mask.bitmap) {
    return { ok: false, reason: 'Custom mask requires a bitmap' };
  }
  if (brush.ink.kind === 'replace' && !brush.ink.replaceColor) {
    return { ok: false, reason: 'Replace ink requires a target color' };
  }
  return { ok: true, reason: '' };
}

export const DEFAULT_BRUSH = createBrush({ name: 'Pixel', mask: { kind: 'square', size: 1 } });

export const BUILTIN_BRUSHES = [
  DEFAULT_BRUSH,
  createBrush({ name: 'Square 2', mask: { kind: 'square', size: 2 } }),
  createBrush({ name: 'Square 3', mask: { kind: 'square', size: 3 } }),
  createBrush({ name: 'Circle 3', mask: { kind: 'circle', size: 3 } }),
  createBrush({ name: 'Circle 5', mask: { kind: 'circle', size: 5 } }),
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brushes.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```powershell
git add js/core/brushes.js tests/brushes.test.mjs
git commit -m "feat: add brush model with mask/ink shape and validation"
```

---

### Task 2: Mask rasterization and lossless transforms

Turns a mask description into a 1-bit coverage grid, and applies quarter turns and flips. The losslessness property is the whole reason rotation is restricted, so it is asserted directly.

**Files:**
- Modify: `js/core/brushes.js` (append)
- Test: `tests/brush-transform.test.mjs`

**Interfaces:**
- Consumes: `normalizeBrush`, `MAX_MASK_SIZE` (Task 1).
- Produces:
  - `rasterizeMask(mask) -> { width, height, bits: Uint8Array }` — `bits[i]` is 0 or 1, row-major
  - `rotateMaskGrid(grid, degrees) -> grid` — 0/90/180/270, lossless
  - `flipMaskGrid(grid, flipH, flipV) -> grid` — lossless
  - `maskGridFor(mask, { rotate }) -> grid` — rasterize then transform, the function the stroke phase calls

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-transform.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { rasterizeMask, rotateMaskGrid, flipMaskGrid, maskGridFor } from '../js/core/brushes.js';

function countSet(grid) {
  let n = 0;
  for (const b of grid.bits) if (b) n++;
  return n;
}

test('square mask is fully covered at every size', () => {
  for (let size = 1; size <= 16; size++) {
    const grid = rasterizeMask(normalizeBrush({ mask: { kind: 'square', size } }).mask);
    assert.equal(grid.width, size);
    assert.equal(grid.height, size);
    assert.equal(countSet(grid), size * size);
  }
});

test('circle mask is symmetric and strictly smaller than its square', () => {
  const grid = rasterizeMask(normalizeBrush({ mask: { kind: 'circle', size: 5 } }).mask);
  assert.equal(grid.width, 5);
  // Corners are outside the disc.
  assert.equal(grid.bits[0], 0);
  assert.equal(grid.bits[4], 0);
  assert.equal(grid.bits[20], 0);
  assert.equal(grid.bits[24], 0);
  // Center row is solid.
  for (let x = 0; x < 5; x++) assert.equal(grid.bits[2 * 5 + x], 1);
  assert.ok(countSet(grid) < 25);
});

test('circle size 1 and 2 stay solid -- a disc that small has no meaningful curve', () => {
  assert.equal(countSet(rasterizeMask({ kind: 'circle', size: 1 })), 1);
  assert.equal(countSet(rasterizeMask({ kind: 'circle', size: 2 })), 4);
});

test('rotating four times returns the original grid exactly', () => {
  const src = rasterizeMask({ kind: 'circle', size: 5 });
  let g = src;
  for (let i = 0; i < 4; i++) g = rotateMaskGrid(g, 90);
  assert.deepEqual([...g.bits], [...src.bits]);
});

test('every quarter turn preserves the set-pixel count -- rotation is lossless', () => {
  const src = rasterizeMask({ kind: 'circle', size: 7 });
  const n = countSet(src);
  for (const deg of [0, 90, 180, 270]) {
    assert.equal(countSet(rotateMaskGrid(src, deg)), n, `rotate ${deg}`);
  }
});

test('rotate 90 transposes a known asymmetric grid', () => {
  // 3x3 with only the top-left pixel set.
  const src = { width: 3, height: 3, bits: Uint8Array.from([1,0,0, 0,0,0, 0,0,0]) };
  const r = rotateMaskGrid(src, 90);
  // Top-left goes to top-right under a clockwise quarter turn.
  assert.equal(r.bits[2], 1);
  assert.equal(countSet(r), 1);
});

test('flipping twice on the same axis is the identity', () => {
  const src = rasterizeMask({ kind: 'circle', size: 6 });
  assert.deepEqual([...flipMaskGrid(flipMaskGrid(src, true, false), true, false).bits], [...src.bits]);
  assert.deepEqual([...flipMaskGrid(flipMaskGrid(src, false, true), false, true).bits], [...src.bits]);
});

test('maskGridFor applies the brush rotate and flips together', () => {
  const mask = normalizeBrush({ mask: { kind: 'square', size: 3, rotate: 90, flipH: true } }).mask;
  const grid = maskGridFor(mask, {});
  // A solid square is invariant under both, so the count must be unchanged.
  assert.equal(countSet(grid), 9);
});

test('maskGridFor honors a per-stamp rotation override for rotateJitter', () => {
  const src = { width: 3, height: 3, bits: Uint8Array.from([1,0,0, 0,0,0, 0,0,0]) };
  const mask = { kind: 'custom', bitmap: src, rotate: 0, flipH: false, flipV: false };
  const grid = maskGridFor(mask, { rotate: 180 });
  assert.equal(grid.bits[8], 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-transform.test.mjs`
Expected: FAIL — `rasterizeMask` is not exported.

- [ ] **Step 3: Append the implementation to `js/core/brushes.js`**

```js
// --- mask rasterization and lossless transforms -------------------------
//
// A mask grid is 1-bit: { width, height, bits } where bits[y*width+x] is 0
// or 1. There is deliberately no alpha channel here -- a brush cannot
// produce partial coverage, which is what keeps every stroke pixel-crisp.

function emptyGrid(width, height) {
  return { width, height, bits: new Uint8Array(width * height) };
}

export function rasterizeMask(mask) {
  const size = Math.max(1, Math.min(MAX_MASK_SIZE, mask.size ?? 1));
  if (mask.kind === 'custom') {
    const bmp = mask.bitmap;
    if (!bmp) return emptyGrid(1, 1);
    // A custom mask may arrive as a 1-bit grid already, or as an RGBA bitmap
    // whose opaque pixels define coverage.
    if (bmp.bits) return { width: bmp.width, height: bmp.height, bits: Uint8Array.from(bmp.bits) };
    const grid = emptyGrid(bmp.width, bmp.height);
    for (let i = 0, p = 0; i < grid.bits.length; i++, p += 4) {
      grid.bits[i] = bmp.data[p + 3] > 0 ? 1 : 0;
    }
    return grid;
  }
  const grid = emptyGrid(size, size);
  if (mask.kind === 'square' || size <= 2) {
    grid.bits.fill(1);
    return grid;
  }
  // Disc test against the pixel center, which keeps small odd sizes
  // symmetric and avoids the lopsided discs a corner test produces.
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r, dy = y + 0.5 - r;
      grid.bits[y * size + x] = dx * dx + dy * dy <= r * r ? 1 : 0;
    }
  }
  return grid;
}

// Clockwise quarter turns. Every source pixel lands on exactly one
// destination pixel, so the set-pixel count is invariant.
export function rotateMaskGrid(grid, degrees) {
  const deg = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  if (deg === 0) return { width: grid.width, height: grid.height, bits: Uint8Array.from(grid.bits) };
  const { width: w, height: h, bits } = grid;
  const swapped = deg === 90 || deg === 270;
  const out = emptyGrid(swapped ? h : w, swapped ? w : h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      let nx, ny;
      if (deg === 90) { nx = h - 1 - y; ny = x; }
      else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      out.bits[ny * out.width + nx] = 1;
    }
  }
  return out;
}

export function flipMaskGrid(grid, flipH, flipV) {
  if (!flipH && !flipV) return { width: grid.width, height: grid.height, bits: Uint8Array.from(grid.bits) };
  const { width: w, height: h, bits } = grid;
  const out = emptyGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      const nx = flipH ? w - 1 - x : x;
      const ny = flipV ? h - 1 - y : y;
      out.bits[ny * w + nx] = 1;
    }
  }
  return out;
}

// `options.rotate` is the per-stamp override rotateJitter supplies; it
// composes with the brush's own static rotation.
export function maskGridFor(mask, options = {}) {
  let grid = rasterizeMask(mask);
  const rotate = (mask.rotate ?? 0) + (options.rotate ?? 0);
  grid = rotateMaskGrid(grid, rotate);
  return flipMaskGrid(grid, !!mask.flipH, !!mask.flipV);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brush-transform.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```powershell
git add js/core/brushes.js tests/brush-transform.test.mjs
git commit -m "feat: rasterize brush masks with lossless quarter turns and flips"
```

---

### Task 3: Seeded PRNG and the mask phase — `js/core/brush-stroke.js`

Turns a pointer path into a list of stamp placements, applying spacing, scatter and `rotateJitter`. Every random value derives from `(seed, stampIndex)` so re-rasterizing a prefix of a stroke reproduces it exactly — the property shape-tool previews depend on.

**Files:**
- Create: `js/core/brush-stroke.js`
- Test: `tests/brush-determinism.test.mjs`

**Interfaces:**
- Consumes: `normalizeBrush` (Task 1).
- Produces:
  - `mulberry32(seed) -> () => number` — PRNG in [0,1)
  - `stampRandom(seed, index, salt) -> number` — position-independent random in [0,1)
  - `strokeStamps(points, mask, seed) -> [{ x, y, rotate }]` — the mask phase
  - `newStrokeSeed() -> number`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-determinism.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, stampRandom, strokeStamps } from '../js/core/brush-stroke.js';
import { normalizeBrush } from '../js/core/brushes.js';

const line = (n) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }));

test('mulberry32 is deterministic for a given seed', () => {
  const a = mulberry32(12345), b = mulberry32(12345);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());
});

test('mulberry32 differs across seeds', () => {
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('stampRandom depends only on (seed, index, salt), not call order', () => {
  const forward = [0, 1, 2, 3].map(i => stampRandom(99, i, 'x'));
  const backward = [3, 2, 1, 0].map(i => stampRandom(99, i, 'x')).reverse();
  assert.deepEqual(forward, backward);
});

test('spacing 1 stamps every point', () => {
  const mask = normalizeBrush({ mask: { spacing: 1 } }).mask;
  assert.equal(strokeStamps(line(10), mask, 1).length, 10);
});

test('spacing N stamps every Nth point and always includes the first', () => {
  const mask = normalizeBrush({ mask: { spacing: 3 } }).mask;
  const stamps = strokeStamps(line(10), mask, 1);
  assert.deepEqual(stamps.map(s => s.x), [0, 3, 6, 9]);
});

test('scatter 0 leaves positions exactly on the path', () => {
  const mask = normalizeBrush({ mask: { scatter: 0 } }).mask;
  for (const s of strokeStamps(line(5), mask, 7)) assert.equal(s.y, 0);
});

test('scatter offsets are integers within the radius', () => {
  const mask = normalizeBrush({ mask: { scatter: 3 } }).mask;
  for (const s of strokeStamps(line(40), mask, 7)) {
    assert.equal(Number.isInteger(s.x), true);
    assert.equal(Number.isInteger(s.y), true);
    assert.ok(Math.abs(s.y) <= 3, `y offset ${s.y} exceeds scatter`);
  }
});

test('the same seed reproduces a scattered stroke byte for byte', () => {
  const mask = normalizeBrush({ mask: { scatter: 4, rotateJitter: true } }).mask;
  assert.deepEqual(strokeStamps(line(30), mask, 555), strokeStamps(line(30), mask, 555));
});

test('a different seed produces a different scattered stroke', () => {
  const mask = normalizeBrush({ mask: { scatter: 4 } }).mask;
  assert.notDeepEqual(strokeStamps(line(30), mask, 1), strokeStamps(line(30), mask, 2));
});

test('re-rasterizing a prefix reproduces that prefix exactly -- shape previews depend on this', () => {
  const mask = normalizeBrush({ mask: { scatter: 4, rotateJitter: true } }).mask;
  const full = strokeStamps(line(20), mask, 42);
  const prefix = strokeStamps(line(8), mask, 42);
  assert.deepEqual(prefix, full.slice(0, prefix.length));
});

test('rotateJitter yields only quarter turns', () => {
  const mask = normalizeBrush({ mask: { rotateJitter: true } }).mask;
  for (const s of strokeStamps(line(40), mask, 3)) {
    assert.ok([0, 90, 180, 270].includes(s.rotate), `bad rotate ${s.rotate}`);
  }
});

test('rotateJitter off means every stamp is unrotated', () => {
  const mask = normalizeBrush({ mask: { rotateJitter: false } }).mask;
  for (const s of strokeStamps(line(10), mask, 3)) assert.equal(s.rotate, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-determinism.test.mjs`
Expected: FAIL — cannot find module `../js/core/brush-stroke.js`.

- [ ] **Step 3: Implement `js/core/brush-stroke.js`**

```js
// js/core/brush-stroke.js
// The mask phase: a pointer path becomes a list of stamp placements.
//
// Randomness here is NOT seeded for undo's sake -- strokes commit as
// before/after pixel patches, so undo replays bytes and is already exact.
// It is seeded because shape tools restore and fully re-rasterize on every
// pointer move (drawing-engine.js:360). Without a stable seed a scattered
// line would reshuffle under the cursor on every mouse move.
//
// For that to hold, a stamp's randomness must depend on its INDEX, not on
// how many random numbers have been drawn before it -- otherwise
// re-rasterizing a shorter prefix would produce different offsets.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Position-independent: the same (seed, index, salt) always gives the same
// value, no matter what else has been drawn.
export function stampRandom(seed, index, salt = '') {
  const mixed = (Math.imul(seed >>> 0, 2654435761) ^ Math.imul(index + 1, 40503) ^ hashString(salt)) >>> 0;
  return mulberry32(mixed)();
}

export function newStrokeSeed() {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

const QUARTER_TURNS = [0, 90, 180, 270];

export function strokeStamps(points, mask, seed) {
  const spacing = Math.max(1, mask.spacing ?? 1);
  const scatter = Math.max(0, mask.scatter ?? 0);
  const jitterRotate = !!mask.rotateJitter;
  const stamps = [];
  for (let i = 0; i < points.length; i += spacing) {
    const p = points[i];
    // Index by position along the path, not by push order, so a prefix
    // re-rasterizes identically.
    const index = i;
    let x = p.x, y = p.y;
    if (scatter > 0) {
      const rx = stampRandom(seed, index, 'sx');
      const ry = stampRandom(seed, index, 'sy');
      x += Math.round((rx * 2 - 1) * scatter);
      y += Math.round((ry * 2 - 1) * scatter);
    }
    const rotate = jitterRotate
      ? QUARTER_TURNS[Math.floor(stampRandom(seed, index, 'rot') * 4) % 4]
      : 0;
    stamps.push({ x, y, rotate });
  }
  return stamps;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brush-determinism.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```powershell
git add js/core/brush-stroke.js tests/brush-determinism.test.mjs
git commit -m "feat: add seeded stamp placement for brush strokes"
```

---

### Task 4: Ramp detection — `js/core/ramps.js`

`ramp-shade` stores no colors; it finds the ramp from the pixel under the brush. This task adds the detection rule and the additive `ramps: []` field on the palette.

**Files:**
- Create: `js/core/ramps.js`
- Modify: `js/core/palettes.js` (`normalizePalette`, `createPalette`)
- Test: `tests/ramps.test.mjs`

**Interfaces:**
- Consumes: the palette shape from `js/core/palettes.js`.
- Produces:
  - `detectRamps(palette) -> number[][]` — arrays of palette indices, each a maximal run
  - `rampContaining(palette, rgba) -> number[] | null` — honors named ramps first
  - `stepAlongRamp(palette, rgba, delta) -> rgba | null` — the function `ramp-shade` calls
  - `js/core/palettes.js` gains `palette.ramps: [{ name, indices }]`, defaulting to `[]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/ramps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPalette, normalizePalette } from '../js/core/palettes.js';
import { detectRamps, rampContaining, stepAlongRamp } from '../js/core/ramps.js';

function paletteOf(colors, extra = {}) {
  return normalizePalette({
    id: 'p', name: 'P', indexed: true,
    colors: colors.map(c => [...c, 255]),
    empty: colors.map(() => false),
    ...extra,
  });
}

// A clean 4-step grey ramp followed by a 3-step red ramp.
const GREYS_THEN_REDS = [
  [20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200],
  [60, 10, 10], [140, 30, 30], [220, 60, 60],
];

test('normalizePalette adds an empty ramps array to an old palette', () => {
  const p = normalizePalette({ id: 'x', name: 'X', colors: [[0, 0, 0, 255]] });
  assert.deepEqual(p.ramps, []);
});

test('createPalette starts with no ramps', () => {
  assert.deepEqual(createPalette({ name: 'New' }).ramps, []);
});

test('detectRamps finds maximal monotonic runs', () => {
  const ramps = detectRamps(paletteOf(GREYS_THEN_REDS));
  assert.deepEqual(ramps, [[0, 1, 2, 3], [4, 5, 6]]);
});

test('a hue jump breaks a run even when luminance keeps rising', () => {
  // grey -> grey -> saturated blue: luminance rises throughout, hue does not.
  const ramps = detectRamps(paletteOf([[20, 20, 20], [80, 80, 80], [40, 40, 240]]));
  assert.deepEqual(ramps, [[0, 1]]);
});

test('a luminance reversal breaks a run', () => {
  const ramps = detectRamps(paletteOf([[20, 20, 20], [120, 120, 120], [60, 60, 60]]));
  assert.deepEqual(ramps, [[0, 1]]);
});

test('an empty slot breaks a run', () => {
  const p = paletteOf([[20, 20, 20], [70, 70, 70], [130, 130, 130]]);
  p.empty[1] = true;
  assert.deepEqual(detectRamps(p), []);
});

test('a single isolated entry is not a ramp', () => {
  assert.deepEqual(detectRamps(paletteOf([[10, 10, 10]])), []);
});

test('rampContaining finds the run holding a color', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.deepEqual(rampContaining(p, [130, 130, 130, 255]), [0, 1, 2, 3]);
  assert.deepEqual(rampContaining(p, [140, 30, 30, 255]), [4, 5, 6]);
});

test('rampContaining returns null for a color in no ramp', () => {
  assert.equal(rampContaining(paletteOf([[10, 10, 10]]), [10, 10, 10, 255]), null);
});

test('a named ramp overrides detection', () => {
  const p = paletteOf(GREYS_THEN_REDS, { ramps: [{ name: 'custom', indices: [0, 4, 6] }] });
  assert.deepEqual(rampContaining(p, [20, 20, 20, 255], 'custom'), [0, 4, 6]);
});

test('stepAlongRamp moves one entry toward light and never interpolates', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.deepEqual(stepAlongRamp(p, [70, 70, 70, 255], 1), [130, 130, 130, 255]);
  assert.deepEqual(stepAlongRamp(p, [130, 130, 130, 255], -1), [70, 70, 70, 255]);
});

test('stepAlongRamp clamps at both ends rather than wrapping', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.deepEqual(stepAlongRamp(p, [200, 200, 200, 255], 1), [200, 200, 200, 255]);
  assert.deepEqual(stepAlongRamp(p, [20, 20, 20, 255], -1), [20, 20, 20, 255]);
});

test('stepAlongRamp returns null for a color in no ramp -- it does not guess', () => {
  assert.equal(stepAlongRamp(paletteOf([[10, 10, 10]]), [10, 10, 10, 255], 1), null);
});

test('stepAlongRamp preserves the source alpha', () => {
  const p = paletteOf(GREYS_THEN_REDS);
  assert.equal(stepAlongRamp(p, [70, 70, 70, 128], 1)[3], 128);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ramps.test.mjs`
Expected: FAIL — cannot find module `../js/core/ramps.js`.

- [ ] **Step 3: Add `ramps` to the palette shape**

In `js/core/palettes.js`, inside `normalizePalette`, add to the returned object:

```js
    ramps: Array.isArray(raw.ramps)
      ? raw.ramps
          .filter(r => r && typeof r.name === 'string' && Array.isArray(r.indices))
          .map(r => ({ name: r.name, indices: r.indices.filter(Number.isInteger) }))
      : [],
```

In `createPalette`, add `ramps: []` to the object it returns.

- [ ] **Step 4: Implement `js/core/ramps.js`**

```js
// js/core/ramps.js
// Ramp detection over a palette. Pure; no DOM.
//
// A ramp is a maximal run of CONTIGUOUS palette indices where luminance is
// strictly monotonic and adjacent hues stay close. That matches how artists
// actually author palettes -- ramps as contiguous blocks -- and it means a
// shade brush needs to store nothing at all: it re-detects the ramp from the
// pixel under the cursor, so one brush works in every project.

const HUE_TOLERANCE = 45;

export function luminance(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function hue(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // achromatic: matches any hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueClose(a, b) {
  const ha = hue(a), hb = hue(b);
  if (ha === null || hb === null) return true; // greys join any ramp
  const d = Math.abs(ha - hb);
  return Math.min(d, 360 - d) <= HUE_TOLERANCE;
}

// Adjacent entries continue a run when luminance keeps moving the same way
// and the hue has not jumped.
function continues(palette, i, direction) {
  if (palette.empty[i] || palette.empty[i - 1]) return false;
  const prev = palette.colors[i - 1], cur = palette.colors[i];
  const delta = luminance(cur) - luminance(prev);
  if (delta === 0) return false;
  if (direction !== 0 && Math.sign(delta) !== direction) return false;
  return hueClose(prev, cur);
}

export function detectRamps(palette) {
  const ramps = [];
  const n = palette.colors.length;
  let start = 0, direction = 0;
  for (let i = 1; i <= n; i++) {
    const ok = i < n && continues(palette, i, direction);
    if (ok) {
      if (direction === 0) {
        direction = Math.sign(luminance(palette.colors[i]) - luminance(palette.colors[i - 1]));
      }
      continue;
    }
    // A ramp needs at least two entries; a lone color is not a ramp.
    if (i - start >= 2) ramps.push(Array.from({ length: i - start }, (_, k) => start + k));
    start = i;
    direction = 0;
  }
  return ramps;
}

function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function rampContaining(palette, rgba, rampName = null) {
  if (rampName) {
    const named = (palette.ramps ?? []).find(r => r.name === rampName);
    if (named) return named.indices;
  }
  for (const ramp of detectRamps(palette)) {
    if (ramp.some(i => sameColor(palette.colors[i], rgba))) return ramp;
  }
  return null;
}

// Moves BETWEEN existing palette entries. It never interpolates, so a ramp
// of four entries has exactly four reachable values.
export function stepAlongRamp(palette, rgba, delta, rampName = null) {
  const ramp = rampContaining(palette, rgba, rampName);
  if (!ramp) return null;
  const at = ramp.findIndex(i => sameColor(palette.colors[i], rgba));
  if (at === -1) return null;
  const next = Math.max(0, Math.min(ramp.length - 1, at + delta));
  const c = palette.colors[ramp[next]];
  return [c[0], c[1], c[2], rgba[3]];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/ramps.test.mjs tests/palettes.test.mjs`
Expected: PASS. The existing palette tests must still pass — `ramps` is additive.

- [ ] **Step 6: Commit**

```powershell
git add js/core/ramps.js js/core/palettes.js tests/ramps.test.mjs
git commit -m "feat: detect palette ramps for shade inks"
```

---

### Task 5: Dither patterns and opacity density — `js/core/dither.js`

Opacity is a threshold pattern, not alpha blending, so it cannot invent colors. Patterns are indexed by **bitmap** coordinates so separate strokes across one region line up.

**Files:**
- Create: `js/core/dither.js`
- Test: `tests/dither.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BAYER4: number[][]` — the 4×4 matrix, values 0..15
  - `PATTERNS: Record<string, {width, height, cells}>` — `bayer4`, `checker`, `dots25`, `lines`
  - `opacityLevel(opacity) -> number` — snaps 0..100 to one of 17 levels
  - `passesOpacity(x, y, opacity) -> boolean` — the density test
  - `patternPicksSecondary(patternName, x, y) -> boolean`

- [ ] **Step 1: Write the failing tests**

```js
// tests/dither.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BAYER4, PATTERNS, opacityLevel, passesOpacity, patternPicksSecondary } from '../js/core/dither.js';

test('BAYER4 holds every value 0..15 exactly once', () => {
  const seen = BAYER4.flat().sort((a, b) => a - b);
  assert.deepEqual(seen, Array.from({ length: 16 }, (_, i) => i));
});

test('opacity 100 always passes and opacity 0 never does', () => {
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.equal(passesOpacity(x, y, 100), true);
    assert.equal(passesOpacity(x, y, 0), false);
  }
});

test('opacity 50 passes for exactly half of a 4x4 cell', () => {
  let n = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (passesOpacity(x, y, 50)) n++;
  assert.equal(n, 8);
});

test('opacity 25 passes for a quarter of a 4x4 cell', () => {
  let n = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (passesOpacity(x, y, 25)) n++;
  assert.equal(n, 4);
});

test('opacity snaps to 17 levels -- 30 and 31 are indistinguishable', () => {
  assert.equal(opacityLevel(30), opacityLevel(31));
  assert.equal(opacityLevel(0), 0);
  assert.equal(opacityLevel(100), 16);
});

test('the pattern is anchored to bitmap coordinates, so it tiles globally', () => {
  // Same result at (x, y) and (x+4, y+4): two strokes over one region align.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.equal(passesOpacity(x, y, 50), passesOpacity(x + 4, y + 4, 50));
    assert.equal(passesOpacity(x, y, 50), passesOpacity(x + 40, y + 80, 50));
  }
});

test('negative coordinates still tile correctly', () => {
  assert.equal(passesOpacity(-4, -4, 50), passesOpacity(0, 0, 50));
  assert.equal(passesOpacity(-1, -1, 50), passesOpacity(3, 3, 50));
});

test('checker pattern alternates every pixel', () => {
  assert.notEqual(patternPicksSecondary('checker', 0, 0), patternPicksSecondary('checker', 1, 0));
  assert.equal(patternPicksSecondary('checker', 0, 0), patternPicksSecondary('checker', 2, 0));
});

test('every named pattern exists and has non-zero dimensions', () => {
  for (const [name, p] of Object.entries(PATTERNS)) {
    assert.ok(p.width > 0 && p.height > 0, name);
    assert.equal(p.cells.length, p.width * p.height, name);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/dither.test.mjs`
Expected: FAIL — cannot find module `../js/core/dither.js`.

- [ ] **Step 3: Implement `js/core/dither.js`**

```js
// js/core/dither.js
// Threshold patterns. Pure; no DOM.
//
// Opacity here is DENSITY, not alpha. Blending 50% of one palette color over
// another invents a third color that is not in the palette; writing through a
// 50% threshold pattern reads as translucent while every written pixel stays
// a real palette entry. This is how pre-alpha paint programs did translucency
// on indexed hardware.
//
// Patterns index by BITMAP coordinates, never by stroke-local ones, so two
// separate strokes across one region produce a continuous, aligned dither.

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// A 4x4 matrix admits 17 distinct densities (0..16 cells lit), so the 0..100
// slider cannot express more than that. Snapping here makes the limit
// explicit rather than letting 30 and 31 silently render the same.
export function opacityLevel(opacity) {
  const o = Math.max(0, Math.min(100, Number(opacity) || 0));
  return Math.round((o / 100) * 16);
}

function wrap(v, n) {
  return ((v % n) + n) % n;
}

export function passesOpacity(x, y, opacity) {
  const level = opacityLevel(opacity);
  if (level >= 16) return true;
  if (level <= 0) return false;
  return BAYER4[wrap(y, 4)][wrap(x, 4)] < level;
}

export const PATTERNS = {
  bayer4: { width: 4, height: 4, cells: BAYER4.flat().map(v => (v < 8 ? 0 : 1)) },
  checker: { width: 2, height: 2, cells: [0, 1, 1, 0] },
  dots25: { width: 4, height: 4, cells: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1] },
  lines: { width: 2, height: 2, cells: [0, 0, 1, 1] },
};

export function patternPicksSecondary(patternName, x, y) {
  const p = PATTERNS[patternName] ?? PATTERNS.bayer4;
  return p.cells[wrap(y, p.height) * p.width + wrap(x, p.width)] === 1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/dither.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```powershell
git add js/core/dither.js tests/dither.test.mjs
git commit -m "feat: add dither patterns and opacity-as-density"
```

---

### Task 6: The inks — `js/core/brush-ink.js`

Six inks as per-stroke objects. An ink is created at pointer-down and lives for the stroke, because `jitter` needs the stroke seed and `ramp-shade` needs to know which pixels it has already stepped.

**Files:**
- Create: `js/core/brush-ink.js`
- Test: `tests/brush-ink.test.mjs`

**Interfaces:**
- Consumes: `stepAlongRamp` (Task 4), `passesOpacity` / `patternPicksSecondary` (Task 5), `stampRandom` (Task 3).
- Produces:
  - `makeInk(brush, context) -> { write(bitmap, x, y) }` where `context` is
    `{ primary, secondary, palette, seed, alt, pressure }`
  - `applyPaletteClosure(palette, rgba) -> rgba`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-ink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { normalizePalette } from '../js/core/palettes.js';
import { normalizeBrush } from '../js/core/brushes.js';
import { makeInk, applyPaletteClosure } from '../js/core/brush-ink.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

function greyPalette() {
  const colors = [[20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200]].map(c => [...c, 255]);
  return normalizePalette({ id: 'p', name: 'P', indexed: true, colors, empty: colors.map(() => false) });
}

function ctx(extra = {}) {
  return { primary: RED, secondary: BLUE, palette: null, seed: 1, alt: false, pressure: 1, ...extra };
}

test('solid ink writes the primary color', () => {
  const bmp = createBitmap(4, 4);
  makeInk(normalizeBrush({}), ctx()).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED);
});

test('solid ink at opacity 0 writes nothing', () => {
  const bmp = createBitmap(4, 4);
  makeInk(normalizeBrush({ ink: { opacity: 0 } }), ctx()).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], CLEAR);
});

test('opacity 50 writes about half the pixels of a filled area', () => {
  const bmp = createBitmap(8, 8);
  const ink = makeInk(normalizeBrush({ ink: { opacity: 50 } }), ctx());
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
  let n = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (getPixel(bmp, x, y)[3] > 0) n++;
  assert.equal(n, 32);
});

test('lock-alpha ink leaves transparent pixels untouched', () => {
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, BLUE);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'lock-alpha' } }), ctx());
  ink.write(bmp, 1, 1);
  ink.write(bmp, 2, 2);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED, 'existing pixel repainted');
  assert.deepEqual([...getPixel(bmp, 2, 2)], CLEAR, 'transparent pixel untouched');
});

test('replace ink writes only over its target color', () => {
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, BLUE);
  setPixel(bmp, 2, 2, [9, 9, 9, 255]);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'replace', replaceColor: BLUE } }), ctx());
  ink.write(bmp, 1, 1);
  ink.write(bmp, 2, 2);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED);
  assert.deepEqual([...getPixel(bmp, 2, 2)], [9, 9, 9, 255]);
});

test('dither ink writes primary and secondary, never a blend', () => {
  const bmp = createBitmap(8, 8);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'dither', pattern: 'checker' } }), ctx());
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = [...getPixel(bmp, x, y)];
    assert.ok(
      p.every((v, i) => v === RED[i]) || p.every((v, i) => v === BLUE[i]),
      `pixel ${x},${y} is neither primary nor secondary: ${p}`,
    );
  }
});

test('ramp-shade steps the destination pixel one entry toward light', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [70, 70, 70, 255]);
  makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [130, 130, 130, 255]);
});

test('ramp-shade with alt steps toward dark', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [130, 130, 130, 255]);
  makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette, alt: true })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [70, 70, 70, 255]);
});

test('ramp-shade steps a pixel ONCE per stroke however many times it is written', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [20, 20, 20, 255]);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette }));
  for (let i = 0; i < 10; i++) ink.write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [70, 70, 70, 255], 'ran up the ramp');
});

test('ramp-shade leaves a color that belongs to no ramp alone', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [1, 2, 3, 255]);
  makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [1, 2, 3, 255]);
});

test('applyPaletteClosure snaps to a palette entry for an indexed palette', () => {
  const palette = greyPalette();
  assert.deepEqual(applyPaletteClosure(palette, [75, 75, 75, 255]), [70, 70, 70, 255]);
});

test('applyPaletteClosure leaves a non-indexed palette alone', () => {
  const palette = greyPalette();
  palette.indexed = false;
  assert.deepEqual(applyPaletteClosure(palette, [75, 75, 75, 255]), [75, 75, 75, 255]);
});

test('PALETTE CLOSURE INVARIANT: no ink ever writes a color outside an indexed palette', () => {
  const palette = greyPalette();
  const entries = palette.colors.map(c => `${c[0]},${c[1]},${c[2]}`);
  for (const kind of ['solid', 'ramp-shade', 'dither', 'lock-alpha']) {
    for (const opacity of [100, 75, 50, 25]) {
      const bmp = createBitmap(8, 8);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        setPixel(bmp, x, y, palette.colors[(x + y) % palette.colors.length]);
      }
      const brush = normalizeBrush({ ink: { kind, opacity } });
      const ink = makeInk(brush, ctx({ palette, primary: [77, 77, 77, 255], secondary: [199, 199, 199, 255] }));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const p = getPixel(bmp, x, y);
        if (p[3] === 0) continue;
        assert.ok(entries.includes(`${p[0]},${p[1]},${p[2]}`),
          `${kind}@${opacity} wrote off-palette ${p} at ${x},${y}`);
      }
    }
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-ink.test.mjs`
Expected: FAIL — cannot find module `../js/core/brush-ink.js`.

- [ ] **Step 3: Implement `js/core/brush-ink.js`**

```js
// js/core/brush-ink.js
// The inks. Pure; no DOM.
//
// An ink is created PER STROKE, not per pixel, because two behaviors need
// stroke-lifetime state:
//   - ramp-shade must step a pixel exactly once per stroke, or dragging back
//     and forth over one pixel would run it up the whole ramp;
//   - jitter draws from the stroke seed.

import { getPixel, setPixel } from './pixels.js';
import { nearestColor } from './palettes.js';
import { stepAlongRamp } from './ramps.js';
import { passesOpacity, patternPicksSecondary } from './dither.js';
import { stampRandom } from './brush-stroke.js';

// The retro guarantee, in one place: when the palette is indexed, every value
// an ink writes is snapped to a real palette entry.
export function applyPaletteClosure(palette, rgba) {
  if (!palette || !palette.indexed) return rgba;
  return nearestColor(palette, rgba);
}

export function makeInk(brush, context) {
  const { kind, opacity, jitter, pattern, rampName, replaceColor } = brush.ink;
  const { primary, secondary, palette, seed, alt } = context;
  // Pixels this stroke has already inked, keyed "x,y". This is what makes a
  // stroke idempotent per pixel.
  const touched = new Set();
  let writeIndex = 0;

  function commit(bitmap, x, y, rgba) {
    setPixel(bitmap, x, y, applyPaletteClosure(palette, rgba));
  }

  return {
    write(bitmap, x, y) {
      const key = `${x},${y}`;
      if (touched.has(key)) return;
      touched.add(key);
      const index = writeIndex++;

      // Opacity is density: the pattern is indexed by bitmap coordinates so
      // separate strokes over one region stay aligned.
      if (!brush.ink.trueAlpha && !passesOpacity(x, y, opacity)) return;

      const dest = getPixel(bitmap, x, y);
      if (!dest) return;

      switch (kind) {
        case 'lock-alpha':
          if (dest[3] === 0) return;
          commit(bitmap, x, y, [primary[0], primary[1], primary[2], dest[3]]);
          return;

        case 'replace':
          if (!replaceColor) return;
          if (dest[0] !== replaceColor[0] || dest[1] !== replaceColor[1] || dest[2] !== replaceColor[2]) return;
          commit(bitmap, x, y, primary);
          return;

        case 'dither':
          commit(bitmap, x, y, patternPicksSecondary(pattern, x, y) ? secondary : primary);
          return;

        case 'ramp-shade': {
          if (!palette) return;
          let delta = alt ? -1 : 1;
          if (jitter > 0) {
            const r = stampRandom(seed, index, 'jit');
            delta += Math.round((r * 2 - 1) * jitter);
          }
          if (delta === 0) return;
          const stepped = stepAlongRamp(palette, dest, delta, rampName);
          // A color in no ramp is left alone rather than guessed at.
          if (!stepped) return;
          setPixel(bitmap, x, y, stepped);
          return;
        }

        case 'stamp':
          // Handled by the stroke layer, which knows the mask's color
          // payload; falls back to solid if it reaches here.
          commit(bitmap, x, y, primary);
          return;

        case 'solid':
        default:
          commit(bitmap, x, y, primary);
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brush-ink.test.mjs`
Expected: PASS, 13 tests — including the palette-closure invariant.

- [ ] **Step 5: Commit**

```powershell
git add js/core/brush-ink.js tests/brush-ink.test.mjs
git commit -m "feat: add the six brush inks with palette closure"
```

---

### Task 7: Pressure mapping — `js/core/brushes.js`

Pure pressure→value mapping. Kept separate from the input plumbing (Task 10) so the curve maths and the pen-only guard are testable without a DOM.

**Files:**
- Modify: `js/core/brushes.js` (append)
- Test: `tests/brush-pressure.test.mjs`

**Interfaces:**
- Consumes: `normalizeBrush`, `MAX_MASK_SIZE` (Task 1).
- Produces:
  - `applyCurve(t, curve) -> number` — maps 0..1 to 0..1
  - `pressureValue(brush, pressure, pointerType) -> number | null` — `null` means "pressure does not apply", so the caller uses the brush's static value
  - `effectiveMaskSize(brush, pressure, pointerType) -> number` — always an integer

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-pressure.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush, applyCurve, pressureValue, effectiveMaskSize } from '../js/core/brushes.js';

const sizeBrush = (extra = {}) => normalizeBrush({
  mask: { kind: 'square', size: 4 },
  pressure: { target: 'size', min: 1, max: 9, curve: 'linear', ...extra },
});

test('applyCurve is identity at the endpoints for every curve', () => {
  for (const curve of ['linear', 'soft', 'hard']) {
    assert.equal(applyCurve(0, curve), 0, curve);
    assert.equal(applyCurve(1, curve), 1, curve);
  }
});

test('soft gives less output at low pressure than linear; hard gives more', () => {
  assert.ok(applyCurve(0.3, 'soft') < applyCurve(0.3, 'linear'));
  assert.ok(applyCurve(0.3, 'hard') > applyCurve(0.3, 'linear'));
});

test('pressure is IGNORED for a mouse -- a mouse reports a constant 0.5', () => {
  assert.equal(pressureValue(sizeBrush(), 0.5, 'mouse'), null);
  assert.equal(pressureValue(sizeBrush(), 1.0, 'mouse'), null);
});

test('pressure is ignored for touch', () => {
  assert.equal(pressureValue(sizeBrush(), 0.7, 'touch'), null);
});

test('pressure applies for a pen', () => {
  assert.equal(typeof pressureValue(sizeBrush(), 0.5, 'pen'), 'number');
});

test('target none ignores pressure even for a pen', () => {
  const b = normalizeBrush({ pressure: { target: 'none' } });
  assert.equal(pressureValue(b, 0.9, 'pen'), null);
});

test('pressure maps across the full min..max range', () => {
  assert.equal(pressureValue(sizeBrush(), 0, 'pen'), 1);
  assert.equal(pressureValue(sizeBrush(), 1, 'pen'), 9);
});

test('every pressure output is an integer -- no fractional brush sizes', () => {
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = pressureValue(sizeBrush(), p, 'pen');
    assert.equal(Number.isInteger(v), true, `pressure ${p} gave ${v}`);
  }
});

test('effectiveMaskSize falls back to the static size without a pen', () => {
  assert.equal(effectiveMaskSize(sizeBrush(), 0.9, 'mouse'), 4);
});

test('effectiveMaskSize uses pressure with a pen and stays within 1..16', () => {
  assert.equal(effectiveMaskSize(sizeBrush(), 1, 'pen'), 9);
  assert.equal(effectiveMaskSize(sizeBrush({ max: 99 }), 1, 'pen'), 16);
  assert.equal(effectiveMaskSize(sizeBrush({ min: 0 }), 0, 'pen'), 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-pressure.test.mjs`
Expected: FAIL — `applyCurve` is not exported.

- [ ] **Step 3: Append the implementation to `js/core/brushes.js`**

```js
// --- pressure -----------------------------------------------------------
//
// Pressure is honored ONLY for a pen. A mouse reports a constant pressure of
// 0.5 (or 1.0 while a button is held) and touch reports wildly inconsistent
// values across devices, so without this guard every mouse user would get a
// brush behaving as though it were held at half pressure forever.

export function applyCurve(t, curve) {
  const x = Math.max(0, Math.min(1, t));
  if (curve === 'soft') return x * x;
  if (curve === 'hard') return 1 - (1 - x) * (1 - x);
  return x;
}

export function pressureValue(brush, pressure, pointerType) {
  const p = brush.pressure;
  if (!p || p.target === 'none') return null;
  if (pointerType !== 'pen') return null;
  const t = applyCurve(Number(pressure) || 0, p.curve);
  // Every target quantizes: no fractional sizes, no continuous opacity.
  return Math.round(p.min + (p.max - p.min) * t);
}

export function effectiveMaskSize(brush, pressure, pointerType) {
  if (brush.pressure.target !== 'size') return brush.mask.size;
  const v = pressureValue(brush, pressure, pointerType);
  if (v === null) return brush.mask.size;
  return Math.max(1, Math.min(MAX_MASK_SIZE, v));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brush-pressure.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```powershell
git add js/core/brushes.js tests/brush-pressure.test.mjs
git commit -m "feat: map pen pressure to quantized brush values"
```

---

### Task 8: Ink hook in `js/core/pixels.js`

Additive only. Every primitive gains an optional trailing `ink`; when it is absent the primitive behaves exactly as it does today, so the compositing caller at `model.js:327` and the snapping callers at `pixelSnapper.js:455-484` are untouched.

**Files:**
- Modify: `js/core/pixels.js`
- Test: `tests/pixels-ink.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stamp(bmp, x, y, rgba, size, ink, grid)` — exported now, mask-grid aware
  - `drawLine(bmp, x0, y0, x1, y1, rgba, size, ink, grid)`
  - `drawRect(bmp, x0, y0, x1, y1, rgba, filled, ink)`
  - `drawEllipse(bmp, x0, y0, x1, y1, rgba, filled, ink)`
  - `floodFill(bmp, x, y, rgba, contiguous, ink)`
  - An `ink` is any object with `write(bitmap, x, y)`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/pixels-ink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, getPixel, setPixel, drawLine, drawRect, drawEllipse, floodFill } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];

// A recording ink that writes green and logs every coordinate it is given.
function spyInk() {
  const seen = [];
  return { seen, write(bmp, x, y) { seen.push(`${x},${y}`); setPixel(bmp, x, y, GREEN); } };
}

test('drawLine without an ink behaves exactly as before', () => {
  const bmp = createBitmap(8, 8);
  drawLine(bmp, 0, 0, 3, 0, RED, 1);
  for (let x = 0; x <= 3; x++) assert.deepEqual([...getPixel(bmp, x, 0)], RED);
});

test('drawLine routes every write through the ink when given one', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawLine(bmp, 0, 0, 3, 0, RED, 1, ink);
  assert.deepEqual(ink.seen, ['0,0', '1,0', '2,0', '3,0']);
  assert.deepEqual([...getPixel(bmp, 2, 0)], GREEN);
});

test('drawRect routes through the ink -- this is what makes dithered shapes work', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawRect(bmp, 0, 0, 2, 2, RED, false, ink);
  assert.ok(ink.seen.includes('0,0'));
  assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN);
});

test('drawEllipse routes through the ink', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawEllipse(bmp, 0, 0, 4, 4, RED, true, ink);
  assert.ok(ink.seen.length > 0);
});

test('floodFill routes through the ink -- this is DITHER FILL', () => {
  const bmp = createBitmap(4, 4);
  const ink = spyInk();
  floodFill(bmp, 0, 0, RED, true, ink);
  assert.equal(ink.seen.length, 16, 'every pixel of an empty bitmap');
  assert.deepEqual([...getPixel(bmp, 3, 3)], GREEN);
});

test('floodFill without an ink still fills with the plain color', () => {
  const bmp = createBitmap(4, 4);
  floodFill(bmp, 0, 0, RED, true);
  assert.deepEqual([...getPixel(bmp, 3, 3)], RED);
});

test('stamp honors a 1-bit mask grid, skipping uncovered cells', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  // 3x3 grid with only the center set.
  const grid = { width: 3, height: 3, bits: Uint8Array.from([0,0,0, 0,1,0, 0,0,0]) };
  drawLine(bmp, 4, 4, 4, 4, RED, 3, ink, grid);
  assert.deepEqual(ink.seen, ['4,4']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/pixels-ink.test.mjs`
Expected: FAIL — the ink argument is ignored, so `ink.seen` is empty.

- [ ] **Step 3: Modify `js/core/pixels.js`**

Replace the private `stamp` with an exported, mask-aware version, and thread an optional `ink` through the primitives. The pattern for every primitive is the same: replace each direct `setPixel(bmp, x, y, rgba)` with a `put` helper.

```js
// A write goes through the ink when one is supplied, and straight to the
// bitmap otherwise. Keeping the fallback here means every existing caller --
// layer compositing in model.js, snapping in pixelSnapper.js -- is unchanged.
function put(bmp, x, y, rgba, ink) {
  if (ink) ink.write(bmp, x, y);
  else setPixel(bmp, x, y, rgba);
}

// `grid` is an optional 1-bit mask ({width,height,bits}); without one the
// stamp is a filled `size` x `size` square, which is the historical shape.
// Masks anchor on their CENTER so the cursor sits in the middle of the brush.
export function stamp(bmp, x, y, rgba, size, ink, grid) {
  if (grid) {
    const halfX = (grid.width - 1) >> 1, halfY = (grid.height - 1) >> 1;
    for (let gy = 0; gy < grid.height; gy++)
      for (let gx = 0; gx < grid.width; gx++)
        if (grid.bits[gy * grid.width + gx]) put(bmp, x + gx - halfX, y + gy - halfY, rgba, ink);
    return;
  }
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) put(bmp, x + dx, y + dy, rgba, ink);
}

export function drawLine(bmp, x0, y0, x1, y1, rgba, size = 1, ink = null, grid = null) {
  // ... unchanged Bresenham, but the stamp call becomes:
  //   stamp(bmp, x0, y0, rgba, size, ink, grid);
}
```

Apply the same change to `drawRect(bmp, x0, y0, x1, y1, rgba, filled, ink = null)`, `drawEllipse(..., ink = null)`, `floodFill(bmp, x, y, rgba, contiguous = true, ink = null)` and `softFloodFill`, replacing their internal `setPixel` calls with `put(..., ink)`.

**Note on anchoring:** this changes a masked stamp to anchor on its center. The unmasked `size` path keeps its historical top-left anchoring, so no existing behavior moves until a brush supplies a grid.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/pixels-ink.test.mjs tests/pixels.test.mjs tests/model.test.mjs`
Expected: PASS. The existing pixel and model tests must be unaffected.

- [ ] **Step 5: Commit**

```powershell
git add js/core/pixels.js tests/pixels-ink.test.mjs
git commit -m "feat: add optional ink hook to drawing primitives"
```

---

### Task 9: Drawing-engine integration and the scatter overflow fix

Wires the mask phase and ink pass into real strokes, and widens the overflow bounds that scatter invalidates.

**Files:**
- Modify: `js/components/canvas/drawing-engine.js:283-373`, and the comment at `:179-183`
- Modify: `js/core/brush-stroke.js` (add `strokeBounds`)
- Test: `tests/brush-overflow.test.mjs`

**Interfaces:**
- Consumes: `maskGridFor`, `effectiveMaskSize` (Tasks 2, 7); `strokeStamps`, `newStrokeSeed` (Task 3); `makeInk` (Task 6).
- Produces: `strokeBounds(x, y, gridW, gridH, scatter) -> {x0,y0,x1,y1}` exported from `js/core/brush-stroke.js`.

**The bug this fixes.** `maskOutsideTarget` is the safety net that restores pixels written outside the target rect. Its comment at `drawing-engine.js:180-182` records the current assumption verbatim: *"brush stamps overflow up to brushSize-1 px past a clamped coordinate."* Scatter invalidates that bound in **both** directions — a scattered stamp can land `scatter` px to the left of and above the path, not only right and below. Every step-bound computation must widen accordingly, or a scattered stroke bleeds outside the frame or tile being edited.

- [ ] **Step 1: Write the failing test**

```js
// tests/brush-overflow.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { strokeBounds, strokeStamps } from '../js/core/brush-stroke.js';
import { normalizeBrush } from '../js/core/brushes.js';

test('strokeBounds covers a centered mask with no scatter', () => {
  assert.deepEqual(strokeBounds(10, 10, 3, 3, 0), { x0: 9, y0: 9, x1: 11, y1: 11 });
});

test('strokeBounds widens in BOTH directions for scatter -- not just right and down', () => {
  const b = strokeBounds(10, 10, 3, 3, 4);
  assert.equal(b.x0, 5, 'left edge must account for negative scatter');
  assert.equal(b.y0, 5, 'top edge must account for negative scatter');
  assert.equal(b.x1, 15);
  assert.equal(b.y1, 15);
});

test('a size-1 mask with no scatter bounds exactly one pixel', () => {
  assert.deepEqual(strokeBounds(7, 9, 1, 1, 0), { x0: 7, y0: 9, x1: 7, y1: 9 });
});

test('every scattered stamp stays within the scatter radius of its path point', () => {
  const mask = normalizeBrush({ mask: { kind: 'square', size: 3, scatter: 5 } }).mask;
  const points = Array.from({ length: 50 }, (_, i) => ({ x: 20 + i, y: 20 }));
  for (const s of strokeStamps(points, mask, 1234)) {
    assert.ok(Math.abs(s.y - 20) <= 5, `stamp escaped scatter radius: ${s.y}`);
  }
});

test('bounds computed from strokeBounds contain every stamped mask pixel', () => {
  const mask = normalizeBrush({ mask: { kind: 'square', size: 3, scatter: 4 } }).mask;
  const points = [{ x: 30, y: 30 }];
  for (const s of strokeStamps(points, mask, 99)) {
    const b = strokeBounds(points[0].x, points[0].y, 3, 3, 4);
    const stampBox = strokeBounds(s.x, s.y, 3, 3, 0);
    assert.ok(stampBox.x0 >= b.x0 && stampBox.x1 <= b.x1, 'x outside declared bounds');
    assert.ok(stampBox.y0 >= b.y0 && stampBox.y1 <= b.y1, 'y outside declared bounds');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/brush-overflow.test.mjs`
Expected: FAIL — `strokeBounds` is not exported.

- [ ] **Step 3: Add `strokeBounds` to `js/core/brush-stroke.js`**

```js
// Bounds for one stamp, used for both the dirty rect and the
// maskOutsideTarget safety net.
//
// Scatter widens the box in BOTH directions: a scattered stamp can land to
// the left of and above its path point as easily as right and below. The old
// `brushSize - 1` bound only ever extended right and down, which is exactly
// why it cannot simply be reused here.
export function strokeBounds(x, y, gridW, gridH, scatter = 0) {
  const halfX = (gridW - 1) >> 1, halfY = (gridH - 1) >> 1;
  return {
    x0: x - halfX - scatter,
    y0: y - halfY - scatter,
    x1: x + (gridW - 1 - halfX) + scatter,
    y1: y + (gridH - 1 - halfY) + scatter,
  };
}
```

- [ ] **Step 4: Rewrite the paint branches in `drawing-engine.js`**

At stroke start, capture the seed and build the ink once:

```js
stroke.seed = newStrokeSeed();
stroke.ink = makeInk(activeBrush(), {
  primary: color, secondary: drawingSettings().secondary,
  palette: activePalette(), seed: stroke.seed, alt: ev.altKey,
  pressure: ev.pressure, pointerType: ev.pointerType,
});
```

Replace each of the five `brushSize` bound computations at lines 318-366. The freehand branch becomes:

```js
const brush = activeBrush();
const size = effectiveMaskSize(brush, ev.pressure, ev.pointerType);
for (const s of strokeStamps([p], brush.mask, stroke.seed)) {
  const g = maskGridFor({ ...brush.mask, size }, { rotate: s.rotate });
  stamp(layer.bitmap, s.x, s.y, color, size, stroke.ink, g);
  const b = strokeBounds(s.x, s.y, g.width, g.height, brush.mask.scatter);
  maskOutsideTarget(layer.bitmap, before, b.x0, b.y0, b.x1, b.y1, target);
  stroke.dirty = extend(stroke.dirty, b.x0, b.y0, b.x1, b.y1);
}
```

Update the comment at lines 180-182 to record the new bound:

```js
  // Catches writes that coordinate clamping alone cannot prevent (brush
  // stamps overflow up to (maskSize - 1)/2 + scatter px in EVERY direction
  // past a clamped coordinate -- scatter reaches left and up as well as
  // right and down; select-move can drag content past the target edge).
```

For the shape branches, the ink is rebuilt on each re-rasterization because `blitRegion` restores the layer first — but the **seed is not**, which is what keeps the preview stable:

```js
blitRegion(layer.bitmap, before, 0, 0);
stroke.ink = makeInk(brush, { ...inkContext, seed: stroke.seed });
drawRect(layer.bitmap, a.x, a.y, p.x, p.y, color, stroke.fill, stroke.ink);
```

Route `floodFill` and `softFloodFill` through the ink too — this is what makes dither fill work:

```js
const r = floodFill(sub, ev.x - t.x, ev.y - t.y, color, toolOptions.contiguous, strokeInk());
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/brush-overflow.test.mjs tests/pixels-ink.test.mjs`
Expected: PASS.

- [ ] **Step 6: Manual check in the browser**

Start the server with `./serve.ps1` — never `python -m http.server`, which sends no cache-control headers and causes stale-module phantom bugs. Load with `?autotest` so `beforeunload`/`confirm` modals do not stall. Paint with a scattered brush at the extreme edge of a frame in sprites mode and confirm nothing bleeds into the neighbouring frame.

- [ ] **Step 7: Commit**

```powershell
git add js/components/canvas/drawing-engine.js js/core/brush-stroke.js tests/brush-overflow.test.mjs
git commit -m "feat: paint through the brush engine and widen scatter bounds"
```

---

### Task 10: Store migration, pressure plumbing and tool-palette wiring

Replaces `brushSize` with the full brush, and stops `canvas-view.js` discarding pressure.

**Files:**
- Modify: `js/host/editor-store.js:22-28`
- Modify: `js/components/canvas/canvas-view.js` (`_onPointerDown`, `_onPointerMove`, `_onPointerUp`)
- Modify: `js/components/tool-palette.js:122-137,231,256`
- Modify: `js/features/workbench/editor-workbench.js:41-44`
- Test: `tests/brush-migration.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_BRUSH`, `normalizeBrush` (Task 1).
- Produces:
  - `workspace.drawing.brush` — the resolved active brush; `brushSize` is gone
  - `migrateDrawingSettings(raw) -> drawing` exported from `js/host/editor-store.js`
  - `onPointer` payload gains `pressure` and `pointerType`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-migration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorState, migrateDrawingSettings } from '../js/host/editor-store.js';

test('a stored brushSize migrates to a square brush of that size', () => {
  const d = migrateDrawingSettings({ brushSize: 5 });
  assert.equal(d.brush.mask.kind, 'square');
  assert.equal(d.brush.mask.size, 5);
  assert.equal(d.brush.ink.kind, 'solid');
  assert.equal(d.brushSize, undefined, 'the legacy field is gone');
});

test('fresh state gets the default single-pixel brush', () => {
  const s = createEditorState();
  assert.equal(s.workspace.drawing.brush.mask.size, 1);
  assert.equal(s.workspace.drawing.brush.ink.kind, 'solid');
});

test('an already-migrated brush is preserved', () => {
  const brush = { mask: { kind: 'circle', size: 7 }, ink: { kind: 'dither' } };
  assert.equal(migrateDrawingSettings({ brush }).brush.mask.kind, 'circle');
  assert.equal(migrateDrawingSettings({ brush }).brush.ink.kind, 'dither');
});

test('mask size accepts the widened 1..16 range', () => {
  assert.equal(migrateDrawingSettings({ brushSize: 16 }).brush.mask.size, 16);
  assert.equal(migrateDrawingSettings({ brushSize: 99 }).brush.mask.size, 16);
});

test('primary and secondary colors survive migration', () => {
  const d = migrateDrawingSettings({ brushSize: 2, primary: [1, 2, 3, 255] });
  assert.deepEqual(d.primary, [1, 2, 3, 255]);
  assert.deepEqual(d.secondary, [255, 255, 255, 255]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-migration.test.mjs`
Expected: FAIL — `migrateDrawingSettings` is not exported.

- [ ] **Step 3: Migrate the store**

In `js/host/editor-store.js`, replace the inline `drawing` block:

```js
import { DEFAULT_BRUSH, normalizeBrush } from '../core/brushes.js';

export function migrateDrawingSettings(raw = {}) {
  const { brushSize, brush, ...rest } = raw;
  return {
    primary: [0, 0, 0, 255],
    secondary: [255, 255, 255, 255],
    ...rest,
    brush: brush
      ? normalizeBrush(brush)
      : normalizeBrush({ ...DEFAULT_BRUSH, mask: { kind: 'square', size: brushSize ?? 1 } }),
  };
}
```

and use it: `drawing: migrateDrawingSettings(initialWorkspace.drawing)`.

- [ ] **Step 4: Forward pressure from `canvas-view.js`**

In all three handlers, add the two fields the app currently discards:

```js
this.onPointer({
  type: 'down', x: img.x, y: img.y, sx, sy,
  buttons: e.buttons, shiftKey: e.shiftKey, altKey: e.altKey,
  pressure: e.pressure, pointerType: e.pointerType,
});
```

- [ ] **Step 5: Point the Size control at `mask.size`**

In `js/components/tool-palette.js`, change `brushInput.max` from `'8'` to `'16'`, read `drawingSettings().brush.mask.size`, and write with:

```js
const cur = drawingSettings().brush;
store.updateDrawingSettings({ brush: { ...cur, mask: { ...cur.mask, size: v } } });
```

Update the subscription at line 256 to `s => s.workspace.drawing.brush.mask.size`. Disable the input when `brush.mask.kind === 'custom'`, since a custom mask has no scalar size.

In `js/features/workbench/editor-workbench.js:41-44`, change the `[` / `]` handlers to adjust `brush.mask.size` with the same 1–16 clamp.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/brush-migration.test.mjs tests/builtinmodes.test.mjs tests/model.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add js/host/editor-store.js js/components/canvas/canvas-view.js js/components/tool-palette.js js/features/workbench/editor-workbench.js tests/brush-migration.test.mjs
git commit -m "feat: migrate brushSize to the full brush and forward pen pressure"
```

---

### Task 11: Brush formats — `js/core/brush-io.js`

**Files:**
- Create: `js/core/brush-io.js`
- Test: `tests/brush-io.test.mjs`

**Interfaces:**
- Consumes: `normalizeBrush` (Task 1); `createBitmap`/`setPixel`/`getPixel` (`js/core/pixels.js`).
- Produces:
  - `brushToBitmap(brush) -> bitmap` — opaque pixels are coverage, colors are the stamp payload
  - `bitmapToBrush(bitmap, name) -> Brush` — a custom-mask brush
  - `serializeBrushJson(brush) -> string`, `parseBrushJson(text) -> Brush`
  - `serializeLibraryJson(brushes) -> string`, `parseLibraryJson(text) -> Brush[]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-io.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { normalizeBrush } from '../js/core/brushes.js';
import {
  brushToBitmap, bitmapToBrush, serializeBrushJson, parseBrushJson,
  serializeLibraryJson, parseLibraryJson,
} from '../js/core/brush-io.js';

test('bitmapToBrush treats opaque pixels as coverage', () => {
  const bmp = createBitmap(3, 3);
  setPixel(bmp, 1, 1, [10, 20, 30, 255]);
  const brush = bitmapToBrush(bmp, 'Dot');
  assert.equal(brush.mask.kind, 'custom');
  assert.equal(brush.name, 'Dot');
  assert.equal([...brush.mask.bitmap.bits].filter(Boolean).length, 1);
});

test('a custom brush round-trips through a bitmap', () => {
  const src = createBitmap(4, 4);
  setPixel(src, 0, 0, [255, 0, 0, 255]);
  setPixel(src, 3, 3, [0, 255, 0, 255]);
  const out = brushToBitmap(bitmapToBrush(src, 'RT'));
  assert.deepEqual([...getPixel(out, 0, 0)], [255, 0, 0, 255]);
  assert.deepEqual([...getPixel(out, 3, 3)], [0, 255, 0, 255]);
  assert.equal(getPixel(out, 1, 1)[3], 0);
});

test('brush JSON round-trips every field including ink and pressure', () => {
  const brush = normalizeBrush({
    name: 'Foliage',
    mask: { kind: 'circle', size: 5, scatter: 3, rotateJitter: true, rotate: 90 },
    ink: { kind: 'dither', opacity: 40, jitter: 2, pattern: 'checker' },
    pressure: { target: 'size', min: 2, max: 9, curve: 'soft' },
  });
  const back = parseBrushJson(serializeBrushJson(brush));
  assert.equal(back.name, 'Foliage');
  assert.equal(back.mask.scatter, 3);
  assert.equal(back.mask.rotateJitter, true);
  assert.equal(back.mask.rotate, 90);
  assert.equal(back.ink.opacity, 40);
  assert.equal(back.ink.pattern, 'checker');
  assert.equal(back.pressure.curve, 'soft');
});

test('a custom mask survives the JSON round-trip as a typed array', () => {
  const src = createBitmap(2, 2);
  setPixel(src, 0, 0, [1, 2, 3, 255]);
  const back = parseBrushJson(serializeBrushJson(bitmapToBrush(src, 'M')));
  assert.equal(back.mask.bitmap.bits instanceof Uint8Array, true);
  assert.equal(back.mask.bitmap.bits[0], 1);
});

test('parseBrushJson normalizes a hand-written partial file', () => {
  const b = parseBrushJson('{"name":"Hand","mask":{"kind":"circle","size":3}}');
  assert.equal(b.ink.kind, 'solid');
  assert.equal(b.pressure.target, 'none');
});

test('parseBrushJson rejects garbage', () => {
  assert.throws(() => parseBrushJson('not json'));
});

test('a whole library round-trips', () => {
  const lib = [normalizeBrush({ name: 'A' }), normalizeBrush({ name: 'B' })];
  const back = parseLibraryJson(serializeLibraryJson(lib));
  assert.deepEqual(back.map(b => b.name), ['A', 'B']);
});

test('parseLibraryJson rejects a file that is not a library', () => {
  assert.throws(() => parseLibraryJson('{"nope":1}'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-io.test.mjs`
Expected: FAIL — cannot find module `../js/core/brush-io.js`.

- [ ] **Step 3: Implement `js/core/brush-io.js`**

```js
// js/core/brush-io.js
// Brush file formats. Pure; no DOM, no File API.
//
// PNG is the shareable format: opaque pixels are mask coverage and their
// colors are the `stamp` payload, so a brush can be authored in the app
// itself. JSON carries the settings a PNG cannot -- ink kind, opacity,
// spacing, scatter, pressure.

import { createBitmap, setPixel, getPixel } from './pixels.js';
import { normalizeBrush } from './brushes.js';

export function bitmapToBrush(bitmap, name = 'Brush') {
  const bits = new Uint8Array(bitmap.width * bitmap.height);
  const colors = [];
  for (let y = 0, i = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++, i++) {
      const p = getPixel(bitmap, x, y);
      bits[i] = p[3] > 0 ? 1 : 0;
      colors.push([p[0], p[1], p[2], p[3]]);
    }
  }
  return normalizeBrush({
    name,
    mask: { kind: 'custom', bitmap: { width: bitmap.width, height: bitmap.height, bits }, colors },
  });
}

export function brushToBitmap(brush) {
  const g = brush.mask.bitmap;
  if (!g) return createBitmap(1, 1);
  const out = createBitmap(g.width, g.height);
  const colors = brush.mask.colors;
  for (let y = 0, i = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++, i++) {
      if (!g.bits[i]) continue;
      setPixel(out, x, y, colors?.[i] ?? [0, 0, 0, 255]);
    }
  }
  return out;
}

// Uint8Array does not survive JSON, so the mask bits travel as a plain array
// and are rehydrated on the way back in.
function toPlain(brush) {
  const b = { ...brush, mask: { ...brush.mask } };
  if (b.mask.bitmap) {
    b.mask.bitmap = { ...b.mask.bitmap, bits: Array.from(b.mask.bitmap.bits) };
  }
  return b;
}

function fromPlain(raw) {
  const b = normalizeBrush(raw);
  if (b.mask.bitmap?.bits) {
    b.mask.bitmap = { ...b.mask.bitmap, bits: Uint8Array.from(b.mask.bitmap.bits) };
  }
  return b;
}

export function serializeBrushJson(brush) {
  return JSON.stringify(toPlain(brush), null, 2);
}

export function parseBrushJson(text) {
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Not a brush file');
  return fromPlain(raw);
}

export function serializeLibraryJson(brushes) {
  return JSON.stringify({ version: 1, brushes: brushes.map(toPlain) }, null, 2);
}

export function parseLibraryJson(text) {
  const raw = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : raw?.brushes;
  if (!Array.isArray(list)) throw new Error('Not a brush library file');
  return list.map(fromPlain);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/brush-io.test.mjs`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```powershell
git add js/core/brush-io.js tests/brush-io.test.mjs
git commit -m "feat: add PNG and JSON brush formats"
```

---

### Task 12: The library and project embedding

The library is the single editable source of truth; project embeds are derived snapshots written at save time.

**Files:**
- Create: `js/features/brushes/brush-library.js`
- Modify: `js/core/model.js:119` (new project), `:634` (serialize), `:691` (deserialize)
- Test: `tests/brush-library.test.mjs`

**Interfaces:**
- Consumes: `normalizeBrush`, `BUILTIN_BRUSHES` (Task 1).
- Produces:
  - `createBrushLibrary(preferences) -> { list, get, add, update, remove, replaceAll, subscribe }`
  - `mergeIncoming(library, incoming) -> { added, existing }` — the open-a-file dedupe
  - `project.brushes: Brush[]` on the model, defaulting to `[]`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-library.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary, mergeIncoming } from '../js/features/brushes/brush-library.js';

// Minimal stand-in for BrowserPreferences: same get/set/remove surface.
function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
}

test('a fresh library seeds the built-ins', () => {
  const lib = createBrushLibrary(fakePrefs());
  assert.ok(lib.list().length >= 5);
  assert.ok(lib.list().some(b => b.mask.size === 1 && b.mask.kind === 'square'));
});

test('added brushes persist through the preferences store', () => {
  const prefs = fakePrefs();
  const a = createBrushLibrary(prefs);
  a.add(normalizeBrush({ name: 'Grass' }));
  const b = createBrushLibrary(prefs);
  assert.ok(b.list().some(x => x.name === 'Grass'));
});

test('update replaces a brush by id and leaves the rest alone', () => {
  const lib = createBrushLibrary(fakePrefs());
  const brush = normalizeBrush({ name: 'Old' });
  lib.add(brush);
  const before = lib.list().length;
  lib.update({ ...brush, name: 'New' });
  assert.equal(lib.list().length, before);
  assert.ok(lib.list().some(b => b.id === brush.id && b.name === 'New'));
});

test('update ignores an unknown id rather than appending', () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  lib.update(normalizeBrush({ id: 'nope', name: 'Ghost' }));
  assert.equal(lib.list().length, before);
});

test('remove deletes by id', () => {
  const lib = createBrushLibrary(fakePrefs());
  const brush = normalizeBrush({ name: 'Doomed' });
  lib.add(brush);
  lib.remove(brush.id);
  assert.equal(lib.list().some(b => b.id === brush.id), false);
});

test('a custom mask survives a save/reload cycle as a typed array', () => {
  const prefs = fakePrefs();
  const a = createBrushLibrary(prefs);
  a.add(normalizeBrush({
    name: 'Custom',
    mask: { kind: 'custom', bitmap: { width: 2, height: 2, bits: Uint8Array.from([1, 0, 0, 1]) } },
  }));
  const reloaded = createBrushLibrary(prefs).list().find(b => b.name === 'Custom');
  assert.equal([...reloaded.mask.bitmap.bits].join(''), '1001');
});

test('mergeIncoming reports which project brushes are new to the library', () => {
  const lib = createBrushLibrary(fakePrefs());
  const known = lib.list()[0];
  const stranger = normalizeBrush({ name: 'Stranger' });
  const { added, existing } = mergeIncoming(lib, [known, stranger]);
  assert.deepEqual(added.map(b => b.name), ['Stranger']);
  assert.equal(existing.length, 1);
});

test('mergeIncoming does not mutate the library -- the caller decides', () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  mergeIncoming(lib, [normalizeBrush({ name: 'Stranger' })]);
  assert.equal(lib.list().length, before);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/brush-library.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `js/features/brushes/brush-library.js`**

```js
// js/features/brushes/brush-library.js
// The brush library: editor configuration, persisted per browser, carried
// between projects.
//
// This is the single EDITABLE source of truth. Brushes embedded in a project
// file are derived snapshots -- read on open and offered to the library,
// never edited in place -- so the two copies cannot drift apart.

import { normalizeBrush, BUILTIN_BRUSHES } from '../../core/brushes.js';

const KEY = 'brushes.library';

// Uint8Array does not survive JSON in localStorage either.
function toStored(brush) {
  if (!brush.mask.bitmap) return brush;
  return {
    ...brush,
    mask: { ...brush.mask, bitmap: { ...brush.mask.bitmap, bits: Array.from(brush.mask.bitmap.bits) } },
  };
}

function fromStored(raw) {
  const b = normalizeBrush(raw);
  if (b.mask.bitmap?.bits) {
    b.mask.bitmap = { ...b.mask.bitmap, bits: Uint8Array.from(b.mask.bitmap.bits) };
  }
  return b;
}

export function createBrushLibrary(preferences) {
  let brushes = null;
  const listeners = new Set();

  function load() {
    if (brushes) return brushes;
    const raw = preferences.get(KEY, null);
    brushes = Array.isArray(raw) && raw.length
      ? raw.map(fromStored)
      : BUILTIN_BRUSHES.map(b => normalizeBrush(b));
    return brushes;
  }

  function save() {
    preferences.set(KEY, brushes.map(toStored));
    for (const fn of listeners) fn(brushes);
  }

  return {
    list: () => [...load()],
    get: (id) => load().find(b => b.id === id) ?? null,
    add(brush) { load().push(fromStored(brush)); save(); },
    update(brush) {
      const list = load();
      const i = list.findIndex(b => b.id === brush.id);
      if (i === -1) return;
      list[i] = fromStored(brush);
      save();
    },
    remove(id) { brushes = load().filter(b => b.id !== id); save(); },
    replaceAll(next) { brushes = next.map(fromStored); save(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// Compares by id, so a brush that travelled inside a project file and one
// already in the library are recognised as the same brush.
export function mergeIncoming(library, incoming) {
  const known = new Set(library.list().map(b => b.id));
  const added = [], existing = [];
  for (const b of incoming) (known.has(b.id) ? existing : added).push(normalizeBrush(b));
  return { added, existing };
}
```

- [ ] **Step 4: Embed brushes in the project model**

In `js/core/model.js`:
- At line 119, add `brushes: []` to the new-project object.
- In serialize (around line 634), add `brushes: project.brushes ?? []`.
- In deserialize (around line 691), add `brushes: (json.brushes ?? []).map(normalizeBrush)`, importing `normalizeBrush` from `./brushes.js`.

Add a test to `tests/model.test.mjs`. Note the real signatures — `serializeProject(project)` returns **`{ json, images }`**, not a bare object, and `deserializeProject(json, imagesByPath)` takes **two** arguments. Use `createProject(name)` (already imported in that file) and add `normalizeBrush` to its imports from `../js/core/brushes.js`:

```js
test('a project round-trips its embedded brushes', () => {
  const p = createProject('brushes');
  p.brushes = [normalizeBrush({ name: 'Embedded', mask: { kind: 'circle', size: 5 } })];
  const { json, images } = serializeProject(p);
  const back = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.equal(back.brushes.length, 1);
  assert.equal(back.brushes[0].name, 'Embedded');
  assert.equal(back.brushes[0].mask.size, 5);
});

test('an old project file with no brushes key loads with an empty list', () => {
  const p = createProject('old');
  const { json, images } = serializeProject(p);
  delete json.brushes;
  const back = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual(back.brushes, []);
});
```

- [ ] **Step 5: Run the tests**

Run: `node --test tests/brush-library.test.mjs tests/model.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add js/features/brushes/brush-library.js js/core/model.js tests/brush-library.test.mjs tests/model.test.mjs
git commit -m "feat: add the brush library and project embedding"
```

---

### Task 13: Named-ramp palette commands

Ramps live on the palette, which **is** project content, so unlike brush edits these are undoable at `PROJECT_SCOPE`.

**Files:**
- Modify: `js/features/palettes/palette-commands.js`
- Test: `tests/palette-commands.test.mjs` (extend)

**Interfaces:**
- Consumes: the existing `runOnPalette` and `paletteById` helpers in that module.
- Produces:
  - `nameRamp(services, paletteId, name, indices)`
  - `deleteRamp(services, paletteId, name)`

- [ ] **Step 1: Write the failing tests**

Append to `tests/palette-commands.test.mjs`. That file already defines the harness these tests use — `makeServices(project, activeSheetId)` and `makePalette(name)` — so reuse them exactly as the existing tests in the file do. There is **no** `setupPalette` helper; do not invent one. Add `nameRamp, deleteRamp` to the existing import from `../js/features/palettes/palette-commands.js`.

```js
// Local to these tests: the two-line setup the existing tests in this file
// already repeat inline.
function rampFixture() {
  const palette = makePalette('Ramps');
  const project = { sheets: [], maps: [], palettes: [palette], activePaletteId: palette.id };
  return { palette, services: makeServices(project) };
}

test('nameRamp adds a named ramp and undo removes it', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1, 2]);
  assert.deepEqual(palette.ramps, [{ name: 'skin', indices: [0, 1, 2] }]);
  services.history.undo();
  assert.deepEqual(palette.ramps, []);
});

test('nameRamp replaces a ramp of the same name rather than duplicating it', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1]);
  nameRamp(services, palette.id, 'skin', [2, 3]);
  assert.equal(palette.ramps.length, 1);
  assert.deepEqual(palette.ramps[0].indices, [2, 3]);
});

test('deleteRamp removes one ramp and undo restores it', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1]);
  deleteRamp(services, palette.id, 'skin');
  assert.deepEqual(palette.ramps, []);
  services.history.undo();
  assert.equal(palette.ramps.length, 1);
});

test('deleteRamp on an unknown name records no history entry', () => {
  const { services, palette } = rampFixture();
  const before = services.history.canUndo();
  deleteRamp(services, palette.id, 'missing');
  assert.equal(services.history.canUndo(), before);
});

test('nameRamp is a no-op for an unknown palette', () => {
  const { services } = rampFixture();
  assert.doesNotThrow(() => nameRamp(services, 'missing', 'x', [0]));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/palette-commands.test.mjs`
Expected: FAIL — `nameRamp` is not exported.

- [ ] **Step 3: Implement the commands**

```js
// Ramps are palette state, so unlike brush edits these ARE undoable at
// PROJECT_SCOPE. Brushes are configuration; palettes are content.
function cloneRamps(ramps) {
  return (ramps ?? []).map(r => ({ name: r.name, indices: [...r.indices] }));
}

export function nameRamp(services, paletteId, name, indices) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = cloneRamps(target.ramps);
  const after = before.filter(r => r.name !== name).concat([{ name, indices: [...indices] }]);
  runOnPalette(services, paletteId, 'name ramp',
    p => { p.ramps = cloneRamps(after); },
    p => { p.ramps = cloneRamps(before); });
}

export function deleteRamp(services, paletteId, name) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = cloneRamps(target.ramps);
  if (!before.some(r => r.name === name)) return;
  const after = before.filter(r => r.name !== name);
  runOnPalette(services, paletteId, 'delete ramp',
    p => { p.ramps = cloneRamps(after); },
    p => { p.ramps = cloneRamps(before); });
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/palette-commands.test.mjs tests/palettes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add js/features/palettes/palette-commands.js tests/palette-commands.test.mjs
git commit -m "feat: add undoable named-ramp palette commands"
```

---

### Task 14: Manager dialog shell and its local undo stack

The dialog, the grid, and the window-scoped history. Editing controls come in Task 15.

**Files:**
- Create: `js/features/brushes/brush-manager.js`
- Modify: `index.html` (dialog markup), `css/app.css` (styles)
- Modify: `js/features/shell/menu-controller.js:81`, `js/bootstrap.js`
- Test: `tests/brush-manager-history.test.mjs`

**Interfaces:**
- Consumes: `createBrushLibrary` (Task 12); `CommandStack` (`js/core/commands.js`); `makeDialogMovable` / `centerDialog` / `closeOnEscape` / `markDefaultAction` (`js/components/dialogs.js`).
- Produces:
  - `mountBrushManager()`, `openBrushManager()`
  - `createBrushHistory() -> { run, undo, redo, canUndo, canRedo, clear }`

**Why a separate stack.** Brush edits must never enter project history: undoing a sprite edit should not silently resize a brush, and undoing a brush rename should not resurrect deleted pixels. `CommandStack` is the right primitive precisely because it has no scope machinery to entangle with `HistoryService`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/brush-manager-history.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary } from '../js/features/brushes/brush-library.js';
import { createBrushHistory } from '../js/features/brushes/brush-manager.js';

function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
}

test('a rename undoes and redoes on the local stack', () => {
  const lib = createBrushLibrary(fakePrefs());
  const history = createBrushHistory();
  const brush = normalizeBrush({ name: 'Before' });
  lib.add(brush);
  history.run({
    label: 'rename',
    redo: () => lib.update({ ...lib.get(brush.id), name: 'After' }),
    undo: () => lib.update({ ...lib.get(brush.id), name: 'Before' }),
  });
  assert.equal(lib.get(brush.id).name, 'After');
  history.undo();
  assert.equal(lib.get(brush.id).name, 'Before');
  history.redo();
  assert.equal(lib.get(brush.id).name, 'After');
});

test('canUndo and canRedo track the stack', () => {
  const history = createBrushHistory();
  assert.equal(history.canUndo(), false);
  history.run({ label: 'noop', redo: () => {}, undo: () => {} });
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);
  history.undo();
  assert.equal(history.canRedo(), true);
});

test('clear empties the stack -- the dialog calls this on close', () => {
  const history = createBrushHistory();
  history.run({ label: 'noop', redo: () => {}, undo: () => {} });
  history.clear();
  assert.equal(history.canUndo(), false);
});

test('a new action after an undo drops the redo branch', () => {
  const history = createBrushHistory();
  history.run({ label: 'a', redo: () => {}, undo: () => {} });
  history.undo();
  history.run({ label: 'b', redo: () => {}, undo: () => {} });
  assert.equal(history.canRedo(), false);
});

test('undo on an empty stack is a no-op, not a throw', () => {
  const history = createBrushHistory();
  assert.doesNotThrow(() => history.undo());
  assert.doesNotThrow(() => history.redo());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/brush-manager-history.test.mjs`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement the history**

```js
// js/features/brushes/brush-manager.js
import { CommandStack } from '../../core/commands.js';

// Brush edits undo HERE, never in project history. Brushes are editor
// configuration; palettes and pixels are project content. Mixing the two
// would mean undoing a sprite edit could silently resize a brush.
export function createBrushHistory() {
  const stack = new CommandStack(100);
  return {
    run(cmd) { cmd.redo(); stack.push(cmd); },
    undo() { stack.undo(); },
    redo() { stack.redo(); },
    canUndo: () => stack.canUndo(),
    canRedo: () => stack.canRedo(),
    clear: () => stack.clear(),
  };
}
```

- [ ] **Step 4: Build the dialog shell**

Add the dialog markup to `index.html` mirroring the palette manager's, and register the menu item. Per the established menu pattern, the item MUST be `{ action: 'edit.brushes' }` routed through `defineAction` — never an ad-hoc `{ label, run }` closure:

```js
// js/features/shell/menu-controller.js:81
{ action: 'edit.filters' }, { action: 'edit.palettes' }, { action: 'edit.brushes' },
```

Mount from `js/bootstrap.js` with one import and one call. The file must stay at or under 60 lines (asserted by `tests/architecture.test.mjs`); it is currently 41.

- [ ] **Step 5: Route `Ctrl+Z` to the local stack**

The global binding at `js/features/project/document-controller.js:442` lives on `window` and deliberately lets non-modal dialogs through, so the manager must claim the key itself. A listener on the **dialog element** runs before the window handler because the dialog is deeper in the tree:

```js
dialog.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); history.undo(); refresh(); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); history.redo(); refresh(); }
});
```

Render explicit Undo/Redo buttons in the dialog footer so the scoping is visible rather than a hidden keybinding whose behavior depends on focus, and call `history.clear()` on close.

- [ ] **Step 6: Run the tests**

Run: `node --test tests/brush-manager-history.test.mjs tests/architecture.test.mjs tests/builtinmodes.test.mjs`
Expected: PASS — including the `bootstrap.js` line-count assertion.

- [ ] **Step 7: Commit**

```powershell
git add js/features/brushes/brush-manager.js js/bootstrap.js js/features/shell/menu-controller.js index.html css/app.css tests/brush-manager-history.test.mjs
git commit -m "feat: add the brush manager dialog with window-scoped undo"
```

---

### Task 15: Editing controls, Make Brush From Selection, and the picker strip

**Files:**
- Modify: `js/features/brushes/brush-manager.js`
- Create: `js/features/brushes/brush-files.js`
- Modify: `js/components/tool-palette.js`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `exportBrush(brush, format)`, `importBrush()` in `brush-files.js`
  - `brushFromSelection(bitmap, rect, name) -> Brush`
  - A brush picker strip in the tool-options panel

- [ ] **Step 1: Build the editors**

Every control writes through `history.run(...)` so it lands on the local stack. Each edit follows one shape — capture `before`, apply `after`, hand both to the history:

```js
function editBrush(label, mutate) {
  const before = structuredClone(library.get(currentId));
  const after = mutate(structuredClone(before));
  history.run({
    label,
    redo: () => { library.update(after); refresh(); },
    undo: () => { library.update(before); refresh(); },
  });
}
```

Controls to render: name, mask kind, size (1–16, **disabled for custom masks**), spacing, scatter, rotate (0/90/180/270), flipH, flipV, rotateJitter, ink kind, opacity (showing the snapped level from `opacityLevel`), trueAlpha, jitter, pattern, and the pressure block (target, min, max, curve). Disable the `stamp` ink option whenever the mask is not custom, matching `validateBrush`.

- [ ] **Step 2: Render a live preview**

Draw a short S-curve stroke into an offscreen bitmap using the real engine — `strokeStamps` + `maskGridFor` + `makeInk` — so the preview shows the **composed** result. This is what makes the dither-at-50%-opacity interaction (which lands near 25% coverage) visible instead of surprising.

- [ ] **Step 3: Add Make Brush From Selection**

```js
// Reads the current marquee and turns it into a custom-mask brush.
import { copyRegion } from '../../core/pixels.js';
import { bitmapToBrush } from '../../core/brush-io.js';

export function brushFromSelection(bitmap, rect, name) {
  return bitmapToBrush(copyRegion(bitmap, rect.x, rect.y, rect.w, rect.h), name);
}
```

Register it as `brush.fromSelection` through `defineAction` and add it to the Edit menu, disabled when there is no selection.

- [ ] **Step 4: Add the picker strip**

In `js/components/tool-palette.js`, render a row of brush swatches from the library below the Size control, each drawing its mask preview to a small canvas. Clicking one sets `workspace.drawing.brush`. Add a button that opens the manager.

- [ ] **Step 5: Wire import/export**

`brush-files.js` mirrors `palette-files.js`: File System Access API with a `downloadBlob` fallback, delegating format work to `brush-io.js`. Never put browser globals in `brush-io.js`.

- [ ] **Step 6: Manual verification**

Start `./serve.ps1` and load with `?autotest`. Verify: create a brush; edit it; `Ctrl+Z` **inside** the dialog undoes only the brush edit and leaves the canvas untouched; `Ctrl+Z` **outside** the dialog still undoes canvas work. Then check dither fill, a shade brush dragged over a ramp, and Make Brush From Selection.

Do **not** script pointer drags in Playwright for this project — drag verification is done by hand.

- [ ] **Step 7: Commit**

```powershell
git add js/features/brushes/ js/components/tool-palette.js index.html css/app.css
git commit -m "feat: add brush editing controls, selection capture and picker"
```

---

### Task 16: Final verification

- [ ] **Step 1: Run the whole suite**

Run: `npm test`

Expected: every test passes. Scan the **entire** output for failures and list every failing test name — never pipe through `tail` or otherwise truncate, which can hide failures that are not in the last few lines.

- [ ] **Step 2: Confirm no dangling references to the retired field**

```powershell
Get-ChildItem -Recurse -Include *.js -Path js | Select-String -Pattern 'brushSize'
```

Expected: no hits outside a migration comment. `brushSize` is gone.

- [ ] **Step 3: Confirm the ink hook did not leak into non-painting callers**

```powershell
Get-ChildItem -Recurse -Include *.js -Path js | Select-String -Pattern 'setPixel\(' | Where-Object { $_.Path -notmatch 'pixels.js' }
```

Expected: only `js/core/model.js` (compositing) and `js/core/pixelSnapper.js` (snapping), unchanged and inkless.

- [ ] **Step 4: Verify the retro guarantees hold**

Confirm the palette-closure invariant test (Task 6) and the lossless-rotation test (Task 2) both pass — they are the executable form of the spec's guarantees.

- [ ] **Step 5: Manual smoke in the browser**

Only exercise flows this work could affect: paint with a custom brush, dither fill, shade over a ramp, pen pressure if hardware is available, brush undo inside the dialog, and a save/load round-trip carrying an embedded brush. Do not re-sweep unrelated flows.

- [ ] **Step 6: Commit any final fixes**

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: brush shape → 1; masks and lossless transforms → 2; spacing/scatter/rotateJitter and determinism → 3; ramp detection and the palette `ramps` field → 4; opacity-as-density → 5; the six inks and palette closure → 6; pressure → 7 (mapping) and 10 (plumbing); the `pixels.js` ink hook → 8; the mask/ink pipeline and the scatter overflow fix → 9; storage migration → 10; import/export formats → 11; library and project embedding → 12; named-ramp commands → 13; the manager, its scoped undo and the menu → 14; editing controls, selection capture and the picker → 15.

**Naming consistency.** `normalizeBrush`, `maskGridFor`, `rasterizeMask`, `rotateMaskGrid`, `flipMaskGrid`, `strokeStamps`, `strokeBounds`, `stampRandom`, `makeInk`, `applyPaletteClosure`, `stepAlongRamp`, `rampContaining`, `detectRamps`, `passesOpacity`, `opacityLevel`, `patternPicksSecondary`, `pressureValue`, `effectiveMaskSize`, `createBrushLibrary`, `mergeIncoming`, `createBrushHistory`, `bitmapToBrush`, `brushToBitmap` are each defined in exactly one task and referenced by that same name afterwards. Mask grids are `{width, height, bits}` throughout; RGBA bitmaps stay `{width, height, data}` — the two are never conflated.

**Ordering.** Tasks 1–7 are pure core, independently reviewable, and touch nothing the running app depends on. Task 8 is additive to `pixels.js`. The first user-visible change lands in Task 9, and the first thing a user can click arrives in Task 14.
