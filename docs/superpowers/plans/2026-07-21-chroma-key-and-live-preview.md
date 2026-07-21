# Chroma Key filter + live preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Chroma Key…" filter (Edit → Filters) that removes or recolors a chosen key color across a tolerance band, and retrofit both it and the existing "Quantize to Palette…" filter with a live preview shown in the right-hand Preview panel while their dialogs are open.

**Architecture:** A new pure, immutable core module (`js/core/chromakey.js`) computes the per-pixel effect. Both filters are split into a pure "compute patches" half (region + per-layer before/after, no undo-stack interaction) and a thin "commit" half (pushes the undo command) — the same compute half also feeds a shared live-preview helper that renders a hypothetical edit into the Preview panel (`js/ui/previewpanel.js`) without touching real layer data, via a new `overrideLayers` parameter on that panel's render pipeline.

**Tech Stack:** Vanilla JavaScript (ES modules), no build step, no dependencies. Tests run via `node --test tests/*.mjs` (Node's built-in test runner, no test framework dependency). Manual/browser verification via a static server (`./serve.ps1`) and Playwright MCP browser tools.

## Global Constraints

- No new dependencies — vanilla JS only, matching the project's "no build step" design (see `package.json`, `README.md`).
- Windows/PowerShell environment — any shell command in a verification step should work under PowerShell (plain `node`/`npm`/`git` commands used throughout are already cross-platform; no bash-only syntax).
- Core modules (`js/core/*.js`) stay pure and immutable: functions take a bitmap and return a NEW bitmap, never mutate the input — same convention `quantize.js`/`resolveAlphaForQuantize` already follow.
- Fully-transparent pixels (`alpha === 0`) are always left untouched by a filter — same convention `quantize.js`/`palettes.js` already follow.
- Dialogs follow the existing static-markup-in-`index.html` + `markDefaultAction` + `.row`/`.dlg-actions`/`.btn-sm` CSS pattern (see `#dlg-quantize`) — no new dialog framework.
- One `npm test` run (`node --test tests/*.mjs`) must stay green after every task.
- `?autotest` (`http://localhost:8080/?autotest`) suppresses native `confirm()`/`beforeunload` prompts for browser verification — always use it when driving the app via Playwright.
- Never simulate pointer drags in Playwright verification for this project — every interaction needed here (clicks, slider drags via keyboard/value-set, text input, color input) is achievable without a drag gesture.

---

## Task 1: Core chroma-key algorithm

**Files:**
- Create: `js/core/chromakey.js`
- Test: `tests/chromakey.test.mjs`

**Interfaces:**
- Produces: `chromaKeyBitmap(bmp, { keyColor, tolerance, softness, mode, replacementColor })` — `bmp: {width, height, data: Uint8ClampedArray}`, `keyColor`/`replacementColor: [r,g,b]`, `tolerance`/`softness: number (0-100)`, `mode: 'transparent' | 'replace'`. Returns a NEW bitmap of the same shape; never mutates `bmp`.

- [ ] **Step 1: Write the failing tests**

Create `tests/chromakey.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromaKeyBitmap } from '../js/core/chromakey.js';

function bmp(width, height, pixels) {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((rgba, i) => data.set(rgba, i * 4));
  return { width, height, data };
}

test('chromaKeyBitmap transparent mode: full match (within tolerance, no softness) zeroes RGBA like the eraser', () => {
  const b = bmp(1, 1, [[10, 10, 10, 255]]); // ~3.9% off black on the grey axis, well inside 50% tolerance
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 50, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [0, 0, 0, 0]);
});

test('chromaKeyBitmap: pixel beyond tolerance+softness is left byte-identical', () => {
  const b = bmp(1, 1, [[200, 200, 200, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 10, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [200, 200, 200, 255]);
});

test('chromaKeyBitmap: fully transparent source pixels are skipped even at zero distance', () => {
  const b = bmp(1, 1, [[0, 0, 0, 0]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 100, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [0, 0, 0, 0]);
});

test('chromaKeyBitmap transparent mode: mid-softness-band match gets partial alpha, RGB untouched', () => {
  // Grey-axis key (black) + grey-axis pixel cancels the sqrt(3) term out of the strength
  // ratio, so at tolerance=0/softness=100 strength reduces exactly to (255 - d) / 255,
  // which makes the resulting alpha come out to exactly d (128) with no rounding ambiguity.
  const b = bmp(1, 1, [[128, 128, 128, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 100, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...out.data], [128, 128, 128, 128]);
});

test('chromaKeyBitmap replace mode: full-strength match lerps RGB fully to replacementColor, alpha untouched', () => {
  const b = bmp(1, 1, [[200, 150, 50, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 100, softness: 0, mode: 'replace', replacementColor: [10, 20, 30] });
  assert.deepEqual([...out.data], [10, 20, 30, 255]);
});

test('chromaKeyBitmap replace mode: mid-softness-band match partially blends RGB toward replacementColor', () => {
  const b = bmp(1, 1, [[128, 128, 128, 255]]);
  const out = chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 0, softness: 100, mode: 'replace', replacementColor: [255, 255, 255] });
  // strength = (255-128)/255 = 127/255; newR = round(128 + (255-128) * 127/255) = round(191.25...) = 191
  assert.deepEqual([...out.data], [191, 191, 191, 255]);
});

test('chromaKeyBitmap: does not mutate the input bitmap', () => {
  const b = bmp(1, 1, [[10, 10, 10, 255]]);
  const before = [...b.data];
  chromaKeyBitmap(b, { keyColor: [0, 0, 0], tolerance: 50, softness: 0, mode: 'transparent', replacementColor: [255, 255, 255] });
  assert.deepEqual([...b.data], before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/chromakey.test.mjs`
Expected: FAIL — `Cannot find module '../js/core/chromakey.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `js/core/chromakey.js`:

```js
// Chroma-key filter: removes or recolors pixels close to a chosen key
// color. Pure/immutable like quantize.js -- returns a new bitmap, never
// mutates its input, so callers can diff before/after for undo and reuse
// the same call for a live preview.

const MAX_DISTANCE = Math.sqrt(3 * 255 * 255);

function colorDistance(r, g, b, key) {
  const dr = r - key[0], dg = g - key[1], db = b - key[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// 1 inside `tolerance` (percent of MAX_DISTANCE), 0 beyond
// `tolerance + softness`, linear falloff between the two -- softness === 0
// collapses this to a hard cutoff at `tolerance`.
function matchStrength(r, g, b, keyColor, tolerance, softness) {
  const dist = colorDistance(r, g, b, keyColor);
  const matchDist = (tolerance / 100) * MAX_DISTANCE;
  if (dist <= matchDist) return 1;
  const softDist = (softness / 100) * MAX_DISTANCE;
  if (softDist <= 0) return 0;
  const edge = matchDist + softDist;
  if (dist >= edge) return 0;
  return (edge - dist) / softDist;
}

// mode 'transparent': full-strength match becomes [0,0,0,0] (mirrors the
// eraser tool's own zero-everything convention, see js/ui/tools.js); a
// partial-strength match scales alpha down by (1 - strength), RGB
// untouched. mode 'replace': RGB is lerped toward replacementColor by
// strength; alpha is left untouched (a recolor, not a transparency op).
// Pixels already fully transparent are skipped -- nothing to key out,
// same alpha===0 skip convention as quantize.js.
export function chromaKeyBitmap(bmp, { keyColor, tolerance, softness, mode, replacementColor }) {
  const data = new Uint8ClampedArray(bmp.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const strength = matchStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness);
    if (strength <= 0) continue;
    if (mode === 'transparent') {
      if (strength >= 1) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
      else data[i + 3] = Math.round(data[i + 3] * (1 - strength));
    } else {
      data[i] = Math.round(data[i] + (replacementColor[0] - data[i]) * strength);
      data[i + 1] = Math.round(data[i + 1] + (replacementColor[1] - data[i + 1]) * strength);
      data[i + 2] = Math.round(data[i + 2] + (replacementColor[2] - data[i + 2]) * strength);
    }
  }
  return { width: bmp.width, height: bmp.height, data };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chromakey.test.mjs`
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — all existing tests still green, plus the 7 new ones.

- [ ] **Step 6: Commit**

```bash
git add js/core/chromakey.js tests/chromakey.test.mjs
git commit -m "feat: add chromaKeyBitmap core filter"
```

---

## Task 2: Export color hex helpers from panels.js

**Files:**
- Modify: `js/ui/panels.js:13-19`
- Test: `tests/panels.test.mjs` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `rgbaToHex([r,g,b,...])` → `'#rrggbb'` lowercase string; `hexToRgb('#rrggbb')` → `[r,g,b]`. Both now exported (previously module-private). Used by Task 5's chroma-key dialog to sync its `<input type="color">`/hex-text pairs, matching the Colors panel's existing swatch-editor pattern.

- [ ] **Step 1: Write the failing test**

Create `tests/panels.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbaToHex, hexToRgb } from '../js/ui/panels.js';

test('rgbaToHex: formats RGB as lowercase 6-digit hex, extra/alpha elements ignored', () => {
  assert.equal(rgbaToHex([255, 0, 128, 255]), '#ff0080');
  assert.equal(rgbaToHex([0, 0, 0, 0]), '#000000');
});

test('hexToRgb: parses a 6-digit hex string back to [r, g, b]', () => {
  assert.deepEqual(hexToRgb('#ff0080'), [255, 0, 128]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
});

test('rgbaToHex/hexToRgb round-trip', () => {
  const rgb = [12, 34, 56];
  assert.deepEqual(hexToRgb(rgbaToHex([...rgb, 255])), rgb);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/panels.test.mjs`
Expected: FAIL — `rgbaToHex`/`hexToRgb` are not exported from `js/ui/panels.js` (currently module-private `function` declarations, not `export function`).

- [ ] **Step 3: Export the two helpers**

In `js/ui/panels.js`, change:

```js
function rgbaToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
```

to:

```js
export function rgbaToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/panels.test.mjs`
Expected: PASS — 3 tests, 0 failures.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — all tests still green (this is a pure `export` addition, no behavior change for existing callers inside `panels.js`).

- [ ] **Step 6: Commit**

```bash
git add js/ui/panels.js tests/panels.test.mjs
git commit -m "feat: export rgbaToHex/hexToRgb from panels.js"
```

---

## Task 3: Preview panel override support

**Files:**
- Modify: `js/ui/previewpanel.js:88-109`

**Interfaces:**
- Consumes: nothing new (uses existing `flattenSheetLayers`, `copyRegion`, `activeSheet`, `currentContextLayers`, `state`, already imported in this file).
- Produces: `previewWithOverride(overrideLayers)` — runs the panel's normal frame/tile-rect-selection + flatten + `copyRegion` + `setPreviewBitmap` pipeline against a caller-supplied layers array instead of the real ones. `refreshPreviewPanel()` — re-renders from real project state (what a filter dialog calls on dialog close to drop a speculative preview). Tasks 4 and 5 both call these.

- [ ] **Step 1: Refactor `render()` and add the two new exports**

In `js/ui/previewpanel.js`, replace:

```js
function render() {
  if (!canvas) return;
  const sheet = activeSheet();
  if (!sheet) { setPreviewBitmap(null); return; }

  if (state.mode === 'sprites') {
    // An animation is selected: timeline.js owns the canvas (playhead frame,
    // pushed via setPreviewBitmap on every scrub/tick) -- don't fight it.
    if (state.selectedAnimationId) return;
    const frameId = state.editingFrameId ?? state.selectedFrameId;
    const frame = sheet.frames.find(f => f.id === frameId);
    if (!frame) { setPreviewBitmap(null); return; }
    const flat = flattenSheetLayers(currentContextLayers(), sheet.width, sheet.height, state.floating, sheet.id);
    setPreviewBitmap(copyRegion(flat, frame.x, frame.y, frame.w, frame.h));
  } else {
    const tileId = state.editingTileId ?? state.selectedTileId;
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile) { setPreviewBitmap(null); return; }
    const flat = flattenSheetLayers(currentContextLayers(), sheet.width, sheet.height, state.floating, sheet.id);
    setPreviewBitmap(copyRegion(flat, tile.x, tile.y, tile.w, tile.h));
  }
}
```

with:

```js
// overrideLayers: when given, flattened instead of currentContextLayers() --
// lets a filter dialog preview a hypothetical edit without touching real
// layer data. Only the layer CONTENT being previewed is swappable; which
// frame/tile is shown is still resolved from real state either way.
function render(overrideLayers = null) {
  if (!canvas) return;
  const sheet = activeSheet();
  if (!sheet) { setPreviewBitmap(null); return; }
  const layers = overrideLayers ?? currentContextLayers();

  if (state.mode === 'sprites') {
    // An animation is selected: timeline.js owns the canvas (playhead frame,
    // pushed via setPreviewBitmap on every scrub/tick) -- don't fight it.
    if (state.selectedAnimationId) return;
    const frameId = state.editingFrameId ?? state.selectedFrameId;
    const frame = sheet.frames.find(f => f.id === frameId);
    if (!frame) { setPreviewBitmap(null); return; }
    const flat = flattenSheetLayers(layers, sheet.width, sheet.height, state.floating, sheet.id);
    setPreviewBitmap(copyRegion(flat, frame.x, frame.y, frame.w, frame.h));
  } else {
    const tileId = state.editingTileId ?? state.selectedTileId;
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile) { setPreviewBitmap(null); return; }
    const flat = flattenSheetLayers(layers, sheet.width, sheet.height, state.floating, sheet.id);
    setPreviewBitmap(copyRegion(flat, tile.x, tile.y, tile.w, tile.h));
  }
}

// Runs the normal frame/tile-rect selection + flatten + copyRegion +
// setPreviewBitmap pipeline against a caller-supplied layers array instead
// of the real ones -- the hook filter dialogs use to preview an edit that
// hasn't been committed yet.
export function previewWithOverride(overrideLayers) { render(overrideLayers); }

// Re-renders from real project state -- what a filter dialog calls on
// close (OK or Cancel) to drop any speculative preview and resume normal
// context-driven display.
export function refreshPreviewPanel() { render(); }
```

All existing call sites (`on('project', render)`, `on('history', render)`, `on('view', render)`, `on('selection', render)`, and the initial `render()` at the end of `mountPreviewPanel`) call `render()` with no arguments, which now defaults `overrideLayers` to `null` — behavior is unchanged for every existing caller.

- [ ] **Step 2: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — no test imports `previewpanel.js` (it's DOM-dependent, `document.createElement('canvas')` etc.), so this step only confirms the change didn't break an unrelated module via a typo.

- [ ] **Step 3: Manual verification — no regression in normal (non-override) preview behavior**

Run: `./serve.ps1` (or `python -m http.server 8080`), then open `http://localhost:8080/?autotest` in a Playwright-driven browser tab.

1. Confirm the page loads with zero console errors.
2. Select a frame in the Frames panel (or a tile in Tile Sheets mode) — the Preview panel (bottom-right sidebar) shows its content, same as before this change.
3. Draw a pixel on the canvas — the Preview panel updates to match.

No new UI is reachable yet at this point (`previewWithOverride`/`refreshPreviewPanel` have no caller until Task 4), so this step is purely a no-regression check on the refactored `render()`.

- [ ] **Step 4: Commit**

```bash
git add js/ui/previewpanel.js
git commit -m "feat: add layer-override support to the Preview panel"
```

---

## Task 4: Quantize to Palette — compute/commit split + live preview

**Files:**
- Modify: `js/app/main.js:1` (import line)
- Modify: `js/app/main.js:32` (import line)
- Modify: `js/app/main.js:420-546` (quantize section)
- Modify: `tests/smoke.md` (append a checklist item)

**Interfaces:**
- Consumes: `previewWithOverride`, `refreshPreviewPanel` (Task 3, from `js/ui/previewpanel.js`); `currentContextLayers` (already exported from `js/app/state.js`, not yet imported into `main.js`).
- Produces: `buildPreviewLayers(region, patches)` and `pushLivePreview(result)` — shared helpers Task 5's chroma-key dialog also calls. `computeQuantizePatches(mode, param, allLayers, preferOpaque)` → `{ region, patches } | null`, `patches: [{layer, before, after}]`.

- [ ] **Step 1: Add `currentContextLayers` to the `state.js` import**

In `js/app/main.js:1`, change:

```js
import { state, on, emit, activeSheet, activeLayer, activeLayerScope, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty, maybeSnapPixels } from './state.js';
```

to:

```js
import { state, on, emit, activeSheet, activeLayer, activeLayerScope, currentContextLayers, setProject, newDefaultProject, AUTOTEST, confirmOrAuto, markDirty, maybeSnapPixels } from './state.js';
```

- [ ] **Step 2: Import the two new previewpanel.js exports**

In `js/app/main.js:32`, change:

```js
import { mountPreviewPanel } from '../ui/previewpanel.js';
```

to:

```js
import { mountPreviewPanel, previewWithOverride, refreshPreviewPanel } from '../ui/previewpanel.js';
```

- [ ] **Step 3: Split `quantizeToPalette` into compute/commit and add the shared preview helpers**

In `js/app/main.js`, replace the whole `// ---- quantize to palette ----` section (from `function bitmapsEqual` through the end of `function quantizeToPalette`, i.e. the current lines 420-456):

```js
// ---- quantize to palette ----
function bitmapsEqual(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

function quantizeToPalette(mode, param, allLayers, preferOpaque = false) {
  commitFloatIfAny();
  const sheet = activeSheet();
  if (!sheet) return;
  const rr = currentEditRegion();
  if (!rr) return;
  const { region } = rr;
  const layers = allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []);
  if (!layers.length) return;
  const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
  const quantizeSource = (mode === 'count' && preferOpaque) ? resolveAlphaForQuantize(befores, param) : befores;
  const colors = mode === 'count'
    ? medianCutPalette(quantizeSource, param).map(c => [c[0], c[1], c[2], 255])
    : param;
  if (!colors.length) return;
  const palette = { colors };
  const patches = layers.map((l, i) => {
    const before = befores[i];
    const after = cloneBitmap(quantizeSource[i]);
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
```

with:

```js
// ---- shared filter-preview plumbing (chroma key + quantize) ----

// Builds a layers array suitable for flattenSheetLayers/previewWithOverride:
// every layer in currentContextLayers() passes through unchanged EXCEPT
// layers with a patch, which get a shallow-cloned layer object wrapping a
// bitmap clone with `after` blitted into `region` -- real layer data is
// never touched by a preview.
function buildPreviewLayers(region, patches) {
  const byId = new Map(patches.map(p => [p.layer.id, p]));
  return currentContextLayers().map(l => {
    const p = byId.get(l.id);
    if (!p) return l;
    const bitmap = cloneBitmap(l.bitmap);
    blitRegion(bitmap, p.after, region.x, region.y);
    return { ...l, bitmap };
  });
}

// result: { region, patches } as returned by computeQuantizePatches/
// computeChromaKeyPatches, or null. Pushes a live preview of the
// not-yet-committed edit into the Preview panel, or drops back to the
// real state when there's nothing to preview (e.g. no layer selected).
function pushLivePreview(result) {
  if (!result || !result.patches.length) { refreshPreviewPanel(); return; }
  previewWithOverride(buildPreviewLayers(result.region, result.patches));
}

// ---- quantize to palette ----
function bitmapsEqual(a, b) {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

// Pure compute half: resolves the target region/layers and returns
// { region, patches } with no-op layers filtered out -- shared by the real
// commit (quantizeToPalette) and the dialog's live preview. Returns null
// when there's no sheet/region/layer/color to operate on.
function computeQuantizePatches(mode, param, allLayers, preferOpaque = false) {
  const sheet = activeSheet();
  if (!sheet) return null;
  const rr = currentEditRegion();
  if (!rr) return null;
  const { region } = rr;
  const layers = allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []);
  if (!layers.length) return null;
  const befores = layers.map(l => copyRegion(l.bitmap, region.x, region.y, region.w, region.h));
  const quantizeSource = (mode === 'count' && preferOpaque) ? resolveAlphaForQuantize(befores, param) : befores;
  const colors = mode === 'count'
    ? medianCutPalette(quantizeSource, param).map(c => [c[0], c[1], c[2], 255])
    : param;
  if (!colors.length) return null;
  const palette = { colors };
  const patches = layers.map((l, i) => {
    const before = befores[i];
    const after = cloneBitmap(quantizeSource[i]);
    quantizeBitmapToPalette(after, palette);
    return { layer: l, before, after };
  }).filter(p => !bitmapsEqual(p.before, p.after));
  return { region, patches };
}

function quantizeToPalette(mode, param, allLayers, preferOpaque = false) {
  commitFloatIfAny();
  const result = computeQuantizePatches(mode, param, allLayers, preferOpaque);
  if (!result || !result.patches.length) return;
  const { region, patches } = result;
  state.commands.push({
    label: 'quantize to palette',
    do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); emit('pixels'); },
    undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); emit('pixels'); },
  });
  markDirty();
}
```

- [ ] **Step 4: Wire the dialog's controls to live-preview, and refresh the panel on close**

In `js/app/main.js`, in the `dlgQuantize` wiring block, replace:

```js
function updateQuantizeModeUI() {
  const isCount = qzModeCount.checked;
  qzPaletteRow.hidden = isCount;
  qzCountRow.hidden = !isCount;
  qzPreferOpaqueRow.hidden = !isCount;
}
qzModePalette.addEventListener('change', updateQuantizeModeUI);
qzModeCount.addEventListener('change', updateQuantizeModeUI);
```

with:

```js
function updateQuantizeModeUI() {
  const isCount = qzModeCount.checked;
  qzPaletteRow.hidden = isCount;
  qzCountRow.hidden = !isCount;
  qzPreferOpaqueRow.hidden = !isCount;
}
function previewQuantize() {
  let result;
  if (qzModeCount.checked) {
    const n = Math.max(1, Math.min(256, parseInt(qzCount.value, 10) || 16));
    result = computeQuantizePatches('count', n, qzAllLayers.checked, qzPreferOpaque.checked);
  } else {
    const pal = resolveQuantizePalette(qzPalette.value);
    result = pal && pal.colors.length ? computeQuantizePatches('palette', pal.colors, qzAllLayers.checked) : null;
  }
  pushLivePreview(result);
}
qzModePalette.addEventListener('change', () => { updateQuantizeModeUI(); previewQuantize(); });
qzModeCount.addEventListener('change', () => { updateQuantizeModeUI(); previewQuantize(); });
qzPalette.addEventListener('change', previewQuantize);
qzCount.addEventListener('input', previewQuantize);
qzPreferOpaque.addEventListener('change', previewQuantize);
qzAllLayers.addEventListener('change', previewQuantize);
```

(`resolveQuantizePalette` and `qzPalette`/`qzCount`/`qzPreferOpaque`/`qzAllLayers` are declared earlier in this same block, unchanged — see the surrounding code.)

Then replace:

```js
defineAction('edit.filters.quantizeToPalette', {
  label: 'Quantize to Palette…',
  run: () => {
    refreshQuantizePaletteOptions();
    qzModePalette.checked = true;
    updateQuantizeModeUI();
    qzAllLayers.checked = false;
    qzPreferOpaque.checked = false;
    dlgQuantize.showModal();
  },
  isEnabled: () => !!activeLayer(),
});
qzCancel.addEventListener('click', () => dlgQuantize.close());
qzOk.addEventListener('click', () => {
  if (qzModeCount.checked) {
    const n = Math.max(1, Math.min(256, parseInt(qzCount.value, 10) || 16));
    dlgQuantize.close();
    quantizeToPalette('count', n, qzAllLayers.checked, qzPreferOpaque.checked);
  } else {
    const pal = resolveQuantizePalette(qzPalette.value);
    dlgQuantize.close();
    if (!pal || !pal.colors.length) return;
    quantizeToPalette('palette', pal.colors, qzAllLayers.checked);
  }
});
```

with:

```js
defineAction('edit.filters.quantizeToPalette', {
  label: 'Quantize to Palette…',
  run: () => {
    refreshQuantizePaletteOptions();
    qzModePalette.checked = true;
    updateQuantizeModeUI();
    qzAllLayers.checked = false;
    qzPreferOpaque.checked = false;
    previewQuantize();
    dlgQuantize.showModal();
  },
  isEnabled: () => !!activeLayer(),
});
qzCancel.addEventListener('click', () => { refreshPreviewPanel(); dlgQuantize.close(); });
qzOk.addEventListener('click', () => {
  refreshPreviewPanel();
  if (qzModeCount.checked) {
    const n = Math.max(1, Math.min(256, parseInt(qzCount.value, 10) || 16));
    dlgQuantize.close();
    quantizeToPalette('count', n, qzAllLayers.checked, qzPreferOpaque.checked);
  } else {
    const pal = resolveQuantizePalette(qzPalette.value);
    dlgQuantize.close();
    if (!pal || !pal.colors.length) return;
    quantizeToPalette('palette', pal.colors, qzAllLayers.checked);
  }
});
```

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — no existing test exercises this dialog/command wiring directly (it's DOM-driven); this confirms the edit didn't break an unrelated import/module.

- [ ] **Step 6: Manual verification**

Run: `./serve.ps1`, open `http://localhost:8080/?autotest` in a Playwright-driven browser tab.

1. Draw a few different-colored pixels on the active sprite sheet.
2. Edit → Filters → Quantize to Palette…: the dialog opens AND the Preview panel immediately shows the quantized result (not the original) for the default settings.
3. Switch between "Palette" and "Number of colors" modes, change the palette selection / colors count / "Prefer opaque colors" / "All layers" — the Preview panel updates after each change, with no console errors.
4. Click Cancel — the Preview panel reverts to showing the real, un-quantized content; the canvas itself is unchanged.
5. Reopen, adjust settings, click OK — the canvas updates to the quantized result, the Preview panel matches it, and `Ctrl+Z` restores the original pixels (Preview panel follows, since it also listens on `history`).

- [ ] **Step 7: Add a smoke-checklist entry**

Append to `tests/smoke.md`, after item 101 (end of "## 18. v6: thumbnail smoothing, timeline dock resize", before "## Pass criteria"):

```markdown
## 19. Chroma key + live preview

102. [A] Edit > Filters > Quantize to Palette…: opening the dialog
     immediately shows a live preview of the current settings in the
     Preview panel (right sidebar); changing palette/count/prefer-opaque/
     all-layers updates the preview in real time; Cancel reverts the panel
     to the real (unchanged) content; OK commits and the panel matches the
     committed result.
```

- [ ] **Step 8: Commit**

```bash
git add js/app/main.js tests/smoke.md
git commit -m "feat: live-preview Quantize to Palette via the Preview panel"
```

---

## Task 5: Chroma Key dialog

**Files:**
- Modify: `index.html:216` (insert new dialog markup)
- Modify: `js/app/main.js` (imports + new chroma-key section + `edit.filters` submenu)
- Modify: `tests/smoke.md` (append a checklist item)

**Interfaces:**
- Consumes: `chromaKeyBitmap` (Task 1), `rgbaToHex`/`hexToRgb` (Task 2), `buildPreviewLayers`/`pushLivePreview`/`bitmapsEqual` (Task 4, same file), `previewWithOverride`/`refreshPreviewPanel` (Task 3).
- Produces: new menu action `edit.filters.chromaKey`, dialog `#dlg-chromakey`.

- [ ] **Step 1: Add the dialog markup to `index.html`**

In `index.html`, right after the closing `</dialog>` of `#dlg-quantize` (line 216) and before `<dialog id="dlg-about" ...>`, insert:

```html
<dialog id="dlg-chromakey">
  <h3>Chroma Key</h3>
  <div class="row">
    <label>Key color <input type="color" id="ck-color"> <input type="text" id="ck-color-hex" size="7"></label>
    <button type="button" id="ck-color-primary" class="btn-sm">← Primary</button>
    <button type="button" id="ck-color-secondary" class="btn-sm">← Secondary</button>
  </div>
  <div class="row">
    <label><input type="radio" name="ck-mode" id="ck-mode-transparent" checked> Make transparent</label>
    <label><input type="radio" name="ck-mode" id="ck-mode-replace"> Replace with color</label>
  </div>
  <div class="row" id="ck-replace-row" hidden>
    <label>Replace with <input type="color" id="ck-replace-color"> <input type="text" id="ck-replace-hex" size="7"></label>
    <button type="button" id="ck-replace-primary" class="btn-sm">← Primary</button>
    <button type="button" id="ck-replace-secondary" class="btn-sm">← Secondary</button>
  </div>
  <div class="row"><label>Tolerance <input type="range" id="ck-tolerance" min="0" max="100" value="15"> <span id="ck-tolerance-val">15</span></label></div>
  <div class="row"><label>Softness <input type="range" id="ck-softness" min="0" max="100" value="10"> <span id="ck-softness-val">10</span></label></div>
  <div class="row"><label><input type="checkbox" id="ck-alllayers"> All layers</label></div>
  <div class="row dlg-actions"><button id="ck-ok" class="btn-sm">OK</button><button id="ck-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

- [ ] **Step 2: Import `chromaKeyBitmap` and the hex helpers in `main.js`**

In `js/app/main.js`, change:

```js
import { quantizeBitmapToPalette } from '../core/palettes.js';
```

to:

```js
import { quantizeBitmapToPalette } from '../core/palettes.js';
import { chromaKeyBitmap } from '../core/chromakey.js';
import { rgbaToHex, hexToRgb } from '../ui/panels.js';
```

- [ ] **Step 3: Add the compute/commit functions and dialog wiring**

In `js/app/main.js`, right after the closing `});` of the `qzOk.addEventListener('click', ...)` block from Task 4 (end of the quantize dialog section), add:

```js
// ---- chroma key ----

// Pure compute half, mirroring computeQuantizePatches -- shared by the
// real commit (commitChromaKey) and the dialog's live preview.
function computeChromaKeyPatches(params, allLayers) {
  const sheet = activeSheet();
  if (!sheet) return null;
  const rr = currentEditRegion();
  if (!rr) return null;
  const { region } = rr;
  const layers = allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []);
  if (!layers.length) return null;
  const patches = layers.map(l => {
    const before = copyRegion(l.bitmap, region.x, region.y, region.w, region.h);
    const after = chromaKeyBitmap(before, params);
    return { layer: l, before, after };
  }).filter(p => !bitmapsEqual(p.before, p.after));
  return { region, patches };
}

function commitChromaKey(params, allLayers) {
  commitFloatIfAny();
  const result = computeChromaKeyPatches(params, allLayers);
  if (!result || !result.patches.length) return;
  const { region, patches } = result;
  state.commands.push({
    label: 'chroma key',
    do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); emit('pixels'); },
    undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); emit('pixels'); },
  });
  markDirty();
}

