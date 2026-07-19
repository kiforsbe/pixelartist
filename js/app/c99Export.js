// Packs already-quantized palette-index arrays into C99 source for retro
// targets. Palette/quantization is the caller's job (js/core/quantize.js) --
// this module is pure byte-packing.
export const MAX_COLORS = { generic8: 256, gba4: 16, nes2: 4 };

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

// Shared by js/app/platformExport.js, which packs the same GBA4/NES2 byte
// layouts into raw native binary files instead of C source.
export function packItem(item, target) {
  if (target === 'generic8') return item.indices;
  if (target === 'gba4') return packTiles(item.w, item.h, item.indices, 32, packGba4Tile);
  if (target === 'nes2') return packTiles(item.w, item.h, item.indices, 16, packNes2Tile);
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

export function buildC99({ projectName, target, palette, items }) {
  const maxColors = MAX_COLORS[target];
  if (!maxColors) throw new Error(`unknown C99 export target "${target}"`);
  if (palette.length > maxColors)
    throw new Error(`${target} supports at most ${maxColors} colors, got ${palette.length}`);

  const guard = `${projectName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_H`;
  const declarations = [`extern const unsigned char ${projectName}_palette[${palette.length}][3];`];
  const definitions = [cPaletteArray(`${projectName}_palette`, palette)];

  for (const item of items) {
    const packed = packItem(item, target);
    declarations.push(`extern const unsigned char ${projectName}_${item.name}[${packed.length}];`);
    definitions.push(cArray(`${projectName}_${item.name}`, packed));
  }

  const h = `#ifndef ${guard}\n#define ${guard}\n\n${declarations.join('\n')}\n\n#endif\n`;
  const c = `#include "${projectName}.h"\n\n${definitions.join('\n\n')}\n`;
  return { h, c };
}
