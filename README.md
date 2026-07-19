# PixelArtist

Browser-based pixel-art editor for packed sprite sheets and tile sheets.
Frames + animations (timeline, onion skin), tiles with live neighbor preview,
layers, indexed/system palettes. No dependencies, no build step.

## Run

ES modules require a static server (file:// will not work):

    ./serve.ps1          # or: python -m http.server 8080

Open http://localhost:8080 in Chrome/Edge (full file-system support) or any
modern browser (packed .pixelproj download/upload fallback).

## Shortcuts

All shortcuts are ignored while focus is in a text field/checkbox or a
dialog is open (so typing a layer name or a frame's X/Y never triggers a
tool switch).

**Tools**

| Key | Tool |
| --- | --- |
| `B` | Pencil |
| `E` | Eraser |
| `G` | Fill (bucket) |
| `L` | Line |
| `U` | Rectangle |
| `O` | Ellipse |
| `I` | Eyedropper |
| `M` | Select (marquee) — selection only: drag inside moves the rectangle, drag a corner/edge handle resizes it (8 handles); CAD-style dimension lines (arrowed, with value pills) show W×H, origin, and Δ while dragging |
| `V` | Move (✋) — cuts the selection (or whole layer if none) into a floating selection with move/scale/rotate handles; hold `Alt` at drag start to float all layers. On the sheet with no marquee, grabbing a frame or strip segment starts a translate-only frame-float instead (frame chrome, no handles/rotation; all layers): committing moves the frame rects together with the pixels. Nothing is rendered to the image until committed |
| `F` | Frame tool (sprite mode only) |
| `T` | Tile tool (tile mode only) |

**Editing**

| Key | Action |
| --- | --- |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo |
| `Ctrl+S` | Save (same target as the Save button; opens Save As if the project has no file/folder yet) |
| `[` / `]` | Decrease / increase brush size (pencil & eraser, clamped 1-8) |
| `X` | Swap primary and secondary colors |
| `Delete` | Delete the selected frame (frame tool, sprite mode) |
| `Enter` | Commit the floating selection (render it to the layer(s)); switching tools/sheets/views also commits |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut / copy the marquee selection to the internal clipboard / paste as a new floating selection (`+Alt`: all layers merged). Cut/copy also mirror a flattened PNG to the OS clipboard (paste into Word, an image editor, etc). If the internal clipboard is empty, `Ctrl+V` instead pastes an image from the OS clipboard (e.g. copied in Windows Photos/Snipping Tool) as a new floating selection on the active layer |
| `Escape` | Clear the active marquee selection, or cancel a pending floating selection (restores the cut-out pixels); back out of the frame editor or tile editor to the sheet view |

**Canvas navigation**

| Input | Action |
| --- | --- |
| Mouse wheel | Zoom in/out, centered on the cursor. Stepped table (not continuous multiply): `0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64` — wheel always moves one table entry at a time, so it never sticks between two adjacent levels. |
| `Space` + drag, or middle-mouse drag | Pan (the transparency checkerboard scrolls with the content, it isn't fixed to the viewport) |

## Floating selections

The move tool never edits pixels directly. Dragging cuts the selection (or
the whole layer) into a floating selection — outlined with scale handles and
a rotation knob — that hovers over the image. Move, scale, and rotate it
freely (always resampled nearest-neighbor from the original pixels), then
commit with `Enter` (or by switching tool/sheet/view) or cancel with
`Escape`. Every step (float, each transform, commit/cancel, cut, paste) is
individually undoable. In the frame/tile editors, committed pixels are
clipped to the frame/tile rect.

While a float is pending, CAD-style dimension lines (arrowed, with value pills) show its origin and scaled size
(with Δ during a scale drag) and the rotation angle in degrees during a
rotate; the same labels appear on marquee drags and frame create/resize/move.

## Sheets: Import & Rename

The sheet selector row in the top bar has, besides "+" (New Sheet…):

- **Import…** — creates a new sheet from a PNG image file. The sheet takes
  the file's name (minus extension) and exact pixel dimensions (max
  4096×4096), with the image on its only layer; it lands in the active tab
  (sprite vs tile sheet) and becomes active. One undo step removes it.
- **✎ (Rename sheet)** — renames the active sheet via a dialog pre-filled
  with the current name. The name feeds the sheet selector and every
  export filename (`<name>.png`, `<name>.frames.json`, `<name>.tiles.json`).
  Empty names are rejected with an alert; renaming is a single undo step.

## New Project

File > New opens the New Project dialog (prompts to discard unsaved
changes first if the current project is dirty). It collects the values
stored as the new project's `settings` (see below): sprite sheet
width/height, tile sheet width/height, tile width/height, frame
width/height, and default animation frame duration. These become the
defaults offered by "New Sheet…" and "New strip…" afterward; each field
must be a positive integer or the dialog rejects the input with an alert
instead of silently coercing it.

## File format

Projects save in one of two layouts, both built from the same
`project.json` + per-layer PNGs:

- **Unpacked folder** (File System Access API, Chrome/Edge only): a
  directory containing
  - `project.json` — sheets, frames, animations, tile metadata, palettes
  - `images/<sheetId>/<layerId>.png` — one PNG per layer, flattened in
    z-order per sheet
- **Packed file** (`.pixelproj`, works everywhere via download/upload): a
  ZIP archive containing the exact same `project.json` +
  `images/<sheetId>/<layerId>.png` entries as the unpacked folder.

`project.json`'s `version` field is checked on load; a mismatched or
corrupt file produces a clear error (e.g. `invalid project: unsupported
version 99 (expected 2)`) shown to the user rather than failing silently.
The current format is **version 2**, which additionally requires a
`settings` object with 9 numeric keys (validated on load — any missing
or non-numeric key is rejected the same way a version mismatch is):

- `spriteSheetW`, `spriteSheetH` — default sprite sheet dimensions
- `tileSheetW`, `tileSheetH` — default tile sheet dimensions
- `tileW`, `tileH` — default tile size
- `frameW`, `frameH` — default frame size
- `durationMs` — default animation frame duration

An animation object may carry a project-internal `strip: true` flag
marking it as an intact strip created via "New strip…" (enables the
"Break apart" action). This flag round-trips through the project.json
save/load cycle (`deserializeProject` restores it via `strip: a.strip ?? false`),
but it is not part of either exported JSON shape below — the Frames JSON
`animations[]` shape omits it and is unchanged.

An intact strip may also carry a project-internal, optional `breaks` array —
sorted indices into the animation's `frames` marking where a spatial
SEGMENT boundary falls. Segments are purely a canvas/editing concept (each
one can be moved, resized, or merged with another segment independently of
the others); playback always uses the full `frames` order regardless of
segmentation, so `breaks` has no effect on exported JSON or on how the
animation plays. Like `strip`, it round-trips through project.json but is
absent from both exported JSON shapes.

With the frame tool, the segment that contains the currently selected frame
shows its editing chrome directly on the canvas whenever it is selected:
"+" call-outs to insert a blank frame at any boundary, "✂" call-outs to
split the segment into two (adding a `breaks` entry) at any interior
boundary, and grips on both ends to grow/shrink the segment by whole
frames. Only one segment's chrome is shown at a time — the one containing
the selection — so overlapping or closely-spaced strips never have their
chrome fight for the same screen space; click a different strip's member
first to bring up its chrome instead. Dragging a segment moves every member
together, metadata-only: like dragging a selection marquee, it never moves
or clears pixels — frames are viewports onto the sheet. To move a frame or
strip WITH its content, use the move tool (`V`): grabbing it starts a
translate-only frame-float (live preview, frame-style chrome, no
scale/rotation) and committing lands pixels and frame rects together.
Dragging a segment end-to-end against another matching-size segment
snaps and merges the two (across animations if needed, deleting the source
animation if it becomes empty). Double-clicking any frame (strip
member or not) opens the frame editor on it and selects its animation in
the timeline. Once a strip is intact, its timeline cells can't be
individually removed, reordered, or padded out with an arbitrary frame
(that's what "Break apart" is for) — but durations remain editable per cell.

### Export shapes

The Export dialog also produces two engine-consumable JSON formats,
one per sheet:

**Frames JSON** (sprite sheets only) — `<sheetname>.frames.json`:

```js
{ "sheet": "<name>.png", "width": W, "height": H,
  "frames": [{ "name", "index", "x", "y", "w", "h", "pivotX", "pivotY" }],
  "animations": [{ "name", "loop", "frames": [{ "frame": "<frame name>", "duration": ms }] }] }
```

**Tiles JSON** (tile sheets only) — `<sheetname>.tiles.json`:

```js
{ "sheet": "<name>.png", "count": n,
  "tiles": [{ "index", "name": "<or null>", "x", "y", "w", "h",
    "neighbors": { "n": {"mode","tileIndex","flipH","flipV"}, ... } }] }
// only tiles with a name or stored neighbor preset are listed; tiles can
// have per-tile size (grids + standalone frames coexist on one sheet), so
// there's no sheet-wide tileWidth/tileHeight/columns. A neighbor slot's
// tileIndex is that referenced tile's position in the tiles array.
```

## Test

Requires Node 18+ (uses the built-in `node --test` runner, no dependencies):

    npm test

## License

No license is granted. All rights reserved.
