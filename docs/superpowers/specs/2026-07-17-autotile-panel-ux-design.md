# Autotile Panel UX Design

Follow-up to `2026-07-17-terrain-sets-autotile-design.md` (Phase B). That
spec built the terrain-set/blob-47 data model and a first-pass UI bolted
into the existing Tiles panel. This round reworks the UI layer only — no
new data-model concepts beyond one new field (`terrainSet.layer`) — driven
by usability gaps found after using Phase B's UI: everything lived in one
flat panel, slots were unlabeled colored boxes, and the "layer" naming
collided with the app's real (pixel-compositing) Layers panel.

## Goal

- Split tile work into two real sidebar panels: **Tiles** (grids +
  standalone tiles) and **Autotiles** (terrain sets, blob-47 slot
  assignment, Tile Layers manager).
- Make the blob-47 editor and its tile-assign dialog self-explanatory
  without hovering: live thumbnails, an explicit mandatory/optional
  classification driven by the terrain set's symmetry settings, and a
  slot-description diagram in the assign dialog.
- Add a 7×7 built-in layout preset and an independent "view mode" for how
  the editor arranges its 47 slots (Staircase / 6×8 / 7×7 / 16-tile-only).
- Disambiguate "Tile Layers" (props/terrain/walls categorization, added in
  Phase B as `sheet.layers`) from the app's actual Layers panel
  (`js/ui/panels.js` `mountLayersPanel`, pixel-compositing layer tree) —
  same underlying data, clearer naming and fully separate CSS/DOM.
- Icons-over-text for panel action buttons, matching the existing
  emoji+`title`-tooltip convention already used in `panels.js`'s Layers
  panel (`➕`/`📁`/`🗑`/`⬇`) and `timeline.js` (`⏮`/`▶`/`⏭`/`✕`).

**Explicitly out of scope for this round:**
- The example autotile tilesheet + slot-index assignments will be
  supplied by the user directly (image + mapping), not generated. Nothing
  to build speculatively here; when provided, it gets imported via the
  existing "Import from layout" flow if its grid shape matches a built-in
  or saved preset, otherwise a one-off assignment pass.
- The tile-editor's logical-vs-selectable neighbor preview is **already
  correct** as of Phase B (`js/ui/tileeditor.js:206` picks
  `terrainPreviewCells(t)` for terrain-set members vs
  `resolveNeighborGrid(...)` for standalone tiles; `openSlotDialog` at
  `:268` is already a no-op for terrain-set members). No change needed;
  called out here only so it isn't accidentally regressed.

## Panel restructuring

Today `mountTilePanel(el)` renders everything (grid list, terrain sets,
tile-layer names, tile detail) into the single `#panel-context` div shared
with `frames.js`'s `mountFramesPanel` (mode-gated: `wrap.hidden = state.mode
!== 'tiles'`).

New structure:
- `index.html` gains a sibling panel: `<div id="panel-autotiles"
  class="panel"></div>`, alongside `#panel-colors` / `#panel-layers` /
  `#panel-context`.
- `js/ui/tilemode.js` exports a new `mountAutotilesPanel(el)` in addition
  to the existing `mountTilePanel(el)`. Both are wired in `main.js`:
  ```js
  mountTilePanel(document.getElementById('panel-context'));
  mountAutotilesPanel(document.getElementById('panel-autotiles'));
  ```
- `mountTilePanel` keeps: grid list, Add Grid, and the tile-detail block
  (name/size/layer-select/tags) for whichever tile is selected — this
  applies to a terrain-set member tile too, since those still have their
  own name/tags independent of their slot.
- `mountAutotilesPanel` gets: terrain-set list, Add Terrain Set, the
  terrain-set editor (view-mode switch, symmetry checkboxes, layer
  select, layout-preset row, slot grid), and the Tile Layers manager
  (shared by both panels' `layer` dropdowns, so it lives here since
  terrain sets are the more complex consumer, but the tile-detail layer
  `<select>` in `mountTilePanel` reads the same `sheet.layers` array).
