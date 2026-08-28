// Packs already-quantized palette-index arrays into C99 source for retro
// targets. Palette/quantization is the caller's job (js/core/quantize.js) --
// this module is pure byte-packing.
export const MAX_COLORS = { generic8: 256, gba4: 16, nes2: 4, snes4: 16, gb2: 4, gbc2: 4, c64mc: 4 };

function packTiles(w, h, indices, tileBytes, packTile) {
  if (w % 8 !== 0 || h % 8 !== 0)
    throw new Error(`${w}x${h}: dimensions must be multiples of 8 for tile-packed targets`);
  const cols = w / 8, rows = h / 8;
  const out = new Uint8Array(cols * rows * tileBytes);
  let o = 0;
  for (let ty = 0; ty < rows; ty++)
    for (let tx = 0; tx < cols; tx++) {
      const tile = new Uint8Array(64);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          tile[y * 8 + x] = indices[(ty * 8 + y) * w + (tx * 8 + x)];
      out.set(packTile(tile), o);
      o += tileBytes;
    }
  return out;
}

// 32 bytes/tile, 2px/byte, low nibble = left pixel (Tonc/GBATEK convention).
function packGba4Tile(tile) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (tile[i * 2] & 0x0f) | ((tile[i * 2 + 1] & 0x0f) << 4);
  return bytes;
}

// 16 bytes/tile: 8-byte plane0 (bit0 of each pixel) then 8-byte plane1
// (bit1), MSB = leftmost pixel (NESdev CHR convention).
function packNes2Tile(tile) {
  const bytes = new Uint8Array(16);
  for (let row = 0; row < 8; row++) {
    let plane0 = 0, plane1 = 0;
    for (let x = 0; x < 8; x++) {
      const v = tile[row * 8 + x] & 3;
      plane0 |= (v & 1) << (7 - x);
      plane1 |= ((v >> 1) & 1) << (7 - x);
    }
    bytes[row] = plane0;
    bytes[row + 8] = plane1;
  }
  return bytes;
}

// 32 bytes/tile: bitplanes 0+1 interleaved row-by-row (16 bytes: row0
// plane0, row0 plane1, row1 plane0, row1 plane1, ...), then bitplanes 2+3
// interleaved row-by-row the same way (next 16 bytes). MSB = leftmost
// pixel. This is a genuinely different byte layout from GBA's packed-
// nibble 4bpp despite both being "4bpp, 32 bytes/tile" (SNESdev/SnesLab
// convention).
function packSnes4Tile(tile) {
  const bytes = new Uint8Array(32);
  for (let row = 0; row < 8; row++) {
    let bp0 = 0, bp1 = 0, bp2 = 0, bp3 = 0;
    for (let x = 0; x < 8; x++) {
      const v = tile[row * 8 + x] & 0x0f;
      bp0 |= (v & 1) << (7 - x);
      bp1 |= ((v >> 1) & 1) << (7 - x);
      bp2 |= ((v >> 2) & 1) << (7 - x);
      bp3 |= ((v >> 3) & 1) << (7 - x);
    }
    bytes[row * 2] = bp0;
    bytes[row * 2 + 1] = bp1;
    bytes[16 + row * 2] = bp2;
    bytes[16 + row * 2 + 1] = bp3;
  }
  return bytes;
}

// 16 bytes/tile, row-interleaved: byte0 = plane0 (bit0) of row0, byte1 =
// plane1 (bit1) of row0, byte2 = plane0 of row1, ... MSB = leftmost pixel
// (Pan Docs "Tile Data" -- same bit-per-pixel layout as NES's 2bpp, but
// interleaved per row rather than in two 8-byte blocks; genuinely
// different byte order despite both being "2bpp, 16 bytes/tile"). Game
// Boy Color uses this identical tile format -- only the palette encoding
// differs (see packPaletteBgr555 in js/core/export/platformExport.js), so both
// 'gb2' and 'gbc2' targets share this packer.
function packGb2Tile(tile) {
  const bytes = new Uint8Array(16);
  for (let row = 0; row < 8; row++) {
    let lo = 0, hi = 0;
    for (let x = 0; x < 8; x++) {
      const v = tile[row * 8 + x] & 3;
      lo |= (v & 1) << (7 - x);
      hi |= ((v >> 1) & 1) << (7 - x);
    }
    bytes[row * 2] = lo;
    bytes[row * 2 + 1] = hi;
  }
  return bytes;
}

