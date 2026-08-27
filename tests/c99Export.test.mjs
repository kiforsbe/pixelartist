import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildC99 } from '../js/core/export/c99Export.js';

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

test('buildC99 snes4: bitplanes 0+1 interleaved per row, then 2+3 interleaved per row', () => {
  // every row: pixels 8..15 (low 3 bits cycle 0-7, bit3 always set) ->
  // bp0=0x55, bp1=0x33, bp2=0x0f, bp3=0xff for every row (hand-derived,
  // see design doc's SNES section)
  const row = [8, 9, 10, 11, 12, 13, 14, 15];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { c } = buildC99({
    projectName: 'demo', target: 'snes4',
    palette: Array.from({ length: 16 }, () => [0, 0, 0]),
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  const bp01 = Array.from({ length: 8 }, () => ['0x55', '0x33']).flat();
  const bp23 = Array.from({ length: 8 }, () => ['0x0f', '0xff']).flat();
  const expected = [...bp01, ...bp23].join(',');
  assert.match(c, new RegExp(`demo_tile0\\[32\\] = \\{${expected}\\}`));
});

test('buildC99 gb2: row-interleaved 2bpp, matching nes2\'s bit values but byte-order per row', () => {
  // same row pattern (0,1,2,3 repeated) as the nes2 test -> per row lo=0x55,
  // hi=0x33 (same bit math as NES), but gb2 interleaves lo/hi per row
  // instead of blocking all lo's then all hi's (see design doc's Game Boy
  // section for the bit-by-bit derivation).
  const row = [0, 1, 2, 3, 0, 1, 2, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { c } = buildC99({
    projectName: 'demo', target: 'gb2',
    palette: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]],
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  const expected = Array.from({ length: 8 }, () => ['0x55', '0x33']).flat().join(',');
  assert.match(c, new RegExp(`demo_tile0\\[16\\] = \\{${expected}\\}`));
});

test('buildC99 c64mc: 1 byte/row, 4 double-wide pixel-pairs sampled from even columns', () => {
  // row = [0,0,1,1,2,2,3,3] -> paired columns already agree (no loss), even
  // columns give indices 0,1,2,3 -> byte = 0<<6|1<<4|2<<2|3 = 0x1b
  const row = [0, 0, 1, 1, 2, 2, 3, 3];
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { c } = buildC99({
    projectName: 'demo', target: 'c64mc',
    palette: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]],
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  assert.match(c, new RegExp(`demo_tile0\\[8\\] = \\{${Array(8).fill('0x1b').join(',')}\\}`));
});

test('buildC99 c64mc: odd column is dropped when a pair disagrees (only the even column\'s index is sampled)', () => {
  const row = [3, 0, 0, 0, 0, 0, 0, 0]; // pair0 = (idx0=3, idx1=0) -> even col wins, byte = 3<<6 = 0xc0
  const indices = new Uint8Array(64);
  for (let y = 0; y < 8; y++) indices.set(row, y * 8);
  const { c } = buildC99({
    projectName: 'demo', target: 'c64mc',
    palette: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]],
    items: [{ name: 'tile0', w: 8, h: 8, indices }],
  });
  assert.match(c, new RegExp(`demo_tile0\\[8\\] = \\{${Array(8).fill('0xc0').join(',')}\\}`));
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
