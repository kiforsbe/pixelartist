import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import { breakApartStrip, acceptAnimation } from '../js/modes/sprites/application/commands/animation-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: 'sheet1' } });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [{ id: 'a', name: 'a', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }],
    animations: [{
      id: 'an1', name: 'strip_0', loop: true, strip: true, breaks: [1],
      frames: [{ frameId: 'a', duration: 100 }], layerGroupId: null, baseDuration: 100,
    }],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function reset(project) {
}

test('breakApartStrip clears the strip flag and its breaks, and undo restores both', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const anim = project.sheets[0].animations[0];

  breakApartStrip(services, 'sheet1', 'an1');
  assert.equal(anim.strip, false);
  assert.deepEqual(anim.breaks, []);
  assert.equal(services.store.getState().project.dirty, true);

  services.history.undo();
  assert.equal(anim.strip, true);
  assert.deepEqual(anim.breaks, [1]);
});

test('acceptAnimation gives a floating animation its own layer group and undo detaches it', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = sheet.animations[0];

  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  acceptAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.layerTree.children.length, 1);
  const group = sheet.layerTree.children[0];
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(group.animationId, 'an1');
  assert.equal(services.selections.get(doc)?.layerId, group.children[0].id);

  services.history.undo();
  assert.equal(anim.layerGroupId, null);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(services.selections.get(doc)?.layerId, null);

  services.history.redo();
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(sheet.layerTree.children[0], group);
});

test('acceptAnimation is a no-op with no history entry once the animation is already accepted', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  project.sheets[0].animations[0].layerGroupId = 'already';

  acceptAnimation(services, 'sheet1', 'an1');
  assert.equal(services.history.canUndo(), false);
  assert.equal(project.sheets[0].layerTree.children.length, 0);
});
