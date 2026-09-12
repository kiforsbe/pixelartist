// tests/drawing-pencil.test.mjs
//
// The freehand tools (pencil/eraser) and the fill tools, driven through the
// REAL pointer path in bindDrawing.
//
// Why this file exists: every mechanism the drawing engine adds on top of the
// pure core modules was, until now, tested only on the pure module. Ruling
// 28's regression tests re-implement the engine's segmented loop inside the
// test and then assert on `strokeStamps`; brush-ink.test.mjs tests `originX`
// on `makeInk` directly. Both pin the pure function and leave the CALLER --
// which is where the defects actually lived -- unguarded. Deleting
// `stroke.travelled += pathSteps(last, p)` from drawing-engine.js, which IS
// Ruling 28's fix, left the whole suite green.
//
// The one pencil test that did go through the engine
// (brush-pressure.test.mjs's pointerup guard) runs at spacing 1, scatter 0,
// size 1 and constant pressure -- the single configuration in which every
// mechanism it could have protected is inert. So the brushes here are
// deliberately NOT that: spacing and scatter are on, and pressure changes
// during the stroke.
//
// Modelled on drawing-line-tool.test.mjs, which drives the same fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getPixel } from '../js/core/pixels.js';
import { normalizeBrush } from '../js/core/brushes.js';
import { strokeStamps } from '../js/core/brush-stroke.js';
import { drawingFixture } from './helpers/drawing-selection-fixtures.mjs';

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

// A deterministic stand-in for Math.random, which is where newStrokeSeed()
// gets a stroke's seed, PLUS the seed it produced. Every call returns a
// DIFFERENT value (as in drawing-line-tool.test.mjs) so a mutation that
// re-seeds mid-stroke shows up as a reshuffle rather than being masked by a
// constant stub; `seed` is derived from the FIRST value, which is the one
// newStrokeSeed() consumed at pointer-down, so a test can recompute exactly
// what the engine should have stamped.
function withCapturedSeed(fn) {
  const original = Math.random;
  let s = 1;
  let first = null;
  Math.random = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    const v = s / 2147483648;
    if (first === null) first = v;
    return v;
  };
  try {
    const result = fn();
    return { result, seed: (first * 0xFFFFFFFF) >>> 0 };
  } finally {
    Math.random = original;
  }
}

function pencilFixture(t, brushOverrides, viewKind = 'sheet') {
  const f = drawingFixture(t, viewKind);
  const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ...brushOverrides });
  f.host.store.updateDrawingSettings({ primary: RED, secondary: BLUE, brush });
  f.host.store.updateSession({ activeToolId: 'pencil' });
  return { f, brush };
}

// Every painted pixel, as "x,y" keys.
function painted(bmp) {
  const out = new Set();
  for (let y = 0; y < bmp.height; y++)
    for (let x = 0; x < bmp.width; x++)
      if (getPixel(bmp, x, y)[3] > 0) out.add(`${x},${y}`);
  return out;
}

function keysOf(stamps) {
  return new Set(stamps.map(s => `${s.x},${s.y}`));
}

// The sheet is 20x8. The path runs along y=4 from x=4 to x=16, so a scatter
// of 3 reaches x=1..19 and y=1..7 -- entirely inside the bitmap. Nothing
// below is an artefact of a stamp falling off an edge and being dropped.
const PATH_Y = 4, PATH_X0 = 4, PATH_X1 = 16;
const SEGMENTED = [8, 12, 16];
const SPACED = { mask: { kind: 'square', size: 1, spacing: 4, scatter: 3 } };

// --- travelled: one stroke, however the pointer happened to sample it ------

