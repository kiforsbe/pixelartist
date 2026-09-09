# Palette Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's minimal palette handling with a real palette manager — create, edit, reorder, resize, lock, import and export palettes, using the built-in system palettes as templates.

**Architecture:** Three layers. `js/core/palettes.js` and a new pure `js/core/palette-io.js` hold the model and the file formats, with no DOM and no host access, so they are directly testable under `node --test`. `js/features/palettes/palette-commands.js` wraps every mutation in an undoable command at `PROJECT_SCOPE`. `js/features/palettes/palette-manager.js` plus `palette-files.js` own the non-modal dialog and the browser file glue. Three byte-identical per-mode command modules are deleted in favour of the shared family.

**Tech Stack:** Vanilla ES modules, no build step. `node --test` for tests. Native `<dialog>`, File System Access API with a `downloadBlob` fallback. Existing helpers: `makeDialogMovable` / `centerDialog` / `closeOnEscape` / `markDefaultAction` (`js/components/dialogs.js`), `armColorSample` (`js/components/canvas/drawing-engine.js`), `confirmOrAuto` (`js/platform/browser/autotest.js`), `colorFrequency` / `medianCutPalette` (`js/core/quantize.js`), `encodePng` / `decodePng` (`js/core/pngcodec.js`).

**Spec:** `docs/superpowers/specs/2026-09-09-palette-manager-design.md`

## Global Constraints

- **Palette shape** is exactly `{ id, name, indexed, colors, empty, emptyColor, lock }`. `colors` is `[r,g,b,a][]`, `empty` is a `boolean[]` of the **same length**, `emptyColor` is one `[r,g,b,a]`, `lock` is `{ size, reason } | null`. The legacy `size` field is gone.
- **`lock.size` always equals `colors.length`.** Any code path that sets one sets the other.
- **`colors` and `empty` are never mutated separately.** Every length or order change goes through a helper in `js/core/palettes.js` that touches both.
- **`empty` is presentational only.** Outside the editor an empty slot is an ordinary color: brush-snap candidate, counted in the quantize/export budget, written to exported files.
- **All palette exports are RGB-only.** Export drops alpha; import forces alpha to 255.
- **Every entry is exported**, empty slots included — a palette locked to 54 writes 54 entries.
- **Commands never touch browser globals.** No `document.`, `window.`, `alert(`, `confirm(`, `prompt(` in `js/core/palette-io.js` or `js/features/palettes/palette-commands.js`. Prompts and confirmations live in the manager UI, which calls `confirmOrAuto`.
- **Every palette mutation is undoable at `PROJECT_SCOPE`** — `history.execute(cmd, { scope: PROJECT_SCOPE })`. Palettes are project-level; document-scoped undo would strand them.
- **`js/bootstrap.js` must stay at or under 60 lines** (asserted by `tests/architecture.test.mjs`). It is currently 39.
- **Windows/PowerShell environment.** Use PowerShell syntax for shell commands.
- **Commits:** each task ends with a commit step, but per the user's standing git rule, only run `git commit` if the user has authorized commits for the execution session. Otherwise leave the work uncommitted and say so.

---

### Task 1: Palette model shape — `lock`, `empty`, `emptyColor`

Introduces the new fields, the load-time normalizer, and updates the two producers (`createPalette`, `clonePalette`) and the two serialization sites. Deliberately does **not** yet change `addSwatch`/`removeSwatch` behavior — that is Task 2 — so this task's diff is purely about shape.

**Files:**
- Modify: `js/core/palettes.js:3-8` (constants, `createPalette`)
- Modify: `js/core/systempalettes.js:41-45` (`clonePalette`)
- Modify: `js/core/model.js:2` (import), `js/core/model.js:634` (serialize), `js/core/model.js:685` (deserialize)
- Test: `tests/palettes.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `DEFAULT_EMPTY_COLOR: [0,0,0,255]` (exported const, `js/core/palettes.js`)
  - `createPalette({ name, indexed = false, size = 0, lockReason = '' }) -> Palette` — `size > 0` creates that many empty slots **and** locks the palette to that size
  - `normalizePalette(raw) -> Palette` — accepts an old-shape or new-shape plain object, returns the new shape
  - `clonePalette(sys) -> Palette` — indexed, locked to `sys.colors.length` with `reason: sys.name`

- [ ] **Step 1: Write the failing tests**

Replace the `'indexed palette pre-filled, addSwatch forbidden'` test in `tests/palettes.test.mjs` (currently lines 14-20) with the two tests below, and add the normalization tests. Also update the import list at the top of the file to pull in `DEFAULT_EMPTY_COLOR` and `normalizePalette`.

```js
// tests/palettes.test.mjs -- replace the import block at lines 3-6 with:
import {
  createPalette, parseHexColors, setEntry, addSwatch, removeSwatch,
  moveSwatch, nearestColor, remapColor, quantizeBitmapToPalette, INDEXED_SIZE_PRESETS,
  DEFAULT_EMPTY_COLOR, normalizePalette,
} from '../js/core/palettes.js';
```

```js
// replaces 'indexed palette pre-filled, addSwatch forbidden'
test('createPalette with a size pre-fills empty slots and locks to that size', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 4, lockReason: 'NES' });
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.empty, [true, true, true, true]);
  assert.deepEqual(p.emptyColor, DEFAULT_EMPTY_COLOR);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
  assert.equal('size' in p, false);
  // every slot starts at the palette's own unset color
  for (const c of p.colors) assert.deepEqual(c, DEFAULT_EMPTY_COLOR);
});

test('createPalette without a size is unlocked and starts empty', () => {
  const p = createPalette({ name: 'free' });
  assert.deepEqual(p.colors, []);
  assert.deepEqual(p.empty, []);
  assert.equal(p.lock, null);
});

test('normalizePalette locks a legacy indexed palette to its own color count', () => {
  const p = normalizePalette({ id: 'p1', name: 'Old', indexed: true, size: 4, colors: [[1,1,1,255],[2,2,2,255]] });
  // colors.length wins over the stored size
  assert.deepEqual(p.lock, { size: 2, reason: '' });
  assert.deepEqual(p.empty, [false, false]);
  assert.deepEqual(p.emptyColor, DEFAULT_EMPTY_COLOR);
  assert.equal('size' in p, false);
});

test('normalizePalette leaves a legacy free palette unlocked', () => {
  const p = normalizePalette({ id: 'p2', name: 'Old', indexed: false, size: 0, colors: [[1,1,1,255]] });
  assert.equal(p.lock, null);
  assert.deepEqual(p.empty, [false]);
});

test('normalizePalette keeps an already-new-shape palette intact', () => {
  const p = normalizePalette({
    id: 'p3', name: 'New', indexed: true,
    colors: [[1,1,1,255],[9,9,9,255]], empty: [false, true],
    emptyColor: [9,9,9,255], lock: { size: 2, reason: 'Game Boy' },
  });
  assert.deepEqual(p.empty, [false, true]);
  assert.deepEqual(p.emptyColor, [9,9,9,255]);
  assert.deepEqual(p.lock, { size: 2, reason: 'Game Boy' });
});

test('normalizePalette drops a mismatched empty array rather than trusting it', () => {
  const p = normalizePalette({ id: 'p4', name: 'Bad', indexed: false, colors: [[1,1,1,255],[2,2,2,255]], empty: [true] });
  assert.deepEqual(p.empty, [false, false]);
});
```

Also update the `clonePalette` assertion inside `'system palettes present with expected sizes'` (currently `assert.equal(clone.size, 4);` at line 59):

```js
  const clone = clonePalette(gb);
  assert.equal(clone.indexed, true);
  assert.deepEqual(clone.lock, { size: 4, reason: 'Game Boy' });
  assert.equal(clone.colors.length, 4);
  assert.deepEqual(clone.empty, [false, false, false, false]);
  assert.ok(clone.id);
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
node --test tests/palettes.test.mjs
```

Expected: FAIL — `DEFAULT_EMPTY_COLOR`/`normalizePalette` are not exported (`SyntaxError: The requested module ... does not provide an export named 'DEFAULT_EMPTY_COLOR'`).

- [ ] **Step 3: Add the new shape to `js/core/palettes.js`**

Replace lines 3-8 (the `INDEXED_SIZE_PRESETS` const and `createPalette`) with:

```js
export const INDEXED_SIZE_PRESETS = [2, 4, 16, 256];

// The color an "unset" slot carries until the user picks something. Real,
// not null: an empty slot is an ordinary color to everything outside the
// editor (brush snapping, quantize, export), and `empty` is only how the
// editor knows to DRAW it as undecided. Per-palette, so a palette whose
// artwork genuinely uses black can move its unset color out of the way.
export const DEFAULT_EMPTY_COLOR = [0, 0, 0, 255];

// `size > 0` creates that many empty slots AND locks the palette to that
// count -- the two are the same decision at creation time. `indexed` is
// independent of both: it only means "snap the brush to these colors, and
// use them as the quantize/export source".
export function createPalette({ name, indexed = false, size = 0, lockReason = '' }) {
  const emptyColor = [...DEFAULT_EMPTY_COLOR];
  return {
    id: newId('pal'), name, indexed,
    colors: Array.from({ length: size }, () => [...emptyColor]),
    empty: Array.from({ length: size }, () => true),
    emptyColor,
    lock: size > 0 ? { size, reason: lockReason } : null,
  };
}

// Brings a palette read from a project file up to the current shape. Old
// files have {indexed, size, colors} and none of empty/emptyColor/lock.
// An old indexed palette was fixed-size under the old rules, so locking it
// preserves exactly the behavior the file was saved with; the empty reason
// renders as an unlabeled lock the user can name or clear.
//
// colors.length always wins over a stored lock.size or size: every consumer
// already reads the array, so the count is the array's to state.
export function normalizePalette(raw) {
  const { size: _legacySize, ...rest } = raw;
  const colors = (raw.colors ?? []).map(c => [c[0], c[1], c[2], c[3] ?? 255]);
  const empty = Array.isArray(raw.empty) && raw.empty.length === colors.length
    ? raw.empty.map(Boolean)
    : colors.map(() => false);
  const emptyColor = raw.emptyColor ? [...raw.emptyColor] : [...DEFAULT_EMPTY_COLOR];
  const locked = raw.lock ? { reason: raw.lock.reason ?? '' } : (raw.indexed ? { reason: '' } : null);
  return {
    ...rest, indexed: !!raw.indexed, colors, empty, emptyColor,
    lock: locked && colors.length > 0 ? { size: colors.length, reason: locked.reason } : null,
  };
}
```

- [ ] **Step 4: Update `clonePalette` in `js/core/systempalettes.js`**

Replace lines 41-45:

```js
export function clonePalette(sys) {
  const p = createPalette({ name: sys.name, indexed: true, size: sys.colors.length, lockReason: sys.name });
  sys.colors.forEach((c, i) => setEntry(p, i, c));
  return p;
}
```

(The file already imports `setEntry`; `setEntry` clears the slot's empty flag once Task 2 lands. Until then the flags stay `true` — Task 2's test covers the corrected behavior, and this task's `clonePalette` assertion above expects `[false,false,false,false]`, so **`setEntry` must clear the flag now**. Add that one line to `setEntry` here rather than waiting:)

In `js/core/palettes.js`, change `setEntry` (line 17) to:

```js
export function setEntry(palette, index, rgba) {
  palette.colors[index] = [...rgba];
  palette.empty[index] = false;
}
```

- [ ] **Step 5: Wire normalization and deep-copy into `js/core/model.js`**

Change the import on line 2 from `import { newId } from './palettes.js';` to:

```js
import { newId, normalizePalette } from './palettes.js';
```

In `serializeProject`, replace the `palettes:` line (currently line 634):

```js
    palettes: project.palettes.map(p => ({
      ...p,
      colors: p.colors.map(c => [...c]),
      empty: [...p.empty],
      emptyColor: [...p.emptyColor],
      lock: p.lock ? { ...p.lock } : null,
    })),
```

In `deserializeProject`, replace the `palettes:` line (currently line 685):

```js
    palettes: (json.palettes ?? []).map(normalizePalette),
```

- [ ] **Step 6: Run the tests to verify they pass**

```powershell
node --test tests/palettes.test.mjs tests/model.test.mjs
```

Expected: PASS. If `tests/model.test.mjs` does not exist, run only the first file.

- [ ] **Step 7: Run the full suite to catch shape fallout**

```powershell
node --test tests/
```

Expected: the only failures are in `tests/sprites-palette-commands.test.mjs`, `tests/tiles-palette-commands.test.mjs` and `tests/maps-palette-commands.test.mjs`, whose `makePalette()` fixtures build the old shape (`{ ..., size: 4, colors: [...] }`) with no `empty` array, so `setEntry` now writes to `palette.empty[index]` on an undefined array. Fix each of the three fixtures by adding the two fields:

```js
function makePalette() {
  return {
    id: 'pal1', name: 'Pal', indexed: true,
    colors: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]],
    empty: [false, false, false, false],
    emptyColor: [0, 0, 0, 255],
    lock: { size: 4, reason: '' },
  };
}
```

Re-run `node --test tests/` and confirm a clean pass. List every failing test name from the full output — do not truncate.

- [ ] **Step 8: Commit**

```powershell
git add js/core/palettes.js js/core/systempalettes.js js/core/model.js tests/palettes.test.mjs tests/sprites-palette-commands.test.mjs tests/tiles-palette-commands.test.mjs tests/maps-palette-commands.test.mjs
git commit -m "refactor(palettes): replace fixed-size `size` with lock/empty/emptyColor"
```

---

### Task 2: Paired mutation, lock, sort and usage helpers

Makes every palette editable in size and keeps `colors` and `empty` in lockstep. This is where `addSwatch`/`removeSwatch` stop throwing on indexed palettes.

**Files:**
- Modify: `js/core/palettes.js:19-32` (`addSwatch`, `removeSwatch`, `moveSwatch`) and append new helpers
- Test: `tests/palettes.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_EMPTY_COLOR`, `createPalette`, `setEntry` (Task 1).
- Produces, all from `js/core/palettes.js`:
  - `setEntry(palette, index, rgba) -> void` (already updated in Task 1)
  - `clearEntry(palette, index) -> void`
  - `addSwatch(palette, rgba) -> number` — returns the index written, or `-1` when a locked palette is full
  - `removeSwatch(palette, index) -> void`
  - `moveSwatch(palette, from, to) -> void`
  - `setEmptyColor(palette, rgba) -> void`
  - `setLock(palette, size, reason) -> void` — `size === null` unlocks
  - `sortOrder(colors, mode, usage) -> number[]` — `mode` is `'hue' | 'luminance' | 'usage'`; returns an index permutation
  - `applyOrder(palette, order) -> void`
  - `countPaletteUsage(palette, bitmaps) -> number[]`

- [ ] **Step 1: Write the failing tests**

Replace the `'non-indexed palette grows, remove and move work'` test in `tests/palettes.test.mjs` (currently lines 22-29) with the block below, and add the rest at the end of the file. Extend the import list with the new names.

```js
// extend the js/core/palettes.js import list with:
//   clearEntry, setEmptyColor, setLock, sortOrder, applyOrder, countPaletteUsage,

