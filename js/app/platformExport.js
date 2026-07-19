// Packs quantized pixel data into each platform's actual native binary
// format -- not a C source wrapper (see js/app/c99Export.js for that).
// Reuses c99Export.js's tile packing (identical byte layout, GBA4/NES2/
// SNES4 hardware formats don't change based on how the bytes get shipped
// to a compiler) but ships raw bytes instead of `const unsigned char[] =
// {...}`.
import { packItem, MAX_COLORS } from './c99Export.js';
// C64 has no programmable RGB palette (VIC-II output is a fixed 16-shade
// set) -- reuse the project's existing hardware palette table instead of
// hand-typing a second copy (js/core/platforms.js already sourced it from
// js/core/systempalettes.js).
import { C64_PALETTE } from '../core/platforms.js';

// GBA and SNES palette RAM both use this exact 15-bit BGR555 format, 2
// bytes per color, little-endian (bit15 unused, bits10-14 = blue, bits5-9
// = green, bits0-4 = red -- GBATEK/Tonc convention for GBA, SNESdev's
// Palettes page confirms CGRAM uses the same encoding -- 0x0000 = black,
// 0x7FFF = white).
function bgr555(r, g, b) {
  return (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10);
}

function packPaletteBgr555(palette) {
  const pal = new Uint8Array(palette.length * 2);
  palette.forEach((c, i) => {
    const v = bgr555(c[0], c[1], c[2]);
    pal[i * 2] = v & 0xff;
    pal[i * 2 + 1] = (v >>> 8) & 0xff;
  });
  return pal;
}

function packTileStream(items, target) {
  const chunks = items.map(item => packItem(item, target));
  const totalLen = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(totalLen);
  let o = 0;
  for (const chunk of chunks) { out.set(chunk, o); o += chunk.length; }
  return out;
}

// Real GBA toolchains (devkitPro's grit and hand-rolled equivalents) ship
// 4bpp tile data and its 15-bit-color palette as two separate raw binary
// files, not embedded in one blob -- mirrored here as two return values
// rather than concatenating them.
export function buildGbaBinary({ palette, items }) {
  if (palette.length > MAX_COLORS.gba4)
    throw new Error(`gba4 supports at most ${MAX_COLORS.gba4} colors, got ${palette.length}`);
  return { pal: packPaletteBgr555(palette), tiles: packTileStream(items, 'gba4') };
}

// Raw NES CHR-ROM pattern data: just the packed 2bpp planar tile bytes,
// concatenated. No header, no embedded palette -- NES hardware has no
// concept of an RGB palette inside CHR data; pixel values are indices
// (0-3) resolved against a separate, level-specific attribute-table
// palette outside any single tile's own bytes.
export function buildNesChr({ items }) {
  return packTileStream(items, 'nes2');
}

// Same two-file convention as GBA (separate raw .pal/.tiles binaries,
// same BGR555 palette encoding) -- common in SNES homebrew toolchains
// (e.g. pvsneslib) that consume raw CGRAM/VRAM dumps directly rather than
// C source.
export function buildSnesBinary({ palette, items }) {
  if (palette.length > MAX_COLORS.snes4)
    throw new Error(`snes4 supports at most ${MAX_COLORS.snes4} colors, got ${palette.length}`);
  return { pal: packPaletteBgr555(palette), tiles: packTileStream(items, 'snes4') };
}

// Original Game Boy (DMG): like NES, hardware has no concept of an RGB
// palette in tile data -- BGP/OBP0/OBP1 registers remap the 2bpp index
// values (0-3) to 4 shades entirely at runtime, so real toolchains (GBDK,
// RGBDS) ship just the packed 2bpp bytes, no palette file.
export function buildGbBinary({ items }) {
  return packTileStream(items, 'gb2');
}

// Game Boy Color: same 2bpp tile format as DMG (packGb2Tile), but adds a
// real programmable palette -- BG/OBJ palette RAM is BGR555, same 15-bit
// encoding as GBA/SNES CGRAM (Pan Docs "CGB Palettes") -- so this mirrors
// buildGbaBinary's two-file convention instead of buildGbBinary's paletteless one.
export function buildGbcBinary({ palette, items }) {
  if (palette.length > MAX_COLORS.gbc2)
    throw new Error(`gbc2 supports at most ${MAX_COLORS.gbc2} colors, got ${palette.length}`);
  return { pal: packPaletteBgr555(palette), tiles: packTileStream(items, 'gbc2') };
}

