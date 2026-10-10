import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProject, createSheet, createLayerNode, sheetLayers, addAnimation, resizeSheetCanvas,
  serializeProject, deserializeProject, validateProjectJson, DEFAULT_SETTINGS, MAX_DIM,
} from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255];

function roundTrip(project) {
  const { json, images } = serializeProject(project);
  return deserializeProject(JSON.parse(JSON.stringify(json)), new Map(images.map(i => [i.path, i.bitmap])));
}

test('new layers start unlocked', () => {
  assert.equal(createLayerNode('L', 4, 4).locked, false);
});

test('sheetMaxWidth defaults to the default sprite sheet width', () => {
  assert.equal(DEFAULT_SETTINGS.sheetMaxWidth, DEFAULT_SETTINGS.spriteSheetW);
  assert.equal(MAX_DIM, 4096);
});

test('new animations are manual with no cell', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const anim = addAnimation(sheet, 'walk', project.settings);
  assert.equal(anim.layout, 'manual');
  assert.equal(anim.cell, null);
});

test('resizeSheetCanvas grows every layer and keeps pixels at their coordinates', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  sheet.layerTree.children.push(createLayerNode('top', 4, 4));
  const [bottom, top] = sheetLayers(sheet);
  setPixel(bottom.bitmap, 3, 3, RED);
  resizeSheetCanvas(sheet, 8, 6);
  assert.deepEqual([sheet.width, sheet.height], [8, 6]);
  for (const l of [bottom, top]) assert.deepEqual([l.bitmap.width, l.bitmap.height], [8, 6]);
  assert.deepEqual(getPixel(bottom.bitmap, 3, 3), RED);
  assert.deepEqual(getPixel(bottom.bitmap, 7, 5), [0, 0, 0, 0]);
});

test('resizeSheetCanvas keeps every layer bitmap object, so undo patches recorded before a growth still apply', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  const [layer] = sheetLayers(sheet);
  const held = layer.bitmap; // what a stroke's undo patch holds on to
  resizeSheetCanvas(sheet, 4, 6);
  resizeSheetCanvas(sheet, 4, 4);
  assert.equal(layer.bitmap, held);
  setPixel(held, 2, 2, RED);
  assert.deepEqual(getPixel(layer.bitmap, 2, 2), RED);
});

test('resizeSheetCanvas shrinks by cropping the right and bottom', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const [layer] = sheetLayers(sheet);
  setPixel(layer.bitmap, 1, 1, RED);
  setPixel(layer.bitmap, 6, 6, RED);
  resizeSheetCanvas(sheet, 4, 4);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), RED);
  assert.equal(layer.bitmap.data.length, 4 * 4 * 4);
});

test('resizeSheetCanvas rejects sizes outside 1..MAX_DIM', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  assert.throws(() => resizeSheetCanvas(sheet, 0, 4), /1\.\.4096/);
  assert.throws(() => resizeSheetCanvas(sheet, 4, MAX_DIM + 1), /1\.\.4096/);
});

test('locked and sheetMaxWidth survive a save/load round trip', () => {
  const project = createProject('t');
  project.settings.sheetMaxWidth = 128;
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  sheetLayers(sheet)[0].locked = true;
  const loaded = roundTrip(project);
  assert.equal(loaded.settings.sheetMaxWidth, 128);
  assert.equal(sheetLayers(loaded.sheets[0])[0].locked, true);
});

test('a file without sheetMaxWidth loads with spriteSheetW as the default', () => {
  const project = createProject('t', { ...DEFAULT_SETTINGS, spriteSheetW: 320 });
  delete project.settings.sheetMaxWidth;
  createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const { json, images } = serializeProject(project);
  delete json.settings.sheetMaxWidth;
  json.version = 3; // only pre-v4 files may omit it (Task 6 makes it required for v4)
  const loaded = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.equal(loaded.settings.sheetMaxWidth, 320);
});

test('validateProjectJson rejects an out-of-range sheetMaxWidth', () => {
  const project = createProject('t');
  createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const { json } = serializeProject(project);
  json.settings.sheetMaxWidth = 0;
  assert.match(validateProjectJson(json).error, /sheetMaxWidth/);
});

test('loading demotes auto animations that break the auto invariants to manual', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite' });
  const frame = (id, x, w = 16, pivotX = 0) => ({ id, name: id, x, y: 0, w, h: 16, pivotX, pivotY: 0 });
  sheet.frames.push(frame('a', 0), frame('b', 16), frame('c', 32, 8), frame('d', 48, 16, 4));
  const auto = (name, ids) => Object.assign(addAnimation(sheet, name), { layout: 'auto', cell: { w: 16, h: 16 }, frames: ids.map(frameId => ({ frameId, duration: null, step: null })) });
  auto('good', ['a', 'b']);
  auto('shares a frame', ['b']);
  auto('wrong size', ['c']);
  auto('missing frame', ['zz']);
  auto('mixed pivots', ['a', 'd']);
  const loaded = roundTrip(project).sheets[0];
  assert.deepEqual(loaded.animations.map(a => [a.name, a.layout]), [
    ['good', 'auto'], ['shares a frame', 'manual'], ['wrong size', 'manual'], ['missing frame', 'manual'], ['mixed pivots', 'manual'],
  ]);
  assert.equal(loaded.animations[1].cell, null);
});
