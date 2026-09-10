// tests/brush-io.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { normalizeBrush } from '../js/core/brushes.js';
import {
  brushToBitmap, bitmapToBrush, serializeBrushJson, parseBrushJson,
  serializeLibraryJson, parseLibraryJson,
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