- Visibility: `mountAutotilesPanel`'s own `wrap.hidden = state.mode !==
  'tiles'` (mirrors the existing pattern at `tilemode.js:1158`). Within
  tile mode, the panel always shows at least the Add Terrain Set button —
  there is no fully-empty state, so no separate disclaimer element is
  needed once in tile mode. Outside tile mode it's hidden entirely, same
  as `#panel-context`'s tile wrap.

## Terrain-set editor: view modes + 7×7 preset

Two independent things, easy to conflate:
- **Layout presets** (`BUILTIN_LAYOUT_PRESETS` / `sheet.terrainLayoutPresets`,
  used by "Import from layout…" / "Save current as preset…") describe how
  blob indices map onto a **physical sheet grid** the user drew tiles into.
- **View mode** is purely how the editor's own clickable 47-slot grid is
  *arranged on screen* — it never touches `terrainSet.slots` and has no
  saved/imported state.

Add a view-mode `<select>` above the slot grid in `renderTerrainSetEditor`
with options `Staircase` (default) / `Grid 6×8` / `Grid 7×7` / `16-tile
only`, held in a local (non-persisted) variable. Rendering per mode:
- **Staircase**: existing `blobStaircaseGroups()` (groups by neighbor
  count) — unchanged.
- **Grid 6×8**: all 47 indices in ascending order, chunked into rows of 6.
- **Grid 7×7**: all 47 indices in ascending order, chunked into rows of 7
  (last row has 5, not 7 — 47 = 6×7 + 5).
- **16-tile only**: a single row containing just `[...SIXTEEN_TILE_INDICES]`
  sorted ascending — the other 31 slots aren't rendered while this mode is
  selected (their data is untouched, just hidden from view).

