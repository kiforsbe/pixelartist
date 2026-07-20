# Quantize to Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `Edit > Filters > Quantize to Palette…` command that remaps every opaque pixel in the current selection (or the whole editable area when there's no selection) to its nearest match in a chosen palette (a project palette or a system palette), on the active layer or every layer in scope.

**Architecture:** A pure core helper (`quantizeBitmapToPalette`, reuses the existing `nearestColor`) does the per-pixel remap. A new `floatsession.js` export (`currentEditRegion`) exposes the selection-or-target-rect resolution `createFloat`/`cutSelection` already use internally, so the filter is confined exactly like every other pixel operation in the app. A small dialog (static markup in `index.html`, populated by `main.js`) picks the palette and layer scope, then pushes one undoable command.

**Tech Stack:** Vanilla JS, ES modules, `node --test` for unit tests. No new dependencies.

## Global Constraints

- No dependencies, no build step (this project's standing rule — see `README.md`).
- Every command must be a single undo step (`state.commands.push({ label, do, undo })`), matching every existing pixel-editing command in `js/app/main.js`.
- DOM/pointer-interaction code in `js/ui`/`js/app` is verified manually, never with simulated Playwright drags or clicks on `<dialog>` elements — only pure `js/core` (and `js/ui` modules with no DOM dependency, like `floatsession.js`'s exported functions) get automated tests, per this project's established test suite (`tests/*.mjs` only ever imports pure-logic modules).
- Follow existing code style: no comments explaining *what* code does, only non-obvious *why*; reuse existing helpers instead of re-implementing (e.g. `nearestColor`, `activeLayerScope`, `resolveRegion`).

---

## Task 1: `quantizeBitmapToPalette` core helper

**Files:**
- Modify: `js/core/palettes.js` (add function after `nearestColor`, i.e. after line 42)
- Test: `tests/palettes.test.mjs`

**Interfaces:**
- Consumes: `nearestColor(palette, rgba)` (already defined in the same file, unchanged).
- Produces: `quantizeBitmapToPalette(bitmap, palette)` — mutates `bitmap.data` in place, returns nothing. `bitmap` is `{ width, height, data: Uint8ClampedArray }` (the shape every `js/core/pixels.js` bitmap already uses). `palette` is any object with a `.colors` array of `[r,g,b,a]` arrays (a real project palette, a `SYSTEM_PALETTES` entry, or a bare `{ colors: [...] }` all work — `nearestColor` already only reads `.colors`).

- [ ] **Step 1: Write the failing tests**

Open `tests/palettes.test.mjs` and change the import at the top from:

```js
import {
  createPalette, parseHexColors, setEntry, addSwatch, removeSwatch,
  moveSwatch, nearestColor, remapColor, INDEXED_SIZE_PRESETS,
} from '../js/core/palettes.js';
```

to:

```js
import {
  createPalette, parseHexColors, setEntry, addSwatch, removeSwatch,
  moveSwatch, nearestColor, remapColor, quantizeBitmapToPalette, INDEXED_SIZE_PRESETS,
} from '../js/core/palettes.js';
```

Then add these two tests at the end of the file (after the `'size presets exported'` test):

```js
test('quantizeBitmapToPalette: maps opaque pixels to nearest palette color, preserves alpha; skips fully transparent pixels', () => {
  const b = createBitmap(3, 1);
  setPixel(b, 0, 0, [250, 5, 5, 255]);   // near red
  setPixel(b, 1, 0, [5, 5, 250, 128]);   // near blue, half alpha
  setPixel(b, 2, 0, [9, 9, 9, 0]);       // fully transparent -- must stay untouched
  const palette = { colors: [[255, 0, 0, 255], [0, 0, 255, 255]] };
  quantizeBitmapToPalette(b, palette);
  assert.deepEqual(getPixel(b, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(b, 1, 0), [0, 0, 255, 128]);
  assert.deepEqual(getPixel(b, 2, 0), [9, 9, 9, 0]);
});

test('quantizeBitmapToPalette: exact palette match is left byte-identical', () => {
  const b = createBitmap(1, 1);
  setPixel(b, 0, 0, [0, 0, 255, 255]);
  quantizeBitmapToPalette(b, { colors: [[255, 0, 0, 255], [0, 0, 255, 255]] });
  assert.deepEqual(getPixel(b, 0, 0), [0, 0, 255, 255]);
});
```

`createBitmap`, `setPixel`, `getPixel` are already imported at the top of this file (line 8) — no change needed there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `quantizeBitmapToPalette` is not exported from `../js/core/palettes.js` (a `SyntaxError`/`TypeError` naming it, since the import itself will fail).

- [ ] **Step 3: Implement `quantizeBitmapToPalette`**

In `js/core/palettes.js`, add this function immediately after `nearestColor` (after the closing `}` on line 42, before `remapColor`):

```js
// Mutates `bitmap` in place: every pixel with alpha > 0 is replaced by its
// nearest-RGB-distance match in `palette.colors` (alpha untouched, exact
// per-pixel semantics as nearestColor). Fully transparent pixels are
// skipped -- no visual effect, and skipping avoids bloating an undo diff
// with invisible changes.
export function quantizeBitmapToPalette(bitmap, palette) {
  const d = bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b, a] = nearestColor(palette, [d[i], d[i + 1], d[i + 2], d[i + 3]]);
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add js/core/palettes.js tests/palettes.test.mjs
git commit -m "feat: add quantizeBitmapToPalette core helper"
```

---

## Task 2: `currentEditRegion` export from `floatsession.js`

**Files:**
- Modify: `js/ui/floatsession.js` (add export after `registerFloatView`, i.e. after line 18)
- Test: Create `tests/floatsession.test.mjs`

**Interfaces:**
- Consumes: the module's existing private `activeView()` and `resolveRegion(viewApi, requireSelection, anchor)` (both already defined in this file, unchanged) and the existing exported `registerFloatView(viewKind, api)`.
- Produces: `currentEditRegion()` — returns `{ region: {x,y,w,h}, target: {x,y,w,h} }` for the CURRENT view (`state.view`), where `region` is the selection clamped to `target` or the whole `target` when there's no selection; or `null` when there's no active view registered for `state.view`, no active sheet, or the target rect is empty. Read-only: never touches `state.floating`.

- [ ] **Step 1: Write the failing tests**

Create `tests/floatsession.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../js/app/state.js';
import { registerFloatView, currentEditRegion } from '../js/ui/floatsession.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';

function setupProject() {
  const project = createProject('p');
  const sheet = createSheet(project, { name: 's', width: 20, height: 20, kind: 'sprite' });
  state.project = project;
  state.activeSheetId = sheet.id;
  state.activeLayerId = sheetLayers(sheet)[0].id;
  state.view = 'sheet';
  return sheet;
}

test('currentEditRegion: no selection returns the whole target rect', () => {
  setupProject();
  registerFloatView('sheet', {
    getSelection: () => null,
    setSelection: () => {},
    getTargetRect: () => ({ x: 0, y: 0, w: 20, h: 20 }),
  });
  const rr = currentEditRegion();
  assert.deepEqual(rr.region, { x: 0, y: 0, w: 20, h: 20 });
  assert.deepEqual(rr.target, { x: 0, y: 0, w: 20, h: 20 });
});

test('currentEditRegion: a selection is clamped to the target rect', () => {
  setupProject();
  registerFloatView('sheet', {
    getSelection: () => ({ x: 5, y: 5, w: 100, h: 100 }), // extends past the target
    setSelection: () => {},
    getTargetRect: () => ({ x: 0, y: 0, w: 20, h: 20 }),
  });
  const rr = currentEditRegion();
  assert.deepEqual(rr.region, { x: 5, y: 5, w: 15, h: 15 });
});

test('currentEditRegion: null when there is no active view registered for state.view', () => {
  setupProject();
  state.view = 'frame'; // never registered in this test file
  assert.equal(currentEditRegion(), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `currentEditRegion` is not exported from `../js/ui/floatsession.js`.

- [ ] **Step 3: Implement `currentEditRegion`**

In `js/ui/floatsession.js`, add this export immediately after `registerFloatView` (after line 18, `export function registerFloatView(viewKind, api) { views.set(viewKind, api); }`):

```js
// Selection-or-target region for the CURRENT view, same rule createFloat
// uses (selection clamped to target, or the whole target when there's no
// selection) -- null when there's no active view/sheet or the target is
// empty. Read-only: unlike createFloat, never touches state.floating.
export function currentEditRegion() {
  const viewApi = activeView();
  return viewApi ? resolveRegion(viewApi, false, null) : null;
}
```

(`activeView` and `resolveRegion` are already defined further down in this same file — `resolveRegion` is defined after this insertion point, which is fine, function declarations are hoisted.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add js/ui/floatsession.js tests/floatsession.test.mjs
git commit -m "feat: export currentEditRegion from floatsession.js"
```

---

## Task 3: Edit > Filters > Quantize to Palette… menu, dialog, and command

**Files:**
- Modify: `index.html` (new dialog markup, after line 204)
- Modify: `js/app/main.js` (imports, new dialog wiring block, new menu entry)

**Interfaces:**
- Consumes: `quantizeBitmapToPalette` (Task 1, from `../core/palettes.js`), `currentEditRegion` (Task 2, from `../ui/floatsession.js`), `activeLayerScope` (already exported from `./state.js`), `SYSTEM_PALETTES` (already exported from `../core/systempalettes.js`), `cloneBitmap`/`blitRegion` (already exported from `../core/pixels.js`), `defineAction`/`bindAction` (already imported), `commitFloatIfAny`/`activeSheet`/`activeLayer`/`markDirty`/`state` (already imported).
- Produces: two new actions (`edit.filters`, `edit.filters.quantizeToPalette`) reachable from the Edit menu. No other file depends on anything from this task.

This task has no pure-logic seam of its own (DOM dialog + menu wiring) — verified manually per this project's convention (see Global Constraints).

- [ ] **Step 1: Add the dialog markup to `index.html`**

Insert this new dialog immediately after the `dlg-renamesheet` dialog's closing tag (after line 204, before `<dialog id="dlg-about" class="sys-dialog">` on line 205):

```html
<dialog id="dlg-quantize">
  <h3>Quantize to Palette</h3>
  <div class="row"><label>Palette <select id="qz-palette"></select></label></div>
  <div class="row"><label><input type="checkbox" id="qz-alllayers"> All layers</label></div>
  <div class="row dlg-actions"><button id="qz-ok" class="btn-sm">OK</button><button id="qz-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

- [ ] **Step 2: Add new imports to `js/app/main.js`**

Change line 1 from:

```js
import { state, on, emit, activeSheet, activeLayer, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty, maybeSnapPixels } from './state.js';
```

to:

```js
import { state, on, emit, activeSheet, activeLayer, activeLayerScope, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty, maybeSnapPixels } from './state.js';
```

Change line 21 from:

```js
import { copyRegion } from '../core/pixels.js';
```

to:

```js
import { copyRegion, cloneBitmap, blitRegion } from '../core/pixels.js';
```

Change line 35 from:

```js
import { initFloatSession, commitFloatIfAny, cutSelection, copySelection, paste, hasSelection } from '../ui/floatsession.js';
```

to:

```js
import { initFloatSession, commitFloatIfAny, cutSelection, copySelection, paste, hasSelection, currentEditRegion } from '../ui/floatsession.js';
```

Add two new import lines right after line 21 (the `copyRegion, cloneBitmap, blitRegion` line):

```js
import { quantizeBitmapToPalette } from '../core/palettes.js';
import { SYSTEM_PALETTES } from '../core/systempalettes.js';
```

- [ ] **Step 3: Add the quantize dialog wiring + command function**

In `js/app/main.js`, find this existing block (currently lines 400-416):

```js
defineAction('edit.cut', { label: 'Cut', shortcut: 'Ctrl+X', run: () => cutSelection(false), isEnabled: hasSelection });
defineAction('edit.copy', { label: 'Copy', shortcut: 'Ctrl+C', run: () => copySelection(false), isEnabled: hasSelection });
defineAction('edit.paste', { label: 'Paste', shortcut: 'Ctrl+V', run: paste });
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); runAction('edit.undo'); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); runAction('edit.redo'); }
  else if (key === 's') {
    // Gated (unlike undo/redo above): Ctrl+S is a global browser shortcut
    // users may also press while a text field or dialog has focus, where we
    // want the browser/native field behavior, not a project save.
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    e.preventDefault();
    runAction('file.save');
  }
});
```

Insert a new block immediately after it (after the closing `});` of the `keydown` listener, before the `// ---- shortcuts: brush size [ / ], swap colors X (Ctrl/Alt-free, gated) ----` comment that follows):

