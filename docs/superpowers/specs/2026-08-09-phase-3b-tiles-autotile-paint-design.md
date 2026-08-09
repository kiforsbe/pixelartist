# Phase 3b — Tiles mode: autotile/Blob-47 paint tool migration (design)

## Goal

Apply the same `application/` (`commands/` + `geometry/`) + `presentation/`
split already used for maps (Phase 1), sprites (Phase 2a-2d), and tiles'
core tool (Phase 3a) to `js/modes/tiles/autotile-paint-controller.js`
(511 lines) — the Blob-47 autotile painter. This is sub-phase 2 of 4 for
tiles mode (3a done; 3c terrain-set editor dialog and 3d `tileeditor.js`
absorption remain, per [[phase-3-tiles-mode-migration]]).

## Scope boundary

In scope: `autotile-paint-controller.js` only. Out of scope, deferred to
3c: `terrain-set-controller.js` (587 lines), `autotiles-panel.js`,
`terrain-set-commands.js` (still legacy `CommandStack`/object-capture
style). `terrain-set-controller.js` is a consumer of this file's exports
(confirmed via grep — every exported function from
`autotile-paint-controller.js` is called either by `contributions.js` or
`terrain-set-controller.js`, nothing else) and needs only its import path
updated, not a functional change, since none of the migrated functions'
external signatures change.

This sub-phase does NOT depend on 3c: `core/terrainsets.js`'s
`assignSlot`/`clearSlot`/`pruneEmptyTerrainSets` are already pure
(sheet/terrainSet/tile arguments, no `state`/DOM dependency) and can be
wrapped directly by new resolve-by-id Command Handlers, with no need to
touch or depend on the legacy `terrain-set-commands.js`.

## Target file layout

```
js/modes/tiles/
  application/
    commands/
      autotile-paint-commands.js    — NEW: 3 Command Handlers
    geometry/
      autotile-geometry.js          — NEW: pure paint-grid/cell/mask helpers
  presentation/
    autotile-paint-presenter.js     — pointer/stroke handling + overlay/preview rendering
    blob47-coverage-dialog.js       — NEW: the standalone coverage-review modal
  contributions.js                  — import paths updated, 3 commands registered
  terrain-set-controller.js         — import paths updated only (unchanged otherwise)
autotile-paint-controller.js        — DELETED
```

`core/blob47.js` (the actual Blob-47 bitmask/canonicalization/symmetry
algorithm — already pure, DOM-free, extensively commented) and
`core/blob47templates.js` are untouched; they're already correctly placed
as Domain-level pure modules under `js/core/`, not part of this migration.

## Function-by-function mapping

Old file line numbers refer to `autotile-paint-controller.js` as of the
start of this sub-phase (commit `b87dd87`).

**→ `application/geometry/autotile-geometry.js`** (pure — no `state`/DOM
import):
- `describeMask(mask)` (12-21) — verbatim.
- `terrainPaintGrid(sheet, terrainSet)` (31-34) — verbatim.
- `paintTileAt(sheet, terrainSet, x, y)` (79-85) — verbatim.
- `paintCellAt(tile, x, y)` (87-91) — verbatim.
- `persistedPaintMask(tile, terrainSet)` (93-95) — verbatim.
- `strokePaintMask(tile, terrainSet, stroke)` (97-99) — **signature
  change**: currently reads the module-level `autotilePaint?.stroke`
  directly, making it impure as written. Takes `stroke` as an explicit
  third parameter instead; callers in the Presenter pass their own
  `autotilePaint.stroke`. Same logic, now pure and testable:
  ```js
  export function strokePaintMask(tile, terrainSet, stroke) {
    return stroke?.masks.get(tile.id) ?? persistedPaintMask(tile, terrainSet);
  }
  ```
- `planTerrainPaintCells(sheet, terrainSet)` — NEW, extracted from
  `prepareTerrainPaint`'s (47-77) validation + diff logic, with the
  `state.commands.push(...)` removed. Pure: computes the expected
  cell lattice, validates existing tiles align to it, and returns either
  `{ error: string }` or `{ grid, missing: [{x,y,w,h}, ...] }` (the cells
  that still need a standalone tile created). The command handler below
  does the actual creation.

