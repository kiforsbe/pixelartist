// `mask.size` applied to a CUSTOM mask.
//
// rasterizeMask read `size` and then ignored it on every custom path, so the
// Size field and [ / ] were inert for imported and captured brushes -- a
// control that looked live and did nothing. It is now a scale factor: the
// bitmap owns the shape, and size N replicates every cell into an NxN block.
//
// Size 1 must stay pixel-identical to the old behaviour, since every custom
// brush already in a user's library carries whatever size it happened to be
// normalized to and would otherwise change shape on load.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rasterizeMask, maskGridFor, effectiveMaskSize, normalizeBrush,
  MAX_CUSTOM_BITMAP_DIM, MAX_MASK_SIZE,
} from '../js/core/brushes.js';

// An L, deliberately asymmetric in BOTH axes: a scale that transposed the
// grid, or replicated along one axis only, produces a different shape here
// rather than the same one. A symmetric fixture would hide all three bugs.
//   #.
//   #.
//   ##
const L_BITS = Uint8Array.from([1, 0, 1, 0, 1, 1]);
const L_W = 2, L_H = 3;

function customMask(extra = {}) {
  return {
    kind: 'custom',
    bitmap: { width: L_W, height: L_H, bits: Uint8Array.from(L_BITS) },
    ...extra,
  };
}

// Renders a grid as rows of '#'/'.' so a failure prints the actual shape
// rather than 96 numbers.
function render(grid) {
  const rows = [];
  for (let y = 0; y < grid.height; y++) {
    let row = '';
    for (let x = 0; x < grid.width; x++) row += grid.bits[y * grid.width + x] ? '#' : '.';
    rows.push(row);
  }
  return rows.join('\n');
}

test('size 1 renders a custom bitmap at its native resolution, unchanged', () => {
  const grid = rasterizeMask(customMask({ size: 1 }));
  assert.equal(grid.width, L_W);
  assert.equal(grid.height, L_H);
  assert.equal(render(grid), '#.\n#.\n##');

  // A mask with no `size` at all takes the same path -- this is what every
  // raw bitmap in the existing tests passes, so the two must not diverge.
  assert.deepEqual([...rasterizeMask(customMask()).bits], [...grid.bits]);
});

test('size N replicates every cell into an NxN block, preserving the shape', () => {
  const grid = rasterizeMask(customMask({ size: 3 }));
  assert.equal(grid.width, L_W * 3);
  assert.equal(grid.height, L_H * 3);
  // Asserted positionally, not by set-bit COUNT: a grid that scaled the
  // wrong axis, or smeared the last row down, has the same count as this one.
  assert.equal(render(grid), [
    '###...',
    '###...',
    '###...',
    '###...',
    '###...',
    '###...',
    '######',
    '######',
    '######',
  ].join('\n'));
});

test('the RGBA branch scales on the same rule as the bits branch', () => {
  // A custom mask arrives as EITHER a 1-bit grid or an RGBA buffer whose
  // opaque pixels define coverage, and those are separate code paths in
  // rasterizeMask -- scaling one and not the other is the easy miss.
  const data = new Uint8Array(L_W * L_H * 4);
  for (let i = 0; i < L_BITS.length; i++) data[i * 4 + 3] = L_BITS[i] ? 255 : 0;
  const rgba = { kind: 'custom', size: 2, bitmap: { width: L_W, height: L_H, data } };

  const fromRgba = rasterizeMask(rgba);
  const fromBits = rasterizeMask(customMask({ size: 2 }));
  assert.equal(fromRgba.width, L_W * 2);
  assert.equal(fromRgba.height, L_H * 2);
  assert.equal(render(fromRgba), render(fromBits));
});

test('the stamp payload is replicated with the bits, not left behind', () => {
  // `colors` is what `stamp` ink paints. It is indexed against the GRID, so a
  // scale that grew the bits and left `colors` at native length would give a
  // scaled multi-colour brush a mostly-null payload -- it would select fine,
  // preview fine, and paint nothing over most of its own area.
  const mask = customMask({ size: 2 });
  mask.colors = [[255, 0, 0, 255], null, [0, 255, 0, 255], null, [0, 0, 255, 255], [255, 255, 0, 255]];

  const grid = rasterizeMask(mask);
  assert.equal(grid.colors.length, grid.bits.length);
  // Top-left source cell is red, and its whole 2x2 block must be red.
  for (const i of [0, 1, grid.width, grid.width + 1]) {
    assert.deepEqual(grid.colors[i], [255, 0, 0, 255], `cell ${i} lost the payload`);
  }
  // Bottom-right source cell is yellow; it lands in the last 2x2 block.
  const last = grid.bits.length - 1;
  assert.deepEqual(grid.colors[last], [255, 255, 0, 255]);
  // And every set bit carries a colour, which is the invariant `stamp` relies
  // on -- attachColors establishes it at native size and scaling must keep it.
  for (let i = 0; i < grid.bits.length; i++) {
    if (grid.bits[i]) assert.ok(grid.colors[i], `set bit ${i} has no colour`);
  }
});

