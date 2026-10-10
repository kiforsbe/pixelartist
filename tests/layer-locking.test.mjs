import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, addLayer, sheetLayers } from '../js/core/model.js';
import { activeLayer, activeEditableLayer, activeLayerScope, currentContextLayers } from '../js/host/document-helpers.js';
import { toggleLayerLocked, mergeLayerDownCmd } from '../js/modes/sprites/application/commands/layer-commands.js';
import { registerFloatView, copySelection, cutSelection, pasteClipboard, commitFloatIfAny } from '../js/components/canvas/float-session.js';
import { setPixel, getPixel } from '../js/core/pixels.js';

test('toggleLayerLocked locks and unlocks a layer as one undo step each', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
  const layer = sheetLayers(sheet)[0];
  toggleLayerLocked(services, sheet.id, layer.id);
  assert.equal(layer.locked, true);
  services.history.undo();
  assert.equal(layer.locked, false);
  services.history.redo();
  assert.equal(layer.locked, true);
});

// runtime.js accepts one EditorHost per process; every host-backed test shares it.
const host = new EditorHost();
setEditorHost(host);
host.registerMode(spriteMode);

test('locked layers are not editable and are skipped by all-layer captures', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const top = addLayer(sheet, 'top');
  const base = sheetLayers(sheet)[0];
  host.setProject(project);
  host.store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  host.selections.patch({ layerId: top.id });
  assert.equal(activeEditableLayer(), top);
  top.locked = true;
  assert.equal(activeLayer(), top, 'a locked layer can still be selected');
  assert.equal(activeEditableLayer(), null, 'painting, filling, filters and floats get no target');
  assert.deepEqual(activeLayerScope(), [base], 'all-layer moves and filters skip it');
  assert.deepEqual(currentContextLayers(), [base, top], 'it still renders');
});

test('the sprites mode registers sprites.toggleLayerLocked', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode);
  assert.ok(host.registries.commands.get('sprites.toggleLayerLocked'));
});

test('merge down refuses to write into a locked layer below', () => {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const top = addLayer(sheet, 'top');
  const base = sheetLayers(sheet)[0];
  base.locked = true;
  setPixel(top.bitmap, 1, 1, [255, 0, 0, 255]);
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
  assert.equal(mergeLayerDownCmd(services, sheet.id, top.id), null);
  assert.deepEqual(sheetLayers(sheet), [base, top]);
  assert.deepEqual(getPixel(base.bitmap, 1, 1), [0, 0, 0, 0]);
  assert.equal(services.history.canUndo(), false);
});

function clipboardSheet() {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const top = addLayer(sheet, 'top');
  const base = sheetLayers(sheet)[0];
  host.setProject(project);
  host.store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id }, activeViewId: 'sprites.sheet' }, 'view');
  registerFloatView('sheet', {
    getSelection: () => ({ x: 0, y: 0, w: 4, h: 4 }),
    setSelection: () => {},
    getTargetRect: () => ({ x: 0, y: 0, w: 8, h: 8 }),
  });
  return { host, top, base };
}

test('an all-layers paste never writes into a layer locked after the copy', () => {
  const { host, top, base } = clipboardSheet();
  const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];
  setPixel(top.bitmap, 1, 1, red); setPixel(base.bitmap, 2, 2, red);
  host.selections.patch({ layerId: top.id });
  copySelection(true);
  setPixel(top.bitmap, 1, 1, blue);
  top.locked = true;
  pasteClipboard();
  commitFloatIfAny();
  assert.deepEqual(getPixel(top.bitmap, 1, 1), blue);
});

test('copy reads a locked layer; cut leaves it untouched', () => {
  const { host, top, base } = clipboardSheet();
  const green = [0, 255, 0, 255];
  setPixel(base.bitmap, 1, 1, green);
  base.locked = true;
  host.selections.patch({ layerId: base.id });
  cutSelection(false);
  assert.deepEqual(getPixel(base.bitmap, 1, 1), green, 'cut cannot clear a locked layer');
  copySelection(false);
  host.selections.patch({ layerId: top.id });
  pasteClipboard();
  commitFloatIfAny();
  assert.deepEqual(getPixel(top.bitmap, 1, 1), green, 'the copy captured the locked layer');
});
