// tests/unify-sprite-size.test.mjs
// The load migration to one sprite size per sprite sheet
// (docs/superpowers/specs/2026-10-10-sprite-size-per-sheet-design.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { buildEntries, loadEntries } from '../js/core/bundle.js';
import { unifySpriteSizes } from '../js/domain/sprites/unify-sprite-size.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

function sheetOf(width = 64, height = 32) {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width, height, kind: 'sprite' });
  return { project, sheet, bitmap: () => sheetLayers(sheet)[0].bitmap };
}
const at = (ctx, f, x, y) => getPixel(ctx.bitmap(), f.x + x, f.y + y);
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('a sheet whose frames share one size adopts it and nothing moves', () => {
  const ctx = sheetOf();
  const a = addFrame(ctx.sheet, { name: 'a', x: 0, y: 0, w: 8, h: 8 });
  addFrame(ctx.sheet, { name: 'b', x: 8, y: 0, w: 8, h: 8 });
  setPixel(ctx.bitmap(), 1, 1, RED);
  const before = ctx.bitmap().data.slice();
  unifySpriteSizes(ctx.project);
  assert.deepEqual(ctx.sheet.spriteSize, { w: 8, h: 8 });
  assert.deepEqual([a.x, a.y], [0, 0]);
  assert.deepEqual(ctx.bitmap().data, before);
});

test('a sheet without frames keeps its sprite size', () => {
  const ctx = sheetOf();
  ctx.sheet.spriteSize = { w: 20, h: 30 };
  unifySpriteSizes(ctx.project);
  assert.deepEqual(ctx.sheet.spriteSize, { w: 20, h: 30 });
});

test('mixed frames are re-framed to the smallest pivot-aligned size, with nothing cropped', () => {
  const ctx = sheetOf();
  const small = addFrame(ctx.sheet, { name: 'small', x: 0, y: 0, w: 8, h: 8, pivotX: 4, pivotY: 8 });
  const big = addFrame(ctx.sheet, { name: 'big', x: 8, y: 0, w: 16, h: 12, pivotX: 8, pivotY: 12 });
  setPixel(ctx.bitmap(), 0, 0, RED); // small's top-left corner
  setPixel(ctx.bitmap(), 8 + 15, 11, BLUE); // big's bottom-right corner
  unifySpriteSizes(ctx.project);
  // pivot P = (8, 12); W = max(8 - 4 + 8, 8 - 8 + 16) = 16, H = max(12 - 8 + 8, 12) = 12
  assert.deepEqual(ctx.sheet.spriteSize, { w: 16, h: 12 });
  for (const f of [small, big]) assert.deepEqual([f.w, f.h, f.pivotX, f.pivotY], [16, 12, 8, 12]);
  assert.deepEqual(at(ctx, small, 4, 4), RED, 'small moved by its pivot offset (4, 4)');
  assert.deepEqual(at(ctx, big, 15, 11), BLUE);
  assert.equal(overlaps(small, big), false);
});

test('manual animations become auto when they can; loose frames are re-framed and packed too', () => {
  const ctx = sheetOf();
  const a = addFrame(ctx.sheet, { name: 'a', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(ctx.sheet, { name: 'b', x: 8, y: 0, w: 16, h: 16 });
  const loose = addFrame(ctx.sheet, { name: 'loose', x: 40, y: 0, w: 4, h: 4 });
  const walk = addAnimation(ctx.sheet, 'walk');
  walk.frames = [a, b].map(f => ({ frameId: f.id, duration: null, step: null }));
  const echo = addAnimation(ctx.sheet, 'echo');
  echo.frames = [{ frameId: a.id, duration: null, step: null }];
  setPixel(ctx.bitmap(), 41, 1, RED);
  unifySpriteSizes(ctx.project);
  assert.deepEqual([walk.layout, walk.cell], ['auto', { w: 16, h: 16 }]);
  assert.equal(echo.layout, 'manual', 'its frame is laid out by walk already');
  assert.deepEqual([loose.w, loose.h], [16, 16]);
  assert.deepEqual(at(ctx, loose, 1, 1), RED);
  const all = ctx.sheet.frames;
  for (const f of all) for (const g of all) if (f !== g) assert.equal(overlaps(f, g), false, `${f.name} / ${g.name}`);
});

test('locked layers are re-framed too and stay locked', () => {
  const ctx = sheetOf();
  const a = addFrame(ctx.sheet, { name: 'a', x: 0, y: 0, w: 8, h: 8 });
  addFrame(ctx.sheet, { name: 'b', x: 8, y: 0, w: 4, h: 4 });
  setPixel(ctx.bitmap(), 2, 2, RED);
  sheetLayers(ctx.sheet)[0].locked = true;
  unifySpriteSizes(ctx.project);
  assert.equal(sheetLayers(ctx.sheet)[0].locked, true);
  assert.deepEqual(ctx.sheet.spriteSize, { w: 8, h: 8 });
  assert.deepEqual(at(ctx, a, 2, 2), RED);
});

test('loading a saved project unifies its sprite sheets', async () => {
  const ctx = sheetOf();
  addFrame(ctx.sheet, { name: 'a', x: 0, y: 0, w: 8, h: 8 });
  addFrame(ctx.sheet, { name: 'b', x: 8, y: 0, w: 12, h: 6 });
  const enc = new TextEncoder(), dec = new TextDecoder();
  const entries = await buildEntries(ctx.project, async bmp => enc.encode(JSON.stringify({ width: bmp.width, height: bmp.height, data: [...bmp.data] })));
  const loaded = await loadEntries(entries, async bytes => {
    const o = JSON.parse(dec.decode(bytes));
    return { width: o.width, height: o.height, data: new Uint8ClampedArray(o.data) };
  });
  const sheet = loaded.sheets[0];
  assert.deepEqual(sheet.spriteSize, { w: 12, h: 8 });
  assert.ok(sheet.frames.every(f => f.w === 12 && f.h === 8));
});