test('a multi-segment pencil stroke stamps exactly what one whole-path call would', (t) => {
  // `stroke.travelled` exists so that a stroke stamped one pointer segment at
  // a time is indistinguishable from the same path stamped in one go: the
  // spacing phase and the stamp ordinal are stroke-global, not segment-local.
  //
  // IF THE MECHANISM WERE ABSENT each segment would restart both at zero, so
  // every pointer sample would land a stamp (spacing measured from the wrong
  // origin) and the shared segment endpoints would be stamped TWICE at two
  // different ordinals -- two different scatter offsets for one path
  // position. That reads as MORE painted pixels than the whole-path call
  // produces, and different ones. The assertion below is exact in both
  // directions, so extra stamps fail it just as loudly as missing ones.
  const { f, brush } = pencilFixture(t, SPACED);
  const { seed } = withCapturedSeed(() => {
    f.pointer('down', PATH_X0, PATH_Y);
    for (const x of SEGMENTED) f.pointer('move', x, PATH_Y);
    f.pointer('up', PATH_X1, PATH_Y);
  });
  const expected = keysOf(strokeStamps(
    [{ x: PATH_X0, y: PATH_Y }, { x: PATH_X1, y: PATH_Y }], brush.mask, seed));

  // Anti-vacuity, both halves. Without these the deepEqual below would pass
  // just as happily on an engine that painted nothing at all, or on a brush
  // whose scatter never moved anything.
  assert.equal(expected.size, 4,
    `12 pixels of travel at spacing 4 is 4 stamps, got ${expected.size}`);
  assert.ok([...expected].some(k => k.split(',')[1] !== String(PATH_Y)),
    'the fixture brush must actually scatter off the path, or this test cannot see an ordinal mismatch');

  assert.deepEqual([...painted(f.bitmap())].sort(), [...expected].sort());
});

test('stroke density does not track the pointer event rate', (t) => {
  // The user-visible form of the same property, and the one that needs no
  // knowledge of the seed: the SAME path, sampled coarsely or finely, must
  // paint the same pixels. A stroke whose spacing phase restarts per segment
  // gets denser the faster the browser delivers pointermove events, which is
  // a stroke that looks different on a fast machine than a slow one.
  //
  // IF THE MECHANISM WERE ABSENT the finely-sampled run would carry a stamp
  // at every segment boundary (each boundary restarts the phase at 0, which
  // always stamps) while the coarse run has only two boundaries -- so the
  // fine run would paint strictly more pixels. Observed: the two sets are
  // identical, which is the opposite of that.
  // The fixture's two sheets have identical geometry, and withCapturedSeed
  // restarts its sequence on every call, so both strokes run with the same
  // stroke seed. One fixture, not two: a second drawingFixture() would
  // replace the shared host's project out from under the first.
  const { f } = pencilFixture(t, SPACED);
  withCapturedSeed(() => {
    f.pointer('down', PATH_X0, PATH_Y);
    f.pointer('move', PATH_X1, PATH_Y);
    f.pointer('up', PATH_X1, PATH_Y);
  });
  f.switchSheet(1);
  withCapturedSeed(() => {
    f.pointer('down', PATH_X0, PATH_Y);
    for (const x of SEGMENTED) f.pointer('move', x, PATH_Y);
    f.pointer('up', PATH_X1, PATH_Y);
  });

  const coarseKeys = [...painted(f.bitmap(f.sheets[0]))].sort();
  assert.ok(coarseKeys.length > 1, 'the coarse stroke painted nothing worth comparing');
  assert.deepEqual([...painted(f.bitmap(f.sheets[1]))].sort(), coarseKeys,
    'the same path sampled at a different pointer rate painted different pixels');
});

// --- pressure reaches the ink THROUGH the engine ---------------------------

test('a pressure change mid-stroke reaches the ink (pen)', (t) => {
  // drawing-engine.js does NOT rebuild the ink per pointer move -- the ink's
  // `touched` set is stroke-lifetime state -- so live pressure reaches it
  // only through `ink.setPressure(ev.pressure, ev.pointerType)` in handleMove.
  // brush-ink.test.mjs tests setPressure on makeInk directly; nothing tested
  // that the engine ever calls it.
  //
  // Opacity is the discriminator because it is binary: a pressure-0 write is
  // opacity 0, which NEVER paints, and a pressure-1 write is opacity 100,
  // which always does. The stroke therefore starts invisible and must become
  // visible partway through.
  //
  // IF THE MECHANISM WERE ABSENT the ink would keep the pressure it was built
  // with at pointer-down -- zero -- for the whole stroke, and the bitmap
  // would be COMPLETELY EMPTY. Observed below is a painted run, which is the
  // opposite of that; the emptiness assertion on the pointer-down pixel is
  // what keeps "everything is painted anyway" from also satisfying it.
  const { f } = pencilFixture(t, {
    ink: { kind: 'solid', opacity: 100 },
    pressure: { target: 'opacity', min: 0, max: 100, curve: 'linear' },
  });
  f.pointer('down', 4, PATH_Y, { pressure: 0, pointerType: 'pen' });
  f.pointer('move', 10, PATH_Y, { pressure: 1, pointerType: 'pen' });
  f.pointer('up', 10, PATH_Y, { pressure: 1, pointerType: 'pen' });

  assert.equal(getPixel(f.bitmap(), 4, PATH_Y)[3], 0,
    'the pointer-down pixel was written at pressure 0 -- opacity 0 must paint nothing');
  assert.ok(getPixel(f.bitmap(), 10, PATH_Y)[3] > 0,
    'the stroke never became visible: the mid-stroke pressure rise never reached the ink');
});

