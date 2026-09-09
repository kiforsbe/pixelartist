import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { rasterizeMask, rotateMaskGrid, flipMaskGrid, maskGridFor } from '../js/core/brushes.js';

function countSet(grid) {
  let n = 0;
  for (const b of grid.bits) if (b) n++;
  return n;
}

test('square mask is fully covered at every size', () => {
  for (let size = 1; size <= 16; size++) {
    const grid = rasterizeMask(normalizeBrush({ mask: { kind: 'square', size } }).mask);
    assert.equal(grid.width, size);
    assert.equal(grid.height, size);
    assert.equal(countSet(grid), size * size);
  }
});

test('circle mask is symmetric and strictly smaller than its square', () => {
  const grid = rasterizeMask(normalizeBrush({ mask: { kind: 'circle', size: 5 } }).mask);
  assert.equal(grid.width, 5);
  // Corners are outside the disc.
  assert.equal(grid.bits[0], 0);
  assert.equal(grid.bits[4], 0);
  assert.equal(grid.bits[20], 0);
  assert.equal(grid.bits[24], 0);
  // Center row is solid.
  for (let x = 0; x < 5; x++) assert.equal(grid.bits[2 * 5 + x], 1);
  assert.ok(countSet(grid) < 25);
});

test('circle size 1 and 2 stay solid -- a disc that small has no meaningful curve', () => {
  assert.equal(countSet(rasterizeMask({ kind: 'circle', size: 1 })), 1);
  assert.equal(countSet(rasterizeMask({ kind: 'circle', size: 2 })), 4);
});

test('rotating four times returns the original grid exactly', () => {
  const src = rasterizeMask({ kind: 'circle', size: 5 });
  let g = src;
  for (let i = 0; i < 4; i++) g = rotateMaskGrid(g, 90);
  assert.deepEqual([...g.bits], [...src.bits]);
});

test('every quarter turn preserves the set-pixel count -- rotation is lossless', () => {
  const src = rasterizeMask({ kind: 'circle', size: 7 });
  const n = countSet(src);
  for (const deg of [0, 90, 180, 270]) {
    assert.equal(countSet(rotateMaskGrid(src, deg)), n, `rotate ${deg}`);
  }
});

test('rotate 90 transposes a known asymmetric grid', () => {
  // 3x3 with only the top-left pixel set.
  const src = { width: 3, height: 3, bits: Uint8Array.from([1,0,0, 0,0,0, 0,0,0]) };
  const r = rotateMaskGrid(src, 90);
  // Top-left goes to top-right under a clockwise quarter turn.
  assert.equal(r.bits[2], 1);
  assert.equal(countSet(r), 1);
});

test('flipping twice on the same axis is the identity', () => {
  const src = rasterizeMask({ kind: 'circle', size: 6 });
  assert.deepEqual([...flipMaskGrid(flipMaskGrid(src, true, false), true, false).bits], [...src.bits]);
  assert.deepEqual([...flipMaskGrid(flipMaskGrid(src, false, true), false, true).bits], [...src.bits]);
});

test('maskGridFor applies the brush rotate and flips together', () => {
  const mask = normalizeBrush({ mask: { kind: 'square', size: 3, rotate: 90, flipH: true } }).mask;
  const grid = maskGridFor(mask, {});
  // A solid square is invariant under both, so the count must be unchanged.
  assert.equal(countSet(grid), 9);
});

test('maskGridFor honors a per-stamp rotation override for rotateJitter', () => {
  const src = { width: 3, height: 3, bits: Uint8Array.from([1,0,0, 0,0,0, 0,0,0]) };
  const mask = { kind: 'custom', bitmap: src, rotate: 0, flipH: false, flipV: false };
  const grid = maskGridFor(mask, { rotate: 180 });
  assert.equal(grid.bits[8], 1);
});
