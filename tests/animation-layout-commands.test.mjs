import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { NO_ROOM } from '../js/domain/sprites/auto-layout.js';
import {
  newAutoAnimation, addAutoFrame, linkAutoFrame, deleteAutoFrame, moveAutoFrame,
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
// An auto animation "run" with `count` frames, laid out left to right.
function runWith(ctx, count, cell = { w: 16, h: 16 }) {
  ctx.sheet.spriteSize = { ...cell };
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run' });
  const anim = ctx.sheet.animations.at(-1);
  for (let i = 1; i < count; i++) addAutoFrame(ctx.services, ctx.sheet.id, anim.id, i);
  return anim;
}
const entryFrame = (ctx, anim, i) => ctx.sheet.frames.find(f => f.id === anim.frames[i].frameId);

test('new creates an auto animation with one blank frame and selects it; undo/redo keep identity', () => {
  const ctx = setup();
  ctx.sheet.spriteSize = { w: 16, h: 24 };
  const r = newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run' });
  assert.equal(r.ok, true);
  const anim = ctx.sheet.animations[0];
  const frame = ctx.sheet.frames[0];
  assert.deepEqual([anim.layout, anim.cell, anim.frames.length], ['auto', { w: 16, h: 24 }, 1]);
  assert.deepEqual([frame.x, frame.y, frame.w, frame.h], [0, 0, 16, 24]);
  assert.deepEqual([r.animationId, r.frameId], [anim.id, frame.id]);
  assert.deepEqual([ctx.selection().animationId, ctx.selection().frameId], [anim.id, frame.id]);
  ctx.services.history.undo();
  assert.deepEqual([ctx.sheet.animations.length, ctx.sheet.frames.length], [0, 0]);
  ctx.services.history.redo();
  assert.equal(ctx.sheet.animations[0], anim);
  assert.equal(ctx.sheet.frames[0], frame);
});

test('a second animation gets its own band below the first', () => {
  const ctx = setup();
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run' });
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'idle' });
  assert.deepEqual([ctx.sheet.frames[1].x, ctx.sheet.frames[1].y], [0, 16]);
});

test('addFrame inserts a blank frame and shifts later frames with their pixels; undo restores', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const first = entryFrame(ctx, anim, 0);
  setPixel(ctx.bitmap(), 2, 2, RED);
  const before = ctx.bitmap().data.slice();
  assert.equal(addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0).ok, true);
  const added = entryFrame(ctx, anim, 0);
  assert.deepEqual([added.x, first.x], [0, 16]);
  assert.deepEqual(getPixel(ctx.bitmap(), 18, 2), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 2, 2), NONE);
  assert.equal(ctx.selection().frameId, added.id);
  ctx.services.history.undo();
  assert.deepEqual(ctx.bitmap().data, before);
  assert.deepEqual([ctx.sheet.frames.length, first.x, anim.frames.length], [1, 0, 1]);
});

test('addFrame with copyOf copies the source pixels; copyOf must be a frame of the animation', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const first = entryFrame(ctx, anim, 0);
  setPixel(ctx.bitmap(), 2, 2, RED);
  addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, { copyOf: first.id });
  const copy = entryFrame(ctx, anim, 1);
  assert.notEqual(copy, first);
  assert.deepEqual(getPixel(ctx.bitmap(), copy.x + 2, copy.y + 2), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 2, 2), RED);
  assert.equal(addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, { copyOf: 'nope' }).ok, false);
});

test('linkFrame inserts another use of a frame, and the sheet follows first appearance', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 17, 1, BLUE);
  assert.equal(linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, f1.id).ok, true);
  assert.deepEqual(anim.frames.map(e => e.frameId), [f1.id, f0.id, f1.id]);
  assert.equal(ctx.sheet.frames.length, 2);
  assert.deepEqual([f1.x, f0.x], [0, 16]);
  assert.deepEqual(getPixel(ctx.bitmap(), 1, 1), BLUE);
  assert.equal(linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, 'nope').ok, false);
});

test('deleteFrame removes an unreferenced frame, clears it, and closes the gap; undo restores', () => {
  const ctx = setup();
  const anim = runWith(ctx, 3);
  const [, f1, f2] = [0, 1, 2].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 17, 1, RED);
  setPixel(ctx.bitmap(), 33, 1, BLUE);
  assert.equal(deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1).ok, true);
  assert.equal(ctx.sheet.frames.includes(f1), false);
  assert.equal(f2.x, 16);
  assert.deepEqual(getPixel(ctx.bitmap(), 17, 1), BLUE);
  assert.deepEqual(getPixel(ctx.bitmap(), 33, 1), NONE);
  ctx.services.history.undo();
  assert.deepEqual([f1.x, f2.x], [16, 32]);
  assert.deepEqual(getPixel(ctx.bitmap(), 17, 1), RED);
  assert.deepEqual(getPixel(ctx.bitmap(), 33, 1), BLUE);
});

