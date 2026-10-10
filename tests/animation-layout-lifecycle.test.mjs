import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import {
  newAutoAnimation, addAutoFrame, resizeAutoCanvas, autoLayoutAnimation, makeManual, reorderAnimations,
  duplicateAnimation, deleteAutoAnimation, setAnimationPivot, deleteLaidOutFrame, SIZE_NEEDED,
} from '../js/modes/sprites/application/commands/animation-layout-commands.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function setup({ width = 64, height = 64, maxWidth = 64 } = {}) {
  const project = createProject('t');
  project.settings.sheetMaxWidth = maxWidth;
  const sheet = createSheet(project, { name: 'S', width, height, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
  return {
    project, sheet, services,
    bitmap: () => sheetLayers(sheet)[0].bitmap,
    selection: () => services.selections.get({ kind: 'sprite-sheet', id: sheet.id }) ?? {},
  };
}
function runWith(ctx, count, { name = 'run', w = 16, h = 16 } = {}) {
  newAutoAnimation(ctx.services, ctx.sheet.id, { name, w, h });
  const anim = ctx.sheet.animations.at(-1);
  for (let i = 1; i < count; i++) addAutoFrame(ctx.services, ctx.sheet.id, anim.id, i);
  return anim;
}
const entryFrame = (ctx, anim, i) => ctx.sheet.frames.find(f => f.id === anim.frames[i].frameId);
function manualAnim(sheet, id, frameIds) {
  const a = { id, name: id, loop: true, baseDuration: 100, layout: 'manual', cell: null, frames: frameIds.map(frameId => ({ frameId, duration: null, step: null })) };
  sheet.animations.push(a);
  return a;
}
const fr = (id, x, y, w = 16, h = 16, pivotX = 0, pivotY = 0) => ({ id, name: id, x, y, w, h, pivotX, pivotY });

test('resizeCanvas re-frames every frame around the anchor and shifts the pivot; undo restores', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 0, 0, RED);
  setPixel(ctx.bitmap(), 31, 15, BLUE);
  assert.equal(resizeAutoCanvas(ctx.services, ctx.sheet.id, anim.id, 20, 16, 'c').ok, true);
  assert.deepEqual(anim.cell, { w: 20, h: 16 });
  assert.deepEqual([f0.x, f0.w, f1.x, f1.w, f0.pivotX], [0, 20, 20, 20, 2]);
  assert.deepEqual(getPixel(ctx.bitmap(), 2, 0), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 37, 15), BLUE);
  ctx.services.history.undo();
  assert.deepEqual(anim.cell, { w: 16, h: 16 });
  assert.deepEqual([f0.w, f1.x, f0.pivotX], [16, 16, 0]);
  assert.deepEqual([getPixel(ctx.bitmap(), 0, 0), getPixel(ctx.bitmap(), 31, 15)], [RED, BLUE]);
});

test('resizeCanvas smaller crops around the anchor', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  setPixel(ctx.bitmap(), 1, 1, RED);
  setPixel(ctx.bitmap(), 10, 10, BLUE);
  resizeAutoCanvas(ctx.services, ctx.sheet.id, anim.id, 8, 8, 'nw');
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 10, 10)], [RED, NONE]);
  assert.deepEqual(anim.cell, { w: 8, h: 8 });
});

test('autoLayout lays out a manual animation of equal frames, carrying their pixels', () => {
  const ctx = setup();
  ctx.sheet.frames.push(fr('m0', 40, 40), fr('m1', 0, 40));
  manualAnim(ctx.sheet, 'walk', ['m0', 'm1']);
  setPixel(ctx.bitmap(), 41, 41, RED);
  setPixel(ctx.bitmap(), 1, 41, BLUE);
  assert.equal(autoLayoutAnimation(ctx.services, ctx.sheet.id, 'walk').ok, true);
  const anim = ctx.sheet.animations[0];
  assert.deepEqual([anim.layout, anim.cell], ['auto', { w: 16, h: 16 }]);
  assert.deepEqual(ctx.sheet.frames.map(f => [f.id, f.x, f.y]), [['m0', 0, 0], ['m1', 16, 0]]);
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 17, 1)], [RED, BLUE]);
  ctx.services.history.undo();
  assert.deepEqual([anim.layout, anim.cell, ctx.sheet.frames[0].x], ['manual', null, 40]);
});