test('an unlocked palette grows, removes and moves, carrying empty flags along', () => {
  const p = createPalette({ name: 'free' });
  assert.equal(addSwatch(p, [1,1,1,255]), 0);
  addSwatch(p, [2,2,2,255]);
  addSwatch(p, [3,3,3,255]);
  assert.deepEqual(p.empty, [false, false, false]);
  moveSwatch(p, 2, 0);
  assert.deepEqual(p.colors[0], [3,3,3,255]);
  removeSwatch(p, 0);
  assert.equal(p.colors.length, 2);
  assert.equal(p.empty.length, 2);
});

test('addSwatch fills a locked palette first empty slot, then reports full', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2 });
  assert.equal(addSwatch(p, [1,1,1,255]), 0);
  assert.deepEqual(p.empty, [false, true]);
  assert.equal(addSwatch(p, [2,2,2,255]), 1);
  assert.equal(addSwatch(p, [3,3,3,255]), -1);
  assert.equal(p.colors.length, 2);              // never grew past the lock
  assert.deepEqual(p.colors[1], [2,2,2,255]);
});

test('removeSwatch clears in place on a locked palette so lower indices do not shift', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 0, [1,1,1,255]); setEntry(p, 1, [2,2,2,255]); setEntry(p, 2, [3,3,3,255]);
  removeSwatch(p, 1);
  assert.equal(p.colors.length, 3);
  assert.deepEqual(p.colors[2], [3,3,3,255]);    // index 2 stayed put
  assert.deepEqual(p.empty, [false, true, false]);
  assert.deepEqual(p.colors[1], p.emptyColor);
});

test('moveSwatch carries the empty flag with its color', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 0, [1,1,1,255]); setEntry(p, 2, [3,3,3,255]);
  // slot 1 is still empty
  moveSwatch(p, 1, 0);
  assert.deepEqual(p.empty, [true, false, false]);
  assert.deepEqual(p.colors[1], [1,1,1,255]);
});

test('setEmptyColor re-syncs every still-empty slot and leaves decided ones alone', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 1, [7,7,7,255]);
  setEmptyColor(p, [200, 0, 200, 255]);
  assert.deepEqual(p.colors[0], [200, 0, 200, 255]);
  assert.deepEqual(p.colors[2], [200, 0, 200, 255]);
  assert.deepEqual(p.colors[1], [7,7,7,255]);
  assert.deepEqual(p.emptyColor, [200, 0, 200, 255]);
});

test('assigning black to a slot clears its empty flag -- the flag is the whole distinction', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 1 });
  assert.equal(p.empty[0], true);
  setEntry(p, 0, [0, 0, 0, 255]);              // same bytes as DEFAULT_EMPTY_COLOR
  assert.equal(p.empty[0], false);
});

test('clearEntry puts the palette unset color back and re-flags the slot', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]);
  setEmptyColor(p, [50,50,50,255]);
  clearEntry(p, 0);
  assert.deepEqual(p.colors[0], [50,50,50,255]);
  assert.equal(p.empty[0], true);
});

test('setLock pads a short palette with empty slots', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]);
  setLock(p, 4, 'NES');
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.empty, [false, true, true, true]);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
});

test('setLock truncates a long palette from the end', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]); addSwatch(p, [2,2,2,255]); addSwatch(p, [3,3,3,255]);
  setLock(p, 2, 'Game Boy');
  assert.equal(p.colors.length, 2);
  assert.deepEqual(p.colors[1], [2,2,2,255]);
  assert.deepEqual(p.lock, { size: 2, reason: 'Game Boy' });
});

test('setLock(null) unlocks and discards empty slots', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 1, [5,5,5,255]);
  setLock(p, null);
  assert.equal(p.lock, null);
  assert.deepEqual(p.colors, [[5,5,5,255]]);
  assert.deepEqual(p.empty, [false]);
});

test('sortOrder ranks by luminance, hue and usage, breaking ties by original index', () => {
  const colors = [[255,0,0,255], [0,0,0,255], [255,255,255,255], [0,0,255,255]];
  assert.deepEqual(sortOrder(colors, 'luminance'), [1, 3, 0, 2]);
  // greys (hue -1) sort ahead of every real hue; red (0) before blue (240)
  assert.deepEqual(sortOrder(colors, 'hue'), [1, 2, 0, 3]);
  assert.deepEqual(sortOrder(colors, 'usage', [1, 9, 0, 9]), [1, 3, 0, 2]);
});

test('applyOrder permutes colors and empty flags together', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 0, [1,1,1,255]); setEntry(p, 2, [3,3,3,255]);
  applyOrder(p, [2, 1, 0]);
  assert.deepEqual(p.colors[0], [3,3,3,255]);
  assert.deepEqual(p.empty, [false, true, false]);
});

test('countPaletteUsage counts exact RGBA matches per slot and ignores transparent pixels', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]); addSwatch(p, [2,2,2,255]);
  const b = createBitmap(3, 1);
  setPixel(b, 0, 0, [1,1,1,255]);
  setPixel(b, 1, 0, [1,1,1,255]);
  setPixel(b, 2, 0, [0,0,0,0]);
  assert.deepEqual(countPaletteUsage(p, [b]), [2, 0]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
node --test tests/palettes.test.mjs
```

Expected: FAIL — no export named `clearEntry`.

- [ ] **Step 3: Replace the mutation helpers in `js/core/palettes.js`**

Replace lines 19-32 (`addSwatch`, `removeSwatch`, `moveSwatch`) with:

```js
// Every helper below maintains `colors` and `empty` together. That pairing
// is the whole cost of keeping `colors` a plain color array (which is what
// lets nearestColor/quantizeBitmapToPalette/serialization stay untouched),
// so nothing outside this file may splice either array on its own.

export function clearEntry(palette, index) {
  palette.colors[index] = [...palette.emptyColor];
  palette.empty[index] = true;
}

// Returns the index written, or -1 when a locked palette has no empty slot
// left. A locked palette fills its first empty slot rather than growing --
// its entry count is the point of the lock.
export function addSwatch(palette, rgba) {
  if (palette.lock) {
    const slot = palette.empty.indexOf(true);
    if (slot === -1) return -1;
    setEntry(palette, slot, rgba);
    return slot;
  }
  palette.colors.push([...rgba]);
  palette.empty.push(false);
  return palette.colors.length - 1;
}

// On a locked palette this CLEARS the slot instead of splicing it out, so
// every index below it keeps its number -- an indexed palette's indices are
// referenced by the artwork, and resequencing them silently would recolor it.
export function removeSwatch(palette, index) {
  if (index < 0 || index >= palette.colors.length) return;
  if (palette.lock) { clearEntry(palette, index); return; }
  palette.colors.splice(index, 1);
  palette.empty.splice(index, 1);
}

export function moveSwatch(palette, from, to) {
  const [c] = palette.colors.splice(from, 1);
  const [e] = palette.empty.splice(from, 1);
  palette.colors.splice(to, 0, c);
  palette.empty.splice(to, 0, e);
}

// The unset color is a per-palette choice, so changing it re-assigns every
// slot still flagged empty -- it stays this palette's unset color rather
// than becoming a one-time fill that later edits drift away from.
export function setEmptyColor(palette, rgba) {
  palette.emptyColor = [...rgba];
  for (let i = 0; i < palette.colors.length; i++) {
    if (palette.empty[i]) palette.colors[i] = [...rgba];
  }
}

// size === null unlocks. Unlocking discards empty slots: they have no
// meaning in a free-growing list. Locking pads with empty slots, or drops
// entries from the end -- the CALLER confirms a lossy truncate first (see
// the manager's setPaletteLock flow); this helper just applies the decision.
export function setLock(palette, size, reason = '') {
  if (size === null) {
    const keep = [];
    for (let i = 0; i < palette.colors.length; i++) if (!palette.empty[i]) keep.push(i);
    palette.colors = keep.map(i => palette.colors[i]);
    palette.empty = keep.map(() => false);
    palette.lock = null;
    return;
  }
  while (palette.colors.length > size) { palette.colors.pop(); palette.empty.pop(); }
  while (palette.colors.length < size) { palette.colors.push([...palette.emptyColor]); palette.empty.push(true); }
  palette.lock = { size, reason };
}
```

- [ ] **Step 4: Append the sort and usage helpers to `js/core/palettes.js`**

```js
// Greys have no hue; -1 parks them ahead of every real hue rather than
// scattering them through the ramp at an arbitrary angle.
function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return -1;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function lumaOf([r, g, b]) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// Returns an index permutation rather than sorted colors, so the caller can
// carry `empty` (and anything else parallel) through the same reordering --
// see applyOrder. Ties break by original index, so a sort is deterministic
// and re-sorting an already-sorted palette is a no-op.
// mode: 'hue' | 'luminance' | 'usage'. `usage` is a per-slot count array
// (see countPaletteUsage); most-used sorts first.
export function sortOrder(colors, mode, usage = null) {
  const key = mode === 'hue' ? i => hueOf(colors[i])
    : mode === 'luminance' ? i => lumaOf(colors[i])
    : i => -(usage?.[i] ?? 0);
  return colors.map((_, i) => i).sort((a, b) => key(a) - key(b) || a - b);
}

export function applyOrder(palette, order) {
  palette.colors = order.map(i => palette.colors[i]);
  palette.empty = order.map(i => palette.empty[i]);
}

// Per-slot exact-RGBA hit counts across `bitmaps`. Duplicate colors in the
// palette all report against their first slot; fully transparent pixels are
// never counted (they need no palette entry).
export function countPaletteUsage(palette, bitmaps) {
  const counts = palette.colors.map(() => 0);
  const index = new Map();
  palette.colors.forEach((c, i) => { const k = c.join(','); if (!index.has(k)) index.set(k, i); });
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const at = index.get(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      if (at !== undefined) counts[at]++;
    }
  }
  return counts;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```powershell
node --test tests/palettes.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run the full suite**

```powershell
node --test tests/
```

Expected: PASS. `color-panel.js` still calls `removeSwatch(target, target.colors.length - 1)` to undo an add — on an unlocked palette that still splices, so it is unaffected. List every failing test name from the full output.

- [ ] **Step 7: Commit**

```powershell
git add js/core/palettes.js tests/palettes.test.mjs
git commit -m "feat(palettes): paired colors/empty mutation, lock resize, sort and usage helpers"
```

---

### Task 3: `js/core/palette-io.js` — GIMP, hex and JASC formats

A new pure module. No DOM, no host, no `pngcodec` import (that would drag in `OffscreenCanvas` and make the module untestable under node) — the PNG side is Task 4 and stays pure too.

**Files:**
- Create: `js/core/palette-io.js`
- Test: `tests/palette-io.test.mjs` (create)

**Interfaces:**
- Consumes: nothing — the module is standalone by design.
- Produces, all from `js/core/palette-io.js`:
  - `PALETTE_FORMATS = ['gpl', 'hex', 'pal', 'png']`
  - `formatFromFilename(filename) -> 'gpl'|'hex'|'pal'|'png'|null`
  - `paletteFilename(palette, ext) -> string`
  - `serializeGpl(palette) -> string`, `parseGpl(text) -> ParsedPalette`
  - `serializeHex(palette) -> string`, `parseHex(text) -> ParsedPalette`
  - `serializePal(palette) -> string`, `parsePal(text) -> ParsedPalette`
  - `serializePaletteText(palette, format) -> string`
  - `parsePaletteText(text, format) -> ParsedPalette`
  - where `ParsedPalette = { name: string, colors: [r,g,b,255][], lock: { size, reason } | null }`

- [ ] **Step 1: Write the failing tests**

Create `tests/palette-io.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE_FORMATS, formatFromFilename, paletteFilename,
  serializeGpl, parseGpl, serializeHex, parseHex, serializePal, parsePal,
  serializePaletteText, parsePaletteText,
} from '../js/core/palette-io.js';

function pal(overrides = {}) {
  return {
    id: 'p', name: 'My Palette', indexed: true,
    colors: [[255, 0, 0, 255], [0, 128, 0, 255], [0, 0, 0, 255]],
    empty: [false, false, true],
    emptyColor: [0, 0, 0, 255],
    lock: { size: 3, reason: 'NES' },
    ...overrides,
  };
}

test('formatFromFilename recognises the four formats and rejects anything else', () => {
  assert.deepEqual(PALETTE_FORMATS, ['gpl', 'hex', 'pal', 'png']);
  assert.equal(formatFromFilename('nes.gpl'), 'gpl');
  assert.equal(formatFromFilename('NES.GPL'), 'gpl');
  assert.equal(formatFromFilename('a.b.pal'), 'pal');
  assert.equal(formatFromFilename('notes.txt'), null);
  assert.equal(formatFromFilename('noextension'), null);
});

