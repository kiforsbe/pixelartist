# PixelArtist

Browser-based pixel-art editor for packed sprite sheets and tile sheets.
Frames + animations (timeline, onion skin, export loop), tiles with live
neighbor preview (3×3/5×5, or 1×1 to turn it off) and drag-to-grow grids,
layers, indexed/system palettes, pixel-snapping PNG import, and
platform-targeted export (GBA, NES, SNES, Game Boy, Game Boy Color,
Commodore 64, generic C header, GIF, Tiled TSX). No dependencies, no
build step.

![Frame editor with layers, frames, and animation timeline](assets/screenshots/frame-editor.png)

## Run

ES modules require a static server (file:// will not work):

    ./serve.ps1          # or: python -m http.server 8080

Open http://localhost:8080 in Chrome/Edge (full file-system support) or any
modern browser (packed .pixelproj download/upload fallback).

## Menu bar

File, Document, Layer, Edit, View, and Help menus sit above the sheet
selector. Every menu item, toolbar button, and keyboard shortcut is a view
over the same action registry, so they never drift out of sync with each
other.

- **File** — New, Open, Save, Save As…, Export Project… (whole project as
  one ZIP or, in Chrome/Edge, straight into a chosen folder — per-sheet
  format selectable)
- **Document** — New Sheet, Import Sheet from Image, Rename Sheet, Delete
  Sheet, Export Sheet (submenu, active sheet), Export Selected Animation
  (submenu, sprite sheets only)
- **Layer** — Add Layer, Add Group, Delete Layer, Merge Down
- **Edit** — Undo, Redo, Cut, Copy, Paste, Project Settings…
- **View** — Show Labels, Show Sequences, Zoom In, Zoom Out, Actual Size
  (100%), Zoom to Fit
- **Help** — Keyboard Shortcuts, About PixelArtist

The top bar still carries its own New/Import/Rename/Delete sheet icon
buttons (wired to the same Document actions) alongside the Sprite Sheets /
Tile Sheets mode tabs.

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

**Resize & scale modifiers**

Frame/tile resize, the selection marquee, and floating-selection scale all
route through the same resize logic:

- `Alt` (held at drag start) resizes from the center instead of the
  opposite corner/edge.
- `Shift` toggles aspect lock. Frame and tile resize only expose corner
  handles, which default to *locked* aspect — so `Shift` there means
  *free* (independent W/H). The marquee and floating-selection scale also
  expose edge handles (N/S/E/W), which default to *free* aspect — so
  `Shift` on an edge handle means *locked* instead.

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

## Sheets: Import, Rename & Delete

The sheet selector row in the top bar has, besides "+" (New Sheet…):

- **Import…** — creates a new sheet from a PNG image file. The sheet takes
  the file's name (minus extension) and exact pixel dimensions (max
  4096×4096), with the image on its only layer; it lands in the active tab
  (sprite vs tile sheet) and becomes active. One undo step removes it. If
  Pixel Snapper is enabled (see below), the image is snapped before it's
  placed on the layer.
- **✎ (Rename sheet)** — renames the active sheet via a dialog pre-filled
  with the current name. The name feeds the sheet selector and every
  export filename (`<name>.png`, `<name>.frames.json`, `<name>.tiles.json`).
  Empty names are rejected with an alert; renaming is a single undo step.
- **🗑 (Delete sheet)** — removes the active sheet and everything on it
  (layers, frames, animations and, for tile sheets, tiles/terrain sets)
  after a confirm prompt. Also reachable from the Document menu.

## Tile grids

A tile grid (a run of same-size tiles arranged in a rectangle) is created
and resized purely by dragging — there's no "Add Grid" dialog. Selecting a
standalone tile or an existing grid shows 4 short grip strips, one near
the middle of each edge:

- Dragging a grip **outward** on a standalone tile turns it into a new
  grid and grows it by however many whole tile-widths/heights the drag
  covers; dragging outward on an existing grid grows that same axis.
- Dragging a grip **inward** shrinks that axis; shrinking a grid down to
  1×1 collapses it back into a single standalone tile.
- Dragging a grid tile's body (not a grip) always moves the whole grid,
  clamped to the sheet bounds — it never swaps or moves an individual
  tile's content.

## Pixel snapping

