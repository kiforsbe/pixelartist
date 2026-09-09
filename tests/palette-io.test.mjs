import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE_FORMATS, formatFromFilename, paletteFilename,
  serializeGpl, parseGpl, serializeHex, parseHex, serializePal, parsePal,
  serializePaletteText, parsePaletteText,
  PALETTE_PNG_CELL, paletteToStripBitmap, bitmapToPaletteColors,
} from '../js/core/palette-io.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

function pal(overrides = {}) {
  return {
    id: 'p', name: 'My Palette', indexed: true,
    colors: [[255, 0, 0, 255], [0, 128, 0, 255], [0, 0, 0, 255]],
    empty: [false, false, true],
    emptyColor: [0, 0, 0, 255],
    lock: { size: 3, reason: 'NES' },
    ...overrides,
  };
}

test('formatFromFilename recognises the four formats and rejects anything else', () => {
  assert.deepEqual(PALETTE_FORMATS, ['gpl', 'hex', 'pal', 'png']);
  assert.equal(formatFromFilename('nes.gpl'), 'gpl');
  assert.equal(formatFromFilename('NES.GPL'), 'gpl');
  assert.equal(formatFromFilename('a.b.pal'), 'pal');
  assert.equal(formatFromFilename('notes.txt'), null);
  assert.equal(formatFromFilename('noextension'), null);
});

test('paletteFilename carries lock provenance, and sanitises path characters', () => {
  assert.equal(paletteFilename(pal(), 'gpl'), 'My Palette (NES 3).gpl');
  assert.equal(paletteFilename(pal({ lock: { size: 3, reason: '' } }), 'gpl'), 'My Palette (3).gpl');
  assert.equal(paletteFilename(pal({ lock: null }), 'hex'), 'My Palette.hex');
  assert.equal(paletteFilename(pal({ name: 'a/b:c', lock: null }), 'pal'), 'a_b_c.pal');
});

