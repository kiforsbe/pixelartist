import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPalette, parseHexColors, setEntry, addSwatch, removeSwatch,
  moveSwatch, nearestColor, remapColor, quantizeBitmapToPalette, INDEXED_SIZE_PRESETS,
  DEFAULT_EMPTY_COLOR, normalizePalette,
  clearEntry, setEmptyColor, setLock, sortOrder, applyOrder, countPaletteUsage,
} from '../js/core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../js/core/systempalettes.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

test('parseHexColors', () => {
  assert.deepEqual(parseHexColors('ff0000 00ff00'), [[255,0,0,255],[0,255,0,255]]);
});

test('createPalette with a size pre-fills empty slots and locks to that size', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 4, lockReason: 'NES' });
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.empty, [true, true, true, true]);
  assert.deepEqual(p.emptyColor, DEFAULT_EMPTY_COLOR);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
  assert.equal('size' in p, false);
  // every slot starts at the palette's own unset color
  for (const c of p.colors) assert.deepEqual(c, DEFAULT_EMPTY_COLOR);
});

test('createPalette without a size is unlocked and starts empty', () => {
  const p = createPalette({ name: 'free' });
  assert.deepEqual(p.colors, []);
  assert.deepEqual(p.empty, []);
  assert.equal(p.lock, null);
});

test('normalizePalette locks a legacy indexed palette to its own color count', () => {
  const p = normalizePalette({ id: 'p1', name: 'Old', indexed: true, size: 4, colors: [[1,1,1,255],[2,2,2,255]] });
  // colors.length wins over the stored size
  assert.deepEqual(p.lock, { size: 2, reason: '' });
  assert.deepEqual(p.empty, [false, false]);
  assert.deepEqual(p.emptyColor, DEFAULT_EMPTY_COLOR);
  assert.equal('size' in p, false);
});

test('normalizePalette leaves a legacy free palette unlocked', () => {
  const p = normalizePalette({ id: 'p2', name: 'Old', indexed: false, size: 0, colors: [[1,1,1,255]] });
  assert.equal(p.lock, null);
  assert.deepEqual(p.empty, [false]);
});

test('normalizePalette keeps an already-new-shape palette intact', () => {
  const p = normalizePalette({
    id: 'p3', name: 'New', indexed: true,
    colors: [[1,1,1,255],[9,9,9,255]], empty: [false, true],
    emptyColor: [9,9,9,255], lock: { size: 2, reason: 'Game Boy' },
  });
  assert.deepEqual(p.empty, [false, true]);
  assert.deepEqual(p.emptyColor, [9,9,9,255]);
  assert.deepEqual(p.lock, { size: 2, reason: 'Game Boy' });
});

test('normalizePalette keeps an unlocked new-shape indexed palette unlocked', () => {
  const p = normalizePalette({
    id: 'p5', name: 'Free indexed', indexed: true,
    colors: [[1,1,1,255]], empty: [false],
    emptyColor: [0,0,0,255], lock: null,
  });
  assert.equal(p.lock, null);
  assert.equal(p.indexed, true);
});

test('normalizePalette drops a mismatched empty array rather than trusting it', () => {
  const p = normalizePalette({ id: 'p4', name: 'Bad', indexed: false, colors: [[1,1,1,255],[2,2,2,255]], empty: [true] });
  assert.deepEqual(p.empty, [false, false]);
});

test('an unlocked palette grows, removes and moves, carrying empty flags along', () => {
  const p = createPalette({ name: 'free' });
  assert.equal(addSwatch(p, [1,1,1,255]), 0);
  addSwatch(p, [2,2,2,255]);
  addSwatch(p, [3,3,3,255]);
  assert.deepEqual(p.empty, [false, false, false]);
  moveSwatch(p, 2, 0);
  assert.deepEqual(p.colors[0], [3,3,3,255]);
  removeSwatch(p, 0);
  assert.equal(p.colors.length, 2);
  assert.equal(p.empty.length, 2);
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
  assert.deepEqual(clone.lock, { size: 4, reason: 'Game Boy' });
  assert.equal(clone.colors.length, 4);
  assert.deepEqual(clone.empty, [false, false, false, false]);
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

test('quantizeBitmapToPalette ordered dither: mid-gray against black/white splits 8/8 per the Bayer matrix', () => {
  const b = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(b, x, y, [128, 128, 128, 255]);
  const palette = { colors: [[0, 0, 0, 255], [255, 255, 255, 255]] };
  quantizeBitmapToPalette(b, palette, 'ordered');
  let black = 0, white = 0;
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const [r] = getPixel(b, x, y);
    r === 0 ? black++ : white++;
  }
  assert.equal(black, 8);
  assert.equal(white, 8);
});

test('quantizeBitmapToPalette floyd-steinberg dither: diffuses error forward along a uniform row', () => {
  const b = createBitmap(4, 1);
  for (let x = 0; x < 4; x++) setPixel(b, x, 0, [100, 100, 100, 255]);
  const palette = { colors: [[0, 0, 0, 255], [255, 255, 255, 255]] };
  quantizeBitmapToPalette(b, palette, 'floyd-steinberg');
  assert.deepEqual([0, 1, 2, 3].map(x => getPixel(b, x, 0)[0]), [0, 255, 0, 0]);
});

test('quantizeBitmapToPalette atkinson dither: only diffuses 6/8 of the error, so it converges differently than Floyd-Steinberg', () => {
  const b = createBitmap(4, 1);
  for (let x = 0; x < 4; x++) setPixel(b, x, 0, [100, 100, 100, 255]);
  const palette = { colors: [[0, 0, 0, 255], [255, 255, 255, 255]] };
  quantizeBitmapToPalette(b, palette, 'atkinson');
  assert.deepEqual([0, 1, 2, 3].map(x => getPixel(b, x, 0)[0]), [0, 0, 0, 255]);
});

test('quantizeBitmapToPalette error-diffusion dither: a fully transparent pixel stays untouched and does not leak error to/from its neighbor', () => {
  const b = createBitmap(2, 1);
  setPixel(b, 0, 0, [10, 10, 10, 0]);   // fully transparent
  setPixel(b, 1, 0, [100, 100, 100, 255]);
  const palette = { colors: [[0, 0, 0, 255], [255, 255, 255, 255]] };
  quantizeBitmapToPalette(b, palette, 'floyd-steinberg');
  assert.deepEqual(getPixel(b, 0, 0), [10, 10, 10, 0]);
  assert.deepEqual(getPixel(b, 1, 0), [0, 0, 0, 255]);
});

test('addSwatch fills a locked palette first empty slot, then reports full', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2 });
  assert.equal(addSwatch(p, [1,1,1,255]), 0);
  assert.deepEqual(p.empty, [false, true]);
  assert.equal(addSwatch(p, [2,2,2,255]), 1);
  assert.equal(addSwatch(p, [3,3,3,255]), -1);
  assert.equal(p.colors.length, 2);              // never grew past the lock
  assert.deepEqual(p.colors[1], [2,2,2,255]);
});

