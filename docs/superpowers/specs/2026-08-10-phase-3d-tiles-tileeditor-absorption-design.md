# Phase 3d — Tiles mode: `tileeditor.js` absorption + Phase 3a bug fix (design)

## Goal

Close out tiles mode's DDD migration by applying the same `application/`
(`commands/` + `geometry/`) + `presentation/` split already used for maps
(Phase 1), sprites (Phase 2a-2d), and tiles' core tool, autotile paint tool,
and terrain-set editor (Phase 3a, 3b, 3c) to the last legacy-pattern file in
tiles mode: `js/ui/tileeditor.js` (443 lines — the focused, zoomed-in
per-tile editor with live neighbor preview). This is sub-phase 4 of 4 for
tiles mode (3a/3b/3c done, per [[phase-3-tiles-mode-migration]]) — after
this lands, tiles mode is fully migrated except for the one deliberate,
tracked exception (`terrain-preset-art.js`).

Bundled into the same plan: a fix for a pre-existing Phase 3a undo/redo bug
that 3c's final whole-branch review surfaced (see "Bug fix" below). It's
small, independent of the tileeditor.js work, and reuses a helper 3c already
shipped, so there's no reason to spread it across two plans.

## Scope boundary

In scope:
- `js/ui/tileeditor.js` in full — deleted after migration.
- `js/modes/tiles/application/commands/tile-sheet-commands.js`'s
  `deleteTile`, `deleteGrid`, `resizeGridAxis` — terrain-slot snapshot fix.
- `js/modes/tiles/contributions.js` — import path + one new command
  registration.
- `tests/architecture.test.mjs` — add the new command file to the
  browser-globals scan; the "except `ui/tileeditor.js`" language in
  `docs/ARCHITECTURE.md` is removed.

