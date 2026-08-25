import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { createProject, createSheet, sheetLayers } from '../js/core/model.js';
import { activeSheet, activeMap, activeLayer } from '../js/host/document-helpers.js';

function sheetProvider(kind, sheetKind) {
  return {
    kind,
    list: project => project.sheets.filter(sheet => sheet.kind === sheetKind),
    get: (project, id) => project.sheets.find(sheet => sheet.kind === sheetKind && sheet.id === id) ?? null,
    create: () => { throw new Error('not used'); },
    rename: (document, name) => { document.name = name; },
    remove: () => {},
  };
}

function mode(id, kind) {
  return {
    id, label: id, documentKinds: [kind], defaultViewId: `${id}.main`,
    register(api) { api.documents.register(sheetProvider(kind, id === 'sprites' ? 'sprite' : 'tile')); },
  };
}

test('activeSheet/activeMap/activeLayer resolve from the host store, not a stale reference', () => {
  const host = new EditorHost({});
  setEditorHost(host);
  assert.equal(activeSheet(), null);
  assert.equal(activeMap(), null);
  assert.equal(activeLayer(), null);

  // Extend to the populated case using the SAME host: setEditorHost() throws
  // if reconfigured with a different host instance, and no test in this repo
  // resets the runtime singleton between tests, so this stays one test.
  host.registerMode(mode('sprites', 'sprite-sheet'));
  host.start('sprites');

  const project = createProject('test');
  const sprite = createSheet(project, { name: 'a', width: 8, height: 8, kind: 'sprite' });
  host.setProject(project);
  host.documents.setActive({ kind: 'sprite-sheet', id: sprite.id });

  assert.equal(activeSheet(), sprite);
  assert.equal(activeMap(), null);

  const layer = sheetLayers(sprite)[0];
  host.selections.set({ layerId: layer.id });
  assert.equal(activeLayer(), layer);
});
