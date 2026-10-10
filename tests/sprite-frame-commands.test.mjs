// tests/sprite-frame-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { createLayerNode } from '../js/core/model.js';
import {
  createFrame, deleteFrame, resizeFrame, moveFrames, sliceSheetIntoFrames,
} from '../js/modes/sprites/application/commands/frame-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function reset() {}

test('createFrame adds a frame, selects it, marks dirty, and is undoable/redoable with a stable id', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();

  createFrame(services, 'sheet1', { x: 4, y: 8, w: 16, h: 16 });
  const sheet = project.sheets[0];
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].name, 'frame_0');
  assert.deepEqual(
    { x: sheet.frames[0].x, y: sheet.frames[0].y, w: sheet.frames[0].w, h: sheet.frames[0].h },
    { x: 4, y: 8, w: 16, h: 16 });
  const id = sheet.frames[0].id;
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  assert.equal(services.selections.get(doc)?.frameId, id);
  assert.equal(services.store.getState().project.dirty, true);

  services.history.undo();
  assert.equal(sheet.frames.length, 0);
  assert.equal(services.selections.get(doc)?.frameId, null);

  services.history.redo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, id);
  assert.equal(services.selections.get(doc)?.frameId, id);
});

test('deleteFrame with an unknown id is a no-op that pushes nothing onto history', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();

  deleteFrame(services, 'sheet1', 'nope');
  assert.equal(services.history.canUndo(), false);
  assert.equal(project.sheets[0].frames.length, 0);
});

test('deleteFrame removes the frame and its animation entries, and undo restores both', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const sheet = project.sheets[0];
  const frameId = sheet.frames[0].id;
  sheet.animations.push({ id: 'an1', name: 'a', loop: true, layout: 'manual', cell: null, frames: [{ frameId, duration: 100 }] });

  deleteFrame(services, 'sheet1', frameId);
  assert.equal(sheet.frames.length, 0);
  assert.equal(sheet.animations[0].frames.length, 0);

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, frameId);
  assert.deepEqual(sheet.animations[0].frames, [{ frameId, duration: 100 }]);
});

test('resizeFrame applies the after rect and undo restores the before rect', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = project.sheets[0].frames[0];

  resizeFrame(services, 'sheet1', frame.id, { x: 0, y: 0, w: 16, h: 16 }, { x: 2, y: 3, w: 20, h: 24 });
  assert.deepEqual({ x: frame.x, y: frame.y, w: frame.w, h: frame.h }, { x: 2, y: 3, w: 20, h: 24 });

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y, w: frame.w, h: frame.h }, { x: 0, y: 0, w: 16, h: 16 });
});

test('moveFrames with a zero delta is a no-op that pushes nothing onto history', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = project.sheets[0].frames[0];
  const undoDepthMarker = services.history.canUndo();
  assert.equal(undoDepthMarker, true);

  moveFrames(services, 'sheet1', [frame.id], 0, 0);
  services.history.undo();          // undoes the createFrame, proving nothing was pushed after it
  assert.equal(project.sheets[0].frames.length, 0);
});

test('moveFrames on a plain frame moves metadata only and never touches pixels', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  sheet.layerTree.children.push(layer);
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = sheet.frames[0];

  moveFrames(services, 'sheet1', [frame.id], 16, 0);
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 16, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 0, y: 0 });
});

test('sliceSheetIntoFrames appends by default and undo removes exactly the added frames', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 8, h: 8 });
  const sheet = project.sheets[0];

  sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, false);
  assert.equal(sheet.frames.length, 1 + 4);
  assert.equal(sheet.frames[1].name, 'cell_0');

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
});

test('sliceSheetIntoFrames with replace clears existing frames and every animation entry list', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 8, h: 8 });
  const sheet = project.sheets[0];
  const oldFrameId = sheet.frames[0].id;
  sheet.animations.push({ id: 'an1', name: 'a', loop: true, layout: 'manual', cell: null, frames: [{ frameId: oldFrameId, duration: 100 }] });

  sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, true);
  assert.equal(sheet.frames.length, 4);
  assert.equal(sheet.frames.some(f => f.id === oldFrameId), false);
  assert.deepEqual(sheet.animations[0].frames, []);

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, oldFrameId);
  assert.deepEqual(sheet.animations[0].frames, [{ frameId: oldFrameId, duration: 100 }]);
});