function nearestC64Index(rgb) {
  let best = 0, bestDist = Infinity;
  C64_PALETTE.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// C64 multicolor bitmap mode: 4 colors per 8x8 cell, but only 3 are
// per-cell -- color 00 is always the single shared background register
// ($D021), the same for the whole screen (C64-Wiki "Bitmap Graphics").
// `palette[0]` (the most-frequent source color, from js/core/quantize.js's
// colorFrequency ordering) becomes that shared background; the other
// entries become each cell's own screen-RAM/color-RAM nibbles. Since this
// app currently shares one palette across a whole sheet export (same
// simplification buildNesChr makes for NES's per-attribute-table
// palettes), every cell here ends up with the same 3 colors too --
// spelled out per-cell anyway so the byte layout matches real VIC-II
// memory (1 screen-RAM + 1 color-RAM byte per 8x8 cell).
export function buildC64Binary({ palette, items }) {
  if (palette.length > MAX_COLORS.c64mc)
    throw new Error(`c64mc supports at most ${MAX_COLORS.c64mc} colors, got ${palette.length}`);
  const idx = palette.map(nearestC64Index);
  const [bg = 0, s1 = bg, s2 = bg, cr = bg] = idx;
  const screenByte = (s1 << 4) | s2;
  const colorByte = cr & 0x0f;
  const tileCount = items.reduce((n, it) => n + Math.ceil(it.w / 8) * Math.ceil(it.h / 8), 0);
  return {
    background: bg,
    screenRam: new Uint8Array(tileCount).fill(screenByte),
    colorRam: new Uint8Array(tileCount).fill(colorByte),
    bitmap: packTileStream(items, 'c64mc'),
  };
}

// ---------------------------------------------------------------- hardware
// compatibility checks
//
// Pure, DOM-free: returns { errors, warnings } (both string arrays) rather
// than throwing/alerting itself, so the caller (main.js) decides how to
// surface them (confirm-before-export, batch summary, etc). `errors` block
// the export outright (the content is structurally impossible to pack);
// `warnings` describe lossy-but-possible conversions the user should know
// about before trusting the output.
function itemTileIssues(items) {
  const badItems = items.filter(it => it.w % 8 !== 0 || it.h % 8 !== 0);
  const tileCount = items.reduce((n, it) => n + Math.ceil(it.w / 8) * Math.ceil(it.h / 8), 0);
  return { badItems, tileCount };
}

// Every bit-packed target's tile packer (packGba4Tile etc., js/app/
// c99Export.js) masks each pixel's index to its format's bit depth (e.g.
// `& 3` for 2bpp) -- if project.settings.exportColorMode is 'total', the
// shared export palette can be much larger than any one item's own
// hardware budget (js/app/main.js's resolveC99Items), so an individual
// item's OWN quantized indices can silently exceed that mask and wrap
// around to the wrong color. This catches that before it happens: it's a
// blocking error, not a lossy-but-valid warning, since wraparound produces
// actively wrong pixels, not just approximated ones.
function itemIndexOverflow(items, maxColors) {
  return items.filter(it => it.indices && Array.prototype.some.call(it.indices, v => v >= maxColors));
}

// GBA: 4bpp tiles are always 8x8; one palette bank holds 16 colors; OBJ
// (sprite) tile VRAM is a fixed 32KB = 1024 tiles across both sprite
// charblocks in bitmap-free display modes (Tonc's "Regular sprites"
// chapter -- see design doc's platform-export section for the source).
export function checkGbaCompatibility({ sourceColorCount, items, paletteBudget = MAX_COLORS.gba4 }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- GBA tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > paletteBudget)
    warnings.push(`Artwork uses ${sourceColorCount} colors; this export's shared palette holds at most ${paletteBudget}. Colors were reduced to the nearest match -- some detail may be lost.`);
  const overflow = itemIndexOverflow(items, MAX_COLORS.gba4);
  if (overflow.length)
    errors.push(`${overflow.length} item(s) (e.g. "${overflow[0].name}") use more than ${MAX_COLORS.gba4} of their own colors -- a single GBA 4bpp tile can never show more than ${MAX_COLORS.gba4} colors, even with a larger overall palette. Simplify the artwork, or use "Generic C Header" instead.`);
  if (tileCount > 1024)
    warnings.push(`${tileCount} 8x8 tiles exceeds the GBA's 1024-tile object VRAM budget (32KB across both sprite charblocks, in bitmap-free display modes) -- you may need to split this across multiple loads.`);
  return { errors, warnings };
}

