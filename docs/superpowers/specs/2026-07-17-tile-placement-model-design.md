# Tile placement model — grids + standalone tiles (Phase A)

Date: 2026-07-17
Status: approved

## Goal

Replace the current "one uniform grid always covers the whole tile sheet"
model with explicit, per-sheet tile placement:

- One or more **persistent grid** regions (origin, cell size, cols/rows,
  spacing), each owning a rectangular block of tiles that stay in sync with
  the grid's geometry.
- **Standalone tiles**: individually placed/resized rects, exactly like sprite
  frames, coexisting freely with grids on the same sheet.
- A tile can be **detached** from its grid to become a standalone tile.
- Same-size tiles (grid or standalone, any combination) can be swapped by
  dragging one onto another, carrying pixels + name + neighbor preset.

This is Phase A only: it replaces the tile *placement* model. Per-tile
relational metadata beyond the existing 8-direction neighbor preset — terrain
sets, blob-47 auto-tile rules, z-layers — is Phase B, a separate spec that
builds on this one.

Out of scope for this spec: anything about terrain sets, bitmask rules, or
z-layers (Phase B).

## Data model

Replace `sheet.tile = { tileWidth, tileHeight, names, neighbors }` with two
arrays, following the same shape convention `sheet.frames` already uses
(flat array, id-based, mutated in place, snapshotted for undo):

```js
sheet.tileGrids = [{
  id,            // newId('tg')
  x, y,          // origin, sheet-global pixels
  cellW, cellH,
  cols, rows,
  spacingX, spacingY,
}]

sheet.tiles = [{
  id,            // newId('ti')
  x, y, w, h,    // sheet-global rect; for grid-owned tiles this is DERIVED
                 // from the owning grid + gridCol/gridRow, kept in sync
                 // whenever the grid changes
  name,          // string | undefined — same convention as frame.name
  gridId,        // owning grid's id, or null for a standalone tile
  gridCol, gridRow, // only meaningful when gridId is set; identity key used
                     // to preserve name/neighbors across a grid resize
  neighbors,     // the existing 8-dir preset shape from core/neighbors.js,
                 // now stored directly on the tile instead of in a
                 // sheet.tile.neighbors[index] side-map
}]
```

`sheet.tile` (singular) is removed entirely. `tileCount(sheet)` /
`tileRect(sheet, index)` (js/core/model.js) are removed — call sites read
`sheet.tiles` directly (`.length`, array element by index or `.find(t => t.id
=== id)`), the same way frame code reads `sheet.frames`.

### Grid cell geometry

Cell `(col, row)` of grid `g`:

```js
x: g.x + col * (g.cellW + g.spacingX)
y: g.y + row * (g.cellH + g.spacingY)
w: g.cellW, h: g.cellH
```

No margin field on the grid object — margin is just baked into the initial
`x, y` the user picks when placing the grid.

### Tile identity

`state.selectedTileIndex` / `state.editingTileIndex` become
`state.selectedTileId` / `state.editingTileId`, matching how frames use
`state.selectedFrameId` / `state.editingFrameId`. Every place that currently
computes or receives a tile *index* (tilemode.js's `tileIndexAt`,
tileeditor.js's `currentTileIndex`, exports.js's loop) switches to looking up
tiles by id or iterating `sheet.tiles` directly.

## Grid mechanics

**Create.** "Add Grid" button opens a dialog (cellW, cellH, cols, rows,
spacingX, spacingY — mirrors the sprite Slice Grid dialog's fields and live
dashed preview, built from the same math). Origin defaults to `(0, 0)`;
reposition afterward by dragging the grid (see Move, below). On confirm, one
grid object is pushed to `sheet.tileGrids` and `cols * rows` tile records are
pushed to `sheet.tiles`, each with `gridCol`/`gridRow` set and `name`/
`neighbors` absent. One undoable command, same shape as `commitCreate` in
frames.js.

**Resize (cols/rows).** `cols` and `rows` are separate numeric fields, each
committed independently on its own `change` event (like every other numeric
field in this codebase's panels) — so a resize command only ever changes one
dimension at a time, keeping the add/remove math one-dimensional: adds or
removes a full trailing row (all `cols` cells at `row = rows-1`) or trailing
column (all `rows` cells at `col = cols-1`), the same "delta > 0 append, delta
< 0 remove" shape as `commitResizeSegment` in frames.js. Pixels are never
touched (tiles are viewports, same as frames); shrinking just drops the
trailing tile records (and whatever `name`/`neighbors` they held). Growing
appends blank tile records at the new `(col, row)` slots.

**Resize (cellW/cellH/spacing).** Editing cell size or spacing recomputes
every owned tile's `x/y/w/h` from the grid origin + that tile's `gridCol`/
`gridRow` — the same "shared frame size" re-layout `setStripFrameSize` does
for a strip. Because identity is keyed by `(gridId, gridCol, gridRow)`, not
recreated, each tile's `name`/`neighbors` survive the resize.

**Move.** Dragging a grid's own handle (a small header/handle rendered at the
grid's origin corner, distinct from dragging an individual owned tile —
dragging a tile is reserved for swap, see below) translates the grid's `x, y`
and shifts every owned tile's cached rect by the same delta. Metadata-only,
one undoable command covering the grid + all its owned tiles' coordinates —
the grid-level equivalent of frames.js dragging a whole intact strip.

