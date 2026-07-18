// Blob-47 autotile bitmask algorithm. Pure, DOM-free -- see
// docs/superpowers/specs/2026-07-17-terrain-sets-autotile-design.md for the
// full derivation. Bit weights verified against the source "Wang blob"
// tileset reference: clockwise from North, alternating edge/corner.
export const NEIGHBOR_BITS = { N: 1, NE: 2, E: 4, SE: 8, S: 16, SW: 32, W: 64, NW: 128 };

// [corner, adjacentA, adjacentB] -- a corner bit only counts when both its
// flanking cardinal bits are also set (the tie-break rule that collapses
// 256 raw masks down to 47 canonical configurations).
const CORNERS = [
  [NEIGHBOR_BITS.NE, NEIGHBOR_BITS.N, NEIGHBOR_BITS.E],
  [NEIGHBOR_BITS.SE, NEIGHBOR_BITS.E, NEIGHBOR_BITS.S],
  [NEIGHBOR_BITS.SW, NEIGHBOR_BITS.S, NEIGHBOR_BITS.W],
  [NEIGHBOR_BITS.NW, NEIGHBOR_BITS.W, NEIGHBOR_BITS.N],
];

function canonicalize(rawMask) {
  let m = rawMask;
  for (const [corner, a, b] of CORNERS) {
    if ((m & corner) && !((m & a) && (m & b))) m &= ~corner;
  }
  return m;
}

function buildBlobTable() {
  const canonToIndex = new Map();
  const blobIndexToMask = [];
  const maskToBlobIndex = new Array(256);
  for (let raw = 0; raw < 256; raw++) {
    const canon = canonicalize(raw);
    if (!canonToIndex.has(canon)) {
      canonToIndex.set(canon, blobIndexToMask.length);
      blobIndexToMask.push(canon);
    }
    maskToBlobIndex[raw] = canonToIndex.get(canon);
  }
  return { maskToBlobIndex, blobIndexToMask };
}

export const { maskToBlobIndex, blobIndexToMask } = buildBlobTable();

// ---------------------------------------------------------------- preview

export const DIRECTION_OFFSETS = [
  { dx: 0, dy: -1, bit: NEIGHBOR_BITS.N },
  { dx: 1, dy: -1, bit: NEIGHBOR_BITS.NE },
  { dx: 1, dy: 0, bit: NEIGHBOR_BITS.E },
  { dx: 1, dy: 1, bit: NEIGHBOR_BITS.SE },
  { dx: 0, dy: 1, bit: NEIGHBOR_BITS.S },
  { dx: -1, dy: 1, bit: NEIGHBOR_BITS.SW },
  { dx: -1, dy: 0, bit: NEIGHBOR_BITS.W },
  { dx: -1, dy: -1, bit: NEIGHBOR_BITS.NW },
];

// ---------------------------------------------------------------- 16-tile subset

const CARDINAL_BITS = [NEIGHBOR_BITS.N, NEIGHBOR_BITS.E, NEIGHBOR_BITS.S, NEIGHBOR_BITS.W];
// corner bit sitting between CARDINAL_BITS[i] and CARDINAL_BITS[i+1]
const CORNER_BETWEEN = [NEIGHBOR_BITS.NE, NEIGHBOR_BITS.SE, NEIGHBOR_BITS.SW, NEIGHBOR_BITS.NW];

// The "smoothest" (all geometrically-eligible corners filled) canonical
// index for a given 4-bit cardinal-only mask (a subset-sum of N/E/S/W bits).
export function sixteenTileBlobIndex(cardinalMask) {
  let full = cardinalMask;
  for (let i = 0; i < 4; i++) {
    const a = CARDINAL_BITS[i], b = CARDINAL_BITS[(i + 1) % 4];
    if ((cardinalMask & a) && (cardinalMask & b)) full |= CORNER_BETWEEN[i];
  }
  return maskToBlobIndex[full];
}

// NOTE: cardinalMask values are NOT sequential 0-15 -- they're subset-sums
// of the ACTUAL bit values {1,4,16,64} (i.e. 0,1,4,5,16,17,20,21,64,65,68,
// 69,80,81,84,85). Build the 16 valid inputs by testing bit b of a plain
// 0-15 counter and OR-ing in CARDINAL_BITS[b] when set -- passing the
// counter directly (as if 0-15 == the cardinal mask) is wrong and silently
// produces duplicate/incorrect buckets.
export const SIXTEEN_TILE_INDICES = new Set(
  Array.from({ length: 16 }, (_, i) => {
    let cardinalMask = 0;
    for (let b = 0; b < 4; b++) if (i & (1 << b)) cardinalMask |= CARDINAL_BITS[b];
    return sixteenTileBlobIndex(cardinalMask);
  })
);
const CARDINAL_MASK = CARDINAL_BITS.reduce((a, b) => a | b, 0); // 0x55

// ---------------------------------------------------------------- symmetry

