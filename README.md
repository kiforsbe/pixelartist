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
| `M` | Select (marquee) |
| `V` | Move (✋) — shifts the marquee selection if one is active, otherwise the whole active layer; check "All layers" in the tool options row to move every layer together |
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
| `Escape` | Clear the active marquee selection; back out of the frame editor or tile editor to the sheet view |

**Canvas navigation**

| Input | Action |
| --- | --- |
| Mouse wheel | Zoom in/out, centered on the cursor. Stepped table (not continuous multiply): `0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64` — wheel always moves one table entry at a time, so it never sticks between two adjacent levels. |
| `Space` + drag, or middle-mouse drag | Pan (the transparency checkerboard scrolls with the content, it isn't fixed to the viewport) |

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
{ "sheet": "<name>.png", "tileWidth": tw, "tileHeight": th, "columns": c, "count": n,
  "tiles": [{ "index", "name": "<or null>", "neighbors": { "n": {"mode","tileIndex","flipH","flipV"}, ... } }] }
// only tiles with a name or stored neighbor preset are listed
```

## Test

    npm test
