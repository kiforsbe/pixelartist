// tests/frame-pixel-motion.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { createLayerNode, createGroupNode } from '../js/core/model.js';
import { stripLayersOf, buildMovePatches } from '../js/modes/sprites/application/frame-pixel-motion.js';

function makeSheet() {
  return {
    id: 'sheet1', width: 32, height: 16, frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
}

test('stripLayersOf returns null for a missing, non-strip, or still-floating animation', () => {
  const sheet = makeSheet();
  assert.equal(stripLayersOf(sheet, null), null);
  assert.equal(stripLayersOf(sheet, { id: 'a1', strip: false, layerGroupId: 'g1' }), null);
  assert.equal(stripLayersOf(sheet, { id: 'a1', strip: true, layerGroupId: null }), null);
});

test("stripLayersOf returns the accepted strip group's own layers", () => {
  const sheet = makeSheet();
  const group = createGroupNode('strip_0', { animationId: 'a1' });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  const anim = { id: 'a1', strip: true, layerGroupId: group.id, frames: [] };
  sheet.animations.push(anim);
  assert.deepEqual(stripLayersOf(sheet, anim), [layer]);
});

test('buildMovePatches carries pixels with the frame and reports a reversible union patch', () => {
  const layer = { id: 'ly1', bitmap: createBitmap(32, 16) };
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  const frame = { id: 'f1', x: 0, y: 0, w: 8, h: 8 };

  const { patches, ur, beforeCoords, afterCoords } = buildMovePatches([frame], 8, 0, [layer]);

  assert.deepEqual(ur, { x: 0, y: 0, w: 16, h: 8 });
  assert.deepEqual(frame, { id: 'f1', x: 8, y: 0, w: 8, h: 8 });
  assert.deepEqual(getPixel(layer.bitmap, 9, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [0, 0, 0, 0]);
  assert.deepEqual(beforeCoords, [{ frame, x: 0, y: 0 }]);
  assert.deepEqual(afterCoords, [{ frame, x: 8, y: 0 }]);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].layer, layer);
});

test('buildMovePatches copies every member before clearing any, so adjacent frames do not clobber', () => {
  const layer = { id: 'ly1', bitmap: createBitmap(32, 16) };
  setPixel(layer.bitmap, 0, 0, [1, 0, 0, 255]);
  setPixel(layer.bitmap, 8, 0, [2, 0, 0, 255]);
  const a = { id: 'a', x: 0, y: 0, w: 8, h: 8 };
  const b = { id: 'b', x: 8, y: 0, w: 8, h: 8 };

  buildMovePatches([a, b], 8, 0, [layer]);

  assert.deepEqual(getPixel(layer.bitmap, 8, 0), [1, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 16, 0), [2, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 0, 0), [0, 0, 0, 0]);
});
