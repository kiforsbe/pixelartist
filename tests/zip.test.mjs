import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipWrite, zipRead } from '../js/core/zip.js';

const enc = new TextEncoder(), dec = new TextDecoder();

test('round-trip multiple entries', async () => {
  const entries = [
    { path: 'project.json', data: enc.encode('{"version":1}') },
    { path: 'images/a/b.png', data: new Uint8Array([1, 2, 3, 250, 251]) },
    { path: 'empty.txt', data: new Uint8Array(0) },
  ];
  const zipped = await zipWrite(entries);
  assert.equal(zipped[0], 0x50); assert.equal(zipped[1], 0x4b); // "PK"
  const out = await zipRead(zipped);
  assert.equal(out.length, 3);
  const byPath = new Map(out.map(e => [e.path, e.data]));
  assert.equal(dec.decode(byPath.get('project.json')), '{"version":1}');
  assert.deepEqual([...byPath.get('images/a/b.png')], [1, 2, 3, 250, 251]);
  assert.equal(byPath.get('empty.txt').length, 0);
});

test('compresses repetitive data', async () => {
  const big = new Uint8Array(100000); // zeros compress well
  const zipped = await zipWrite([{ path: 'big.bin', data: big }]);
  assert.ok(zipped.length < 5000, `expected small zip, got ${zipped.length}`);
  const out = await zipRead(zipped);
  assert.equal(out[0].data.length, 100000);
});

test('rejects garbage', async () => {
  await assert.rejects(() => zipRead(new Uint8Array([1, 2, 3, 4])));
});

// --- integrity -------------------------------------------------------------
//
// zipWrite emits no archive comment, so the end record is the last 22 bytes
// and the first central-directory entry sits at its recorded offset. These
// helpers patch fields in place to simulate a damaged or hostile file.
function centralOffset(zipped) {
  const v = new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength);
  return v.getUint32(zipped.length - 22 + 16, true);
}
function setU32(zipped, at, value) {
  new DataView(zipped.buffer, zipped.byteOffset, zipped.byteLength).setUint32(at, value, true);
}
async function oneEntryZip(data = enc.encode('hello hello hello hello')) {
  return zipWrite([{ path: 'a.txt', data }]);
}

test('rejects an entry whose CRC does not match its data', async () => {
  const zipped = await oneEntryZip();
  const cd = centralOffset(zipped);
  setU32(zipped, cd + 16, 0xdeadbeef);
  await assert.rejects(() => zipRead(zipped), /CRC/);
});

test('rejects an entry whose data inflates to a different size than declared', async () => {
  const zipped = await oneEntryZip();
  const cd = centralOffset(zipped);
  setU32(zipped, cd + 24, 3);
  await assert.rejects(() => zipRead(zipped), /size/);
});

test('rejects a truncated archive instead of reading short data', async () => {
  const zipped = await oneEntryZip();
  const cd = centralOffset(zipped);
  // Claim the compressed data runs past the end of the file.
  setU32(zipped, cd + 20, zipped.length * 2);
  await assert.rejects(() => zipRead(zipped), /truncated/);
});

test('rejects an entry declaring an implausibly large size before inflating it', async () => {
  const zipped = await oneEntryZip();
  const cd = centralOffset(zipped);
  setU32(zipped, cd + 24, 0xffffffff);
  await assert.rejects(() => zipRead(zipped), /too large/);
});

test('stops inflating a bomb once it exceeds its declared size', async () => {
  // 4 MB of zeros deflates to a few KB; declare it as 1 KB.
  const zipped = await oneEntryZip(new Uint8Array(4 * 1024 * 1024));
  const cd = centralOffset(zipped);
  setU32(zipped, cd + 24, 1024);
  await assert.rejects(() => zipRead(zipped), /size/);
});
