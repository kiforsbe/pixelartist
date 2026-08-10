# Phase 3c — Tiles mode: terrain-set editor dialog migration (design)

## Goal

Apply the same `application/` (`commands/` + `geometry/`) + `presentation/`
split already used for maps (Phase 1), sprites (Phase 2a-2d), and tiles'
core tool + autotile paint tool (Phase 3a, 3b) to the remaining tiles-mode
files still on the legacy pattern: `js/modes/tiles/terrain-set-controller.js`
(590 lines), `js/modes/tiles/autotiles-panel.js` (55 lines), and
`js/modes/tiles/terrain-set-commands.js` (132 lines — still pushes
`{do,undo}` onto the legacy `CommandStack` via object-capture, not
resolve-by-id). This is sub-phase 3 of 4 for tiles mode (3a, 3b done; 3d
`tileeditor.js` absorption remains, per [[phase-3-tiles-mode-migration]]).

## Scope boundary

In scope: all three files listed above, plus a small, targeted modification
to Phase 3b's already-shipped `js/modes/tiles/application/commands/autotile-paint-commands.js`
(see "Shared terrain-slot snapshot helper" below — a mechanical extraction,
not a behavior change).

Out of scope: `importPresetArtOntoLayer`'s raw `state.commands.push(makePixelPatch(...))`
call stays as-is. It matches the still-legacy, cross-mode-shared paint-commit
idiom used by `js/ui/tools.js` (the shared paint tool used by every mode,
explicitly out of scope for this whole migration series per
[[tiles-sprites-share-common-code]]'s earlier cross-mode pass) — not a
3c-specific gap. `core/terrainsets.js` and `core/blob47.js`/`core/blob47templates.js`
are untouched; already pure, DOM-free Domain-level code.

## Target file layout

```
js/modes/tiles/
  application/
    commands/
      terrain-set-commands.js       — NEW: 8 resolve-by-id Command Handlers
      terrain-slot-snapshot.js      — NEW: shared capture/restore helpers,
                                       used by this file AND autotile-paint-commands.js
      autotile-paint-commands.js    — MODIFIED: resolveAutotilePaintConflict
                                       switches to the shared snapshot helper
    geometry/
      terrain-set-geometry.js       — NEW: pure view-arrangement helpers
  presentation/
    terrain-set-panel.js            — NEW (moved from autotiles-panel.js)
    terrain-set-editor.js           — NEW (bulk of terrain-set-controller.js)
    tile-panel.js                   — import path updated only
  contributions.js                  — import paths updated, 8 commands registered
autotiles-panel.js                  — DELETED
terrain-set-controller.js           — DELETED
terrain-set-commands.js             — DELETED
```

## Function-by-function mapping

Old file line numbers refer to the files as of the start of this sub-phase
(commit `abc0ef0`).

**→ `application/geometry/terrain-set-geometry.js`** (pure — no `state`/DOM
import):
- `blobStaircaseGroups()` (terrain-set-controller.js:38-47) — verbatim.
- `gridFromRawTemplate(rawGrid)` (68-70) — verbatim.
- `slotGroupsForViewMode(mode)` (72-77) — verbatim.
- `describeMask` (79-83) is **not** re-declared here — it duplicates the
  function already exported by `application/geometry/autotile-geometry.js`
  (flagged as a sanctioned deferral in 3b's final review). The presentation
  file imports it from there instead.

**→ `application/commands/terrain-slot-snapshot.js`** (pure, NEW — shared
by two command files):
- `captureTerrainSlotState(sheet)` → `{ terrainSets: [{id, slots}], tiles: [{id, terrainSetId, blobIndex, duplicateOf}] }`,
  covering every terrain set's `slots` (not just one) and every tile's
  back-reference fields. `core/terrainsets.js`'s `assignSlot` can mutate a
  *different* terrain set's `slots` map when the tile being assigned
  already belongs to another set — the tile picker (`buildTilePickerDialog`)
  lets the user pick any same-size tile regardless of which set currently
  owns it, so this is a reachable case for `assignTerrainSlot`, unlike for
  3b's paint-conflict flow (see below).
- `restoreTerrainSlotState(sheet, snapshot)` → re-resolves every id inside
  the function body (`sheet.terrainSets.find`/`sheet.tiles.find`), never
  operates on captured entity references.

**Why this fixes a real bug, not just duplication:** the current
`commitAssignSlot` (terrain-set-commands.js:50-69) snapshots only
`beforeTiles`/`beforeSlots` for undo, but its `do()` closure re-applies only
`afterSlots` + the assigned tile's own `terrainSetId`/`blobIndex` — it never
restores a previous slot occupant's cleared back-reference on **redo**
(there is no `afterTiles` capturing that side effect). Switching to the
shared helper's full capture-both-before-and-after pattern fixes this.
3b's `resolveAutotilePaintConflict` already captures `beforeTiles`/`afterTiles`
correctly (it doesn't have this redo bug), but its snapshot only covers the
*target* terrain set's `slots`, not every set's — narrower than the new
shared helper, though it never hit the gap in practice, since a
paint-in-progress tile's `terrainSetId` is always either unset or already
equal to the terrain set being painted. Switching it to the shared helper is
therefore a safe widening, not a behavior change for any reachable 3b call
site.

**→ `application/commands/terrain-set-commands.js`** (resolve-by-id,
`(services, sheetId, ...)`, reuses `runCommand` from `./tile-sheet-commands.js`):
- `createTerrainSet(services, sheetId, { name, tileW, tileH })` → whole-array
  snapshot swap on `sheet.terrainSets` (same pattern as 3b's
  `prepareTerrainPaint`). Returns `{ terrainSetId }` (not the entity) —
  callers select it via id.
- `deleteTerrainSet(services, sheetId, terrainSetId)` → whole-array swap on
  `sheet.terrainSets` + id-based tile snapshot/restore for the
  `terrainSetId`/`blobIndex` back-references `removeTerrainSet` clears.
  Converts the current `beforeTiles = sheet.tiles.map(t => ({t, ...}))`
  (captures live tile references) to `{id, terrainSetId, blobIndex}` +
  `sheet.tiles.find` inside the closures.
- `renameTerrainSet(services, sheetId, terrainSetId, name)` → simple field
  toggle.
- `assignTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId)` →
  uses `captureTerrainSlotState`/`restoreTerrainSlotState`. Does **not**
  clear `duplicateOf` (matches current `commitAssignSlot` behavior exactly —
  only the conflict-resolution flow does that).
- `clearTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId)` →
  `tileId` may be `null` (mirrors `commitClearSlot`'s optional `tile`
  param — the slot's recorded owner id may not resolve to a live tile).
  Narrow snapshot (`clearSlot`'s blast radius is at most one tile + one
  terrain set's `slots`) — does not need the shared helper.
- `setTerrainSymmetry(services, sheetId, terrainSetId, key, value)` →
  simple field toggle.
- `applyTerrainLayoutPreset(services, sheetId, terrainSetId, preset, sourceTileIds, cols)` →
  resolves `sourceTileIds` to tile objects internally (row-major, matching
  `sourceTiles`' existing shape), then calls `core/terrainsets.js`'s
  `applyLayoutPreset`. `preset` is passed through as plain data (never
  mutated by the command — same treatment 3b gave `strokeMasks`). Uses the
  shared snapshot helper (blast radius is the union of N `assignSlot` calls
  plus direct `duplicateOf` writes on non-primary cells, all covered by the
  helper's tile-level capture).
- `setTerrainSetLayer(services, sheetId, terrainSetId, layer)` → simple
  field toggle.

**→ `application/commands/autotile-paint-commands.js`** (MODIFIED):
`resolveAutotilePaintConflict`'s inline `beforeSlots`/`beforeTiles`/`afterSlots`/`afterTiles`
capture (currently built by hand at the top of the function, then replayed
inside the `runCommand` apply/revert closures) is replaced by
`captureTerrainSlotState`/`restoreTerrainSlotState` calls in those same three
places. The `tile.duplicateOf = undefined` line stays (this command's own
distinguishing behavior, applied after capturing "before" and before
capturing "after"). No change to its exported signature or the 11 existing
tests in `tests/autotile-paint-commands.test.mjs` — they must keep passing
unchanged, since this is a pure internal-implementation swap.

**→ `presentation/terrain-set-panel.js`** (moved from `autotiles-panel.js`):
- `mountAutotilesPanel(element)` (autotiles-panel.js:8-55) — verbatim, only
  its import of `renderTerrainSetEditor`/`syncSelectedTerrainSetFromTile`
  repointed to `./terrain-set-editor.js`.

**→ `presentation/terrain-set-editor.js`** (bulk of `terrain-set-controller.js`):
- `terrainSetViewModes` Map + `viewModeFor` (terrain-set-controller.js:57-60) —
  transient, per-terrain-set UI state, never persisted — stays module-level
  here.
- `syncSelectedTerrainSetFromTile(tile)` (99-101) — verbatim.
- `terrainSetNameField(terrainSet)` (107-123), `terrainSetLayerField(sheet, terrainSet)` (125-142),
  `terrainSetDeleteButton(sheet, terrainSet)` (144-155) — verbatim, calling
  the new command functions by id instead of the old `commit*` imports.
  These three are also imported by `presentation/tile-panel.js` (its own
  import line updated, no other change — none of these signatures change).
- `importPresetArtOntoLayer(sheet, preset, sourceTiles, cols)` (164-203) —
  verbatim, including its own raw `state.commands.push(makePixelPatch(...))`
  (see Scope boundary — intentionally not converted).
- `drawLayoutPreview(canvas, preset)` (220-258) + module-level `previewGeneration` —
  verbatim.
- `buildAddTerrainSetDialog()` (260-343) — verbatim except its calls into
  `commitAddTerrainSet`/`commitApplyLayoutPreset`/`createTile`/`commitAssignSlot`
  become `createTerrainSet`/`applyTerrainLayoutPreset`/`createTile` (already
  migrated, 3a)/`assignTerrainSlot`, all called via
  `getEditorHost().registries.commands.execute(id, ctx, args)` — this file
  becomes a Presenter, so it never imports `application/commands/` directly
  (enforced by `tests/architecture.test.mjs`, same as every other tiles-mode
  presentation file since 3a).
- `buildTilePickerDialog()` (345-418) — verbatim, its `pick`/`clear`
  callbacks dispatch `tiles.assignTerrainSlot`/`tiles.clearTerrainSlot` by
  id instead of calling `commitAssignSlot`/`commitClearSlot` directly.
- `renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog)` (421-590) —
  verbatim, its `commitRenameTerrainSet`/`commitSetTerrainSetLayer`/`commitDeleteTerrainSet`/`commitSetSymmetry`
  calls (reached via the field helpers above) become dispatches.

**`contributions.js`**: 8 new commands registered in `registerTileCommands`
(`tiles.createTerrainSet`, `tiles.deleteTerrainSet`, `tiles.renameTerrainSet`,
`tiles.assignTerrainSlot`, `tiles.clearTerrainSlot`, `tiles.setTerrainSymmetry`,
`tiles.applyTerrainLayoutPreset`, `tiles.setTerrainSetLayer`), alongside the
existing 22 (19 from 3a + 3 from 3b).

**`presentation/tile-panel.js`**: its one import line
(`from '../terrain-set-controller.js'`, currently importing
`buildAddTerrainSetDialog, terrainSetNameField, terrainSetLayerField, terrainSetDeleteButton, syncSelectedTerrainSetFromTile`)
repoints to `from '../presentation/terrain-set-editor.js'`. No other change —
none of these functions' external signatures change.

## Global constraints (inherited from Phases 0/1/2/3a/3b, still binding)

- Command Handlers: `(services, sheetId, ...)`, resolve-by-id via local
  `find*` helpers inside `apply`/`revert` closures, never captured by
  closure across a `mutate()` boundary.
- Presenters dispatch Commands by id only
  (`getEditorHost().registries.commands.execute(id, ctx, args)`), never
  import `application/commands/` directly — enforced by
  `tests/architecture.test.mjs`.
- `application/` never touches `document`/`window`/`alert`/`confirm`/`prompt`
  — enforced by the existing banned-globals scan, extended to cover
  `terrain-set-commands.js` and `terrain-slot-snapshot.js`.
- `services.history.execute()` shares the same `CommandStack` as legacy
  global undo/redo.
- No command may capture an entity object across a `mutate()` boundary.
- Every new command's tests include explicit **redo** coverage (undo, then
  redo, then assert), not just apply+undo — per the finding from 3b's final
  whole-branch review, which had to add this after the fact.

## Testing

New `tests/terrain-set-commands.test.mjs`, same fixture style as
`tests/tile-sheet-commands.test.mjs`/`tests/autotile-paint-commands.test.mjs`
(`makeServices`/`makeTile`/`makeTerrainSet`/`makeSheet`/`makeProject`),
covering all 8 commands with apply+undo+redo, plus a dedicated test for
`assignTerrainSlot` reassigning a tile that currently belongs to a
*different* terrain set (the cross-set case `captureTerrainSlotState` exists
to handle correctly) — this is the one behavior this migration actually
changes relative to legacy (fixes the redo bug described above), so it needs
direct coverage, not just parity-with-legacy.

Existing `tests/autotile-paint-commands.test.mjs`'s 11 tests (6 original + 5
redo tests added in 3b's final-review fix-up) must keep passing unchanged
after `resolveAutotilePaintConflict`'s internal refactor.

No direct unit tests for `terrain-set-geometry.js` or
`terrain-slot-snapshot.js`, matching 3a/3b's precedent for pure
geometry/helper modules — coverage comes from the command tests. A non-drag
Playwright smoke check (per [[no-drag-smoke-tests]]) covers the editor UI at
the end of the implementation plan: add a terrain set (with and without a
layout preset), assign/clear a slot via the tile-picker dialog, delete a
terrain set, toggle flip/rotate symmetry.

## Out of scope for this sub-phase

- `js/ui/tools.js` and the raw pixel-patch commit idiom it and
  `importPresetArtOntoLayer` both use — shared cross-mode infrastructure,
  out of scope for the whole Phase 1-3 migration series.
- `core/terrainsets.js`, `core/blob47.js`, `core/blob47templates.js` —
  already correctly placed, pure Domain-level code.
- `js/ui/tileeditor.js` absorption — deferred to Phase 3d.
