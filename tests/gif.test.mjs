import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGif } from '../js/core/gif.js';

function px(r, g, b, a = 255) { return [r, g, b, a]; }

test('encodeGif: single 2x1 red/green frame, no loop, hand-verified byte layout', () => {
  const pixels = new Uint8ClampedArray([...px(255, 0, 0), ...px(0, 255, 0)]);
  const bytes = encodeGif([{ pixels, width: 2, height: 1, delayMs: 100 }], { loop: false });

  // Header + Logical Screen Descriptor
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  assert.deepEqual([...bytes.slice(6, 8)], [2, 0]); // width=2 LSB-first
  assert.deepEqual([...bytes.slice(8, 10)], [1, 0]); // height=1
  // packed byte: GCT present (0x80) | color-res(3b)=0 | sort(0) | size(3b)=0
  // -> tableSizeExp=0 (2-color GCT) since red+green = 2 distinct colors
  assert.equal(bytes[10] & 0x80, 0x80);
  assert.equal(bytes[10] & 0x07, 0); // tableSizeExp = 0 -> 2^(0+1) = 2 entries
  // Global Color Table: 2 entries x 3 bytes = 6 bytes, red then green
  // (both appear once -> frequency-tie order = first-encountered = red, green)
  const gct = bytes.slice(13, 19);
  assert.deepEqual([...gct], [255, 0, 0, 0, 255, 0]);

  // no loop -> no NETSCAPE2.0 Application Extension anywhere in the stream
  const asString = [...bytes].map(b => String.fromCharCode(b)).join('');
  assert.equal(asString.includes('NETSCAPE2.0'), false);

  // Graphic Control Extension starts right after the GCT (offset 19):
  // 0x21 0xF9 0x04 <flags> <delay LSB> <delay MSB> <transparent idx> 0x00
  const gceStart = 19;
  assert.deepEqual([...bytes.slice(gceStart, gceStart + 3)], [0x21, 0xf9, 0x04]);
  assert.equal(bytes[gceStart + 3] & 0x08, 0x08); // disposal method 2 (bit3 of the flags nibble)
  assert.deepEqual([...bytes.slice(gceStart + 4, gceStart + 6)], [10, 0]); // 100ms -> 10 centiseconds
  assert.equal(bytes[gceStart + 7], 0x00); // block terminator

  // Image Descriptor: 0x2C left(2) top(2) width(2) height(2) flags(1) = 10 bytes
  const idStart = gceStart + 8;
  assert.equal(bytes[idStart], 0x2c);
  assert.deepEqual([...bytes.slice(idStart + 1, idStart + 10)], [0, 0, 0, 0, 2, 0, 1, 0, 0]);

  // LZW: min code size byte, then hand-derived sub-block for indices [0,1]
  // at minCodeSize=2 (clear=4,eoi=5): codes emitted are clear(100b),
  // idx0(000b), idx1(001b), eoi(101b) at 3 bits each, LSB-first packed ->
  // byte0=0b01000100=0x44=68, byte1=0b00001010=0x0A=10 (derived by hand,
  // see design doc's LZW section for the bit-packing rule).
  const lzwStart = idStart + 10;
  assert.equal(bytes[lzwStart], 2); // minCodeSize
  assert.deepEqual([...bytes.slice(lzwStart + 1, lzwStart + 5)], [2, 68, 10, 0]); // sub-block: size,data,data,terminator

  // Trailer
  assert.equal(bytes.at(-1), 0x3b);
});

test('encodeGif: loop:true includes a NETSCAPE2.0 extension with loop count 0', () => {
  const pixels = new Uint8ClampedArray([...px(0, 0, 0)]);
  const bytes = encodeGif([{ pixels, width: 1, height: 1, delayMs: 50 }], { loop: true });
  const asString = [...bytes].map(b => String.fromCharCode(b)).join('');
  assert.equal(asString.includes('NETSCAPE2.0'), true);
});

test('encodeGif: throws on an empty frame list', () => {
  assert.throws(() => encodeGif([], { loop: false }));
});
