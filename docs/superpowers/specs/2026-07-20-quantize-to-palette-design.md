# Quantize to Palette

Date: 2026-07-20
Status: approved

## Goal

A new Edit menu filter that remaps colors in the current selection (or, with
no selection, the whole editable area) to the nearest color in a
user-chosen palette — a manual "flatten this art down to a fixed palette"
operation, distinct from the existing Pixel Snapper (which only runs at
import time on brand-new artwork) and from the read-only, per-project
target-platform compatibility warnings (which never touch pixels).

This is also the first of what will likely become several pixel-art
filters, so it lands under a new **Filters** submenu inside Edit rather
than as a flat top-level item.

## Out of scope

- No live/interactive preview — pick a palette, click OK, one undo step.
  (A preview canvas in the dialog is a reasonable future addition, not
  needed for a first cut.)
- No dithering options — straight nearest-RGB-distance mapping only,
  reusing `nearestColor`'s existing distance function unchanged.
- No new palette-management UI — the dialog only *reads* `project.palettes`
  and `SYSTEM_PALETTES`; it never creates, edits, or clones a palette into
  the project (picking a system palette entry quantizes to its colors
  directly, without adding it to `project.palettes`).
- No batch/whole-sheet mode — scope is selection-or-editable-area on the
  layer(s) in scope, same footprint every other pixel-editing command in
  this app already respects (see "Region" below).

## Menu — `js/app/main.js`

New submenu action, alongside `edit.projectSettings`:

```js
defineAction('edit.filters', {
  label: 'Filters',
  submenu: [
    { action: 'edit.filters.quantizeToPalette' },
  ],
  isEnabled: () => !!activeSheet(),
});
defineAction('edit.filters.quantizeToPalette', {
  label: 'Quantize to Palette…',
  run: () => openQuantizeDialog(),
  isEnabled: () => !!activeLayer(),
});
```

`MENUS`'s `Edit` entry gains `{ action: 'edit.filters' }` plus its own
trailing separator, between the existing `edit.paste` separator and
`edit.projectSettings` — i.e. `..., edit.paste, separator, edit.filters,
separator, edit.projectSettings` (mirrors `document.exportSheet`'s
existing submenu-as-menu-item pattern — no new mounting code needed,
`menubar.js` already renders `submenu` arrays).

## Dialog — `index.html` + `js/app/main.js`

New static dialog skeleton in `index.html`, following the
`dlg-renamesheet` pattern (plain markup, JS populates the dynamic `<select>`
each time it opens):

```html
<dialog id="dlg-quantize">
  <h3>Quantize to Palette</h3>
  <div class="row"><label>Palette <select id="qz-palette"></select></label></div>
  <div class="row"><label><input type="checkbox" id="qz-alllayers"> All layers</label></div>
  <div class="row dlg-actions"><button id="qz-ok" class="btn-sm">OK</button><button id="qz-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```

`openQuantizeDialog()`:
- Rebuilds `#qz-palette`'s options every open: an `<optgroup label="Project
  Palettes">` from `state.project.palettes` (skipping any with 0 colors),
  then an `<optgroup label="System Palettes">` from `SYSTEM_PALETTES`
  (always non-empty). Option values are `proj:<id>` / `sys:<name>` so both
  sources share one flat list without colliding.
- Preselects `proj:<activePaletteId>` when the project has one and it
  isn't empty; otherwise the first available option.
- `#qz-alllayers` always starts unchecked.
- OK is disabled (or a no-op) if the option list ends up empty — can only
  happen if the project has zero palettes AND `SYSTEM_PALETTES` were
  somehow empty, which never occurs in practice, but the guard costs
  nothing.

OK handler resolves the chosen option back to a plain `{ colors }` (project
palette object as-is, or the matching `SYSTEM_PALETTES` entry), then calls
`quantizeToPalette(colors, qzAllLayers.checked)` (below) and closes.

## Region

Reuses the exact selection-or-target-rect resolution `createFloat`/
`cutSelection` already use in `js/ui/floatsession.js`
(`resolveRegion(viewApi, false, null)`), so the filter is confined the same
way every other pixel operation already is: the marquee selection clamped
to whatever the active view currently limits edits to, or that whole area
when there's no selection. Concretely: the whole layer on the plain sheet
view, just the open frame/tile inside the frame/tile editor, or just the
selected segment while editing an accepted strip's frame on the sheet.

`floatsession.js` currently keeps `resolveRegion`/`activeView` private; it
gains one new export:

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

## Core — `js/core/palettes.js`

One new function next to `nearestColor` (which it reuses unchanged):

```js
// Mutates `bitmap` in place: every pixel with alpha > 0 is replaced by its
// nearest-RGB-distance match in `palette.colors` (alpha untouched, exact
// per-pixel semantics as nearestColor). Fully transparent pixels are
// skipped -- no visual effect, and skipping avoids bloating the undo diff
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

## Command — `js/app/main.js`

```js
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
```

`layers` reuses `activeLayerScope()` (already exported from `state.js`,
already used by Alt+Cut/Copy) for "all layers" — each layer in scope is
quantized independently against the SAME chosen palette, not merged, same
"process every layer separately" semantics Alt+Cut/Copy already has.

`bitmapsEqual` is a small new local helper (byte-compare two same-size
`Uint8ClampedArray`-backed bitmaps) so quantizing already-on-palette art,
or a layer with only transparent pixels in the region, doesn't push a
no-op undo step — every other patch-diffing command in this file
(`editIndexedEntry`'s remap-color count-first check, for one) already
guards the same way, just via a different mechanism (a pixel count instead
of a raw compare) because that command needed the count for its confirm
dialog text anyway; a plain compare is simpler here since there's no
confirm prompt to word.

## Testing

- `tests/palettes.test.mjs`: unit tests for `quantizeBitmapToPalette` —
  nearest match per opaque pixel, alpha preserved exactly, alpha-0 pixels
  left byte-identical, RGB of an exact palette match is unchanged.
- `tests/floating.test.mjs` (or a new small test file): `currentEditRegion`
  returns the selection clamped to target when a selection exists, and the
  whole target when it doesn't — mirrors existing `resolveRegion` coverage
  reached today only indirectly through `createFloat`/`cutSelection`
  tests, so this is a first direct test of that shared logic via its new
  export.
- The dialog and menu wiring are DOM/pointer surface with no pure-logic
  seam (same reasoning `tile-grid-drag-grow`'s spec gives for its own
  interaction code) — verified manually, not automated.
