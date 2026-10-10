import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel } from '../js/core/pixels.js';
import {
  planLayout, distinctFrameIds, autoAnimationOf, isPinnedFrame, NO_ROOM,
} from '../js/domain/sprites/auto-layout.js';

const RED = [255, 0, 0, 255];

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
function anim(sheet, id, frameIds, { layout = 'auto', cell = { w: 16, h: 16 } } = {}) {
  const a = {
    id, name: id, loop: true, baseDuration: 100, layout, cell: layout === 'auto' ? cell : null,
    frames: frameIds.map(frameId => ({ frameId, duration: null, step: null })),
  };
  sheet.animations.push(a);
  return a;
}
const opts = (maxWidth = 64, maxHeight = 4096) => ({ maxWidth, maxHeight });

test('distinctFrameIds keeps the order of first appearance', () => {
  assert.deepEqual(distinctFrameIds({ frames: [{ frameId: 'b' }, { frameId: 'a' }, { frameId: 'b' }] }), ['b', 'a']);
});

test('autoAnimationOf and isPinnedFrame only see auto animations', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 0, 0); frame(sheet, 'm', 16, 0);
  const run = anim(sheet, 'run', ['a']);
  anim(sheet, 'loose', ['m'], { layout: 'manual' });
  assert.equal(autoAnimationOf(sheet, 'a'), run);
  assert.equal(autoAnimationOf(sheet, 'm'), null);
  assert.equal(isPinnedFrame(sheet, 'a'), true);
  assert.equal(isPinnedFrame(sheet, 'm'), false);
});

test('a single auto animation fills a band from the origin in timeline order', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 32, 32); frame(sheet, 'b', 0, 48);
  anim(sheet, 'run', ['b', 'a', 'b']);
  const plan = planLayout(sheet, opts());
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.rects.get('b'), { x: 0, y: 0 });
  assert.deepEqual(plan.rects.get('a'), { x: 16, y: 0 });
  assert.deepEqual(plan.size, { w: 64, h: 64 });
});

test('a band wraps at maxWidth into extra rows', () => {
  const { sheet } = sheetWith(48, 64);
  ['f0', 'f1', 'f2', 'f3', 'f4'].forEach((id, i) => frame(sheet, id, (i % 3) * 16, 32 + Math.floor(i / 3) * 16));
  anim(sheet, 'run', ['f0', 'f1', 'f2', 'f3', 'f4']);
  const plan = planLayout(sheet, opts(48));
  assert.deepEqual(['f0', 'f1', 'f2', 'f3', 'f4'].map(id => plan.rects.get(id)),
    [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 32, y: 0 }, { x: 0, y: 16 }, { x: 16, y: 16 }]);
});

test('bands stack in sheet.animations order', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 40, 40); frame(sheet, 'b', 40, 40); frame(sheet, 'c', 0, 0, 8, 8);
  anim(sheet, 'run', ['a', 'b']);
  anim(sheet, 'idle', ['c'], { cell: { w: 8, h: 8 } });
  const plan = planLayout(sheet, opts());
  assert.deepEqual(plan.rects.get('c'), { x: 0, y: 16 });
});

test('manual frames are obstacles', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'm', 0, 0);
  anim(sheet, 'loose', ['m'], { layout: 'manual' });
  frame(sheet, 'a', 40, 40);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 16 });
});

test('stray pixels outside every frame push a band below them', () => {
  const { sheet, layer } = sheetWith(64, 64);
  setPixel(layer.bitmap, 5, 3, RED);
  frame(sheet, 'a', 32, 32);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 4 });
});

test('stray pixels right of the band width do not block it', () => {
  const { sheet, layer } = sheetWith(64, 64);
  setPixel(layer.bitmap, 40, 0, RED);
  frame(sheet, 'a', 0, 32); frame(sheet, 'b', 16, 32);
  anim(sheet, 'run', ['a', 'b']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 0 });
});

test("an auto frame's own pixels are not obstacles", () => {
  const { sheet, layer } = sheetWith(64, 64);
  frame(sheet, 'a', 32, 32);
  setPixel(layer.bitmap, 33, 33, RED);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 0 });
});

test("fresh frames' rects do not hide strays; ignoreRects do", () => {
  const { sheet, layer } = sheetWith(64, 64);
  frame(sheet, 'n', 0, 0);
  setPixel(layer.bitmap, 2, 2, RED);
  anim(sheet, 'run', ['n']);
  assert.deepEqual(planLayout(sheet, { ...opts(), fresh: new Set(['n']) }).rects.get('n'), { x: 0, y: 3 });
  assert.deepEqual(planLayout(sheet, { ...opts(), fresh: new Set(['n']), ignoreRects: [{ x: 0, y: 0, w: 4, h: 4 }] }).rects.get('n'), { x: 0, y: 0 });
});

test('the sheet grows to fit but never shrinks', () => {
  const tall = sheetWith(64, 16);
  ['a', 'b', 'c', 'd', 'e'].forEach(id => frame(tall.sheet, id, 0, 0));
  anim(tall.sheet, 'run', ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(planLayout(tall.sheet, opts()).size, { w: 64, h: 32 });
  const big = sheetWith(128, 128);
  frame(big.sheet, 'a', 0, 0);
  anim(big.sheet, 'run', ['a']);
  assert.deepEqual(planLayout(big.sheet, opts()).size, { w: 128, h: 128 });
});

test('a short band does not widen a narrow sheet', () => {
  const { sheet } = sheetWith(32, 32);
  frame(sheet, 'a', 0, 0);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts(256)).size, { w: 32, h: 32 });
});

test('an auto animation with no frames reserves nothing', () => {
  const { sheet } = sheetWith(64, 64);
  anim(sheet, 'empty', []);
  frame(sheet, 'a', 40, 40);
  anim(sheet, 'run', ['a']);
  assert.deepEqual(planLayout(sheet, opts()).rects.get('a'), { x: 0, y: 0 });
});

test('refuses when a cell is wider than maxWidth or no room is left below maxHeight', () => {
  const wide = sheetWith(64, 64);
  frame(wide.sheet, 'a', 0, 0, 80, 16);
  anim(wide.sheet, 'run', ['a'], { cell: { w: 80, h: 16 } });
  assert.deepEqual(planLayout(wide.sheet, opts(64)), { ok: false, reason: NO_ROOM });
  const full = sheetWith(64, 16);
  frame(full.sheet, 'm', 0, 0);
  frame(full.sheet, 'a', 32, 0);
  anim(full.sheet, 'run', ['a']);
  assert.deepEqual(planLayout(full.sheet, opts(64, 16)), { ok: false, reason: NO_ROOM });
});

test('moves list only frames that change position, and planning is deterministic', () => {
  const { sheet } = sheetWith(64, 64);
  frame(sheet, 'a', 0, 0); frame(sheet, 'b', 40, 40);
  anim(sheet, 'run', ['a', 'b']);
  const plan = planLayout(sheet, opts());
  assert.deepEqual(plan.moves, [{ frameId: 'b', from: { x: 40, y: 40 }, to: { x: 16, y: 0 } }]);
  assert.deepEqual(planLayout(sheet, opts()), plan);
});
