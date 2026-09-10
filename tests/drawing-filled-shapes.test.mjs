// tests/drawing-filled-shapes.test.mjs
//
// The two-colour filled-shape convention (outline in the pressed button's
// swatch, interior in the opposite one) collides with any ink that already
// claims the secondary swatch for itself. There are only two swatches, so a
// left-button filled rect handed a `dither` ink the secondary as its source
// colour -- putting the same colour in both of the dither's slots and painting
// a SOLID interior. The ink wins: it reports `usesSecondary`, and a filled
// shape then takes its interior colour from the outline.
//
// These drive the real pointer path through bindDrawing, because the decision
// lives in the tool, not in the ink or the primitive.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getPixel } from '../js/core/pixels.js';
import { normalizeBrush } from '../js/core/brushes.js';
import { toolOptions } from '../js/components/tool-palette.js';
import { drawingFixture } from './helpers/drawing-selection-fixtures.mjs';

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

// A new project has no palettes (`activePaletteId: null`), so nothing snaps
// these colours -- the swatches reach the bitmap exactly as set.
function shapeFixture(t, ink) {
  const f = drawingFixture(t, 'sheet');
  const filled = toolOptions.filled;
  toolOptions.filled = true;
  t.after(() => { toolOptions.filled = filled; });
  f.host.store.updateDrawingSettings({
    primary: RED,
    secondary: BLUE,
    brush: normalizeBrush({ mask: { kind: 'square', size: 1 }, ink }),
  });
  f.host.store.updateSession({ activeToolId: 'rect' });
  return f;
}

function dragRect(f) {
  f.pointer('down', 2, 1);
  f.pointer('move', 9, 6);
  f.pointer('up', 9, 6);
}

// Distinct colours found strictly inside the rect drawn by dragRect.
function interiorColours(bmp) {
  const out = new Set();
  for (let y = 2; y <= 5; y++) for (let x = 3; x <= 8; x++) out.add(getPixel(bmp, x, y).join());
  return out;
}

test('a filled rect under a dither brush dithers its interior instead of flooding it', (t) => {
  // opacity stays at the default 100 so the PATTERN path runs. At opacity 50
  // the density path (passesOpacity) would skip the off-phase entirely and
  // transparent gaps would masquerade as a working dither -- which is exactly
  // the misreading this test exists to prevent.
  const f = shapeFixture(t, { kind: 'dither', pattern: 'checker' });
  dragRect(f);
  const colours = interiorColours(f.bitmap());
  assert.ok(colours.has(RED.join()), 'the interior must contain the primary swatch');
  assert.ok(colours.has(BLUE.join()), 'the interior must contain the secondary swatch');
  assert.equal(colours.size, 2, `the interior must be exactly the two swatches, got ${[...colours].join(' / ')}`);
});

test('a filled rect under a dither brush dithers its border in the same phase', (t) => {
  // One evenly dithered region, not a dithered border round a dithered middle
  // that happens to disagree: the pattern is screen-anchored, so a border pixel
  // and the interior pixel below it must follow the same checkerboard.
  const f = shapeFixture(t, { kind: 'dither', pattern: 'checker' });
  dragRect(f);
  const bmp = f.bitmap();
  for (const x of [3, 4, 5, 6, 7, 8]) {
    const border = getPixel(bmp, x, 1).join();
    const inside = getPixel(bmp, x, 2).join();
    // checker flips on every step in x AND y, so consecutive rows differ.
    assert.notEqual(border, inside, `column ${x} did not alternate between rows`);
    assert.equal(border, getPixel(bmp, x, 3).join(), `column ${x} is not on one continuous pattern`);
  }
});

test('a filled rect under a SOLID ink still keeps outline and interior distinct', (t) => {
  // The round-1 contract, at the tool level this time. An ink that does not
  // claim the secondary must not have the two-colour convention taken away
  // from it.
  const f = shapeFixture(t, { kind: 'solid' });
  dragRect(f);
  const bmp = f.bitmap();
  assert.deepEqual([...getPixel(bmp, 2, 1)], RED, 'outline corner');
  assert.deepEqual([...getPixel(bmp, 5, 1)], RED, 'outline edge');
  assert.deepEqual([...interiorColours(bmp)], [BLUE.join()], 'the interior must be solid secondary');
});

test('an unfilled rect is unaffected whichever ink is active', (t) => {
  const f = shapeFixture(t, { kind: 'dither', pattern: 'checker' });
  toolOptions.filled = false;
  dragRect(f);
  const colours = interiorColours(f.bitmap());
  assert.deepEqual([...colours], ['0,0,0,0'], 'an unfilled rect must leave its interior blank');
});
