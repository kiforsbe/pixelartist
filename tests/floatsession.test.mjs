import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerFloatView, currentEditRegion } from '../js/components/canvas/float-session.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';

const host = new EditorHost();
setEditorHost(host);

function setupProject() {
  const project = createProject('p');
  const sheet = createSheet(project, { name: 's', width: 20, height: 20, kind: 'sprite' });
  const document = { kind: 'sprite-sheet', id: sheet.id };
  host.setProject(project);
  host.store.updateSession({ activeDocument: document, activeViewId: 'sprites.sheet' }, 'view');
  host.selections.set({ layerId: sheetLayers(sheet)[0].id }, document);
  return sheet;
}

test('currentEditRegion: no selection returns the whole target rect', () => {
  setupProject();
  registerFloatView('sheet', {
    getSelection: () => null,
    setSelection: () => {},
    getTargetRect: () => ({ x: 0, y: 0, w: 20, h: 20 }),
  });
  const rr = currentEditRegion();
  assert.deepEqual(rr.region, { x: 0, y: 0, w: 20, h: 20 });
  assert.deepEqual(rr.target, { x: 0, y: 0, w: 20, h: 20 });
});

test('currentEditRegion: a selection is clamped to the target rect', () => {
  setupProject();
  registerFloatView('sheet', {
    getSelection: () => ({ x: 5, y: 5, w: 100, h: 100 }), // extends past the target
    setSelection: () => {},
    getTargetRect: () => ({ x: 0, y: 0, w: 20, h: 20 }),
  });
  const rr = currentEditRegion();
  assert.deepEqual(rr.region, { x: 5, y: 5, w: 15, h: 15 });
});

test('currentEditRegion: null when there is no active registered view', () => {
  setupProject();
  host.store.updateSession({ activeViewId: 'sprites.frame' }, 'view'); // never registered in this test file
  assert.equal(currentEditRegion(), null);
});
