// tests/brush-stamp-ink.test.mjs
//
// Amendment section A (task-11-brief-amendment.md, Ruling 29): `bitmapToBrush`
// produces `mask.colors` -- the stamp ink's own per-pixel colour payload --
// but nothing read it. This file exercises the machinery that gives it a
// consumer: rasterizeMask/rotateMaskGrid/flipMaskGrid carry `colors` on the
// grid unconditionally, and pixels.js's `stamp()` forwards the right cell's
// colour instead of the caller's flat `rgba` -- but ONLY when the active ink
// actually claims the payload (`ink.usesMaskColors`, brush-ink.js).
//
// Fix round 1: an earlier version of this file gated the payload in
// `maskGridFor` via an `options.inkKind` hint. That failed open -- every real
// call site in drawing-engine.js passes no hint, so the payload leaked into
// every ink there by default -- and put ink taxonomy in a mask function
// (the same anti-pattern `usesSecondary` exists to avoid, per Ruling 38).
// `maskGridFor` now always returns a mask's colours unconditionally (mask and
// ink are independent axes; a mask does not know or care what will paint it),
// and the decision moved to the one place that already knows, per ink,
// whether it wants the payload: `ink.usesMaskColors`. This is fail-closed --
// an ink absent from brush-ink.js's MASK_COLOR_CONSUMING_KINDS, including one
// added later, cannot receive the payload no matter how the grid was built.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel, stamp } from '../js/core/pixels.js';
import { normalizeBrush, maskGridFor } from '../js/core/brushes.js';
import { normalizePalette, nearestColor } from '../js/core/palettes.js';
import { makeInk } from '../js/core/brush-ink.js';
import { bitmapToBrush } from '../js/core/brush-io.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255];
const PRIMARY = [9, 9, 9, 255];

function ctx(extra = {}) {
  return { primary: PRIMARY, secondary: null, palette: null, seed: 1, alt: false, pressure: 1, ...extra };
}

function greyPalette() {
  const colors = [[20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200]].map(c => [...c, 255]);
  return normalizePalette({ id: 'p', name: 'P', indexed: true, colors, empty: colors.map(() => false) });
}

// A 3x1 custom mask whose three opaque cells carry RED, GREEN, BLUE as their
// stamp payload -- born via bitmapToBrush exactly as a real user would create
// one (paint a 3-pixel swatch, save it as a brush).
function rgbBrush(inkOverride) {
  const src = createBitmap(3, 1);
  setPixel(src, 0, 0, RED);
  setPixel(src, 1, 0, GREEN);
  setPixel(src, 2, 0, BLUE);
  const base = bitmapToBrush(src, 'RGB');
  return normalizeBrush({ ...base, ...(inkOverride ? { ink: inkOverride } : {}) });
}

// `{ rotate: 0 }` mirrors drawing-engine.js's actual call shape
// (`maskGridFor({ ...brush.mask, size }, { rotate: s.rotate })` at lines 360,
// 449, 496) -- there is no ink hint to pass any more, so every test in this
// file already exercises the live call shape, not a hypothetical one.
function liveGrid(mask) {
  return maskGridFor(mask, { rotate: 0 });
}

test('a stamp-ink custom brush paints its own red/green/blue payload, not primary', () => {
  const brush = rgbBrush({ kind: 'stamp' });
  const grid = liveGrid(brush.mask);
  assert.ok(grid.colors, 'grid must carry the payload -- rasterizeMask attaches it unconditionally');
  const ink = makeInk(brush, ctx());
  assert.equal(ink.usesMaskColors, true, 'stamp ink must claim the mask colour payload');
  const bmp = createBitmap(10, 10);
  stamp(bmp, 5, 5, PRIMARY, 1, ink, grid);
  assert.deepEqual([...getPixel(bmp, 4, 5)], RED, 'first cell must be the payload red, not primary');
  assert.deepEqual([...getPixel(bmp, 5, 5)], GREEN, 'second cell must be the payload green, not primary');
  assert.deepEqual([...getPixel(bmp, 6, 5)], BLUE, 'third cell must be the payload blue, not primary');
});

