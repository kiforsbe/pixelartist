import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BLOB47_8X6_RAW, BLOB47_7X7_RAW, neighborBlobIndex, terrainNeighborPreviewCells } from '../js/core/blob47templates.js';
import { maskToBlobIndex } from '../js/core/blob47.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dirname, '..', 'assets', 'blob47-templates');

// Minimal PNG decoder for exactly the format the bundled reference images
// use (8-bit indexed color, non-interlaced) -- not a general-purpose
// decoder. js/app/pngcodec.js can't be reused here: it delegates decoding
// to createImageBitmap, a browser-only API this node:test file can't call.
// Throws clearly rather than silently misdecoding an unsupported format.
function decodeIndexedPng(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'not a PNG file');
  let offset = 8;
  let width, height, bitDepth, colorType, interlace;
  let palette = null;
  let alphaByIndex = null;
  const idatChunks = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = [];
      for (let i = 0; i < data.length; i += 3) palette.push([data[i], data[i + 1], data[i + 2]]);
    } else if (type === 'tRNS') {
      alphaByIndex = [...data];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + len + 4; // length + type + data + CRC
  }
  assert.equal(bitDepth, 8, `unsupported bitDepth ${bitDepth} (decoder only handles 8)`);
  assert.equal(colorType, 3, `unsupported colorType ${colorType} (decoder only handles indexed/3)`);
  assert.equal(interlace, 0, 'unsupported interlaced PNG');
  assert.ok(palette, 'missing PLTE chunk');

  const raw = inflateSync(Buffer.concat(idatChunks));
  const bpp = 1; // 1 byte/pixel for 8-bit indexed color
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height); // palette indices
  let prevRow = new Uint8Array(stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset++];
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const recon = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? recon[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      let v = row[x];
      if (filterType === 1) v += a;
      else if (filterType === 2) v += b;
      else if (filterType === 3) v += Math.floor((a + b) / 2);
      else if (filterType === 4) v += paeth(a, b, c);
      else if (filterType !== 0) throw new Error(`unsupported filter type ${filterType}`);
      recon[x] = v & 0xff;
    }
    pixels.set(recon, y * stride);
    prevRow = recon;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++) {
    const idx = pixels[i];
    const [r, g, b] = palette[idx];
    const a = alphaByIndex && idx < alphaByIndex.length ? alphaByIndex[idx] : 255;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, data: rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---- derive each cell's raw neighbor bitmask straight from the image's
// own two-color fill (not its baked-in text labels) -- mirrors the
// authoring method used to originally verify BLOB47_8X6_RAW/7X7_RAW.
// Both reference images share this exact two-color palette; a color
// mismatch here means the reference image changed and the raw grids
// need re-deriving, not that this method is wrong.
const BACKGROUND = [68, 153, 200];
const TERRAIN = [202, 202, 73];
const NEIGHBOR_BITS = { N: 1, NE: 2, E: 4, SE: 8, S: 16, SW: 32, W: 64, NW: 128 };
// 5-point line per direction, from near-edge inward, to survive the ~2px
// black outline stroke that follows the shape boundary.
const DIR_LINES = {
  N: [[16, 2], [16, 4], [16, 6], [16, 8], [16, 10]],
  NE: [[29, 3], [27, 5], [25, 7], [23, 9], [21, 11]],
  E: [[30, 16], [28, 16], [26, 16], [24, 16], [22, 16]],
  SE: [[29, 29], [27, 27], [25, 25], [23, 23], [21, 21]],
  S: [[16, 30], [16, 28], [16, 26], [16, 24], [16, 22]],
  SW: [[3, 29], [5, 27], [7, 25], [9, 23], [11, 21]],
  W: [[2, 16], [4, 16], [6, 16], [8, 16], [10, 16]],
  NW: [[3, 3], [5, 5], [7, 7], [9, 9], [11, 11]],
};

function colorAt(bmp, x, y) {
  const i = (y * bmp.width + x) * 4;
  return [bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]];
}
function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function classifyPoint(c) {
  const db = dist2(c, BACKGROUND), dt = dist2(c, TERRAIN);
  if (Math.min(db, dt) > 400) return null; // black outline or text -- not a fill color
  return db < dt ? 0 : 1;
}
function classifyDir(bmp, ox, oy, dirName) {
  const votes = { 0: 0, 1: 0 };
  for (const [dx, dy] of DIR_LINES[dirName]) {
    const bit = classifyPoint(colorAt(bmp, ox + dx, oy + dy));
    if (bit !== null) votes[bit]++;
  }
  assert.ok(votes[0] + votes[1] > 0, `${dirName} at (${ox},${oy}): every sample point hit neither reference color`);
  return votes[1] > votes[0] ? 1 : 0;
}
function deriveMaskGrid(bmp, cols, rows, tileSize) {
  const grid = [];
  for (let row = 0; row < rows; row++) {
    const rowVals = [];
    for (let col = 0; col < cols; col++) {
      const ox = col * tileSize, oy = row * tileSize;
      let mask = 0;
      for (const name of Object.keys(NEIGHBOR_BITS)) {
        if (classifyDir(bmp, ox, oy, name)) mask |= NEIGHBOR_BITS[name];
      }
      rowVals.push(mask);
    }
    grid.push(rowVals);
  }
  return grid;
}

