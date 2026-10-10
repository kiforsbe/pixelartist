import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { PINNED_HINT } from '../js/domain/sprites/auto-layout.js';
import { newAutoAnimation } from '../js/modes/sprites/application/commands/animation-layout-commands.js';
import { createFrame, moveFrames, resizeFrame } from '../js/modes/sprites/application/commands/frame-commands.js';
import { setFrameField } from '../js/modes/sprites/application/commands/frame-metadata-commands.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration,
} from '../js/modes/sprites/application/commands/animation-frame-commands.js';

const RED = [255, 0, 0, 255];

function setup() {
  const project = createProject('t');
  project.settings.sheetMaxWidth = 64;
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
  const { animationId } = newAutoAnimation(services, sheet.id, { name: 'run', w: 16, h: 16 });
  const anim = sheet.animations[0];
  return { project, sheet, services, anim, animationId, pinned: sheet.frames[0] };
}

test('a pinned frame cannot be moved or resized; a plain frame still moves', () => {
  const { sheet, services, pinned } = setup();
  assert.deepEqual(moveFrames(services, sheet.id, [pinned.id], 4, 0), { ok: false, reason: PINNED_HINT });
  assert.deepEqual(resizeFrame(services, sheet.id, pinned.id, { x: 0, y: 0, w: 16, h: 16 }, { x: 0, y: 0, w: 8, h: 8 }), { ok: false, reason: PINNED_HINT });
  assert.deepEqual([pinned.x, pinned.w], [0, 16]);
  services.history.undo(); // the only recorded step is "new animation"
  assert.equal(services.history.canUndo(), false);
  services.history.redo();
  createFrame(services, sheet.id, { x: 40, y: 40, w: 8, h: 8 });
  const plain = sheet.frames.at(-1);
  moveFrames(services, sheet.id, [plain.id], 2, 0);
  assert.equal(plain.x, 42);
});

test('setFrameField refuses geometry on a pinned frame but still renames it', () => {
  const { sheet, services, pinned } = setup();
  for (const key of ['x', 'y', 'w', 'h', 'pivotX', 'pivotY'])
    assert.deepEqual(setFrameField(services, sheet.id, pinned.id, key, 3), { ok: false, reason: PINNED_HINT });
  setFrameField(services, sheet.id, pinned.id, 'name', 'hero');
  assert.equal(pinned.name, 'hero');
});

test('the plain timeline commands refuse an auto animation; timing edits still apply', () => {
  const { sheet, services, anim, pinned } = setup();
  for (const r of [
    addAnimationFrame(services, sheet.id, anim.id, pinned.id),
    removeAnimationFrame(services, sheet.id, anim.id, 0),
    reorderAnimationFrame(services, sheet.id, anim.id, 0, 0),
  ]) assert.equal(r.ok, false);
  assert.equal(anim.frames.length, 1);
  setAnimationFrameDuration(services, sheet.id, anim.id, 0, 250);
  assert.equal(anim.frames[0].duration, 250);
});

test('sprites.deleteFrame routes a pinned frame to the layout-aware delete', () => {
  const host = new EditorHost();
  setEditorHost(host);
  host.registerMode(spriteMode);
  const project = createProject('t');
  project.settings.sheetMaxWidth = 64;
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite' });
  host.setProject(project);
  host.store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const run = (id, args) => host.registries.commands.execute(id, { modeId: 'sprites' }, { sheetId: sheet.id, ...args });
  const { animationId } = run('animations.new', { name: 'run', w: 16, h: 16 });
  run('animations.addFrame', { animationId, at: 1 });
  const [f0, f1] = sheet.frames;
  setPixel(sheetLayers(sheet)[0].bitmap, 17, 1, RED);
  run('sprites.deleteFrame', { frameId: f0.id });
  assert.deepEqual([sheet.frames, f1.x], [[f1], 0]);
  assert.deepEqual(getPixel(sheetLayers(sheet)[0].bitmap, 1, 1), RED);
});
