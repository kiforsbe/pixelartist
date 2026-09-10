import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, getPixel, setPixel, drawLine, drawRect, drawEllipse, floodFill, softFloodFill } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];

// A recording ink that writes green and logs every coordinate it is given.
// `sources` records the SOURCE COLOUR each write was offered, which is how a
// primitive that varies colour across its own geometry (drawRect's outline vs
// interior, and later the stamp ink's per-pixel payload) reaches an ink.
function spyInk() {
  const seen = [], sources = [];
  return {
    seen,
    sources,
    write(bmp, x, y, srcColor) {
      seen.push(`${x},${y}`);
      sources.push(srcColor ? srcColor.join() : null);
      setPixel(bmp, x, y, GREEN);
    },
  };
}

test('drawLine without an ink behaves exactly as before', () => {
  const bmp = createBitmap(8, 8);
  drawLine(bmp, 0, 0, 3, 0, RED, 1);
  for (let x = 0; x <= 3; x++) assert.deepEqual([...getPixel(bmp, x, 0)], RED);
});

test('drawLine routes every write through the ink when given one', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawLine(bmp, 0, 0, 3, 0, RED, 1, ink);
  assert.deepEqual(ink.seen, ['0,0', '1,0', '2,0', '3,0']);
  assert.deepEqual([...getPixel(bmp, 2, 0)], GREEN);
});

test('drawRect routes through the ink -- this is what makes dithered shapes work', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawRect(bmp, 0, 0, 2, 2, RED, false, ink);
  assert.ok(ink.seen.includes('0,0'));
  assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN);
});

test('drawEllipse routes through the ink', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawEllipse(bmp, 0, 0, 4, 4, RED, true, ink);
  assert.ok(ink.seen.length > 0);
});

test('floodFill routes through the ink -- this is DITHER FILL', () => {
  const bmp = createBitmap(4, 4);
  const ink = spyInk();
  floodFill(bmp, 0, 0, RED, true, ink);
  assert.equal(ink.seen.length, 16, 'every pixel of an empty bitmap');
  assert.deepEqual([...getPixel(bmp, 3, 3)], GREEN);
});

test('floodFill without an ink still fills with the plain color', () => {
  const bmp = createBitmap(4, 4);
  floodFill(bmp, 0, 0, RED, true);
  assert.deepEqual([...getPixel(bmp, 3, 3)], RED);
});

test('stamp honors a 1-bit mask grid, skipping uncovered cells', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  // 3x3 grid with only the center set.
  const grid = { width: 3, height: 3, bits: Uint8Array.from([0,0,0, 0,1,0, 0,0,0]) };
  drawLine(bmp, 4, 4, 4, 4, RED, 3, ink, grid);
  assert.deepEqual(ink.seen, ['4,4']);
});

// --- Amendment (Ruling 24): floodFill must not use the written colour as its
// visited marker. An ink is free to decline to write (opacity < 100,
// ramp-shade off-ramp, replace on a non-match, lock-alpha on a transparent
// pixel), and a skipped pixel still equals `target`. Against a floodFill that
// treats "still equals target" as "unvisited", two orthogonally adjacent
// skipped pixels push each other back onto the stack forever -- exactly what
// a real dots25 (25%) dither pattern produces. Both tests below use an ink
// that writes only where x % 2 === 0 && y % 2 === 0, which guarantees
// orthogonally adjacent skips (e.g. (0,1) and (1,1) are both skipped and
// adjacent), and both guard with a ceiling so a regression fails fast
// instead of hanging the test run.

test('floodFill with a skipping ink terminates instead of looping on adjacent skips', () => {
  const bmp = createBitmap(8, 8);
  const CEILING = 10000; // a correct implementation offers each of the 64 pixels at most once
  let calls = 0;
  const ink = {
    write(bmp, x, y) {
      calls++;
      if (calls > CEILING) {
        throw new Error('floodFill did not terminate: exceeded pop ceiling -- visited marker is broken');
      }
      if (x % 2 === 0 && y % 2 === 0) setPixel(bmp, x, y, GREEN);
      // else: decline to write, simulating adjacent dither skips.
    },
  };
  const rect = floodFill(bmp, 0, 0, RED, true, ink);
  assert.ok(rect, 'floodFill should return a dirty rect for the filled region');
  assert.ok(calls <= 64, `expected at most 64 offers for an 8x8 region, got ${calls}`);
});

