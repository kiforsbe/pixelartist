import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, activeSheet, activeMap } from '../js/app/state.js';
import { createProject, createSheet, createMap } from '../js/core/model.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';

function testProject() {
  const project = createProject('test');
  const sheet = createSheet(project, { name: 'sprites', width: 8, height: 8, kind: 'sprite' });
  const map = createMap(project, { name: 'world' });
  return { project, sheet, map };
}

test('activeSheet/activeMap fall back to legacy ids when no EditorHost is configured', () => {
  const { project, sheet, map } = testProject();
  state.project = project;
  state.activeSheetId = sheet.id;
  state.activeMapId = map.id;
  assert.equal(activeSheet(), sheet);
  assert.equal(activeMap(), map);
});

test('activeSheet/activeMap read from the EditorHost session when one is configured', () => {
  const { project, sheet, map } = testProject();
  state.project = project;
  // Legacy ids intentionally left null/stale to prove the host path is
  // actually driving the result, not falling through to these.
  state.activeSheetId = null;
  state.activeMapId = null;

  const host = new EditorHost();
  host.store.transaction('test-setup', next => { next.session.activeDocument = { kind: 'sprite-sheet', id: sheet.id }; });
  setEditorHost(host);

  assert.equal(activeSheet(), sheet);

  host.store.transaction('test-setup', next => { next.session.activeDocument = { kind: 'map', id: map.id }; });
  assert.equal(activeMap(), map);
});