const dlgChromaKey = document.getElementById('dlg-chromakey');
const ckColor = document.getElementById('ck-color');
const ckColorHex = document.getElementById('ck-color-hex');
const ckColorPrimary = document.getElementById('ck-color-primary');
const ckColorSecondary = document.getElementById('ck-color-secondary');
const ckModeTransparent = document.getElementById('ck-mode-transparent');
const ckModeReplace = document.getElementById('ck-mode-replace');
const ckReplaceRow = document.getElementById('ck-replace-row');
const ckReplaceColor = document.getElementById('ck-replace-color');
const ckReplaceHex = document.getElementById('ck-replace-hex');
const ckReplacePrimary = document.getElementById('ck-replace-primary');
const ckReplaceSecondary = document.getElementById('ck-replace-secondary');
const ckTolerance = document.getElementById('ck-tolerance');
const ckToleranceVal = document.getElementById('ck-tolerance-val');
const ckSoftness = document.getElementById('ck-softness');
const ckSoftnessVal = document.getElementById('ck-softness-val');
const ckAllLayers = document.getElementById('ck-alllayers');
const ckOk = document.getElementById('ck-ok');
const ckCancel = document.getElementById('ck-cancel');
markDefaultAction(dlgChromaKey, ckOk);

function setColorInputs(colorEl, hexEl, rgb) {
  hexEl.value = rgbaToHex(rgb);
  colorEl.value = hexEl.value;
}

