// tests/sprite-frame-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { createLayerNode, createGroupNode } from '../js/core/model.js';
import { state } from '../js/app/state.js';
import {
  createFrame, deleteFrame, resizeFrame, moveFrames, sliceSheetIntoFrames,
} from '../js/modes/sprites/application/commands/frame-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function reset() { state.commands = new CommandStack(); state.dirty = false; state.selectedFrameId = null; }

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
  assert.equal(state.selectedFrameId, id);
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.frames.length, 0);
  assert.equal(state.selectedFrameId, null);

  services.history.redo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, id);
  assert.equal(state.selectedFrameId, id);
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
  sheet.animations.push({ id: 'an1', name: 'a', strip: true, loop: true, breaks: [], frames: [{ frameId, duration: 100 }], layerGroupId: null });

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

  moveFrames(services, 'sheet1', [frame.id], 0, 0, null);
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

  moveFrames(services, 'sheet1', [frame.id], 16, 0, null);
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 16, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 0, y: 0 });
});

test("moveFrames on an accepted strip carries the strip layer's pixels and undo restores them", () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  const group = createGroupNode('strip_0', { animationId: 'an1' });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  createFrame(services, 'sheet1', { x: 0, y: 0, w: 16, h: 16 });
  const frame = sheet.frames[0];
  sheet.animations.push({ id: 'an1', name: 'strip_0', strip: true, loop: true, breaks: [], frames: [{ frameId: frame.id, duration: 100 }], layerGroupId: group.id });

  moveFrames(services, 'sheet1', [frame.id], 16, 0, 'an1');
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 16, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 0, y: 0 });
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);
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
  sheet.animations.push({ id: 'an1', name: 'a', strip: true, loop: true, breaks: [1], frames: [{ frameId: oldFrameId, duration: 100 }], layerGroupId: null });

  sliceSheetIntoFrames(services, 'sheet1', { cellW: 32, cellH: 32, namePrefix: 'cell' }, true);
  assert.equal(sheet.frames.length, 4);
  assert.equal(sheet.frames.some(f => f.id === oldFrameId), false);
  assert.deepEqual(sheet.animations[0].frames, []);
  assert.deepEqual(sheet.animations[0].breaks, []);

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, oldFrameId);
  assert.deepEqual(sheet.animations[0].frames, [{ frameId: oldFrameId, duration: 100 }]);
  assert.deepEqual(sheet.animations[0].breaks, [1]);
});
