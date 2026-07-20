import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../js/app/state.js';
import { registerFloatView, currentEditRegion } from '../js/ui/floatsession.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';

function setupProject() {
  const project = createProject('p');
  const sheet = createSheet(project, { name: 's', width: 20, height: 20, kind: 'sprite' });
  state.project = project;
  state.activeSheetId = sheet.id;
  state.activeLayerId = sheetLayers(sheet)[0].id;
  state.view = 'sheet';
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

test('currentEditRegion: null when there is no active view registered for state.view', () => {
  setupProject();
  state.view = 'frame'; // never registered in this test file
  assert.equal(currentEditRegion(), null);
});
