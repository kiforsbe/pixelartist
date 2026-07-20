# Quantize to Palette: Number-of-Colors Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Number of colors" mode to the existing `Edit > Filters > Quantize to Palette…` dialog: instead of picking an existing palette, the user picks a target color count N, and the filter builds an N-color palette from the region's own pixels via median-cut, then quantizes to it — same region/scope/undo semantics as the existing palette mode.

**Architecture:** A pure core helper (`medianCutPalette`, in `js/core/quantize.js` next to the existing `buildPalette`/`colorFrequency`/`quantizeBitmap` palette-reduction helpers) implements weighted median-cut over an RGB histogram. The existing `quantizeToPalette` command function in `js/app/main.js` gains a `mode` parameter so it can resolve its target colors either from a picked palette (today's behavior, unchanged) or by calling `medianCutPalette` on the region's own pixels. The dialog gets a radio toggle that swaps the palette `<select>` for a number input.

**Tech Stack:** Vanilla JS, ES modules, `node --test` for unit tests. No new dependencies.

## Global Constraints

- No dependencies, no build step (this project's standing rule — see `README.md`).
- Every command must be a single undo step (`state.commands.push({ label, do, undo })`), matching every existing pixel-editing command in `js/app/main.js`.
- DOM/pointer-interaction code in `js/ui`/`js/app` is verified manually, never with simulated Playwright drags or clicks on `<dialog>` elements — only pure `js/core` modules get automated tests, per this project's established test suite (`tests/*.mjs` only ever imports pure-logic modules).
- Follow existing code style: no comments explaining *what* code does, only non-obvious *why*; reuse existing helpers instead of re-implementing (e.g. `nearestColor`, `quantizeBitmapToPalette`, `activeLayerScope`, `currentEditRegion`).
- Median-cut alpha handling: the cut and the resulting palette entries only ever carry RGB — alpha is not part of the algorithm (it's only used to skip fully-transparent pixels from consideration, mirroring `colorFrequency`'s existing rule), because `nearestColor`/`quantizeBitmapToPalette` never read a palette entry's alpha, only the source pixel's.

---

## Task 1: `medianCutPalette` core helper

**Files:**
- Modify: `js/core/quantize.js` (add helpers + export after `quantizeBitmap`, i.e. after line 51)
- Test: `tests/quantize.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks — this is a standalone pure function.
- Produces: `medianCutPalette(bitmaps, maxColors)` — `bitmaps` is an array of `{ width, height, data: Uint8ClampedArray }` bitmaps (the same shape `colorFrequency`/`buildPalette` already accept). Returns an array of `[r, g, b]` triples, length `<= maxColors` (fewer only when the input has fewer than `maxColors` distinct opaque RGB values). Task 2 calls this with the region's `before` bitmaps and pads each result with a constant alpha before handing it to `quantizeBitmapToPalette`.

- [ ] **Step 1: Write the failing tests**

Open `tests/quantize.test.mjs` and change the import at the top from:

```js
import { colorFrequency, buildPalette, quantizeBitmap } from '../js/core/quantize.js';
```

to:

```js
import { colorFrequency, buildPalette, quantizeBitmap, medianCutPalette } from '../js/core/quantize.js';
```

Then add these four tests at the end of the file (after the `'quantizeBitmap: each pixel maps to its nearest palette index'` test):

```js
test('medianCutPalette: fewer distinct colors than maxColors returns them all unchanged', () => {
  const b = bmp(3, 1, [[10, 20, 30, 255], [10, 20, 30, 255], [40, 50, 60, 255]]);
  assert.deepEqual(medianCutPalette([b], 5), [[10, 20, 30], [40, 50, 60]]);
});

test('medianCutPalette: fully-transparent pixels excluded from the histogram', () => {
  const b = bmp(3, 1, [[255, 0, 0, 255], [0, 0, 0, 0], [0, 255, 0, 255]]);
  assert.deepEqual(medianCutPalette([b], 5), [[255, 0, 0], [0, 255, 0]]);
});

test('medianCutPalette: two color clusters reduced to 2 produce one average per cluster', () => {
  const pixels = [
    ...Array(5).fill([255, 0, 0, 255]),
    ...Array(5).fill([245, 5, 5, 255]),
    ...Array(5).fill([0, 0, 255, 255]),
    ...Array(5).fill([5, 5, 245, 255]),
  ];
  const b = bmp(20, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 2), [[3, 3, 250], [250, 3, 3]]);
});

test('medianCutPalette: a lopsided outlier color still gets its own palette entry', () => {
  const pixels = [
    [250, 0, 0, 255], [252, 0, 0, 255], [254, 0, 0, 255], [255, 0, 0, 255], [248, 0, 0, 255],
    [0, 0, 255, 255],
  ];
  const b = bmp(6, 1, pixels);
  assert.deepEqual(medianCutPalette([b], 3), [[249, 0, 0], [0, 0, 255], [254, 0, 0]]);
});
```

`bmp` is the existing local helper already defined at the top of this file (line 5) — no change needed there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `medianCutPalette` is not exported from `../js/core/quantize.js` (a `SyntaxError`/`TypeError` naming it, since the import itself will fail).

- [ ] **Step 3: Implement `medianCutPalette`**

In `js/core/quantize.js`, add this block at the end of the file (after `quantizeBitmap`'s closing `}` on line 51):

```js

