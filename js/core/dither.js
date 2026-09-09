// js/core/dither.js
// Threshold patterns. Pure; no DOM.
//
// Opacity here is DENSITY, not alpha. Blending 50% of one palette color over
// another invents a third color that is not in the palette; writing through a
// 50% threshold pattern reads as translucent while every written pixel stays
// a real palette entry. This is how pre-alpha paint programs did translucency
// on indexed hardware.
//
// Patterns index by BITMAP coordinates, never by stroke-local ones, so two
// separate strokes across one region produce a continuous, aligned dither.

export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// A 4x4 matrix admits 17 distinct densities (0..16 cells lit), so the 0..100
// slider cannot express more than that. Snapping here makes the limit
// explicit rather than letting 30 and 31 silently render the same.
export function opacityLevel(opacity) {
  const o = Math.max(0, Math.min(100, Number(opacity) || 0));
  return Math.round((o / 100) * 16);
}

function wrap(v, n) {
  return ((v % n) + n) % n;
}

export function passesOpacity(x, y, opacity) {
  const level = opacityLevel(opacity);
  if (level >= 16) return true;
  if (level <= 0) return false;
  return BAYER4[wrap(y, 4)][wrap(x, 4)] < level;
}

export const PATTERNS = {
  bayer4: { width: 4, height: 4, cells: BAYER4.flat().map(v => (v < 8 ? 0 : 1)) },
  checker: { width: 2, height: 2, cells: [0, 1, 1, 0] },
  dots25: { width: 4, height: 4, cells: [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1] },
  lines: { width: 2, height: 2, cells: [0, 0, 1, 1] },
};

export function patternPicksSecondary(patternName, x, y) {
  const p = PATTERNS[patternName] ?? PATTERNS.bayer4;
  return p.cells[wrap(y, p.height) * p.width + wrap(x, p.width)] === 1;
}
