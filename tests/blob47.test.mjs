import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maskToBlobIndex, blobIndexToMask,
  SIXTEEN_TILE_INDICES, sixteenTileBlobIndex, resolveTerrainSlot, classifySlots,
} from '../js/core/blob47.js';

test('maskToBlobIndex reduces 256 raw masks to exactly 47 canonical buckets', () => {
  assert.equal(blobIndexToMask.length, 47);
  const seen = new Set(maskToBlobIndex);
  assert.equal(seen.size, 47);
  for (const idx of maskToBlobIndex) assert.ok(idx >= 0 && idx < 47);
});

test('known reference cases', () => {
  // isolated (no neighbors) and full surround are always their own bucket.
  const isolated = maskToBlobIndex[0];
  const full = maskToBlobIndex[255];
  assert.notEqual(isolated, full);
  // a lone diagonal (NE=2) with neither adjacent edge (N=1, E=4) set reduces
  // to the same bucket as "no neighbors at all" (NE gets masked off).
  assert.equal(maskToBlobIndex[2], isolated);
  // N+E+NE (1+4+2=7) is its own distinct bucket from N+E alone (1+4=5).
  assert.notEqual(maskToBlobIndex[7], maskToBlobIndex[5]);
});

test('canonical masks never have an ineligible corner bit set', () => {
  const CORNERS = [[2, 1, 4], [8, 4, 16], [32, 16, 64], [128, 64, 1]];
  for (const m of blobIndexToMask) {
    for (const [corner, a, b] of CORNERS) {
      if (m & corner) assert.ok((m & a) && (m & b), `corner ${corner} set without both ${a},${b} in mask ${m}`);
    }
  }
});

test('sixteenTileBlobIndex produces exactly 16 distinct canonical indices', () => {
  // Valid cardinal-only masks are subset-sums of the actual N/E/S/W bit
  // values {1,4,16,64} -- NOT sequential 0-15 (that range mixes in bits
  // that mean NE/SE/etc in this module's convention).
  const CARDINALS = [1, 4, 16, 64];
  const indices = new Set();
  for (let i = 0; i < 16; i++) {
    let cardinalMask = 0;
    for (let b = 0; b < 4; b++) if (i & (1 << b)) cardinalMask |= CARDINALS[b];
    indices.add(sixteenTileBlobIndex(cardinalMask));
  }
  assert.equal(indices.size, 16);
  assert.deepEqual(SIXTEEN_TILE_INDICES, indices);
});

test('resolveTerrainSlot: explicit assignment wins, no symmetry needed', () => {
  const ts = { slots: { [maskToBlobIndex[0]]: 'tileA' }, symmetry: { flip: false, rotate: false } };
  const result = resolveTerrainSlot(ts, maskToBlobIndex[0]);
  assert.deepEqual(result, { tileId: 'tileA', flipH: false, flipV: false, rotate: 0 });
});

test('resolveTerrainSlot: unresolved with no reduction enabled', () => {
  const ts = { slots: {}, symmetry: { flip: false, rotate: false } };
  assert.equal(resolveTerrainSlot(ts, maskToBlobIndex[1]), null);
});

test('resolveTerrainSlot: rotation-only resolves a 90-degree-rotated slot with a nonzero rotate', () => {
  // Mask 1 (N only) rotated 90 degrees clockwise (bits rotated left by 2
  // positions in this module's bit ordering) becomes E (bit0 -> bit2 => 4).
  const nIndex = maskToBlobIndex[1];
  const eIndex = maskToBlobIndex[4];
  assert.notEqual(nIndex, eIndex);
  const ts = { slots: { [nIndex]: 'tileN' }, symmetry: { flip: false, rotate: true } };
  const result = resolveTerrainSlot(ts, eIndex);
  assert.ok(result && result.tileId === 'tileN');
  assert.notEqual(result.rotate, 0); // must use a real rotation, not identity
});

test('resolveTerrainSlot: 16-tile fallback resolves a corner-refinement slot from its core representative', () => {
  const nIndex = maskToBlobIndex[1]; // N only, cardinal-only, IS a core index
  assert.ok(SIXTEEN_TILE_INDICES.has(nIndex));
  const nePartial = maskToBlobIndex[5]; // N+E, no corner -- NOT a core index
  assert.ok(!SIXTEEN_TILE_INDICES.has(nePartial));
  const tsNE = { slots: { [sixteenTileBlobIndex(0b0101)]: 'coreNE' }, symmetry: { flip: false, rotate: false } };
  const result = resolveTerrainSlot(tsNE, nePartial);
  assert.deepEqual(result, { tileId: 'coreNE', flipH: false, flipV: false, rotate: 0 });
});

test('resolveTerrainSlot: both symmetry + 16-tile fallback compose', () => {
  const nIndex = maskToBlobIndex[1]; // core: N only
  const ts = { slots: { [nIndex]: 'tileN' }, symmetry: { flip: false, rotate: true } };
  // E-only (mask 4) is also core; should resolve via rotation from N, not via fallback.
  const eIndex = maskToBlobIndex[4];
  const result = resolveTerrainSlot(ts, eIndex);
  assert.ok(result && result.tileId === 'tileN');
});

test('classifySlots: symmetry off -> every index is its own singleton orbit, all mandatory', () => {
  const classification = classifySlots({ flip: false, rotate: false });
  assert.equal(classification.size, 47);
  for (let i = 0; i < 47; i++) {
    const c = classification.get(i);
    assert.equal(c.mandatory, true);
    assert.equal(c.orbitRepresentative, i);
  }
});

test('classifySlots: flip-only pairs mirror-symmetric indices, one mandatory per pair', () => {
  const classification = classifySlots({ flip: true, rotate: false });
  assert.equal([...classification.values()].filter(c => c.mandatory).length, 20);
  // real orbit: blob indices 1 and 5 are E<->W-style mirror images of each other.
  const c1 = classification.get(1);
  const c5 = classification.get(5);
  assert.equal(c1.orbitRepresentative, 1);
  assert.equal(c5.orbitRepresentative, 1);
  assert.equal(c1.mandatory, true);
  assert.equal(c5.mandatory, false);
});

test('classifySlots: rotate-only groups the 4-way rotational orbit of index 1, one mandatory per orbit', () => {
  const classification = classifySlots({ flip: false, rotate: true });
  assert.equal([...classification.values()].filter(c => c.mandatory).length, 15);
  // real orbit: blob indices 1, 2, 5, 13 are 90-degree rotations of each other.
  for (const idx of [1, 2, 5, 13]) assert.equal(classification.get(idx).orbitRepresentative, 1);
  assert.equal(classification.get(1).mandatory, true);
  for (const idx of [2, 5, 13]) assert.equal(classification.get(idx).mandatory, false);
});

test('classifySlots: both flip+rotate enabled composes into larger orbits, one mandatory per orbit', () => {
  const classification = classifySlots({ flip: true, rotate: true });
  assert.equal([...classification.values()].filter(c => c.mandatory).length, 14);
  // real 8-element orbit under the full dihedral group.
  const orbit = [9, 11, 17, 23, 27, 28, 35, 37];
  for (const idx of orbit) assert.equal(classification.get(idx).orbitRepresentative, 9);
  assert.equal(classification.get(9).mandatory, true);
  for (const idx of orbit.filter(i => i !== 9)) assert.equal(classification.get(idx).mandatory, false);
});