// Counts pixels by exact (r,g,b) across all bitmaps, skipping alpha === 0
// (mirrors colorFrequency's transparency rule, but keys on RGB only --
// alpha never enters median-cut, see the module-level note above
// medianCutPalette).
function rgbHistogram(bitmaps) {
  const counts = new Map();
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => {
    const [r, g, b] = key.split(',').map(Number);
    return { r, g, b, count };
  });
}

function channelRange(box, ch) {
  let min = Infinity, max = -Infinity;
  for (const c of box) {
    const v = ch === 0 ? c.r : ch === 1 ? c.g : c.b;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

// Index of the box (of length >= 2) with the widest range on any RGB
// channel; -1 when every box has length 1 (nothing left to split -- this
// is what lets medianCutPalette return fewer than maxColors entries when
// the source has few distinct colors).
function widestBoxIndex(boxes) {
  let idx = -1, bestRange = -1;
  boxes.forEach((box, i) => {
    if (box.length < 2) return;
    for (let ch = 0; ch < 3; ch++) {
      const range = channelRange(box, ch);
      if (range > bestRange) { bestRange = range; idx = i; }
    }
  });
  return idx;
}

// Splits `box` on its widest channel at the count-weighted median.
function splitBox(box) {
  let widestCh = 0, bestRange = -1;
  for (let ch = 0; ch < 3; ch++) {
    const range = channelRange(box, ch);
    if (range > bestRange) { bestRange = range; widestCh = ch; }
  }
  const sorted = [...box].sort((a, b) => {
    const va = widestCh === 0 ? a.r : widestCh === 1 ? a.g : a.b;
    const vb = widestCh === 0 ? b.r : widestCh === 1 ? b.g : b.b;
    return va - vb;
  });
  const total = sorted.reduce((s, c) => s + c.count, 0);
  let acc = 0, splitAt = 1;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i].count;
    if (acc >= total / 2) { splitAt = i + 1; break; }
  }
  splitAt = Math.min(Math.max(splitAt, 1), sorted.length - 1);
  return [sorted.slice(0, splitAt), sorted.slice(splitAt)];
}

