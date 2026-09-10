// The mask phase: a pointer path becomes a list of stamp placements.
//
// Randomness here is NOT seeded for undo's sake -- strokes commit as
// before/after pixel patches, so undo replays bytes and is already exact.
// It is seeded because shape tools restore and fully re-rasterize on every
// pointer move (drawing-engine.js:360). Without a stable seed a scattered
// line would reshuffle under the cursor on every mouse move.
//
// For that to hold, a stamp's randomness must depend on its ORDINAL along
// the stroke, not on how many random numbers have been drawn before it --
// otherwise re-rasterizing a shorter prefix would produce different
// offsets.

import { mulberry32 } from './prng.js';

export { mulberry32 };

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// Position-independent: the same (seed, index, salt) always gives the same
// value, no matter what else has been drawn.
export function stampRandom(seed, index, salt = '') {
  const mixed = (Math.imul(seed >>> 0, 2654435761) ^ Math.imul(index + 1, 40503) ^ hashString(salt)) >>> 0;
  return mulberry32(mixed)();
}

export function newStrokeSeed() {
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}

const QUARTER_TURNS = [0, 90, 180, 270];

// Bresenham stepping between two integer points, inclusive of both
// endpoints. Every step moves at most one grid cell in x and one in y, so
// consecutive entries are always path-adjacent -- never separated by a gap
// a single fast pointer-move sample could otherwise leave.
function bresenhamSegment(x0, y0, x1, y1) {
  const points = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return points;
}

// Densifies a pointer path to one entry per pixel of travel, so `spacing`
// (an integer count of pixels along the stroke, per the design doc) stays
// stable regardless of how far apart the pointer-move samples landed -- a
// fast drag must stamp exactly as densely as a slow one over the same
// distance. Each segment depends only on its own two endpoints, never on
// points after it, so the dense path of a path PREFIX is always a strict
// prefix of the dense path of the FULL path -- which is what keeps a
// shape-tool preview's re-rasterized prefix byte-identical to the same
// prefix of the eventual full stroke.
function densifyPath(points) {
  if (points.length === 0) return [];
  const dense = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length; i++) {
    const seg = bresenhamSegment(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
    for (let j = 1; j < seg.length; j++) dense.push(seg[j]);
  }
  return dense;
}

// Bounds for one stamp, used for both the dirty rect and the
// maskOutsideTarget safety net.
//
// Scatter widens the box in BOTH directions: a scattered stamp can land to
// the left of and above its path point as easily as right and below. The old
// `brushSize - 1` bound only ever extended right and down, which is exactly
// why it cannot simply be reused here.
export function strokeBounds(x, y, gridW, gridH, scatter = 0) {
  const halfX = (gridW - 1) >> 1, halfY = (gridH - 1) >> 1;
  return {
    x0: x - halfX - scatter,
    y0: y - halfY - scatter,
    x1: x + (gridW - 1 - halfX) + scatter,
    y1: y + (gridH - 1 - halfY) + scatter,
  };
}

export function strokeStamps(points, mask, seed) {
  const spacing = Math.max(1, mask.spacing ?? 1);
  const scatter = Math.max(0, mask.scatter ?? 0);
  const jitterRotate = !!mask.rotateJitter;
  const dense = densifyPath(points);
  const stamps = [];
  let stampIndex = 0;
  for (let i = 0; i < dense.length; i += spacing) {
    const p = dense[i];
    let x = p.x, y = p.y;
    if (scatter > 0) {
      const rx = stampRandom(seed, stampIndex, 'sx');
      const ry = stampRandom(seed, stampIndex, 'sy');
      // Each axis is drawn independently, so the jitter region is a square
      // of half-width `scatter`, not a disc -- diagonal reach is
      // scatter*sqrt(2), not scatter.
      x += Math.round((rx * 2 - 1) * scatter);
      y += Math.round((ry * 2 - 1) * scatter);
    }
    const rotate = jitterRotate
      ? QUARTER_TURNS[Math.floor(stampRandom(seed, stampIndex, 'rot') * 4)]
      : 0;
    stamps.push({ x, y, rotate });
    stampIndex++;
  }
  return stamps;
}
