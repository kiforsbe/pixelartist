// Target-platform hardware constraints for live edit-time compatibility
// warnings (see editor-workbench.js's status-bar wiring) -- NOT export-time
// packing (js/core/export/c99Export.js / js/core/export/platformExport.js own that; the
// numeric caps here intentionally mirror MAX_COLORS there for gba4/nes2/
// snes4/generic8 so the two don't silently disagree).
//
// Constraint fields per platform:
// - maxColorsPerItem: max distinct opaque colors in one frame/tile's own
//   pixels. Always a hard hardware fact where cited (NES/GBA/SNES/C64/GB/GBC).
// - palette: if the hardware has a genuinely FIXED, non-programmable color
//   set (NES's PPU output, C64's VIC-II output, the original DMG Game
//   Boy's 4-shade LCD), the actual list of [r,g,b] values -- colors
//   outside it get flagged even if the COUNT is within budget. null means
//   "freely-chosen RGB, any hue is fine" (GBA/SNES/GBC/generic all have
//   programmable 15-bit-or-more palettes with no fixed swatch set).
// - validSizes: { sprite: [[w,h], ...], tile: [[w,h], ...] } -- the exact
//   pixel dimensions hardware sprites/OBJs (`kind: 'sprite'`, i.e. this
//   app's frames) and background tiles (`kind: 'tile'`) are allowed to be.
//   Only set for platforms with a genuinely fixed, enumerable hardware
//   size list (GBA/NES/SNES/C64); null for platforms with no such table
//   (generic, retro8/16/32 -- see below).
// - tileAligned: true if the platform's hardware is fundamentally built
//   from 8x8 tile blocks (used as a softer fallback check for platforms
//   without a `validSizes` table, e.g. the retro8/16/32 tiers, which are
//   deliberately not pinned to one exact chip).
// - maxReasonableTiles: a SOFT, advisory "this is larger than one typical
//   single sprite" threshold in 8x8 tiles, used only as a fallback for
//   platforms without a `validSizes` table (retro8/16/32). Multiple
//   hardware sprites/tiles can always be combined into a bigger on-screen
//   character -- it just spends more of the platform's total budget.

// This project already ships real hardware master palettes (js/core/
// systempalettes.js, used for the indexed-palette picker) -- reuse those
// instead of a second, independently-typed copy.
import { SYSTEM_PALETTES } from './systempalettes.js';

const systemPalette = name => SYSTEM_PALETTES.find(p => p.name === name).colors;

export const NES_PALETTE = systemPalette('NES');
export const C64_PALETTE = systemPalette('Commodore 64');
export const GB_PALETTE = systemPalette('Game Boy');

// GBA OBJ (sprite) sizes: attribute-0 shape (square/wide/tall) crossed with
// attribute-1 size (0-3) -- 12 valid combinations, Tonc's "Regular sprites"
// Table 8.4 / GBATEK OAM attributes. GBA background tiles are always 8x8.
const GBA_OBJ_SIZES = [
  [8, 8], [16, 16], [32, 32], [64, 64],
  [16, 8], [32, 8], [32, 16], [64, 32],
  [8, 16], [8, 32], [16, 32], [32, 64],
];

// SNES OBJ sizes: register $2101 picks one of 6 *documented* size pairs,
// each pair drawn from these 4 square sizes (SNESdev/SnesLab PPU registers
// page); a sprite's own OAM size bit then selects the small or large size
// from that pair. SNES background tiles are always 8x8.
const SNES_OBJ_SIZES = [[8, 8], [16, 16], [32, 32], [64, 64]];

// NES sprites: PPUCTRL's sprite-size bit is a single global switch for
// every sprite on screen -- 8x8 or 8x16, never per-sprite (NESdev PPU
// registers page). Background (CHR) tiles are always 8x8.
const NES_SPRITE_SIZES = [[8, 8], [8, 16]];

// Game Boy (DMG) and Game Boy Color share the same LCD controller sprite
// hardware: LCDC bit 2 is a single global OBJ-size switch, 8x8 or 8x16
// (Pan Docs "LCD Control"), identical in shape to the NES's switch.
// Background tiles are always 8x8 on both.
const GB_SPRITE_SIZES = [[8, 8], [8, 16]];

// C64 (VIC-II) sprites are a fixed 24x21 pixel grid, independently
// doubled in X and/or Y via the $D01D/$D017 expand registers (C64-Wiki
// "Sprite" / Dustlayer VIC-II series) -- 4 possible on-screen sizes.
// Character-mode tiles are always 8x8.
const C64_SPRITE_SIZES = [[24, 21], [48, 21], [24, 42], [48, 42]];

const TILE_8X8 = [[8, 8]];

