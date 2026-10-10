import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, sheetLayers, createLayerNode } from '../js/core/model.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { applyLayout, undoLayout, redoLayout } from '../js/core/sheet-layout.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function sheetWith(w, h) {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: w, height: h, kind: 'sprite' });
  return { sheet, layer: sheetLayers(sheet)[0] };
}
function frame(sheet, id, x, y, w = 16, h = 16) {
  const f = { id, name: id, x, y, w, h, pivotX: 0, pivotY: 0 };
  sheet.frames.push(f);
  return f;
}
// entries: [frameId, from, to]
function plan(entries, size) {
  return {
    ok: true, size,
    rects: new Map(entries.map(([id, , to]) => [id, to])),
    moves: entries.filter(([, f, t]) => f.x !== t.x || f.y !== t.y).map(([frameId, from, to]) => ({ frameId, from, to })),
  };
}

test("swapping two frames carries each one's pixels across every layer", () => {
  const { sheet, layer } = sheetWith(32, 16);
  const top = createLayerNode('top', 32, 16);
  sheet.layerTree.children.push(top);
  frame(sheet, 'a', 0, 0); frame(sheet, 'b', 16, 0);
  setPixel(layer.bitmap, 1, 1, RED);
  setPixel(top.bitmap, 17, 2, BLUE);
  const r = applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 16, y: 0 }], ['b', { x: 16, y: 0 }, { x: 0, y: 0 }]], { w: 32, h: 16 }));
  assert.equal(r.ok, true);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), RED);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), NONE);
  assert.deepEqual(getPixel(top.bitmap, 1, 2), BLUE);
  assert.deepEqual(sheet.frames.map(f => [f.id, f.x]), [['a', 16], ['b', 0]]);
});

test('an overlapping shift never clobbers a frame before it is copied', () => {
  const { sheet, layer } = sheetWith(64, 16);
  [['a', RED], ['b', GREEN], ['c', BLUE]].forEach(([id, c], i) => { frame(sheet, id, i * 16, 0); setPixel(layer.bitmap, i * 16, 0, c); });
  applyLayout(sheet, plan(['a', 'b', 'c'].map((id, i) => [id, { x: i * 16, y: 0 }, { x: (i + 1) * 16, y: 0 }]), { w: 64, h: 16 }));
  assert.deepEqual([0, 16, 32, 48].map(x => getPixel(layer.bitmap, x, 0)), [NONE, RED, GREEN, BLUE]);
});

test('growth is applied, and undo/redo restore size, pixels and coords byte-exactly', () => {
  const { sheet, layer } = sheetWith(16, 16);
  frame(sheet, 'a', 0, 0);
  setPixel(layer.bitmap, 3, 3, RED);
  const beforeData = layer.bitmap.data.slice();
  const r = applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 0, y: 16 }]], { w: 16, h: 32 }));
  assert.deepEqual([sheet.height, layer.bitmap.height], [32, 32]);
  assert.deepEqual(getPixel(layer.bitmap, 3, 19), RED);
  const afterData = layer.bitmap.data.slice();
  undoLayout(sheet, r.record);
  assert.equal(sheet.height, 16);
  assert.deepEqual(layer.bitmap.data, beforeData);
  assert.equal(sheet.frames[0].y, 0);
  redoLayout(sheet, r.record);
  assert.deepEqual(layer.bitmap.data, afterData);
  assert.equal(sheet.frames[0].y, 16);
});

test('refuses, changing nothing, when a locked layer has pixels that would move', () => {
  const { sheet, layer } = sheetWith(32, 16);
  layer.locked = true; layer.name = 'Ink';
  frame(sheet, 'a', 0, 0);
  setPixel(layer.bitmap, 2, 2, RED);
  const r = applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 16, y: 0 }]], { w: 32, h: 32 }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /Ink/);
  assert.deepEqual(getPixel(layer.bitmap, 2, 2), RED);
  assert.deepEqual([sheet.frames[0].x, sheet.height], [0, 16]);
});

test('an empty locked layer is skipped and left untouched', () => {
  const { sheet, layer } = sheetWith(32, 16);
  layer.locked = true;
  const paint = createLayerNode('paint', 32, 16);
  sheet.layerTree.children.push(paint);
  frame(sheet, 'a', 0, 0);
  setPixel(paint.bitmap, 1, 1, RED);
  assert.equal(applyLayout(sheet, plan([['a', { x: 0, y: 0 }, { x: 16, y: 0 }]], { w: 32, h: 16 })).ok, true);
  assert.deepEqual(getPixel(paint.bitmap, 17, 1), RED);
  assert.ok(layer.bitmap.data.every(v => v === 0));
});

test('content replaces a frame, null content blanks it, and clears empty rects', () => {
  const { sheet, layer } = sheetWith(64, 16);
  frame(sheet, 'a', 0, 0); frame(sheet, 'n', 0, 0); frame(sheet, 'z', 0, 0);
  setPixel(layer.bitmap, 1, 1, RED);
  setPixel(layer.bitmap, 40, 1, BLUE);
  setPixel(layer.bitmap, 50, 5, BLUE);
  const stamp = createBitmap(16, 16);
  setPixel(stamp, 0, 0, GREEN);
  const r = applyLayout(sheet,
    plan([['a', { x: 0, y: 0 }, { x: 0, y: 0 }], ['n', { x: 0, y: 0 }, { x: 16, y: 0 }], ['z', { x: 0, y: 0 }, { x: 48, y: 0 }]], { w: 64, h: 16 }),
    { content: new Map([['n', new Map([[layer.id, stamp]])], ['z', null]]), clears: [{ x: 32, y: 0, w: 16, h: 16 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), RED);
  assert.deepEqual(getPixel(layer.bitmap, 16, 0), GREEN);
  assert.deepEqual(getPixel(layer.bitmap, 40, 1), NONE);
  assert.deepEqual(getPixel(layer.bitmap, 50, 5), NONE);
});
