import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGbaBinary, buildNesChr } from '../js/app/platformExport.js';

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
