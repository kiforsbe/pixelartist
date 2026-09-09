// Shared seeded PRNG. Used by both brush-stroke.js (per-stamp scatter and
// rotate-jitter draws) and pixelSnapper.js (k-means++ centroid seeding) --
// both need a deterministic-but-reproducible sequence from an integer seed,
// and neither module should depend on the other to get it.

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