function averageColor(box) {
  let r = 0, g = 0, b = 0, total = 0;
  for (const c of box) {
    r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; total += c.count;
  }
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

// Builds an N-color palette from the given bitmaps via weighted median-cut
// over their opaque pixels' RGB values (alpha is never part of the cut --
// nearestColor/quantizeBitmapToPalette never read a palette entry's alpha,
// only the source pixel's, so it would only add noise). Returns up to
// maxColors [r,g,b] triples, fewer if there are fewer distinct RGB values
// than maxColors in the input.
export function medianCutPalette(bitmaps, maxColors) {
  const hist = rgbHistogram(bitmaps);
  if (hist.length <= maxColors) return hist.map(c => [c.r, c.g, c.b]);
  let boxes = [hist];
  while (boxes.length < maxColors) {
    const idx = widestBoxIndex(boxes);
    if (idx === -1) break;
    const [left, right] = splitBox(boxes[idx]);
    boxes.splice(idx, 1, left, right);
  }
  return boxes.map(averageColor);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add js/core/quantize.js tests/quantize.test.mjs
git commit -m "feat: add medianCutPalette core helper"
```

---

## Task 2: Dialog "Number of colors" mode + command wiring

**Files:**
- Modify: `index.html:205-210` (dialog markup)
- Modify: `js/app/main.js:17` (import), `js/app/main.js:420-514` (quantize block)

**Interfaces:**
- Consumes: `medianCutPalette` (Task 1, from `../core/quantize.js`); everything else already exists in `main.js` (`quantizeBitmapToPalette`, `currentEditRegion`, `activeLayerScope`, `cloneBitmap`/`blitRegion`, `copyRegion`).
- Produces: no new exports — this task only changes dialog markup and the existing `quantizeToPalette` function's signature and callers, both private to `main.js`.

This task has no pure-logic seam of its own (DOM dialog + command wiring) beyond `medianCutPalette` itself, already covered in Task 1 — verified manually per this project's convention (see Global Constraints).

- [ ] **Step 1: Update the dialog markup in `index.html`**

Replace the existing `dlg-quantize` dialog (lines 205-210):

```html
<dialog id="dlg-quantize">
  <h3>Quantize to Palette</h3>
  <div class="row"><label>Palette <select id="qz-palette"></select></label></div>
  <div class="row"><label><input type="checkbox" id="qz-alllayers"> All layers</label></div>
  <div class="row dlg-actions"><button id="qz-ok" class="btn-sm">OK</button><button id="qz-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

with:

```html
<dialog id="dlg-quantize">
  <h3>Quantize to Palette</h3>
  <div class="row">
    <label><input type="radio" name="qz-mode" id="qz-mode-palette" checked> Palette</label>
    <label><input type="radio" name="qz-mode" id="qz-mode-count"> Number of colors</label>
  </div>
  <div class="row" id="qz-palette-row"><label>Palette <select id="qz-palette"></select></label></div>
  <div class="row" id="qz-count-row" hidden><label>Colors <input type="number" id="qz-count" min="1" max="256" value="16"></label></div>
  <div class="row"><label><input type="checkbox" id="qz-alllayers"> All layers</label></div>
  <div class="row dlg-actions"><button id="qz-ok" class="btn-sm">OK</button><button id="qz-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

- [ ] **Step 2: Add the `medianCutPalette` import to `js/app/main.js`**

Change line 17 from:

```js
import { buildPalette, quantizeBitmap, colorFrequency } from '../core/quantize.js';
```

to:

```js
import { buildPalette, quantizeBitmap, colorFrequency, medianCutPalette } from '../core/quantize.js';
```

- [ ] **Step 3: Restructure `quantizeToPalette` and the dialog wiring**

In `js/app/main.js`, replace the entire block from the `// ---- quantize to palette ----` comment (line 420) through the closing `});` of the `qzOk` click listener (line 514) with:

```js
// ---- quantize to palette ----
function bitmapsEqual(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function quantizeToPalette(mode, param, allLayers) {
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet) return;
  const rr = currentEditRegion();
  if (!rr) return;
  const { region } = rr;
  const layers = allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []);
  if (!layers.length) return;
  const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
  const colors = mode === 'count'
    ? medianCutPalette(befores, param).map(c => [c[0], c[1], c[2], 255])
    : param;
  if (!colors.length) return;
  const palette = { colors };
  const patches = layers.map((l, i) => {
    const before = befores[i];
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
const qzModePalette = document.getElementById('qz-mode-palette');
const qzModeCount = document.getElementById('qz-mode-count');
const qzPaletteRow = document.getElementById('qz-palette-row');
const qzCountRow = document.getElementById('qz-count-row');
const qzPalette = document.getElementById('qz-palette');
const qzCount = document.getElementById('qz-count');
const qzAllLayers = document.getElementById('qz-alllayers');
const qzOk = document.getElementById('qz-ok');
const qzCancel = document.getElementById('qz-cancel');
markDefaultAction(dlgQuantize, qzOk);

function updateQuantizeModeUI() {
  const isCount = qzModeCount.checked;
  qzPaletteRow.hidden = isCount;
  qzCountRow.hidden = !isCount;
}
qzModePalette.addEventListener('change', updateQuantizeModeUI);
qzModeCount.addEventListener('change', updateQuantizeModeUI);

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
    qzModePalette.checked = true;
    updateQuantizeModeUI();
    qzAllLayers.checked = false;
    dlgQuantize.showModal();
  },
  isEnabled: () => !!activeLayer(),
});
qzCancel.addEventListener('click', () => dlgQuantize.close());
qzOk.addEventListener('click', () => {
  if (qzModeCount.checked) {
    const n = Math.max(1, Math.min(256, parseInt(qzCount.value, 10) || 16));
    dlgQuantize.close();
    quantizeToPalette('count', n, qzAllLayers.checked);
  } else {
    const pal = resolveQuantizePalette(qzPalette.value);
    dlgQuantize.close();
    if (!pal || !pal.colors.length) return;
    quantizeToPalette('palette', pal.colors, qzAllLayers.checked);
  }
});
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — this task adds no new automated tests, so this just confirms nothing else broke (import typos, etc.).

- [ ] **Step 5: Manual verification**

Start the app (`./serve.ps1`) and check:
1. Open a project, select a sprite sheet with a layer that has several distinct colors on it.
2. `Edit > Filters > Quantize to Palette…` opens the dialog with "Palette" mode selected by default, the palette `<select>` visible, and the "Number of colors" row hidden.
3. Click the "Number of colors" radio — the palette `<select>` hides, a "Colors" number input (defaulting to 16) appears.
4. With no marquee selection, set colors to a small number (e.g. 4) and click OK — the layer's opaque pixels reduce to (at most) 4 distinct colors, chosen from the layer's own colors, not from any existing palette; transparent pixels are untouched.
5. `Ctrl+Z` undoes it back to the original colors in one step; `Ctrl+Y` redoes it.
6. Draw a marquee selection over part of the layer, run the filter again in count mode — only pixels inside the selection are used to build the palette AND only those pixels change.
7. Add a second layer with different colors, check "All layers", run count mode with e.g. 4 colors — both layers reduce to colors drawn from ONE shared 4-color palette built from both layers' pixels combined (not two separately-generated 4-color palettes).
8. Re-open the dialog — it resets to "Palette" mode (not remembering the last-used "Number of colors" choice).
9. Switch back to "Palette" mode and confirm the original palette-based flow (Task 3 of the base filter's plan) still works unchanged.

- [ ] **Step 6: Commit**

```bash
git add index.html js/app/main.js
git commit -m "feat: add Number of colors mode to Quantize to Palette"
```

---

## Self-Review Notes

- **Spec coverage:** Core `medianCutPalette` with `rgbHistogram`/`widestBoxIndex`/`splitBox`/`averageColor` helpers (Task 1) ✓, dialog mode toggle + count input (Task 2 Step 1) ✓, mode reset on every open (Task 2 Step 3, `run` handler) ✓, `quantizeToPalette(mode, param, allLayers)` restructuring with shared diff/undo logic (Task 2 Step 3) ✓, pooled palette across layers in "All layers" + count mode (Task 2 Step 3 — `medianCutPalette(befores, param)` called once on the whole `befores` array) ✓, alpha padding at 255 (Task 2 Step 3) ✓, testing plan (Task 1 automated with hand-verified expected values, Task 2 manual, matching the spec's own testing section) ✓.
- **Placeholder scan:** none — every step has literal code.
- **Type consistency:** `medianCutPalette(bitmaps, maxColors)` (Task 1) returns `[r,g,b]` triples; Task 2's `quantizeToPalette` maps them to `[r,g,b,255]` before use as `palette.colors`, matching what `quantizeBitmapToPalette`/`nearestColor` (already existing, unchanged) expect. `currentEditRegion()`'s return shape (`{ region, target }`) is used identically to the base filter's plan (only `region` destructured).
- **Numeric test values:** the four `medianCutPalette` test expectations in Task 1 were computed by actually running the exact implementation code (not hand-derived), to avoid baking arithmetic mistakes into the plan.
