# PixelArtist v3 — Import Sheet, Move Tool, Rename Sheet — Design

Date: 2026-07-13
Status: Approved by user (brainstorming session)
Builds on: v1 (2026-07-12) and v2 (2026-07-13) specs, both shipped.

## Scope

1. Import a new sheet from an existing image file.
2. A move tool for shifting pixel content (selection or whole layer, one or
   all layers).
3. Rename sheets.

## 1. Import sheet from image

- **"Import…" button** in the top bar next to "+ New sheet".
- File picker: File System Access `showOpenFilePicker` (accept `image/png`
  by default, plus other browser-decodable image types), `<input type=file>`
  fallback; cancel-safe (AbortError / Error('cancelled') swallowed).
- Decoding reuses the existing `decodePng` (createImageBitmap-based — handles
  PNG and other common formats transparently).
- Result: a **new sheet of the current mode's kind** —
  - name = filename without extension (deduplicated is NOT required),
  - width/height = image dimensions; if either exceeds 4096, alert and abort
    (no partial state),
  - Layer 1's bitmap = the decoded image,
  - tile sheets take `project.settings.tileW/tileH`.
- Creation is **one undoable command** (same shape as the New Sheet command:
  undo removes the sheet and restores the previous selection); the imported
  sheet becomes active. Marks the project dirty.
- Decode failure (corrupt/unsupported file): alert with the error message,
  no state change.

## 2. Move tool

- New tool `{id: 'move', icon: '✋', key: 'v'}` in the tool palette, available
  in both modes (it edits the active sheet like the other drawing tools).
- **Region**: the active marquee selection's rect if one exists, else the
  whole layer (0, 0, sheetW, sheetH).
- **Scope**: the active layer by default; an **"All layers"** checkbox in the
  tool options row applies the same move to every layer of the sheet.
- Drag behavior: live preview while dragging (restore-before + blit-at-offset
  each move, like the existing select-move); on release, ONE undoable command
  with per-layer union-rect before/after patches (byte-exact undo).
- Pixels moved outside the sheet bounds are cropped (lost, restorable via
  undo). The vacated area becomes transparent.
- If a selection existed, the selection rect follows the moved content
  (clamped to the sheet).
- Zero-delta drags commit nothing.
- The move tool respects `bindDrawing`'s target-rect/mapPoint contract so it
  behaves correctly inside the frame editor and tile editor (region clipped
  to the focused frame/tile like other tools).

## 3. Rename sheet

- **✎ button** next to the sheet selector → small centered dialog
  (`#dlg-renamesheet`) pre-filled with the active sheet's name; OK/Cancel.
- Rename is an undoable command (old name / new name). Empty or
  whitespace-only names are rejected with an alert.
- The sheet selector, panels, and export filenames pick up the new name
  automatically (they read live `sheet.name`).

## Error handling

- Import: oversized image → alert, abort; decode failure → alert, abort;
  picker cancel → silent.
- Rename: empty name → alert, dialog stays open.
- Move: no-ops when the layer is missing or the sheet is empty.

## Testing

- Node tests (extending the 57-test suite): a pure move-region helper
  (shift region within bitmap with cropping; vacated area cleared) if
  extracted to js/core (recommended: `js/core/moveregion.js` with
  `shiftRegion(bitmap, rect, dx, dy)` returning the union dirty rect) —
  tests for in-bounds move, edge cropping, vacated-area transparency,
  zero delta.
- Browser verification (?autotest) per the established smoke pattern;
  tests/smoke.md extended: import (via DataTransfer/fallback input or module
  call), move tool selection/layer/all-layers + undo, rename + undo.

## Out of scope

- Importing INTO an existing sheet/layer (only new-sheet import).
- Sheet deletion (still not offered).
- Move tool rotation/scaling.