test('moveFrames moves multiple plain frames by the same delta and undoes', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  sheet.layerTree.children.push(layer);
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  createFrame(services, 'sheet1', { x: 20, y: 0, w: 16, h: 16 });
  const frame0 = sheet.frames[0];
  const frame1 = sheet.frames[1];

  moveFrames(services, 'sheet1', [frame0.id, frame1.id], 16, 8);
  assert.deepEqual({ x: frame0.x, y: frame0.y }, { x: 16, y: 8 });
  assert.deepEqual({ x: frame1.x, y: frame1.y }, { x: 36, y: 8 });
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);

  services.history.undo();
  assert.deepEqual({ x: frame0.x, y: frame0.y }, { x: 0, y: 0 });
  assert.deepEqual({ x: frame1.x, y: frame1.y }, { x: 20, y: 0 });
});


// ---- one sprite size per sprite sheet ----

function sizedProject(spriteSize = { w: 16, h: 16 }) {
  const project = makeProject();
  project.sheets[0].spriteSize = { ...spriteSize };
  return project;
}

test('createFrame stamps the sprite size at the rect\'s top-left', () => {
  const project = sizedProject();
  const services = makeServices(project);
  assert.deepEqual(createFrame(services, 'sheet1', { x: 4, y: 8, w: 3, h: 5 }), { ok: true });
  const f = project.sheets[0].frames[0];
  assert.deepEqual([f.x, f.y, f.w, f.h], [4, 8, 16, 16]);
});

test('createFrame refuses a frame that would leave the sheet', () => {
  const project = sizedProject();
  const services = makeServices(project);
  const r = createFrame(services, 'sheet1', { x: 56, y: 0, w: 1, h: 1 });
  assert.equal(r.ok, false);
  assert.deepEqual([project.sheets[0].frames.length, services.history.canUndo()], [0, false]);
});

test('resizeFrame refuses a size change but still moves a frame', () => {
  const project = sizedProject();
  const services = makeServices(project);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = project.sheets[0].frames[0];
  const r = resizeFrame(services, 'sheet1', frame.id, { x: 0, y: 0, w: 16, h: 16 }, { x: 2, y: 3, w: 20, h: 24 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /16×16/);
  assert.deepEqual(resizeFrame(services, 'sheet1', frame.id, { x: 0, y: 0, w: 16, h: 16 }, { x: 2, y: 3, w: 16, h: 16 }), { ok: true });
  assert.deepEqual([frame.x, frame.y, frame.w], [2, 3, 16]);
});

test('sliceSheetIntoFrames appending to a sheet with frames needs the sprite size', () => {
  const project = sizedProject();
  const services = makeServices(project);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const r = sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, false);
  assert.equal(r.ok, false);
  assert.match(r.reason, /16×16/);
  assert.equal(project.sheets[0].frames.length, 1);
  assert.equal(sliceSheetIntoFrames(services, 'sheet1', { cellW: 16, cellH: 16, namePrefix: 'cell' }, false).ok, true);
});

test('sliceSheetIntoFrames with replace adopts the slice size as the sprite size; undo restores it', () => {
  const project = sizedProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  sheet.animations.push({ id: 'an1', name: 'a', loop: true, layout: 'auto', cell: { w: 16, h: 16 }, frames: [] });
  assert.equal(sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, true).ok, true);
  assert.deepEqual([sheet.spriteSize, sheet.animations[0].cell, sheet.frames.length], [{ w: 32, h: 32 }, { w: 32, h: 32 }, 4]);
  services.history.undo();
  assert.deepEqual([sheet.spriteSize, sheet.animations[0].cell], [{ w: 16, h: 16 }, { w: 16, h: 16 }]);
});

test('sliceSheetIntoFrames on a sheet without frames adopts the slice size', () => {
  const project = sizedProject();
  const services = makeServices(project);
  assert.equal(sliceSheetIntoFrames(services, 'sheet1', { cellW: 8, cellH: 32, namePrefix: 'cell' }, false).ok, true);
  assert.deepEqual(project.sheets[0].spriteSize, { w: 8, h: 32 });
});
