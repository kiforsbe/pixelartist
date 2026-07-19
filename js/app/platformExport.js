// Packs quantized pixel data into each platform's actual native binary
// format -- not a C source wrapper (see js/app/c99Export.js for that).
// Reuses c99Export.js's tile packing (identical byte layout, GBA4/NES2/
// SNES4 hardware formats don't change based on how the bytes get shipped
// to a compiler) but ships raw bytes instead of `const unsigned char[] =
// {...}`.
import { packItem, MAX_COLORS } from './c99Export.js';

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

// GBA: 4bpp tiles are always 8x8; one palette bank holds 16 colors; OBJ
// (sprite) tile VRAM is a fixed 32KB = 1024 tiles across both sprite
// charblocks in bitmap-free display modes (Tonc's "Regular sprites"
// chapter -- see design doc's platform-export section for the source).
export function checkGbaCompatibility({ sourceColorCount, items }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- GBA tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > MAX_COLORS.gba4)
    warnings.push(`Artwork uses ${sourceColorCount} colors; a GBA 4bpp palette bank holds at most ${MAX_COLORS.gba4}. Colors were reduced to the nearest match -- some detail may be lost.`);
  if (tileCount > 1024)
    warnings.push(`${tileCount} 8x8 tiles exceeds the GBA's 1024-tile object VRAM budget (32KB across both sprite charblocks, in bitmap-free display modes) -- you may need to split this across multiple loads.`);
  return { errors, warnings };
}

// NES: 2bpp CHR tiles are always 8x8; a tile's palette holds 3 colors plus
// transparency; one CHR-ROM pattern table is a fixed 4KB = 256 tiles (two
// tables per 8KB bank = 512 tiles total) -- see NESdev's PPU pattern
// tables page (design doc has the citation).
export function checkNesCompatibility({ sourceColorCount, items }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- NES tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > MAX_COLORS.nes2)
    warnings.push(`Artwork uses ${sourceColorCount} colors; an NES tile's palette holds at most ${MAX_COLORS.nes2} (3 colors + transparency). Colors were reduced to the nearest match -- some detail may be lost.`);
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
export function checkSnesCompatibility({ sourceColorCount, items }) {
  const errors = [], warnings = [];
  const { badItems, tileCount } = itemTileIssues(items);
  if (badItems.length)
    errors.push(`${badItems.length} item(s) (e.g. "${badItems[0].name}", ${badItems[0].w}x${badItems[0].h}) aren't multiples of 8x8 -- SNES tiles are always built from 8x8 blocks.`);
  if (sourceColorCount > MAX_COLORS.snes4)
    warnings.push(`Artwork uses ${sourceColorCount} colors; an SNES 4bpp CGRAM palette holds at most ${MAX_COLORS.snes4}. Colors were reduced to the nearest match -- some detail may be lost.`);
  if (tileCount > 1024)
    warnings.push(`${tileCount} 8x8 tiles exceeds one 4bpp background layer's 1024-tile VRAM budget (32KB) -- SNES VRAM is only 64KB total, shared with every other layer/sprite/tilemap, so you'll likely need to split or stream this.`);
  return { errors, warnings };
}
