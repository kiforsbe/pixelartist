// tests/sprite-animation-lifecycle-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  newAnimation, deleteAnimation, renameAnimation, toggleAnimationLoop, setAnimationBaseDuration,
} from '../js/modes/sprites/application/commands/animation-lifecycle-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }), selections: new SelectionService(store) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [{ id: 'f0', name: 'f0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }],
    animations: [{
      id: 'an1', name: 'walk', loop: true, strip: false, breaks: [],
      frames: [{ frameId: 'f0', duration: 100, step: null }], layerGroupId: null,
      baseDuration: 100, baseFps: undefined, baseStep: undefined,
    }],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

// activeSheet() (js/app/state.js) reads the legacy global `state`, not
// `services.projects.project` -- newAnimation's `target === activeSheet()`
// check only resolves true if state.project/state.activeSheetId point at
// the same sheet object these tests construct. Mirrors
// sprite-animation-commands.test.mjs's reset(project) exactly.
function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
}

test('newAnimation names by animation count, selects it when the sheet is active, and undo/redo restore the same object at the same index', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  newAnimation(services, 'sheet1');
  assert.equal(sheet.animations.length, 2);
  const created = sheet.animations[1];
  assert.equal(created.name, 'anim_1');
  assert.equal(services.selections.get(doc)?.animationId, created.id);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(services.selections.get(doc)?.animationId, null);

  services.history.redo();
  assert.equal(sheet.animations.length, 2);
  assert.equal(sheet.animations[1].id, created.id);
  assert.equal(sheet.animations[1].name, 'anim_1');
});

test('deleteAnimation removes the animation and tears down its layer group; undo restores both at their original positions', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  const group = { id: 'g1', type: 'group', name: 'walk', animationId: 'an1', open: true, children: [] };
  sheet.layerTree.children.push(group);
  sheet.animations[0].layerGroupId = 'g1';
  services.selections.set({ animationId: 'an1' }, doc);

  deleteAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.animations.length, 0);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(services.selections.get(doc)?.animationId, null);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(sheet.animations[0].id, 'an1');
  assert.equal(sheet.animations[0].layerGroupId, 'g1');
  assert.equal(sheet.layerTree.children[0].id, 'g1');
  assert.equal(services.selections.get(doc)?.animationId, 'an1');
});

test('renameAnimation renames and is undoable; no-ops (no history entry) when the name is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  renameAnimation(services, 'sheet1', 'an1', 'walk');
  assert.equal(services.history.canUndo(), false);

  renameAnimation(services, 'sheet1', 'an1', 'run');
  assert.equal(sheet.animations[0].name, 'run');
  services.history.undo();
  assert.equal(sheet.animations[0].name, 'walk');
});

test('toggleAnimationLoop toggles and is undoable; no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  toggleAnimationLoop(services, 'sheet1', 'an1', true);
  assert.equal(services.history.canUndo(), false);

  toggleAnimationLoop(services, 'sheet1', 'an1', false);
  assert.equal(sheet.animations[0].loop, false);
  services.history.undo();
  assert.equal(sheet.animations[0].loop, true);
});

test('setAnimationBaseDuration sets ms/fps/step together and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  setAnimationBaseDuration(services, 'sheet1', 'an1',
    { durationMs: 100, baseFps: undefined, baseStep: undefined },
    { durationMs: 200, baseFps: 5, baseStep: 2 });
  assert.equal(sheet.animations[0].baseDuration, 200);
  assert.equal(sheet.animations[0].baseFps, 5);
  assert.equal(sheet.animations[0].baseStep, 2);

  services.history.undo();
  assert.equal(sheet.animations[0].baseDuration, 100);
  assert.equal(sheet.animations[0].baseFps, undefined);
  assert.equal(sheet.animations[0].baseStep, undefined);
});