**→ `application/commands/autotile-paint-commands.js`** (resolve-by-id,
`(services, sheetId, ...)`, mirrors `tile-sheet-commands.js`'s
`runCommand`/`findSheet` pattern):
- `prepareTerrainPaint(services, sheetId, terrainSetId)` — calls
  `planTerrainPaintCells`; on error returns `{ error }` (no `alert()` —
  that's a banned global in `application/`, per the existing
  `tests/architecture.test.mjs` banned-globals scan that already covers
  the tile/terrain-set command files; the Presenter shows the alert).
  On success, creates the missing cells as standalone tiles (the
  `standalonePaintTile(x, y, w, h)` factory, 36-42, moves here —
  colocated with the command that uses it, matching `createTile`'s
  precedent of an inline tile literal living in the command file, not
  geometry) and pushes one undo entry only if cells were actually added,
  matching the original's behavior (69-75).
- `paintTerrainStroke(services, sheetId, terrainSetId, strokeMasks)` —
  replaces `commitTerrainPaintStroke`'s (128-178) command-push (159-173).
  Takes the finished stroke's `Map<tileId, mask>` (or an equivalent
  serializable form) as an argument — the stroke's pointer-tracking state
  itself (`seen`, `brush`) stays in the Presenter, only the final masks
  cross the dispatch boundary. Same conflict-detection + slot-assignment
  logic (139-158), eager-mutate-then-snapshot before calling
  `runCommand`, matching `deleteGrid`'s established pattern from 3a.
  Returns `{ conflicts }` (a `Map<tileId, blobIndex>`) for the Presenter
  to store as `autotilePaint.conflicts` — conflicts are ephemeral
  paint-session UI state, not project data, so they don't belong in the
  command's undo/redo payload itself.
- `resolveAutotilePaintConflict(services, sheetId, terrainSetId, tileId, blobIndex)`
  — replaces `useAutotilePaintConflict`'s (475-501) command-push
  (484-498). Wraps `assignSlot` from `core/terrainsets.js` directly.

**→ `presentation/autotile-paint-presenter.js`**:
- The `autotilePaint` module-level session state (29).
- Pointer routing: `beginTerrainPaintStroke`, `applyTerrainPaintPoint`
  (101-126) — now call the geometry functions with explicit `stroke`
  arguments; `commitTerrainPaintStroke` (128-178) becomes a thin wrapper
  that packages `stroke.masks` and calls
  `dispatch('tiles.paintTerrainStroke', {...})`, storing the returned
  `conflicts` onto `autotilePaint.conflicts`.
- All Canvas rendering: `drawAutotilePaintOverlay`, `drawAutotilePaintPreview`,
  `drawBlob47Reference`, `drawBlob47AssignedTileOverlay`,
  `drawBlob47PaintMarks`, `getBlob47ReferenceImage` (271-279) — verbatim,
  `getBlob47ReferenceImage` additionally exported so the coverage dialog
  can share the same cached `Image` instance.
- `registerAutotilePaintTool`, `bindAutotilePaintTool` (418-447) —
  verbatim.
- Public API: `startAutotilePaint` (449-462) — calls
  `dispatch('tiles.prepareTerrainPaint', ...)`, shows `alert()` on
  `{error}`, otherwise sets up `autotilePaint` session state as today;
  `stopAutotilePaint` (464-470) — verbatim; `useAutotilePaintConflict`
  (475-501) — becomes a thin wrapper dispatching
  `tiles.resolveAutotilePaintConflict`; `getAutotilePaintSession` (503-505),
  `setAutotilePaintBrush` (507-510) — verbatim.

**→ `presentation/blob47-coverage-dialog.js`** (NEW file):
- `openBlob47Coverage` (281-349) — verbatim, imports
  `getBlob47ReferenceImage` from `./autotile-paint-presenter.js`
  (presentation-to-presentation import within the same mode — the
  architecture boundary only restricts presentation importing
  `application/commands/`, not sibling presentation files).
