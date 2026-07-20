# Quantize to Palette: Number-of-Colors Mode

Date: 2026-07-20
Status: approved

## Goal

Extend the existing `Edit > Filters > Quantize to Palette…` filter
([2026-07-20-quantize-to-palette-design.md](2026-07-20-quantize-to-palette-design.md))
with a second mode: instead of picking an existing project or system
palette, the user picks a target color count N, and the filter builds an
N-color palette from the region's own pixels (via median-cut) before
quantizing to it. Same region/scope/undo semantics as the existing filter
— this only changes how the target palette is obtained.

## Out of scope

- No live/interactive preview, same as the base filter.
- No algorithm choice — median-cut only, no frequency-based fallback
  toggle.
- No persistence of the generated palette into `project.palettes` — it's
  used once and discarded, same as picking a system palette today.
- No memory of last-used mode across dialog opens — always resets to
  Palette mode.

## Core — `js/core/quantize.js`

New function alongside `colorFrequency`/`buildPalette`/`quantizeBitmap`
(same file, same "reduce a bitmap to a small palette" responsibility,
different algorithm):

```js
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

Internal helpers (not exported, private to `quantize.js`):

- `rgbHistogram(bitmaps)`: counts pixels by exact `(r,g,b)` across all
  bitmaps, skipping `alpha === 0` (mirrors `colorFrequency`'s
  transparency rule, but keys on RGB only, not RGBA — alpha never
  matters for this algorithm). Returns `[{ r, g, b, count }, ...]`.
- `widestBoxIndex(boxes)`: returns the index of the box (of length ≥ 2)
  whose R, G, or B range is largest across all boxes; `-1` if every box
  has length 1 (nothing left to split — this is what lets `medianCutPalette`
  return fewer than `maxColors` entries when the source has few distinct
  colors).
- `splitBox(box)`: sorts `box` by the channel found to be widest, then
  splits at the count-weighted median (the earliest index where the
  running weight sum reaches half the box's total weight), clamped so
  neither side is empty.
- `averageColor(box)`: count-weighted average `r`/`g`/`b` across the box,
  rounded to the nearest integer.

## Dialog — `index.html`

`dlg-quantize` gains a mode toggle above the existing palette row, plus a
new count-input row:

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

In `main.js`:
- A `change` listener on both radios toggles `qz-palette-row`'s and
  `qz-count-row`'s `hidden` to match the selected mode.
- `edit.filters.quantizeToPalette`'s `run` resets `qz-mode-palette.checked
  = true` (and re-applies the row visibility) every time the dialog opens,
  same "always starts unchecked" reset `qz-alllayers` already gets.
- OK handler branches on which radio is checked:
  - Palette mode: unchanged from today — resolve the `<select>` value via
    `resolveQuantizePalette`, bail if it has no colors.
  - Count mode: read `qz-count.value`, clamp to `[1, 256]` (matches the
    input's own `min`/`max`, clamped again in JS since a user can type
    outside the HTML constraint before blur).

## Command — `js/app/main.js`

`quantizeToPalette(colors, allLayers)` becomes `quantizeToPalette(mode,
param, allLayers)`:

```js
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
```

Both modes share every line after `colors` is resolved — the diffing,
no-op guard, and single undo step are untouched from the existing
filter. In "All layers" + count mode, `befores` (one bitmap per layer in
scope) is passed as a whole to `medianCutPalette`, so the generated
palette is built once from the pooled pixels of every layer in scope, not
recomputed per layer — colors stay consistent across layers after
quantizing, same rationale `buildPalette` already applies when GIF/C99
export hands it multiple bitmaps.

`quantizeBitmapToPalette` requires `[r,g,b,a]` entries; `medianCutPalette`
returns `[r,g,b]` triples, so the count-mode branch pads a constant `255`
alpha — that value is never read (`nearestColor` only reads a palette
entry's `r/g/b` and returns the *source pixel's* alpha untouched).

New imports needed in `main.js`: `medianCutPalette` from
`../core/quantize.js` (added to the existing `buildPalette, quantizeBitmap,
colorFrequency` import).

## Testing

- `tests/quantize.test.mjs`: unit tests for `medianCutPalette` —
  - Distinct-color count ≤ maxColors returns every distinct color
    unchanged (no cutting needed).
  - A simple two-cluster bitmap (e.g. a block of near-red pixels and a
    block of near-blue pixels) reduced to 2 colors produces one palette
    entry near each cluster's average.
  - Weighting: a lopsided cluster (many near-red pixels, one blue pixel)
    reduced to 2 colors still keeps the blue outlier as its own entry
    rather than being absorbed (median-cut splits by population, not
    just spatial range, so an isolated outlier still gets its own box
    once other boxes stop being the widest).
  - Fully-transparent pixels are excluded from the histogram entirely
    (mirrors the existing `colorFrequency` transparency test).
- The dialog mode toggle and command's mode branching are DOM/pointer
  surface with no independent pure-logic seam beyond `medianCutPalette`
  itself (which is fully covered above) — verified manually, not
  automated, same convention the base filter's spec already applies.
