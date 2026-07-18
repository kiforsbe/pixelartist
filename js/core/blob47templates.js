// Real blob-47 reference templates (raw neighbor bitmasks, top-left to
// bottom-right, using blob47.js's NEIGHBOR_BITS weights: N=1, NE=2, E=4,
// SE=8, S=16, SW=32, W=64, NW=128). Each raw byte is resolved through
// maskToBlobIndex to its canonical blobIndex. Both templates have a
// duplicated cell (known convention of the reference sheets these were
// transcribed from): raw byte 255 (full 8-neighbor surround) repeats twice
// in the 8x6 template; raw byte 0 (isolated) repeats three times -- at the
// top-left, top-right, and bottom-left corners -- in the 7x7 template.
// Every other one of the 47 canonical indices appears exactly once per
// template.
//
// Pure, DOM-free -- see js/core/blob47.js's header comment for why this
// codebase separates pure logic (core/) from DOM construction (ui/).
// Pixel-verified against their source reference images, bundled at
// assets/blob47-templates/blob47-8x6-reference.png and
// blob47-7x7-reference.png: tests/blob47templates.test.mjs decodes those
// PNGs directly and re-derives each cell's raw byte from its own 8-color
// neighbor fill (not the images' baked-in text labels), then asserts the
// arrays below match exactly. If you edit these arrays, that test is the
// regression guard -- update the reference images (and re-run the test to
// confirm) rather than hand-editing both out of sync.
import { maskToBlobIndex, blobIndexToMask, SIXTEEN_TILE_INDICES, DIRECTION_OFFSETS, resolveTerrainSlot } from './blob47.js';

export const BLOB47_8X6_RAW = [
  [20, 68, 92, 112, 28, 124, 116, 80],
  [21, 84, 87, 221, 127, 255, 241, 17],
  [29, 117, 85, 95, 247, 215, 209, 1],
  [23, 213, 81, 31, 253, 125, 113, 16],
  [5, 69, 93, 119, 223, 255, 245, 65],
  [0, 4, 71, 193, 7, 199, 197, 64],
];
export const BLOB47_7X7_RAW = [
  [0, 4, 92, 124, 116, 80, 0],
  [16, 20, 87, 223, 241, 21, 64],
  [29, 117, 85, 71, 221, 125, 112],
  [31, 253, 113, 28, 127, 247, 209],
  [23, 199, 213, 95, 255, 245, 81],
  [5, 84, 93, 119, 215, 193, 17],
  [0, 1, 7, 197, 69, 68, 65],
];

export function cellsFromRawGrid(rawGrid) {
  const cells = [];
  rawGrid.forEach((rowVals, row) => rowVals.forEach((raw, col) => {
    cells.push({ col, row, blobIndex: maskToBlobIndex[raw] });
  }));
  return cells;
}

// sourceImage/sourceCellSize point at the bundled reference PNGs these
// presets were pixel-derived from (see tests/blob47templates.test.mjs).
// Only the two Blob-47 presets have a reference image to import art from;
// the 16-tile preset is a synthetic ascending layout with no source art.
export const BUILTIN_LAYOUT_PRESETS = [
  {
    name: 'Blob-47 (8×6)', cols: 8, rows: 6,
    cells: cellsFromRawGrid(BLOB47_8X6_RAW),
    sourceImage: 'assets/blob47-templates/blob47-8x6-reference.png', sourceCellSize: 32,
  },
  {
    name: 'Blob-47 (7×7)', cols: 7, rows: 7,
    cells: cellsFromRawGrid(BLOB47_7X7_RAW),
    sourceImage: 'assets/blob47-templates/blob47-7x7-reference.png', sourceCellSize: 32,
  },
  {
    name: '16-tile (4×4, ascending)', cols: 4, rows: 4,
    cells: Array.from({ length: 16 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), blobIndex: [...SIXTEEN_TILE_INDICES][i] })),
  },
];

// ---------------------------------------------------------------- neighbor preview
//
// The tile editor's live neighbor preview (js/ui/tileeditor.js) needs, for a
// terrain-set tile with a given blobIndex, a PLAUSIBLE blobIndex for each
// directly-connected neighbor direction -- not just "the same tile again".
// There's no way to derive that from pure bitmask math alone (a center
// tile's mask only pins down the ONE bit pointing back at it; the
// neighbor's remaining 7 bits are unconstrained). Instead, reuse the
// Blob-47 8x6 reference template as a fixed, professionally-authored
// convention: each cell's grid-adjacent neighbor (up/down/left/right/
// diagonal) in that template is already a coherent, real-world-verified
// choice of "what a smooth continuation looks like" for every direction a
// tile can connect in. This holds regardless of which layout preset (if
// any) the terrain set being edited was actually seeded from -- the 8x6
// template is used purely as an internal adjacency reference, not as a
// claim about the terrain set's own art layout.
const BLOB_8X6_INDEX_GRID = BLOB47_8X6_RAW.map(row => row.map(raw => maskToBlobIndex[raw]));

// blobIndex -> its first {col, row} in the 8x6 template. (blobIndex 255's
// canonical bucket appears twice in the raw grid -- see header comment;
// either occurrence is a valid adjacency reference, so the first one found
// is kept.)
const BLOB_8X6_POSITION = new Map();
BLOB_8X6_INDEX_GRID.forEach((row, r) => row.forEach((blobIndex, c) => {
  if (!BLOB_8X6_POSITION.has(blobIndex)) BLOB_8X6_POSITION.set(blobIndex, { col: c, row: r });
}));

// The blobIndex one template-grid step (dx, dy) away from `blobIndex`, or
// null if that step falls outside the 8x6 grid (shouldn't happen for any
// (blobIndex, direction) pair where the direction's bit is actually set in
// blobIndex's own mask -- the template's edge rows/columns are exactly the
// shapes whose masks don't reach further outward -- but checked instead of
// assumed, since an out-of-bounds read here would silently pull from the
// wrong table row).
export function neighborBlobIndex(blobIndex, dx, dy) {
  const pos = BLOB_8X6_POSITION.get(blobIndex);
  if (!pos) return null;
  const row = BLOB_8X6_INDEX_GRID[pos.row + dy];
  const neighbor = row ? row[pos.col + dx] : undefined;
  return neighbor ?? null;
}

// For each of `tile`'s 8 neighbor directions where its own blobIndex
// connects (mask bit set), resolves the actual tile assigned to that
// direction's plausible neighbor blobIndex within `terrainSet` (via
// resolveTerrainSlot, so flip/rotate-derived slots preview correctly too).
// Directions with no connection, or with no resolvable tile, come back
// with tileId: null so the caller skips drawing that cell.
export function terrainNeighborPreviewCells(tile, terrainSet) {
  const ownMask = blobIndexToMask[tile.blobIndex];
  return DIRECTION_OFFSETS.map(({ dx, dy, bit }) => {
    const empty = { dx, dy, tileId: null, flipH: false, flipV: false, rotate: 0 };
    if (!(ownMask & bit)) return empty;
    const neighborIndex = neighborBlobIndex(tile.blobIndex, dx, dy);
    if (neighborIndex == null) return empty;
    const resolved = resolveTerrainSlot(terrainSet, neighborIndex);
    if (!resolved) return empty;
    return { dx, dy, tileId: resolved.tileId, flipH: resolved.flipH, flipV: resolved.flipV, rotate: resolved.rotate };
  });
}
