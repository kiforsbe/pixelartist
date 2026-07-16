import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSheet } from '../js/core/model.js';
import { makeTransform } from '../js/core/floating.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255];

function sheetWith2Layers() {
  const l1 = { id: 'l1', visible: true, opacity: 1, bitmap: createBitmap(8, 8) };
  const l2 = { id: 'l2', visible: true, opacity: 1, bitmap: createBitmap(8, 8) };
  return { id: 'sh', width: 8, height: 8, layers: [l1, l2] };
}

function floatFor(layerId, color) {
  const buffer = createBitmap(2, 2);
  setPixel(buffer, 0, 0, color);
  return { sheetId: 'sh', srcRect: { x: 4, y: 4, w: 2, h: 2 }, cut: false,
    layers: [{ layerId, buffer }], transform: makeTransform() };
}

test('null floating: unchanged behavior', () => {
  const sheet = sheetWith2Layers();
  setPixel(sheet.layers[0].bitmap, 1, 1, RED);
  assert.deepEqual(getPixel(flattenSheet(sheet), 1, 1), RED);
  assert.deepEqual(getPixel(flattenSheet(sheet, null), 1, 1), RED);
});

test('float composites at its layer z-position (upper layer covers lower float)', () => {
  const sheet = sheetWith2Layers();
  setPixel(sheet.layers[1].bitmap, 4, 4, GREEN);   // upper layer opaque at (4,4)
  const flat = flattenSheet(sheet, floatFor('l1', RED)); // float on LOWER layer, same spot
  assert.deepEqual(getPixel(flat, 4, 4), GREEN);   // upper layer wins
});

test('float on upper layer shows over lower content', () => {
  const sheet = sheetWith2Layers();
  setPixel(sheet.layers[0].bitmap, 4, 4, GREEN);
  const flat = flattenSheet(sheet, floatFor('l2', RED));
  assert.deepEqual(getPixel(flat, 4, 4), RED);
});

test('hidden layer hides its float; other-sheet float ignored', () => {
  const sheet = sheetWith2Layers();
  sheet.layers[1].visible = false;
  assert.deepEqual(getPixel(flattenSheet(sheet, floatFor('l2', RED)), 4, 4), [0, 0, 0, 0]);
  const foreign = floatFor('l1', RED);
  foreign.sheetId = 'other';
  assert.deepEqual(getPixel(flattenSheet(sheet, foreign), 4, 4), [0, 0, 0, 0]);
});

test('layer opacity applies to float pixels too', () => {
  const sheet = sheetWith2Layers();
  sheet.layers[1].opacity = 0.5;
  const flat = flattenSheet(sheet, floatFor('l2', RED));
  const p = getPixel(flat, 4, 4);
  assert.ok(p[3] > 120 && p[3] < 136, `alpha ${p[3]} should be ~128`);
});