test('floodFill with a skipping ink offers every pixel of the region exactly once', () => {
  const bmp = createBitmap(8, 8);
  const CEILING = 10000;
  const seen = [];
  const ink = {
    write(bmp, x, y) {
      seen.push(`${x},${y}`);
      if (seen.length > CEILING) {
        throw new Error('floodFill did not terminate: exceeded pop ceiling -- visited marker is broken');
      }
      if (x % 2 === 0 && y % 2 === 0) setPixel(bmp, x, y, GREEN);
    },
  };
  floodFill(bmp, 0, 0, RED, true, ink);
  assert.equal(seen.length, 64, 'every pixel of the empty 8x8 region should be offered to the ink');
  assert.equal(new Set(seen).size, 64, 'no coordinate should be offered to the ink twice');
});

// --- softFloodFill ink hook (Ruling 25) ------------------------------------

test('softFloodFill without an ink blends exactly as it always has', () => {
  const bmp = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, [0, 0, 0, 255]);
  softFloodFill(bmp, 0, 0, [255, 255, 255, 255], { tolerance: 255 });
  assert.deepEqual([...getPixel(bmp, 2, 2)], [255, 255, 255, 255]);
});

test('softFloodFill routes through an ink when given one', () => {
  const bmp = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, [0, 0, 0, 255]);
  const ink = spyInk();
  softFloodFill(bmp, 0, 0, [255, 255, 255, 255], { tolerance: 255 }, ink);
  assert.equal(ink.seen.length, 16, 'every pixel in tolerance should be offered to the ink');
  assert.deepEqual([...getPixel(bmp, 2, 2)], GREEN, 'the ink decides the colour, not rgba');
});

test('an ink turns feather into a hard threshold instead of a blend', () => {
  // Strengths are pinned to known values so this test actually constrains the
  // 0.5 cutoff. tolerance 20 + feather 100 => edge 120, and strength in the
  // band is (edge - dist) / feather:
  //   x=0  dist   0 -> strength 1.0   written
  //   x=1  dist  60 -> strength 0.6   written
  //   x=2  dist  90 -> strength 0.3   SKIPPED
  //   x=3  dist 200 -> strength 0     skipped, and traversal stops here
  // A cutoff of 0.05 would also write x=2; a cutoff of 0.99 would write only
  // x=0. Either mutation must fail this test.
  const bmp = createBitmap(4, 1);
  setPixel(bmp, 0, 0, [0, 0, 0, 255]);
  setPixel(bmp, 1, 0, [60, 60, 60, 255]);
  setPixel(bmp, 2, 0, [90, 90, 90, 255]);
  setPixel(bmp, 3, 0, [200, 200, 200, 255]);
  const ink = spyInk();
  softFloodFill(bmp, 0, 0, [255, 0, 0, 255], { tolerance: 20, feather: 100 }, ink);
  assert.deepEqual(ink.seen, ['0,0', '1,0'], 'only pixels at or above half strength may be inked');
  assert.deepEqual([...getPixel(bmp, 2, 0)], [90, 90, 90, 255], 'a sub-threshold pixel must be left exactly as it was');
  // The original point of this test: nothing may come back part-blended.
  for (const x of [0, 1, 2, 3]) {
    const p = [...getPixel(bmp, x, 0)];
    const untouched = p[0] === p[1] && p[1] === p[2];
    assert.ok(p.join() === GREEN.join() || untouched,
      `pixel ${x} came back part-blended (${p}) -- an ink must never produce an in-between colour`);
  }
});