test('paletteFilename carries lock provenance, and sanitises path characters', () => {
  assert.equal(paletteFilename(pal(), 'gpl'), 'My Palette (NES 3).gpl');
  assert.equal(paletteFilename(pal({ lock: { size: 3, reason: '' } }), 'gpl'), 'My Palette (3).gpl');
  assert.equal(paletteFilename(pal({ lock: null }), 'hex'), 'My Palette.hex');
  assert.equal(paletteFilename(pal({ name: 'a/b:c', lock: null }), 'pal'), 'a_b_c.pal');
});

test('gpl round-trips name, colors and the lock comment', () => {
  const text = serializeGpl(pal());
  assert.match(text, /^GIMP Palette\r?\n/);
  assert.match(text, /Name: My Palette/);
  assert.match(text, /# Locked to 3 entries \(NES\)/);
  const back = parseGpl(text);
  assert.equal(back.name, 'My Palette');
  assert.deepEqual(back.colors, [[255, 0, 0, 255], [0, 128, 0, 255], [0, 0, 0, 255]]);
  assert.deepEqual(back.lock, { size: 3, reason: 'NES' });
});

test('gpl export writes every entry, empty slots included', () => {
  const lines = serializeGpl(pal()).trim().split(/\r?\n/);
  const colorLines = lines.filter(l => /^\s*\d+\s+\d+\s+\d+/.test(l));
  assert.equal(colorLines.length, 3);
});

test('gpl export omits the lock comment for an unlocked palette', () => {
  assert.doesNotMatch(serializeGpl(pal({ lock: null })), /Locked to/);
  assert.equal(parseGpl(serializeGpl(pal({ lock: null }))).lock, null);
});

test('gpl parse tolerates trailing color names, blank lines and unrelated comments', () => {
  const text = [
    'GIMP Palette', 'Name: Imported', 'Columns: 4', '# just a note', '',
    ' 17  34  51\tSteel', '255 255 255 White', 'garbage line',
  ].join('\n');
  const back = parseGpl(text);
  assert.equal(back.name, 'Imported');
  assert.deepEqual(back.colors, [[17, 34, 51, 255], [255, 255, 255, 255]]);
  assert.equal(back.lock, null);
});

test('hex round-trips one lowercase rrggbb per line and drops alpha', () => {
  const text = serializeHex(pal({ colors: [[255, 0, 0, 128], [0, 128, 0, 255]], empty: [false, false] }));
  assert.equal(text.trim(), 'ff0000\n008000');
  assert.deepEqual(parseHex(text).colors, [[255, 0, 0, 255], [0, 128, 0, 255]]);
});

test('hex parse tolerates # prefixes, whitespace and skips junk lines', () => {
  const back = parseHex('#FF0000\n  00ff00  \n\nnot-a-color\n#12345\n0000ff\n');
  assert.deepEqual(back.colors, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
  assert.equal(back.name, '');
  assert.equal(back.lock, null);
});

test('pal writes a JASC header whose third line is the entry count', () => {
  const lines = serializePal(pal()).trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(0, 3), ['JASC-PAL', '0100', '3']);
  assert.deepEqual(parsePal(serializePal(pal())).colors, pal().colors);
});

test('pal parse honours the declared count and rejects a non-JASC file', () => {
  const back = parsePal('JASC-PAL\r\n0100\r\n2\r\n1 2 3\r\n4 5 6\r\n7 8 9\r\n');
  assert.deepEqual(back.colors, [[1, 2, 3, 255], [4, 5, 6, 255]]);
  assert.throws(() => parsePal('not a palette'), /JASC-PAL/);
});

test('serializePaletteText and parsePaletteText dispatch by format, and refuse png', () => {
  assert.equal(serializePaletteText(pal(), 'hex'), serializeHex(pal()));
  assert.deepEqual(parsePaletteText(serializeGpl(pal()), 'gpl').lock, { size: 3, reason: 'NES' });
  assert.throws(() => serializePaletteText(pal(), 'png'), /png/);
  assert.throws(() => parsePaletteText('x', 'png'), /png/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
node --test tests/palette-io.test.mjs
```

Expected: FAIL — `Cannot find module .../js/core/palette-io.js`.

- [ ] **Step 3: Create `js/core/palette-io.js`**

```js
// Palette file formats: parse and serialize only. Deliberately free of DOM,
// host and pngcodec imports (pngcodec needs OffscreenCanvas) so the whole
// module runs under `node --test` -- the PNG helpers below the text formats
// are pure bitmap math for the same reason, and the actual encode/decode
// lives in the feature layer.
//
// Every format here is RGB-only: export drops alpha, import forces 255.
// Palettes in this app can carry alpha (the color panel has an alpha
// slider), so that loss is real and worth knowing about -- none of these
// four interchange formats has an alpha channel to put it in.
//
// Every entry is written, empty slots included: a palette locked to 54
// exports 54 entries, which is the point of locking it.

export const PALETTE_FORMATS = ['gpl', 'hex', 'pal', 'png'];

export function formatFromFilename(filename) {
  const parts = String(filename).split('.');
  if (parts.length < 2) return null;
  const ext = parts.pop().toLowerCase();
  return PALETTE_FORMATS.includes(ext) ? ext : null;
}

// `.hex` and `.png` have no metadata channel and `.pal` has no room for the
// reason, so the filename is where provenance survives for three of the
// four formats. Kept identical across all four so a set of exports of the
// same palette sorts together.
export function paletteFilename(palette, ext) {
  const suffix = palette.lock
    ? ` (${palette.lock.reason ? `${palette.lock.reason} ` : ''}${palette.lock.size})`
    : '';
  const base = `${palette.name}${suffix}`.replace(/[\\/:*?"<>|]/g, '_');
  return `${base}.${ext}`;
}

// ---- GIMP .gpl ----
// The only one of the four with a metadata channel: `Name:` is standard, and
// the lock rides in a `#` comment that every other .gpl reader ignores.
const GPL_LOCK_RE = /^#\s*Locked to\s+(\d+)\s+entries(?:\s*\(([^)]*)\))?/i;

export function serializeGpl(palette) {
  const lines = ['GIMP Palette', `Name: ${palette.name}`, 'Columns: 16'];
  if (palette.lock) lines.push(`# Locked to ${palette.lock.size} entries (${palette.lock.reason})`);
  for (const [r, g, b] of palette.colors) {
    lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseGpl(text) {
  let name = '', lock = null;
  const colors = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^GIMP Palette$/i.test(line) || /^Columns:/i.test(line)) continue;
    if (/^Name:/i.test(line)) { name = line.slice(5).trim(); continue; }
    if (line.startsWith('#')) {
      const m = line.match(GPL_LOCK_RE);
      if (m) lock = { size: Number(m[1]), reason: m[2] ?? '' };
      continue;
    }
    const rgb = readRgb(line);
    if (rgb) colors.push(rgb);
  }
  return { name, colors, lock };
}

// A .gpl color line is "r g b" plus an optional trailing color name, so read
// the first three fields and ignore the rest.
function readRgb(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map(Number);
  if (!rgb.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  return [rgb[0], rgb[1], rgb[2], 255];
}

// ---- plain hex ----
// One rrggbb per line. Written separately from core/palettes.js's
// parseHexColors, which splits on whitespace and validates nothing -- a
// hand-edited .hex file wants the `#` prefix tolerated and junk lines
// skipped rather than turned into NaN swatches.
export function serializeHex(palette) {
  const hex = palette.colors.map(([r, g, b]) =>
    [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
  return `${hex.join('\n')}\n`;
}

export function parseHex(text) {
  const colors = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(line)) continue;
    colors.push([
      parseInt(line.slice(0, 2), 16),
      parseInt(line.slice(2, 4), 16),
      parseInt(line.slice(4, 6), 16),
      255,
    ]);
  }
  return { name: '', colors, lock: null };
}

// ---- JASC .pal ----
// Header is JASC-PAL / 0100 / count, so the entry count is self-evident in
// the file itself -- that IS this format's provenance for a locked palette.
// CRLF because that is what the format's own tooling writes.
export function serializePal(palette) {
  const lines = ['JASC-PAL', '0100', String(palette.colors.length)];
  for (const [r, g, b] of palette.colors) lines.push(`${r} ${g} ${b}`);
  return `${lines.join('\r\n')}\r\n`;
}

export function parsePal(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!/^JASC-PAL$/i.test(lines[0] ?? '')) throw new Error('not a JASC-PAL file');
  const declared = Number(lines[2]);
  const body = lines.slice(3);
  const limit = Number.isInteger(declared) && declared >= 0 ? declared : body.length;
  const colors = [];
  for (const line of body.slice(0, limit)) {
    const rgb = readRgb(line);
    if (rgb) colors.push(rgb);
  }
  return { name: '', colors, lock: null };
}

// ---- dispatch ----
export function serializePaletteText(palette, format) {
  if (format === 'gpl') return serializeGpl(palette);
  if (format === 'hex') return serializeHex(palette);
  if (format === 'pal') return serializePal(palette);
  throw new Error(`not a text palette format: ${format}`);
}

export function parsePaletteText(text, format) {
  if (format === 'gpl') return parseGpl(text);
  if (format === 'hex') return parseHex(text);
  if (format === 'pal') return parsePal(text);
  throw new Error(`not a text palette format: ${format}`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
node --test tests/palette-io.test.mjs
```

Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```powershell
git add js/core/palette-io.js tests/palette-io.test.mjs
git commit -m "feat(palettes): add .gpl/.hex/.pal palette parsers and serializers"
```

---

### Task 4: `js/core/palette-io.js` — PNG swatch strip

Pure bitmap math only. `encodePng`/`decodePng` need `OffscreenCanvas`, so they stay in the feature layer (Task 9) and these two helpers stay node-testable.

**Files:**
- Modify: `js/core/palette-io.js` (append)
- Test: `tests/palette-io.test.mjs` (append)

**Interfaces:**
- Consumes: `colorFrequency` from `js/core/quantize.js`.
- Produces:
  - `PALETTE_PNG_CELL = 16` — swatch size in pixels
  - `paletteToStripBitmap(palette, { cell = PALETTE_PNG_CELL, columns = 16 } = {}) -> { width, height, data }`
  - `bitmapToPaletteColors(bitmap) -> [r,g,b,255][]`

- [ ] **Step 1: Write the failing tests**

Append the tests to `tests/palette-io.test.mjs`. First, at the **top** of that file, extend the `palette-io.js` import list with `PALETTE_PNG_CELL, paletteToStripBitmap, bitmapToPaletteColors` and add one more import line:

```js
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
```

Then append:

```js
test('paletteToStripBitmap lays every entry out as an opaque cell, wrapping into rows', () => {
  const p = pal({ colors: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]], empty: [false, false, false] });
  const bmp = paletteToStripBitmap(p, { cell: 2, columns: 2 });
  assert.equal(bmp.width, 4);
  assert.equal(bmp.height, 4);              // 3 entries over 2 columns -> 2 rows
  assert.deepEqual(getPixel(bmp, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(bmp, 2, 0), [0, 255, 0, 255]);
  assert.deepEqual(getPixel(bmp, 0, 2), [0, 0, 255, 255]);
  assert.deepEqual(getPixel(bmp, 3, 3), [0, 0, 0, 0]);   // unused tail cell stays transparent
});

test('paletteToStripBitmap writes empty slots too -- an exported palette keeps its entry count', () => {
  const p = pal({ colors: [[1, 1, 1, 255], [0, 0, 0, 255]], empty: [false, true], lock: { size: 2, reason: '' } });
  const bmp = paletteToStripBitmap(p, { cell: 1, columns: 2 });
  assert.equal(bmp.width, 2);
  assert.deepEqual(getPixel(bmp, 1, 0), [0, 0, 0, 255]);
});

test('paletteToStripBitmap on an empty palette produces a 1x1 transparent bitmap rather than a zero-size one', () => {
  const bmp = paletteToStripBitmap(pal({ colors: [], empty: [], lock: null }), { cell: 4, columns: 4 });
  assert.equal(bmp.width, 1);
  assert.equal(bmp.height, 1);
});

test('bitmapToPaletteColors returns unique opaque colors, most frequent first', () => {
  const b = createBitmap(4, 1);
  setPixel(b, 0, 0, [9, 9, 9, 255]);
  setPixel(b, 1, 0, [1, 2, 3, 255]);
  setPixel(b, 2, 0, [9, 9, 9, 255]);
  setPixel(b, 3, 0, [0, 0, 0, 0]);
  assert.deepEqual(bitmapToPaletteColors(b), [[9, 9, 9, 255], [1, 2, 3, 255]]);
});

test('bitmapToPaletteColors collapses colors that differ only in alpha', () => {
  const b = createBitmap(2, 1);
  setPixel(b, 0, 0, [5, 5, 5, 255]);
  setPixel(b, 1, 0, [5, 5, 5, 128]);
  assert.deepEqual(bitmapToPaletteColors(b), [[5, 5, 5, 255]]);
});

test('a palette survives a strip round-trip when its colors are distinct', () => {
  const colors = [[10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255]];
  const bmp = paletteToStripBitmap(pal({ colors, empty: [false, false, false] }), { cell: 3, columns: 3 });
  const back = bitmapToPaletteColors(bmp);
  assert.equal(back.length, 3);
  for (const c of colors) assert.ok(back.some(b => b.join() === c.join()), `${c} survived`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
node --test tests/palette-io.test.mjs
```

Expected: FAIL — no export named `paletteToStripBitmap`.

- [ ] **Step 3: Append the PNG helpers to `js/core/palette-io.js`**

Add the import at the top of the file, below the header comment:

```js
import { colorFrequency } from './quantize.js';
```

Then append:

```js
// ---- PNG swatch strip ----
// The least precise of the four formats: a PNG carries no entry order, no
// name and no count, so an import can only recover the distinct colors --
// ordered by frequency, which is not the order they were authored in.
// Round-tripping a palette through PNG is lossy by construction; the format
// exists because swatch strips are how palettes get shared in practice.

export const PALETTE_PNG_CELL = 16;

export function paletteToStripBitmap(palette, { cell = PALETTE_PNG_CELL, columns = 16 } = {}) {
  const n = palette.colors.length;
  // A zero-width bitmap is not a thing any encoder will accept, and an
  // empty palette is a legitimate thing to export.
  if (n === 0) return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const cols = Math.max(1, Math.min(columns, n));
  const rows = Math.ceil(n / cols);
  const width = cols * cell, height = rows * cell;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = palette.colors[i];
    const ox = (i % cols) * cell, oy = Math.floor(i / cols) * cell;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const o = ((oy + y) * width + (ox + x)) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

// colorFrequency keys on full RGBA, so force opacity first and then dedupe:
// two source pixels that differ only in alpha are one palette color here.
export function bitmapToPaletteColors(bitmap) {
  const seen = new Set(), out = [];
  for (const [r, g, b] of colorFrequency([bitmap])) {
    const key = `${r},${g},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([r, g, b, 255]);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
node --test tests/palette-io.test.mjs
```

Expected: PASS (18 tests).

- [ ] **Step 5: Confirm the module stayed pure**

```powershell
node --test tests/architecture.test.mjs
Select-String -Path js/core/palette-io.js -Pattern "document\.|window\.|OffscreenCanvas|pngcodec"
```

Expected: architecture tests PASS, and the `Select-String` prints nothing.

- [ ] **Step 6: Commit**

```powershell
git add js/core/palette-io.js tests/palette-io.test.mjs
git commit -m "feat(palettes): add PNG swatch-strip palette encoding helpers"
```

---

### Task 5: The shared undoable command family

One family for all three modes, replacing the three per-mode copies. Every command is `PROJECT_SCOPE`.

**Files:**
- Create: `js/features/palettes/palette-commands.js`
- Test: `tests/palette-commands.test.mjs` (create)

**Interfaces:**
- Consumes: everything from Tasks 1-2 (`createPalette`, `setEntry`, `clearEntry`, `addSwatch`, `removeSwatch`, `moveSwatch`, `setEmptyColor`, `setLock`, `sortOrder`, `applyOrder`, `countPaletteUsage`, `normalizePalette`), plus `PROJECT_SCOPE` from `js/host/history-service.js` and `sheetLayers` from `js/core/model.js`.
- Produces, all from `js/features/palettes/palette-commands.js`. Every one takes `services` (`{ store, projects, history }`) first and returns `void`:
  - `createNewPalette(services, palette)` — pushes an already-built palette and selects it
  - `duplicatePalette(services, paletteId)`
  - `renamePalette(services, paletteId, name)`
  - `deletePalette(services, paletteId)`
  - `addPaletteSwatch(services, paletteId, color)`
  - `setSwatchColor(services, paletteId, index, color)`
  - `remapSwatchColor(services, paletteId, index, color)`
  - `clearSwatch(services, paletteId, index)`
  - `removePaletteSwatch(services, paletteId, index)`
  - `movePaletteSwatch(services, paletteId, from, to)`
  - `sortPalette(services, paletteId, mode)`
  - `setPaletteLock(services, paletteId, size, reason)`
  - `setPaletteEmptyColor(services, paletteId, color)`
  - `setPaletteIndexed(services, paletteId, indexed)`
  - `countSwatchPixels(services, color) -> number` — **not** a command; the UI calls it to decide between `setSwatchColor` and `remapSwatchColor`

- [ ] **Step 1: Write the failing tests**

Create `tests/palette-commands.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { createBitmap } from '../js/core/pixels.js';
import { createPalette, setEntry } from '../js/core/palettes.js';
import {
  createNewPalette, duplicatePalette, renamePalette, deletePalette,
  addPaletteSwatch, setSwatchColor, remapSwatchColor, clearSwatch,
  removePaletteSwatch, movePaletteSwatch, sortPalette, setPaletteLock,
  setPaletteEmptyColor, setPaletteIndexed, countSwatchPixels,
} from '../js/features/palettes/palette-commands.js';

function makeServices(project, activeSheetId = null) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: activeSheetId ? { kind: 'sprite-sheet', id: activeSheetId } : null });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makePalette(name = 'Pal') {
  const p = createPalette({ name, indexed: true, size: 4, lockReason: 'NES' });
  [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]]
    .forEach((c, i) => setEntry(p, i, c));
  return p;
}

function fillBitmap(bmp, color) {
  for (let i = 0; i < bmp.data.length; i += 4) {
    bmp.data[i] = color[0]; bmp.data[i + 1] = color[1]; bmp.data[i + 2] = color[2]; bmp.data[i + 3] = color[3];
  }
  return bmp;
}

function projectWithSheet(palettes, bmp) {
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: bmp.width, height: bmp.height, kind: 'sprite', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  return { sheets: [sheet], maps: [], palettes, activePaletteId: palettes[0]?.id ?? null };
}

test('createNewPalette adds and selects it; undo removes it and restores the old selection', () => {
  const existing = makePalette('Old');
  const project = { sheets: [], maps: [], palettes: [existing], activePaletteId: existing.id };
  const services = makeServices(project);
  const fresh = makePalette('Fresh');

  createNewPalette(services, fresh);
  assert.deepEqual(project.palettes.map(p => p.name), ['Old', 'Fresh']);
  assert.equal(project.activePaletteId, fresh.id);

  services.history.undo();
  assert.deepEqual(project.palettes.map(p => p.name), ['Old']);
  assert.equal(project.activePaletteId, existing.id);

  services.history.redo();
  assert.equal(project.activePaletteId, fresh.id);
});

test('duplicatePalette produces an independent copy with a new id', () => {
  const src = makePalette();
  const project = { sheets: [], maps: [], palettes: [src], activePaletteId: src.id };
  const services = makeServices(project);

  duplicatePalette(services, src.id);
  const copy = project.palettes[1];
  assert.notEqual(copy.id, src.id);
  assert.match(copy.name, /copy/i);
  assert.deepEqual(copy.colors, src.colors);
  copy.colors[0][0] = 1;
  assert.equal(src.colors[0][0], 255, 'the copy must not alias the source colors');

  services.history.undo();
  assert.equal(project.palettes.length, 1);
});

test('renamePalette is undoable', () => {
  const p = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  renamePalette(services, p.id, 'Renamed');
  assert.equal(p.name, 'Renamed');
  services.history.undo();
  assert.equal(p.name, 'Pal');
});

test('deletePalette restores the palette at its original position on undo', () => {
  const a = makePalette('A'), b = makePalette('B'), c = makePalette('C');
  const project = { sheets: [], maps: [], palettes: [a, b, c], activePaletteId: b.id };
  const services = makeServices(project);

  deletePalette(services, b.id);
  assert.deepEqual(project.palettes.map(p => p.name), ['A', 'C']);
  assert.notEqual(project.activePaletteId, b.id);

  services.history.undo();
  assert.deepEqual(project.palettes.map(p => p.name), ['A', 'B', 'C']);
  assert.equal(project.activePaletteId, b.id);
});

test('addPaletteSwatch fills a locked palette empty slot and undo re-empties exactly that slot', () => {
  const p = createPalette({ name: 'L', indexed: true, size: 2, lockReason: 'x' });
  setEntry(p, 0, [1, 1, 1, 255]);
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  addPaletteSwatch(services, p.id, [7, 7, 7, 255]);
  assert.deepEqual(p.colors[1], [7, 7, 7, 255]);
  assert.deepEqual(p.empty, [false, false]);

  services.history.undo();
  assert.deepEqual(p.empty, [false, true]);
  assert.deepEqual(p.colors[1], p.emptyColor);
});

test('addPaletteSwatch on a full locked palette records no history at all', () => {
  const p = createPalette({ name: 'L', indexed: true, size: 1, lockReason: 'x' });
  setEntry(p, 0, [1, 1, 1, 255]);
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  addPaletteSwatch(services, p.id, [7, 7, 7, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('setSwatchColor never touches pixels, and is a no-op when the color is unchanged', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), p.colors[0]);
  const services = makeServices(projectWithSheet([p], bmp), 'sheet1');

  setSwatchColor(services, p.id, 0, [9, 9, 9, 255]);
  assert.deepEqual(p.colors[0], [9, 9, 9, 255]);
  assert.equal(bmp.data[0], 255, 'setSwatchColor must not remap pixels');

  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);

  setSwatchColor(services, p.id, 0, [255, 0, 0, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('remapSwatchColor rewrites the entry and matching pixels in one undo step', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), p.colors[0]);
  const before = Uint8ClampedArray.from(bmp.data);
  const services = makeServices(projectWithSheet([p], bmp), 'sheet1');

  remapSwatchColor(services, p.id, 0, [9, 8, 7, 255]);
  assert.deepEqual(p.colors[0], [9, 8, 7, 255]);
  assert.equal(bmp.data[0], 9);

  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);
  assert.deepEqual(Array.from(bmp.data), Array.from(before));
});

test('remapSwatchColor works with no active sheet -- the maps-mode case that used to be a silent no-op', () => {
  const p = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  remapSwatchColor(services, p.id, 0, [1, 1, 1, 255]);
  assert.deepEqual(p.colors[0], [1, 1, 1, 255]);
  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);
});

test('countSwatchPixels counts exact matches on the active sheet and returns 0 with no sheet', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), p.colors[0]);
  assert.equal(countSwatchPixels(makeServices(projectWithSheet([p], bmp), 'sheet1'), p.colors[0]), 4);
  assert.equal(countSwatchPixels(makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id }), p.colors[0]), 0);
});

test('clearSwatch and removePaletteSwatch are undoable and respect the lock', () => {
  const locked = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [locked], activePaletteId: locked.id });

  clearSwatch(services, locked.id, 1);
  assert.equal(locked.empty[1], true);
  assert.equal(locked.colors.length, 4);
  services.history.undo();
  assert.deepEqual(locked.colors[1], [0, 255, 0, 255]);
  assert.equal(locked.empty[1], false);

  // locked: remove clears in place rather than shrinking
  removePaletteSwatch(services, locked.id, 1);
  assert.equal(locked.colors.length, 4);
  assert.equal(locked.empty[1], true);
  services.history.undo();
  assert.deepEqual(locked.colors[1], [0, 255, 0, 255]);
});

test('removePaletteSwatch splices an unlocked palette and undo restores order', () => {
  const p = createPalette({ name: 'free' });
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  addPaletteSwatch(services, p.id, [1, 1, 1, 255]);
  addPaletteSwatch(services, p.id, [2, 2, 2, 255]);

  removePaletteSwatch(services, p.id, 0);
  assert.deepEqual(p.colors, [[2, 2, 2, 255]]);
  services.history.undo();
  assert.deepEqual(p.colors, [[1, 1, 1, 255], [2, 2, 2, 255]]);
});

test('movePaletteSwatch and sortPalette reorder colors and flags together, undoably', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3, lockReason: '' });
  setEntry(p, 0, [255, 255, 255, 255]);
  setEntry(p, 2, [0, 0, 0, 255]);

  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  movePaletteSwatch(services, p.id, 2, 0);
  assert.deepEqual(p.colors[0], [0, 0, 0, 255]);
  assert.deepEqual(p.empty, [false, false, true]);
  services.history.undo();
  assert.deepEqual(p.empty, [false, true, false]);

  sortPalette(services, p.id, 'luminance');
  assert.deepEqual(p.colors[p.colors.length - 1], [255, 255, 255, 255]);
  assert.equal(p.colors.length, 3);
  assert.equal(p.empty.length, 3);
  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 255, 255, 255]);
});

test('setPaletteLock pads, truncates and unlocks, all undoable byte-for-byte', () => {
  const p = createPalette({ name: 'free' });
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  addPaletteSwatch(services, p.id, [1, 1, 1, 255]);

  setPaletteLock(services, p.id, 4, 'NES');
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
  assert.deepEqual(p.empty, [false, true, true, true]);

  setPaletteLock(services, p.id, 2, 'Game Boy');
  assert.equal(p.colors.length, 2);

  services.history.undo();
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });

  services.history.undo();
  assert.equal(p.lock, null);
  assert.deepEqual(p.colors, [[1, 1, 1, 255]]);
});

test('setPaletteEmptyColor re-syncs empty slots and undo restores both color and flags', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2, lockReason: '' });
  setEntry(p, 0, [1, 1, 1, 255]);
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  setPaletteEmptyColor(services, p.id, [200, 0, 200, 255]);
  assert.deepEqual(p.emptyColor, [200, 0, 200, 255]);
  assert.deepEqual(p.colors[1], [200, 0, 200, 255]);
  assert.deepEqual(p.colors[0], [1, 1, 1, 255]);

  services.history.undo();
  assert.deepEqual(p.emptyColor, [0, 0, 0, 255]);
  assert.deepEqual(p.colors[1], [0, 0, 0, 255]);
});

test('setPaletteIndexed toggles only the brush-snap flag, never the size', () => {
  const p = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  setPaletteIndexed(services, p.id, false);
  assert.equal(p.indexed, false);
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
  services.history.undo();
  assert.equal(p.indexed, true);
});

test('every palette command lands on the project scope, so it survives a document switch', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(1, 1), [0, 0, 0, 255]);
  const project = projectWithSheet([p], bmp);
  const services = makeServices(project, 'sheet1');

  setSwatchColor(services, p.id, 0, [3, 3, 3, 255]);
  services.store.updateSession({ activeDocument: { kind: 'map', id: 'map1' } });
  assert.equal(services.history.canUndo(), true, 'palette edits stay undoable from another document');
  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);
});

test('commands re-resolve their palette by id, so undo hits the right one after the selection moves', () => {
  const first = makePalette('First'), second = makePalette('Second');
  const project = { sheets: [], maps: [], palettes: [first, second], activePaletteId: first.id };
  const services = makeServices(project);

  setSwatchColor(services, first.id, 0, [10, 20, 30, 255]);
  project.activePaletteId = second.id;
  services.history.undo();
  assert.deepEqual(first.colors[0], [255, 0, 0, 255]);
  assert.deepEqual(second.colors[0], [255, 0, 0, 255]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```powershell
node --test tests/palette-commands.test.mjs
```

Expected: FAIL — `Cannot find module .../js/features/palettes/palette-commands.js`.

- [ ] **Step 3: Create `js/features/palettes/palette-commands.js`**

```js
// The one undoable palette command family, shared by every mode.
//
// This replaces three byte-identical per-mode modules
// (js/modes/{sprites,tiles,maps}/application/commands/palette-commands.js).
// Nothing about editing a palette is mode-specific -- sprites, tiles and
// maps all share one project-level palette list -- so per-mode registration
// bought nothing and cost a real bug: maps mode registered neither command,
// which made editing a swatch there a silent no-op.
//
// Every command runs at PROJECT_SCOPE (see js/host/history-service.js): a
// palette belongs to the project, not to whichever sheet or map is open, so
// scoping one to the active document would strand it the moment the user
// switched away.
//
// No browser globals here. Prompts and confirmations -- "remap N pixels?",
// "truncate this palette?" -- belong to the caller, which is why
// setSwatchColor and remapSwatchColor stay two commands and countSwatchPixels
// is a plain query rather than a command.
import { PROJECT_SCOPE } from '../../host/history-service.js';
import { sheetLayers } from '../../core/model.js';
import { cloneBitmap, blitRegion, colorsEqual } from '../../core/pixels.js';
import { remapColor, setEntry, clearEntry, addSwatch, removeSwatch, moveSwatch,
  setEmptyColor, setLock, sortOrder, applyOrder, countPaletteUsage } from '../../core/palettes.js';

function project(services) { return services.projects.project; }

function paletteById(services, id) {
  return project(services)?.palettes.find(p => p.id === id) ?? null;
}

function activeSheet(services) {
  const doc = services.store?.getState().session.activeDocument;
  if (!doc || (doc.kind !== 'sprite-sheet' && doc.kind !== 'tile-sheet')) return null;
  return project(services)?.sheets.find(sheet => sheet.id === doc.id) ?? null;
}

function activeBitmaps(services) {
  const sheet = activeSheet(services);
  return sheet ? sheetLayers(sheet).map(layer => layer.bitmap) : [];
}

// Every command re-resolves the palette by id inside do() and undo() rather
// than closing over the object: the project can be replaced wholesale (file
// load, autosave restore) between a do and its undo.
function run(services, label, apply, revert) {
  services.history.execute({
    label,
    do: () => services.projects.mutate(label, apply),
    undo: () => services.projects.mutate(label, revert),
  }, { scope: PROJECT_SCOPE });
}

function runOnPalette(services, paletteId, label, apply, revert) {
  run(services,
    label,
    proj => { const p = proj.palettes.find(x => x.id === paletteId); if (p) apply(p, proj); },
    proj => { const p = proj.palettes.find(x => x.id === paletteId); if (p) revert(p, proj); });
}

// Snapshot/restore of the two paired arrays plus the lock -- the honest way
// to undo anything that changes length or order, and short enough that
// per-operation inverse logic would only be a way to get it subtly wrong.
function snapshot(p) {
  return { colors: p.colors.map(c => [...c]), empty: [...p.empty], emptyColor: [...p.emptyColor], lock: p.lock ? { ...p.lock } : null };
}
function restore(p, snap) {
  p.colors = snap.colors.map(c => [...c]);
  p.empty = [...snap.empty];
  p.emptyColor = [...snap.emptyColor];
  p.lock = snap.lock ? { ...snap.lock } : null;
}

// ---- palette lifecycle ----

// Takes an already-built palette (from createPalette, clonePalette, an
// import, or artwork) so the caller owns naming and shape; this only makes
// adding it undoable. Selecting it is part of the same step: undo has to put
// the previous selection back or the user lands on a palette that is gone.
export function createNewPalette(services, palette) {
  const previousActiveId = project(services)?.activePaletteId ?? null;
  run(services, 'new palette',
    proj => {
      if (!proj.palettes.some(p => p.id === palette.id)) proj.palettes.push(palette);
      proj.activePaletteId = palette.id;
    },
    proj => {
      proj.palettes = proj.palettes.filter(p => p.id !== palette.id);
      proj.activePaletteId = previousActiveId;
    });
}

export function duplicatePalette(services, paletteId) {
  const source = paletteById(services, paletteId);
  if (!source) return;
  const copy = {
    ...source,
    id: `${source.id}-copy-${Date.now().toString(36)}`,
    name: `${source.name} copy`,
    colors: source.colors.map(c => [...c]),
    empty: [...source.empty],
    emptyColor: [...source.emptyColor],
    lock: source.lock ? { ...source.lock } : null,
  };
  createNewPalette(services, copy);
}

export function renamePalette(services, paletteId, name) {
  const target = paletteById(services, paletteId);
  if (!target || target.name === name) return;
  const before = target.name;
  runOnPalette(services, paletteId, 'rename palette',
    p => { p.name = name; },
    p => { p.name = before; });
}

export function deletePalette(services, paletteId) {
  const proj = project(services);
  const at = proj?.palettes.findIndex(p => p.id === paletteId) ?? -1;
  if (at === -1) return;
  const removed = proj.palettes[at];
  const previousActiveId = proj.activePaletteId;
  run(services, 'delete palette',
    target => {
      target.palettes.splice(at, 1);
      if (target.activePaletteId === paletteId) target.activePaletteId = target.palettes[0]?.id ?? null;
    },
    target => {
      target.palettes.splice(at, 0, removed);
      target.activePaletteId = previousActiveId;
    });
}

// ---- swatch edits ----

export function addPaletteSwatch(services, paletteId, color) {
  const target = paletteById(services, paletteId);
  // A full locked palette has nowhere to put it: record nothing, so the
  // user's undo stack does not fill with steps that changed nothing.
  if (!target || (target.lock && !target.empty.includes(true))) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'add swatch',
    p => { addSwatch(p, color); },
    p => restore(p, before));
}

export function setSwatchColor(services, paletteId, index, color) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = [...target.colors[index]];
  const wasEmpty = target.empty[index];
  if (colorsEqual(before, color) && !wasEmpty) return;
  runOnPalette(services, paletteId, 'edit palette color',
    p => { setEntry(p, index, color); },
    p => { p.colors[index] = [...before]; p.empty[index] = wasEmpty; });
}

// The palette entry AND the pixels move in one command, so undo restores
// both -- splitting them would let a half-undo leave the artwork referring
// to a color the palette no longer has. layerPatches is collected up front
// over the active sheet's layers only, matching what the user was told the
// remap would touch.
export function remapSwatchColor(services, paletteId, index, color) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = [...target.colors[index]];
  const wasEmpty = target.empty[index];
  if (colorsEqual(before, color) && !wasEmpty) return;
  const layerPatches = activeBitmaps(services).map(bitmap => {
    const after = cloneBitmap(bitmap);
    remapColor(after, before, color);
    return { bitmap, before: cloneBitmap(bitmap), after };
  });
  runOnPalette(services, paletteId, 'remap palette color',
    p => {
      setEntry(p, index, color);
      for (const lp of layerPatches) blitRegion(lp.bitmap, lp.after, 0, 0);
    },
    p => {
      p.colors[index] = [...before]; p.empty[index] = wasEmpty;
      for (const lp of layerPatches) blitRegion(lp.bitmap, lp.before, 0, 0);
    });
}

// Not a command: a query the UI runs to decide whether to offer the remap.
export function countSwatchPixels(services, color) {
  let n = 0;
  for (const bmp of activeBitmaps(services)) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === color[0] && d[i + 1] === color[1] && d[i + 2] === color[2] && d[i + 3] === color[3]) n++;
    }
  }
  return n;
}

export function clearSwatch(services, paletteId, index) {
  const target = paletteById(services, paletteId);
  if (!target || target.empty[index]) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'clear swatch',
    p => clearEntry(p, index),
    p => restore(p, before));
}

export function removePaletteSwatch(services, paletteId, index) {
  const target = paletteById(services, paletteId);
  if (!target || index < 0 || index >= target.colors.length) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'remove swatch',
    p => removeSwatch(p, index),
    p => restore(p, before));
}

export function movePaletteSwatch(services, paletteId, from, to) {
  const target = paletteById(services, paletteId);
  if (!target || from === to) return;
  if (to < 0 || to >= target.colors.length) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'move swatch',
    p => moveSwatch(p, from, to),
    p => restore(p, before));
}

// mode: 'hue' | 'luminance' | 'usage'. Usage counts come from the active
// sheet, so sorting by usage in maps mode simply leaves the order alone.
export function sortPalette(services, paletteId, mode) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const usage = mode === 'usage' ? countPaletteUsage(target, activeBitmaps(services)) : null;
  const order = sortOrder(target.colors, mode, usage);
  if (order.every((v, i) => v === i)) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, `sort palette by ${mode}`,
    p => applyOrder(p, order),
    p => restore(p, before));
}

// ---- palette-level settings ----

// size === null unlocks. A lossy truncate is the CALLER's to confirm first.
export function setPaletteLock(services, paletteId, size, reason = '') {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, size === null ? 'unlock palette' : 'lock palette size',
    p => setLock(p, size, reason),
    p => restore(p, before));
}

export function setPaletteEmptyColor(services, paletteId, color) {
  const target = paletteById(services, paletteId);
  if (!target || colorsEqual(target.emptyColor, color)) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'set unset color',
    p => setEmptyColor(p, color),
    p => restore(p, before));
}

