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
import { maskToBlobIndex, SIXTEEN_TILE_INDICES } from './blob47.js';

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

export const BUILTIN_LAYOUT_PRESETS = [
  {
    name: 'Blob-47 (8×6)', cols: 8, rows: 6,
    cells: cellsFromRawGrid(BLOB47_8X6_RAW),
  },
  {
    name: 'Blob-47 (7×7)', cols: 7, rows: 7,
    cells: cellsFromRawGrid(BLOB47_7X7_RAW),
  },
  {
    name: '16-tile (4×4, ascending)', cols: 4, rows: 4,
    cells: Array.from({ length: 16 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), blobIndex: [...SIXTEEN_TILE_INDICES][i] })),
  },
];
