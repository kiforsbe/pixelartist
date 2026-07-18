# Autotile Panel Cleanup — Design

**Goal:** Simplify the Tiles and Autotiles panels down to selection-driven detail views (matching the Frames panel's pattern), fix confusing/dead UI, and add clearer signaling for slots/tiles that don't strictly need to exist.

**Context:** Since the Phase B autotile UX rework (`2026-07-17-autotile-panel-ux-design.md`) and the subsequent duplicate-tile-tracking work, the Tiles and Autotiles panels have accumulated UI that either isn't needed yet (layout-preset import row, grid cols/rows list) or was never clearly explained (the terrain-set layer dropdown). This pass cleans that up based on ten numbered items from the user, clarified through Q&A.

## Data model changes

None. `terrainSet.layer`, `tile.layer`, `tile.duplicateOf`, `tile.gridId` all already exist and already round-trip through save/load and Tiles JSON export. This is a UI-and-wiring-only pass, plus one new cross-cutting deletion rule.

## 1. Remove the layout-preset row

`renderLayoutPresetRow` (preset select, grid select, ⬇ import, 💾 save-as-preset) is deleted from `renderTerrainSetEditor`. Not needed for now — presets are still applied at terrain-set *creation* time via the Add Terrain Set dialog; only the "apply a preset onto an existing grid" path goes away.

## 2. Optional-but-assigned indicator

Today, `classifySlots` already marks each blobIndex mandatory or optional (derivable via flip/rotation symmetry), and `.terrain-slot.optional` gets a dashed border. The gap: a slot can be *optional* and still have an *explicit* tile assigned (`terrainSet.slots[blobIndex] != null`, i.e. `isExplicit`) — meaning the user (or a layout preset) manually gave it art, but the app would happily derive the same visual via flip/rotate if that explicit tile were removed.

New treatment, visually distinct from the existing duplicate-tile marker (orange) to avoid conflating "does nothing at all" with "works fine, just not required":
- Terrain-slot grid (`renderTerrainSetEditor`): when `classInfo.mandatory === false && isExplicit === true`, add a `.terrain-slot.removable` class — muted blue/grey dashed outline + a small badge (e.g. `✓opt`), title text explains it's safe to clear.
- Tile sheet overlay (`js/ui/overlays.js`): an outline alone is too easy to miss here (unlike the small terrain-slot cells, sheet tiles are surrounded by other outlined tiles already). Instead, a tile with `t.terrainSetId != null` whose slot (`classifySlots(terrainSet.symmetry).get(t.blobIndex)`) is non-mandatory gets a translucent color wash filled across the *whole* tile (a semi-transparent muted blue/grey rectangle, distinct from the duplicate marker's orange), not just its border, plus its label chip. Covers the full cell so it reads at a glance even at small zoom levels, without obscuring the art underneath (low alpha).

## 3 & 10. Tiles panel — selection-driven, like Frames

Rip out the always-visible `gridList` (cols/rows/W/H per grid) and the unconditional tile count. Mirror `mountFramesPanel`'s shape:
- A button row for creation: "Add grid…" (existing dialog) and "Add terrain set…" (dialog *moved here* from the Autotiles panel — same dialog, just relocated trigger).
- Below that, detail for `state.selectedTileId` only. Nothing selected → a hint, same as today.
- Selected tile detail: name, Edit tile, tags — unchanged.
  - If `tile.gridId != null`: show the **owning grid's** W/H (`grid.cellW`/`cellH`, edits via existing `commitGridCellField`, resizes every cell in that grid) and a Delete-grid button, alongside the existing Detach-from-grid button. No cols/rows fields — grid dimensions are fixed at creation for now.
  - If standalone: show the tile's own W/H (existing `commitTileSize` behavior, unchanged).
- Layer dropdown (see item 6 below) replaces the plain per-tile-only one.
- No separate "select a grid" gesture — selecting any tile inside a grid is how you see/edit that grid's info (confirmed via Q&A).

## 4. Implicit terrain-set deletion

Trigger: only on **grid deletion** (`commitDeleteGrid`/`removeTileGrid`), not individual tile deletion. After a grid and its tiles are removed, for each terrain set check whether any tile in `sheet.tiles` still has `terrainSetId === ts.id`; if none do, delete that terrain set too (reuses `removeTerrainSet`).

## 5. Icon toggle buttons

"Allow flip"/"Allow rotation" checkboxes-with-text become `<button type="button">` toggles showing an icon (↔ for flip, ↻ for rotation), with a pressed/active visual state (`aria-pressed`, CSS `[aria-pressed="true"]`) instead of a native checkbox. Same `commitSetSymmetry` wiring underneath.

## 6 & 9. Layer dropdown relocation

`terrainSet.layer` is a single value shared by every tile in that terrain set (confirmed intent, and already how it's exported in Tiles JSON as `terrainSets[].layer`, distinct from each tile's own `layer`). Resolution:
- Remove the dropdown from the Autotiles panel's symmetry row entirely.
- In the Tiles panel's selected-tile detail: **one** layer dropdown, but its target depends on the tile —
  - `tile.terrainSetId != null` → bound to `terrainSet.layer` / `commitSetTerrainSetLayer` (looked up via the tile's terrain set). Editing it from any member tile changes it for the whole set, since they all read the same field.
  - otherwise → bound to `tile.layer` / `commitTileLayer`, unchanged from today.
- New **Tile Layers** panel (`mountTileLayersPanel`, new function): a third stacked section in the same sidebar, below Autotiles. Contains exactly what's currently at the bottom of the Autotiles panel — the `sheet.layers` name list with ➕ add / ↑↓ reorder / 🗑 delete — moved verbatim, just re-mounted into its own section.

## 7. Default view mode from creation preset

`terrainViewMode` is currently a single module-level variable shared by *every* terrain set, always starting at `'staircase'`. That's actually two bugs: it never defaults to the preset that created it, and switching between two terrain sets leaks one's view-mode choice into the other. Fix both: replace the single variable with a `Map<terrainSetId, viewMode>` (module-level, transient — not persisted/exported, purely a UI nicety). When a terrain set is created from a built-in preset in the Add Terrain Set dialog, seed its entry with the matching mode (`'grid7x7'` for the 7×7 preset, `'grid8x6'` for 8×6, `'staircase'` otherwise). `renderTerrainSetEditor` reads/writes through this map keyed by `terrainSet.id` instead of a bare variable, falling back to `'staircase'` for terrain sets with no entry (e.g. ones created before this change, or via "(none — add tiles manually)").

**Note:** while implementing this, also fix the pre-existing `grid6x8`/"Grid 6×8" identifier and label to `grid8x6`/"Grid 8×6" — the layout is 8 columns × 6 rows (matches `BLOB47_8X6_RAW` and the correctly-named `blob47-8x6-reference.png` asset); only this view-mode id/label had the digits transposed. *(Already fixed directly in `js/ui/tilemode.js` and `tests/smoke.md`, ahead of this plan, since it was an isolated pre-existing bug unrelated to today's redesign.)*

## 8. Remove "View" label

Drop the `<label>View </label>` text node; keep just the `<select>` with its options, no leading label text.

## Testing

- Pure logic (implicit terrain-set deletion, view-mode default selection, optional-but-explicit classification reuse of existing `classifySlots`) gets `node --test` coverage in `js/core` where the logic lives.
- UI wiring (`js/ui/*`) stays manually/Playwright-verified per this codebase's existing convention (UI modules are excluded from the automated suite).
