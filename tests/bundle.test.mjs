import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntries, loadEntries, packProject, unpackProject } from '../js/core/bundle.js';
import { createProject, createSheet } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const fakeEncode = async bmp =>
  enc.encode(JSON.stringify({ width: bmp.width, height: bmp.height, data: [...bmp.data] }));
const fakeDecode = async bytes => {
  const o = JSON.parse(dec.decode(bytes));
  return { width: o.width, height: o.height, data: new Uint8ClampedArray(o.data) };
};

function demoProject() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 's', width: 8, height: 8, kind: 'sprite' });
  setPixel(s.layers[0].bitmap, 1, 1, [7, 8, 9, 255]);
  return p;
}

test('buildEntries produces project.json + one png per layer', async () => {
  const entries = await buildEntries(demoProject(), fakeEncode);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'project.json');
  const json = JSON.parse(dec.decode(entries[0].data));
  assert.equal(json.version, 2);
  assert.match(entries[1].path, /^images\/.+\.png$/);
});

test('entries round-trip preserves pixels', async () => {
  const entries = await buildEntries(demoProject(), fakeEncode);
  const p2 = await loadEntries(entries, fakeDecode);
  assert.deepEqual(getPixel(p2.sheets[0].layers[0].bitmap, 1, 1), [7, 8, 9, 255]);
});

test('packed round-trip via zip', async () => {
  const bytes = await packProject(demoProject(), fakeEncode);
  const p2 = await unpackProject(bytes, fakeDecode);
  assert.equal(p2.name, 'demo');
  assert.deepEqual(getPixel(p2.sheets[0].layers[0].bitmap, 1, 1), [7, 8, 9, 255]);
});

test('loadEntries rejects bad version with clear error', async () => {
  const entries = [{ path: 'project.json', data: enc.encode('{"version": 42, "sheets": []}') }];
  await assert.rejects(() => loadEntries(entries, fakeDecode), /version/);
});

test('loadEntries rejects missing project.json', async () => {
  await assert.rejects(() => loadEntries([], fakeDecode), /project\.json/);
});