// NES: 2bpp CHR tiles are always 8x8; a tile's palette holds 3 colors plus
// transparency; one CHR-ROM pattern table is a fixed 4KB = 256 tiles (two
// tables per 8KB bank = 512 tiles total) -- see NESdev's PPU pattern
// tables page (design doc has the citation).
export function checkNesCompatibility({ sourceColorCount, items, paletteBudget = MAX_COLORS.nes2 }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- NES tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > paletteBudget)
    warnings.push(`Artwork uses ${sourceColorCount} colors; this export's shared palette holds at most ${paletteBudget}. Colors were reduced to the nearest match -- some detail may be lost.`);
  const overflow = itemIndexOverflow(items, MAX_COLORS.nes2);
  if (overflow.length)
    errors.push(`${overflow.length} item(s) (e.g. "${overflow[0].name}") use more than ${MAX_COLORS.nes2} of their own colors (3 colors + transparency) -- a single NES tile can never show more, even with a larger overall palette. Simplify the artwork, or use "Generic C Header" instead.`);
  if (tileCount > 256)
    warnings.push(`${tileCount} 8x8 tiles exceeds one 256-tile CHR-ROM pattern table (4KB) -- you'll need the second pattern table or CHR bank switching to fit it all.`);
  return { errors, warnings };
}

// SNES: 4bpp tiles are always 8x8; one CGRAM palette holds 16 colors
// (BGR555, same encoding as GBA); one 4bpp background layer's worth of
// unique tiles fills 32KB VRAM = 1024 tiles (SNESdev's Backgrounds page --
// design doc has the citation). Total VRAM is 64KB shared across every BG
// layer, OBJ tiles, and tilemaps, so this is an optimistic upper bound for
// any single asset, not a guarantee it'll fit alongside everything else.
export function checkSnesCompatibility({ sourceColorCount, items, paletteBudget = MAX_COLORS.snes4 }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- SNES tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > paletteBudget)
    warnings.push(`Artwork uses ${sourceColorCount} colors; this export's shared palette holds at most ${paletteBudget}. Colors were reduced to the nearest match -- some detail may be lost.`);
  const overflow = itemIndexOverflow(items, MAX_COLORS.snes4);
  if (overflow.length)
    errors.push(`${overflow.length} item(s) (e.g. "${overflow[0].name}") use more than ${MAX_COLORS.snes4} of their own colors -- a single SNES 4bpp tile can never show more than ${MAX_COLORS.snes4} colors, even with a larger overall palette. Simplify the artwork, or use "Generic C Header" instead.`);
  if (tileCount > 1024)
    warnings.push(`${tileCount} 8x8 tiles exceeds one 4bpp background layer's 1024-tile VRAM budget (32KB) -- SNES VRAM is only 64KB total, shared with every other layer/sprite/tilemap, so you'll likely need to split or stream this.`);
  return { errors, warnings };
}

// Game Boy (DMG): 2bpp tiles are always 8x8; a tile's palette holds 4
// shades (index-remapped at runtime via BGP/OBP0/OBP1, not stored in tile
// data); VRAM is a fixed 8KB = 384 tiles (Pan Docs "VRAM Tile Data").
export function checkGbCompatibility({ sourceColorCount, items, paletteBudget = MAX_COLORS.gb2 }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- Game Boy tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > paletteBudget)
    warnings.push(`Artwork uses ${sourceColorCount} colors; this export's shared palette holds at most ${paletteBudget}. Colors were reduced to the nearest match -- some detail may be lost.`);
  const overflow = itemIndexOverflow(items, MAX_COLORS.gb2);
  if (overflow.length)
    errors.push(`${overflow.length} item(s) (e.g. "${overflow[0].name}") use more than ${MAX_COLORS.gb2} of their own shades -- a single Game Boy tile can never show more, even with a larger overall palette. Simplify the artwork, or use "Generic C Header" instead.`);
  if (tileCount > 384)
    warnings.push(`${tileCount} 8x8 tiles exceeds the Game Boy's 384-tile VRAM budget (8KB) -- you'll need runtime tile swapping to fit it all.`);
  return { errors, warnings };
}

