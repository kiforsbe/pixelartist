import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildC99 } from '../js/app/c99Export.js';

test('buildC99 generic8: one byte per pixel, palette as [r,g,b] rows', () => {
  const { h, c } = buildC99({
    projectName: 'demo', target: 'generic8',
    palette: [[255, 0, 0], [0, 255, 0]],
    items: [{ name: 'tile0', w: 2, h: 1, indices: new Uint8Array([0, 1]) }],
  });
  assert.match(h, /extern const unsigned char demo_palette\[2\]\[3\];/);
  assert.match(h, /extern const unsigned char demo_tile0\[2\];/);
  assert.match(c, /const unsigned char demo_tile0\[2\] = \{0x00,0x01\};/);
  assert.match(c, /\{0xff,0x00,0x00\},\{0x00,0xff,0x00\}/);
});

test('buildC99 gba4: 8x8 tile packs to 32 bytes, low nibble = left pixel', () => {
  const indices = new Uint8Array(64); // all zero except the first two pixels
  indices[0] = 5; indices[1] = 10;
  const { c } = buildC99({
    projectName: 'demo', target: 'gba4',
    palette: Array.from({ length: 16 }, () => [0, 0, 0]),
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  // byte0 = left(5) | right(10)<<4 = 5 | 160 = 165 = 0xa5; every other byte 0
  assert.match(c, /demo_tile0\[32\] = \{0xa5,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00\}/);
});

test('buildC99 nes2: 8x8 tile packs to 16 bytes, two 8-byte bitplanes', () => {
  // every row: values 0,1,2,3 repeated -> plane0=0x55, plane1=0x33 (see
  // design doc's NES section for the bit-by-bit derivation)
  const row = [0, 1, 2, 3, 0, 1, 2, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { c } = buildC99({
    projectName: 'demo', target: 'nes2',
    palette: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]],
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  const expected = [...Array(8).fill('0x55'), ...Array(8).fill('0x33')].join(',');
  assert.match(c, new RegExp(`demo_tile0\\[16\\] = \\{${expected}\\}`));
});

test('buildC99: gba4/nes2 reject dimensions not a multiple of 8', () => {
  const items = [{ name: 't', w: 5, h: 8, indices: new Uint8Array(40) }];
  assert.throws(() => buildC99({ projectName: 'd', target: 'gba4', palette: [[0, 0, 0]], items }),
    /multiples of 8/);
});

test('buildC99: rejects a palette larger than the target supports', () => {
  const palette = Array.from({ length: 5 }, () => [0, 0, 0]);
  assert.throws(() => buildC99({ projectName: 'd', target: 'nes2', palette, items: [] }),
    /at most 4 colors/);
});
