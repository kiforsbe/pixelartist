import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGbaBinary, buildNesChr, buildSnesBinary, buildGbBinary, buildGbcBinary, buildC64Binary,
  checkGbaCompatibility, checkNesCompatibility, checkSnesCompatibility,
  checkGbCompatibility, checkGbcCompatibility, checkC64Compatibility,
} from '../js/app/platformExport.js';
import { C64_PALETTE } from '../js/core/platforms.js';

function item(name, w, h) { return { name, w, h, indices: new Uint8Array(w * h) }; }

test('buildGbaBinary: palette packs to 2-byte little-endian BGR555, black/white checkpoints', () => {
  const { pal } = buildGbaBinary({
    palette: [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 0, 255]],
    items: [],
  });
  // black = 0x0000, white = 0x7FFF (both bytes low-first)
  assert.deepEqual([...pal.slice(0, 2)], [0x00, 0x00]);
  assert.deepEqual([...pal.slice(2, 4)], [0xff, 0x7f]);
  // pure red: r=31 -> value 0x001F -> bytes [0x1F, 0x00]
  assert.deepEqual([...pal.slice(4, 6)], [0x1f, 0x00]);
  // pure blue: b=31<<10 -> value 0x7C00 -> bytes [0x00, 0x7C]
  assert.deepEqual([...pal.slice(6, 8)], [0x00, 0x7c]);
});