// Game Boy Color: same 2bpp tile format as DMG, but a real programmable
// palette (BGR555, up to 4 colors/tile from 8 selectable palette banks)
// and a second VRAM bank (another 8KB, switched via $FF4F) doubling the
// Game Boy's 384-tile budget to 768 tiles total (Pan Docs "CGB Palettes" /
// "VRAM Bank Select").
export function checkGbcCompatibility({ sourceColorCount, items, paletteBudget = MAX_COLORS.gbc2 }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- Game Boy Color tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > paletteBudget)
    warnings.push(`Artwork uses ${sourceColorCount} colors; this export's shared palette holds at most ${paletteBudget}. Colors were reduced to the nearest match -- some detail may be lost.`);
  const overflow = itemIndexOverflow(items, MAX_COLORS.gbc2);
  if (overflow.length)
    errors.push(`${overflow.length} item(s) (e.g. "${overflow[0].name}") use more than ${MAX_COLORS.gbc2} of their own colors -- a single Game Boy Color tile can never show more than ${MAX_COLORS.gbc2} colors (one palette bank), even with a larger overall palette. Simplify the artwork, or use "Generic C Header" instead.`);
  if (tileCount > 768)
    warnings.push(`${tileCount} 8x8 tiles exceeds the Game Boy Color's 768-tile VRAM budget (two 8KB banks) -- you'll need runtime tile swapping to fit it all.`);
  return { errors, warnings };
}

// Multicolor bitmap-mode pixels are always 2 physical pixels wide (see
// packC64McTile in js/app/c99Export.js) -- counts how many horizontally-
// adjacent source pixel pairs disagree, since those get silently collapsed
// to the even column's color on export.
function c64PairedColumnLoss(items) {
  let n = 0;
  for (const it of items) {
    if (!it.indices || it.w % 2 !== 0) continue;
    for (let y = 0; y < it.h; y++)
      for (let x = 0; x < it.w; x += 2)
        if (it.indices[y * it.w + x] !== it.indices[y * it.w + x + 1]) n++;
  }
  return n;
}

// C64 (VIC-II) multicolor bitmap mode: 8x8 cells hold 4 colors (1 shared
// background + 3 per-cell -- see buildC64Binary), but each color is a
// double-wide pixel pair, and the whole VIC-II bank holds 8KB = 1000
// cells' worth of bitmap data (C64-Wiki "Bitmap Graphics").
export function checkC64Compatibility({ sourceColorCount, items, paletteBudget = MAX_COLORS.c64mc }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- C64 multicolor bitmap cells are always built from 8x8 blocks.`);
  if (sourceColorCount > paletteBudget)
    warnings.push(`Artwork uses ${sourceColorCount} colors; this export's shared palette holds at most ${paletteBudget}. Colors were reduced to the nearest match -- some detail may be lost.`);
  const overflow = itemIndexOverflow(items, MAX_COLORS.c64mc);
  if (overflow.length)
    errors.push(`${overflow.length} item(s) (e.g. "${overflow[0].name}") use more than ${MAX_COLORS.c64mc} of their own colors -- a single C64 multicolor cell can never show more than ${MAX_COLORS.c64mc} colors (1 shared background + 3 per cell), even with a larger overall palette. Simplify the artwork, or use "Generic C Header" instead.`);
  const lossyPairs = c64PairedColumnLoss(items);
  if (lossyPairs)
    warnings.push(`${lossyPairs} double-wide pixel pair(s) have mismatched colors -- C64 multicolor pixels are always 2px wide, so the second column's color is dropped.`);
  if (tileCount > 1000)
    warnings.push(`${tileCount} 8x8 cells exceeds the C64's 1000-cell bitmap budget (8KB bitmap RAM) -- you'll need multiple loads to fit it all.`);
  return { errors, warnings };
}
