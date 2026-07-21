# Chroma Key filter + live preview (also retrofits Quantize to Palette)

Date: 2026-07-21
Status: approved

## Goal

A new Edit → Filters entry, **Chroma Key…**, that removes or recolors a
chosen "key" color across a tolerance band — the classic "cut out the
green/magenta background" cleanup step for pixel art imported or composited
from other sources. It lands alongside the existing `edit.filters.quantizeToPalette`
in the same `edit.filters` submenu.

Because chroma-key results are hard to predict from numbers alone, this
filter gets a live preview: while its dialog is open, the existing
**Preview** side panel (`js/ui/previewpanel.js`) shows the filtered result
in real time as the user adjusts color/tolerance/mode, instead of only
after committing. The Quantize to Palette dialog is retrofitted with the
same live-preview mechanism in this change, since both filters can now
share one piece of infrastructure rather than building it twice.

## Out of scope

- No in-dialog eyedropper / canvas color sampling. Both dialogs are native
  `showModal()` dialogs, which block pointer interaction with the canvas
  underneath; teaching either dialog to sample from canvas would mean
  closing/un-modal-ing it mid-flow, which is more machinery than this
  feature needs. Key/replace colors are set via a `<input type="color">` +
  hex field, seeded from the current primary/secondary paint colors, with
  quick "← Primary" / "← Secondary" buttons to re-seed on demand.
- No dithering, no multi-key-color lists — one key color, one tolerance
  band, matching `quantizeToPalette`'s existing "keep the first cut
  simple" precedent.
- No new palette-management or color-history UI.
- No change to `quantizeToPalette`'s actual output/behavior — the retrofit
  only adds a preview; the committed result is byte-identical to before.

## Core algorithm — `js/core/chromakey.js` (new)

Pure, immutable function mirroring `quantize.js`'s style (returns a new
bitmap, never mutates its input, so callers can diff before/after for undo
and reuse the same call for preview):

```js
// Per-pixel RGB distance to keyColor, normalized to 0-100 so tolerance/
// softness read as percentages of the maximum possible color distance
// (sqrt(3 * 255^2)). Pixels already fully transparent are left alone --
// nothing to key out, same alpha===0 skip convention as quantize.js.
//
// matchStrength: 1 inside `tolerance`, 0 beyond `tolerance + softness`,
// linear falloff between (softness === 0 collapses this to a hard cutoff
// at `tolerance`).
//
// mode 'transparent': full-strength match becomes [0,0,0,0] (mirrors the
// eraser tool's own zero-everything convention); partial-strength scales
// alpha down by (1 - strength), RGB untouched.
// mode 'replace': RGB is lerped toward replacementColor by strength;
// alpha is left untouched (a recolor, not a transparency op).
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

`matchStrength` is a small local helper (RGB Euclidean distance → 0-100
scale → banded falloff), not exported — same "internal helper, tested
through the public function" pattern `quantize.js` uses for
`channelRange`/`splitBox`/etc.

## Menu — `js/app/main.js`

```js
defineAction('edit.filters', {
  label: 'Filters',
  submenu: [
    { action: 'edit.filters.quantizeToPalette' },
    { action: 'edit.filters.chromaKey' },
  ],
  isEnabled: () => !!activeSheet(),
});
defineAction('edit.filters.chromaKey', {
  label: 'Chroma Key…',
  run: () => openChromaKeyDialog(),
  isEnabled: () => !!activeLayer(),
});
```

No `MENUS` structure change needed — `edit.filters` already renders as a
submenu; this just adds a second entry to its existing array.

## Dialog — `index.html` + `js/app/main.js`

New static dialog, following `dlg-quantize`'s plain-markup-plus-JS-state
pattern:

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

`openChromaKeyDialog()`:
- Seeds `#ck-color` / `#ck-color-hex` from `state.primary`, `#ck-replace-color`
  / `#ck-replace-hex` from `state.secondary`.
- Resets mode to "Make transparent", tolerance to 15, softness to 10,
  "All layers" unchecked — same fixed defaults every time, no
  remembered-across-opens state (matches `dlg-quantize`'s own reset-every-open
  behavior).
- The "← Primary"/"← Secondary" buttons just re-seed their respective
  color+hex pair from `state.primary`/`state.secondary` on click.
