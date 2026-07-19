import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGbaBinary, buildNesChr, buildSnesBinary,
  checkGbaCompatibility, checkNesCompatibility, checkSnesCompatibility,
} from '../js/app/platformExport.js';

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