```js

// ---- quantize to palette ----
function bitmapsEqual(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function quantizeToPalette(colors, allLayers) {
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet) return;
  const rr = currentEditRegion();
  if (!rr) return;
  const { region } = rr;
  const layers = allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []);
  const palette = { colors };
  const patches = layers.map(l => {
    const before = copyRegion(l.bitmap, region.x, region.y, region.w, region.h);
    const after = cloneBitmap(before);
    quantizeBitmapToPalette(after, palette);
    return { layer: l, before, after };
  }).filter(p => !bitmapsEqual(p.before, p.after));
  if (!patches.length) return;
  state.commands.push({
    label: 'quantize to palette',
    do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); emit('pixels'); },
    undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); emit('pixels'); },
  });
  markDirty();
}

const dlgQuantize = document.getElementById('dlg-quantize');
const qzPalette = document.getElementById('qz-palette');
const qzAllLayers = document.getElementById('qz-alllayers');
const qzOk = document.getElementById('qz-ok');
const qzCancel = document.getElementById('qz-cancel');
markDefaultAction(dlgQuantize, qzOk);

function refreshQuantizePaletteOptions() {
  qzPalette.innerHTML = '';
  const projGroup = document.createElement('optgroup');
  projGroup.label = 'Project Palettes';
  for (const p of state.project?.palettes ?? []) {
    if (!p.colors.length) continue;
    const o = document.createElement('option');
    o.value = `proj:${p.id}`;
    o.textContent = p.indexed ? `${p.name} (${p.colors.length})` : p.name;
    projGroup.appendChild(o);
  }
  if (projGroup.children.length) qzPalette.appendChild(projGroup);

  const sysGroup = document.createElement('optgroup');
  sysGroup.label = 'System Palettes';
  for (const sys of SYSTEM_PALETTES) {
    const o = document.createElement('option');
    o.value = `sys:${sys.name}`;
    o.textContent = `${sys.name} (${sys.colors.length})`;
    sysGroup.appendChild(o);
  }
  qzPalette.appendChild(sysGroup);

  const activeOpt = state.project?.activePaletteId ? `proj:${state.project.activePaletteId}` : null;
  if (activeOpt && [...qzPalette.options].some(o => o.value === activeOpt)) qzPalette.value = activeOpt;
  else if (qzPalette.options.length) qzPalette.selectedIndex = 0;
}

function resolveQuantizePalette(value) {
  if (value.startsWith('proj:')) return state.project?.palettes.find(p => p.id === value.slice(5)) ?? null;
  if (value.startsWith('sys:')) return SYSTEM_PALETTES.find(s => s.name === value.slice(4)) ?? null;
  return null;
}

defineAction('edit.filters', {
  label: 'Filters',
  submenu: [
    { action: 'edit.filters.quantizeToPalette' },
  ],
  isEnabled: () => !!activeSheet(),
});
defineAction('edit.filters.quantizeToPalette', {
  label: 'Quantize to Palette…',
  run: () => {
    refreshQuantizePaletteOptions();
    qzAllLayers.checked = false;
    dlgQuantize.showModal();
  },
  isEnabled: () => !!activeLayer(),
});
qzCancel.addEventListener('click', () => dlgQuantize.close());
qzOk.addEventListener('click', () => {
  const pal = resolveQuantizePalette(qzPalette.value);
  dlgQuantize.close();
  if (!pal || !pal.colors.length) return;
  quantizeToPalette(pal.colors, qzAllLayers.checked);
});
```

