// tests/animation-range-commands.test.mjs
// Range commands for animation frames (timeline-dock-dragdrop design §4):
// each is one history step with byte-exact undo/redo; manual animations get
// entry-list edits only; frame-creating commands need the auto layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { createProject, createSheet, sheetLayers, addFrame, addAnimation, addLayer } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import {
  newAutoAnimation, addAutoFrame, linkAutoFrame, NEEDS_AUTO,
} from '../js/modes/sprites/application/commands/animation-layout-commands.js';
import {
  moveFrames, copyFrames, duplicateFrames, deleteFrames, reverseFrames, setFrameDurations, unlinkFrame, clearCel,
} from '../js/modes/sprites/application/commands/animation-range-commands.js';

const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], WHITE = [255, 255, 255, 255];
const NONE = [0, 0, 0, 0];
const COLOURS = [RED, GREEN, BLUE, WHITE];

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
    revision: () => services.history.snapshot().revision,
  };
}

// An auto animation "run" of `count` 16x16 frames, frame i marked at (1,1)
// with COLOURS[i], laid out left to right.
function autoRun(ctx, count) {
  newAutoAnimation(ctx.services, ctx.sheet.id, { name: 'run', w: 16, h: 16 });
  const anim = ctx.sheet.animations.at(-1);
  for (let i = 1; i < count; i++) addAutoFrame(ctx.services, ctx.sheet.id, anim.id, i);
  anim.frames.forEach((e, i) => {
    const f = ctx.sheet.frames.find(fr => fr.id === e.frameId);
    setPixel(ctx.bitmap(), f.x + 1, f.y + 1, COLOURS[i]);
  });
  return anim;
}

// A manual animation over `count` hand-placed 8x8 frames on row y = 40.
function manualRun(ctx, count) {
  const anim = addAnimation(ctx.sheet, 'walk');
  for (let i = 0; i < count; i++) {
    const f = addFrame(ctx.sheet, { name: `walk_${i}`, x: i * 8, y: 40, w: 8, h: 8 });
    setPixel(ctx.bitmap(), f.x + 1, f.y + 1, COLOURS[i]);
    anim.frames.push({ frameId: f.id, duration: null, step: null });
  }
  return anim;
}

const ids = anim => anim.frames.map(e => e.frameId);
const frameOf = (ctx, id) => ctx.sheet.frames.find(f => f.id === id);
const marker = (ctx, id) => { const f = frameOf(ctx, id); return getPixel(ctx.bitmap(), f.x + 1, f.y + 1); };

// Everything a command could touch, for byte-exact comparisons.
function state(ctx) {
  const { sheet } = ctx;
  return JSON.stringify({
    size: [sheet.width, sheet.height],
    frames: sheet.frames,
    animations: sheet.animations,
    layers: sheetLayers(sheet).map(l => [l.id, l.bitmap.width, l.bitmap.height, Buffer.from(l.bitmap.data).toString('base64')]),
  });
}

// Runs `run`, then checks one undo restores the state byte-exactly and one
// redo brings back the result byte-exactly. Returns run's result.
function oneStep(ctx, run) {
  const before = state(ctx);
  const result = run();
  assert.equal(result.ok, true, result.reason);
  const after = state(ctx);
  assert.notEqual(after, before);
  ctx.services.history.undo();
  assert.equal(state(ctx), before, 'one undo restores everything');
  ctx.services.history.redo();
  assert.equal(state(ctx), after, 'redo repeats it');
  return result;
}

function refusesUnchanged(ctx, run, pattern) {
  const before = state(ctx), revision = ctx.revision();
  const result = run();
  assert.equal(result.ok, false);
  if (pattern) assert.match(result.reason, pattern);
  assert.equal(state(ctx), before);
  assert.equal(ctx.revision(), revision, 'no history recorded');
  return result;
}

// ---- moveFrames ----

