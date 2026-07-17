# Terrain sets, blob-47 autotile rules, layers & tags (Phase B)

Date: 2026-07-17
Status: approved

## Goal

Building on Phase A's grid/standalone tile placement model, add per-tile
relational metadata that an external game engine can consume:

- **Terrain sets**: named groups of same-size tiles, each tile assigned to
  one of the 47 canonical "blob" neighbor configurations, so an engine can
  look up the correct tile for any 8-neighbor bitmask (classic autotiling).
- **Layers**: an ordered, named list per sheet (e.g. "Ground", "Props",
  "Collision"); each tile picks at most one, telling the engine what to draw
  it as / in what order.
- **Tags**: free-form, unordered strings per tile, for browsing/searching in
  the editor only — no export-side ordering or engine meaning implied beyond
  "these are labels on this tile."

This is metadata authoring only. Pixelartist has no map/level-painting
canvas anywhere in the app (confirmed: no map/tilemap concept exists in the
codebase) and this spec does not add one — the payoff is entirely in what
gets exported to `tiles.json` for the consuming engine to use.

Terrain-set membership **replaces** the manual 8-direction neighbor preset
(`js/core/neighbors.js`) for member tiles only: a tile with a terrain-set
assignment gets its neighbor preview auto-computed from the terrain set's
own slot assignments via the blob-47 table, instead of the user hand-wiring
each of the 8 directions. Tiles that don't belong to any terrain set keep
today's manual neighbor editor completely unchanged.

## Data model

Three additions to the sheet shape, following the same conventions Phase A
established (flat arrays, id-based, mutated in place):

```js
sheet.terrainSets = [{
  id,              // newId('ts')
  name,            // string, user-editable
  tileW, tileH,    // fixed at creation; only tiles this exact size may be
                   // assigned into a slot
  slots,           // { [blobIndex: 0-46]: tileId }, sparse — an index with
                   // no key means that configuration has no tile yet
}]

sheet.layers = ["Ground", "Props", ...]   // ordered string array, sheet-level

sheet.tiles = [{
  // ...unchanged Phase A fields (id, x, y, w, h, name, gridId, gridCol,
  // gridRow, neighbors)...
  terrainSetId,    // owning terrain set's id, or undefined
  blobIndex,       // 0-46, only meaningful when terrainSetId is set
  layer,           // a string present in sheet.layers, or undefined
  tags,            // string[] | undefined
}]
```

**Exclusivity:** a tile can occupy at most one terrain-set slot at a time,
across *all* terrain sets on the sheet — assigning a tile into a new slot
clears its previous `terrainSetId`/`blobIndex` (its own, or another set's),
mirroring how a Phase A tile can't belong to two grids simultaneously.

**Size mismatch:** if a standalone tile that holds a terrain-set slot is
later resized (W/H fields in the tile detail panel) to no longer match its
terrain set's `tileW`/`tileH`, the resize commit also clears that tile's
`terrainSetId`/`blobIndex` (auto-detach), the same way Phase A already
recomputes derived state as a side effect of a single commit.

**`sheet.layers` is independent of usage** — it's a managed list (add /
rename / delete / reorder) that can contain names no tile currently uses,
exactly like `sheet.terrainSets` can have empty slots.

## Blob-47 bitmask algorithm (`js/core/blob47.js`, new file)

Pure, dependency-free module, no DOM:

- Bit weights for the 8 neighbor directions: `N=1, E=2, S=4, W=8` (cardinal),
  `NE=16, SE=32, SW=64, NW=128` (diagonal).
- **Corner tie-break rule:** a diagonal bit is treated as unset unless *both*
  its adjacent cardinal bits are set (e.g. `NE` only counts if `N` and `E`
  are both present). This collapses the 256 raw masks down to exactly 47
  canonical configurations.