- [ ] **Step 4: Add the menu entry**

In `js/app/main.js`, find the `Edit` menu inside the `MENUS` array (currently):

```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
    { action: 'edit.projectSettings' },
  ] },
```

Change it to:

```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
    { action: 'edit.filters' }, { separator: true },
    { action: 'edit.projectSettings' },
  ] },
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS — this task adds no new automated tests, so this just confirms nothing else broke (import typos, etc.).

- [ ] **Step 6: Manual verification**

Start the app (`./serve.ps1`) and check:
1. Open a project, select a sprite sheet with a layer that has some non-palette colors on it.
2. `Edit > Filters > Quantize to Palette…` opens the dialog; the palette `<select>` shows a "Project Palettes" group (if the project has any non-empty palettes) and a "System Palettes" group (NES, Game Boy, PICO-8, etc.), with the project's active palette preselected if it has one.
3. With no marquee selection, pick a small palette (e.g. Game Boy, 4 colors) and click OK — every opaque pixel on the active layer snaps to one of those 4 colors; transparent pixels are untouched.
4. `Ctrl+Z` undoes it back to the original colors in one step; `Ctrl+Y` redoes it.
5. Draw a marquee selection over part of the layer, run the filter again — only pixels inside the selection change.
6. Add a second layer with different colors, check "All layers", run the filter — both layers get quantized independently (colors on each layer separately snap to nearest, not merged).
7. Open the frame editor or tile editor on a frame/tile that has content extending beyond it on the sheet, run the filter with no selection — only that frame's/tile's own pixels change, not the rest of the sheet.
8. Try it with an empty selection or with no active sheet (menu item disabled) — action never crashes.

- [ ] **Step 7: Commit**

```bash
git add index.html js/app/main.js
git commit -m "feat: add Edit > Filters > Quantize to Palette command"
```

---

## Self-Review Notes

- **Spec coverage:** Menu/submenu (Task 3 Step 4) ✓, dialog with project+system palette groups (Task 3 Steps 1, 3) ✓, all-layers checkbox (Task 3 Step 3) ✓, region resolution reusing `resolveRegion` (Task 2) ✓, core quantize helper reusing `nearestColor` (Task 1) ✓, single undo step + no-op skip via `bitmapsEqual` (Task 3 Step 3) ✓, testing plan (Tasks 1-2 automated, Task 3 manual, matching the spec's own testing section) ✓.
- **Placeholder scan:** none — every step has literal code.
- **Type consistency:** `quantizeBitmapToPalette(bitmap, palette)` (Task 1) is called identically in Task 3's `quantizeToPalette` with `palette = { colors }`; `currentEditRegion()` (Task 2) returns `{ region, target }`, and Task 3 only destructures `{ region }`, matching Task 2's real return shape (confirmed against `resolveRegion`'s existing behavior, not guessed).