- The `<input type="color">` and its hex `<input type="text">` are kept in
  sync both directions (color picker → hex text on `input`, hex text →
  color picker on valid 6-digit hex `input`); invalid hex text is simply
  ignored until it parses.
- `#ck-mode-replace` toggling shows/hides `#ck-replace-row` (same
  show/hide-row pattern `updateQuantizeModeUI` uses).
- Every control (`color`, `hex`, mode radios, replace color/hex, tolerance,
  softness, all-layers) is wired to recompute the live preview on `input`
  (sliders/text/color) or `change` (radios/checkbox).

OK reads the current dialog state into a plain params object and calls the
commit function (below); Cancel just closes. Both call `refreshPreviewPanel()`
on close so the panel stops showing a speculative preview.

## Region and scope

Same rule as `quantizeToPalette`: `currentEditRegion()` for the affected
rect, `allLayers ? activeLayerScope() : [activeLayer()]` for which layers
are touched — no new region logic.

## Compute/commit split — `js/app/main.js`

Both filters are split into a pure "compute patches" half and a thin
"commit" half, so the same computation can feed either the undo-stack
commit or the live preview without duplicating logic.

```js
// Shared shape returned by both compute functions:
// { region, patches: [{ layer, before, after }] } -- patches excludes any
// layer where before/after come out byte-identical (bitmapsEqual), same
// no-op guard quantizeToPalette already has today.

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
```

`quantizeToPalette` (existing function) is refactored the same way:
`computeQuantizePatches(mode, param, allLayers, preferOpaque)` extracted
from its current body (identical logic, just returning `{ region, patches }`
instead of pushing the command directly), with `quantizeToPalette` itself
reduced to `commitFloatIfAny()` + call + push-command, unchanged behavior.

## Live preview — `js/ui/previewpanel.js` changes

`render()` gains an optional override parameter:

```js
// overrideLayers: when given, flattened instead of currentContextLayers()
// -- lets a filter dialog preview a hypothetical edit without touching
// real layer data. render() itself stays the single source of truth for
// "which frame/tile rect is currently being previewed."
function render(overrideLayers = null) {
  ...
  const flat = flattenSheetLayers(overrideLayers ?? currentContextLayers(), sheet.width, sheet.height, state.floating, sheet.id);
  ...
}
```

Two new exports:

```js
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

## Shared preview-layers builder — `js/app/main.js`

```js
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

function pushLivePreview(result) {
  if (!result || !result.patches.length) { refreshPreviewPanel(); return; }
  previewWithOverride(buildPreviewLayers(result.region, result.patches));
}
```

Both dialogs' input/change handlers call
`pushLivePreview(computeChromaKeyPatches(...))` /
`pushLivePreview(computeQuantizePatches(...))` respectively, and both
dialogs call `refreshPreviewPanel()` right before `dlg*.close()` on both OK
and Cancel paths (OK's real commit already triggers `emit('pixels')`,
which fires `previewpanel.js`'s own `on('project', render)`/etc.
listeners with no override — but that emit happens synchronously inside
`commitChromaKey`/`quantizeToPalette` *before* the dialog closes each
handler, so the explicit `refreshPreviewPanel()` call is what guarantees
the panel isn't left showing a stale override in the (rare) no-op-patch
case where no `emit` happens at all).

## Testing

- `tests/chromakey.test.mjs` (new): unit tests for `chromaKeyBitmap` —
  exact key-color match with `softness: 0` goes fully transparent (mode
  `transparent`) / fully replaced (mode `replace`); a color at exactly
  `tolerance + softness` distance is unaffected; a color halfway through
  the softness band gets a mid-strength result; alpha-0 pixels are left
  byte-identical; a color outside the tolerance+softness band entirely is
  untouched.
- `tests/quantize.test.mjs`: no behavior change, existing tests keep
  passing unchanged (covers the `computeQuantizePatches` extraction
  producing identical results to before).
- `previewWithOverride`/`refreshPreviewPanel`/`buildPreviewLayers` are DOM-
  and-live-state-shaped with no meaningful pure-logic seam beyond what
  `chromaKeyBitmap`/`computeChromaKeyPatches` already cover — verified
  manually (open each dialog, drag each slider/color input, confirm the
  Preview panel updates and reverts correctly on Cancel/OK), same
  reasoning `quantize-to-palette`'s own spec gives for its dialog wiring.