- `buildBlobTable()` computes, once at module load: `maskToBlobIndex` (a
  256-entry array, raw mask → 0-46) and `blobIndexToMask` (a 47-entry array
  of one representative raw mask per canonical index, used to render a
  slot's tooltip/preview).

This table is the only genuinely algorithmic part of Phase B and is fully
unit-testable in isolation: 256 inputs, 47 buckets, spot-checked against
known reference cases (isolated tile, single edge, full 8-neighbor
surround, a lone diagonal with no adjacent edges reducing to the "no
diagonal" bucket).

**No spatial lookup involved.** Pixelartist has no map/canvas where tiles
sit adjacent to real neighbors — a terrain-set tile's *own* `blobIndex`
already states which of the 8 directions its terrain continues in, so the
tile-editor preview (below) derives its 8 neighbor cells directly from that
one value, with no scan of sheet positions:

```js
// js/core/blob47.js
export function terrainPreviewCells(tile) {
  const mask = blobIndexToMask[tile.blobIndex];
  const cells = [];
  for (const { dx, dy, bit } of DIRECTION_OFFSETS) {
    // bit set in this tile's own mask => terrain continues that way =>
    // preview with the tile itself; bit unset => boundary => empty cell.
    cells.push({ dx, dy, tileId: (mask & bit) ? tile.id : null,
                 flipH: false, flipV: false });
  }
  return cells;
}
```

This returns the same `{dx, dy, tileId, flipH, flipV}` cell shape Phase A's
`resolveNeighborGrid` already produces, so `tileeditor.js` can consume
either interchangeably (see Tile editor integration, below).

## Terrain Sets UI (`js/ui/tilemode.js`)

- A "Terrain Sets" list, sibling to Phase A's grid list in the "nothing
  selected" tile-panel view: one row per terrain set (name, tile size,
  delete button), plus an "Add Terrain Set…" button opening a dialog (Name,
  Tile W, Tile H — same field shape as "Add Grid").
- Clicking a terrain set opens its slot editor: all 47 slots laid out in
  the canonical "blob" arrangement — grouped by neighbor-count in a
  staircase shape (isolated tile alone at top, then the 4 single-edge
  variants, then edge+corner combinations, down to the full 8-neighbor
  surround) — each slot showing its assigned tile's thumbnail, or an empty
  placeholder if unassigned.
- Clicking a slot opens a tile picker filtered to sheet tiles matching that
  terrain set's `tileW`/`tileH` (grid-owned or standalone, either is fine);
  picking one assigns it into that slot (clearing the tile's previous slot
  elsewhere, per the exclusivity rule above). A "Clear" option empties the
  slot without assigning a replacement.
- Hovering a slot shows a tooltip describing its neighbor pattern in words
  (derived from `blobIndexToMask`, e.g. "N + E + NE corner").
- Rename / Delete a terrain set: Delete clears the `terrainSetId`/
  `blobIndex` back-reference on every tile that referenced it (tiles
  themselves are not deleted — same "metadata goes away, pixels don't"
  convention as deleting a grid).

## Tile detail panel additions

Independent of grid/standalone/terrain-set status, the tile detail panel
(shown when a tile is selected) gains:

- **Layer**: a dropdown populated from `sheet.layers`, plus a "(none)"
  option. Committing a change sets `tile.layer`.
- **Tags**: a text input taking a comma-separated list, committing to
  `tile.tags` (trimmed, empty strings dropped, `undefined` if the result is
  empty rather than storing `[]`).

A separate "Layers" management list (add / rename / delete, plus up/down
buttons per row to reorder — a flat string list has no need for the
existing drawing-layers panel's tree/drag machinery) lives alongside the
Terrain Sets list in the "nothing selected" tile-panel view.

## Tile editor integration (`js/ui/tileeditor.js`)

- Tile has `terrainSetId` set: the neighbor-preview grid is auto-computed via
  `terrainPreviewCells(tile)` instead of `resolveNeighborGrid(getPreset(tile),
  ...)`; the manual slot-editing dialog (click a neighbor cell to configure
  it) is not shown for this tile — a label reads "Terrain: `<set name>` —
  neighbors follow the terrain set automatically."
- Tile has no `terrainSetId`: completely unchanged from Phase A — full
  manual per-direction slot editor, `tile.neighbors` read/written exactly as
  today.
- Joining a terrain set never touches `tile.neighbors` — only `terrainSetId`/
  `blobIndex` are set. If the tile later leaves the terrain set (reassigned
  to a different slot, or auto-detached by a size mismatch), whatever
  `tile.neighbors` it had before reappears unchanged — no special
  save/restore logic needed, it was simply never overwritten.

## Data integrity: reference cleanup on tile removal

Phase A's final review flagged (and deferred to Phase B) a gap: deleting a
tile or shrinking a grid can leave other tiles' `neighbors` slots pointing
at a `tileId` that no longer exists (degrades gracefully today — export
resolves it to `tileIndex: null` — but nothing scrubs it). Terrain-set slots
introduce the identical risk. Since this Phase B work already touches the
same removal code paths, both are fixed together with one shared helper:

```js
// js/core/model.js (or co-located with existing tile-removal logic)
function scrubTileReferences(sheet, removedTileId) {
  for (const tile of sheet.tiles) {
    for (const dir of NEIGHBOR_DIRS) {
      const slot = tile.neighbors?.[dir];
      if (slot?.mode === 'tile' && slot.tileId === removedTileId) {
        tile.neighbors[dir] = { ...slot, mode: 'empty', tileId: null };
      }
    }
  }
  for (const ts of sheet.terrainSets ?? []) {
    for (const idx of Object.keys(ts.slots)) {
      if (ts.slots[idx] === removedTileId) delete ts.slots[idx];
    }
  }
}
```

Called from every place a tile record is actually removed from
`sheet.tiles`: `deleteTile` (tilemode.js), and grid shrink in
`resizeGridCols`/`resizeGridRows` (tilegrids.js) for each trailing tile it
drops. Terrain-set Delete does not call this — it only clears the deleted
set's own back-references (tiles survive, per the convention above), it
doesn't remove tile records.

## Export (`js/app/exports.js` `buildTilesJson`)

```js
{
  "sheet": "<name>.png", "count": n,
  "terrainSets": [           // omitted entirely if sheet.terrainSets is empty
    { "name": "Grass", "tileW": 16, "tileH": 16,
      "slots": { "0": 3, "5": 7 } }   // blobIndex -> tileIndex, sparse
  ],
  "layers": ["Ground", "Props"],   // omitted entirely if sheet.layers is empty
  "tiles": [
    { "index", "name": "<or null>", "x", "y", "w", "h",
      "neighbors": {...},          // omitted if this tile has a terrainSetId
      "layer": "<or omitted>", "tags": ["<...>"] /* omitted if empty */ }
  ]
}
```

`terrainSets[].slots` values and any `tileId` references resolve to
export-time `tileIndex` the same way Phase A's `neighbors` resolution
already works (`indexById.get(tileId) ?? null`, dropped entirely if null
here since slots are sparse by design).

## Testing

- `tests/blob47.test.mjs` (new): all 256 raw masks reduce to exactly 47
  buckets; spot-check known reference cases (isolated, single edge, full
  surround, lone diagonal without adjacent edges).
- `tests/terrainsets.test.mjs` (new): create/rename/delete a terrain set;
  assign/clear a slot; assigning a tile already used elsewhere clears the
  old slot; deleting a terrain set clears every referencing tile's back-ref
  without deleting the tiles.
- `tests/model.test.mjs`: extend for `scrubTileReferences` — deleting a
  tile clears both dangling `neighbors` slots and dangling terrain-set slot
  entries elsewhere on the sheet.
- `tests/tilegrids.test.mjs`: extend `resizeGridCols`/`resizeGridRows`
  shrink cases to assert dropped tiles' ids are scrubbed from other tiles'
  `neighbors` and from any terrain set's `slots`.
- Tile editor: unit coverage that a terrain-set tile's preview resolves via
  `terrainPreviewCells` (not `tile.neighbors`), and that a non-terrain tile
  is completely unaffected (regression on existing neighbor-editor tests).
- `tests/exports.test.mjs`: extend `buildTilesJson` coverage for
  `terrainSets`/`layers` top-level shape, per-tile `layer`/`tags`, and
  `neighbors` omission once a tile has a `terrainSetId`.
- `tests/smoke.md`: new manual-verification items for the Terrain Sets
  list, Add Terrain Set dialog, slot assignment/clear, the Layers list, and
  the tile detail panel's Layer/Tags fields — tagged `[A]`/`[M]` per the
  existing convention (no drag-simulation items).
