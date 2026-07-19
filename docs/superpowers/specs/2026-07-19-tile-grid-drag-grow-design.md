# Tile grid drag-to-grow

Date: 2026-07-19
Status: approved

## Goal

Unify how non-autotile tiles are created and grown in tile mode, mirroring
sprite mode's strip-grow interaction (`js/ui/frames.js`'s `stripresize` drag
+ edge grips), generalized from 1D (strips only grow left/right) to 2D
(grids grow left/right AND up/down).

Today, a **standalone tile** (a freely placed/resized rect, `gridId: null`)
is created by dragging a rect on empty canvas — this already works and is
unchanged. A **grid** (a rectangular block of uniformly-sized tiles sharing
one origin/cell-size/cols/rows) can currently only be created via a modal
dialog (exact Cell W/H, Cols, Rows, Spacing X/Y as number inputs) — there is
no interactive way to grow one, and the primitives for it
(`resizeGridCols`/`resizeGridRows` in `core/tilegrids.js`) are already
written but never called from any UI.

After this change: place a tile (drag a rect, as today), then **drag an
edge grip** (left/right/top/bottom) to grow it into a grid one row/column at
a time in that direction. An existing grid gets the same 4 edge grips on
its outer boundary. **A grid that shrinks down to exactly 1×1 collapses
back into a standalone tile** — grid-ness is a derived fact of cell count,
not a separate mode the user has to manage. **Dragging any of a grid's own
tiles (its body, not an edge grip) moves the whole grid** — mirrors how
dragging any frame that belongs to an intact strip moves the whole strip in
sprite mode, and fixes what's currently a dead end (see "Grid body-drag to
move" below).

## Out of scope

- Mid-grid insert/split (Word-style "+" call-outs between existing
  rows/columns, or a split control) — end-edge grow/shrink only, matching
  the "End-grip resize only" scope decision. `chromeGeometry`'s
  `inserts`/`splits` call-outs in frames.js are NOT mirrored here.
- Autotile / terrain-set grids — these are a separate creation flow
  (`buildAddTerrainSetDialog`, kept as-is) and are not affected.
- Any change to how standalone tiles are freely corner-resized (arbitrary
  w/h, unrelated to any cell grid) — unchanged.
- The existing small origin-handle grid-move mechanism itself
  (`hitGridHandle`/`drawGridHandles`, the `gridmove` drag kind) is
  unchanged and stays as an additional, more precise way to grab a grid —
  it coexists with the new body-drag-to-move (below), which is an
  addition, not a replacement.

## Removed

- `buildAddGridDialog`, `drawAddGridPreview`, `addGridPreviewOpts`
  (js/ui/tilemode.js) — the modal-dialog grid-creation UI. Both are
  dynamically-constructed `<dialog>` elements (`document.createElement`),
  not markup in index.html, so nothing there needs touching.
- The "➕ Grid" button in the Tiles panel (js/ui/tilemode.js's
  `mountTilePanel`) — only "➕ Autotiles" remains there. Standalone-tile
  grid creation is now purely: drag a tile on the canvas, then drag its
  edge grip.

