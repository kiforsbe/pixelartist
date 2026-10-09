// Named ramps store palette INDICES, so every operation that renumbers or
// removes an entry invalidates them. palettes.js's mutators now remap ramps
// as part of the mutation; these are the tests that hold that honest.
//
// The invariant asserted throughout is NOT "the indices changed" -- that
// would pass for any rewrite, correct or not. It is "the ramp still names
// the same COLOURS", which is the only thing a ramp is actually for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPalette, setEntry, applyOrder, moveSwatch, removeSwatch, setLock,
  clearEntry, sortOrder,
} from '../js/core/palettes.js';

const RED = [255, 0, 0, 255];
const DARK = [20, 20, 60, 255];
const MID = [70, 70, 150, 255];
const LIGHT = [140, 140, 230, 255];
const WHITE = [255, 255, 255, 255];

// An UNLOCKED palette: the mutators behave differently under a lock, and the
// lock path is covered separately below.
function paletteOf(colors) {
  const p = createPalette({ name: 'P' });
  p.colors = colors.map(c => [...c]);
  p.empty = colors.map(() => false);
  return p;
}

// The colours a ramp currently names, in ramp order. This is the value that
// must survive every operation below.
function rampColors(palette, name) {
  const r = (palette.ramps ?? []).find(x => x.name === name);
  if (!r) return null;
  return r.indices.map(i => palette.colors[i]);
}

test('sorting a palette leaves a named ramp naming the same colours', () => {
  // Asymmetric on purpose: the ramp is indices 1-3, NOT 0-2 and not the whole
  // palette, so an off-by-one or a no-op remap both show up. RED at index 0
  // sorts away from the blues, so the ramp genuinely has to move.
  const p = paletteOf([RED, DARK, MID, LIGHT]);
  p.ramps = [{ name: 'Blues', indices: [1, 2, 3] }];
  const before = rampColors(p, 'Blues');
  assert.deepEqual(before, [DARK, MID, LIGHT]);

  const order = sortOrder(p.colors, 'luminance', null);
  // The control: the sort must actually permute something, or this test
  // proves nothing at all.
  assert.ok(!order.every((v, i) => v === i), 'sort did not reorder the palette');

  applyOrder(p, order);

  // Absent the remap the ramp would still read indices [1,2,3] against a
  // reordered array -- a different set of colours, silently.
  assert.deepEqual(rampColors(p, 'Blues'), before);
});

test('moving a swatch through a ramp keeps the ramp on its own colours', () => {
  const p = paletteOf([RED, DARK, MID, LIGHT, WHITE]);
  p.ramps = [{ name: 'Blues', indices: [1, 2, 3] }];
  const before = rampColors(p, 'Blues');

  // Drag RED (index 0) to the far end: every ramp index shifts down by one.
  moveSwatch(p, 0, 4);
  assert.deepEqual(rampColors(p, 'Blues'), before);
  assert.deepEqual(p.ramps[0].indices, [0, 1, 2]);

  // And the other direction: move WHITE from the end into the middle of the
  // ramp, which splits it across the inserted entry.
  moveSwatch(p, 3, 1);
  assert.deepEqual(rampColors(p, 'Blues'), before);
});

test('removing a swatch below a ramp shifts it down; removing one inside drops that entry', () => {
  const p = paletteOf([RED, DARK, MID, LIGHT]);
  p.ramps = [{ name: 'Blues', indices: [1, 2, 3] }];

  removeSwatch(p, 0);                       // below the ramp
  assert.deepEqual(p.ramps[0].indices, [0, 1, 2]);
  assert.deepEqual(rampColors(p, 'Blues'), [DARK, MID, LIGHT]);

  removeSwatch(p, 1);                       // MID, inside the ramp
  assert.deepEqual(rampColors(p, 'Blues'), [DARK, LIGHT]);
  assert.deepEqual(p.ramps[0].indices, [0, 1]);
});

test('a ramp reduced below two entries is dropped whole rather than left unusable', () => {
  const p = paletteOf([DARK, MID, LIGHT]);
  p.ramps = [{ name: 'Blues', indices: [0, 1] }];

  removeSwatch(p, 0);
  // One entry left. stepAlongRamp would find no neighbour and silently do
  // nothing forever, which is worse than the ramp visibly going away --
  // nameRamp refuses to CREATE a one-entry ramp for the same reason.
  assert.deepEqual(p.ramps, []);
});

test('clearing a slot removes it from its ramp even though its index survives', () => {
  const p = paletteOf([DARK, MID, LIGHT, WHITE]);
  p.ramps = [{ name: 'Blues', indices: [0, 1, 2] }];

  clearEntry(p, 1);
  // An unset slot holds emptyColor, not a colour anyone chose; stepping into
  // it would paint "nothing here". Indices do NOT shift -- clearEntry is the
  // locked-palette path precisely because it preserves numbering -- so this
  // is a drop, not a remap.
  assert.deepEqual(p.ramps[0].indices, [0, 2]);
  assert.deepEqual(rampColors(p, 'Blues'), [DARK, LIGHT]);
});

test('locking to a smaller size drops the truncated tail from a ramp', () => {
  const p = paletteOf([RED, DARK, MID, LIGHT]);
  p.ramps = [{ name: 'Blues', indices: [1, 2, 3] }];

  setLock(p, 3, 'NES');
  assert.deepEqual(rampColors(p, 'Blues'), [DARK, MID]);
  assert.deepEqual(p.ramps[0].indices, [1, 2]);
});

test('padding to a larger size disturbs no ramp', () => {
  const p = paletteOf([RED, DARK, MID, LIGHT]);
  p.ramps = [{ name: 'Blues', indices: [1, 2, 3] }];
  const before = rampColors(p, 'Blues');

  setLock(p, 8, 'NES');
  assert.deepEqual(rampColors(p, 'Blues'), before);
  assert.deepEqual(p.ramps[0].indices, [1, 2, 3]);
});

test('UNLOCKING compacts away empty slots and carries the ramp with them', () => {
  // The less obvious of the two stale-index paths: unlocking reads like it
  // only removes a restriction, but it discards every empty slot and
  // renumbers everything above each one.
  const p = createPalette({ name: 'P', indexed: true, size: 6, lockReason: 'NES' });
  setEntry(p, 0, RED);
  setEntry(p, 2, DARK);
  setEntry(p, 3, MID);
  setEntry(p, 5, LIGHT);
  // Slots 1 and 4 stay empty, so they sit BETWEEN the ramp's entries -- the
  // fixture is asymmetric so a remap that only subtracted a constant fails.
  p.ramps = [{ name: 'Blues', indices: [2, 3, 5] }];
  const before = rampColors(p, 'Blues');
  assert.deepEqual(before, [DARK, MID, LIGHT]);

  setLock(p, null);
  assert.equal(p.colors.length, 4, 'unlock should have compacted to the 4 set entries');
  assert.deepEqual(rampColors(p, 'Blues'), before);
  assert.deepEqual(p.ramps[0].indices, [1, 2, 3]);
});

test('a palette with no ramps is untouched by every remapping path', () => {
  // The control for the whole file: none of this may throw or invent a
  // `ramps` array on a palette that never had one.
  const p = paletteOf([RED, DARK, MID, LIGHT]);
  delete p.ramps;
  assert.doesNotThrow(() => {
    applyOrder(p, [3, 2, 1, 0]);
    moveSwatch(p, 0, 3);
    clearEntry(p, 1);
    removeSwatch(p, 0);
    setLock(p, 2, '');
    setLock(p, null);
  });
});
