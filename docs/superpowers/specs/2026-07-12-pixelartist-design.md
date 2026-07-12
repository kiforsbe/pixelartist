# PixelArtist — Sprite Sheet & Tile Sheet Editor — Design

Date: 2026-07-12
Status: Approved by user (brainstorming session)

## Purpose

A browser-based (JS/HTML) pixel-art editor in the spirit of Aseprite, specialized
for **packed sheets**: sprite atlases and tile atlases. The packed sheet is always
the base artifact. Within it the user draws pixels, defines sprite frames and
animations, and defines/edits tiles with live neighbor previews. Level/tile-map
(world) editing is explicitly **out of scope** — exported atlases + JSON are
consumed by external tools.

## Platform & architecture

- **Static web app**: plain HTML/CSS/JS with vanilla ES modules. No framework,
  no build step, zero runtime dependencies.
- Requires a static file server for ES modules (`npx serve`, `python -m
  http.server`); a launcher script and README instructions are included.
- Rendering: Canvas 2D with nearest-neighbor scaling (`imageSmoothingEnabled =
  false`). No WebGL.
- Core logic (data model, commands/undo, flood fill, slicing, neighbor presets)
  lives in pure JS modules with no DOM dependency so it can be unit-tested in
  Node.

## App structure & UI

Single-page app with **two modes**, switched by tabs in the top bar:

1. **Sprite Sheets** — the packed sprite atlas is the canvas. Draw pixels
   directly on it, define frame rectangles on it, group frames into animations.
2. **Tile Sheets** — the packed tile atlas is the canvas, overlaid with its tile
   grid. Edit pixels directly on the atlas, or click a tile to open the focused
   **tile editor** with live neighbor preview.

Common layout:

- **Top bar**: mode tabs, file menu (new/open/save/export), undo/redo buttons.
- **Left**: contextual tool palette.
- **Center**: canvas with wheel zoom centered on cursor, space+drag or
  middle-drag pan, pixel grid visible at high zoom.
- **Right**: color palette + layers panel, plus mode-specific panels
  (frames/animations list, or tile inspector).
- **Bottom**: status bar (cursor position, zoom level, active tool).

## Data model & persistence

One self-contained project JSON file (e.g. `game.pixelproj`) with a `version`
field, validated on load:

- **sheets** — named images with a **layer stack**. Each layer stores its pixels
  as a base64-encoded PNG plus `visible` and `opacity`. A sheet is either a
  sprite sheet (has `frames` + `animations`) or a tile sheet (has tile grid
  config + neighbor presets).
- **frames** (sprite sheets) — named rectangles `{x, y, w, h}` with a pivot
  point.
- **animations** (sprite sheets) — named, ordered lists of frame references,
  each with a per-frame duration in ms, plus a loop flag.
- **tile config** (tile sheets) — `tileWidth`/`tileHeight`; tiles are grid cells
  addressed by index. Each tile may store a **neighbor preset**: 8 slots (N, NE,
  E, SE, S, SW, W, NW), each configured as *same tile*, *another tile* (by
  index), or *empty*, with independent flip-H / flip-V flags.
- **palettes** — named swatch lists (RGBA).

Persistence:

- Open/save via the **File System Access API** (Chrome/Edge); download/upload
  fallback for other browsers.
- **Autosave** snapshot to IndexedDB for crash recovery.
- **Exports**: flattened sheet PNG; frames/animations JSON; tile sheet JSON
  (grid config + neighbor presets).
- Unsaved-changes warning (`beforeunload`).

## Pixel editing core

- **Tools**: pencil (brush sizes), eraser, flood fill (contiguous + global
  option), line, rectangle, ellipse (outline/filled), eyedropper, rectangular
  select + move, pan/zoom.
- **Color**: primary color on left-click, secondary on right-click; RGBA picker;
  palette panel with add/remove/reorder swatches.
- **Layers** (per sheet): add/delete/reorder/rename, visibility toggle, opacity,
  merge down. Drawing targets the active layer. Export flattens.
- **Undo/redo**: single global command stack (Ctrl+Z / Ctrl+Y). Pixel edits are
  recorded as before/after image patches of the dirty rectangle on the affected
  layer; structural edits (add/move frame, reorder layer, change neighbor
  preset, …) are discrete commands.

## Sprite sheet mode

- Drag to create frame rectangles anywhere on the sheet; move/resize with
  handles; optional snap-to-grid.
- **Slice by grid** dialog (cell size, margin, spacing) for bulk frame creation.
- Frames are **movable within the sheet carrying their pixels** (repacking):
  the move-frame tool relocates both the rectangle and its pixel content (on
  all layers), recorded as one undoable command.
- Animation panel: create/rename animations, ordered frame list with per-frame
  durations, live preview player with play/pause and loop.

## Tile sheet mode

- Atlas overview with tile grid overlay; every tile addressable by index.
- Tiles can be **swapped/moved within the atlas** with their pixels (all
  layers), as one undoable command.
- **Tile editor** (the distinctive feature): the selected tile renders at
  center at high zoom with all pixel tools active. Around it, a 3×3 (optionally
  5×5) arrangement shows the 8 neighbor slots rendered live — repainting a
  pixel in the center instantly updates every "same tile" neighbor, flips
  applied. Clicking a neighbor slot opens its config: same tile / pick another
  tile / empty, plus flip-H / flip-V toggles. Default preset: all 8 = same
  tile, no flips (seamless-texture checking out of the box). Drawing affects
  only the center tile; neighbors are pure preview. Presets persist in the
  project file.

## Error handling

- Project JSON validated against `version` on load with a clear error message
  on mismatch/corruption.
- Canvas size limits enforced when creating/resizing sheets.
- Unsaved-changes guard on close.

## Testing

- Core logic in pure modules tested with Node's built-in test runner
  (`node --test`): data model round-trip, command/undo stack, flood fill,
  grid slicing, frame move (pixel-carrying), tile swap, neighbor presets.
- UI verified with Playwright smoke checks and manual passes.

## Explicitly deferred (not v1)

- Level/world map editor (external tool handles this).
- Onion skinning; tile auto-terrain rules.
- Exporters for Aseprite/Tiled formats.
- Selection tools beyond rectangle (lasso, magic wand).