test('gpl round-trips name, colors and the lock comment', () => {
  const text = serializeGpl(pal());
  assert.match(text, /^GIMP Palette\r?\n/);
  assert.match(text, /Name: My Palette/);
  assert.match(text, /# Locked to 3 entries \(NES\)/);
  const back = parseGpl(text);
  assert.equal(back.name, 'My Palette');
  assert.deepEqual(back.colors, [[255, 0, 0, 255], [0, 128, 0, 255], [0, 0, 0, 255]]);
  assert.deepEqual(back.lock, { size: 3, reason: 'NES' });
});

test('gpl export writes every entry, empty slots included', () => {
  const lines = serializeGpl(pal()).trim().split(/\r?\n/);
  const colorLines = lines.filter(l => /^\s*\d+\s+\d+\s+\d+/.test(l));
  assert.equal(colorLines.length, 3);
});

test('gpl export omits the lock comment for an unlocked palette', () => {
  assert.doesNotMatch(serializeGpl(pal({ lock: null })), /Locked to/);
  assert.equal(parseGpl(serializeGpl(pal({ lock: null }))).lock, null);
});

test('gpl parse tolerates trailing color names, blank lines and unrelated comments', () => {
  const text = [
    'GIMP Palette', 'Name: Imported', 'Columns: 4', '# just a note', '',
    ' 17  34  51\tSteel', '255 255 255 White', 'garbage line',
  ].join('\n');
  const back = parseGpl(text);
  assert.equal(back.name, 'Imported');
  assert.deepEqual(back.colors, [[17, 34, 51, 255], [255, 255, 255, 255]]);
  assert.equal(back.lock, null);
});

test('hex round-trips one lowercase rrggbb per line and drops alpha', () => {
  const text = serializeHex(pal({ colors: [[255, 0, 0, 128], [0, 128, 0, 255]], empty: [false, false] }));
  assert.equal(text.trim(), 'ff0000\n008000');
  assert.deepEqual(parseHex(text).colors, [[255, 0, 0, 255], [0, 128, 0, 255]]);
});

test('hex parse tolerates # prefixes, whitespace and skips junk lines', () => {
  const back = parseHex('#FF0000\n  00ff00  \n\nnot-a-color\n#12345\n0000ff\n');
  assert.deepEqual(back.colors, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
  assert.equal(back.name, '');
  assert.equal(back.lock, null);
});

test('pal writes a JASC header whose third line is the entry count', () => {
  const lines = serializePal(pal()).trim().split(/\r?\n/);
  assert.deepEqual(lines.slice(0, 3), ['JASC-PAL', '0100', '3']);
  assert.deepEqual(parsePal(serializePal(pal())).colors, pal().colors);
});

test('pal parse honours the declared count and rejects a non-JASC file', () => {
  const back = parsePal('JASC-PAL\r\n0100\r\n2\r\n1 2 3\r\n4 5 6\r\n7 8 9\r\n');
  assert.deepEqual(back.colors, [[1, 2, 3, 255], [4, 5, 6, 255]]);
  assert.throws(() => parsePal('not a palette'), /JASC-PAL/);
});

test('serializePaletteText and parsePaletteText dispatch by format, and refuse png', () => {
  assert.equal(serializePaletteText(pal(), 'hex'), serializeHex(pal()));
  assert.deepEqual(parsePaletteText(serializeGpl(pal()), 'gpl').lock, { size: 3, reason: 'NES' });
  assert.throws(() => serializePaletteText(pal(), 'png'), /png/);
  assert.throws(() => parsePaletteText('x', 'png'), /png/);
});

test('paletteToStripBitmap lays every entry out as an opaque cell, wrapping into rows', () => {
  const p = pal({ colors: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]], empty: [false, false, false] });
  const bmp = paletteToStripBitmap(p, { cell: 2, columns: 2 });
  assert.equal(bmp.width, 4);
  assert.equal(bmp.height, 4);              // 3 entries over 2 columns -> 2 rows
  assert.deepEqual(getPixel(bmp, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(bmp, 2, 0), [0, 255, 0, 255]);
  assert.deepEqual(getPixel(bmp, 0, 2), [0, 0, 255, 255]);
  assert.deepEqual(getPixel(bmp, 3, 3), [0, 0, 0, 0]);   // unused tail cell stays transparent
});

test('paletteToStripBitmap writes empty slots too -- an exported palette keeps its entry count', () => {
  const p = pal({ colors: [[1, 1, 1, 255], [0, 0, 0, 255]], empty: [false, true], lock: { size: 2, reason: '' } });
  const bmp = paletteToStripBitmap(p, { cell: 1, columns: 2 });
  assert.equal(bmp.width, 2);
  assert.deepEqual(getPixel(bmp, 1, 0), [0, 0, 0, 255]);
});

test('paletteToStripBitmap on an empty palette produces a 1x1 transparent bitmap rather than a zero-size one', () => {
  const bmp = paletteToStripBitmap(pal({ colors: [], empty: [], lock: null }), { cell: 4, columns: 4 });
  assert.equal(bmp.width, 1);
  assert.equal(bmp.height, 1);
});

test('bitmapToPaletteColors returns unique opaque colors, most frequent first', () => {
  const b = createBitmap(4, 1);
  setPixel(b, 0, 0, [9, 9, 9, 255]);
  setPixel(b, 1, 0, [1, 2, 3, 255]);
  setPixel(b, 2, 0, [9, 9, 9, 255]);
  setPixel(b, 3, 0, [0, 0, 0, 0]);
  assert.deepEqual(bitmapToPaletteColors(b), [[9, 9, 9, 255], [1, 2, 3, 255]]);
});

test('bitmapToPaletteColors collapses colors that differ only in alpha', () => {
  const b = createBitmap(2, 1);
  setPixel(b, 0, 0, [5, 5, 5, 255]);
  setPixel(b, 1, 0, [5, 5, 5, 128]);
  assert.deepEqual(bitmapToPaletteColors(b), [[5, 5, 5, 255]]);
});

test('a palette survives a strip round-trip when its colors are distinct', () => {
  const colors = [[10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255]];
  const bmp = paletteToStripBitmap(pal({ colors, empty: [false, false, false] }), { cell: 3, columns: 3 });
  const back = bitmapToPaletteColors(bmp);
  assert.equal(back.length, 3);
  for (const c of colors) assert.ok(back.some(b => b.join() === c.join()), `${c} survived`);
});

test('PALETTE_PNG_CELL is the default swatch size', () => {
  assert.equal(PALETTE_PNG_CELL, 16);
  assert.equal(paletteToStripBitmap(pal({ colors: [[1, 2, 3, 255]], empty: [false] })).width, 16);
});