test('autoLayout asks for a size when frames differ, then aligns them on their pivots', () => {
  const ctx = setup();
  ctx.sheet.frames.push(fr('a', 0, 32, 16, 16, 8, 16), fr('b', 32, 32, 8, 8, 4, 8));
  manualAnim(ctx.sheet, 'walk', ['a', 'b']);
  const asked = autoLayoutAnimation(ctx.services, ctx.sheet.id, 'walk');
  assert.deepEqual(asked, { ok: false, reason: SIZE_NEEDED, needsSize: true, suggested: { w: 16, h: 16 } });
  assert.equal(ctx.sheet.animations[0].layout, 'manual');
  setPixel(ctx.bitmap(), 36, 39, RED); // b's local (4, 7), just above its pivot
  assert.equal(autoLayoutAnimation(ctx.services, ctx.sheet.id, 'walk', { w: 16, h: 16 }).ok, true);
  const b = ctx.sheet.frames.find(f => f.id === 'b');
  assert.deepEqual([b.x, b.y, b.w, b.h, b.pivotX, b.pivotY], [16, 0, 16, 16, 8, 16]);
  assert.deepEqual(getPixel(ctx.bitmap(), 24, 15), RED);
});

test('autoLayout refuses a frame another auto animation already lays out', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  manualAnim(ctx.sheet, 'other', [run.frames[0].frameId]);
  const r = autoLayoutAnimation(ctx.services, ctx.sheet.id, 'other');
  assert.equal(r.ok, false);
  assert.match(r.reason, /already laid out by "run"/);
});

test('makeManual releases an animation without touching pixels or rects; undo re-pins it', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const f1 = entryFrame(ctx, anim, 1);
  assert.equal(makeManual(ctx.services, ctx.sheet.id, anim.id).ok, true);
  assert.deepEqual([anim.layout, anim.cell, f1.x], ['manual', null, 16]);
  ctx.services.history.undo();
  assert.deepEqual([anim.layout, anim.cell], ['auto', { w: 16, h: 16 }]);
});

test('reorderAnimations swaps band order and moves pixels with it', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  const idle = runWith(ctx, 1, { name: 'idle', w: 8, h: 8 });
  const idleFrame = entryFrame(ctx, idle, 0);
  assert.deepEqual([idleFrame.x, idleFrame.y], [0, 16]);
  setPixel(ctx.bitmap(), 1, 17, BLUE);
  assert.equal(reorderAnimations(ctx.services, ctx.sheet.id, 1, 0).ok, true);
  assert.deepEqual(ctx.sheet.animations, [idle, run]);
  assert.deepEqual([idleFrame.y, entryFrame(ctx, run, 0).y], [0, 8]);
  assert.deepEqual(getPixel(ctx.bitmap(), 1, 1), BLUE);
});

test('duplicate copies an auto animation with its pixels right after the source', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  anim.frames[1].duration = 250;
  setPixel(ctx.bitmap(), 1, 1, RED);
  const r = duplicateAnimation(ctx.services, ctx.sheet.id, anim.id);
  const copy = ctx.sheet.animations[1];
  assert.deepEqual([r.ok, r.animationId, copy.name, copy.layout, copy.frames.length], [true, copy.id, 'run copy', 'auto', 2]);
  assert.equal(copy.frames[1].duration, 250);
  const c0 = entryFrame(ctx, copy, 0);
  assert.notEqual(c0.id, anim.frames[0].frameId);
  assert.equal(c0.y, 16);
  assert.deepEqual(getPixel(ctx.bitmap(), c0.x + 1, c0.y + 1), RED);
  assert.equal(ctx.selection().animationId, copy.id);
});

