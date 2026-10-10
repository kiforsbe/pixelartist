// tests/sprite-animation-frame-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration, setAnimationFrameStep,
} from '../js/modes/sprites/application/commands/animation-frame-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [
      { id: 'f0', name: 'f0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 },
      { id: 'f1', name: 'f1', x: 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 },
    ],
    animations: [{
      id: 'an1', name: 'walk', loop: true,
      frames: [
        { frameId: 'f0', duration: 100, step: null },
        { frameId: 'f1', duration: 150, step: null },
      ],
      layout: 'manual', cell: null, baseDuration: 100, baseFps: undefined, baseStep: undefined,
    }],
    layerTree: { id: 'root', type: 'group', name: 'root', open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

test('addAnimationFrame appends a null-duration/step entry and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];

  addAnimationFrame(services, 'sheet1', 'an1', 'f0');
  assert.equal(sheet.animations[0].frames.length, 3);
  assert.deepEqual(sheet.animations[0].frames[2], { frameId: 'f0', duration: null, step: null });

  services.history.undo();
  assert.equal(sheet.animations[0].frames.length, 2);
});

test('removeAnimationFrame drops the entry at index and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];

  removeAnimationFrame(services, 'sheet1', 'an1', 0);
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f1']);

  services.history.undo();
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f0', 'f1']);
});

test('reorderAnimationFrame moves an entry to a new index, clamping to the array bounds, and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];

  reorderAnimationFrame(services, 'sheet1', 'an1', 0, 2);
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f1', 'f0']);
  services.history.undo();
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f0', 'f1']);

  // toIndex beyond the array clamps to the end (Math.min(after.length, toIndex))
  reorderAnimationFrame(services, 'sheet1', 'an1', 0, 99);
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f1', 'f0']);
});

test('setAnimationFrameDuration edits one entry, is undoable, and no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];

  setAnimationFrameDuration(services, 'sheet1', 'an1', 1, 150);
  assert.equal(services.history.canUndo(), false);

  setAnimationFrameDuration(services, 'sheet1', 'an1', 1, 300);
  assert.equal(sheet.animations[0].frames[1].duration, 300);
  services.history.undo();
  assert.equal(sheet.animations[0].frames[1].duration, 150);
});

test('setAnimationFrameStep edits one entry, is undoable, and no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];

  setAnimationFrameStep(services, 'sheet1', 'an1', 0, null);
  assert.equal(services.history.canUndo(), false);

  setAnimationFrameStep(services, 'sheet1', 'an1', 0, 2);
  assert.equal(sheet.animations[0].frames[0].step, 2);
  services.history.undo();
  assert.equal(sheet.animations[0].frames[0].step, null);
});