test('a mouse reports constant pressure, so a pressure brush ignores it entirely', (t) => {
  // The other side of the same wire, and the guard that keeps the test above
  // from merely re-measuring "opacity 100 paints". Pressure is honored ONLY
  // for `pointerType === 'pen'` (a Global Constraint), so the identical
  // gesture from a mouse must paint at the brush's own static opacity from
  // the very first pixel -- including the pointer-down pixel that the pen run
  // above leaves blank.
  const { f } = pencilFixture(t, {
    ink: { kind: 'solid', opacity: 100 },
    pressure: { target: 'opacity', min: 0, max: 100, curve: 'linear' },
  });
  f.pointer('down', 4, PATH_Y, { pressure: 0, pointerType: 'mouse' });
  f.pointer('move', 10, PATH_Y, { pressure: 0, pointerType: 'mouse' });
  f.pointer('up', 10, PATH_Y, { pressure: 0, pointerType: 'mouse' });

  assert.ok(getPixel(f.bitmap(), 4, PATH_Y)[3] > 0,
    "a mouse's pressure reading must not gate the ink");
  assert.ok(getPixel(f.bitmap(), 10, PATH_Y)[3] > 0);
});

// --- the fill tools' ink, and its screen anchoring -------------------------
//
// The fill tools flood a DETACHED copy of the target region whose own origin
// is (0,0) and blit it back, so the ink has to be told where that copy really
// sits (`strokeInk(ev, color, t)`) or every screen-anchored pattern indexes
// from sub-local coordinates. brush-ink.test.mjs pins this on `makeInk`
// directly; nothing pinned that handleDown actually passes `t`.
//
// The region used is the fixture's SECOND frame, at sheet x=10 -- a non-zero
// origin, which is the whole point. The two sheets the fixture builds have
// identical geometry, so one can be painted by the pencil and the other
// filled, and the results compared pixel for pixel.

const DITHER = { ink: { kind: 'dither', pattern: 'checker', opacity: 50 } };

function regionPixels(bmp, rect) {
  const out = [];
  for (let y = rect.y; y < rect.y + rect.h; y++)
    for (let x = rect.x; x < rect.x + rect.w; x++) out.push(getPixel(bmp, x, y).join());
  return out;
}

test('a dither fill at a non-zero target origin lands in the same phase as a pencil stroke over the same pixels', (t) => {
  const { f } = pencilFixture(t, DITHER, 'frame');
  f.switchRegion(1);
  const rect = f.regions()[1];
  assert.ok(rect.x > 0, 'this test is only meaningful at a non-zero target origin');

  // Sheet 0: cover the region with pencil strokes, one per row. The pencil
  // paints straight onto the layer bitmap in sheet coordinates, so this is
  // the absolute-phase reference by construction.
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    f.pointer('down', rect.x, y);
    f.pointer('move', rect.x + rect.w - 1, y);
    f.pointer('up', rect.x + rect.w - 1, y);
  }
  const reference = regionPixels(f.bitmap(f.sheets[0]), rect);

  // Anti-vacuity: the reference has to be an actual two-colour dither with
  // gaps in it. If it were solid (or empty) the comparison below would pass
  // under an ink that had been dropped altogether.
  const distinct = new Set(reference);
  assert.equal(distinct.size, 3,
    `expected primary, secondary and empty in the reference, got ${[...distinct].join(' / ')}`);

  // Sheet 1: same geometry, filled instead.
  f.switchSheet(1);
  f.switchRegion(1);
  f.host.store.updateSession({ activeToolId: 'fill' });
  f.pointer('down', rect.x + 1, rect.y + 1);
  f.pointer('up', rect.x + 1, rect.y + 1);

  assert.deepEqual(regionPixels(f.bitmap(f.sheets[1]), rect), reference,
    'the fill came out in a different phase from a pencil stroke over the same pixels');
});

