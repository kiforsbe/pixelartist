// Target-platform hardware constraints for live edit-time compatibility
// warnings (see js/app/main.js's status-bar wiring) -- NOT export-time
// packing (js/app/c99Export.js / js/app/platformExport.js own that; the
// numeric caps here intentionally mirror MAX_COLORS there for gba4/nes2/
// snes4/generic8 so the two don't silently disagree).
//
// Two kinds of constraint per platform:
// - maxColorsPerItem: max distinct opaque colors in one frame/tile's own
//   pixels. Always a hard hardware fact where cited (NES/GBA/SNES/C64).
// - palette: if the hardware has a genuinely FIXED, non-programmable color
//   set (NES's PPU output, C64's VIC-II output), the actual list of
//   [r,g,b] values -- colors outside it get flagged even if the COUNT is
//   within budget. null means "freely-chosen RGB, any hue is fine" (GBA/
//   SNES/generic all have programmable 15-bit-or-more palettes with no
//   fixed swatch set).
// - maxReasonableTiles: a SOFT, advisory "this is larger than one typical
//   single sprite" threshold in 8x8 tiles. GBA/SNES's 64 is a hardware
//   fact (largest single OBJ is 64x64px = 64 tiles -- both platforms cap
//   individual objects there, confirmed against GBATEK/SNESdev). The rest
//   are practical guidance, not a hard limit -- multiple hardware sprites/
//   tiles can always be combined into a bigger on-screen character, it
//   just spends more of the platform's total sprite/tile budget to do it.

// This project already ships real hardware master palettes (js/core/
// systempalettes.js, used for the indexed-palette picker) -- reuse those
// instead of a second, independently-typed copy.
import { SYSTEM_PALETTES } from './systempalettes.js';

const systemPalette = name => SYSTEM_PALETTES.find(p => p.name === name).colors;

export const NES_PALETTE = systemPalette('NES');
export const C64_PALETTE = systemPalette('Commodore 64');

export const PLATFORMS = {
  none: { label: 'None', maxColorsPerItem: null, palette: null, maxReasonableTiles: null },
  generic: { label: 'Generic', maxColorsPerItem: 256, palette: null, maxReasonableTiles: null },
  gba: { label: 'Game Boy Advance', maxColorsPerItem: 16, palette: null, maxReasonableTiles: 64 },
  nes: { label: 'NES', maxColorsPerItem: 4, palette: NES_PALETTE, maxReasonableTiles: 16 },
  snes: { label: 'SNES', maxColorsPerItem: 16, palette: null, maxReasonableTiles: 64 },
  c64: { label: 'Commodore 64', maxColorsPerItem: 4, palette: C64_PALETTE, maxReasonableTiles: 16 },
  retro8: { label: 'Retro 8-bit', maxColorsPerItem: 4, palette: NES_PALETTE, maxReasonableTiles: 16 },
  retro16: { label: 'Retro 16-bit', maxColorsPerItem: 16, palette: null, maxReasonableTiles: 64 },
  retro32: { label: 'Retro 32-bit', maxColorsPerItem: 256, palette: null, maxReasonableTiles: 256 },
};

function paletteHasColor(palette, rgb) {
  return palette.some(c => c[0] === rgb[0] && c[1] === rgb[1] && c[2] === rgb[2]);
}

// `colors`: distinct opaque [r,g,b,a] colors actually used in one frame/
// tile's own pixels (e.g. js/core/quantize.js's colorFrequency output).
// `w`/`h`: that frame/tile's own pixel dimensions. Returns a list of
// human-readable warning strings; empty when compliant or platformId is
// 'none'/unknown.
export function checkItemAgainstPlatform(platformId, { colors, w, h }) {
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
  if (platform.maxReasonableTiles != null) {
    const tiles = Math.ceil(w / 8) * Math.ceil(h / 8);
    if (tiles > platform.maxReasonableTiles) {
      warnings.push(`${w}x${h} (${tiles} 8x8 tiles) is larger than a typical single ${platform.label} sprite (~${platform.maxReasonableTiles} tiles) -- combining multiple hardware sprites/tiles works, but eats into the on-screen budget.`);
    }
  }
  return warnings;
}
