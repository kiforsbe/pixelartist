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
