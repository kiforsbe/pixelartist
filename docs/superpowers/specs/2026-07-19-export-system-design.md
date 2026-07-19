# Export System Overhaul — Design

## Goal

Split export into two scopes — a single active sheet (Document menu) and the
whole project (File menu) — and add new per-sheet export formats: Tiled TSX
(tile sheets), animation export (GIF / spritesheet+json / image sequence,
sprite sheets), and C99 header export (generic 8bpp / GBA 4bpp / NES 2bpp
planar CHR, both sheet kinds).

## Non-goals

- WebP/APNG or any animated format beyond GIF (no hand-rollable encoder
  without a new dependency, ruled out to keep the project dependency-free).
- Tiled TSX for sprite sheets (no natural mapping from this app's
  frames/segments/pivots onto Tiled's tile-animation model).
- C99 targets beyond generic/GBA/NES in this pass (extensible later).

## Architecture

New pure, node-testable builder modules (mirroring the existing
`js/app/exports.js` pattern: no DOM, unit-tested with `node --test`,
`main.js` wraps their output in a `Blob`/download or a folder write):

- `js/core/gif.js` — GIF89a encoder. `encodeGif(frames, { loop }) -> Uint8Array`
  where `frames: [{ pixels: Uint8ClampedArray (RGBA), width, height, delayMs }]`.
  Global color table, `NETSCAPE2.0` loop extension, one Graphic Control
  Extension + Image Descriptor per frame, LZW-compressed image data.
- `js/app/tiledExport.js` — `buildTiledTsx(sheet) -> string` (XML). Tileset
  from the sheet's tile grid; `<wangsets>` built from `sheet.terrainSets`.
- `js/app/c99Export.js` — `buildC99({ items, palette, target }) -> { h, c }`
  (text). `items` is an array of `{ name, pixels, w, h }` (frames or tiles);
  `target` is `'generic8'` | `'gba4'` | `'nes2'`.
- `js/app/animationExport.js` — orchestrates GIF / spritesheet+json / image
  sequence output for one animation or all animations on a sprite sheet,
  reusing `flattenSheet` to render each frame.
- `js/app/projectExport.js` — whole-project orchestrator: for each selected
  sheet, runs the chosen per-sheet builder(s), collects `{ path, data }`
  entries, and either zips them with `js/core/zip.js:zipWrite` (download) or
  writes them via a directory-handle walk (mirrors `io.js:saveUnpacked`).

## Palette source for quantization (GIF / C99)

Both GIF and C99 need an indexed palette; sheet pixels are stored as RGBA
truecolor (`js/core/palettes.js` has no per-sheet palette assignment today).
Resolution order, reusing the existing `nearestColor` helper:

1. If `project.activePaletteId` refers to an **indexed** palette, use its
   colors directly (each pixel mapped via `nearestColor`).
2. Otherwise, auto-build a palette from the item's own distinct pixel colors,
   capped at the target's max color count (256 generic, 16 GBA, 4 NES) by
   taking the most-frequent colors and mapping the remainder via
   `nearestColor`.

## Menu & dialog UX

- **Document menu**: `file.export` action moves here, relabeled
  **"Export Sheet…"**, scoped to the active sheet. Same dialog-driven pattern
  as today (`defineAction` + `<dialog>.showModal()`), restructured as a
  format picker:
  - Sprite sheet: `JSON + PNG`, `Animation export…` (sub-dialog: pick an
    animation or "All animations", then `GIF` / `Spritesheet (PNG+JSON)` /
    `Image sequence`), `C99 header…` (sub-dialog: `Generic 8bpp` / `GBA 4bpp`
    / `NES 2bpp CHR`).
  - Tile sheet: `JSON + PNG`, `Tiled TSX`, `C99 header…` (same three
    targets).
  - Buttons disabled per sheet kind, same as today's `updateExportButtons()`.
- **File menu**: `file.export` action id is repurposed to **"Export
  Project…"** — new dialog listing every sheet (checkbox, default all
  checked) with a per-sheet format dropdown (options scoped to that sheet's
  kind) and a destination choice: **Download ZIP** (always available) or
  **Save to folder** (shown only when `io.supportsFS()`).

