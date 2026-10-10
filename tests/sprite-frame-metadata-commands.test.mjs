import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { setFrameField } from '../js/modes/sprites/application/commands/frame-metadata-commands.js';

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


test('setFrameField refuses a size other than the sprite size; moves still apply', () => {
  const project = makeProject();
  const services = makeServices(project);
  const sheet = project.sheets[0];
  sheet.spriteSize = { w: 16, h: 16 };
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });
  for (const key of ['w', 'h']) {
    const r = setFrameField(services, 'sheet1', 'f1', key, 20);
    assert.equal(r.ok, false);
    assert.match(r.reason, /16×16.*Sprite size/);
  }
  assert.deepEqual(setFrameField(services, 'sheet1', 'f1', 'x', 4), { ok: true });
  assert.deepEqual([sheet.frames[0].x, sheet.frames[0].w], [4, 16]);
});
