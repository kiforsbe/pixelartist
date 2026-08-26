import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import {
  setFrameField, moveStripTo, setStripFrameSize, setStripPivot,
} from '../js/modes/sprites/application/commands/frame-metadata-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makeProject({ width = 64, height = 64 } = {}) {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width, height,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function addStrip(sheet, ids, { breaks = [] } = {}) {
  ids.forEach((id, index) => sheet.frames.push({ id, name: id, x: index * 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }));
  const anim = {
    id: 'an1', name: 'strip_0', loop: true, strip: true, breaks: breaks.slice(),
    frames: ids.map(id => ({ frameId: id, duration: 100 })), layerGroupId: null, baseDuration: 100,
  };
  sheet.animations.push(anim);
  return anim;
}

function reset() {}

test('setFrameField edits one field, is undoable, and no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  setFrameField(services, 'sheet1', 'f1', 'name', 'hero');
  assert.equal(sheet.frames[0].name, 'hero');
  assert.equal(services.store.getState().project.dirty, true);

  setFrameField(services, 'sheet1', 'f1', 'name', 'hero');
  services.history.undo();
  assert.equal(sheet.frames[0].name, 'frame_0');
  assert.equal(services.history.canUndo(), false);
});

test('moveStripTo clamps the strip bounding box to the sheet', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  moveStripTo(services, 'sheet1', 'an1', 100, 0);
  assert.deepEqual(sheet.frames.map(f => f.x), [32, 48]);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 16]);
});

test('moveStripTo is a no-op with no history entry when nothing would move', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  addStrip(project.sheets[0], ['a', 'b']);

  moveStripTo(services, 'sheet1', 'an1', 0, 0);
  assert.equal(services.history.canUndo(), false);
});

test('setStripFrameSize w clamps per segment and re-lays the segment out left to right', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  setStripFrameSize(services, 'sheet1', 'an1', 'w', 100);
  assert.deepEqual(sheet.frames.map(f => f.w), [32, 32]);
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 32]);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.w), [16, 16]);
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 16]);
});

test('setStripFrameSize h clamps each frame to the sheet height and no-ops when already set', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  setStripFrameSize(services, 'sheet1', 'an1', 'h', 100);
  assert.deepEqual(sheet.frames.map(f => f.h), [64, 64]);

  setStripFrameSize(services, 'sheet1', 'an1', 'h', 100);
  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.h), [16, 16]);
  assert.equal(services.history.canUndo(), false);
});

test('setStripPivot applies to every member and no-ops when they already match', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];
  addStrip(sheet, ['a', 'b']);

  setStripPivot(services, 'sheet1', 'an1', 'pivotX', 8);
  assert.deepEqual(sheet.frames.map(f => f.pivotX), [8, 8]);

  setStripPivot(services, 'sheet1', 'an1', 'pivotX', 8);
  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.pivotX), [0, 0]);
  assert.equal(services.history.canUndo(), false);
});
