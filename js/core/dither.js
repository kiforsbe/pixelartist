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

// There is no `bayer4` entry here on purpose: patternPicksSecondary takes no
// density argument, so a named pattern is always a fixed 50/50-or-whatever
// split of two colors -- and splitting the standard 4x4 Bayer matrix at its
// median (v < 8) is mathematically always a checkerboard. The Bayer matrix
// already earns its keep in passesOpacity, where all 17 density levels get
// used; do not re-add it here, it would just be `checker` under another
// name.
export const PATTERNS = {
  checker: { width: 2, height: 2, cells: [0, 1, 1, 0] },
  dots25: { width: 2, height: 2, cells: [0, 1, 1, 1] },
  lines: { width: 2, height: 2, cells: [0, 0, 1, 1] },
};

export function patternPicksSecondary(patternName, x, y) {
  const p = PATTERNS[patternName] ?? PATTERNS.checker;
  return p.cells[wrap(y, p.height) * p.width + wrap(x, p.width)] === 1;
}

// The density screen for an ink that ALSO splits its admitted pixels between
// two colours by a pattern -- one density decision per whole pattern PERIOD
// rather than per pixel.
//
// Why the coarser grain: passesOpacity and patternPicksSecondary were being
// asked to partition the same lattice independently, and they are not
// independent. BAYER4's eight lowest values sit exactly on the even-parity
// cells, which is precisely the primary phase of every 2x2 pattern here. So
// the density gate admitted only primary-phase pixels first and only started
// admitting the secondary phase once it had saturated the primary one: a
// `checker` dither at opacity 50 came out as a 50%-density SOLID wash of the
// primary, with the secondary swatch unreachable anywhere below opacity 54 --
// on the one ink whose entire purpose is two colours. It also skewed each
// pattern's own ratio at every level in between (`dots25`, a 25/75 pattern,
// measured 50/50 at opacity 50).
//
// Deciding per period fixes both exactly rather than approximately: an
// admitted period contains one full copy of the pattern, so every phase of it
// appears inside every admitted period. Density is untouched -- the same
// fraction of periods is admitted as the fraction of pixels was before -- and
// each pattern keeps its own primary/secondary ratio at every one of the 17
// levels, including the lowest.
//
// The cost, stated plainly: the translucency screen is one pattern period
// coarser for these inks, so a low-opacity wash clumps at the pattern's own
// grain (2x2 today) instead of the Bayer cell's. That is the trade -- a
// slightly chunkier screen in exchange for a two-colour ink that is actually
// two colours.
//
// Floor division, not `>> 1`: the period comes from the pattern itself, so a
// pattern wider than 2 keeps its periods aligned to the same boundaries
// `wrap` uses. Negative coordinates floor consistently, which is what keeps
// the screen anchored to the sheet rather than to the stroke.
export function passesPatternOpacity(patternName, x, y, opacity) {
  const p = PATTERNS[patternName] ?? PATTERNS.checker;
  return passesOpacity(Math.floor(x / p.width), Math.floor(y / p.height), opacity);
}