Out of scope: `core/neighbors.js`, `core/blob47templates.js` — already
correct, pure Domain-level code, untouched. `js/ui/tools.js`'s `bindDrawing`
— shared cross-mode drawing infrastructure, out of scope for the whole
migration series (same reasoning as 3c's `terrain-preset-art.js` boundary).
`js/ui/canvasview.js` — shared, mode-agnostic, untouched.

## Bug fix: terrain-slot state lost on undo (Phase 3a regression)

`deleteTile`, `deleteGrid`, and `resizeGridAxis` in `tile-sheet-commands.js`
all eventually call `core/model.js`'s `scrubTileReferences`, which mutates
**in place**: surviving terrain sets' `slots` maps, the deleted tile's
former slot-occupant fields on other tiles (`terrainSetId`/`blobIndex`/
`duplicateOf`), and — a second, related effect the original 3c review
finding didn't name — any *other* tile's manual neighbor-slot override
(`tile.neighbors[dir]`) that pointed at the now-removed tile, which gets
reset to `{mode:'empty', tileId:null}`. `deleteTile` and `deleteGrid`
currently snapshot `beforeSets = sheet.terrainSets.slice()` before calling
`scrubTileReferences` — but `.slice()` is a shallow array copy: `beforeSets`
and the live `sheet.terrainSets` array contain the exact same terrain-set
*objects*, so once `scrubTileReferences` mutates a set's `.slots` in place,
`beforeSets` was never actually protected — undo restores an array of the
same, already-mutated objects. The same shallow-copy problem applies to
`beforeTiles = sheet.tiles.slice()`: it doesn't protect a surviving tile's
`.neighbors` object from being mutated in place either. `resizeGridAxis`
doesn't even snapshot `terrainSets` at all today, despite its shrink path
(`core/tilegrids.js`'s `resizeGridAxis`) also calling `scrubTileReferences`
on every dropped tile.

Fix: replace each function's `terrainSets`-array snapshot with
`captureTerrainSlotState(sheet)` / `restoreTerrainSlotState(sheet, snapshot)`
from `js/modes/tiles/application/commands/terrain-slot-snapshot.js` (shipped
in 3c for `assignSlot`/`applyLayoutPreset`'s analogous wide-blast-radius
mutations), **widened** in this sub-phase to also capture/restore each
tile's `.neighbors` (a `structuredClone`, matching the `undefined`-safe
clone already used for `.neighbors` elsewhere in `tile-sheet-commands.js`),
since `scrubTileReferences` is a second mutator with the same shape of
problem. `resizeGridAxis` gains a snapshot it didn't have before;
`deleteTile`/`deleteGrid` swap their existing (broken) snapshot for the real
one. No behavior changes outside undo/redo correctness — the array-level
`sheet.terrainSets = afterSets.slice()`/`beforeSets.slice()` assignments stay
(pruning still adds/removes whole terrain-set entries; that part was never
broken), the slot-state capture/restore is additive.

## Target file layout

```
js/modes/tiles/
  application/
    commands/
      tile-sheet-commands.js       — MODIFIED: deleteTile/deleteGrid/
                                       resizeGridAxis use the shared snapshot
      terrain-slot-snapshot.js     — MODIFIED: capture/restore widened to
                                       also cover tile.neighbors
      tile-editor-commands.js      — NEW: 1 resolve-by-id Command Handler
    geometry/
      tile-editor-geometry.js      — NEW: pure hit-testing/offset math
  presentation/
    tile-editor-presenter.js       — NEW (bulk of tileeditor.js)
  contributions.js                 — import path updated, 1 command registered
js/ui/tileeditor.js                — DELETED
```

## Function-by-function mapping

Old file line numbers refer to `js/ui/tileeditor.js` as of the start of this
sub-phase (commit `a1135e5`).

**→ `application/geometry/tile-editor-geometry.js`** (pure — no `state`/DOM
import):
- `DIR_BY_SIGN` (line 53-57) and `dirForCell(dx, dy)` (58-60) — verbatim.
- `DIR_LABELS` (62-66) — verbatim (a pure lookup table; used only to build
  dialog text, but the table itself has no DOM dependency).
- `offset()` (122-127) — becomes pure `computeOffset(tile, radius)`, taking
  the tile directly instead of closing over `currentTile()`/`centerRect()`:
  ```js
  export function computeOffset(tile, radius) {
    return { x: tile.x - radius * tile.w, y: tile.y - radius * tile.h };
  }
  ```
  (`centerRect()` was always just `{x:t.x,y:t.y,w:t.w,h:t.h}` — the
  presenter's `centerRect()` helper stays, as a 1-line closure over
  `currentTile()`, but the actual offset math moves here.)
- `mapPoint(x, y)` (142-145) — becomes pure `mapEditorPoint(offsetPt, x, y)`:
  `{ x: x + offsetPt.x, y: y + offsetPt.y }`. The presenter keeps a thin
  `mapPoint(x, y) { return mapEditorPoint(offset(), x, y); }` wrapper (same
  shape as `tile-tool-presenter.js`'s existing thin wrappers over
  `tile-geometry.js` calls).
- `cellAt(x, y)` (300-308) — becomes pure
  `cellAt(tile, radius, contentW, contentH, x, y)`, dropping the
  `currentTile()`/`view.width`/`view.height` closures in favor of explicit
  params.
- `insideCenter(x, y)` (310-314) — becomes pure
  `insideCenter(tile, radius, x, y)`, same treatment.

**→ `application/commands/tile-editor-commands.js`** (new):
- `commitSlot(tile, dir, slot)` (274-282, currently
  `state.commands.push({do,undo})`) becomes:
  ```js
  import { setSlot } from '../../../../core/neighbors.js';
  import { runCommand } from './tile-sheet-commands.js';

  function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
  function findTile(sheet, tileId) { return sheet.tiles.find(t => t.id === tileId) ?? null; }

  export function setTileNeighborSlot(services, sheetId, tileId, dir, slot) {
    const sheet = findSheet(services.projects.project, sheetId);
    const tile = findTile(sheet, tileId);
    if (!tile) return;
    const before = tile.neighbors ? structuredClone(tile.neighbors) : null;
    runCommand(services, sheetId, 'edit tile neighbor slot',
      sheet => { const t = findTile(sheet, tileId); if (t) setSlot(t, dir, slot); },
      sheet => { const t = findTile(sheet, tileId); if (t) t.neighbors = before ? structuredClone(before) : undefined; });
  }
  ```
  This is the standard resolve-by-id shape (matches `moveGrid` in
  `tile-sheet-commands.js`: `apply` performs the real mutation via the core
  helper, `revert` restores from a `structuredClone` snapshot) — no wide
  blast radius here, so none of 3c's eager-mutate-then-snapshot exception is
  needed. Registered in `contributions.js` as `tiles.setTileNeighborSlot`.

**→ `presentation/tile-editor-presenter.js`** (bulk of the file — DOM
mounting, `CanvasView` wiring, Canvas drawing, dialog, pointer routing, view
lifecycle):
- `mountTileEditor(hostEl)` (68) — verbatim entry point, same return shape
  `{show, hide, view}`. Only `contributions.js`'s import path changes.
- Top-strip DOM construction (69-97), `updateStrip()` (349-363) — verbatim.
- `currentTile()`/`centerRect()`/`getTargetRect()` (108-140) — verbatim
  (thin closures over `state`), now calling `computeOffset` from geometry
  where they used to inline the math.
- `view.imageToScreen` override (132-135) — verbatim, using the geometry
  `computeOffset`.
- `drawTileCell(ctx, ...)` (166-180) — verbatim; stays here because it's a
  `CanvasRenderingContext2D` consumer, which `application/` may never touch
  (enforced by `tests/architecture.test.mjs`'s banned-globals scan at
  line 117-131).
- `view.onPaint`/`view.onOverlay` (182-221) — verbatim.
- Slot dialog construction + `openSlotDialog`/`setMode` (223-272) —
  verbatim, using `getPreset` from `core/neighbors.js` directly (a read,
  not a command — presenters reading Domain/core functions directly is
  established practice, e.g. `terrain-set-editor.js` reading
  `core/terrainsets.js`).
- `teOk` click handler (286-294) — `commitSlot(t, dialogDir, slot)` becomes
  a call through the same `dispatch(id, args)` helper every other migrated
  tiles-mode presenter defines (`import { getEditorHost } from
  '../../../host/runtime.js'`;
  `function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }`
  — verbatim from `tile-tool-presenter.js:19`/`terrain-set-editor.js:20`):
  `dispatch('tiles.setTileNeighborSlot', { sheetId: sheet.id, tileId: t.id, dir: dialogDir, slot })`
  (a single named-keys object, matching every other `dispatch()` call site
  in this codebase — not a positional array).
- Pointer routing (`cellAt`/`insideCenter`/`dirForCell` call sites, 296-345)
  — verbatim except calling the geometry module's pure functions with
  explicit tile/radius/content-size args instead of the old closures.
- `loadContent`/`show`/`hide`/`refresh` (386-435) and the `on('project'|
  'history'|'pixels'|'selection', ...)` wiring (437-440) — verbatim.

No behavior changes anywhere in the presenter — this is a structural
extraction, same as 3a's `tile-tool-presenter.js` split. The only functional
change in this whole sub-phase is the bug fix above.

## Global constraints (inherited from Phases 0/1/2/3a/3b/3c, still binding)

- Command Handlers: `(services, sheetId, ...)`, resolve-by-id via local
  `find*` helpers inside `apply`/`revert` closures, never captured by
  closure across a `mutate()` boundary.
- Presenters dispatch Commands by id only
  (`getEditorHost().registries.commands.execute(id, ctx, args)`), never
  import `application/commands/` or `core/commands.js` directly — enforced
  by `tests/architecture.test.mjs`.
- `application/` never touches `document`/`window`/`alert`/`confirm`/
  `prompt`/Canvas — enforced by the existing banned-globals scans, extended
  to cover `tile-editor-commands.js`.
- `services.history.execute()` shares the same `CommandStack` as legacy
  global undo/redo (confirmed load-bearing by 3c's final review via
  `js/bootstrap.js:14`).
- Every new command's tests include explicit **redo** coverage (undo, then
  redo, then assert), not just apply+undo.