## Sprite-sheet formats

1. **JSON + PNG** — unchanged (`buildFramesJson` + `flattenSheet`).
2. **Animation export** — for the chosen animation(s), each frame rendered
   via `flattenSheet` cropped to the frame rect:
   - **GIF**: `js/core/gif.js`; per-frame delay from `effectiveDuration`.
     When `animation.loop` is true, include the `NETSCAPE2.0` extension with
     loop count 0 (infinite). When false, omit the extension entirely so the
     GIF plays once and stops (a loop count of 1 would replay it once more,
     not play it once).
   - **Spritesheet (PNG+JSON)**: same shape as `buildFramesJson`/PNG but
     frames filtered to the chosen animation(s) and repacked into a new
     tight sheet image (not the original sheet layout).
   - **Image sequence**: one PNG per frame, zipped, named
     `<anim>_000.png`, `<anim>_001.png`, …
3. **C99 header** — palette array + one `const uint8_t` array per frame (or
   per animation, concatenated), per the chosen target:
   - **Generic 8bpp**: one byte/pixel = palette index.
   - **GBA 4bpp**: 32 bytes per 8×8 tile, 2px/byte, low nibble = left pixel.
   - **NES 2bpp CHR**: 16 bytes per 8×8 tile, two 8-byte bitplanes (plane 0
     then plane 1), MSB = leftmost pixel; palette capped at 4 colors.
     Frame/tile dimensions not divisible by 8 are rejected with a clear
     error for the GBA/NES targets (generic8 has no tiling constraint).

## Tile-sheet formats

1. **JSON + PNG** — unchanged.
2. **Tiled TSX** — `<tileset>` with `<image>` pointing at the exported PNG,
   tile `id`s in sheet grid order; `<wangsets>` built from
   `sheet.terrainSets`: each terrain set → one `<wangset>`, each distinct
   terrain material → one `<wangcolor>`, each tile's resolved neighbor mask
   (via `resolveTerrainSlot`, the same helper `buildTilesJson` already uses)
   → one `<wangtile wangid="top,topright,right,bottomright,bottom,bottomleft,left,topleft">`
   (Tiled's fixed 8-value corner+edge order).
3. **C99 header** — same three targets as sprite frames, applied per-tile.

## Whole-project export mechanics

`projectExport.js` iterates the user's selected `{ sheet, format }` pairs,
calls the matching single-sheet builder for each (the same functions the
Document-menu export uses), and collects every output as a `{ path, data }`
entry (e.g. `<sheet>.png`, `<sheet>.frames.json`, `<sheet>.tsx`,
`<sheet>/<anim>.gif`). Two destinations:

- **Download ZIP**: `zipWrite(entries)` from `js/core/zip.js`, then
  `io.downloadBlob`.
- **Save to folder**: walk `entries` writing each through a
  `showDirectoryPicker()` handle, mirroring `io.js:saveUnpacked`'s
  directory-walk logic (new function, since `saveUnpacked` is specific to
  the packed project layout).

## Testing

Every new builder is a pure function tested the same way as
`tests/exports.test.mjs` — no DOM/browser dependency:

- `tests/gif.test.mjs` — byte-level structure checks (header, NETSCAPE loop
  block, GCE delay/loop values, frame count) and a round-trip decode check
  against a hand-verified small GIF.
- `tests/tiledExport.test.mjs` — wangid ordering and wangcolor/wangtile
  correctness against known terrain-set fixtures.
- `tests/c99Export.test.mjs` — one test per target verifying exact byte
  packing (GBA nibble order, NES bitplane order) against hand-computed
  expected arrays.
- `tests/animationExport.test.mjs` — spritesheet/image-sequence frame
  filtering and repacking; GIF path checked via `gif.js`'s own tests plus an
  integration test that the right frames/delays are passed through.
- `tests/projectExport.test.mjs` — entry collection (paths, count) for a
  multi-sheet project with mixed formats.