test('duplicate refuses a manual animation', () => {
  const ctx = setup();
  ctx.sheet.frames.push(fr('m', 0, 0));
  manualAnim(ctx.sheet, 'walk', ['m']);
  assert.equal(duplicateAnimation(ctx.services, ctx.sheet.id, 'walk').ok, false);
});

test('deleting an auto animation removes and clears its own frames and closes the gap; undo restores', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  const idle = runWith(ctx, 1, { name: 'idle' });
  const runFrame = entryFrame(ctx, run, 0), idleFrame = entryFrame(ctx, idle, 0);
  setPixel(ctx.bitmap(), 1, 1, RED);
  setPixel(ctx.bitmap(), 1, 17, BLUE);
  assert.equal(deleteAutoAnimation(ctx.services, ctx.sheet.id, run.id).ok, true);
  assert.deepEqual([ctx.sheet.animations, ctx.sheet.frames.includes(runFrame), idleFrame.y], [[idle], false, 0]);
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 1, 17)], [BLUE, NONE]);
  ctx.services.history.undo();
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 1, 17)], [RED, BLUE]);
});

test('deleting an auto animation keeps frames a map still places', () => {
  const ctx = setup();
  const run = runWith(ctx, 1);
  const runFrame = entryFrame(ctx, run, 0);
  ctx.project.maps.push({ id: 'm', name: 'M', layers: [{
    id: 'ml', name: 'L', type: 'sprite', visible: true, locked: false, opacity: 1,
    sprites: [{ id: 'p', sheetId: ctx.sheet.id, assetId: runFrame.id, kind: 'frame', x: 0, y: 0 }],
  }] });
  deleteAutoAnimation(ctx.services, ctx.sheet.id, run.id);
  assert.ok(ctx.sheet.frames.includes(runFrame));
});

test('setPivot sets the shared pivot on every frame and undoes', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  setAnimationPivot(ctx.services, ctx.sheet.id, anim.id, 8, 15);
  assert.deepEqual(ctx.sheet.frames.map(f => [f.pivotX, f.pivotY]), [[8, 15], [8, 15]]);
  ctx.services.history.undo();
  assert.deepEqual(ctx.sheet.frames.map(f => [f.pivotX, f.pivotY]), [[0, 0], [0, 0]]);
});

test('deleteLaidOutFrame removes a frame from every animation and relays out', () => {
  const ctx = setup();
  const anim = runWith(ctx, 3);
  const [, f1, f2] = [0, 1, 2].map(i => entryFrame(ctx, anim, i));
  manualAnim(ctx.sheet, 'loose', [f1.id]);
  assert.equal(deleteLaidOutFrame(ctx.services, ctx.sheet.id, f1.id).ok, true);
  assert.equal(ctx.sheet.frames.includes(f1), false);
  assert.deepEqual([anim.frames.length, ctx.sheet.animations[1].frames.length, f2.x], [2, 0, 16]);
});

test('undo restores only the selection keys the command changed', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const doc = { kind: 'sprite-sheet', id: ctx.sheet.id };
  ctx.services.selections.set({ animationId: anim.id, layerId: 'L1' }, doc);
  duplicateAnimation(ctx.services, ctx.sheet.id, anim.id);
  ctx.services.selections.patch({ layerId: 'L2' }, doc); // a later, non-history change
  ctx.services.history.undo();
  assert.deepEqual([ctx.selection().animationId, ctx.selection().layerId], [anim.id, 'L2']);
});

test('duplicate refuses a source whose pixels sit on a locked layer', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const layer = sheetLayers(ctx.sheet)[0];
  setPixel(layer.bitmap, 1, 1, RED);
  layer.locked = true;
  const r = duplicateAnimation(ctx.services, ctx.sheet.id, anim.id);
  assert.equal(r.ok, false);
  assert.match(r.reason, /locked/);
  assert.equal(ctx.sheet.animations.length, 1);
  assert.equal(ctx.services.history.canUndo(), true, 'only the setup commands are on the stack');
  ctx.services.history.undo();
  assert.equal(ctx.sheet.animations.length, 0);
});