test('mask.rotate: 90 rotates the payload WITH the shape, not independently of it', () => {
  const brush = rgbBrush({ kind: 'stamp' });
  const rotated = normalizeBrush({ ...brush, mask: { ...brush.mask, rotate: 90 } });
  const grid = liveGrid(rotated.mask);
  // A 3x1 grid rotated 90 degrees clockwise becomes 1x3.
  assert.equal(grid.width, 1);
  assert.equal(grid.height, 3);
  const ink = makeInk(rotated, ctx());
  const bmp = createBitmap(10, 10);
  stamp(bmp, 5, 5, PRIMARY, 1, ink, grid);
  const halfY = (grid.height - 1) >> 1;
  assert.deepEqual([...getPixel(bmp, 5, 5 - halfY)], RED, 'top cell after rotation must still be red');
  assert.deepEqual([...getPixel(bmp, 5, 5 - halfY + 1)], GREEN, 'middle cell after rotation must still be green');
  assert.deepEqual([...getPixel(bmp, 5, 5 - halfY + 2)], BLUE, 'bottom cell after rotation must still be blue');
});

test('a stamp brush on a palette lacking its colours writes the nearest palette colour, never an off-palette one', () => {
  const palette = greyPalette();
  const src = createBitmap(3, 1);
  // Deliberately off-palette but each nearer to a DIFFERENT grey entry, so a
  // single shared closure result could not make this pass vacuously.
  const OFF_A = [5, 5, 5, 255], OFF_B = [68, 68, 68, 255], OFF_C = [140, 140, 140, 255];
  setPixel(src, 0, 0, OFF_A);
  setPixel(src, 1, 0, OFF_B);
  setPixel(src, 2, 0, OFF_C);
  const base = bitmapToBrush(src, 'Off');
  const brush = normalizeBrush({ ...base, ink: { kind: 'stamp' } });
  const grid = liveGrid(brush.mask);
  const ink = makeInk(brush, ctx({ palette, primary: [222, 111, 5, 255] }));
  const bmp = createBitmap(10, 10);
  stamp(bmp, 5, 5, [222, 111, 5, 255], 1, ink, grid);

  const entries = palette.colors.map(c => `${c[0]},${c[1]},${c[2]}`);
  const [a, b, c] = [getPixel(bmp, 4, 5), getPixel(bmp, 5, 5), getPixel(bmp, 6, 5)];
  for (const p of [a, b, c]) {
    assert.ok(entries.includes(`${p[0]},${p[1]},${p[2]}`), `${p} is off-palette`);
  }
  assert.deepEqual([...a], nearestColor(palette, OFF_A));
  assert.deepEqual([...b], nearestColor(palette, OFF_B));
  assert.deepEqual([...c], nearestColor(palette, OFF_C));
  // Anti-vacuity: the three results must actually differ from each other, or
  // every off-palette probe closed to the same entry and this proves nothing
  // about per-cell colours surviving into the closure.
  assert.ok(new Set([a, b, c].map(p => p.join())).size === 3, 'all three cells closed to the same entry');
});

// --- Fix round 1: the leak closes at the ink, not the grid -----------------
//
// This inverts the old "leaky" test from before the fix. A solid-ink custom
// brush is the DEFAULT shape `bitmapToBrush` produces (it sets no `ink`
// field, and normalizeInk defaults to `solid`), and `liveGrid` above is
// EXACTLY the call shape drawing-engine.js uses -- no ink hint, because there
// is nowhere left to pass one. Before this fix, painting this exact
// combination through `stamp()` produced [255,0,0,255] [0,255,0,255]
// [0,0,255,255] -- the payload -- where solid ink should give primary three
// times. That was the live app's behaviour, not a hypothetical.

test('a solid-ink custom brush, built by bitmapToBrush and painted through the drawing engine\'s exact call shape, paints primary -- the payload must not leak', () => {
  const brush = rgbBrush(); // no ink override: exercises normalizeInk's actual default
  assert.equal(brush.ink.kind, 'solid', 'bitmapToBrush must still default to solid ink, or this test is not the real scenario');
  const grid = liveGrid(brush.mask);
  // Baseline: the grid genuinely carries the payload (rasterizeMask attaches
  // it unconditionally), so the "no leak" assertions below are pinned against
  // an ink that had real ammunition to leak, not an empty one.
  assert.ok(grid.colors, 'baseline: the grid must actually carry the payload, or "no leak" below proves nothing');
  const ink = makeInk(brush, ctx());
  assert.equal(ink.usesMaskColors, false, 'solid ink must not claim the mask colour payload');
  const bmp = createBitmap(10, 10);
  stamp(bmp, 5, 5, PRIMARY, 1, ink, grid);
  assert.deepEqual([...getPixel(bmp, 4, 5)], PRIMARY, 'solid must paint primary, not the payload red');
  assert.deepEqual([...getPixel(bmp, 5, 5)], PRIMARY, 'solid must paint primary, not the payload green');
  assert.deepEqual([...getPixel(bmp, 6, 5)], PRIMARY, 'solid must paint primary, not the payload blue');
});
