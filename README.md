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
| Mouse wheel | Zoom in/out, centered on the cursor |
| `Space` + drag, or middle-mouse drag | Pan |

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
version 99 (expected 1)`) shown to the user rather than failing silently.

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