test('BLOB47_8X6_RAW matches its bundled reference image, re-derived from the art itself', () => {
  const bmp = decodeIndexedPng(readFileSync(path.join(ASSET_DIR, 'blob47-8x6-reference.png')));
  assert.equal(bmp.width, 256);
  assert.equal(bmp.height, 192);
  const derived = deriveMaskGrid(bmp, 8, 6, 32);
  assert.deepEqual(derived, BLOB47_8X6_RAW);
});

test('BLOB47_7X7_RAW matches its bundled reference image, re-derived from the art itself', () => {
  const bmp = decodeIndexedPng(readFileSync(path.join(ASSET_DIR, 'blob47-7x7-reference.png')));
  assert.equal(bmp.width, 224);
  assert.equal(bmp.height, 224);
  const derived = deriveMaskGrid(bmp, 7, 7, 32);
  assert.deepEqual(derived, BLOB47_7X7_RAW);
});

// Reported bug: mask 85 (N+E+S+W, no corners) sits at (col:2, row:2) in the
// 8x6 template (row2 = [29, 117, 85, 95, 247, 215, 209, 1]) -- its N/S/E/W
// grid-adjacent neighbors are masks 87/81/95/117, not itself.
test('neighborBlobIndex: mask-85 example matches the 8x6 reference template exactly', () => {
  const center = maskToBlobIndex[85];
  assert.equal(neighborBlobIndex(center, 0, -1), maskToBlobIndex[87]); // N
  assert.equal(neighborBlobIndex(center, 0, 1), maskToBlobIndex[81]); // S
  assert.equal(neighborBlobIndex(center, 1, 0), maskToBlobIndex[95]); // E
  assert.equal(neighborBlobIndex(center, -1, 0), maskToBlobIndex[117]); // W
});

test('neighborBlobIndex returns null one step past the 8x6 grid edge', () => {
  // top-left cell (mask 20, col:0 row:0) has no tile further north or west.
  assert.equal(neighborBlobIndex(maskToBlobIndex[20], 0, -1), null);
  assert.equal(neighborBlobIndex(maskToBlobIndex[20], -1, 0), null);
});

test('terrainNeighborPreviewCells: mask-85 center resolves distinct N/S/E/W tiles from the terrain set, not itself', () => {
  const center = maskToBlobIndex[85];
  const tile = { id: 'center-tile', blobIndex: center };
  const terrainSet = {
    symmetry: { flip: false, rotate: false },
    slots: {
      [maskToBlobIndex[87]]: 'tile-N',
      [maskToBlobIndex[81]]: 'tile-S',
      [maskToBlobIndex[95]]: 'tile-E',
      [maskToBlobIndex[117]]: 'tile-W',
    },
  };
  const cells = terrainNeighborPreviewCells(tile, terrainSet);
  const byDir = Object.fromEntries(cells.map(c => [`${c.dx},${c.dy}`, c]));
  assert.equal(byDir['0,-1'].tileId, 'tile-N');
  assert.equal(byDir['0,1'].tileId, 'tile-S');
  assert.equal(byDir['1,0'].tileId, 'tile-E');
  assert.equal(byDir['-1,0'].tileId, 'tile-W');
  // corner directions carry no connection in mask 85 -- must stay empty,
  // never fall back to the center tile itself.
  for (const [dx, dy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
    assert.equal(byDir[`${dx},${dy}`].tileId, null);
  }
});

test('terrainNeighborPreviewCells: unresolved neighbor slot stays empty rather than showing the center tile', () => {
  const center = maskToBlobIndex[85];
  const tile = { id: 'center-tile', blobIndex: center };
  const terrainSet = { symmetry: { flip: false, rotate: false }, slots: {} };
  const cells = terrainNeighborPreviewCells(tile, terrainSet);
  assert.ok(cells.every(c => c.tileId === null));
});