test('moveFrames moves an auto range and its pixels; reports the new range', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 4);
  const [f0, f1, f2, f3] = ids(anim);
  const r = oneStep(ctx, () => moveFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1, 4));
  assert.deepEqual(r, { ok: true, from: 2, to: 3 });
  assert.deepEqual(ids(anim), [f2, f3, f0, f1]);
  assert.deepEqual([frameOf(ctx, f2).x, frameOf(ctx, f0).x], [0, 32]);
  assert.deepEqual([marker(ctx, f0), marker(ctx, f2)], [RED, BLUE]);
  assert.deepEqual(getPixel(ctx.bitmap(), 1, 1), BLUE);
});

test('moveFrames moves a range earlier', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 4);
  const [f0, f1, f2, f3] = ids(anim);
  assert.deepEqual(moveFrames(ctx.services, ctx.sheet.id, anim.id, 2, 3, 1), { ok: true, from: 1, to: 2 });
  assert.deepEqual(ids(anim), [f0, f2, f3, f1]);
});

test('moveFrames on a manual animation reorders entries only', () => {
  const ctx = setup();
  const anim = manualRun(ctx, 3);
  const [f0, f1, f2] = ids(anim);
  const rects = ctx.sheet.frames.map(f => [f.x, f.y]);
  const pixels = ctx.bitmap().data.slice();
  const r = oneStep(ctx, () => moveFrames(ctx.services, ctx.sheet.id, anim.id, 2, 2, 0));
  assert.deepEqual(r, { ok: true, from: 0, to: 0 });
  assert.deepEqual(ids(anim), [f2, f0, f1]);
  assert.deepEqual(ctx.sheet.frames.map(f => [f.x, f.y]), rects);
  assert.deepEqual(ctx.bitmap().data, pixels);
});

test('moveFrames to a slot inside or next to the range is a no-op without history', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 4);
  const revision = ctx.revision();
  for (const at of [1, 2, 3]) assert.deepEqual(moveFrames(ctx.services, ctx.sheet.id, anim.id, 1, 2, at), { ok: true, from: 1, to: 2 });
  assert.equal(ctx.revision(), revision);
});

test('range commands accept a reversed range and refuse empty or out-of-range ones', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 3);
  assert.deepEqual(moveFrames(ctx.services, ctx.sheet.id, anim.id, 1, 0, 3), { ok: true, from: 1, to: 2 });
  for (const [from, to] of [[-1, 0], [0, 3], [3, 3], [0.5, 1], [null, 1]]) {
    refusesUnchanged(ctx, () => moveFrames(ctx.services, ctx.sheet.id, anim.id, from, to, 0));
    refusesUnchanged(ctx, () => deleteFrames(ctx.services, ctx.sheet.id, anim.id, from, to));
    refusesUnchanged(ctx, () => reverseFrames(ctx.services, ctx.sheet.id, anim.id, from, to));
    refusesUnchanged(ctx, () => copyFrames(ctx.services, ctx.sheet.id, anim.id, from, to, 0));
    refusesUnchanged(ctx, () => setFrameDurations(ctx.services, ctx.sheet.id, anim.id, from, to, { duration: 50 }));
  }
  refusesUnchanged(ctx, () => moveFrames(ctx.services, ctx.sheet.id, 'nope', 0, 0, 1));
  refusesUnchanged(ctx, () => moveFrames(ctx.services, ctx.sheet.id, anim.id, 0, 0, 'x'));
});

test('moveFrames on an empty animation refuses', () => {
  const ctx = setup();
  const anim = addAnimation(ctx.sheet, 'empty');
  refusesUnchanged(ctx, () => moveFrames(ctx.services, ctx.sheet.id, anim.id, 0, 0, 0));
});

// ---- copyFrames / duplicateFrames ----