test('a bitmap with no payload gains no payload from scaling', () => {
  // The other half of the rule above: `stamp` checks for `colors` to decide
  // whether a brush has its own pixels, so inventing an all-null array on a
  // plain 1-bit mask would change what that check reports.
  const grid = rasterizeMask(customMask({ size: 4 }));
  assert.equal(grid.colors, undefined);
});

test('scale is capped so the OUTPUT grid stays within MAX_CUSTOM_BITMAP_DIM', () => {
  // Source dimensions are clamped to 256; without a matching cap on the
  // output, a 200x200 import at size 16 allocates ~10M cells per stamp, on
  // every stamp of every stroke.
  const big = {
    kind: 'custom',
    size: MAX_MASK_SIZE,
    bitmap: { width: 200, height: 200, bits: new Uint8Array(200 * 200).fill(1) },
  };
  const grid = rasterizeMask(big);
  assert.ok(grid.width <= MAX_CUSTOM_BITMAP_DIM, `width ${grid.width} exceeded the cap`);
  assert.ok(grid.height <= MAX_CUSTOM_BITMAP_DIM, `height ${grid.height} exceeded the cap`);
  assert.equal(grid.bits.length, grid.width * grid.height);
  // It degrades to the largest scale that FITS rather than collapsing to 1:
  // 200 fits once in 256, so this one legitimately lands back on native size.
  assert.equal(grid.width, 200);

  // A bitmap small enough to scale still scales, so the cap above is not
  // passing by disabling the feature outright.
  const small = { kind: 'custom', size: 4, bitmap: { width: 50, height: 50, bits: new Uint8Array(2500).fill(1) } };
  assert.equal(rasterizeMask(small).width, 200);

  // And one that scales PART of the way: 100x100 at size 16 wants 1600 and
  // gets the largest whole multiple that fits, not 256 exactly.
  const mid = { kind: 'custom', size: 16, bitmap: { width: 100, height: 100, bits: new Uint8Array(10000).fill(1) } };
  assert.equal(rasterizeMask(mid).width, 200);
});

test('generated masks are untouched by the custom scaling path', () => {
  // The control for the whole file: `size` still means a DIMENSION for
  // square and circle, so a change that made it mean "scale" everywhere
  // would turn Square 4 into a 16x16 block.
  for (let size = 1; size <= MAX_MASK_SIZE; size++) {
    const sq = rasterizeMask({ kind: 'square', size });
    assert.equal(sq.width, size, `square ${size} changed dimension`);
    assert.equal(sq.height, size);
  }
  const circle = rasterizeMask({ kind: 'circle', size: 5 });
  assert.equal(circle.width, 5);
  assert.equal(circle.height, 5);
});

test('a scaled custom mask still rotates and flips through maskGridFor', () => {
  // maskGridFor composes rasterizeMask with rotate/flip. Scaling happens
  // first, so the transforms operate on the scaled grid -- verified here
  // rather than assumed, because a 2x3 bitmap rotating to 3x2 is exactly
  // where a hardcoded dimension would show up.
  // `rotate` is in DEGREES, not quarter-steps (rotateMaskGrid rounds to the
  // nearest 90), so a quarter turn is 90 -- passing 1 rounds to 0 and the
  // assertion below would be checking an unrotated grid.
  const upright = maskGridFor(customMask({ size: 2 }));
  assert.equal(upright.width, L_W * 2);
  assert.equal(upright.height, L_H * 2);

  const grid = maskGridFor(customMask({ size: 2, rotate: 90 }));
  assert.equal(grid.width, L_H * 2);
  assert.equal(grid.height, L_W * 2);
});

test('pressure-driven size scales a custom mask like any other', () => {
  // effectiveMaskSize is kind-agnostic and always was; it simply had no
  // effect on a custom mask while rasterizeMask ignored the number. This is
  // the test that the two halves are now actually connected.
  const brush = normalizeBrush({
    mask: customMask({ size: 1 }),
    pressure: { target: 'size', min: 1, max: 4, curve: 'linear' },
  });
  assert.equal(effectiveMaskSize(brush, 1, 'pen'), 4);
  const grid = rasterizeMask({ ...brush.mask, size: effectiveMaskSize(brush, 1, 'pen') });
  assert.equal(grid.width, L_W * 4);

  // A mouse reports no usable pressure, so it paints at the stored size.
  assert.equal(effectiveMaskSize(brush, 1, 'mouse'), 1);
});
