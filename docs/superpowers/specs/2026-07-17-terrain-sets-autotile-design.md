# Terrain sets, blob-47 autotile rules, layers & tags (Phase B)

Date: 2026-07-17
Status: approved

## Goal

Building on Phase A's grid/standalone tile placement model, add per-tile
relational metadata that an external game engine can consume:

- **Terrain sets**: named groups of same-size tiles, each tile assigned to
  one of the 47 canonical "blob" neighbor configurations, so an engine can
  look up the correct tile for any 8-neighbor bitmask (classic autotiling).
  A terrain set can be authored as a full 47-tile blob, or as just its
  16-tile core subset (the other 31 fall back automatically), and can
  further cut down the tiles that need art at all by allowing flip and/or
  rotation to stand in for symmetric variants. Built-in and user-saved
  layout presets let a matching sheet region be imported in one step
  instead of assigning all 47/16 slots by hand.
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
                   // no key means that configuration has no *explicit*
                   // tile yet (it may still resolve via fallback/symmetry,
                   // see Reduction & resolution, below)
  symmetry: { flip: false, rotate: false },  // per-set reduction toggles
}]

sheet.terrainLayoutPresets = [{
  id,              // newId('tlp')
  name,            // user-given name when saved
  cols, rows,      // shape of the source grid region this preset expects
  cells,           // [{ col, row, blobIndex }], row-major
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

Pure, dependency-free module, no DOM.

**Bit weights — verified against the reference convention** (the
cr31/"Wang blob" tileset page, the original source for the 47-tile blob
scheme, and the basis nearly every blob-47 tool since has copied):
clockwise from North, alternating edge/corner:
`N=1, NE=2, E=4, SE=8, S=16, SW=32, W=64, NW=128`.
(An earlier draft of this spec had the cardinals and diagonals grouped
into separate low/high nibbles instead — that was wrong; this is the
corrected, source-verified convention. Getting this exactly right matters
once rotation math enters the picture, below.)

**Corner tie-break rule:** a diagonal bit is treated as unset unless *both*
its adjacent cardinal bits are set (e.g. `NE` only counts if `N` and `E`
are both present) — this is what collapses the 256 raw masks down to
exactly 47 canonical configurations; it's also why no canonical tile ever
needs art for "a corner connects but one of its flanking edges doesn't."

- `buildBlobTable()` computes, once at module load: `maskToBlobIndex` (a
  256-entry array, raw mask → 0-46) and `blobIndexToMask` (a 47-entry array
  of one representative raw mask per canonical index, used to render a
  slot's tooltip/preview).

This table is fully unit-testable in isolation: 256 inputs, 47 buckets,
spot-checked against known reference cases (isolated tile, single edge,
full 8-neighbor surround, a lone diagonal with no adjacent edges reducing
to the "no diagonal" bucket).

**No spatial lookup involved.** Pixelartist has no map/canvas where tiles
sit adjacent to real neighbors — a terrain-set tile's *own* `blobIndex`
already states which of the 8 directions its terrain continues in, so the
tile-editor preview derives its 8 neighbor cells directly from that one
value, with no scan of sheet positions:

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

### 16-tile subset

The widely-used "16-tile" (a.k.a. "4-direction") autotile scheme is not a
separate table — it's the 16 blob-47 canonical indices that depend only on
the 4 cardinal bits, each with every geometrically-eligible corner also
filled in (the "smoothest" variant for that cardinal combination):

```js
// js/core/blob47.js
const CARDINALS = [1, 4, 16, 64];               // N, E, S, W
const CORNER_OF = { 1: { 4: 2 }, 4: { 16: 8 }, 16: { 64: 32 }, 64: { 1: 128 } };
// CORNER_OF[a][b] = the corner bit between adjacent cardinals a and b

export function sixteenTileBlobIndex(cardinalMask /* 0-15, only N/E/S/W bits */) {
  let full = cardinalMask;
  for (const a of CARDINALS) for (const b in CORNER_OF[a] ?? {})
    if ((cardinalMask & a) && (cardinalMask & b)) full |= CORNER_OF[a][b];
  return maskToBlobIndex[full];
}
export const SIXTEEN_TILE_INDICES = new Set(
  Array.from({ length: 16 }, (_, c) => sixteenTileBlobIndex(c)));
```

These 16 canonical indices are exactly the tiles a "16-tile" terrain needs;
the other 31 are corner-refinement variants that only matter once you also
want inner/outer corner nuance. A terrain set's 47 slots always exist —
"16-tile" isn't a different mode, it's just which 16 of the 47 you fill in
first (see Reduction & resolution, below, for how the other 31 fall back).

### Symmetry transforms

A 90°-step rotation of a tile's *artwork* is equivalent, in bitmask space,
to circularly rotating its 8 bits by 2 positions (since each bit position
is 45° apart and this bit order runs clockwise around the compass):

```js
const rotate90  = m => ((m << 2) | (m >> 6)) & 0xFF;
const rotate180 = m => ((m << 4) | (m >> 4)) & 0xFF;
const rotate270 = m => ((m << 6) | (m >> 2)) & 0xFF;
```

Mirroring the artwork swaps the bit positions that sit on either side of
the mirror axis:

```js
// flipH (mirror left-right): swap E<->W, NE<->NW, SE<->SW; N and S unchanged
const flipH = m => swapBits(m, [[4,64],[2,128],[8,32]]);
// flipV (mirror top-bottom): swap N<->S, NE<->SE, NW<->SW; E and W unchanged
const flipV = m => swapBits(m, [[1,16],[2,8],[128,32]]);
```

Each formula is independently unit-tested (apply twice → identity; apply
four rotations → identity; rotate ∘ rotate ∘ rotate ∘ rotate = identity;
etc.) before anything is built on top of them.

### Reduction & resolution

Two independent per-terrain-set toggles — `symmetry.flip` and
`symmetry.rotate` — select which transforms are allowed when looking for a
stand-in for an unassigned slot. The transforms an enabled toggle
contributes generate a small transform group:

- Neither enabled: `{ identity }` — no reduction, exactly Phase A behavior.
- `flip` only: `{ identity, flipH, flipV, flipH∘flipV }` (note
  `flipH∘flipV` is the same result as `rotate180` — enabling flip already
  buys you the 180° case for free).
- `rotate` only: `{ identity, rotate90, rotate180, rotate270 }`.
- Both: the full 8-element dihedral group (all 4 rotations, each with and
  without a mirror first).

For a given canonical index `B` with representative mask `M`, its
**equivalence class** is every other canonical index reachable by applying
a transform in the enabled group to `M`. Resolving slot `B` at export time
tries, in order:

1. **Explicit assignment** — `terrainSet.slots[B]` has a tile: use it as-is
   (identity transform).
2. **Symmetry of an explicit assignment** — some other index `B'` in `B`'s
   equivalence class has an explicit assignment: use that tile with the
   transform that carries `B'`'s art to `B`'s orientation.
3. **16-tile fallback** — `B` is not itself one of the 16 core indices;
   resolve its cardinal bucket's core representative instead (recursing
   through steps 1-2 for that representative, so a core slot filled via
   symmetry still counts).
4. **Unresolved** — no explicit tile anywhere in reach; the slot stays
   empty (this is fine and expected — partial terrain sets are allowed, per
   the earlier partial-assignment decision).

This is computed once, at export time (see Export, below) — the *engine*
never needs to know about 16-tile fallback or symmetry groups at all, it
just gets one flat, fully-resolved 47-entry table with a transform per
entry. Reduction is purely an authoring-time convenience.

## Terrain Sets UI (`js/ui/tilemode.js`)

- A "Terrain Sets" list, sibling to Phase A's grid list in the "nothing
  selected" tile-panel view: one row per terrain set (name, tile size,
  delete button), plus an "Add Terrain Set…" button opening a dialog (Name,
  Tile W, Tile H — same field shape as "Add Grid").
- Clicking a terrain set opens its slot editor in the side panel — all 47
  slots laid out in the canonical "blob" arrangement, grouped by
  neighbor-count in a staircase shape (isolated tile alone at top, then the
  4 single-edge variants, then edge+corner combinations, down to the full
  8-neighbor surround). Each of the 16 core "16-tile subset" slots carries
  a small persistent badge (e.g. a "16" chip) so it's visible at a glance
  which slots to prioritize for a minimal terrain.
- Two checkboxes above the slot grid: **"Allow flip"** and **"Allow
  rotation"** — set `terrainSet.symmetry.flip`/`.rotate`. Toggling either
  immediately re-renders every slot's resolved state (see below).
- Each slot's thumbnail reflects its *resolved* state, live, using the same
  precedence the export uses:
  - **Explicit**: plain thumbnail, no decoration.
  - **Derived via symmetry**: thumbnail rendered with the resolved
    transform applied (so it visually shows what will actually be used),
    plus a small corner icon indicating the transform (↔ flipH, ↕ flipV, a
    degree badge for a rotation).
  - **Derived via 16-tile fallback**: thumbnail from the bucket's core
    slot (itself possibly symmetry-transformed), with a dashed border.
  - **Unresolved**: empty placeholder, exactly as Phase A's partial-slot
    behavior already specified.
- Clicking a slot opens a tile picker filtered to sheet tiles matching that
  terrain set's `tileW`/`tileH` (grid-owned or standalone, either is fine);
  picking one assigns it into that slot *explicitly* (clearing the tile's
  previous slot elsewhere, per the exclusivity rule above, and taking
  precedence over whatever it was previously showing via fallback/
  symmetry). A "Clear" option removes the explicit assignment (the slot
  then re-resolves via fallback/symmetry if it still can).
- Hovering a slot shows a tooltip with its neighbor pattern in words
  (derived from `blobIndexToMask`, e.g. "N + E + NE corner") plus, for a
  derived slot, the source and transform (e.g. "Derived from slot 5 via
  horizontal flip" / "Falls back to the 16-tile smooth variant").
- **Import from layout…**: applies a layout preset against a chosen source
  region (a `tileGrid` of matching `cols`×`rows`, or a same-shaped
  selection of standalone tiles), assigning each `{col, row}` in the
  preset's `cells` to the sheet tile sitting at that position in the
  source region. Ships with two built-in presets:
  - **"Blob-47 (6×8, ascending)"** — a 6-column × 8-row grid, canonical
    indices 0-46 placed row-major in ascending order, 1 unused cell. This
    is *pixelartist's own* deterministic ordering, chosen to match the
    well-known 47-tile-in-a-6×8-grid packing size cr31's reference site
    documents — the exact cell-by-cell arrangement of any specific
    external template PNG couldn't be reliably verified from here, so
    rather than risk silently mis-mapping someone's art, this preset is
    honestly a pixelartist-defined ordering at the right grid shape, not a
    byte-for-byte copy of one specific external tool's layout.
  - **"16-tile (4×4, ascending)"** — same idea, at the 4×4 shape common to
    simple 4-direction autotile sheets.
  - **"Save current as preset…"** — once a terrain set's slots are filled
    (by hand or via a built-in preset the user then tweaked), save that
    exact `{col, row} -> blobIndex` mapping as a new named entry in
    `sheet.terrainLayoutPresets`, reusable on other terrain sets in this
    sheet. This is the practical way to match a layout the user already
    has and knows the ordering of, without pixelartist guessing at it.
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
      "slots": {               // blobIndex -> resolved reference, sparse
        "0": { "tileIndex": 3, "flipH": false, "flipV": false, "rotate": 0 },
        "5": { "tileIndex": 3, "flipH": true,  "flipV": false, "rotate": 0 }
      } }
  ],
  "layers": ["Ground", "Props"],   // omitted entirely if sheet.layers is empty
  "tiles": [
    { "index", "name": "<or null>", "x", "y", "w", "h",
      "neighbors": {...},          // omitted if this tile has a terrainSetId
      "layer": "<or omitted>", "tags": ["<...>"] /* omitted if empty */ }
  ]
}
```

Every `slots` entry — whether the tile was assigned explicitly, found via
a symmetry transform, or via 16-tile fallback — is resolved down to one
flat `{tileIndex, flipH, flipV, rotate}` record before export (see
Reduction & resolution, above); the consuming engine never needs its own
notion of 16-tile fallback or symmetry groups, it just draws `tileIndex`
with the given transform (apply `rotate` degrees clockwise, then `flipH`,
then `flipV` — that fixed order is the one pixelartist itself uses when
computing the transform, so it's the one that reproduces the intended
art). A blobIndex with no explicit tile and no resolvable fallback/
symmetry source is omitted from `slots` entirely, same as Phase A's
existing "sparse, omit unresolvable" convention. `tileIndex` resolves from
the internal `tileId` the same way Phase A's `neighbors` resolution
already works (`indexById.get(tileId) ?? null`, dropped entirely if null).

## Testing

- `tests/blob47.test.mjs` (new): all 256 raw masks reduce to exactly 47
  buckets; spot-check known reference cases (isolated, single edge, full
  surround, lone diagonal without adjacent edges); the 4 transform
  formulas (`rotate90/180/270`, `flipH`, `flipV`) each verified for
  involution/cyclic closure (e.g. 4× `rotate90` = identity, 2× `flipH` =
  identity, `flipH` composed with `flipV` = `rotate180`); `sixteenTileBlobIndex`
  produces exactly 16 distinct canonical indices across all 16 cardinal
  submasks.
- `tests/terrainsets.test.mjs` (new): create/rename/delete a terrain set;
  assign/clear a slot; assigning a tile already used elsewhere clears the
  old slot; deleting a terrain set clears every referencing tile's back-ref
  without deleting the tiles; resolution precedence (explicit beats
  symmetry beats 16-tile fallback beats unresolved) across all four
  `symmetry` toggle combinations; layout-preset import assigns the right
  tile to the right slot from a same-shaped source grid, and "save current
  as preset" round-trips back through import correctly.
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
  `terrainSets`/`layers` top-level shape (including the resolved
  `{tileIndex, flipH, flipV, rotate}` slot shape for explicit, symmetry-
  derived, and 16-tile-fallback-derived entries), per-tile `layer`/`tags`,
  and `neighbors` omission once a tile has a `terrainSetId`.
- `tests/smoke.md`: new manual-verification items for the Terrain Sets
  list, Add Terrain Set dialog, slot assignment/clear, the flip/rotation
  checkboxes visibly changing derived-slot thumbnails, layout-preset
  import, "save as preset," the Layers list, and the tile detail panel's
  Layer/Tags fields — tagged `[A]`/`[M]` per the existing convention (no
  drag-simulation items).