New built-in layout preset (for the *import* flow, independent of the
above), added to `BUILTIN_LAYOUT_PRESETS` in `tilemode.js`:
```js
{
  name: 'Blob-47 (7×7, ascending)', cols: 7, rows: 7,
  cells: Array.from({ length: 47 }, (_, i) => ({ col: i % 7, row: Math.floor(i / 7), blobIndex: i })),
}
```
(49 grid cells, last 2 of the final row unused — same "ascending index,
not a claimed external match" convention as the existing 6×8/4×4 presets.)

## Mandatory vs optional slot classification

Replaces the current `.core` (static: "is this one of the 16-tile
indices") / `.derived` (dynamic: "did this slot resolve via fallback right
now") pair with a single classification computed from the terrain set's
*current symmetry settings alone* — independent of what's currently
assigned, so the user sees up front how many tiles they actually need to
draw.

`js/core/blob47.js` changes:
- Export the two already-implemented-but-private helpers `enabledGroup`
  and `applyDescriptor` (no behavior change, just visibility — both are
  already exercised indirectly via `resolveTerrainSlot`'s existing tests).
- Add:
  ```js
  // For each of the 47 blob indices, compute its orbit under the
  // terrain set's ENABLED symmetry transforms (flip/rotate) and pick one
  // representative per orbit -- preferring a 16-tile-subset member when
  // the orbit contains one, else the lowest blobIndex. The representative
  // is "mandatory" (draw a real tile for it); every other orbit member is
  // "optional" (comes free via resolveTerrainSlot's symmetry fallback
  // once the representative is assigned). With symmetry fully off, every
  // orbit is a singleton, so all 47 are mandatory.
  export function classifySlots(symmetry) {
    const group = enabledGroup(symmetry);
    const classification = new Map();
    const visited = new Set();
    for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
      if (visited.has(blobIndex)) continue;
      const mask = blobIndexToMask[blobIndex];
      const orbit = new Set(group.map(t => maskToBlobIndex[applyDescriptor(mask, t)]));
      const sorted = [...orbit].sort((a, b) => a - b);
      const representative = sorted.find(i => SIXTEEN_TILE_INDICES.has(i)) ?? sorted[0];
      for (const idx of orbit) {
        visited.add(idx);
        classification.set(idx, { mandatory: idx === representative, orbitRepresentative: representative });
      }
    }
    return classification;
  }
  ```
- `tilemode.js`'s `renderTerrainSetEditor` calls `classifySlots(terrainSet.symmetry)`
  once per render and applies `.mandatory` / `.optional` (renamed from
  `.core` / `.derived`) to each slot cell accordingly, regardless of
  current fill state. Whether a slot is *currently* resolved (has a
  thumbnail at all) remains a separate, independent visual (see below).

CSS (`app.css`): rename `.terrain-slot.core` → `.terrain-slot.mandatory`
(same solid-blue-border treatment) and `.terrain-slot.derived` →
`.terrain-slot.optional` (same dashed treatment).

## Live thumbnails + flip/rotate icons

Both the terrain-set editor's slot grid and the redesigned tile-picker
dialog (below) show actual cropped tile pixels instead of blank boxes.

`tilemode.js` adds a small private flat-canvas cache, following the exact
pattern already duplicated across `tileeditor.js`/`frameeditor.js` (this
codebase's established convention over a shared abstraction — see
`tileeditor.js:166`'s `getFlatCanvas`):
```js
function getFlatCanvas(sheet) { /* same shape as tileeditor.js's, using
  flattenSheet from core/model.js; cached per sheet reference + dirty flag */ }

function tileThumbnailURL(sheet, tile, { flipH = false, flipV = false, rotate = 0 } = {}) {
  // draws tile.w x tile.h source rect from getFlatCanvas(sheet) into a
  // scratch canvas, applying the same translate/scale transform shape as
  // tileeditor.js's drawTileCell for flips, plus a rotate(deg) step;
  // returns canvas.toDataURL(). Cached by `${tile.id}|${flipH}|${flipV}|${rotate}`.
}
```
Each slot cell's `style.backgroundImage` is set to this data URL when
`resolveTerrainSlot` returns a hit; left blank (current placeholder look)
when it returns `null`.

Flip/rotate indication: replace the current text `badge` (`'F'` /
`'90°'`) with a small icon overlay — `↔` for `flipH`, `↕` for `flipV`,
`↻` for any non-zero `rotate` (shown together if more than one applies,
space-separated) — only drawn when the slot's resolution came from a
symmetry-derived transform (`resolved && !isExplicit`, same guard as
today). This matches the icons-over-text preference and reads clearer
than a bare letter/degree string.

## Tile-picker dialog redesign

Current `buildTilePickerDialog` is a `<dialog>` with a plain `<select>` of
tile names/indices — no visual, no context about what's being assigned.

Redesign:
- **Header** (new, always visible without hovering): the slot's
  `describeMask(mask)` text, its mandatory/optional badge (from
  `classifySlots`), and a small static 3×3 diagram built from plain CSS
  grid + divs (reusing `DIRECTION_OFFSETS` from `blob47.js` the same way
  `terrainPreviewCells` does) — center cell always "filled", each of the 8
  surrounding cells shaded in/out per whether the slot's mask bit is set.
  This single diagram answers "what should be drawn in this tile" without
  needing per-thumbnail overlays or hover.
- **Body**: replaces the `<select>` with a `.tile-picker-grid` of clickable
  thumbnail cells (using `tileThumbnailURL`, no transform — these are the
  actual candidate tiles, shown as-is), each labeled with its index/name
  underneath (small text, not hidden behind hover). Clicking a cell picks
  it immediately (no separate OK button needed for selection; Clear/Cancel
  remain as explicit buttons).
- Tiles with fully transparent/empty pixels still render their thumbnail
  (which will look blank) — the header diagram is what conveys intent in
  that case, not the thumbnail itself.

## Tile Layers manager: disambiguation

No new data model — `sheet.layers` (ordered string array) and
`tile.layer` already exist from Phase B. Changes are naming + one new
field:
- UI copy: section header "Layers" → "Tile Layers"; button "Add Layer
  Name…" → icon-only `➕` with `title="Add tile layer"`. Up/down/delete
  stay `↑`/`↓`/`🗑` (already icons from Phase B, just adding `title`
  tooltips: "Move up" / "Move down" / "Delete").
- CSS: the tile-layer-names list currently reuses the shared `.layer-list`
  class (`tilemode.js:1134`), which the *real* Layers panel
  (`panels.js:361`, `.layer-list.layer-tree`) also uses. Rename to a new
  `.tile-layer-list` class with its own rule in `app.css` (same
  `display:flex;flex-direction:column;gap:2px;margin-bottom:6px` as the
  current shared rule) so the two are fully decoupled — no shared class,
  even though the visual result stays the same today.
- New field: `terrainSet.layer` (string name from `sheet.layers`, or
  `null`). Added in `createTerrainSet` (`js/core/terrainsets.js`) as
  `layer: null`. A `<select>` next to the symmetry checkboxes in
  `renderTerrainSetEditor`, populated from `sheet.layers` plus a blank/none
  option, wired through a new `commitSetTerrainSetLayer(terrainSet, layer)`
  command wrapper (mirrors `commitTileLayer`).
  **Design call:** this is independent metadata on the *set* (e.g. "this
  whole terrain set is 'walls'") — it does not bulk-overwrite each member
  tile's own `.layer` field. A member tile's `.layer` stays whatever it
  was (usually unset, since terrain-set membership already implies
  meaning via the set itself).

## Icons over text: full inventory

Following the existing convention (emoji glyph as `textContent`, `title`
attribute for the tooltip), applied to every button touched by this round:

| Location | Before | After |
|---|---|---|
| Tiles panel: Add Grid | `"Add Grid…"` | `➕` title "Add grid" |
| Autotiles panel: Add Terrain Set | `"Add Terrain Set…"` | `➕` title "Add terrain set" |
| Terrain-set row: Delete | `"Delete"` | `🗑` title "Delete terrain set" |
| Layout preset row: Import | `"Import from layout…"` | `⬇` title "Import from layout" |
| Layout preset row: Save | `"Save current as preset…"` | `💾` title "Save current as preset" |
| Tile Layers: Add | `"Add Layer Name…"` | `➕` title "Add tile layer" |
| Tile Layers: Up/Down/Delete | `↑`/`↓`/(none) | unchanged glyphs + added `title`s, delete gets `🗑` |

Checkboxes (Allow flip / Allow rotation) and the view-mode/layer `<select>`
elements are left with their text labels — the ask was about buttons, and
these aren't buttons.

## Export shape update

`js/app/exports.js`'s `buildTilesJson`: each `terrainSets[]` entry gains
`layer` (omitted if `null`), sourced from the new `terrainSet.layer` field:
```js
return { name: ts.name, tileW: ts.tileW, tileH: ts.tileH, slots,
  ...(ts.layer != null ? { layer: ts.layer } : {}) };
```

## Testing plan

- `tests/blob47.test.mjs`: new tests for `classifySlots` — symmetry off
  (all 47 mandatory, singleton orbits), flip-only, rotate-only, and both
  enabled (orbit sizes and representative selection, including a case
  where the representative must prefer a 16-tile-subset member over a
  lower raw index that isn't in the subset).
- `tests/terrainsets.test.mjs`: `createTerrainSet` includes `layer: null`;
  a new `commitSetTerrainSetLayer`-equivalent core-level test if the
  mutation is exposed as a core helper rather than inline in `tilemode.js`.
- `tests/exports.test.mjs`: `terrainSets[].layer` present when set, omitted
  when `null`.
- No new tests for DOM-only changes (panel split, thumbnail rendering,
  picker dialog markup, icon glyphs) — consistent with this codebase's
  existing pattern of not unit-testing `tilemode.js`'s DOM construction;
  covered instead by the smoke-test checklist and manual verification.
- `tests/smoke.md`: add items for the two-panel split, 7×7 preset, view
  mode switch, mandatory/optional visual distinction, live thumbnails, and
  the redesigned picker dialog's header diagram.