function rotateMaskBy(mask, deg) {
  if (deg === 90) return ((mask << 2) | (mask >> 6)) & 0xFF;
  if (deg === 180) return ((mask << 4) | (mask >> 4)) & 0xFF;
  if (deg === 270) return ((mask << 6) | (mask >> 2)) & 0xFF;
  return mask;
}

function swapBits(mask, pairs) {
  let m = mask;
  for (const [a, b] of pairs) {
    const bitA = mask & a, bitB = mask & b;
    m = (m & ~a & ~b) | (bitA ? b : 0) | (bitB ? a : 0);
  }
  return m;
}

// mirror left-right: E<->W, NE<->NW, SE<->SW; N and S unchanged.
function flipHBits(mask) {
  return swapBits(mask, [[NEIGHBOR_BITS.E, NEIGHBOR_BITS.W], [NEIGHBOR_BITS.NE, NEIGHBOR_BITS.NW], [NEIGHBOR_BITS.SE, NEIGHBOR_BITS.SW]]);
}

// A transform is described as { rotate: 0|90|180|270, flipH: bool }, applied
// rotate-then-flipH. This pair alone spans the full 8-element dihedral
// group (4 rotations x flip-or-not) -- a separate flipV is never needed
// internally: e.g. { rotate: 180, flipH: true } already nets out to a pure
// top-bottom mirror.
export function applyDescriptor(mask, { rotate, flipH }) {
  let m = rotateMaskBy(mask, rotate);
  if (flipH) m = flipHBits(m);
  return m;
}

// Only rotate90/rotate270 (with flipH: false) are not self-inverse; every
// other descriptor (identity, rotate180, and any flipH:true reflection) is
// its own inverse.
function inverseOf(t) {
  if (!t.flipH && t.rotate === 90) return { rotate: 270, flipH: false };
  if (!t.flipH && t.rotate === 270) return { rotate: 90, flipH: false };
  return t;
}

export function enabledGroup(symmetry) {
  const rotate = symmetry?.rotate;
  const flip = symmetry?.flip;
  const rotates = rotate ? [0, 90, 180, 270] : (flip ? [0, 180] : [0]);
  const flips = flip ? [false, true] : [false];
  const group = [];
  for (const r of rotates) for (const fh of flips) group.push({ rotate: r, flipH: fh });
  return group;
}

// For each of the 47 blob indices, compute its orbit under the terrain
// set's ENABLED symmetry transforms (flip/rotate) and pick one
// representative per orbit -- preferring a 16-tile-subset member when the
// orbit contains one, else the lowest blobIndex. The representative is
// "mandatory" (draw a real tile for it); every other orbit member is
// "optional" (comes free via resolveTerrainSlot's symmetry fallback once
// the representative is assigned). With symmetry fully off, every orbit is
// a singleton, so all 47 are mandatory.
export function classifySlots(symmetry) {
  const group = enabledGroup(symmetry);
  const classification = new Map();
  const visited = new Set();
  for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
    if (visited.has(blobIndex)) continue;
    const mask = blobIndexToMask[blobIndex];
    const orbit = new Set(group.map(t => maskToBlobIndex[applyDescriptor(mask, t)]));
    const sorted = [...orbit].sort((a, b) => a - b);
    const representative = sorted.find(i => SIXTEEN_TILE_INDICES.has(i)) ?? sorted[0];
    for (const idx of orbit) {
      visited.add(idx);
      classification.set(idx, { mandatory: idx === representative, orbitRepresentative: representative });
    }
  }
  return classification;
}

// ---------------------------------------------------------------- resolution

// Resolves what should render at `blobIndex` for `terrainSet`: explicit
// assignment, else a symmetry-equivalent explicit assignment, else the
// 16-tile core representative (itself resolved the same way), else null.
export function resolveTerrainSlot(terrainSet, blobIndex) {
  const explicit = terrainSet.slots[blobIndex];
  if (explicit != null) return { tileId: explicit, flipH: false, flipV: false, rotate: 0 };

  const targetMask = blobIndexToMask[blobIndex];
  for (const t of enabledGroup(terrainSet.symmetry)) {
    if (t.rotate === 0 && !t.flipH) continue; // identity already covered above
    // t is the transform to apply to a FOUND source tile to produce the
    // target look, so the source's own mask is t's inverse applied to the
    // target mask.
    const sourceMask = applyDescriptor(targetMask, inverseOf(t));
    const candidateIndex = maskToBlobIndex[sourceMask];
    const candidateTile = terrainSet.slots[candidateIndex];
    if (candidateTile != null) {
      return { tileId: candidateTile, flipH: t.flipH, flipV: false, rotate: t.rotate };
    }
  }

  if (!SIXTEEN_TILE_INDICES.has(blobIndex)) {
    const coreIndex = sixteenTileBlobIndex(targetMask & CARDINAL_MASK);
    return resolveTerrainSlot(terrainSet, coreIndex);
  }
  return null;
}
