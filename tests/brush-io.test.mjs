// tests/brush-io.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { normalizeBrush, MAX_CUSTOM_BITMAP_DIM } from '../js/core/brushes.js';
import {
  brushToBitmap, bitmapToBrush, serializeBrushJson, parseBrushJson,
  serializeLibraryJson, parseLibraryJson,
  brushFromSelection, boundedBrushRegion, toPlain, fromPlain,
} from '../js/core/brush-io.js';

test('bitmapToBrush treats opaque pixels as coverage', () => {
  const bmp = createBitmap(3, 3);
  setPixel(bmp, 1, 1, [10, 20, 30, 255]);
  const brush = bitmapToBrush(bmp, 'Dot');
  assert.equal(brush.mask.kind, 'custom');
  assert.equal(brush.name, 'Dot');
  assert.equal([...brush.mask.bitmap.bits].filter(Boolean).length, 1);
});

test('a custom brush round-trips through a bitmap', () => {
  const src = createBitmap(4, 4);
  setPixel(src, 0, 0, [255, 0, 0, 255]);
  setPixel(src, 3, 3, [0, 255, 0, 255]);
  const out = brushToBitmap(bitmapToBrush(src, 'RT'));
  assert.deepEqual([...getPixel(out, 0, 0)], [255, 0, 0, 255]);
  assert.deepEqual([...getPixel(out, 3, 3)], [0, 255, 0, 255]);
  assert.equal(getPixel(out, 1, 1)[3], 0);
});

test('brush JSON round-trips every field including ink and pressure', () => {
  const brush = normalizeBrush({
    name: 'Foliage',
    mask: { kind: 'circle', size: 5, scatter: 3, rotateJitter: true, rotate: 90 },
    ink: { kind: 'dither', opacity: 40, jitter: 2, pattern: 'checker' },
    pressure: { target: 'size', min: 2, max: 9, curve: 'soft' },
  });
  const back = parseBrushJson(serializeBrushJson(brush));
  assert.equal(back.name, 'Foliage');
  assert.equal(back.mask.scatter, 3);
  assert.equal(back.mask.rotateJitter, true);
  assert.equal(back.mask.rotate, 90);
  assert.equal(back.ink.opacity, 40);
  assert.equal(back.ink.pattern, 'checker');
  assert.equal(back.pressure.curve, 'soft');
});

test('a custom mask survives the JSON round-trip as a typed array', () => {
  const src = createBitmap(2, 2);
  setPixel(src, 0, 0, [1, 2, 3, 255]);
  const back = parseBrushJson(serializeBrushJson(bitmapToBrush(src, 'M')));
  assert.equal(back.mask.bitmap.bits instanceof Uint8Array, true);
  assert.equal(back.mask.bitmap.bits[0], 1);
});

test('parseBrushJson normalizes a hand-written partial file', () => {
  const b = parseBrushJson('{"name":"Hand","mask":{"kind":"circle","size":3}}');
  assert.equal(b.ink.kind, 'solid');
  assert.equal(b.pressure.target, 'none');
});

test('parseBrushJson rejects garbage', () => {
  assert.throws(() => parseBrushJson('not json'));
});

test('a whole library round-trips', () => {
  const lib = [normalizeBrush({ name: 'A' }), normalizeBrush({ name: 'B' })];
  const back = parseLibraryJson(serializeLibraryJson(lib));
  assert.deepEqual(back.map(b => b.name), ['A', 'B']);
});

test('parseLibraryJson rejects a file that is not a library', () => {
  assert.throws(() => parseLibraryJson('{"nope":1}'));
});

// ===========================================================================
// Amendment section B: refuse hostile brush files (Ruling 30)
// ===========================================================================
//
// rasterizeMask puts no upper bound on a custom bitmap's dimensions, so a
// brush file claiming {"width":1e9,"height":1e9} used to throw RangeError on
// the first paint, well after import appeared to succeed. brushes.js now
// clamps as a last line of defence (tested in brush-transform.test.mjs); this
// module goes further and refuses the file outright, which is a strictly
// stronger guarantee than clamping -- a parser that throws can never produce
// a garbage brush from a corrupt file in the first place.

test('parseBrushJson rejects a custom bitmap whose declared dimensions exceed the cap', () => {
  const hostile = JSON.stringify({
    name: 'Hostile', mask: { kind: 'custom', bitmap: { width: 1e9, height: 1e9, bits: [] } },
  });
  assert.throws(() => parseBrushJson(hostile), /exceeds the maximum allowed size/);
});