test('buildGbaBinary: tile data is the same packed bytes as c99Export\'s gba4 target, concatenated', () => {
  const indices = new Uint8Array(64);
  indices[0] = 5; indices[1] = 10; // matches c99Export.test.mjs's hand-verified gba4 fixture
  const { tiles } = buildGbaBinary({
    palette: Array.from({ length: 16 }, () => [0, 0, 0]),
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  assert.equal(tiles.length, 32);
  assert.equal(tiles[0], 0xa5); // 5 | (10<<4)
  assert.equal(tiles[1], 0x00);
});

test('buildGbaBinary: rejects a palette larger than 16 colors', () => {
  const palette = Array.from({ length: 17 }, () => [0, 0, 0]);
  assert.throws(() => buildGbaBinary({ palette, items: [] }), /at most 16 colors/);
});

test('buildNesChr: raw concatenated CHR bytes, no header, matches c99Export\'s nes2 packing', () => {
  const row = [0, 1, 2, 3, 0, 1, 2, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const chr = buildNesChr({ items: [{ name: 'tile0', w: 8, h: 8, indices }] });
  assert.equal(chr.length, 16); // one tile, no header
  assert.deepEqual([...chr.slice(0, 8)], Array(8).fill(0x55)); // plane0
  assert.deepEqual([...chr.slice(8, 16)], Array(8).fill(0x33)); // plane1
});

test('buildNesChr: multiple items concatenate back-to-back, matching a real CHR-ROM bank layout', () => {
  const a = new Uint8Array(64); // all index 0
  const b = new Uint8Array(64).fill(3); // all index 3
  const chr = buildNesChr({ items: [{ name: 'a', w: 8, h: 8, indices: a }, { name: 'b', w: 8, h: 8, indices: b }] });
  assert.equal(chr.length, 32);
  assert.deepEqual([...chr.slice(0, 16)], Array(16).fill(0)); // tile a: index 0 everywhere -> all-zero bytes
  assert.deepEqual([...chr.slice(16, 24)], Array(8).fill(0xff)); // tile b plane0: bit1 of index3 set everywhere
  assert.deepEqual([...chr.slice(24, 32)], Array(8).fill(0xff)); // tile b plane1
});

test('buildSnesBinary: palette uses the same BGR555 encoding as GBA (black/white checkpoints)', () => {
  const { pal } = buildSnesBinary({
    palette: [[0, 0, 0], [255, 255, 255]],
    items: [],
  });
  assert.deepEqual([...pal.slice(0, 2)], [0x00, 0x00]);
  assert.deepEqual([...pal.slice(2, 4)], [0xff, 0x7f]);
});

test('buildSnesBinary: tile data matches c99Export\'s snes4 interleaved-bitplane packing', () => {
  const row = [8, 9, 10, 11, 12, 13, 14, 15];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { tiles } = buildSnesBinary({
    palette: Array.from({ length: 16 }, () => [0, 0, 0]),
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  assert.equal(tiles.length, 32);
  assert.deepEqual([...tiles.slice(0, 16)], Array.from({ length: 8 }, () => [0x55, 0x33]).flat());
  assert.deepEqual([...tiles.slice(16, 32)], Array.from({ length: 8 }, () => [0x0f, 0xff]).flat());
});

test('buildSnesBinary: rejects a palette larger than 16 colors', () => {
  const palette = Array.from({ length: 17 }, () => [0, 0, 0]);
  assert.throws(() => buildSnesBinary({ palette, items: [] }), /at most 16 colors/);
});

test('checkGbaCompatibility: clean, in-budget content has no errors or warnings', () => {
  const { errors, warnings } = checkGbaCompatibility({ sourceColorCount: 12, items: [item('a', 16, 16)] });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('checkGbaCompatibility: flags non-8-multiple dimensions as a blocking error', () => {
  const { errors } = checkGbaCompatibility({ sourceColorCount: 4, items: [item('a', 8, 8), item('bad', 5, 8)] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad.*5x8/);
});

test('checkGbaCompatibility: warns when source colors exceed the 16-color palette bank', () => {
  const { warnings } = checkGbaCompatibility({ sourceColorCount: 20, items: [item('a', 8, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /20 colors/);
  assert.match(warnings[0], /at most 16/);
});

test('checkGbaCompatibility: warns when tile count exceeds the 1024-tile OBJ VRAM budget', () => {
  const { warnings } = checkGbaCompatibility({ sourceColorCount: 4, items: [item('big', 8 * 1025, 8)] }); // 1025 tiles > 1024
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds the GBA's 1024-tile/);
});

test('checkNesCompatibility: warns when source colors exceed the 4-color (3+transparent) tile palette', () => {
  const { warnings } = checkNesCompatibility({ sourceColorCount: 6, items: [item('a', 8, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /6 colors/);
  assert.match(warnings[0], /at most 4/);
});

test('checkNesCompatibility: warns when tile count exceeds the 256-tile pattern table', () => {
  const { warnings } = checkNesCompatibility({ sourceColorCount: 4, items: [item('big', 8 * 300, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds one 256-tile/);
});

test('checkSnesCompatibility: clean, in-budget content has no errors or warnings', () => {
  const { errors, warnings } = checkSnesCompatibility({ sourceColorCount: 12, items: [item('a', 16, 16)] });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('checkSnesCompatibility: flags non-8-multiple dimensions as a blocking error', () => {
  const { errors } = checkSnesCompatibility({ sourceColorCount: 4, items: [item('bad', 5, 8)] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad.*5x8/);
});

test('checkSnesCompatibility: warns when source colors exceed the 16-color CGRAM palette', () => {
  const { warnings } = checkSnesCompatibility({ sourceColorCount: 20, items: [item('a', 8, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /20 colors/);
  assert.match(warnings[0], /at most 16/);
});

test('checkSnesCompatibility: warns when tile count exceeds the 1024-tile VRAM budget', () => {
  const { warnings } = checkSnesCompatibility({ sourceColorCount: 4, items: [item('big', 8 * 1025, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds one 4bpp background layer's 1024-tile/);
});

test('buildGbBinary: ships only packed tile bytes, no palette file (DMG has no RGB palette in ROM data)', () => {
  const row = [0, 1, 2, 3, 0, 1, 2, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const tiles = buildGbBinary({ items: [{ name: 'tile0', w: 8, h: 8, indices }] });
  assert.equal(tiles.length, 16);
  assert.deepEqual([...tiles], Array.from({ length: 8 }, () => [0x55, 0x33]).flat());
});

test('buildGbcBinary: palette uses the same BGR555 encoding as GBA/SNES', () => {
  const { pal } = buildGbcBinary({ palette: [[0, 0, 0], [255, 255, 255]], items: [] });
  assert.deepEqual([...pal.slice(0, 2)], [0x00, 0x00]);
  assert.deepEqual([...pal.slice(2, 4)], [0xff, 0x7f]);
});

test('buildGbcBinary: rejects a palette larger than 4 colors', () => {
  const palette = Array.from({ length: 5 }, () => [0, 0, 0]);
  assert.throws(() => buildGbcBinary({ palette, items: [] }), /at most 4 colors/);
});

test('checkGbCompatibility: warns when source colors exceed the 4-shade tile palette', () => {
  const { warnings } = checkGbCompatibility({ sourceColorCount: 6, items: [item('a', 8, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /6 colors/);
  assert.match(warnings[0], /at most 4/);
});

test('checkGbCompatibility: warns when tile count exceeds the 384-tile VRAM budget', () => {
  const { warnings } = checkGbCompatibility({ sourceColorCount: 4, items: [item('big', 8 * 400, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds the Game Boy's 384-tile/);
});

test('checkGbcCompatibility: warns when tile count exceeds the 768-tile (two-bank) VRAM budget', () => {
  const { warnings } = checkGbcCompatibility({ sourceColorCount: 4, items: [item('big', 8 * 800, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds the Game Boy Color's 768-tile/);
});

test('buildC64Binary: background comes from the most-frequent (first) palette color, mapped to the nearest real VIC-II index', () => {
  const black = C64_PALETTE[0]; // 000000, index 0
  const white = C64_PALETTE[1]; // ffffff, index 1
  const { background, screenRam, colorRam } = buildC64Binary({
    palette: [black, white],
    items: [{ name: 'a', w: 8, h: 8, indices: new Uint8Array(64) }],
  });
  assert.equal(background, 0);
  assert.equal(screenRam[0], 1 << 4); // s1 = white(1), s2 defaults to background(0)
  assert.equal(colorRam[0], 0); // cr defaults to background(0)
});

test('buildC64Binary: tile data matches c99Export\'s c64mc packing, one entry per 8x8 cell', () => {
  const row = [0, 0, 1, 1, 2, 2, 3, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { bitmap, screenRam, colorRam } = buildC64Binary({
    palette: [C64_PALETTE[0], C64_PALETTE[1], C64_PALETTE[2], C64_PALETTE[3]],
    items: [{ name: 'a', w: 8, h: 8, indices }],
  });
  assert.equal(bitmap.length, 8);
  assert.deepEqual([...bitmap], Array(8).fill(0x1b)); // 0<<6|1<<4|2<<2|3
  assert.equal(screenRam.length, 1);
  assert.equal(colorRam.length, 1);
});

test('buildC64Binary: rejects a palette larger than 4 colors', () => {
  const palette = Array.from({ length: 5 }, () => [0, 0, 0]);
  assert.throws(() => buildC64Binary({ palette, items: [] }), /at most 4 colors/);
});

test('checkC64Compatibility: warns when source colors exceed the 4-color (1 shared bg + 3/cell) budget', () => {
  const { warnings } = checkC64Compatibility({ sourceColorCount: 6, items: [item('a', 8, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /6 colors/);
  assert.match(warnings[0], /at most 4/);
});

test('checkC64Compatibility: warns when double-wide pixel pairs disagree (lossy on export)', () => {
  const indices = new Uint8Array(64); // row of 8, alternating 0,1 -> every pair (0,1) disagrees, 4 pairs/row * 8 rows = 32
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) indices[y * 8 + x] = x % 2;
  const { warnings } = checkC64Compatibility({ sourceColorCount: 2, items: [{ name: 'a', w: 8, h: 8, indices }] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /32 double-wide pixel pair\(s\)/);
});

test('checkC64Compatibility: no paired-column warning when every pair already agrees', () => {
  const row = [0, 0, 1, 1, 2, 2, 3, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { warnings } = checkC64Compatibility({ sourceColorCount: 4, items: [{ name: 'a', w: 8, h: 8, indices }] });
  assert.deepEqual(warnings, []);
});

test('checkC64Compatibility: warns when cell count exceeds the 1000-cell bitmap budget', () => {
  const { warnings } = checkC64Compatibility({ sourceColorCount: 4, items: [item('big', 8 * 1001, 8)] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /exceeds the C64's 1000-cell/);
});

// -------------------------------------------------------------- paletteBudget
// (project.settings.exportColorMode === 'total') and the per-item overflow
// guard it makes reachable -- see js/app/main.js's resolveC99Items /
// SYSTEM_TOTAL_COLORS.

test('checkNesCompatibility: with a larger paletteBudget (system-total mode), a sheet-wide color count under that budget no longer warns', () => {
  const { warnings } = checkNesCompatibility({ sourceColorCount: 20, items: [item('a', 8, 8)], paletteBudget: 56 });
  assert.deepEqual(warnings, []);
});

test('checkNesCompatibility: paletteBudget still warns once the sheet-wide count exceeds it', () => {
  const { warnings } = checkNesCompatibility({ sourceColorCount: 60, items: [item('a', 8, 8)], paletteBudget: 56 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /60 colors/);
  assert.match(warnings[0], /at most 56/);
});

test('checkNesCompatibility: blocks export when a single item\'s own indices exceed the format\'s 4-value hardware limit, even under a larger paletteBudget', () => {
  const indices = new Uint8Array(64).fill(5); // index 5 -- only reachable when the shared palette exceeds 4 colors
  const { errors } = checkNesCompatibility({ sourceColorCount: 6, items: [{ name: 'overflowing', w: 8, h: 8, indices }], paletteBudget: 56 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /overflowing/);
  assert.match(errors[0], /more than 4/);
});

test('checkNesCompatibility: an item using only indices 0-3 never trips the overflow guard, regardless of paletteBudget', () => {
  const indices = new Uint8Array(64);
  indices.set([0, 1, 2, 3], 0);
  const { errors } = checkNesCompatibility({ sourceColorCount: 4, items: [{ name: 'a', w: 8, h: 8, indices }], paletteBudget: 56 });
  assert.deepEqual(errors, []);
});

test('checkC64Compatibility: also blocks on per-item index overflow (same guard, different format)', () => {
  const indices = new Uint8Array(64).fill(4); // index 4 -- c64mc is also a 2-bit/4-value format
  const { errors } = checkC64Compatibility({ sourceColorCount: 5, items: [{ name: 'overflowing', w: 8, h: 8, indices }], paletteBudget: 16 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /overflowing/);
  assert.match(errors[0], /more than 4/);
});

test('checkGbaCompatibility: 4bpp overflow guard trips past index 15, not before', () => {
  const okIndices = new Uint8Array(64).fill(15);
  assert.deepEqual(checkGbaCompatibility({ sourceColorCount: 16, items: [{ name: 'a', w: 8, h: 8, indices: okIndices }] }).errors, []);
  const overflowIndices = new Uint8Array(64).fill(16);
  const { errors } = checkGbaCompatibility({ sourceColorCount: 17, items: [{ name: 'b', w: 8, h: 8, indices: overflowIndices }] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /more than 16/);
});