test('copyFrames inserts independent copies with their pixels and durations', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 3);
  anim.frames[1].duration = 250;
  const [f0, f1, f2] = ids(anim);
  const r = oneStep(ctx, () => copyFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1, 3));
  assert.deepEqual([r.from, r.to, r.frameIds.length], [3, 4, 2]);
  assert.deepEqual(ids(anim), [f0, f1, f2, ...r.frameIds]);
  assert.equal(new Set(ids(anim)).size, 5);
  assert.deepEqual(r.frameIds.map(id => marker(ctx, id)), [RED, GREEN]);
  assert.deepEqual([marker(ctx, f0), marker(ctx, f1), marker(ctx, f2)], [RED, GREEN, BLUE]);
  assert.equal(anim.frames[4].duration, 250);
  assert.equal(ctx.selection().frameId, r.frameIds[0]);
});

test('copyFrames keeps linked uses inside the range linked to each other, not to the source', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  const [f0, f1] = ids(anim);
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 1, f0); // f0 f0 f1
  const r = copyFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1, 0);
  assert.equal(r.frameIds.length, 1);
  assert.deepEqual(ids(anim), [r.frameIds[0], r.frameIds[0], f0, f0, f1]);
});

test('duplicateFrames copies the range right after itself', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 3);
  const [f0, f1, f2] = ids(anim);
  const r = oneStep(ctx, () => duplicateFrames(ctx.services, ctx.sheet.id, anim.id, 1, 2));
  assert.deepEqual([r.from, r.to], [3, 4]);
  assert.deepEqual(ids(anim), [f0, f1, f2, ...r.frameIds]);
  assert.deepEqual(r.frameIds.map(id => marker(ctx, id)), [GREEN, BLUE]);
});

test('frame-creating commands refuse a manual animation with the auto-layout message', () => {
  const ctx = setup();
  const anim = manualRun(ctx, 2);
  anim.frames.push({ ...anim.frames[0] });
  assert.equal(NEEDS_AUTO, 'Auto-layout this animation first');
  for (const run of [
    () => copyFrames(ctx.services, ctx.sheet.id, anim.id, 0, 0, 1),
    () => duplicateFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1),
    () => unlinkFrame(ctx.services, ctx.sheet.id, anim.id, 2),
  ]) assert.equal(refusesUnchanged(ctx, run).reason, NEEDS_AUTO);
});

test('copying refuses when a locked layer has pixels in a copied frame', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  Object.assign(sheetLayers(ctx.sheet)[0], { locked: true, name: 'Ink' });
  refusesUnchanged(ctx, () => copyFrames(ctx.services, ctx.sheet.id, anim.id, 0, 0, 2), /Ink/);
  refusesUnchanged(ctx, () => duplicateFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1), /Ink/);
});

test('a copy that grows the sheet is undone and redone byte-exactly', () => {
  const ctx = setup({ width: 32, height: 16, maxWidth: 32 });
  const anim = autoRun(ctx, 2);
  oneStep(ctx, () => copyFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1, 2));
  assert.deepEqual([ctx.sheet.height, ctx.bitmap().height], [32, 32]);
});

// ---- deleteFrames ----

test('deleteFrames removes entries, deletes unreferenced frames and closes the gap', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 4);
  const [f0, f1, f2, f3] = ids(anim);
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 4, f1); // f0 f1 f2 f3 f1
  ctx.services.selections.patch({ animationId: anim.id, frameId: f2 }, { kind: 'sprite-sheet', id: ctx.sheet.id });
  oneStep(ctx, () => deleteFrames(ctx.services, ctx.sheet.id, anim.id, 1, 2));
  assert.deepEqual(ids(anim), [f0, f3, f1]);
  assert.equal(frameOf(ctx, f2), undefined);
  assert.ok(frameOf(ctx, f1), 'still used by the last entry');
  assert.deepEqual([frameOf(ctx, f3).x, frameOf(ctx, f1).x], [16, 32]);
  assert.deepEqual([marker(ctx, f3), marker(ctx, f1)], [WHITE, GREEN]);
  assert.deepEqual(getPixel(ctx.bitmap(), 49, 1), NONE);
  assert.equal(ctx.selection().frameId, null);
  ctx.services.history.undo();
  assert.equal(ctx.selection().frameId, f2);
});