test('parseBrushJson rejects a custom bitmap whose bits length disagrees with width*height', () => {
  const hostile = JSON.stringify({
    name: 'Hostile', mask: { kind: 'custom', bitmap: { width: 4, height: 4, bits: [1, 1] } },
  });
  assert.throws(() => parseBrushJson(hostile), /bits length does not match/);
});

test('parseLibraryJson rejects a library containing one hostile brush', () => {
  const good = { ...normalizeBrush({ name: 'Good' }) };
  const hostile = { name: 'Hostile', mask: { kind: 'custom', bitmap: { width: 5e8, height: 5e8, bits: [] } } };
  const text = JSON.stringify({ version: 1, brushes: [good, hostile] });
  assert.throws(() => parseLibraryJson(text), /exceeds the maximum allowed size/);
});

test('a well-formed custom brush at ordinary size is untouched by the hostile-file guard', () => {
  // Anti-vacuity: the guard must not reject legitimate files just because it
  // exists. A real bitmapToBrush round-trip is exactly what must keep working.
  const src = createBitmap(8, 8);
  setPixel(src, 0, 0, [9, 9, 9, 255]);
  const back = parseBrushJson(serializeBrushJson(bitmapToBrush(src, 'Fine')));
  assert.equal(back.mask.bitmap.width, 8);
  assert.equal(back.mask.bitmap.bits.length, 64);
});

// --- Make Brush From Selection: the in-app PRODUCER of a custom mask ------
//
// The hostile-file guard above is right to throw for a downloaded file, but
// Task 15b then added an in-app producer that never passes through
// parseBrushJson, had no size bound, and no try/catch. Any marquee over 256px
// in either axis therefore produced a brush that library.add() threw on, from
// inside a CommandRegistry.execute that does not catch: no brush, no
// active-brush change, no feedback at all.
//
// Bounding the REGION is the fix, and it has to happen before the pixels are
// read -- clamping the finished mask inside rasterizeMask instead would make
// a latent shearing bug live, because that path re-reads an oversized
// source's bits at the DECLARED width.

test('a selection wider than the cap is bounded at capture instead of throwing', () => {
  // The exact reproduction: a 300x20 marquee.
  const sheet = createBitmap(400, 40);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 400; x++) setPixel(sheet, x, y, [1, 2, 3, 255]);
  const asked = { x: 0, y: 0, w: 300, h: 20 };

  const bounded = boundedBrushRegion(asked);
  assert.equal(bounded.w, MAX_CUSTOM_BITMAP_DIM, 'the over-cap axis must be bounded');
  assert.equal(bounded.h, 20, 'the axis that was already legal must be left alone');

  // The whole point: what capture produces must now survive the very guard
  // that used to reject it. fromPlain is what library.add() runs.
  const brush = brushFromSelection(sheet, asked, 'Selection brush');
  assert.doesNotThrow(() => fromPlain(toPlain(brush)));
  assert.equal(brush.mask.bitmap.width, MAX_CUSTOM_BITMAP_DIM);
  assert.equal(brush.mask.bitmap.bits.length, MAX_CUSTOM_BITMAP_DIM * 20);
});

test('bounding a selection crops it -- it does not SHEAR it', () => {
  // The discriminating test against the wrong fix. Clamping an oversized mask
  // inside rasterizeMask re-reads the source bits at the declared width, so a
  // vertical line comes out diagonal. Cropping the region before the pixels
  // are read cannot do that, because copyRegion gives a bitmap whose stride
  // matches its own width.
  const sheet = createBitmap(400, 40);
  const LINE_X = 5;
  for (let y = 0; y < 40; y++) setPixel(sheet, LINE_X, y, [255, 0, 0, 255]);

  const brush = brushFromSelection(sheet, { x: 0, y: 0, w: 300, h: 20 }, 'Line');
  const { width, bits } = brush.mask.bitmap;
  for (let y = 0; y < 20; y++) {
    const row = [];
    for (let x = 0; x < width; x++) if (bits[y * width + x]) row.push(x);
    assert.deepEqual(row, [LINE_X],
      `row ${y} has coverage at ${row.join(',')} -- a vertical line sheared into a diagonal`);
  }
});

test('a selection inside the cap is captured whole, bound or no bound', () => {
  // Anti-vacuity: the bound must not crop legitimate captures.
  const sheet = createBitmap(64, 64);
  setPixel(sheet, 10, 10, [7, 7, 7, 255]);
  const rect = { x: 4, y: 4, w: 20, h: 12 };
  assert.deepEqual(boundedBrushRegion(rect), rect);
  const brush = brushFromSelection(sheet, rect, 'Small');
  assert.equal(brush.mask.bitmap.width, 20);
  assert.equal(brush.mask.bitmap.height, 12);
  assert.equal([...brush.mask.bitmap.bits].filter(Boolean).length, 1);
});