## Testing

New `tests/tile-editor-commands.test.mjs`, same fixture style as
`tests/tile-sheet-commands.test.mjs` (`makeServices`/`makeTile`/`makeSheet`/
`makeProject`), covering `setTileNeighborSlot` with apply+undo+redo for at
least two `mode` values (`'tile'` and `'same'`/`'empty'`), plus a
not-found-tile no-op case (matching the null-guard precedent from 3c's
final-review fix).

`tests/tile-sheet-commands.test.mjs` gets 3 new/modified test cases for the
bug fix: `deleteTile`, `deleteGrid`, and `resizeGridAxis` (shrink path) each
get an undo-then-assert-slots-map-intact case, reproducing the exact repro
3c's final review used (delete a tile that's an explicit terrain-set slot
occupant, undo, assert the slot still lists it and `duplicateOf` is
preserved) — one of these three also covers the widened `.neighbors` case
(a surviving tile has a manual neighbor slot pointing at the deleted tile;
undo must restore that slot, not just leave it `{mode:'empty'}`).

No direct unit tests for `tile-editor-geometry.js`, matching 3a/3b/3c's
precedent for pure geometry modules — coverage comes indirectly from the
command tests plus the smoke check. A non-drag Playwright smoke check (per
[[no-drag-smoke-tests]]) covers the presenter UI at the end of the
implementation plan: open a tile in the tile editor, cycle the neighbor
radius (1×1/3×3/5×5), open a neighbor slot dialog and assign/clear it,
verify a terrain-set-linked tile's slots are read-only (dialog doesn't open,
per the existing `t.terrainSetId != null` guard at line 256), undo/redo the
slot edit, and separately verify the bug fix end-to-end (delete a
slot-occupying tile via the sheet view, undo, re-open the terrain-set editor
and confirm the slot is still occupied).

## Out of scope for this sub-phase

- `js/ui/tools.js` and `bindDrawing` — shared cross-mode drawing
  infrastructure, out of scope for the whole Phase 1-3 migration series.
- `core/neighbors.js`, `core/blob47templates.js`, `core/model.js` — already
  correctly placed, pure Domain/core-level code.
- The other Minor findings 3c's final review parked (e.g. `findSheet`'s 4x
  duplication across command files, dialogs never removed from DOM,
  `terrainSetViewModes` never pruned) — pre-existing, not introduced or
  worsened by this sub-phase, left for a future dedicated cleanup pass if
  ever warranted.