export const PLATFORMS = {
  none: { label: 'None', maxColorsPerItem: null, palette: null, validSizes: null, tileAligned: false, maxReasonableTiles: null },
  generic: { label: 'Generic', maxColorsPerItem: 256, palette: null, validSizes: null, tileAligned: false, maxReasonableTiles: null },
  gba: { label: 'Game Boy Advance', maxColorsPerItem: 16, palette: null, validSizes: { sprite: GBA_OBJ_SIZES, tile: TILE_8X8 }, tileAligned: true, maxReasonableTiles: null },
  nes: { label: 'NES', maxColorsPerItem: 4, palette: NES_PALETTE, validSizes: { sprite: NES_SPRITE_SIZES, tile: TILE_8X8 }, tileAligned: true, maxReasonableTiles: null },
  snes: { label: 'SNES', maxColorsPerItem: 16, palette: null, validSizes: { sprite: SNES_OBJ_SIZES, tile: TILE_8X8 }, tileAligned: true, maxReasonableTiles: null },
  c64: { label: 'Commodore 64', maxColorsPerItem: 4, palette: C64_PALETTE, validSizes: { sprite: C64_SPRITE_SIZES, tile: TILE_8X8 }, tileAligned: true, maxReasonableTiles: null },
  gb: { label: 'Game Boy', maxColorsPerItem: 4, palette: GB_PALETTE, validSizes: { sprite: GB_SPRITE_SIZES, tile: TILE_8X8 }, tileAligned: true, maxReasonableTiles: null },
  gbc: { label: 'Game Boy Color', maxColorsPerItem: 4, palette: null, validSizes: { sprite: GB_SPRITE_SIZES, tile: TILE_8X8 }, tileAligned: true, maxReasonableTiles: null },
  retro8: { label: 'Retro 8-bit', maxColorsPerItem: 4, palette: null, validSizes: null, tileAligned: true, maxReasonableTiles: 16 },
  retro16: { label: 'Retro 16-bit', maxColorsPerItem: 16, palette: null, validSizes: null, tileAligned: true, maxReasonableTiles: 64 },
  retro32: { label: 'Retro 32-bit', maxColorsPerItem: 256, palette: null, validSizes: null, tileAligned: true, maxReasonableTiles: 256 },
};

function paletteHasColor(palette, rgb) {
  return palette.some(c => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]);
}

function nearestInPalette(hwPalette, rgb) {
  let best = 0, bestDist = Infinity;
  hwPalette.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// Snaps each entry of `colors` ([r,g,b] or [r,g,b,a]) to its nearest match
// in a platform's real, fixed hardware palette (e.g. NES_PALETTE,
// C64_PALETTE, GB_PALETTE), deduping so two source colors that land on the
// same hardware color collapse to one palette entry. Used by
// file-controller.js's resolveC99Items so exported palettes for these
// platforms only ever contain colors the real hardware can actually
// produce -- not arbitrary source RGB. Order-preserving (first occurrence
// wins), so it composes with buildPalette's frequency ordering. Platforms
// with no fixed swatch set (GBA/SNES/GBC/generic) never call this --
// their `palette` field is null for exactly this reason.
export function snapPaletteToHardware(colors, hwPalette) {
  const seen = new Map();
  for (const c of colors) {
    const idx = nearestInPalette(hwPalette, c);
    if (!seen.has(idx)) seen.set(idx, hwPalette[idx]);
  }
  return [...seen.values()];
}

function matchesAnySize(sizes, w, h) {
  return sizes.some(([sw, sh]) => sw === w && sh === h);
}

// `colors`: distinct opaque [r,g,b,a] colors actually used in one frame/
// tile's own pixels (e.g. js/core/quantize.js's colorFrequency output).
// `w`/`h`: that frame/tile's own pixel dimensions. `kind`: 'sprite' (this
// app's frames -- the default) or 'tile' (this app's tiles), used to pick
// which half of a platform's `validSizes` table applies. Returns a list of
// human-readable warning strings; empty when compliant or platformId is
// 'none'/unknown.
export function checkItemAgainstPlatform(platformId, { colors, w, h, kind = 'sprite' }) {
  const platform = PLATFORMS[platformId];
  if (!platform || platformId === 'none') return [];
  const warnings = [];

  if (platform.maxColorsPerItem != null && colors.length > platform.maxColorsPerItem) {
    warnings.push(`Uses ${colors.length} colors; ${platform.label} allows at most ${platform.maxColorsPerItem} per sprite/tile.`);
  }
  if (platform.palette) {
    const outside = colors.filter(c => !paletteHasColor(platform.palette, c)).length;
    if (outside) warnings.push(`${outside} color(s) aren't in the ${platform.label} palette (will be approximated on export).`);
  }

  const sizes = platform.validSizes?.[kind];
  if (sizes) {
    if (!matchesAnySize(sizes, w, h)) {
      const list = sizes.map(([sw, sh]) => `${sw}x${sh}`).join(', ');
      const noun = kind === 'tile' ? 'background tile' : 'sprite';
      warnings.push(`${w}x${h} isn't a native ${platform.label} ${noun} size (valid sizes: ${list}) -- it will be padded/cropped on export.`);
    }
  } else if (platform.tileAligned && (w % 8 !== 0 || h % 8 !== 0)) {
    warnings.push(`${w}x${h} isn't a multiple of 8x8 -- ${platform.label} tiles are always built from 8x8 blocks; it will be padded on export.`);
  } else if (platform.maxReasonableTiles != null) {
    const tiles = Math.ceil(w / 8) * Math.ceil(h / 8);
    if (tiles > platform.maxReasonableTiles) {
      warnings.push(`${w}x${h} (${tiles} 8x8 tiles) is larger than a typical single ${platform.label} sprite (~${platform.maxReasonableTiles} tiles) -- combining multiple hardware sprites/tiles works, but eats into the on-screen budget.`);
    }
  }

  return warnings;
}
