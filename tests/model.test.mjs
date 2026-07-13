import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, flattenSheet,
  serializeProject, deserializeProject, validateProjectJson, tileCount, tileRect,
} from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

function proj() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 'sheet1', width: 32, height: 16, kind: 'sprite' });
  return { p, s };
}

test('createSheet defaults: one layer, bounds enforced', () => {
  const { p, s } = proj();
  assert.equal(s.layers.length, 1);
  assert.equal(s.layers[0].bitmap.width, 32);
  assert.throws(() => createSheet(p, { name: 'x', width: 0, height: 5, kind: 'sprite' }));
  assert.throws(() => createSheet(p, { name: 'x', width: 5000, height: 5, kind: 'sprite' }));
});

test('layer ops: add, move, mergeDown composites with opacity', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  top.opacity = 0.5;
  setPixel(s.layers[0].bitmap, 0, 0, [0, 0, 0, 255]);
  setPixel(top.bitmap, 0, 0, [255, 255, 255, 255]);
  mergeDown(s, top.id);
  assert.equal(s.layers.length, 1);
  const px = getPixel(s.layers[0].bitmap, 0, 0);
  assert.ok(px[0] > 100 && px[0] < 155, `blended, got ${px}`);
  assert.throws(() => mergeDown(s, s.layers[0].id)); // bottom layer
  const l2 = addLayer(s, 'b'); moveLayer(s, l2.id, 0);
  assert.equal(s.layers[0].id, l2.id);
  removeLayer(s, l2.id);
  assert.equal(s.layers.length, 1);
});

test('frames and animations; removeFrame cleans references', () => {
  const { s } = proj();
  const f1 = addFrame(s, { name: 'walk0', x: 0, y: 0, w: 16, h: 16 });
  const f2 = addFrame(s, { name: 'walk1', x: 16, y: 0, w: 16, h: 16 });
  const a = addAnimation(s, 'walk');
  a.frames.push({ frameId: f1.id, duration: 100 }, { frameId: f2.id, duration: 150 });
  removeFrame(s, f1.id);
  assert.equal(s.frames.length, 1);
  assert.deepEqual(a.frames.map(x => x.frameId), [f2.id]);
});

test('flattenSheet composites visible layers only', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  setPixel(s.layers[0].bitmap, 1, 1, [255, 0, 0, 255]);
  setPixel(top.bitmap, 1, 1, [0, 255, 0, 255]);
  top.visible = false;
  assert.deepEqual(getPixel(flattenSheet(s), 1, 1), [255, 0, 0, 255]);
  top.visible = true;
  assert.deepEqual(getPixel(flattenSheet(s), 1, 1), [0, 255, 0, 255]);
});

test('tile helpers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'tiles', width: 64, height: 32, kind: 'tile' });
  s.tile.tileWidth = 16; s.tile.tileHeight = 16;
  assert.equal(tileCount(s), 8);
  assert.deepEqual(tileRect(s, 5), { x: 16, y: 16, w: 16, h: 16 });
});

test('serialize/deserialize round-trip preserves pixels and structure', () => {
  const { p, s } = proj();
  setPixel(s.layers[0].bitmap, 3, 2, [1, 2, 3, 255]);
  addFrame(s, { name: 'f', x: 0, y: 0, w: 8, h: 8 });
  const { json, images } = serializeProject(p);
  assert.equal(json.version, PROJECT_VERSION);
  assert.equal(images.length, 1);
  assert.match(images[0].path, /^images\/.+\/.+\.png$/);
  assert.equal(json.sheets[0].layers[0].image, images[0].path);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(getPixel(p2.sheets[0].layers[0].bitmap, 3, 2), [1, 2, 3, 255]);
  assert.equal(p2.sheets[0].frames.length, 1);
});

test('validateProjectJson rejects bad input', () => {
  assert.equal(validateProjectJson({ version: 99 }).ok, false);
  assert.equal(validateProjectJson(null).ok, false);
  const { p } = proj();
  assert.equal(validateProjectJson(serializeProject(p).json).ok, true);
});

test('project carries required settings; version 2', () => {
  const p = createProject('s');
  assert.equal(p.version, 2);
  assert.deepEqual(p.settings, DEFAULT_SETTINGS);
  const p2 = createProject('s2', { ...DEFAULT_SETTINGS, tileW: 8 });
  assert.equal(p2.settings.tileW, 8);
});

test('createSheet tile kind honors tileW/tileH', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'x', width: 64, height: 64, kind: 'tile', tileW: 8, tileH: 8 });
  assert.equal(s.tile.tileWidth, 8);
});

test('animations carry strip flag; serialize round-trips settings and strip', () => {
  const p = createProject('a');
  const s = createSheet(p, { name: 'sh', width: 32, height: 32, kind: 'sprite' });
  const an = addAnimation(s, 'walk', true);
  assert.equal(an.strip, true);
  const { json, images } = serializeProject(p);
  assert.equal(json.version, 2);
  assert.deepEqual(json.settings, DEFAULT_SETTINGS);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(p2.settings, DEFAULT_SETTINGS);
  assert.equal(p2.sheets[0].animations[0].strip, true);
});

test('validateProjectJson rejects version 1 and missing/invalid settings', () => {
  assert.equal(validateProjectJson({ version: 1, sheets: [], settings: DEFAULT_SETTINGS }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [] }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [], settings: { tileW: 16 } }).ok, false);
});
