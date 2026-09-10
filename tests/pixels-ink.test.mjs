import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, getPixel, setPixel, drawLine, drawRect, drawEllipse, floodFill } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];

// A recording ink that writes green and logs every coordinate it is given.
function spyInk() {
  const seen = [];
  return { seen, write(bmp, x, y) { seen.push(`${x},${y}`); setPixel(bmp, x, y, GREEN); } };
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