// 8 bytes/tile, 1 byte/row: VIC-II multicolor bitmap mode pairs up
// columns into double-wide pixels (each cell is 4 double-wide pixels
// across 8 screen pixels), so only every other source column is sampled;
// the odd column's color is dropped (C64-Wiki "Sprite" / Dustlayer VIC-II
// bitmap-mode docs). 2 bits/pixel-pair, MSB = leftmost pair.
function packC64McTile(tile) {
  const bytes = new Uint8Array(8);
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let pair = 0; pair < 4; pair++) {
      const v = tile[row * 8 + pair * 2] & 3;
      byte |= v << ((3 - pair) * 2);
    }
    bytes[row] = byte;
  }
  return bytes;
}

// Shared by js/core/export/platformExport.js, which packs the same GBA4/NES2/
// SNES4/GB2/GBC2/C64MC byte layouts into raw native binary files instead
// of C source.
export function packItem(item, target) {
  if (target === 'generic8') return item.indices;
  if (target === 'gba4') return packTiles(item.w, item.h, item.indices, 32, packGba4Tile);
  if (target === 'nes2') return packTiles(item.w, item.h, item.indices, 16, packNes2Tile);
  if (target === 'snes4') return packTiles(item.w, item.h, item.indices, 32, packSnes4Tile);
  if (target === 'gb2' || target === 'gbc2') return packTiles(item.w, item.h, item.indices, 16, packGb2Tile);
  if (target === 'c64mc') return packTiles(item.w, item.h, item.indices, 8, packC64McTile);
  throw new Error(`unknown C99 export target "${target}"`);
}

const hex = b => `0x${b.toString(16).padStart(2, '0')}`;

function cArray(name, bytes) {
  return `const unsigned char ${name}[${bytes.length}] = {${Array.from(bytes).map(hex).join(',')}};`;
}

function cPaletteArray(name, palette) {
  const rows = palette.map(c => `{${hex(c[0])},${hex(c[1])},${hex(c[2])}}`).join(',');
  return `const unsigned char ${name}[${palette.length}][3] = {${rows}};`;
}

function identifier(value) {
  const name = String(value ?? '').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z]/.test(name) ? name : `asset_${name || 'item'}`;
}

export function buildC99({ projectName, target, palette, items }) {
  const maxColors = MAX_COLORS[target];
  if (!maxColors) throw new Error(`unknown C99 export target "${target}"`);
  if (palette.length > maxColors)
    throw new Error(`${target} supports at most ${maxColors} colors, got ${palette.length}`);

  const prefix = identifier(projectName);
  const guard = `${prefix.toUpperCase()}_H`;
  const used = new Set([guard]);
  function symbol(name) {
    const base = `${prefix}_${identifier(name)}`;
    let unique = base, suffix = 2;
    while (used.has(unique)) unique = `${base}_${suffix++}`;
    used.add(unique);
    return unique;
  }
  const paletteName = symbol('palette');
  const declarations = [`extern const unsigned char ${paletteName}[${palette.length}][3];`];
  const definitions = [cPaletteArray(paletteName, palette)];

  for (const item of items) {
    const packed = packItem(item, target);
    const name = symbol(item.name);
    declarations.push(`extern const unsigned char ${name}[${packed.length}];`);
    definitions.push(cArray(name, packed));
  }

  const h = `#ifndef ${guard}\n#define ${guard}\n\n${declarations.join('\n')}\n\n#endif\n`;
  // Keep display/file names independent from C symbols, but reject filename
  // delimiters which could also break the generated include directive.
  const filename = String(projectName).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'asset';
  const headerFilename = `${filename}.h`, sourceFilename = `${filename}.c`;
  const c = `#include "${headerFilename}"\n\n${definitions.join('\n\n')}\n`;
  return { h, c, headerFilename, sourceFilename };
}
