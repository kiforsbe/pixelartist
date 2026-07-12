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

A project is a **bundle of files**: a `project.json` metadata file plus one PNG
file per layer, referenced by relative path. The bundle can be stored two ways:

- **Unpacked**: a project directory on disk (opened via a File System Access
  API directory handle). Layer PNGs sit next to `project.json` — friendly to
  git and external image tools.
- **Packed**: a single `.pixelproj` file, which is a ZIP archive of the same
  structure. Read/written with zero dependencies using the browser-native
  `CompressionStream`/`DecompressionStream` APIs (entries stored or
  deflate-compressed).

Both forms are first-class: open either, save-as either. `project.json` carries
a `version` field, validated on load.

Metadata contents:

- **sheets** — named images with a **layer stack**. Each layer references its
  PNG file and stores `visible` and `opacity`. A sheet is either a sprite
  sheet (has `frames` + `animations`) or a tile sheet (has tile grid config +
  neighbor presets).
- **frames** (sprite sheets) — named rectangles `{x, y, w, h}` with a pivot
  point.
- **animations** (sprite sheets) — named, ordered lists of frame references,
  each with a per-frame duration in ms, plus a loop flag.
- **tile config** (tile sheets) — `tileWidth`/`tileHeight`; tiles are grid cells
  addressed by index. Each tile may store a **neighbor preset**: 8 slots (N, NE,
  E, SE, S, SW, W, NW), each configured as *same tile*, *another tile* (by
  index), or *empty*, with independent flip-H / flip-V flags.
- **palettes** — named palettes, either **non-indexed** (free RGBA, 16/32-bit
  color) or **indexed** with a defined entry count (see Palettes section).

Persistence:

- Open/save via the **File System Access API** (Chrome/Edge): directory handle
  for unpacked projects, file handle for packed ones. Other browsers fall back
  to packed-only via download/upload.
- **Autosave** snapshot to IndexedDB for crash recovery.
- **Exports**: flattened sheet PNG; frames/animations JSON; tile sheet JSON
  (grid config + neighbor presets).
- Unsaved-changes warning (`beforeunload`).

## Pixel editing core

- **Tools**: pencil (brush sizes), eraser, flood fill (contiguous + global
  option), line, rectangle, ellipse (outline/filled), eyedropper, rectangular
  select + move, pan/zoom.
- **Color**: primary color on left-click, secondary on right-click; RGBA picker;
  palette panel with add/remove/reorder swatches (see Palettes section for
  indexed-mode behavior).
- **Layers** (per sheet): add/delete/reorder/rename, visibility toggle, opacity,
  merge down. Drawing targets the active layer. Export flattens.
- **Undo/redo**: single global command stack (Ctrl+Z / Ctrl+Y). Pixel edits are
  recorded as before/after image patches of the dirty rectangle on the affected
  layer; structural edits (add/move frame, reorder layer, change neighbor
  preset, …) are discrete commands.

## Palettes

Two palette kinds, selectable per palette:

- **Non-indexed** (default): free RGBA color (standard 16/32-bit modes). The
  palette is an open-ended swatch list the user grows as they work.
- **Indexed**: a fixed number of entries chosen at creation (presets for
  common depths: 2, 4, 16, 256 entries; custom counts allowed). While an
  indexed palette is active, the color picker is restricted to its entries —
  drawing can only use palette colors. Editing an entry's color offers an
  optional "remap existing pixels" pass that recolors matching pixels on the
  active sheet (palette-swap workflow). Pixels are stored as RGBA in the PNGs;
  true per-pixel index storage is deferred (see below).

**Built-in system palettes** shipped as read-only presets that can be cloned:
Game Boy (4), NES (54), Commodore 64 (16), CGA (16), EGA (16/64), ZX Spectrum
(15), PICO-8 (16), MSX (15), Apple II (15), Atari 2600 NTSC (128). Palettes are
importable/exportable as JSON.

## Overlays

Toggleable overlays rendered on top of the sheet canvas in both modes:

- **Sprite sheets**: each frame rect labeled with its name and index; frames
  belonging to an animation additionally badge the animation name and the
  frame's sequence position (e.g. `walk 3/8`), so animation ordering is
  readable directly on the packed sheet.
- **Tile sheets**: each grid cell labeled with its tile index (and name, if
  the tile has been named).
- Overlay toggles live in the top bar (labels on/off, sequence badges on/off);
  labels scale readably with zoom and are never baked into exports.

## Sprite sheet mode

- Drag to create frame rectangles anywhere on the sheet; move/resize with
  handles; optional snap-to-grid.
- **Slice by grid** dialog (cell size, margin, spacing) for bulk frame creation.
- Frames are **movable within the sheet carrying their pixels** (repacking):
  the move-frame tool relocates both the rectangle and its pixel content (on
  all layers), recorded as one undoable command.
- Animation panel: create/rename animations; each animation is an ordered list
  of frames with per-frame durations.
- **Timeline**: animations are edited in a horizontal timeline strip — one cell
  per frame showing its thumbnail and duration, with drag-to-reorder,
  insert/remove, and per-frame duration editing in place. A playhead tracks
  playback.
- **Preview player**: play/pause/loop with speed control, rendering the
  animation at actual frame timings; scrubbing the timeline playhead previews
  any point in the sequence.
- Frames are allocated to animations from the sheet (add selected frame to
  animation) and can be freely reordered on the timeline; independently,
  frames can be repositioned on the sprite map itself via the pixel-carrying
  move described above.
- **Frame editor with onion skinning**: double-clicking a frame (on the sheet
  or the timeline) opens a focused per-frame view — the frame at high zoom
  with all pixel tools active, editing the underlying sheet pixels in place.
  When the frame belongs to an animation, an **onion skin mode** ghosts the
  previous and future frames of that animation over the canvas, aligned by
  frame rect (pivot-aware), tinted (e.g. red = past, green = future) and faded
  with distance. The number of frames shown back and ahead is configurable
  (0–N each, default 1/1). Onion skins are pure overlay — never drawn into
  the sheet. Timeline navigation (prev/next frame) works inside this view for
  a draw-flip-draw workflow.

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
  (`node --test`): data model round-trip, ZIP pack/unpack round-trip,
  command/undo stack, flood fill, grid slicing, frame move (pixel-carrying),
  tile swap, neighbor presets, indexed-palette remap, animation timing.
- UI verified with Playwright smoke checks and manual passes.

## Explicitly deferred (not v1)

- Level/world map editor (external tool handles this).
- True per-pixel indexed color storage (pixels stored as palette indices with
  live palette remapping); v1 approximates this with indexed-palette
  constrained drawing + explicit remap.
- Tile auto-terrain rules.
- Exporters for Aseprite/Tiled formats.
- Selection tools beyond rectangle (lasso, magic wand).
