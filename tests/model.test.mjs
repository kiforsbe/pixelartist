import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, flattenSheet, flattenSheetLayers,
  serializeProject, deserializeProject, validateProjectJson, tileCount, tileRect,
  sheetLayers, findGroup, contextLayers, addGroup, flattenLayers,
} from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

function proj() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 'sheet1', width: 32, height: 16, kind: 'sprite' });
  return { p, s };
}

test('createSheet defaults: one layer, bounds enforced', () => {
  const { p, s } = proj();
  assert.equal(sheetLayers(s).length, 1);
  assert.equal(sheetLayers(s)[0].bitmap.width, 32);
  assert.throws(() => createSheet(p, { name: 'x', width: 0, height: 5, kind: 'sprite' }));
  assert.throws(() => createSheet(p, { name: 'x', width: 5000, height: 5, kind: 'sprite' }));
});

test('layer ops: add, move, mergeDown composites with opacity', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  top.opacity = 0.5;
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [0, 0, 0, 255]);
  setPixel(top.bitmap, 0, 0, [255, 255, 255, 255]);
  mergeDown(s, top.id);
  assert.equal(sheetLayers(s).length, 1);
  const px = getPixel(sheetLayers(s)[0].bitmap, 0, 0);
  assert.ok(px[0] > 100 && px[0] < 155, `blended, got ${px}`);
  assert.throws(() => mergeDown(s, sheetLayers(s)[0].id)); // bottom layer
  const l2 = addLayer(s, 'b'); moveLayer(s, l2.id, 0);
  assert.equal(sheetLayers(s)[0].id, l2.id);
  removeLayer(s, l2.id);
  assert.equal(sheetLayers(s).length, 1);
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
  setPixel(sheetLayers(s)[0].bitmap, 1, 1, [255, 0, 0, 255]);
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
  setPixel(sheetLayers(s)[0].bitmap, 3, 2, [1, 2, 3, 255]);
  addFrame(s, { name: 'f', x: 0, y: 0, w: 8, h: 8 });
  const { json, images } = serializeProject(p);
  assert.equal(json.version, PROJECT_VERSION);
  assert.equal(images.length, 1);
  assert.match(images[0].path, /^images\/.+\/.+\.png$/);
  assert.equal(json.sheets[0].layerTree.children[0].image, images[0].path);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(getPixel(sheetLayers(p2.sheets[0])[0].bitmap, 3, 2), [1, 2, 3, 255]);
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

test('addAnimation initializes breaks; serialize/deserialize round-trips them', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 32, height: 32, kind: 'sprite' });
  const a = addAnimation(s, 'walk', true);
  assert.deepEqual(a.breaks, []);
  const f1 = addFrame(s, { name: 'f1', x: 0, y: 0, w: 8, h: 8 });
  const f2 = addFrame(s, { name: 'f2', x: 8, y: 0, w: 8, h: 8 });
  a.frames = [{ frameId: f1.id, duration: 100 }, { frameId: f2.id, duration: 100 }];
  a.breaks = [1];
  const { json, images } = serializeProject(p);
  assert.deepEqual(json.sheets[0].animations[0].breaks, [1]);
  const imagesByPath = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(json, imagesByPath);
  assert.deepEqual(p2.sheets[0].animations[0].breaks, [1]);
});

test('deserializeProject defaults missing breaks to []', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 32, height: 32, kind: 'sprite' });
  addAnimation(s, 'walk', true);
  const { json, images } = serializeProject(p);
  delete json.sheets[0].animations[0].breaks; // legacy file
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual(p2.sheets[0].animations[0].breaks, []);
});

test('removeFrame adjusts breaks (shift down, drop degenerate)', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 64, height: 32, kind: 'sprite' });
  const fs = [0, 1, 2, 3].map(i => addFrame(s, { name: `f${i}`, x: i * 8, y: 0, w: 8, h: 8 }));
  const a = addAnimation(s, 'walk', true);
  a.frames = fs.map(f => ({ frameId: f.id, duration: 100 }));
  a.breaks = [2];
  removeFrame(s, fs[0].id);          // segments [0,1][2,3] → remove f0 → [1][2,3]
  assert.deepEqual(a.breaks, [1]);
  removeFrame(s, fs[1].id);          // [1][2,3] → remove f1 → break shifts to 0, normalize drops it
  assert.deepEqual(a.frames.map(e => e.frameId), [fs[2].id, fs[3].id]);
  assert.deepEqual(a.breaks, []);    // one segment [2,3]
});

test('addAnimation creates a group with a copy of current layers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [1, 2, 3, 255]);
  const a = addAnimation(s, 'walk');
  assert.ok(a.layerGroupId, 'animation has layerGroupId');
  const g = findGroup(s.layerTree, a.layerGroupId);
  assert.ok(g, 'group exists');
  assert.equal(g.animationId, a.id);
  assert.equal(flattenLayers(g).length, 1);
  assert.deepEqual(getPixel(flattenLayers(g)[0].bitmap, 0, 0), [1, 2, 3, 255]);
  // mutation on animation layer does not bleed back to sheet layer
  setPixel(flattenLayers(g)[0].bitmap, 0, 0, [9, 9, 9, 255]);
  assert.deepEqual(getPixel(sheetLayers(s)[0].bitmap, 0, 0), [1, 2, 3, 255]);
});

test('contextLayers scopes to animation group or returns all layers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  addLayer(s, 'global');
  const beforeAnim = sheetLayers(s).map(l => l.id);
  const a = addAnimation(s, 'walk');
  // all sheet layers include both root layers plus the two copied into the anim group
  assert.equal(contextLayers(s).length, 4);
  // scoped to the animation, only its private layers are returned
  assert.equal(contextLayers(s, a.id).length, 2);
  const animLayerIds = new Set(contextLayers(s, a.id).map(l => l.id));
  // animation layers are independent copies with new ids, not the originals
  for (const id of animLayerIds) assert.ok(!beforeAnim.includes(id));
});

test('flattenSheetLayers respects context and visibility', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  addLayer(s, 'global');
  const a = addAnimation(s, 'walk');
  const animLayers = contextLayers(s, a.id);
  animLayers[0].visible = false;
  setPixel(animLayers[1].bitmap, 1, 1, [255, 0, 0, 255]);
  const flat = flattenSheetLayers(animLayers, s.width, s.height);
  assert.deepEqual(getPixel(flat, 1, 1), [255, 0, 0, 255]);
});
