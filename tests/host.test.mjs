import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { createProject, createSheet, createMap } from '../js/core/model.js';

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

function mode(id, kind, hooks = {}) {
  return {
    id, label: id, documentKinds: [kind], defaultViewId: `${id}.main`,
    register(api) { api.documents.register(sheetProvider(kind, id === 'sprites' ? 'sprite' : 'tile')); hooks.register?.(api); },
    activate: hooks.activate,
  };
}

test('EditorHost registers and activates a mode without host-specific code', () => {
  const host = new EditorHost();
  const activations = [];
  host.registerMode(mode('sprites', 'sprite-sheet', { activate: context => {
    activations.push(context.mode.id);
    return { dispose: () => activations.push('disposed') };
  } }));
  host.start('sprites');
  assert.equal(host.activeModeId, 'sprites');
  assert.deepEqual(activations, ['sprites']);
  assert.equal(host.contextKeys.get('viewId'), 'sprites.main');
  host.dispose();
  assert.deepEqual(activations, ['sprites', 'disposed']);
});

test('mode switching remembers active documents per mode', () => {
  const host = new EditorHost();
  host.registerMode(mode('sprites', 'sprite-sheet'));
  host.registerMode(mode('tiles', 'tile-sheet'));
  host.start('sprites');
  const project = createProject('test');
  const spriteA = createSheet(project, { name: 'a', width: 8, height: 8, kind: 'sprite' });
  const spriteB = createSheet(project, { name: 'b', width: 8, height: 8, kind: 'sprite' });
  const tile = createSheet(project, { name: 'tiles', width: 8, height: 8, kind: 'tile' });
  host.setProject(project);
  host.documents.setActive({ kind: 'sprite-sheet', id: spriteB.id });
  host.activateMode('tiles');
  assert.deepEqual(host.store.getState().session.activeDocument, { kind: 'tile-sheet', id: tile.id });
  host.activateMode('sprites');
  assert.deepEqual(host.store.getState().session.activeDocument, { kind: 'sprite-sheet', id: spriteB.id });
  assert.notEqual(spriteA.id, spriteB.id);
});

test('failed mode activation rolls state back and leaves prior mode active', () => {
  const host = new EditorHost();
  host.registerMode(mode('sprites', 'sprite-sheet'));
  host.registerMode(mode('tiles', 'tile-sheet', { activate: () => { throw new Error('boom'); } }));
  host.start('sprites');
  assert.throws(() => host.activateMode('tiles'), /boom/);
  assert.equal(host.activeModeId, 'sprites');
  assert.equal(host.store.getState().session.activeModeId, 'sprites');
  assert.equal(host.contextKeys.get('modeId'), 'sprites');
});

test('built-in-shaped map provider can coexist with sheet modes', () => {
  const host = new EditorHost();
  host.registerMode({
    id: 'maps', label: 'Maps', documentKinds: ['map'], defaultViewId: 'maps.canvas',
    register(api) { api.documents.register({
      kind: 'map', list: project => project.maps, get: (project, id) => project.maps.find(map => map.id === id),
      create: (project, input) => createMap(project, input), rename: (map, name) => { map.name = name; },
      remove: (project, id) => project.maps.splice(project.maps.findIndex(map => map.id === id), 1),
    }); },
  });
  host.start('maps');
  const project = createProject('maps');
  const map = createMap(project, { name: 'World' });
  host.setProject(project);
  assert.deepEqual(host.store.getState().session.activeDocument, { kind: 'map', id: map.id });
});

test('EditorStore starts with a default overlays workspace field, mutable via transaction', () => {
  const host = new EditorHost();
  assert.deepEqual(host.store.getState().workspace.overlays, { labels: true, sequences: true });

  let notified = null;
  const dispose = host.store.subscribe(
    state => state.workspace.overlays,
    value => { notified = value; },
  );
  host.store.transaction('overlays', next => { next.workspace.overlays.sequences = false; });
  assert.deepEqual(notified, { labels: true, sequences: false });
  dispose();
});