test('deleteFrames can empty an animation, which stays', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  deleteFrames(ctx.services, ctx.sheet.id, anim.id, 0, 1);
  assert.deepEqual([anim.frames.length, ctx.sheet.frames.length, ctx.sheet.animations.includes(anim)], [0, 0, true]);
});

test('deleteFrames on a manual animation removes entries only and keeps the frames', () => {
  const ctx = setup();
  const anim = manualRun(ctx, 3);
  const [f0] = ids(anim);
  const pixels = ctx.bitmap().data.slice();
  oneStep(ctx, () => deleteFrames(ctx.services, ctx.sheet.id, anim.id, 1, 2));
  assert.deepEqual(ids(anim), [f0]);
  assert.equal(ctx.sheet.frames.length, 3);
  assert.deepEqual(ctx.bitmap().data, pixels);
});

// ---- reverseFrames ----

test('reverseFrames reverses an auto range and its pixels', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 4);
  const [f0, f1, f2, f3] = ids(anim);
  oneStep(ctx, () => reverseFrames(ctx.services, ctx.sheet.id, anim.id, 1, 3));
  assert.deepEqual(ids(anim), [f0, f3, f2, f1]);
  assert.deepEqual([getPixel(ctx.bitmap(), 17, 1), getPixel(ctx.bitmap(), 49, 1)], [WHITE, GREEN]);
});

test('reverseFrames on a manual animation reverses entries only', () => {
  const ctx = setup();
  const anim = manualRun(ctx, 3);
  const [f0, f1, f2] = ids(anim);
  const pixels = ctx.bitmap().data.slice();
  oneStep(ctx, () => reverseFrames(ctx.services, ctx.sheet.id, anim.id, 0, 2));
  assert.deepEqual(ids(anim), [f2, f1, f0]);
  assert.deepEqual(ctx.bitmap().data, pixels);
});

test('reverseFrames of a single entry or a palindrome records nothing', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  const [f0] = ids(anim);
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2, f0); // f0 f1 f0
  const revision = ctx.revision();
  assert.deepEqual(reverseFrames(ctx.services, ctx.sheet.id, anim.id, 1, 1), { ok: true });
  assert.deepEqual(reverseFrames(ctx.services, ctx.sheet.id, anim.id, 0, 2), { ok: true });
  assert.equal(ctx.revision(), revision);
});

// ---- setFrameDurations ----

test('setFrameDurations sets every entry of the range in one step, both layouts', () => {
  for (const make of [autoRun, manualRun]) {
    const ctx = setup();
    const anim = make(ctx, 3);
    oneStep(ctx, () => setFrameDurations(ctx.services, ctx.sheet.id, anim.id, 0, 1, { duration: 150 }));
    assert.deepEqual(anim.frames.map(e => e.duration), [150, 150, null]);
  }
});

test('setFrameDurations sets the hold step for an fps-based animation, and null resets', () => {
  const ctx = setup();
  const anim = manualRun(ctx, 3);
  anim.baseFps = 12; anim.baseStep = 1;
  oneStep(ctx, () => setFrameDurations(ctx.services, ctx.sheet.id, anim.id, 1, 2, { step: 3 }));
  assert.deepEqual(anim.frames.map(e => e.step), [null, 3, 3]);
  oneStep(ctx, () => setFrameDurations(ctx.services, ctx.sheet.id, anim.id, 0, 2, { step: null }));
  assert.deepEqual(anim.frames.map(e => e.step), [null, null, null]);
});

test('setFrameDurations refuses bad values and records nothing when unchanged', () => {
  const ctx = setup();
  const anim = manualRun(ctx, 2);
  for (const value of [{}, { duration: 0 }, { duration: -5 }, { duration: 'x' }, { step: 1.5 }, { step: 0 }]) {
    refusesUnchanged(ctx, () => setFrameDurations(ctx.services, ctx.sheet.id, anim.id, 0, 1, value));
  }
  const revision = ctx.revision();
  assert.deepEqual(setFrameDurations(ctx.services, ctx.sheet.id, anim.id, 0, 1, { duration: null }), { ok: true });
  assert.equal(ctx.revision(), revision);
});

