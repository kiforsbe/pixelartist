# PixelArtist v2 — Project Settings, Multi-Sheet, Animation Strips, View Fixes — Design

Date: 2026-07-13
Status: Approved by user (brainstorming session)
Builds on: docs/superpowers/specs/2026-07-12-pixelartist-design.md (v1, shipped)

## Scope

Five user-requested improvements to the shipped v1 app:

1. New Project dialog with project-level defaults.
2. Multi-sheet management: sheet selector per mode + create new sheets.
3. Animation strips as the default sprite workflow.
4. View fixes: zoom stepping (¼x–64x) and checkerboard anchored to image origin.
5. Live layer thumbnails in the layers panel.

## 1. New Project dialog & project settings

- The "New" button opens a **New Project dialog** instead of instantly creating
  the demo project: fields for sprite sheet width/height, tile sheet
  width/height, tile width/height, **default frame size** (w/h), and **default
  frame duration** (ms). Sensible initial values (256×256 sheets, 16×16 tiles,
  16×16 frames, 100 ms).
- Values persist as `project.settings = { spriteSheetW, spriteSheetH,
  tileSheetW, tileSheetH, tileW, tileH, frameW, frameH, durationMs }` in
  `project.json`.
- **Backward compatible**: all fields optional; `PROJECT_VERSION` stays 1;
  loading a v1 project without `settings` falls back to built-in defaults.
- Dimension inputs validated against the existing 1..4096 sheet limit.
- Creating the project produces one sprite sheet and one tile sheet at the
  chosen sizes (dirty-discard confirm unchanged).

## 2. Multi-sheet management

- **Sheet selector**: a `<select>` in the top bar listing all sheets of the
  current mode's kind (sprite sheets in Sprites mode, tile sheets in Tiles
  mode), bound to `state.activeSheetId`. Switching resets `activeLayerId` to
  the sheet's first layer and returns to the sheet view.
- **"+ New sheet" button** beside the selector → dialog: name, width, height
  (defaults from `project.settings`), plus tile width/height for tile sheets.
  Creating a sheet is one undoable command (undo removes it and reselects the
  previously active sheet).
- Sheets remain separate image files inside the project bundle
  (`images/<sheetId>/<layerId>.png`), as in v1.

## 3. Animation strips

- **"New animation strip…" button** in the frames panel (sprite mode):
  dialog with name, frame width/height (defaults from settings), frame count
  (≥1), per-frame duration (default from settings).
- Creates, as **one undoable command**: N frames named `<name>_0 … <name>_N-1`
  laid out left-to-right contiguously in a row, plus an animation containing
  them in order with the given duration, flagged `strip: true` (intact).
- **Auto-placement**: scan the sheet top-to-bottom, left-to-right for the
  first free rectangle (no overlap with existing frames) that fits the whole
  row (`count*frameW × frameH`); if none fits, alert "no free space on sheet"
  and create nothing.
- **Intact strip = moves as one unit**: dragging any member frame with the
  frame tool moves ALL frames of that animation together — pixels carried on
  all layers, relative offsets preserved, clamped to sheet bounds, one undo
  step. Resize handles are disabled on intact-strip frames.
- **Break apart**: a button visible when the selected frame belongs to an
  intact strip (frames panel) and in the timeline header when the selected
  animation is an intact strip. Sets `strip: false` (undoable). Frames then
  move individually; animation membership is unaffected.
- Manually built animations (timeline "New" + add frames) get `strip: false`
  and behave exactly as in v1.
- `strip` serializes with the animation; absent = false on load (backward
  compatible).

## 4. View fixes

- **Zoom stepping**: replace multiply-by-2^±0.25-then-snap (which rounds back
  to the same entry at low zooms, making 1x/2x sticky) with direct index
  stepping through the zoom table. New table:
  `[0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]`.
  One wheel notch = one table step; cursor-anchored panning math unchanged.
  `centerFit()` snaps its computed fit zoom to the nearest table entry ≤ fit
  (min 0.25). Fractional zooms keep nearest-neighbor rendering. Applies to all
  three CanvasView instances automatically.
- **Checkerboard anchored to image origin**: the checker pattern's phase is
  locked to image (0,0) — a square corner always coincides with the sheet's
  top-left and the pattern follows content when panning. Squares stay 8
  screen pixels.

## 5. Layer thumbnails

- Each layers-panel row gains a small live thumbnail (~40 px box,
  nearest-neighbor, aspect-fit, checker or dark background) of that layer's
  own bitmap.
- Refreshed via the panel's existing re-render events ('project', 'history',
  'view') plus 'pixels' (stroke commits/preview), coalesced with the panel's
  microtask guard so drags don't thrash.

## Error handling

- New Project / New Sheet dialogs clamp dimensions to 1..4096 and refuse
  non-numeric input (reuse core validation; alert on failure).
- Strip creation with no free space: alert, no partial state.
- Loading old projects: missing `settings`/`strip` fields default cleanly.

## Testing

- Node tests (extending the 45-test suite): settings serialization round-trip
  (with and without settings present), strip placement scan (free-space finder
  incl. no-space case), strip creation command shape (frames + animation +
  flag), whole-strip move geometry (pure helper), zoom table stepping helper
  (up/down from every entry, clamped ends), checkerboard phase helper if
  extracted.
- Browser verification via Playwright (?autotest) per the established smoke
  pattern; tests/smoke.md extended with strip workflow, sheet selector, zoom
  range, layer thumbnails.

## Explicitly out of scope (unchanged from v1 deferred list)

- Sheet delete/rename UI, palette JSON import/export, swatch remove/reorder
  UI (v1 review follow-ups, not part of this round).
- Level/world maps, true indexed pixel storage, lasso/wand, terrain rules.