export function setPaletteIndexed(services, paletteId, indexed) {
  const target = paletteById(services, paletteId);
  if (!target || target.indexed === !!indexed) return;
  runOnPalette(services, paletteId, indexed ? 'make palette indexed' : 'make palette free',
    p => { p.indexed = !!indexed; },
    p => { p.indexed = !indexed; });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```powershell
node --test tests/palette-commands.test.mjs
```

Expected: PASS (18 tests). If `colorsEqual` is not exported from `js/core/pixels.js`, check its actual export list — the existing `js/modes/sprites/application/commands/palette-commands.js:15` imports it from there, so it is available.

- [ ] **Step 5: Confirm no browser globals leaked in**

```powershell
Select-String -Path js/features/palettes/palette-commands.js -Pattern "document\.|window\.|alert\(|confirm\(|prompt\("
```

Expected: no output.

- [ ] **Step 6: Commit**

```powershell
git add js/features/palettes/palette-commands.js tests/palette-commands.test.mjs
git commit -m "feat(palettes): add the shared undoable palette command family"
```

---

### Task 6: Retire the three per-mode modules and retarget the Colors panel

Deletes the duplication and fixes the maps-mode no-op by routing the Colors panel's existing double-click through the shared family.

**Files:**
- Delete: `js/modes/sprites/application/commands/palette-commands.js`, `js/modes/tiles/application/commands/palette-commands.js`, `js/modes/maps/application/commands/palette-commands.js`
- Delete: `tests/sprites-palette-commands.test.mjs`, `tests/tiles-palette-commands.test.mjs`, `tests/maps-palette-commands.test.mjs`
- Modify: `js/modes/sprites/contributions.js:30,88-89`, `js/modes/tiles/contributions.js:29,78-79`, `js/modes/maps/contributions.js:13,37-38`
- Modify: `js/components/panels/color-panel.js` (imports, `editIndexedEntry`, `btnAddSwatch`, `refreshSwatchStrip`)
- Modify: `tests/builtinmodes.test.mjs`

**Interfaces:**
- Consumes: the whole command family from Task 5.
- Produces: no new exports. `sprites.editPaletteColor`, `sprites.remapPaletteColor`, `tiles.editPaletteColor`, `tiles.remapPaletteColor`, `maps.editPaletteColor`, `maps.remapPaletteColor` cease to exist.

- [ ] **Step 1: Update the failing test first**

In `tests/builtinmodes.test.mjs`, remove `'sprites.editPaletteColor'` and `'sprites.remapPaletteColor'` from the expected sprites id list (lines 54 and 56). Do the same for the `tiles.*` and `maps.*` expected lists in the same file — locate them with:

```powershell
Select-String -Path tests/builtinmodes.test.mjs -Pattern "PaletteColor"
```

- [ ] **Step 2: Run it to verify it fails**

```powershell
node --test tests/builtinmodes.test.mjs
```

Expected: FAIL — the registries still contain the six ids the expectation no longer lists.

- [ ] **Step 3: Delete the three modules, their tests, and their registrations**

```powershell
git rm js/modes/sprites/application/commands/palette-commands.js js/modes/tiles/application/commands/palette-commands.js js/modes/maps/application/commands/palette-commands.js
git rm tests/sprites-palette-commands.test.mjs tests/tiles-palette-commands.test.mjs tests/maps-palette-commands.test.mjs
```

Then remove, by hand, from each `contributions.js`:

- `js/modes/sprites/contributions.js` — the import on line 30 and the two `command('sprites.editPaletteColor', ...)` / `command('sprites.remapPaletteColor', ...)` lines (88-89)
- `js/modes/tiles/contributions.js` — the import on line 29 and the two `api.commands.register({ id: 'tiles.editPaletteColor'... })` / `'tiles.remapPaletteColor'` lines (78-79)
- `js/modes/maps/contributions.js` — the import on line 13 and the two `api.commands.register({ id: 'maps.editPaletteColor'... })` / `'maps.remapPaletteColor'` lines (37-38)

- [ ] **Step 4: Retarget `js/components/panels/color-panel.js`**

Replace the `dispatch`/`currentModeId` helpers (lines 14-24) — `dispatch` is no longer used by this panel — with a services accessor, and swap the palette imports. The new import block and helper:

```js
import { createPalette, INDEXED_SIZE_PRESETS } from '../../core/palettes.js';
import { addPaletteSwatch, setSwatchColor, remapSwatchColor, countSwatchPixels, createNewPalette }
  from '../../features/palettes/palette-commands.js';
```

Remove the now-unused `addSwatch`, `removeSwatch` and `PROJECT_SCOPE` imports, and add:

```js
// The palette command family takes the host's services directly -- palettes
// are project-level, so there is no mode registry to route through.
function services() {
  const host = getEditorHost();
  return { store: host.store, projects: host.projects, history: host.history };
}
```

Replace `editIndexedEntry` (lines 156-194) — the whole leading comment block goes with it — with:

```js
  // Decides WHICH command to run (a plain edit vs. a remap that also rewrites
  // pixels) and how many pixels a remap would touch. The commands themselves
  // are in js/features/palettes/palette-commands.js, shared by every mode --
  // this used to dispatch mode-scoped ids, which is why editing a swatch in
  // maps mode did nothing at all.
  function editSwatch(pal, index) {
    const old = pal.colors[index];
    const paletteId = pal.id;
    const input = hiddenColorInput();
    document.body.appendChild(input);
    input.value = rgbaToHex(old);
    input.addEventListener('change', () => {
      const [r, g, b] = hexToRgb(input.value);
      const to = [r, g, b, 255];
      document.body.removeChild(input);
      if (r === old[0] && g === old[1] && b === old[2]) return;

      const count = countSwatchPixels(services(), old);
      if (count === 0) {
        setSwatchColor(services(), paletteId, index, to);
        return;
      }
      if (!confirmOrAuto(`Remap ${count} pixels of old color on active sheet?`)) return;
      remapSwatchColor(services(), paletteId, index, to);
    });
    input.click();
  }
```

(The `refreshSwatchStrip()` calls the old version made are gone: `HistoryService` marks the project dirty on every `do()`, and this panel already redraws from `history.subscribe` — see `disposeHistory` at the bottom of the file.)

Update `refreshSwatchStrip` (lines 196-212) so both `indexed`-keyed behaviors move to `lock`:

```js
  function refreshSwatchStrip() {
    swatchStrip.innerHTML = '';
    const pal = currentPalette();
    // A locked palette can still take a swatch while it has an empty slot;
    // only a full one has nowhere to put it.
    btnAddSwatch.style.display = (pal && (!pal.lock || pal.empty.includes(true))) ? '' : 'none';
    if (!pal) return;
    pal.colors.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = pal.empty[i] ? 'palette-swatch is-empty' : 'palette-swatch';
      sw.style.background = cssColor(c);
      sw.title = pal.lock ? `index ${i}` : '';
      sw.addEventListener('click', () => { updateDrawingSettings({ primary: [...c] }); primaryEditor.sync(); });
      sw.addEventListener('contextmenu', (e) => { e.preventDefault(); updateDrawingSettings({ secondary: [...c] }); secondaryEditor.sync(); });
      // Every palette is editable now, not just indexed ones.
      sw.addEventListener('dblclick', () => editSwatch(pal, i));
      swatchStrip.appendChild(sw);
    });
  }
```

Replace the `btnAddSwatch` handler (lines 261-269) and the `commitAddPalette` helper (lines 243-259) plus `runPaletteCommand`/`paletteById` (lines 237-242) — all four are superseded by the command family:

```js
  btnAddSwatch.addEventListener('click', () => {
    const pal = currentPalette();
    if (!pal) return;
    addPaletteSwatch(services(), pal.id, [...drawingSettings().primary]);
  });
```

Replace the two `commitAddPalette(...)` call sites with `createNewPalette(services(), p)` — in the New-palette dialog's Create handler (line 302) and the system-palette card click (line 337). In the Create handler, pass the lock reason through:

```js
    const p = createPalette({
      name: npName.value.trim() || 'Palette',
      indexed,
      size,
      lockReason: size > 0 ? 'custom' : '',
    });
    dlgNew.close();
    createNewPalette(services(), p);
```

Finally, drop the now-unused `PROJECT_SCOPE` import and the `// ---- undoable palette edits ----` comment block that described the removed helpers. `createNewPalette` stays imported for now — the two dialogs that call it are removed in Task 7, which drops the import with them.

- [ ] **Step 5: Run the tests**

```powershell
node --test tests/
```

Expected: PASS. The three deleted test files are gone; `tests/builtinmodes.test.mjs` now matches the trimmed registries. List every failing test name from the full output.

- [ ] **Step 6: Verify nothing still references the removed ids**

```powershell
Select-String -Path js,tests -Include *.js,*.mjs -Recurse -Pattern "editPaletteColor|remapPaletteColor|commitAddPalette"
```

Expected: no output.

- [ ] **Step 7: Commit**

```powershell
git add -A js/modes js/components/panels/color-panel.js tests/builtinmodes.test.mjs
git commit -m "refactor(palettes): drop the three per-mode command copies for the shared family"
```

---

### Task 7: The manager dialog — markup, styles, mount, and swatch grid

Gets a working, openable, non-modal manager on screen that lists palettes and renders the selected one's swatches. Editing controls come in Task 8, files in Task 9.

**Files:**
- Modify: `index.html` (new `<dialog>` after `#dlg-checkerboard`)
- Modify: `css/app.css` (append a palette-manager block)
- Create: `js/features/palettes/palette-manager.js`
- Modify: `js/bootstrap.js` (import + one mount call)
- Modify: `js/features/shell/menu-controller.js` (Edit menu item)
- Modify: `js/components/panels/color-panel.js` (Manage… button replaces `+` and `⚙`)

**Interfaces:**
- Consumes: the Task 5 command family; `defineAction` (`js/features/shell/actions.js`); `makeDialogMovable`, `centerDialog`, `closeOnEscape`, `markDefaultAction` (`js/components/dialogs.js`); `SYSTEM_PALETTES`, `clonePalette` (`js/core/systempalettes.js`).
- Produces:
  - `mountPaletteManager() -> void` (`js/features/palettes/palette-manager.js`)
  - `openPaletteManager() -> void` — exported so the Colors panel's button and the menu action share one entry point
  - action id `edit.palettes`

- [ ] **Step 1: Add the dialog to `index.html`**

Insert directly after the `</dialog>` that closes `#dlg-checkerboard`:

```html
<dialog id="dlg-palettes" class="dlg-movable dlg-scrolls">
  <h3>Palettes</h3>
  <div class="dlg-body">
    <div class="row pm-top">
      <select id="pm-list"></select>
      <button id="pm-new" class="btn-sm" title="New palette">New…</button>
      <button id="pm-duplicate" class="btn-sm" title="Duplicate palette">Duplicate</button>
      <button id="pm-delete" class="btn-sm" title="Delete palette">Delete</button>
    </div>
    <div class="row">
      <label>Name <input type="text" id="pm-name"></label>
      <span id="pm-lock-badge" class="pm-lock-badge" hidden></span>
    </div>
    <div class="row">
      <label><input type="checkbox" id="pm-indexed"> Indexed (snap brush, drive quantize/export)</label>
    </div>
    <div class="row pm-lock-row">
      <label>Size <select id="pm-lock-size"></select></label>
      <label>Custom <input type="number" id="pm-lock-custom" min="1" max="256" value="16"></label>
      <label>Reason <input type="text" id="pm-lock-reason" placeholder="e.g. NES"></label>
    </div>
    <div class="row">
      <label>Unset color <input type="color" id="pm-empty-color"></label>
      <label>Sort <select id="pm-sort">
        <option value="">Sort by…</option>
        <option value="hue">Hue</option>
        <option value="luminance">Luminance</option>
        <option value="usage">Usage on this sheet</option>
      </select></label>
    </div>
    <div class="row pm-swatch-actions">
      <button id="pm-add" class="btn-sm">Add current color</button>
      <button id="pm-pick" class="btn-sm">Pick from canvas</button>
      <button id="pm-set" class="btn-sm">Set color…</button>
      <button id="pm-clear" class="btn-sm">Clear</button>
      <button id="pm-remove" class="btn-sm">Remove</button>
      <button id="pm-left" class="btn-sm" title="Move swatch left">←</button>
      <button id="pm-right" class="btn-sm" title="Move swatch right">→</button>
    </div>
    <div class="pm-grid" id="pm-grid"></div>
    <div class="row pm-file-actions">
      <button id="pm-import" class="btn-sm">Import…</button>
      <label>Export <select id="pm-export-format">
        <option value="gpl">GIMP (.gpl)</option>
        <option value="hex">Hex (.hex)</option>
        <option value="pal">JASC (.pal)</option>
        <option value="png">Image (.png)</option>
      </select></label>
      <button id="pm-export" class="btn-sm">Export</button>
    </div>
  </div>
  <div class="row dlg-actions"><button id="pm-close" class="btn-sm">Close</button></div>
</dialog>
```

- [ ] **Step 2: Add the styles to `css/app.css`**

Append:

```css
/* ---- palette manager ---- */
#dlg-palettes { width: 520px; max-width: 92vw; }
.pm-top { gap: 4px; }
.pm-top select { flex: 1 1 auto; min-width: 0; }
.pm-lock-badge { font-size: 11px; opacity: .75; border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; }
.pm-grid { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px 0; }
.pm-swatch { width: 22px; height: 22px; border: 1px solid #0006; padding: 0; cursor: pointer; }
.pm-swatch.is-selected { outline: 2px solid #4af; outline-offset: 1px; }
/* An empty slot still HAS a color -- the stripe says "nobody chose this yet",
   which is exactly the distinction the `empty` flag exists to carry. */
.pm-swatch.is-empty { background-image: repeating-linear-gradient(45deg, #fff6 0 3px, #0000 3px 6px); }
.pm-swatch-index { font-size: 9px; line-height: 1; color: #fff; text-shadow: 0 0 2px #000; pointer-events: none; }
.pm-swatch-actions, .pm-file-actions { flex-wrap: wrap; gap: 4px; }

/* The Colors panel swatch strip shares the empty-slot treatment. */
.palette-swatch.is-empty { background-image: repeating-linear-gradient(45deg, #fff6 0 3px, #0000 3px 6px); }
```

- [ ] **Step 3: Create `js/features/palettes/palette-manager.js`**

This step delivers open/close, the palette list, name, and the swatch grid with selection. Every other control is wired in Task 8 — leave their listeners out for now, but query the elements so Task 8 only adds handlers.

```js
// The palette manager dialog.
//
// Non-modal (.show(), not .showModal()) on purpose: picking a color off the
// canvas, drawing a test stroke and watching the palette update all require
// the canvas to stay live underneath. Undo works with a non-modal dialog
// open, so edits made here can be taken back without closing it.
import { getEditorHost } from '../../host/runtime.js';
import { defineAction } from '../shell/actions.js';
import { makeDialogMovable, centerDialog, closeOnEscape } from '../../components/dialogs.js';
import { INDEXED_SIZE_PRESETS } from '../../core/palettes.js';
import { SYSTEM_PALETTES } from '../../core/systempalettes.js';
import { renamePalette, duplicatePalette, deletePalette } from './palette-commands.js';

function host() { return getEditorHost(); }
function services() {
  const h = host();
  return { store: h.store, projects: h.projects, history: h.history };
}
function project() { return host().projects.project; }
function cssColor([r, g, b, a]) { return `rgba(${r},${g},${b},${a / 255})`; }

// Module-scoped so the Colors panel's button and the Edit-menu action open
// the same dialog instance rather than each finding it themselves.
let openManager = () => {};
export function openPaletteManager() { openManager(); }

export function mountPaletteManager() {
  const dlg = document.getElementById('dlg-palettes');
  if (!dlg) return;

  const el = id => dlg.querySelector(`#${id}`);
  const list = el('pm-list');
  const name = el('pm-name');
  const lockBadge = el('pm-lock-badge');
  const grid = el('pm-grid');
  const btnClose = el('pm-close');

  // Selected swatch index within the current palette; -1 for none. Reset
  // whenever the palette changes, since an index means nothing across two
  // different palettes.
  let selected = -1;

  function current() {
    const proj = project();
    return proj?.palettes.find(p => p.id === proj.activePaletteId) ?? null;
  }

  function refreshList() {
    list.innerHTML = '';
    for (const p of project()?.palettes ?? []) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.lock ? `${p.name} (${p.colors.length})` : p.name;
      list.appendChild(o);
    }
    list.value = project()?.activePaletteId ?? '';
  }

  function refreshHeader() {
    const pal = current();
    name.value = pal?.name ?? '';
    name.disabled = !pal;
    const locked = pal?.lock ?? null;
    lockBadge.hidden = !locked;
    if (locked) lockBadge.textContent = locked.reason ? `${locked.size} — ${locked.reason}` : `${locked.size}`;
  }

  function refreshGrid() {
    grid.innerHTML = '';
    const pal = current();
    if (!pal) return;
    if (selected >= pal.colors.length) selected = -1;
    pal.colors.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'pm-swatch';
      if (pal.empty[i]) sw.classList.add('is-empty');
      if (i === selected) sw.classList.add('is-selected');
      sw.style.background = cssColor(c);
      sw.title = pal.lock ? `index ${i}${pal.empty[i] ? ' (unset)' : ''}` : '';
      sw.addEventListener('click', () => { selected = i; refreshGrid(); });
      grid.appendChild(sw);
    });
  }

  function refreshAll() {
    refreshList();
    refreshHeader();
    refreshGrid();
  }

  // Populate the lock-size dropdown once: the generic presets, then every
  // system palette's own count, so "lock this to what a NES can show" is a
  // pick rather than a number the user has to look up.
  const lockSize = el('pm-lock-size');
  const noneOpt = document.createElement('option');
  noneOpt.value = ''; noneOpt.textContent = 'Unlocked';
  lockSize.appendChild(noneOpt);
  for (const size of INDEXED_SIZE_PRESETS) {
    const o = document.createElement('option');
    o.value = String(size); o.textContent = String(size);
    lockSize.appendChild(o);
  }
  for (const sys of SYSTEM_PALETTES) {
    const o = document.createElement('option');
    o.value = `sys:${sys.name}`;
    o.textContent = `${sys.name} (${sys.colors.length})`;
    lockSize.appendChild(o);
  }
  const customOpt = document.createElement('option');
  customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
  lockSize.appendChild(customOpt);

  list.addEventListener('change', () => {
    const proj = project();
    if (!proj) return;
    // Selection is not content: it stays off the undo stack, matching the
    // Colors panel's own palette dropdown.
    proj.activePaletteId = list.value || null;
    host().projects.markDirty();
    selected = -1;
    refreshAll();
  });

  name.addEventListener('change', () => {
    const pal = current();
    if (pal) renamePalette(services(), pal.id, name.value.trim() || pal.name);
  });

  el('pm-duplicate').addEventListener('click', () => {
    const pal = current();
    if (pal) duplicatePalette(services(), pal.id);
  });

  el('pm-delete').addEventListener('click', () => {
    const pal = current();
    if (pal) deletePalette(services(), pal.id);
  });

  makeDialogMovable(dlg, dlg.querySelector('h3'));
  closeOnEscape(dlg, () => dlg.close());
  btnClose.addEventListener('click', () => dlg.close());

  openManager = () => {
    if (dlg.open) return;
    refreshAll();
    dlg.show();
    if (!dlg.style.left) centerDialog(dlg);
  };

  defineAction('edit.palettes', {
    label: 'Palettes…',
    run: openPaletteManager,
    isEnabled: () => !!project(),
  });

  // Redraw on undo/redo and on any project change made elsewhere, the same
  // way color-panel.js does -- the dialog stays open across both.
  host().history.subscribe(() => { if (dlg.open) refreshAll(); });
  host().store.subscribe(s => s.project.model, () => { if (dlg.open) refreshAll(); });

  // Task 8 wires: pm-indexed, pm-lock-size, pm-lock-custom, pm-lock-reason,
  // pm-empty-color, pm-sort, pm-add, pm-pick, pm-set, pm-clear, pm-remove,
  // pm-left, pm-right. Task 9 wires: pm-new, pm-import, pm-export.
  return { refreshAll };
}
```

- [ ] **Step 4: Mount it from `js/bootstrap.js`**

Add the import beside the other `mount*` imports:

```js
import { mountPaletteManager } from './features/palettes/palette-manager.js';
```

and the call at the end, after `mountFileController();`:

```js
mountPaletteManager();
```

- [ ] **Step 5: Add the Edit menu entry**

In `js/features/shell/menu-controller.js`, change the Edit menu's item list so the palettes entry sits with the other dialog-openers:

```js
    { label: 'Edit', items: [
      { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
      { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
      { action: 'edit.filters' }, { action: 'edit.palettes' }, { separator: true },
      { action: 'edit.projectSettings' },
    ] },
```

- [ ] **Step 6: Replace the Colors panel's two buttons with one Manage… button**

In `js/components/panels/color-panel.js`, replace the `btnNewPalette` and `btnSystemPalette` declarations (lines 101-108) and the `paletteActions.append(...)` line (112) with:

```js
  const btnManage = document.createElement('button');
  btnManage.type = 'button';
  btnManage.textContent = 'Manage…';
  btnManage.title = 'Open the palette manager';
  const btnAddSwatch = document.createElement('button');
  btnAddSwatch.textContent = '+';
  btnAddSwatch.title = 'Add current color';
  paletteActions.append(btnManage, btnAddSwatch);
```

Add the import:

```js
import { openPaletteManager } from '../../features/palettes/palette-manager.js';
```

and the handler:

```js
  btnManage.addEventListener('click', () => openPaletteManager());
```

Then delete the whole `// ---- New palette dialog ----` block (lines 271-304) and the `// ---- System palettes dialog ----` block (lines 306-350) — both flows now live in the manager. Those two blocks were the only users of the `markDefaultAction`, `SYSTEM_PALETTES`, `clonePalette`, `createPalette`, `INDEXED_SIZE_PRESETS` and `createNewPalette` imports, so remove all six import bindings as well. The panel's remaining palette imports after this task are exactly:

```js
import { addPaletteSwatch, setSwatchColor, remapSwatchColor, countSwatchPixels }
  from '../../features/palettes/palette-commands.js';
import { openPaletteManager } from '../../features/palettes/palette-manager.js';
```

- [ ] **Step 7: Verify the architecture guards still hold**

```powershell
node --test tests/architecture.test.mjs
(Get-Content js/bootstrap.js | Measure-Object -Line).Lines
```

Expected: architecture tests PASS and the line count is at most 60.

- [ ] **Step 8: Run the suite and check it in the browser**

```powershell
node --test tests/
./serve.ps1
```

Note the server's PID and port from its output. Open the served page with `?autotest`, then confirm by hand:
1. Edit ▸ Palettes… opens a movable, non-modal dialog; the canvas still responds underneath.
2. The palette dropdown lists the project's palettes; selecting one redraws the grid.
3. Renaming in the Name field takes effect, and Ctrl+Z undoes it with the dialog still open.
4. Duplicate and Delete work and undo.
5. The Colors panel shows a single **Manage…** button that opens the same dialog.

Report the PID and the kill command (`Stop-Process -Id <PID> -Force`) to the user.

- [ ] **Step 9: Commit**

```powershell
git add index.html css/app.css js/features/palettes/palette-manager.js js/bootstrap.js js/features/shell/menu-controller.js js/components/panels/color-panel.js
git commit -m "feat(palettes): add the non-modal palette manager dialog"
```

---

### Task 8: Manager editing controls

Wires the remaining swatch and palette-level controls to the command family.

**Files:**
- Modify: `js/features/palettes/palette-manager.js`

**Interfaces:**
- Consumes: `addPaletteSwatch`, `setSwatchColor`, `remapSwatchColor`, `countSwatchPixels`, `clearSwatch`, `removePaletteSwatch`, `movePaletteSwatch`, `sortPalette`, `setPaletteLock`, `setPaletteEmptyColor`, `setPaletteIndexed` (Task 5); `armColorSample` (`js/components/canvas/drawing-engine.js`); `confirmOrAuto` (`js/platform/browser/autotest.js`); `rgbaToHex` / `hexToRgb` (`js/components/color-utils.js`); `SYSTEM_PALETTES`.
- Produces: no new exports.

- [ ] **Step 1: Extend the imports in `js/features/palettes/palette-manager.js`**

```js
import { armColorSample } from '../../components/canvas/drawing-engine.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { rgbaToHex, hexToRgb } from '../../components/color-utils.js';
import {
  renamePalette, duplicatePalette, deletePalette,
  addPaletteSwatch, setSwatchColor, remapSwatchColor, countSwatchPixels,
  clearSwatch, removePaletteSwatch, movePaletteSwatch, sortPalette,
  setPaletteLock, setPaletteEmptyColor, setPaletteIndexed,
} from './palette-commands.js';
```

- [ ] **Step 2: Add the swatch-level handlers**

Insert before the `makeDialogMovable(...)` line:

```js
  // ---- swatch operations ----
  // All of these act on the selected slot, so they no-op without one rather
  // than guessing which swatch the user meant.
  function withSelection(fn) {
    const pal = current();
    if (pal && selected >= 0 && selected < pal.colors.length) fn(pal, selected);
  }

  // The one place that decides between a plain entry edit and a remap that
  // also rewrites pixels. Same rule as the Colors panel's double-click: if
  // the old color is on the active sheet, offer to carry the artwork along.
  function applyColorToSelection(pal, index, to) {
    const old = pal.colors[index];
    const count = pal.empty[index] ? 0 : countSwatchPixels(services(), old);
    if (count === 0) {
      setSwatchColor(services(), pal.id, index, to);
      return;
    }
    if (!confirmOrAuto(`Remap ${count} pixels of old color on active sheet?`)) return;
    remapSwatchColor(services(), pal.id, index, to);
  }

  el('pm-add').addEventListener('click', () => {
    const pal = current();
    if (pal) addPaletteSwatch(services(), pal.id, [...host().store.getState().workspace.drawing.primary]);
  });

  el('pm-set').addEventListener('click', () => withSelection((pal, index) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.style.position = 'absolute';
    input.style.width = '0'; input.style.height = '0';
    input.style.opacity = '0'; input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    input.value = rgbaToHex(pal.colors[index]);
    input.addEventListener('change', () => {
      const [r, g, b] = hexToRgb(input.value);
      document.body.removeChild(input);
      applyColorToSelection(pal, index, [r, g, b, 255]);
    });
    input.click();
  }));

  // One-shot canvas sampler, the same mechanism the chroma-key dialog uses.
  // This is the reason the manager is non-modal: a modal dialog would put
  // the canvas out of reach.
  el('pm-pick').addEventListener('click', () => withSelection((pal, index) => {
    armColorSample(rgba => applyColorToSelection(pal, index, [rgba[0], rgba[1], rgba[2], 255]), () => {});
  }));

  el('pm-clear').addEventListener('click', () => withSelection((pal, index) => clearSwatch(services(), pal.id, index)));

  el('pm-remove').addEventListener('click', () => withSelection((pal, index) => removePaletteSwatch(services(), pal.id, index)));

  el('pm-left').addEventListener('click', () => withSelection((pal, index) => {
    if (index === 0) return;
    movePaletteSwatch(services(), pal.id, index, index - 1);
    selected = index - 1;
  }));

  el('pm-right').addEventListener('click', () => withSelection((pal, index) => {
    if (index >= pal.colors.length - 1) return;
    movePaletteSwatch(services(), pal.id, index, index + 1);
    selected = index + 1;
  }));

  const sortSelect = el('pm-sort');
  sortSelect.addEventListener('change', () => {
    const pal = current();
    if (pal && sortSelect.value) sortPalette(services(), pal.id, sortSelect.value);
    sortSelect.value = '';          // it is an action, not a stored setting
    selected = -1;
  });
```

- [ ] **Step 3: Add the palette-level handlers**

```js
  // ---- palette-level settings ----
  const indexed = el('pm-indexed');
  indexed.addEventListener('change', () => {
    const pal = current();
    if (pal) setPaletteIndexed(services(), pal.id, indexed.checked);
  });

  const emptyColor = el('pm-empty-color');
  emptyColor.addEventListener('change', () => {
    const pal = current();
    if (!pal) return;
    const [r, g, b] = hexToRgb(emptyColor.value);
    setPaletteEmptyColor(services(), pal.id, [r, g, b, 255]);
  });

  const lockCustom = el('pm-lock-custom');
  const lockReason = el('pm-lock-reason');

  // Reads the size dropdown into { size, reason }. A `sys:` option carries
  // its own reason (the system's name), which is the whole point of picking
  // a size from that list rather than typing the number.
  function chosenLock() {
    const value = lockSize.value;
    if (value === '') return { size: null, reason: '' };
    if (value === 'custom') return { size: Math.max(1, parseInt(lockCustom.value, 10) || 1), reason: lockReason.value.trim() };
    if (value.startsWith('sys:')) {
      const sysName = value.slice(4);
      const sys = SYSTEM_PALETTES.find(s => s.name === sysName);
      return { size: sys?.colors.length ?? 0, reason: sysName };
    }
    return { size: parseInt(value, 10), reason: lockReason.value.trim() };
  }

  function applyLockChoice() {
    const pal = current();
    if (!pal) return;
    const { size, reason } = chosenLock();
    if (size !== null && size < pal.colors.length) {
      const dropped = pal.colors.length - size;
      if (!confirmOrAuto(`Locking to ${size} entries drops the last ${dropped}. Continue?`)) {
        refreshHeader();               // put the dropdown back where it was
        return;
      }
    }
    setPaletteLock(services(), pal.id, size, reason);
    selected = -1;
  }

  lockSize.addEventListener('change', () => {
    // A `sys:` pick supplies its own reason; show it before applying so the
    // user sees what the export will say.
    const { reason } = chosenLock();
    if (reason) lockReason.value = reason;
    applyLockChoice();
  });
  lockCustom.addEventListener('change', () => { if (lockSize.value === 'custom') applyLockChoice(); });
  lockReason.addEventListener('change', () => {
    const pal = current();
    if (pal?.lock) setPaletteLock(services(), pal.id, pal.lock.size, lockReason.value.trim());
  });
```

- [ ] **Step 4: Extend `refreshHeader` to drive the new controls**

Replace `refreshHeader` with:

```js
  function refreshHeader() {
    const pal = current();
    name.value = pal?.name ?? '';
    name.disabled = !pal;
    indexed.checked = !!pal?.indexed;
    indexed.disabled = !pal;
    emptyColor.value = pal ? rgbaToHex(pal.emptyColor) : '#000000';
    emptyColor.disabled = !pal;

    const locked = pal?.lock ?? null;
    lockBadge.hidden = !locked;
    if (locked) lockBadge.textContent = locked.reason ? `${locked.size} — ${locked.reason}` : `${locked.size}`;
    lockReason.value = locked?.reason ?? '';

    // Reflect the palette's actual size back into the dropdown: prefer a
    // system option whose name matches the recorded reason, then a plain
    // preset, else Custom.
    if (!locked) lockSize.value = '';
    else if (SYSTEM_PALETTES.some(s => s.name === locked.reason && s.colors.length === locked.size)) lockSize.value = `sys:${locked.reason}`;
    else if (INDEXED_SIZE_PRESETS.includes(locked.size)) lockSize.value = String(locked.size);
    else { lockSize.value = 'custom'; lockCustom.value = String(locked.size); }
  }
```

Move the `const lockSize`/`lockCustom`/`lockReason`/`indexed`/`emptyColor` declarations above `refreshHeader` so they are in scope, keeping the dropdown-population loop where it is.

- [ ] **Step 5: Check it in the browser**

```powershell
./serve.ps1
```

With `?autotest`, verify each in turn, undoing after each with Ctrl+Z while the dialog stays open:
1. Select a swatch, **Set color…**, pick a color → the swatch changes. On a color used by the artwork, the remap confirm appears and accepting rewrites the pixels.
2. **Pick from canvas** → the next canvas click fills the selected slot.
3. **Clear** on a locked palette leaves the slot in place with the stripe overlay; **Remove** on an unlocked palette shrinks the grid.
4. ← / → reorder, and the selection follows the swatch.
5. Sort by hue, luminance and usage each reorder the grid.
6. Lock size to "NES (54)" → grid pads to 54, badge reads `54 — NES`. Locking down to a smaller size prompts before dropping entries.
7. Changing the unset color recolors every striped slot and leaves the decided ones alone.
8. Toggling Indexed changes brush snapping without changing the entry count.

Report the server PID and its kill command.

- [ ] **Step 6: Commit**

```powershell
git add js/features/palettes/palette-manager.js
git commit -m "feat(palettes): wire the manager's swatch and lock editing controls"
```

---

### Task 9: Palette files — new-palette flows, import and export

The browser file glue plus the three creation flows (blank, system template, from artwork).

**Files:**
- Create: `js/features/palettes/palette-files.js`
- Modify: `js/features/palettes/palette-manager.js` (`pm-new`, `pm-import`, `pm-export`)
- Modify: `index.html` (a small New-palette sub-dialog)

**Interfaces:**
- Consumes: all of `js/core/palette-io.js` (Tasks 3-4); `createPalette`, `setEntry`, `setLock` (`js/core/palettes.js`); `clonePalette`, `SYSTEM_PALETTES`; `createNewPalette` (Task 5); `encodePng` / `decodePng` (`js/core/pngcodec.js`); `downloadBlob`, `supportsFS` (`js/platform/browser/project-io.js`); `colorFrequency` / `medianCutPalette` (`js/core/quantize.js`); `sheetLayers` (`js/core/model.js`).
- Produces, from `js/features/palettes/palette-files.js`:
  - `exportPalette(palette, format) -> Promise<void>`
  - `importPalette() -> Promise<Palette|null>` — returns a ready-to-add palette, or `null` if the user cancelled
  - `paletteFromArtwork(bitmaps, maxColors) -> Palette`

- [ ] **Step 1: Create `js/features/palettes/palette-files.js`**

```js
// Browser glue between the pure format code in js/core/palette-io.js and the
// file system. Everything here is IO and DOM; the parsing, serializing and
// bitmap math all live in core so they stay node-testable.
import {
  formatFromFilename, paletteFilename, serializePaletteText, parsePaletteText,
  paletteToStripBitmap, bitmapToPaletteColors,
} from '../../core/palette-io.js';
import { createPalette, addSwatch, setLock } from '../../core/palettes.js';
import { medianCutPalette, colorFrequency } from '../../core/quantize.js';
import { encodePng, decodePng } from '../../core/pngcodec.js';
import { downloadBlob, supportsFS } from '../../platform/browser/project-io.js';

const PALETTE_FILE_TYPES = [{
  description: 'Palette files',
  accept: { 'application/octet-stream': ['.gpl', '.hex', '.pal', '.png'] },
}];

async function paletteBlob(palette, format) {
  if (format === 'png') {
    const bytes = await encodePng(paletteToStripBitmap(palette));
    return new Blob([bytes], { type: 'image/png' });
  }
  return new Blob([serializePaletteText(palette, format)], { type: 'text/plain' });
}

export async function exportPalette(palette, format) {
  const filename = paletteFilename(palette, format);
  const blob = await paletteBlob(palette, format);
  if (supportsFS()) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: filename });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch {
      // User cancelled the picker, or the API refused -- fall through to the
      // download path rather than failing the export outright.
    }
  }
  downloadBlob(blob, filename);
}

function pickFileFallback(accept) {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

async function pickPaletteFile() {
  if (supportsFS()) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: PALETTE_FILE_TYPES });
      return handle.getFile();
    } catch {
      return null;
    }
  }
  return pickFileFallback('.gpl,.hex,.pal,.png');
}

// Import ALWAYS creates a new palette -- never overwrites the selected one,
// so there is no destructive path here at all. The name comes from the
// .gpl header when there is one, else the filename.
export async function importPalette() {
  const file = await pickPaletteFile();
  if (!file) return null;
  const format = formatFromFilename(file.name);
  if (!format) throw new Error(`unsupported palette format: ${file.name}`);

  let parsed;
  if (format === 'png') {
    const bitmap = await decodePng(new Uint8Array(await file.arrayBuffer()));
    parsed = { name: '', colors: bitmapToPaletteColors(bitmap), lock: null };
  } else {
    parsed = parsePaletteText(await file.text(), format);
  }
  if (parsed.colors.length === 0) throw new Error(`no colors found in ${file.name}`);

  const fallbackName = file.name.replace(/\.[^.]+$/, '');
  // Built unlocked and filled via addSwatch so `colors` and `empty` are only
  // ever grown together, then locked afterwards if the file said so.
  const palette = createPalette({ name: parsed.name || fallbackName });
  for (const c of parsed.colors) addSwatch(palette, c);
  // A .gpl lock comment can disagree with the entry count it was written
  // beside (hand-edited file, truncated export). colors.length is the
  // authority; only the reason is taken from the comment.
  if (parsed.lock) setLock(palette, palette.colors.length, parsed.lock.reason);
  return palette;
}

// maxColors === 0 means "every distinct color", which is what you want when
// lifting a palette off pixel art that is already palettised.
export function paletteFromArtwork(bitmaps, maxColors) {
  const colors = maxColors > 0
    ? medianCutPalette(bitmaps, maxColors).map(c => [c[0], c[1], c[2], 255])
    : colorFrequency(bitmaps).map(c => [c[0], c[1], c[2], 255]);
  const palette = createPalette({ name: 'From artwork' });
  for (const c of colors) addSwatch(palette, c);
  return palette;
}
```

- [ ] **Step 2: Add the New-palette sub-dialog to `index.html`**

Insert after the `#dlg-palettes` dialog:

```html
<dialog id="dlg-palette-new">
  <h3>New Palette</h3>
  <div class="row"><label>Source <select id="pn-source">
    <option value="blank">Blank</option>
    <option value="system">System palette</option>
    <option value="artwork">From artwork on this sheet</option>
  </select></label></div>
  <div class="row" id="pn-name-row"><label>Name <input type="text" id="pn-name" value="Palette"></label></div>
  <div class="row" id="pn-system-row" hidden><label>Template <select id="pn-system"></select></label></div>
  <div class="row" id="pn-artwork-row" hidden>
    <label>Colors <input type="number" id="pn-artwork-count" min="0" max="256" value="16"></label>
    <span class="hint">0 = every distinct color</span>
  </div>
  <div class="row dlg-actions"><button id="pn-create" class="btn-sm">Create</button><button id="pn-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

- [ ] **Step 3: Wire New, Import and Export in `js/features/palettes/palette-manager.js`**

Add the imports:

```js
import { clonePalette } from '../../core/systempalettes.js';
import { createPalette } from '../../core/palettes.js';
import { sheetLayers } from '../../core/model.js';
import { activeSheet } from '../../host/document-helpers.js';
import { markDefaultAction } from '../../components/dialogs.js';
import { createNewPalette } from './palette-commands.js';
import { exportPalette, importPalette, paletteFromArtwork } from './palette-files.js';
```

and, before `makeDialogMovable(...)`:

```js
  // ---- new palette ----
  const dlgNew = document.getElementById('dlg-palette-new');
  const pnSource = dlgNew.querySelector('#pn-source');
  const pnName = dlgNew.querySelector('#pn-name');
  const pnSystem = dlgNew.querySelector('#pn-system');
  const pnCount = dlgNew.querySelector('#pn-artwork-count');
  for (const sys of SYSTEM_PALETTES) {
    const o = document.createElement('option');
    o.value = sys.name;
    o.textContent = `${sys.name} (${sys.colors.length})`;
    pnSystem.appendChild(o);
  }
  function refreshNewDialog() {
    dlgNew.querySelector('#pn-system-row').hidden = pnSource.value !== 'system';
    dlgNew.querySelector('#pn-artwork-row').hidden = pnSource.value !== 'artwork';
    dlgNew.querySelector('#pn-name-row').hidden = pnSource.value === 'system';
  }
  pnSource.addEventListener('change', refreshNewDialog);
  markDefaultAction(dlgNew, dlgNew.querySelector('#pn-create'));
  dlgNew.querySelector('#pn-cancel').addEventListener('click', () => dlgNew.close());
  dlgNew.querySelector('#pn-create').addEventListener('click', () => {
    if (!project()) { dlgNew.close(); return; }
    let palette = null;
    if (pnSource.value === 'system') {
      const sys = SYSTEM_PALETTES.find(s => s.name === pnSystem.value);
      // A template-derived palette is locked to its template's count by
      // default, with the system's name as the reason -- that provenance is
      // what makes an export self-evidently a palette for that machine.
      if (sys) palette = clonePalette(sys);
    } else if (pnSource.value === 'artwork') {
      const sheet = activeSheet();
      const bitmaps = sheet ? sheetLayers(sheet).map(l => l.bitmap) : [];
      if (bitmaps.length) {
        palette = paletteFromArtwork(bitmaps, Math.max(0, parseInt(pnCount.value, 10) || 0));
        palette.name = pnName.value.trim() || palette.name;
      }
    } else {
      palette = createPalette({ name: pnName.value.trim() || 'Palette' });
    }
    dlgNew.close();
    if (palette) createNewPalette(services(), palette);
  });
  el('pm-new').addEventListener('click', () => { refreshNewDialog(); dlgNew.showModal(); });

  // ---- import / export ----
  el('pm-import').addEventListener('click', async () => {
    const palette = await importPalette();
    if (palette) createNewPalette(services(), palette);
  });

  el('pm-export').addEventListener('click', async () => {
    const pal = current();
    if (pal) await exportPalette(pal, el('pm-export-format').value);
  });
```

- [ ] **Step 4: Run the suite**

```powershell
node --test tests/
```

Expected: PASS. List every failing test name from the full output.

- [ ] **Step 5: Verify the file round-trips in the browser**

```powershell
./serve.ps1
```

With `?autotest`, for each of the four formats:
1. Create a palette from the NES system template (54 entries, badge `54 — NES`).
2. Export as `.gpl` → the file is named `NES (NES 54).gpl` and contains 54 color lines plus `# Locked to 54 entries (NES)`.
3. Import that same file → a new palette appears, still 54 entries, still locked with reason `NES`, and the original is untouched.
4. Repeat export/import for `.hex`, `.pal` and `.png`. `.pal`'s third line reads `54`. `.png` comes back with the distinct colors only (order will differ — expected).
5. New ▸ From artwork on a sheet with a handful of colors produces a palette holding them.

Report the server PID and its kill command.

- [ ] **Step 6: Commit**

```powershell
git add js/features/palettes/palette-files.js js/features/palettes/palette-manager.js index.html
git commit -m "feat(palettes): palette import, export and creation flows"
```

---

### Task 10: Final verification

**Files:** none changed unless a defect turns up.

**Interfaces:**
- Consumes: everything.
- Produces: a verification report.

- [ ] **Step 1: Run the full suite and read all of it**

```powershell
node --test tests/
```

Do not pipe through `tail` or otherwise truncate. List every failing test name from the full output. Expected: all pass.

- [ ] **Step 2: Confirm the layering guards**

```powershell
node --test tests/architecture.test.mjs
Select-String -Path js/core/palette-io.js,js/features/palettes/palette-commands.js -Pattern "document\.|window\.|alert\(|confirm\(|prompt\(|OffscreenCanvas"
(Get-Content js/bootstrap.js | Measure-Object -Line).Lines
```

Expected: tests pass, `Select-String` prints nothing, line count at most 60.

- [ ] **Step 3: Confirm the old surface is gone**

```powershell
Select-String -Path js,tests -Include *.js,*.mjs -Recurse -Pattern "editPaletteColor|remapPaletteColor|\.size\b" | Select-String -NotMatch "brushSize|fontSize|gridSize|tileSize|canvasSize|\.sizes|runLengths|reasons\.size|changed\.size|masks\.size|conflicts\.size|afterTiles\.size|seen\.size|strokeMasks\.size"
```

Expected: no palette-related hits. Any `.size` hits should be unrelated `Set`/`Map` sizes.

- [ ] **Step 4: Browser regression pass on what the model change touched**

```powershell
./serve.ps1
```

With `?autotest`, check only the flows the palette model actually feeds — per the "no redundant smoke runs" rule, do not re-sweep unrelated features:
1. **Brush snapping** — with an indexed palette active, painting snaps to palette colors; with `indexed` off, it does not.
2. **Quantize to Palette** — the filter dialog lists the palettes and quantizes to the selected one, including one with empty slots.
3. **Export color budget** — exporting a sheet against an indexed palette still counts `colors.length`.
4. **Save and reload** — save a project containing a locked palette with empty slots and a custom unset color, reload it, and confirm `lock`, `empty` and `emptyColor` all survive.
5. **Load an older project file** saved before this change — its indexed palettes come back locked to their own color count with an unlabeled reason, and its free palettes come back unlocked.

Report the server PID and its kill command.

- [ ] **Step 5: Report**

Summarize: tests passing, what was verified in the browser, anything left uncommitted, and any deviation from this plan with its reason.

---

## Notes for the executor

- **The `colors`/`empty` invariant is the one thing that will bite.** If a swatch renders with the wrong stripe or a sort scrambles the flags, the cause is almost always code that spliced one array without the other. Every length or order change belongs in `js/core/palettes.js`.
- **Task 5's commands snapshot and restore** rather than computing per-operation inverses. That is deliberate: palettes are small, and hand-written inverses for "remove from a locked palette" versus "remove from an unlocked one" are exactly the kind of thing that is subtly wrong for a year.
- **Do not make the manager modal.** Pick-from-canvas and draw-to-test both depend on it being non-modal, and `float-session.js:472` still bails on any open dialog for Ctrl+X/C/V — a known limitation, out of scope here.
- **`empty` never changes behavior outside the editor.** If a change makes empty slots skip brush snapping, get dropped from an export, or vanish from the quantize budget, that is a bug against this plan, not an improvement.
