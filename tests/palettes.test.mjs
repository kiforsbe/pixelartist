import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPalette, parseHexColors, setEntry, addSwatch, removeSwatch,
  moveSwatch, nearestColor, remapColor, quantizeBitmapToPalette, INDEXED_SIZE_PRESETS,
} from '../js/core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../js/core/systempalettes.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

test('parseHexColors', () => {
  assert.deepEqual(parseHexColors('ff0000 00ff00'), [[255,0,0,255],[0,255,0,255]]);
});

test('indexed palette pre-filled, addSwatch forbidden', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 4 });
  assert.equal(p.colors.length, 4);
  assert.throws(() => addSwatch(p, [1,2,3,255]));
  setEntry(p, 2, [10,20,30,255]);
  assert.deepEqual(p.colors[2], [10,20,30,255]);
});

test('non-indexed palette grows, remove and move work', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]); addSwatch(p, [2,2,2,255]); addSwatch(p, [3,3,3,255]);
  moveSwatch(p, 2, 0);
  assert.deepEqual(p.colors[0], [3,3,3,255]);
  removeSwatch(p, 0);
  assert.equal(p.colors.length, 2);
});

test('nearestColor picks closest, keeps input alpha', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2 });
  setEntry(p, 0, [0,0,0,255]); setEntry(p, 1, [200,200,200,255]);
  assert.deepEqual(nearestColor(p, [190,190,190,128]), [200,200,200,128]);
});

test('remapColor recolors exact matches only', () => {
  const b = createBitmap(3, 1);
  setPixel(b, 0, 0, [5,5,5,255]); setPixel(b, 1, 0, [5,5,5,254]);
  const n = remapColor(b, [5,5,5,255], [9,9,9,255]);
  assert.equal(n, 1);
  assert.deepEqual(getPixel(b, 0, 0), [9,9,9,255]);
  assert.deepEqual(getPixel(b, 1, 0), [5,5,5,254]);
});

test('system palettes present with expected sizes', () => {
  const names = SYSTEM_PALETTES.map(p => p.name);
  assert.ok(names.includes('Game Boy') && names.includes('PICO-8') && names.includes('NES'));
  const gb = SYSTEM_PALETTES.find(p => p.name === 'Game Boy');
  assert.equal(gb.colors.length, 4);
  const ega = SYSTEM_PALETTES.find(p => p.name === 'EGA (64)');
  assert.equal(ega.colors.length, 64);
  for (const sys of SYSTEM_PALETTES) {
    const seen = new Set(sys.colors.map(c => c.join(',')));
    assert.equal(seen.size, sys.colors.length, `${sys.name} has duplicate colors`);
  }
  const clone = clonePalette(gb);
  assert.equal(clone.indexed, true);
  assert.equal(clone.size, 4);
  assert.ok(clone.id);
});

test('size presets exported', () => {
  assert.deepEqual(INDEXED_SIZE_PRESETS, [2, 4, 16, 256]);
});

test('quantizeBitmapToPalette: maps opaque pixels to nearest palette color, preserves alpha; skips fully transparent pixels', () => {
  const b = createBitmap(3, 1);
  setPixel(b, 0, 0, [250, 5, 5, 255]);   // near red
  setPixel(b, 1, 0, [5, 5, 250, 128]);   // near blue, half alpha
  setPixel(b, 2, 0, [9, 9, 9, 0]);       // fully transparent -- must stay untouched
  const palette = { colors: [[255, 0, 0, 255], [0, 0, 255, 255]] };
  quantizeBitmapToPalette(b, palette);
  assert.deepEqual(getPixel(b, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(b, 1, 0), [0, 0, 255, 128]);
  assert.deepEqual(getPixel(b, 2, 0), [9, 9, 9, 0]);
});

test('quantizeBitmapToPalette: exact palette match is left byte-identical', () => {
  const b = createBitmap(1, 1);
  setPixel(b, 0, 0, [0, 0, 255, 255]);
  quantizeBitmapToPalette(b, { colors: [[255, 0, 0, 255], [0, 0, 255, 255]] });
  assert.deepEqual(getPixel(b, 0, 0), [0, 0, 255, 255]);
});
