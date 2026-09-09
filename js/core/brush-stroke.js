// The mask phase: a pointer path becomes a list of stamp placements.
//
// Randomness here is NOT seeded for undo's sake -- strokes commit as
// before/after pixel patches, so undo replays bytes and is already exact.
// It is seeded because shape tools restore and fully re-rasterize on every
// pointer move (drawing-engine.js:360). Without a stable seed a scattered
// line would reshuffle under the cursor on every mouse move.
//
// For that to hold, a stamp's randomness must depend on its INDEX, not on
// how many random numbers have been drawn before it -- otherwise
// re-rasterizing a shorter prefix would produce different offsets.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

export function strokeStamps(points, mask, seed) {
  const spacing = Math.max(1, mask.spacing ?? 1);
  const scatter = Math.max(0, mask.scatter ?? 0);
  const jitterRotate = !!mask.rotateJitter;
  const stamps = [];
  for (let i = 0; i < points.length; i += spacing) {
    const p = points[i];
    // Index by position along the path, not by push order, so a prefix
    // re-rasterizes identically.
    const index = i;
    let x = p.x, y = p.y;
    if (scatter > 0) {
      const rx = stampRandom(seed, index, 'sx');
      const ry = stampRandom(seed, index, 'sy');
      x += Math.round((rx * 2 - 1) * scatter);
      y += Math.round((ry * 2 - 1) * scatter);
    }
    const rotate = jitterRotate
      ? QUARTER_TURNS[Math.floor(stampRandom(seed, index, 'rot') * 4) % 4]
      : 0;
    stamps.push({ x, y, rotate });
  }
  return stamps;
}