**Delete grid.** Removes the grid object and every tile record with that
`gridId` (same trade-off as deleting a frame: pixels stay on the sheet, only
the tile metadata goes away). One undoable command.

**Detach.** A "Detach from grid" button on a grid-owned tile's detail panel
clears that tile's `gridId`/`gridCol`/`gridRow`. It's now a fully standalone
tile: individually movable/resizable/deletable, and no longer touched by that
grid's resize/regenerate logic. The vacated slot is simply not revisited by
future grid resizes (resizes only ever add/remove at the trailing edge) — if
the grid is later resized in a way that would geometrically overlap the
detached tile's rect, that's an accepted overlap, same as any two standalone
frames/tiles can already overlap today.

## Tile-tool interactions (js/ui/tilemode.js)

Mirrors frames.js's tool split (create / move / resize handles / delete),
plus the swap behavior the current implicit-grid tile tool already has:

- **Create**: drag on empty canvas space with the tile tool active → new
  standalone tile (frame-style create-drag, same rect math as
  `commitCreate`/`rectBetween` in frames.js).
- **Drag tile A onto tile B, same `w`×`h`** (any combination of grid-owned /
  standalone on either side) → pixel-content swap: pixels, `name`, and
  `neighbors` swap between A and B, exactly like today's `commitSwapTile`.
  Shift-drag keeps today's "move" variant (`commitMoveTile`: A's pixels
  overwrite B, A clears, A's metadata moves to B) for same-size pairs.
- **Drag a standalone tile onto empty space, or onto a different-size
  tile** → plain reposition (frame-style metadata-only move by drag delta,
  clamped on-sheet).
- **Drag a grid-owned tile onto empty space or a different-size tile** →
  no-op, snaps back. An individual grid cell can't "just move" without
  breaking the grid's regularity; repositioning it requires either dragging
  the whole grid (Move, above) or detaching it first.
- **Resize handles** appear only on standalone (or detached) tiles, never on
  in-grid tiles — same restriction frames.js already applies to intact strip
  members.
- **Delete** (Delete key / panel button) removes a standalone tile's record
  outright; for a grid-owned tile it's not offered directly (delete the
  owning grid, shrink it, or detach then delete).
- Double-click a tile (grid-owned or standalone) still opens the tile editor,
  same as today.

## Tile panel (js/ui/tilemode.js `mountTilePanel`)

Restructured to mirror the frames panel's "nothing selected vs. detail" split:

- **Nothing selected**: one row per grid (cols / rows / cellW / cellH fields,
  a delete-grid button), an "Add Grid" button opening the create dialog, and
  a total tile count across all grids + standalone tiles.
- **A tile selected**: name field, "Edit tile" button (opens the existing
  tile editor unchanged). Grid-owned tiles additionally show a "Detach from
  grid" button; standalone tiles show W/H fields instead.

## Tile editor (js/ui/tileeditor.js)

No behavioral changes beyond re-pointing storage: `getPreset`/`setSlot` (in
`js/core/neighbors.js`) read/write `tile.neighbors` on the tile record
instead of a `sheet.tile.neighbors[index]` side-map, keyed by the tile's `id`
instead of its index. The neighbor-preview grid's cell size becomes the
*edited tile's own* `w`/`h` (previously a sheet-global `tileWidth`/
`tileHeight`). A neighbor tile of a different size than the center still gets
stretched into that cell via the existing `drawImage` call — a known, minor,
accepted visual quirk for mixed-size neighbors in Phase A (Phase B's terrain
sets are the real fix, since a terrain set naturally requires uniform tile
size within itself).

## Migration

`PROJECT_VERSION` stays 2 — no other project-level shape changes. Legacy
detection follows the existing `layers` vs. `layerTree` pattern in
`deserializeProject`: if a sheet has the old `tile: { tileWidth, tileHeight,
names, neighbors }` shape and no `tiles`/`tileGrids` arrays, synthesize:

- One grid: `x: 0, y: 0, cellW: tile.tileWidth, cellH: tile.tileHeight,
  cols/rows` from the old `Math.floor(width / tileWidth)` /
  `Math.floor(height / tileHeight)` division, `spacingX: 0, spacingY: 0`.
- One tile per cell, `gridCol`/`gridRow` from the old row-major index math,
  `name` from `tile.names[i]`, `neighbors` from `tile.neighbors[i]` carried
  over unchanged (Phase B migrates the neighbor shape further, if needed, in
  its own spec).

## Export (js/app/exports.js `buildTilesJson`)

The top-level `tileWidth`/`tileHeight`/`columns` fields are dropped: they
assumed one sheet-global uniform grid, which is no longer guaranteed once
multiple grids/sizes can coexist. New shape:

```js
{ sheet, count, tiles: [{ index, name, x, y, w, h, neighbors }] }
```

`index` is the tile's position in `sheet.tiles`; `w`/`h` are now per-tile
(previously implied by the sheet-global `tileWidth`/`tileHeight`). `gridId`/
`gridCol`/`gridRow` stay internal (editor bookkeeping only, not exported).

## Testing

- Unit coverage for the new grid geometry helpers (cell rect math, resize
  add/remove-at-trailing-edge, cellW/cellH re-layout keeping identity via
  gridCol/gridRow) and for the legacy-shape migration (old fixture → expected
  grid + tiles).
- Manual/Playwright coverage for tile-tool interactions (create, swap,
  move, detach, delete) following this project's existing no-drag-simulation
  convention — drags are verified manually, not via simulated Playwright
  pointer events.
