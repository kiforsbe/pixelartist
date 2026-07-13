# PixelArtist v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add image import (new sheet from PNG), a move tool (selection/layer, one-or-all layers), and sheet renaming to the shipped v2 app.

**Architecture:** One new pure core module (`js/core/moveregion.js`, node-tested); the move tool extends `js/ui/tools.js`'s existing stroke machinery; import and rename extend `js/app/main.js`'s existing sheet-command and dialog patterns.

**Tech Stack:** Vanilla ES modules, Canvas 2D, Node built-in test runner. Zero dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-pixelartist-v3-design.md`. When ambiguous, the spec wins.
- No npm dependencies; core modules (`js/core/**`) never reference document/window/navigator/canvas.
- All structural/pixel edits are undoable commands on `state.commands` (eager-mutate + snapshot-based idempotent do()/undo(); push() executes do()).
- Tests: `npm test` green at every commit (57 at start; 61 after Task 1; stable thereafter).
- Commit after every task (conventional commits).
- ENVIRONMENT: Windows 11 — PowerShell syntax for all shell commands (never bash). Browser verification via Playwright MCP, ALWAYS loading `http://localhost:8080/?autotest` (serve `npx --yes serve -l 8080 .` in background).
- House conventions: dialogs centered (CSS handles it), dims clamp high to 4096 / alert+abort on NaN/<1, cancel-safe pickers (AbortError / Error('cancelled') swallowed), microtask-coalesced panel refreshes.

## File Structure

```
js/core/moveregion.js   NEW: shiftRegion (pure)
tests/moveregion.test.mjs NEW
js/ui/tools.js          MODIFY: 'move' tool (lifecycle + all-layers option)
js/app/io.js            MODIFY: pickImageFile()
js/app/main.js          MODIFY: Import button/handler, shared commitAddSheet, rename button + dialog
index.html              MODIFY: #btn-import-sheet, #btn-rename-sheet, #dlg-renamesheet
tests/smoke.md, README.md MODIFY (Task 4)
```

---

### Task 1: `shiftRegion` core helper

**Files:**
- Create: `js/core/moveregion.js`
- Test: `tests/moveregion.test.mjs`

**Interfaces:**
- Consumes: `copyRegion`, `fillRegion`, `blitRegion` from `js/core/pixels.js`.
- Produces: `shiftRegion(bmp, rect, dx, dy) -> {x, y, w, h} | null` — moves the pixels of `rect` (already clamped by caller or clamped internally to the bitmap) by `(dx, dy)`: vacated area becomes transparent, destination pixels overwritten, anything landing outside the bitmap is cropped (blitRegion clips). Returns the union dirty rect of old+new positions clamped to the bitmap, or `null` for zero delta / degenerate rect (no mutation).

- [ ] **Step 1: Write failing tests**

`tests/moveregion.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftRegion } from '../js/core/moveregion.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], CLEAR = [0, 0, 0, 0];

test('in-bounds move: pixels arrive, vacated area transparent, union rect returned', () => {
  const b = createBitmap(8, 8);
  setPixel(b, 1, 1, RED);
  const dirty = shiftRegion(b, { x: 0, y: 0, w: 3, h: 3 }, 4, 2);
  assert.deepEqual(getPixel(b, 5, 3), RED);   // 1+4, 1+2
  assert.deepEqual(getPixel(b, 1, 1), CLEAR); // vacated
  assert.deepEqual(dirty, { x: 0, y: 0, w: 7, h: 5 }); // union of (0,0,3,3) and (4,2,3,3)
});

test('edge cropping: pixels shifted past the boundary are lost', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 3, 0, RED);
  const dirty = shiftRegion(b, { x: 0, y: 0, w: 4, h: 4 }, 2, 0);
  assert.deepEqual(getPixel(b, 3, 0), CLEAR); // moved to x=5, cropped
  assert.equal(dirty.w, 4); // union clamped to bitmap
});

test('zero delta and degenerate rect are no-ops returning null', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 1, 1, RED);
  assert.equal(shiftRegion(b, { x: 0, y: 0, w: 4, h: 4 }, 0, 0), null);
  assert.equal(shiftRegion(b, { x: 0, y: 0, w: 0, h: 4 }, 1, 0), null);
  assert.deepEqual(getPixel(b, 1, 1), RED); // untouched
});

test('rect partially outside bitmap is clamped before moving', () => {
  const b = createBitmap(4, 4);
  setPixel(b, 0, 0, RED);
  const dirty = shiftRegion(b, { x: -2, y: -2, w: 4, h: 4 }, 1, 1);
  assert.deepEqual(getPixel(b, 1, 1), RED);
  assert.deepEqual(getPixel(b, 0, 0), CLEAR);
  assert.deepEqual(dirty, { x: 0, y: 0, w: 3, h: 3 }); // clamped rect (0,0,2,2) ∪ (1,1,2,2)
});
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL (module missing).

- [ ] **Step 3: Implement `js/core/moveregion.js`**

```js
import { copyRegion, fillRegion, blitRegion } from './pixels.js';

// Moves the pixels of `rect` by (dx, dy): vacated area becomes transparent,
// pixels landing outside the bitmap are cropped. Returns the union dirty rect
// (old ∪ new, clamped to the bitmap), or null when nothing changes.
export function shiftRegion(bmp, rect, dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(bmp.width, rect.x + rect.w);
  const y1 = Math.min(bmp.height, rect.y + rect.h);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const clip = copyRegion(bmp, x0, y0, w, h);
  fillRegion(bmp, x0, y0, w, h, [0, 0, 0, 0]);
  blitRegion(bmp, clip, x0 + dx, y0 + dy);
  const ux0 = Math.max(0, Math.min(x0, x0 + dx));
  const uy0 = Math.max(0, Math.min(y0, y0 + dy));
  const ux1 = Math.min(bmp.width, Math.max(x1, x1 + dx));
  const uy1 = Math.min(bmp.height, Math.max(y1, y1 + dy));
  return { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
}
```

- [ ] **Step 4: Run, verify pass** — `npm test` → 61/61.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: shiftRegion core helper for the move tool"`

---

### Task 2: Move tool

**Files:**
- Modify: `js/ui/tools.js`

**Interfaces:**
- Consumes: `shiftRegion` (moveregion.js); tools.js's own stroke machinery: `cloneBitmap`, `blitRegion`, `copyRegion`, `makePixelPatch`, the per-instance `selection`, `getTargetRect()`, `finalize`-style patch clamping (`clampRectTo`, `maskOutsideTarget` — read the current code), `activeLayer()`, `activeSheet()`.
- Produces:
  - `TOOLS` gains `{ id: 'move', icon: '✋', key: 'v' }` (after 'select').
  - Tool options row (like fill's "contiguous"): an "All layers" checkbox visible when the move tool is active; module reads it at pointerdown.

Move lifecycle (inside `bindDrawing`, per instance — mirror the existing stroke/selStroke pattern):

```
pointerdown (tool==='move'):
  sheet = activeSheet(); if (!sheet) return
  region = (instance selection?.rect within target) ?? getTargetRect()
  layers = allLayersChecked ? sheet.layers : [activeLayer()] (skip if none)
  moveStroke = { anchor: {x: ev.x, y: ev.y}, region, layers,
                 before: layers.map(l => cloneBitmap(l.bitmap)),
                 delta: {dx: 0, dy: 0}, hadSelection: !!selection }
pointermove:
  delta = ev - anchor (integer image px)
  for each layer i: blitRegion(layer.bitmap, before[i], 0, 0)  // full restore
  for each layer: shiftRegion(layer.bitmap, region, dx, dy)
  moveStroke.delta = {dx, dy}; emit('pixels'); requestRender()
pointerup:
  {dx, dy} = moveStroke.delta
  restore all layers from before
  if (dx === 0 && dy === 0) { moveStroke = null; return }
  target = getTargetRect()
  for each layer:
    apply shiftRegion(layer.bitmap, region, dx, dy)
    // clamp the patch to the target rect (frame/tile editors) and mask
    // any out-of-target bleed exactly like finalize() does for brushes:
    patchRect = clamp(union rect returned by shiftRegion ∪ region, target)
    mask outside target back to before-pixels
    before/after = copyRegion of patchRect from before[i] / current
  push ONE command: do() re-blits all after-patches (+ moves selection),
                    undo() re-blits all before-patches (+ restores selection rect)
  if (hadSelection) selection.rect shifts by (dx, dy) clamped to target
  markDirty()
```

Implementation notes (binding):
- Read the existing `handleSelectDown/Move/Up` and `finalize` code FIRST and reuse its helpers (`clampPoint`, the union/patch helpers) rather than duplicating; the multi-layer patch loop may need a small generalization of `finalize` or a local equivalent — keep it in one place.
- Multi-layer command = ONE command object whose do/undo iterate the per-layer patches (same shape as frames.js's `commitMoveFrames` per-layer arrays).
- The move tool must not fight the marquee: with tool==='move' the selection is read-only input (no marquee creation); Escape still clears it via the existing handler.
- Keyboard: 'v' via the TOOLS entry (mountToolPalette already handles keys).
- Cursor: set canvas cursor to 'move' when the tool is active if trivial (optional, skip if it complicates).

- [ ] **Step 1: Implement per lifecycle above.**
- [ ] **Step 2: Browser verify (?autotest, sprite mode):**
  - Draw pixels; select move tool (v); drag with NO selection → whole layer content shifts live; release; undo restores byte-exact.
  - Marquee a region (select tool), switch to move (v), drag → only region pixels move, selection rect follows; undo restores pixels AND selection rect.
  - Two layers with distinct pixels: move with "All layers" OFF → only active layer moved; undo; ON → both moved in one undo step.
  - Move past the sheet edge → cropped; undo restores.
  - In the frame editor: move shifts only within the frame (no bleed outside; undo exact).
  - No console errors; `npm test` 61/61.
- [ ] **Step 3: Commit** — `git add -A; git commit -m "feat: move tool (selection/layer, optional all-layers)"`

---

### Task 3: Import sheet from image

**Files:**
- Modify: `js/app/io.js`, `js/app/main.js`, `index.html`

**Interfaces:**
- Consumes: `decodePng` (js/app/pngcodec.js — createImageBitmap-based, handles common formats), `createSheet` (model), the existing new-sheet command logic in main.js, `state`, `confirmOrAuto` not needed (import doesn't discard anything).
- Produces:
  - io.js: `async pickImageFile() -> File` — `showOpenFilePicker` with `{description: 'Images', accept: {'image/png': ['.png'], 'image/*': ['.png', '.gif', '.jpg', '.jpeg', '.webp', '.bmp']}}` when `supportsFS()`, else the existing `pickFileFallback('image/*')` (check its signature — it takes an accept string).
  - main.js: `#btn-import-sheet` ("Import…") next to `#btn-new-sheet`; extract the existing new-sheet command construction into a shared `commitAddSheet(sheet)` helper (captures prev selection, pushes the command, emits) used by BOTH the New Sheet dialog and import.

Import handler flow:
```
click → file = await pickImageFile()   (cancel-safe: isCancel → return)
bytes = new Uint8Array(await file.arrayBuffer())
bitmap = await decodePng(bytes)        (failure → alert(`Import failed: ${e.message}`), return)
if (bitmap.width > 4096 || bitmap.height > 4096) → alert, return
name = file.name.replace(/\.[^.]+$/, '') || 'imported'
kind = state.mode === 'sprites' ? 'sprite' : 'tile'
sheet = createSheet(state.project, { name, width: bitmap.width, height: bitmap.height,
        kind, tileW: settings.tileW, tileH: settings.tileH })
sheet.layers[0].bitmap = bitmap        (replace the blank Layer 1 bitmap)
commitAddSheet(sheet)                  (one undoable command; selects the sheet)
```

- [ ] **Step 1: Implement (extract commitAddSheet first, verify New Sheet still works).**
- [ ] **Step 2: Browser verify (?autotest):** fallback-path import driven by test: create a File from a generated PNG in browser_evaluate (draw on an OffscreenCanvas → convertToBlob → File) and call the import handler's internals (or dispatch through the fallback input via DataTransfer). Verify: new sheet appears in the selector with the file's name, dimensions match, pixels present on Layer 1 (sample bitmap bytes), tile sheets get settings tile size, undo removes it (selector reverts), oversized image (e.g. 5000px canvas) alerts and creates nothing, corrupt bytes alert. New Sheet dialog still works (regression). No console errors; `npm test` 61/61.
- [ ] **Step 3: Commit** — `git add -A; git commit -m "feat: import sheet from image file"`

---

### Task 4: Rename sheet + docs

**Files:**
- Modify: `index.html`, `js/app/main.js`, `tests/smoke.md`, `README.md`

**Interfaces:**
- Consumes: sheet selector refresh (already on 'project'/'view'), `activeSheet()`, `markDirty()`.
- Produces: `#btn-rename-sheet` ("✎", title "Rename sheet") next to `#btn-import-sheet`; `#dlg-renamesheet` with `#rs-name`, `#rs-ok`, `#rs-cancel`.

Behavior:
- Open: pre-fill `#rs-name` with `activeSheet().name`; disabled/no-op when no active sheet.
- OK: `const v = input.value.trim(); if (!v) { alert('Name cannot be empty.'); return; }` — command `{label:'rename sheet', do(){ sheet.name = v; }, undo(){ sheet.name = old; }}` via the eager-mutate idiom (set, then push with snapshot values), then `markDirty()` (its 'project' emit refreshes the selector). Cancel closes.
- Docs:
  - `tests/smoke.md`: new [A] items — import (fallback input w/ generated PNG, name/dims/pixels/undo), move tool (no-selection layer move, selection move + rect follows, all-layers, frame-editor confinement, undo each), rename (+ selector/export name updates, undo).
  - `README.md`: add Import and Rename to the UI docs; add the move tool to the tools/shortcuts tables (✋, key v, "All layers" option).

- [ ] **Step 1: Implement rename.**
- [ ] **Step 2: Update smoke.md + README.**
- [ ] **Step 3: Browser verify (?autotest):** rename active sheet → selector label updates immediately; undo restores old name; empty name alerts, dialog stays open; export PNG filename uses the new name (trigger export, check download name). Run the new [A] smoke items end-to-end. No console errors; `npm test` 61/61.
- [ ] **Step 4: Commit** — `git add -A; git commit -m "feat: rename sheet; docs for import/move/rename"`

---

## Self-Review Notes

- Spec coverage: §1 import (T3), §2 move tool incl. all-layers/selection-follows/cropping/editor-confinement (T1, T2), §3 rename (T4); error handling (oversize/decode-fail/empty-name alerts, cancel-safe pickers in T3/T4); testing (T1 node tests; smoke/README in T4).
- Type consistency: `shiftRegion(bmp, rect, dx, dy)` used identically in T1/T2; `pickImageFile()`/`commitAddSheet(sheet)` defined and consumed only in T3; test counts 57 → 61 (T1) stable thereafter.
- No placeholders; all code steps carry code.