// --- scatter at the extreme edge of a target rect --------------------------

test('a scattered stroke along a target edge never writes outside that target', (t) => {
  // The design doc asked for this one directly: "paint a scattered stroke at
  // the extreme edge of a target rect and assert no pixel outside the rect
  // changed". Coordinate clamping alone cannot provide it -- clampPoint
  // clamps the POINTER, and scatter then moves the stamp off the clamped
  // position, in every direction. Two separate mechanisms stand behind it:
  // maskOutsideTarget restores out-of-target pixels during the live stroke,
  // and finalize restores the whole dirty extent before re-applying a
  // target-clamped patch, so nothing can persist.
  const { f, brush } = pencilFixture(t, { mask: { kind: 'square', size: 1, spacing: 1, scatter: 3 } }, 'frame');
  const rect = f.regions()[0];
  const edgeX = rect.x + rect.w - 1;

  const outsideIsClean = (label) => {
    const bmp = f.bitmap();
    for (let y = 0; y < bmp.height; y++)
      for (let x = 0; x < bmp.width; x++) {
        if (x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h) continue;
        assert.equal(getPixel(bmp, x, y)[3], 0, `${label}: pixel ${x},${y} outside the target was written`);
      }
  };

  // Up the edge, not down it. The direction matters only because the stroke
  // must START where its scatter can reach somewhere both OUTSIDE the target
  // and still ON the bitmap: from the rect's top-right corner this seed's
  // first stamp scatters to y=-1, which setPixel drops, so the pointer-down
  // branch would go untested. The anti-vacuity assertions below are what
  // caught that and what will catch it again if the seed ever moves.
  const startY = rect.y + rect.h - 1, endY = rect.y;
  const { seed } = withCapturedSeed(() => {
    f.pointer('down', edgeX, startY);
    // Both branches stamp, so both are asserted: pointer-down lays its own
    // stamp before any move happens.
    outsideIsClean('after pointer-down');
    f.pointer('move', edgeX, endY);
    // Asserted BEFORE pointer-up, so this covers the live stroke rather than
    // only what finalize leaves behind.
    outsideIsClean('mid-stroke');
    f.pointer('up', edgeX, endY);
  });

  // Anti-vacuity: prove the stroke actually HAD somewhere outside the target
  // to bleed into, and that the pointer-down stamp on its own did too --
  // otherwise the assertions above would be satisfied by a scatter that
  // happened never to reach past the edge. "Outside and still on the bitmap"
  // is the condition that matters: a stamp scattered off the bitmap entirely
  // is dropped by setPixel and could never have been visible.
  const bmp = f.bitmap();
  const stamps = strokeStamps([{ x: edgeX, y: startY }, { x: edgeX, y: endY }], brush.mask, seed);
  const bleeds = s => s.x >= 0 && s.y >= 0 && s.x < bmp.width && s.y < bmp.height
    && (s.x >= rect.x + rect.w || s.y >= rect.y + rect.h || s.x < rect.x || s.y < rect.y);
  assert.ok(bleeds(stamps[0]),
    `the pointer-down stamp (${stamps[0].x},${stamps[0].y}) stayed inside the target -- the down branch is untested as configured`);
  assert.ok(stamps.slice(1).some(bleeds),
    'no later stamp landed outside the target -- the move branch is untested as configured');

  outsideIsClean('after finalize');
  // And the stroke really did paint INSIDE, so "clean outside" is not just
  // "nothing was painted anywhere".
  assert.ok(painted(f.bitmap()).size > 0, 'the stroke painted nothing at all');
});