**NOT removed** (corrected after re-reading the actual call sites —
`commitAddGrid` and `createTileGrid` are load-bearing outside the dialog
being removed):
- `commitAddGrid` (js/ui/tilemode.js) and `createTileGrid`
  (js/core/tilegrids.js) stay. `buildAddTerrainSetDialog`'s create handler
  also calls `commitAddGrid` directly (`{ x: 0, y: 0, cellW: tileW, cellH:
  tileH, cols: preset.cols, rows: preset.rows }`) to build the grid that
  holds a blob47 layout preset's artwork (8×6/7×7 templates) — this is the
  terrain-set flow the "Out of scope" section already excludes, and must
  keep working unchanged. Only `buildAddGridDialog`'s OWN call to
  `commitAddGrid` (the manual entry point) goes away with the dialog.
  `growTileIntoGrid` (new, below) does NOT call `createTileGrid` — that
  function always builds brand-new cell tiles via its internal
  `makeCellTile`, which would create a second, blank tile object
  duplicating the original standalone tile's rect instead of reusing it.
  `growTileIntoGrid` constructs the `{ id: newId('tg'), x: tile.x, y:
  tile.y, cellW: tile.w, cellH: tile.h, cols: 1, rows: 1, spacingX: 0,
  spacingY: 0 }` grid record itself, pushes it to `sheet.tileGrids`,
  mutates the existing tile in place (`gridId`/`gridCol: 0`/`gridRow: 0`
  — its `x/y/w/h` already match the grid's sole cell, untouched), and
  only THEN calls `resizeGridAxis` to grow to the requested count — which
  is what actually creates any additional NEW cell tiles.

## Data model — `core/tilegrids.js`

No changes to the `tileGrids`/`tiles` shapes from the Phase A tile-placement
spec (2026-07-17). New/generalized functions:

```js
// Generalizes the existing (currently dead-code) resizeGridCols/resizeGridRows.
// axis: 'cols' | 'rows'. side: 'start' | 'end' — 'start' is left (cols) or
// top (rows); 'end' is right (cols) or bottom (rows). `count` is the new
// total cols/rows (same contract as the old functions: pass the target
// count, not a delta). Growing/shrinking on 'end' is exactly today's
// resizeGridCols/resizeGridRows (append/truncate high-index cells) — this
// generalization ADDS the 'start' case.
//
// 'start' growth: shift grid.x (cols) or grid.y (rows) so existing cells'
// on-screen position is UNCHANGED (see "Why no pixel-shifting" below), then
// renumber every existing tile's gridCol/gridRow by the delta, then append
// new cells at the freed-up low indices.
//
// 'start' shrink: remove the lowest-index cells (scrubTileReferences each,
// same as the existing 'end' shrink path), renumber the survivors'
// gridCol/gridRow down by the delta, then shift grid.x/grid.y the other
// way so survivors' on-screen position is unchanged.
//
// Returns { added: Tile[], removed: Tile[] } like the functions it replaces.
export function resizeGridAxis(sheet, grid, axis, side, count)

// Promotes a standalone tile into a brand-new 1x1 grid using the tile's own
// w/h as cellW/cellH and its x/y as the grid origin (spacingX/Y: 0 — no
// dialog to set spacing anymore, drag-created grids are always flush) --
// see "Removed" above for exactly how (does NOT call createTileGrid) --
// then immediately grows it via resizeGridAxis(axis, side, count). The
// ORIGINAL tile object is reused (mutated in place: gridId/gridCol/gridRow
// set), matching commitNewStripFromFrame's "origin frame becomes a real
// member" pattern in frames.js -- its id, name, neighbors, terrainSetId
// etc. all survive the promotion. Its FINAL gridCol/gridRow depends on
// side, per resizeGridAxis's own renumbering rule above: index 0 for
// side: 'end' growth (new cells append after it), or the highest index
// for side: 'start' growth (it gets renumbered up as new cells fill in
// below/left of it) -- it never silently jumps position on screen either
// way, only its (col, row) address within the grid changes.
// Returns { grid, added, removed } (removed is always [] here).
export function growTileIntoGrid(sheet, tile, axis, side, count)

// When resizeGridAxis leaves a grid at exactly 1 col AND 1 row, the caller
// (tilemode.js's commit function, not resizeGridAxis itself — see below)
// calls this to remove the tileGrids entry and detach the surviving tile
// (reuses the existing detachTile primitive). Returns the surviving tile.
export function collapseGridToTile(sheet, grid)
```

`resizeGridAxis` does NOT auto-collapse on its own — it's a pure geometry
primitive (mirrors how `resizeGridCols`/`resizeGridRows` never contained
UI-level policy either). The 1×1-collapse decision is made by the
`ui/tilemode.js` commit wrapper, which is also where undo/redo commands are
built (same "eager mutate + snapshot for undo" idiom as `commitResizeGridCols`
today) — collapsing is just another state transition in that command.

### Why no pixel-shifting is needed

Unlike sprite-mode strips (whose members are physically relocated —
`commitMoveFramesWithPixels` — because frames pack tightly with no fixed
grid concept), a tile grid's cells are purely positional:
`x = grid.x + col * (cellW + spacingX)`. Growing on `'start'` shifts
`grid.x` left by one `(cellW + spacingX)` **and** renumbers every existing
tile's `gridCol += 1` in the same step. Substituting into the position
formula: `(grid.x_old − step) + (col_old + 1) × step = grid.x_old + col_old
× step` — algebraically identical to the tile's position before the grow.
Existing tiles never move on screen or need their pixels touched; the new
column simply appears in the vacated slot at `grid.x_new`. Same math for
rows via `grid.y`/`cellH`/`spacingY`. Shrinking on `'start'` is the exact
inverse.

### Bounds clamping

Mirrors `frames.js`'s `stripresize` `maxCount` clamp: growth on any side is
capped so the grid's outer bounding box never exceeds the sheet's
width/height, and never goes negative (`grid.x`/`grid.y` can't go below 0,
and `grid.x + cols*(cellW+spacingX)` can't exceed `sheet.width`, same for
rows/height). Computed the same way — `Math.floor(availableSpace / step)`
— in the UI's `handleMove`, exactly where the strip feature already does
this clamp, not inside `resizeGridAxis` itself (which trusts its caller,
same division of responsibility as `resizeGridCols`/`resizeGridRows` today).

## Interaction — `ui/tilemode.js`

### Grip geometry

New function mirroring `frames.js`'s `standaloneGripGeometry` /
`chromeGeometry`'s `grips` array, generalized from 2 sides to 4:

```js
// bounds: {x, y, w, h} in sheet-space — either a standalone tile's own rect,
// or a grid's outer bounding box (x, y, cols*(cellW+spacingX)-spacingX, ...).
// Returns 4 edge-strip zones (screen space), one per side, each a thin
// (6px) strip running the full length of that edge — same shape as
// frames.js's left/right grips, plus top/bottom.
function tileGripGeometry(view, bounds)
```

Hit-testing (`hitGrip`-equivalent) checks these 4 zones. In `handleDown`,
checked in this order (mirrors the existing frame/tile precedent of
corner-handle-before-grip):

1. Existing grid move-handle (small origin square) — unchanged, unaffected.
2. Corner resize handles (`hitHandle`) — standalone tiles only, unchanged;
   grid-owned tiles still never get these (matches the existing
   `hitHandle` gate).
3. **New**: the 4 edge grips — on a standalone tile OR a grid-owned tile
   (via its owning grid's outer bounds), only when that tile is currently
   selected (mirrors `chromeGeometry`'s "chrome only targets the selected
   segment" rule).
4. Existing tile-at hit-test (`tiledrag`) — **behavior changes on release**,
   see "Grid body-drag to move" below. The down-handling itself (start a
   `tiledrag` drag on whatever tile is under the pointer) is unchanged;
   only `handleUp`'s "no swap target" branch changes for grid-owned tiles.

### New drag kind: `gridresize`

```js
drag = {
  kind: 'gridresize',
  axis: 'cols' | 'rows', side: 'start' | 'end',
  grid: Grid | null,   // null means "no grid yet — dragging a standalone tile's grip"
  tile: Tile,           // the standalone tile (grid: null) or the anchor cell (grid: set)
  step: number,          // cellW+spacingX or cellH+spacingY
  bbox: Rect,            // outer bounds at drag start
  // count0 is the starting count: 1 for a standalone tile (grid: null,
  // mirrors frames.js's count0: 1 for its no-strip-yet case), or the
  // grid's current cols/rows (matching axis) for an existing grid. count
  // is count0 live-updated by handleMove's drag-distance math, same
  // formula as stripresize: count0 + Math.round(raw / step), clamped.
  count0: number, count: number,
}
```

`handleMove` computes `count` from drag distance exactly like
`stripresize` does (`Math.round(raw / step)`, clamped to bounds — see
above — and to a minimum of 1). `handleUp` follows this codebase's
established "eager mutate, then snapshot, then push a do()/undo() that
only restores snapshots" idiom (see `commitResizeGridCols`/
`commitDeleteGrid` in tilemode.js today — the primitive runs ONCE,
immediately; `do()`/`undo()` never re-invoke it, they just assign
before/after snapshot arrays):

- If `d.grid` is `null` (no drag distance beyond 1, i.e. `count === 1`):
  no-op, matching `commitResizeGridCols`'s `if (cols === grid.cols)
  return;` guard. Otherwise snapshot `sheet.tileGrids`/`sheet.tiles`
  before, call `growTileIntoGrid(...)` once (eager mutate), snapshot
  after, push a command whose `do()`/`undo()` assign
  `sheet.tileGrids`/`sheet.tiles` to the after/before snapshots (mirrors
  `commitAddGrid`'s shape, since this also creates a new `tileGrids`
  entry).
- If `d.grid` is set: snapshot `sheet.tileGrids`/`sheet.tiles` before,
  call `resizeGridAxis(...)` once — and if that leaves the grid at 1×1,
  immediately call `collapseGridToTile(...)` too, in the SAME eager pass
  — then snapshot after, push ONE command covering both steps (so undo
  restores the pre-shrink multi-cell grid in one step, not two separate
  undo-able actions for one drag gesture). Mirrors `commitDeleteGrid`'s
  shape (snapshots `tileGrids` + `tiles`, no separate terrain-set pruning
  — existing `commitResizeGridCols` doesn't prune empty terrain sets on
  shrink either, so this preserves that existing behavior rather than
  introducing new pruning scope).

### Grid body-drag to move

Today, `handleUp`'s `tiledrag` branch has:

```js
if (from.gridId != null) return; // grid-owned, no same-size target: snaps back
```

— dragging a grid tile's body and releasing anywhere that isn't a
same-size swap target is currently a **dead end**: the ghost preview draws
during the drag (ghost logic already checks `drag.from.gridId == null`
before drawing a move-preview, so a grid tile's ghost is already
correctly suppressed today) but nothing happens on release. This is
replaced with: when `from.gridId != null` and there's no swap target,
move the tile's OWNING GRID by the drag delta — same computation
`commitMoveGrid` already takes (`dx`, `dy`), but clamped to the sheet
bounds using the grid's full outer bounding box (not just the single
dragged tile's rect), fixing `commitMoveGrid`'s current total absence of
bounds clamping (the existing origin-handle `gridmove` path has the same
gap — both paths call the same `commitMoveGrid`, so this one fix covers
both):

```js
if (from.gridId != null) {
  const grid = sheet.tileGrids.find(g => g.id === from.gridId);
  const bounds = gridBounds(grid); // {x, y, w, h} — new small helper, or inline
  const dx = Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - d.anchor.x));
  const dy = Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - d.anchor.y));
  if (dx !== 0 || dy !== 0) commitMoveGrid(sheet, grid, dx, dy);
  return;
}
```

The swap-onto-same-size-target branch above this (unchanged) still takes
priority — dropping a grid tile onto another same-size tile (grid-owned
or standalone) swaps them exactly as today; only the "no target" fallback
changes from a no-op to a whole-grid move. The tile that was dragged stays
selected (`state.selectedTileId` is untouched by this branch, matching
today).

**Ghost preview while dragging** must be added too, not just the commit —
today's overlay code only draws a ghost for the swap case or for a
standalone tile's free move; a grid tile's in-progress drag currently
renders nothing at all (`else if (drag.from.gridId == null)` gates the
only other ghost branch). The drag stays `tiledrag` throughout (swap vs.
whole-grid-move can't be decided until release, since it depends on
whether a same-size tile happens to be under the pointer at that moment —
same ambiguity the existing swap-ghost check already resolves live, every
`handleMove`). Extend the overlay's `tiledrag` branch: when not a swap
candidate and `drag.from.gridId != null`, draw every tile owned by that
grid shifted by the live `(dx, dy)` — reuses the exact ghost-drawing loop
`gridmove` already has (`for (const t of ownedTiles(...)) strokeGhostRect(...)`)
— plus the grid's dimension label via `drawGridDims(ctx, view, grid, {
dx, dy })`, same as `gridmove`'s non-quiet render today.

### Rendering

- **Ghost during drag**: a dashed outline of the live bbox at the current
  `count` (mirrors `resizeGhostRect`), plus a dimension label showing the
  cols×rows delta (mirrors `drawStripDims`/`drawGridDims`'s existing
  non-quiet mode).
- **Idle chrome** (`drawTileChrome`, existing function, extended): a
  selected standalone tile shows its existing corner handles PLUS the new 4
  edge grips. A selected grid-owned tile shows the existing quiet
  `drawGridDims` label PLUS the new 4 edge grips on the grid's outer
  bounds (no corner handles — unchanged rule).

## Testing

- `core/tilegrids.js` unit tests (`tests/tilegrids.test.mjs` — new or
  extended, check existing test file naming) for `resizeGridAxis` on all
  4 (axis, side) combinations: grow and shrink, verifying existing tiles'
  x/y/gridCol/gridRow stay correct (the algebra above) and grid.x/grid.y
  shift correctly; `growTileIntoGrid` preserving the original tile's id/
  name/neighbors as the (0,0) or (N-1,0) etc. cell depending on side;
  `collapseGridToTile` removing the tileGrids entry and detaching the
  surviving tile with its rect unchanged.
- Grid body-drag-to-move and the edge-grip grow/shrink drags are pointer
  interactions with no pure-logic seam to unit test (the bounds-clamping
  math is inline in `handleUp`/`handleMove`, matching how the existing
  standalone-tile move clamp is also inline, not factored into `core/`) —
  per this project's existing convention of never simulating pointer
  drags in Playwright, these are verified manually by the user, not
  automated.