- The module-level `blob47CoverageDialog`/`refreshBlob47Coverage` state
  (281-282) moves with it. `refreshBlob47Coverage` is currently called
  from `commitTerrainPaintStroke` (176) and `useAutotilePaintConflict`
  (500) — both now live in the Presenter, which will need a way to
  trigger a re-render of an open coverage dialog. Simplest: the dialog
  file exports `refreshBlob47CoverageIfOpen()` (renamed from the current
  module-level `refreshBlob47Coverage` variable pattern, now an exported
  function with the same open-check guard) and the Presenter imports and
  calls it after both dispatches succeed.

**`contributions.js`**: `import { registerAutotilePaintTool, bindAutotilePaintTool } from './autotile-paint-controller.js';`
→ `from './presentation/autotile-paint-presenter.js';`; the 3 new
commands (`tiles.prepareTerrainPaint`, `tiles.paintTerrainStroke`,
`tiles.resolveAutotilePaintConflict`) registered alongside the existing
19 in `registerTileCommands`.

**`terrain-set-controller.js`**: its one import line
(`from './autotile-paint-controller.js'`, currently importing
`getAutotilePaintSession, setAutotilePaintBrush, startAutotilePaint,
stopAutotilePaint, useAutotilePaintConflict, openBlob47Coverage`) splits
into two — the first five from `./presentation/autotile-paint-presenter.js`,
`openBlob47Coverage` from `./presentation/blob47-coverage-dialog.js`. No
other change; all call sites (lines ~426-472) are unchanged since none of
these functions' external signatures change.

## Global constraints (inherited from Phases 0/1/2/3a, still binding)

- Command Handlers: `(services, sheetId, ...)`, resolve-by-id via local
  `find*` helpers inside `apply`/`revert` closures, never captured by
  closure across a `mutate()` boundary.
- Presenters dispatch Commands by id only
  (`getEditorHost().registries.commands.execute(id, ctx, args)`), never
  import `application/commands/` directly — enforced by
  `tests/architecture.test.mjs`.
- `application/` never touches `document`/`window`/`alert`/`confirm`/`prompt`
  — enforced by the existing banned-globals scan test, which this
  sub-phase extends to cover `autotile-paint-commands.js`.
- `services.history.execute()` shares the same `CommandStack` as legacy
  global undo/redo — pre-existing infrastructure, nothing to build, just
  don't break it.
- No command may capture an entity object across a `mutate()` boundary
  (the lesson from 3a's final review, where `createTile` briefly
  regressed on this) — every entity (`tile`, `terrainSet`) is
  re-resolved fresh inside each `apply`/`revert` closure via `findSheet`/
  local lookups, never held from an outer scope across the boundary.

## Testing

New `tests/autotile-paint-commands.test.mjs` for the 3 command handlers,
same fixture style as `tests/tile-sheet-commands.test.mjs`
(`makeServices`/`makeTile`/`makeSheet`/`makeProject`/`resetLegacy`),
including complete `slots`/`symmetry` terrain-set fixtures (the fixture
bug from 3a's Task 1 — an incomplete terrain-set literal breaking
`core/terrainsets.js`'s `clearSlot`/`assignSlot` — must not recur here).

No direct unit tests for `autotile-geometry.js`, matching 3a's precedent
(`tile-geometry.js` got none either) — coverage comes from the command
tests plus a non-drag Playwright smoke check of the paint tool
(select/paint a Blob-47 cell via clicks, not drags; verify the stroke
commits; verify a conflict can be created and resolved via the "use this"
action) at the end of the implementation plan, per
[[no-drag-smoke-tests]].

## Out of scope for this sub-phase

- Any change to `terrain-set-controller.js`'s own internals, `autotiles-panel.js`,
  or `terrain-set-commands.js` — all deferred to 3c.
- Any change to `core/blob47.js`, `core/blob47templates.js`, or
  `core/terrainsets.js` — already correctly placed, pure Domain-level
  code.