test('deleteFrame keeps a frame another entry or a map placement still uses', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2, f1.id);
  deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2);
  assert.ok(ctx.sheet.frames.includes(f1));
  ctx.project.maps.push({ id: 'm', name: 'M', layers: [{
    id: 'ml', name: 'L', type: 'sprite', visible: true, locked: false, opacity: 1,
    sprites: [{ id: 'p', sheetId: ctx.sheet.id, assetId: f1.id, kind: 'frame', x: 0, y: 0 }],
  }] });
  deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1);
  assert.ok(ctx.sheet.frames.includes(f1));
  assert.deepEqual(anim.frames.map(e => e.frameId), [f0.id]);
});

test('deleting the last entry keeps an empty animation', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  deleteAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0);
  assert.ok(ctx.sheet.animations.includes(anim));
  assert.deepEqual([anim.frames.length, ctx.sheet.frames.length], [0, 0]);
});

test('moveFrame reorders entries and the frames swap places with their pixels', () => {
  const ctx = setup();
  const anim = runWith(ctx, 2);
  const [f0, f1] = [0, 1].map(i => entryFrame(ctx, anim, i));
  setPixel(ctx.bitmap(), 1, 1, RED);
  setPixel(ctx.bitmap(), 17, 1, BLUE);
  assert.equal(moveAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0, 1).ok, true);
  assert.deepEqual(anim.frames.map(e => e.frameId), [f1.id, f0.id]);
  assert.deepEqual([getPixel(ctx.bitmap(), 1, 1), getPixel(ctx.bitmap(), 17, 1)], [BLUE, RED]);
  assert.equal(moveAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, 1).ok, true);
  ctx.services.history.undo();
  assert.deepEqual(anim.frames.map(e => e.frameId), [f0.id, f1.id]);
});

test('a layout refusal changes nothing and records no history', () => {
  const ctx = setup({ maxWidth: 64 });
  ctx.sheet.spriteSize = { w: 80, h: 16 };
  assert.deepEqual(newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'big' }), { ok: false, reason: NO_ROOM });
  assert.deepEqual([ctx.sheet.animations.length, ctx.sheet.frames.length], [0, 0]);
  assert.equal(ctx.services.history.canUndo(), false);
});

test('refuses to move pixels out of a locked layer', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  setPixel(ctx.bitmap(), 2, 2, RED);
  Object.assign(sheetLayers(ctx.sheet)[0], { locked: true, name: 'Ink' });
  const r = addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 0);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Ink/);
  assert.deepEqual([anim.frames.length, ctx.sheet.frames.length], [1, 1]);
  ctx.services.history.undo();
  assert.equal(ctx.sheet.animations.length, 0); // only "new animation" was recorded
});

test('growth is undone and redone byte-exactly', () => {
  const ctx = setup({ width: 32, height: 16, maxWidth: 32 });
  const anim = runWith(ctx, 2);
  setPixel(ctx.bitmap(), 1, 1, RED);
  const before = ctx.bitmap().data.slice();
  addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2);
  assert.deepEqual([ctx.sheet.height, ctx.bitmap().height], [32, 32]);
  const after = ctx.bitmap().data.slice();
  ctx.services.history.undo();
  assert.equal(ctx.sheet.height, 16);
  assert.deepEqual(ctx.bitmap().data, before);
  ctx.services.history.redo();
  assert.equal(ctx.sheet.height, 32);
  assert.deepEqual(ctx.bitmap().data, after);
});

test('addFrame with count inserts that many frames as one undo step; with copyOf each is a copy', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  const first = entryFrame(ctx, anim, 0);
  setPixel(ctx.bitmap(), 2, 2, RED);
  const r = addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, { count: 3, copyOf: first.id });
  assert.equal(r.ok, true);
  assert.equal(anim.frames.length, 4);
  assert.deepEqual(r.frameIds, anim.frames.slice(1).map(e => e.frameId));
  for (const id of r.frameIds) {
    const f = ctx.sheet.frames.find(fr => fr.id === id);
    assert.deepEqual(getPixel(ctx.bitmap(), f.x + 2, f.y + 2), RED);
  }
  assert.equal(ctx.selection().frameId, r.frameIds[0]);
  ctx.services.history.undo();
  assert.deepEqual([anim.frames.length, ctx.sheet.frames.length], [1, 1]);
});

test('addFrame refuses a count that is not a positive whole number', () => {
  const ctx = setup();
  const anim = runWith(ctx, 1);
  for (const count of [0, -1, 1.5, 'x']) assert.equal(addAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, { count }).ok, false);
  assert.equal(anim.frames.length, 1);
});
