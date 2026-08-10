// js/modes/tiles/application/geometry/terrain-set-geometry.js
import {
  blobIndexToMask, maskToBlobIndex, SIXTEEN_TILE_INDICES,
} from '../../../../core/blob47.js';
import { BLOB47_8X6_RAW, BLOB47_7X7_RAW } from '../../../../core/blob47templates.js';

// Groups the 47 canonical blob indices by how many of the 8 bits are set
// in their representative mask (the "staircase" layout: isolated alone,
// then single-edge variants, etc, up to the full 8-neighbor surround).
export function blobStaircaseGroups() {
  const groups = new Map();
  blobIndexToMask.forEach((mask, blobIndex) => {
    let count = 0;
    for (let b = 1; b <= 128; b <<= 1) if (mask & b) count++;
    if (!groups.has(count)) groups.set(count, []);
    groups.get(count).push(blobIndex);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, indices]) => indices);
}

// Mirrors the real reference template's row/col arrangement (not an
// arbitrary ascending-index chunking) so this cosmetic view is a 1:1
// visual match for the actual tilemap when that built-in preset was used
// to fill the slots -- including duplicate cells (e.g. the 7x7 template's
// three "isolated" corners), which render as separate cells for the same
// underlying slot, exactly as they appear in the source tilemap.
export function gridFromRawTemplate(rawGrid) {
  return rawGrid.map(rowVals => rowVals.map(raw => maskToBlobIndex[raw]));
}

export function slotGroupsForViewMode(mode) {
  if (mode === 'grid8x6') return gridFromRawTemplate(BLOB47_8X6_RAW);
  if (mode === 'grid7x7') return gridFromRawTemplate(BLOB47_7X7_RAW);
  if (mode === 'sixteen') return [[...SIXTEEN_TILE_INDICES].sort((a, b) => a - b)];
  return blobStaircaseGroups();
}