Pixel Snapper is a one-shot, import-time conversion, not a live filter: it
runs automatically on Document > Import Sheet from Image and on pasting an
image from the OS clipboard, snapping a hand-drawn or photo-resolution
image down to one pixel per detected cell (k-means color quantization,
then per-axis grid detection and an elastic-walker snap). Configure it in
Project Settings > Import:

- **Pixel snapper** — enable/disable checkbox
- **Palette** — snap into a specific project palette, "(none — full RGB)",
  or the active palette
- **Colors (k)** — quantization budget (default 256)
- **Pixel size** — leave blank to auto-detect the cell size, or force an
  exact size
- **Advanced** (collapsible) — 9 tuning fields (max iterations, peak
  threshold/distance, search window ratio/minimum, strength threshold, min
  cuts per axis, fallback segments, max step ratio), each individually
  resettable to its default

## New Project

File > New opens the New Project dialog (prompts to discard unsaved
changes first if the current project is dirty). It collects the values
stored as the new project's `settings` (see below): sprite sheet
width/height, tile sheet width/height, tile width/height, frame
width/height, and default animation frame duration. These become the
defaults offered by "New Sheet…" and "New strip…" afterward; each field
must be a positive integer or the dialog rejects the input with an alert
instead of silently coercing it.

New Project only sets these; everything else (target platform, pixel
snapper, onion colors, smooth thumbnails) takes its default and is changed
afterward via Edit > Project Settings…, tabbed into General / Import /
Onion Steps.

## Animation panel, onion skin & preview

Below the Frames panel, the **Animation panel** edits the selected
animation: a Name field, a Loop checkbox (whether the *exported* animation
loops — independent of the timeline's own playback-only loop toggle), and
the shared ms/fps base-duration control (toggle between an "ms/frame"
field and an "fps" + "step" pair, e.g. "animate on every 2nd frame at
30fps").

The timeline dock has a drag handle to resize its height (100–400px,
persisted per browser); thumbnail size scales with it. Clicking a cell
scrubs the playhead, selects that frame app-wide, and opens the Frame
Editor on it in one click.

**Onion skin** controls live in the Frame Editor's own toolbar: an enable
checkbox, an opacity slider for the current frame, independent Mask and
Outline toggles, and a Back/Ahead group each with a frame-count (0–8), a
color swatch, and separate mask-/outline-opacity sliders. A ⚙ button opens
Project Settings > Onion Steps for per-distance (1–8 frames back/ahead)
color overrides.

A separate **Preview panel** below the Animation panel mirrors the frame
or tile currently being edited (or the timeline's live playhead frame
while an animation is selected), with its own zoom bar, mouse-wheel zoom,
and drag-to-pan.

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

## Export

**Document > Export Sheet** exports the active sheet as one of: Sheet PNG
(flattened), Frames JSON (sprite sheets), Tiles JSON (tile sheets), Tiled
TSX (tile sheets — terrain-set autotiling data for the Tiled map editor),
or a native binary target: Game Boy Advance, NES, SNES, Game Boy, Game Boy
Color, Commodore 64, or a generic C header.

**Document > Export Selected Animation** (sprite sheets, when an animation
is selected) exports GIF, Spritesheet (PNG + JSON), or Image Sequence
(zipped PNG frames).

**File > Export Project…** exports every sheet in the project at once:
pick a format per sheet, then a destination — a single ZIP download, or
(Chrome/Edge only) write straight into a chosen folder.

### Target-platform compatibility

Project Settings > General > Compatibility sets a **Target platform**
(None, Generic, Game Boy Advance, NES, SNES, Commodore 64, Game Boy, Game
Boy Color, Retro 8/16/32-bit) and an **Export colors** mode (restrict
per-sprite/tile to the hardware limit, or use the full system palette
still capped per sprite/tile). With a platform set, the status bar shows a
live ✓/⚠ compatibility indicator — hover for details, e.g. "Uses 6 colors;
NES allows at most 4 per sprite/tile." — while a frame or tile is open in
its own editor. Exporting to a native binary target re-checks
compatibility and asks for confirmation if there are warnings, or blocks
outright on hard errors.

### Export shapes

Frames JSON and Tiles JSON are the two engine-consumable JSON formats also
reachable via Export Sheet, one per sheet:

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