function previewChromaKey() {
  pushLivePreview(computeChromaKeyPatches(currentChromaKeyParams(), ckAllLayers.checked));
}

// Reads from the native color inputs (ckColor/ckReplaceColor), not the
// free-text hex fields -- a <input type="color"> value is ALWAYS a valid
// lowercase 6-digit hex per spec, whereas the hex text field can be
// mid-edit and invalid (e.g. OK clicked while it reads "#ff"), which would
// otherwise feed garbage into hexToRgb.
function currentChromaKeyParams() {
  return {
    keyColor: hexToRgb(ckColor.value),
    tolerance: Number(ckTolerance.value),
    softness: Number(ckSoftness.value),
    mode: ckModeReplace.checked ? 'replace' : 'transparent',
    replacementColor: hexToRgb(ckReplaceColor.value),
  };
}

ckColor.addEventListener('input', () => { ckColorHex.value = ckColor.value; previewChromaKey(); });
ckColorHex.addEventListener('input', () => {
  if (!/^#[0-9a-fA-F]{6}$/.test(ckColorHex.value)) return;
  // <input type="color">.value must be lowercase per the HTML "simple color"
  // spec -- assigning mixed-/upper-case hex silently resets it to black in
  // strict implementations, so normalize before assigning.
  ckColor.value = ckColorHex.value.toLowerCase();
  previewChromaKey();
});
ckColorPrimary.addEventListener('click', () => { setColorInputs(ckColor, ckColorHex, state.primary); previewChromaKey(); });
ckColorSecondary.addEventListener('click', () => { setColorInputs(ckColor, ckColorHex, state.secondary); previewChromaKey(); });

ckReplaceColor.addEventListener('input', () => { ckReplaceHex.value = ckReplaceColor.value; previewChromaKey(); });
ckReplaceHex.addEventListener('input', () => {
  if (!/^#[0-9a-fA-F]{6}$/.test(ckReplaceHex.value)) return;
  ckReplaceColor.value = ckReplaceHex.value.toLowerCase();
  previewChromaKey();
});
ckReplacePrimary.addEventListener('click', () => { setColorInputs(ckReplaceColor, ckReplaceHex, state.primary); previewChromaKey(); });
ckReplaceSecondary.addEventListener('click', () => { setColorInputs(ckReplaceColor, ckReplaceHex, state.secondary); previewChromaKey(); });

function updateChromaKeyModeUI() {
  ckReplaceRow.hidden = !ckModeReplace.checked;
}
ckModeTransparent.addEventListener('change', () => { updateChromaKeyModeUI(); previewChromaKey(); });
ckModeReplace.addEventListener('change', () => { updateChromaKeyModeUI(); previewChromaKey(); });

ckTolerance.addEventListener('input', () => { ckToleranceVal.textContent = ckTolerance.value; previewChromaKey(); });
ckSoftness.addEventListener('input', () => { ckSoftnessVal.textContent = ckSoftness.value; previewChromaKey(); });
ckAllLayers.addEventListener('change', previewChromaKey);

defineAction('edit.filters.chromaKey', {
  label: 'Chroma Key…',
  run: () => {
    setColorInputs(ckColor, ckColorHex, state.primary);
    ckModeTransparent.checked = true;
    updateChromaKeyModeUI();
    setColorInputs(ckReplaceColor, ckReplaceHex, state.secondary);
    ckTolerance.value = '15'; ckToleranceVal.textContent = '15';
    ckSoftness.value = '10'; ckSoftnessVal.textContent = '10';
    ckAllLayers.checked = false;
    previewChromaKey();
    dlgChromaKey.showModal();
  },
  isEnabled: () => !!activeLayer(),
});
ckCancel.addEventListener('click', () => { refreshPreviewPanel(); dlgChromaKey.close(); });
ckOk.addEventListener('click', () => {
  refreshPreviewPanel();
  const params = currentChromaKeyParams();
  dlgChromaKey.close();
  commitChromaKey(params, ckAllLayers.checked);
});
```

- [ ] **Step 4: Add the menu entry**

In `js/app/main.js`, change:

```js
defineAction('edit.filters', {
  label: 'Filters',
  submenu: [
    { action: 'edit.filters.quantizeToPalette' },
  ],
  isEnabled: () => !!activeSheet(),
});
```

to:

```js
defineAction('edit.filters', {
  label: 'Filters',
  submenu: [
    { action: 'edit.filters.quantizeToPalette' },
    { action: 'edit.filters.chromaKey' },
  ],
  isEnabled: () => !!activeSheet(),
});
```

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS — no automated test touches this dialog wiring; confirms no unrelated import/syntax break.

- [ ] **Step 6: Manual verification**

Run: `./serve.ps1`, open `http://localhost:8080/?autotest` in a Playwright-driven browser tab.

1. Set the primary color to a distinctive color (e.g. bright green) and paint several pixels of it, plus some other-colored pixels, on the active sprite sheet.
2. Edit → Filters → Chroma Key… — the dialog opens with Key color pre-filled to the current primary color, "Make transparent" selected, Tolerance 15 / Softness 10, and the Preview panel already shows a live preview (the green pixels made transparent or partially transparent, other pixels unaffected).
3. Drag Tolerance and Softness — the Preview panel's affected area changes size/softness in real time; no console errors.
4. Click "Replace with color" — the Replace-with row appears; the Preview panel now shows the green pixels recolored toward the replace color instead of transparent.
5. Edit the Key color hex field directly (type a 6-digit hex) — the color swatch and preview update; type an invalid/partial hex — no crash, preview simply doesn't update until it's valid again.
6. Click "← Secondary" next to Key color — the key color field snaps to the current secondary color and the preview updates accordingly.
7. Click Cancel — the Preview panel reverts to the real, unmodified canvas content; the canvas itself is unchanged.
8. Reopen, adjust settings, click OK — the canvas updates to the keyed result, the Preview panel matches it, and `Ctrl+Z` restores the original pixels.

- [ ] **Step 7: Add a smoke-checklist entry**

Append to `tests/smoke.md`, in the "## 19. Chroma key + live preview" section added by Task 4, after item 102:

```markdown
103. [A] Edit > Filters > Chroma Key…: opens pre-filled with the primary
     color as Key color; toggling "Replace with color" reveals the
     Replace-with color row; dragging Tolerance/Softness and editing the
     color/hex fields all update the Preview panel live; "← Primary"/
     "← Secondary" buttons re-seed the corresponding color field; OK
     commits one undo step (Ctrl+Z restores the pre-key pixels), Cancel
     discards the preview and leaves pixels untouched.
```

- [ ] **Step 8: Commit**

```bash
git add index.html js/app/main.js tests/smoke.md
git commit -m "feat: add Chroma Key filter with live preview"
```