test('softFloodFill offers the ink the colour the operation actually writes', () => {
  // `target` is the answer softFloodFill already computes: `rgba` for a fill,
  // transparent black for an erase. It used to be discarded whenever an ink
  // was present, which is why a right-click soft flood painted the ink's
  // primary instead of erasing.
  const fillBmp = createBitmap(2, 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(fillBmp, x, y, [0, 0, 0, 255]);
  const fillInk = spyInk();
  softFloodFill(fillBmp, 0, 0, RED, { tolerance: 255 }, fillInk);
  assert.deepEqual([...new Set(fillInk.sources)], [RED.join()], 'fill mode offers the fill colour');

  const eraseBmp = createBitmap(2, 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(eraseBmp, x, y, [0, 0, 0, 255]);
  const eraseInk = spyInk();
  softFloodFill(eraseBmp, 0, 0, RED, { mode: 'erase', tolerance: 255 }, eraseInk);
  assert.deepEqual([...new Set(eraseInk.sources)], ['0,0,0,0'],
    'erase mode must offer transparent black, not the colour a fill would have used');
});

test('softFloodFill with a skipping ink still terminates', () => {
  const bmp = createBitmap(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPixel(bmp, x, y, [0, 0, 0, 255]);
  let offered = 0;
  const ink = { write(b, x, y) { offered++; if (offered > 4096) throw new Error('runaway traversal'); if (x % 2 === 0 && y % 2 === 0) setPixel(b, x, y, GREEN); } };
  softFloodFill(bmp, 0, 0, [255, 255, 255, 255], { tolerance: 255 }, ink);
  assert.equal(offered, 256, 'each pixel offered exactly once');
});

// --- gaps found in review ---------------------------------------------------

test('drawRect routes its INTERIOR through the ink, not just its border', () => {
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawRect(bmp, 0, 0, 3, 3, RED, true, ink);
  assert.ok(ink.seen.includes('1,1'), 'an interior pixel must be offered to the ink');
  assert.deepEqual([...getPixel(bmp, 1, 1)], GREEN, 'the interior must be written by the ink');
});

test('a two-colour rect offers each pixel its own source colour', () => {
  // drawRect takes `filled` as an rgba array for two-colour shapes, and the
  // distinction has to survive the ink. `put` used to drop `rgba` whenever an
  // ink was present, so both branches painted the ink's primary and a filled
  // rect with a red outline and a blue interior came back solid red. The ink
  // is still the authority on what actually lands (this spy writes GREEN
  // regardless) -- but it must be TOLD which colour the caller meant.
  const bmp = createBitmap(8, 8);
  const BLUE = [0, 0, 255, 255];
  const ink = spyInk();
  drawRect(bmp, 0, 0, 3, 3, RED, BLUE, ink);
  const offered = new Map(ink.seen.map((key, i) => [key, ink.sources[i]]));
  assert.equal(offered.get('0,0'), RED.join(), 'the border must be offered the outline colour');
  assert.equal(offered.get('1,1'), BLUE.join(), 'the interior must be offered the fill colour');
  assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN, 'the ink still decides what lands');
  assert.deepEqual([...getPixel(bmp, 1, 1)], GREEN);
});

test('drawLine offers the ink the colour it was called with', () => {
  // Not just drawRect: threading the caller's colour is a general mechanism.
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  drawLine(bmp, 0, 0, 2, 0, RED, 1, ink);
  assert.deepEqual(ink.sources, [RED.join(), RED.join(), RED.join()]);
});

test('a primitive called without an ink is untouched by the source-colour path', () => {
  // The no-ink fallback still writes rgba straight to the bitmap.
  const bmp = createBitmap(8, 8);
  const BLUE = [0, 0, 255, 255];
  drawRect(bmp, 0, 0, 3, 3, RED, BLUE);
  assert.deepEqual([...getPixel(bmp, 0, 0)], RED, 'border');
  assert.deepEqual([...getPixel(bmp, 1, 1)], BLUE, 'interior');
});

test('an even-width mask grid anchors top-left-biased, since it has no exact centre', () => {
  // halfX = (2 - 1) >> 1 = 0, so a 2x2 grid at (4,4) covers (4,4)..(5,5).
  const bmp = createBitmap(8, 8);
  const ink = spyInk();
  const grid = { width: 2, height: 2, bits: Uint8Array.from([1, 1, 1, 1]) };
  drawLine(bmp, 4, 4, 4, 4, RED, 2, ink, grid);
  assert.deepEqual(ink.seen.sort(), ['4,4', '4,5', '5,4', '5,5']);
});

test('a mask grid whose cells fall outside the bitmap does not throw', () => {
  const bmp = createBitmap(4, 4);
  const ink = spyInk();
  const grid = { width: 3, height: 3, bits: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]) };
  drawLine(bmp, 0, 0, 0, 0, RED, 3, ink, grid);
  assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN, 'in-bounds cells still land');
});
