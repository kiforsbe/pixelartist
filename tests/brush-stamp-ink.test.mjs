// tests/brush-stamp-ink.test.mjs
//
// Amendment section A (task-11-brief-amendment.md, Ruling 29): `bitmapToBrush`
// produces `mask.colors` -- the stamp ink's own per-pixel colour payload --
// but nothing read it. This file exercises the machinery that gives it a
// consumer: rasterizeMask/rotateMaskGrid/flipMaskGrid carry `colors` on the
// grid, and pixels.js's `stamp()` forwards the right cell's colour instead of
// the caller's flat `rgba`.
//
// A custom mask's colour payload belongs to `stamp` alone (mask and ink are
// independent axes -- brushes.js's header comment); the SAME mask reused
// under any other ink must paint that ink's own colour, not the embedded
// palette. `maskGridFor`'s optional `options.inkKind` is what withholds the
// payload for every ink but stamp -- see its comment in brushes.js.

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

test('a stamp-ink custom brush paints its own red/green/blue payload, not primary', () => {
  const brush = rgbBrush({ kind: 'stamp' });
  const grid = maskGridFor(brush.mask, { inkKind: brush.ink.kind });
  assert.ok(grid.colors, 'grid must carry the payload for a stamp-ink brush');
  const bmp = createBitmap(10, 10);
  const ink = makeInk(brush, ctx());
  stamp(bmp, 5, 5, PRIMARY, 1, ink, grid);
  assert.deepEqual([...getPixel(bmp, 4, 5)], RED, 'first cell must be the payload red, not primary');
  assert.deepEqual([...getPixel(bmp, 5, 5)], GREEN, 'second cell must be the payload green, not primary');
  assert.deepEqual([...getPixel(bmp, 6, 5)], BLUE, 'third cell must be the payload blue, not primary');
});

test('mask.rotate: 90 rotates the payload WITH the shape, not independently of it', () => {
  const brush = rgbBrush({ kind: 'stamp' });
  const rotated = normalizeBrush({ ...brush, mask: { ...brush.mask, rotate: 90 } });
  const grid = maskGridFor(rotated.mask, { inkKind: rotated.ink.kind });
  // A 3x1 grid rotated 90 degrees clockwise becomes 1x3.
  assert.equal(grid.width, 1);
  assert.equal(grid.height, 3);
  const bmp = createBitmap(10, 10);
  const ink = makeInk(rotated, ctx());
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
  const grid = maskGridFor(brush.mask, { inkKind: brush.ink.kind });
  const bmp = createBitmap(10, 10);
  const ink = makeInk(brush, ctx({ palette, primary: [222, 111, 5, 255] }));
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

test('solid ink on the SAME custom mask with a colors payload still paints primary -- the payload must not leak', () => {
  const brush = rgbBrush({ kind: 'solid' });
  const grid = maskGridFor(brush.mask, { inkKind: brush.ink.kind });
  assert.equal(grid.colors, undefined, 'a grid built for solid ink must not carry the stamp payload');
  const bmp = createBitmap(10, 10);
  const ink = makeInk(brush, ctx());
  stamp(bmp, 5, 5, PRIMARY, 1, ink, grid);
  assert.deepEqual([...getPixel(bmp, 4, 5)], PRIMARY, 'solid must paint primary, not the payload red');
  assert.deepEqual([...getPixel(bmp, 5, 5)], PRIMARY, 'solid must paint primary, not the payload green');
  assert.deepEqual([...getPixel(bmp, 6, 5)], PRIMARY, 'solid must paint primary, not the payload blue');

  // Anti-vacuity, required by the task's verification discipline: prove what
  // "the mechanism is absent" looks like. A grid built WITHOUT declaring
  // inkKind (every call site that predates this option) keeps the payload
  // attached regardless of ink -- the exact leak this test guards against --
  // so painting through IT must reproduce red/green/blue, not primary. If it
  // didn't, the assertions above would not be discriminating anything.
  const leaky = maskGridFor(brush.mask, {});
  assert.ok(leaky.colors, 'a grid built without inkKind must still carry the payload (baseline)');
  const leakyBmp = createBitmap(10, 10);
  stamp(leakyBmp, 5, 5, PRIMARY, 1, makeInk(brush, ctx()), leaky);
  assert.deepEqual([...getPixel(leakyBmp, 4, 5)], RED, 'baseline: an ink-unaware grid leaks the payload');
  assert.deepEqual([...getPixel(leakyBmp, 5, 5)], GREEN, 'baseline: an ink-unaware grid leaks the payload');
  assert.deepEqual([...getPixel(leakyBmp, 6, 5)], BLUE, 'baseline: an ink-unaware grid leaks the payload');
});
