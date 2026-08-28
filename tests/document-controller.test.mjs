import test from 'node:test';
import assert from 'node:assert/strict';
import { mountDocumentFixture, Element } from './helpers/document-controller-fixture.mjs';
import { addFrame, addLayer } from '../js/core/model.js';
import { createTileGrid } from '../js/core/tilegrids.js';

const { host, reset, keydown, elements, runAction } = await mountDocumentFixture();

function selectContent(document) {
  if ('snap' in document) {
    const sheet = host.projects.project.sheets.find(sheet => sheet.kind === 'tile');
    const { tiles } = createTileGrid(sheet, { x: 0, y: 0, cellW: 2, cellH: 2, cols: 1, rows: 1 });
    const item = { id: 'selected-placement', sheetId: sheet.id, tileId: tiles[0].id, x: 0, y: 0 };
    document.layers[0].tiles.push(item);
    host.selections.patch({ itemId: item.id });
  } else {
    const layer = addLayer(document, 'Selected layer');
    if (document.kind === 'sprite') {
      const frame = addFrame(document, { name: 'Selected frame', x: 0, y: 0, w: 2, h: 2 });
      host.selections.patch({ layerId: layer.id, frameId: frame.id, frameIds: [frame.id] });
    } else {
      const { tiles } = createTileGrid(document, { x: 0, y: 0, cellW: 2, cellH: 2, cols: 1, rows: 1 });
      host.selections.patch({ layerId: layer.id, tileId: tiles[0].id });
    }
  }
  return { ...host.selections.get() };
}

for (const input of ['input', 'textarea', 'contenteditable', 'dialog', 'activeElement', 'openDialog', 'prevented']) {
  test(`history shortcuts leave ${input} editing alone`, () => {
    reset();
    let value = 0;
    host.history.execute({ do() { value = 1; }, undo() { value = 0; } });
    const target = new Element(input === 'input' ? 'INPUT' : input === 'textarea' ? 'TEXTAREA' : 'DIV');
    if (input === 'contenteditable') target.isContentEditable = true;
    if (input === 'dialog') target.dialog = new Element('DIALOG');
    if (input === 'activeElement') document.activeElement = new Element('INPUT');
    if (input === 'openDialog') elements.get('dlg-newsheet').showModal();
    const prevented = input === 'prevented';
    const undo = keydown({ target, defaultPrevented: prevented });
    assert.equal(value, 1, 'project history must not consume text undo');
    assert.equal(undo.defaultPrevented, prevented, 'native behavior remains available');
    host.history.undo();
    for (const patch of [{ key: 'y' }, { key: 'z', shiftKey: true, ctrlKey: false, metaKey: true }]) {
      const redo = keydown({ ...patch, target, defaultPrevented: prevented });
      assert.equal(value, 0, 'project history must not consume text redo');
      assert.equal(redo.defaultPrevented, prevented);
    }
  });
}

test('history shortcuts still undo and redo from a canvas with control or command', () => {
  reset(); let value = 0;
  host.history.execute({ do() { value = 1; }, undo() { value = 0; } });
  assert.equal(keydown().defaultPrevented, true); assert.equal(value, 0);
  keydown({ key: 'y' }); assert.equal(value, 1);
  keydown({ ctrlKey: false, metaKey: true }); assert.equal(value, 0);
  keydown({ ctrlKey: false, metaKey: true, shiftKey: true }); assert.equal(value, 1);
});

for (const [mode, kind] of [['sprites', 'sprite-sheet'], ['tiles', 'tile-sheet'], ['maps', 'map']]) {
  test(`${mode} round trips preserve remembered document and its selection`, () => {
    const project = reset(); host.activateMode(mode);
    const docs = kind === 'map' ? project.maps : project.sheets.filter(sheet => sheet.kind === (mode === 'sprites' ? 'sprite' : 'tile'));
    const reference = { kind, id: docs[1].id };
    host.documents.setActive(reference);
    const selection = selectContent(docs[1]);
    host.activateMode(mode === 'sprites' ? 'tiles' : 'sprites'); host.activateMode(mode);
    assert.deepEqual(host.store.getState().session.activeDocument, reference);
    assert.deepEqual(host.selections.get(), selection);
    assert.equal(elements.get('sheet-select').value, reference.id);
  });

  test(`${mode} creation restores document and full selection through undo/redo`, () => {
    const project = reset(); host.activateMode(mode);
    const previous = { ...host.store.getState().session.activeDocument };
    const selected = host.documents.provider(kind).get(project, previous.id);
    const selection = selectContent(selected);
    const collection = kind === 'map' ? project.maps : project.sheets;
    const before = collection.slice();
    runAction('document.newSheet');
    if (mode !== 'maps') { elements.get('ns-w').value = '4'; elements.get('ns-h').value = '4'; elements.get('ns-create').emit('click'); }
    const added = collection.at(-1);
    assert.equal(collection.length, before.length + 1);
    assert.equal(host.history.canUndo(), true);
    assert.equal(host.projects.dirty, true);
    assert.equal(host.store.getState().session.activeDocument.id, added.id);
    const addedSelection = { ...host.selections.get() };
    for (let cycle = 0; cycle < 2; cycle++) {
      host.history.undo();
      assert.deepEqual(collection, before);
      assert.deepEqual(host.store.getState().session.activeDocument, previous);
      assert.deepEqual(host.selections.get(), selection);
      host.history.redo();
      assert.equal(collection.at(-1), added);
      assert.equal(host.store.getState().session.activeDocument.id, added.id);
      assert.deepEqual(host.selections.get(), addedSelection);
    }
  });

  test(`${mode} creation undo from another mode preserves that mode's active document`, () => {
    reset(); host.activateMode(mode);
    const previous = { ...host.store.getState().session.activeDocument };
    runAction('document.newSheet');
    if (mode !== 'maps') { elements.get('ns-w').value = '4'; elements.get('ns-h').value = '4'; elements.get('ns-create').emit('click'); }
    const added = { ...host.store.getState().session.activeDocument };
    host.activateMode(mode === 'sprites' ? 'tiles' : 'sprites');
    const other = { ...host.store.getState().session.activeDocument };
    host.history.undo();
    assert.deepEqual(host.store.getState().session.activeDocument, other);
    assert.deepEqual(host.store.getState().session.activeDocumentByMode[mode], previous);
    host.history.redo();
    assert.deepEqual(host.store.getState().session.activeDocument, other);
    host.activateMode(mode);
    assert.deepEqual(host.store.getState().session.activeDocument, added);
  });
}

test('creating the first map can be undone back to an empty document list', () => {
  const project = reset(); project.maps.length = 0; host.activateMode('maps');
  runAction('document.newSheet'); const map = project.maps[0];
  host.history.undo();
  assert.equal(project.maps.length, 0);
  assert.equal(host.store.getState().session.activeDocument, null);
  host.history.redo(); assert.equal(project.maps[0], map);
});

test('mode activation falls back when its remembered document was removed', () => {
  const project = reset(); const removed = project.sheets[1];
  host.documents.setActive({ kind: 'sprite-sheet', id: removed.id });
  host.activateMode('tiles'); project.sheets.splice(project.sheets.indexOf(removed), 1);
  host.activateMode('sprites');
  assert.equal(host.store.getState().session.activeDocument.id, project.sheets[0].id);
});