test('removeSwatch clears in place on a locked palette so lower indices do not shift', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 0, [1,1,1,255]); setEntry(p, 1, [2,2,2,255]); setEntry(p, 2, [3,3,3,255]);
  removeSwatch(p, 1);
  assert.equal(p.colors.length, 3);
  assert.deepEqual(p.colors[2], [3,3,3,255]);    // index 2 stayed put
  assert.deepEqual(p.empty, [false, true, false]);
  assert.deepEqual(p.colors[1], p.emptyColor);
});

test('moveSwatch carries the empty flag with its color', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 0, [1,1,1,255]); setEntry(p, 2, [3,3,3,255]);
  // slot 1 is still empty
  moveSwatch(p, 1, 0);
  assert.deepEqual(p.empty, [true, false, false]);
  assert.deepEqual(p.colors[1], [1,1,1,255]);
});

test('setEmptyColor re-syncs every still-empty slot and leaves decided ones alone', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 1, [7,7,7,255]);
  setEmptyColor(p, [200, 0, 200, 255]);
  assert.deepEqual(p.colors[0], [200, 0, 200, 255]);
  assert.deepEqual(p.colors[2], [200, 0, 200, 255]);
  assert.deepEqual(p.colors[1], [7,7,7,255]);
  assert.deepEqual(p.emptyColor, [200, 0, 200, 255]);
});

test('assigning black to a slot clears its empty flag -- the flag is the whole distinction', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 1 });
  assert.equal(p.empty[0], true);
  setEntry(p, 0, [0, 0, 0, 255]);              // same bytes as DEFAULT_EMPTY_COLOR
  assert.equal(p.empty[0], false);
});

test('clearEntry puts the palette unset color back and re-flags the slot', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]);
  setEmptyColor(p, [50,50,50,255]);
  clearEntry(p, 0);
  assert.deepEqual(p.colors[0], [50,50,50,255]);
  assert.equal(p.empty[0], true);
});

test('setLock pads a short palette with empty slots', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]);
  setLock(p, 4, 'NES');
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.empty, [false, true, true, true]);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
});

test('setLock truncates a long palette from the end', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]); addSwatch(p, [2,2,2,255]); addSwatch(p, [3,3,3,255]);
  setLock(p, 2, 'Game Boy');
  assert.equal(p.colors.length, 2);
  assert.deepEqual(p.colors[1], [2,2,2,255]);
  assert.deepEqual(p.lock, { size: 2, reason: 'Game Boy' });
});

test('setLock(null) unlocks and discards empty slots', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 1, [5,5,5,255]);
  setLock(p, null);
  assert.equal(p.lock, null);
  assert.deepEqual(p.colors, [[5,5,5,255]]);
  assert.deepEqual(p.empty, [false]);
});

test('sortOrder ranks by luminance, hue and usage, breaking ties by original index', () => {
  const colors = [[255,0,0,255], [0,0,0,255], [255,255,255,255], [0,0,255,255]];
  assert.deepEqual(sortOrder(colors, 'luminance'), [1, 3, 0, 2]);
  // greys (hue -1) sort ahead of every real hue; red (0) before blue (240)
  assert.deepEqual(sortOrder(colors, 'hue'), [1, 2, 0, 3]);
  assert.deepEqual(sortOrder(colors, 'usage', [1, 9, 0, 9]), [1, 3, 0, 2]);
});

test('applyOrder permutes colors and empty flags together', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3 });
  setEntry(p, 0, [1,1,1,255]); setEntry(p, 2, [3,3,3,255]);
  applyOrder(p, [2, 1, 0]);
  assert.deepEqual(p.colors[0], [3,3,3,255]);
  assert.deepEqual(p.empty, [false, true, false]);
});

test('countPaletteUsage counts exact RGBA matches per slot and ignores transparent pixels', () => {
  const p = createPalette({ name: 'free' });
  addSwatch(p, [1,1,1,255]); addSwatch(p, [2,2,2,255]);
  const b = createBitmap(3, 1);
  setPixel(b, 0, 0, [1,1,1,255]);
  setPixel(b, 1, 0, [1,1,1,255]);
  setPixel(b, 2, 0, [0,0,0,0]);
  assert.deepEqual(countPaletteUsage(p, [b]), [2, 0]);
});