// ---- unlinkFrame ----

test('unlinkFrame gives a linked entry its own frame with a copy of the pixels', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  const [f0, f1] = ids(anim);
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2, f0); // f0 f1 f0
  const r = oneStep(ctx, () => unlinkFrame(ctx.services, ctx.sheet.id, anim.id, 2));
  assert.deepEqual(ids(anim), [f0, f1, r.frameId]);
  assert.notEqual(r.frameId, f0);
  assert.deepEqual([marker(ctx, r.frameId), marker(ctx, f0)], [RED, RED]);
  assert.equal(ctx.selection().frameId, r.frameId);
});

test('unlinkFrame on the first use leaves the later uses on the original frame', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  const [f0, f1] = ids(anim);
  linkAutoFrame(ctx.services, ctx.sheet.id, anim.id, 2, f0);
  const r = unlinkFrame(ctx.services, ctx.sheet.id, anim.id, 0);
  assert.deepEqual(ids(anim), [r.frameId, f1, f0]);
  assert.deepEqual([marker(ctx, r.frameId), marker(ctx, f0), marker(ctx, f1)], [RED, RED, GREEN]);
});

test('unlinkFrame refuses an entry that is not linked or does not exist', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 2);
  refusesUnchanged(ctx, () => unlinkFrame(ctx.services, ctx.sheet.id, anim.id, 0), /not linked/);
  refusesUnchanged(ctx, () => unlinkFrame(ctx.services, ctx.sheet.id, anim.id, 5));
});

// ---- clearCel ----

test('clearCel clears one layer inside one frame, for auto and manual frames', () => {
  const ctx = setup();
  const auto = autoRun(ctx, 2);
  const manual = manualRun(ctx, 1);
  const top = addLayer(ctx.sheet, 'Top');
  const [a0, a1] = ids(auto);
  const fa = frameOf(ctx, a0);
  setPixel(top.bitmap, fa.x + 2, fa.y + 2, BLUE);
  oneStep(ctx, () => clearCel(ctx.services, ctx.sheet.id, a0, sheetLayers(ctx.sheet)[0].id));
  assert.deepEqual(marker(ctx, a0), NONE);
  assert.deepEqual(marker(ctx, a1), GREEN);
  assert.deepEqual(getPixel(top.bitmap, fa.x + 2, fa.y + 2), BLUE);
  const [m0] = ids(manual);
  oneStep(ctx, () => clearCel(ctx.services, ctx.sheet.id, m0, sheetLayers(ctx.sheet)[0].id));
  assert.deepEqual(marker(ctx, m0), NONE);
});

test('clearCel refuses a locked layer, a folder, or an unknown frame; an empty cel records nothing', () => {
  const ctx = setup();
  const anim = autoRun(ctx, 1);
  const [f0] = ids(anim);
  const layer = sheetLayers(ctx.sheet)[0];
  Object.assign(layer, { locked: true, name: 'Ink' });
  refusesUnchanged(ctx, () => clearCel(ctx.services, ctx.sheet.id, f0, layer.id), /Ink/);
  layer.locked = false;
  refusesUnchanged(ctx, () => clearCel(ctx.services, ctx.sheet.id, f0, ctx.sheet.layerTree.id));
  refusesUnchanged(ctx, () => clearCel(ctx.services, ctx.sheet.id, 'nope', layer.id));
  const empty = addLayer(ctx.sheet, 'Empty');
  const revision = ctx.revision();
  assert.deepEqual(clearCel(ctx.services, ctx.sheet.id, f0, empty.id), { ok: true });
  assert.equal(ctx.revision(), revision);
});
