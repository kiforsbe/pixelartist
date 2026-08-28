import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { createBitmap } from '../js/core/pixels.js';
import { flatCanvas, clearMapRasterCache } from '../js/modes/maps/presentation/map-renderer.js';
import { verifyLayerSelectionRecovery, verifyMapRenamePanelCallback, verifyTerrainToolbarRefresh, verifyTileGestureCancellationAndCompletion } from './helpers/phase4-final-fix-fixtures.mjs';

function installCanvasDocument() {
  const previous = globalThis.document;
  globalThis.ImageData = class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const context = { imageSmoothingEnabled: true, putImageData(image) { this.image = image; } };
      return { width: 0, height: 0, getContext: () => context, context };
    },
  };
  return () => { globalThis.document = previous; };
}

function sourceProject(bitmap) {
  return {
    sheets: [{ id: 'sheet', kind: 'sprite', width: 1, height: 1, layerTree: { id: 'root', type: 'group', children: [{ id: 'layer', type: 'layer', visible: true, opacity: 1, bitmap }] }, animations: [] }],
    maps: [], palettes: [],
  };
}

test('map flatCanvas invalidates cached raster before reads after pixel and history revisions', () => {
  const restore = installCanvasDocument();
  try {
    const host = new EditorHost({}); setEditorHost(host);
    const bitmap = createBitmap(1, 1); bitmap.data.set([255, 0, 0, 255]);
    const project = sourceProject(bitmap); host.setProject(project);
    clearMapRasterCache();
    const first = flatCanvas(project.sheets[0], project);
    assert.deepEqual(Array.from(first.context.image.data), [255, 0, 0, 255]);
    bitmap.data.set([0, 0, 255, 255]); host.store.notifyPixelsChanged();
    const afterPixel = flatCanvas(project.sheets[0], project);
    assert.deepEqual(Array.from(afterPixel.context.image.data), [0, 0, 255, 255]);
    const historyPixels = [];
    const disposeHistory = host.history.subscribe(() => historyPixels.push(Array.from(flatCanvas(project.sheets[0], project).context.image.data)));
    host.history.execute({ do() { project.sheets[0].layerTree.children[0].visible = false; }, undo() { project.sheets[0].layerTree.children[0].visible = true; } });
    const afterHistory = flatCanvas(project.sheets[0], project);
    assert.deepEqual(Array.from(afterHistory.context.image.data), [0, 0, 0, 0]);
    assert.deepEqual(historyPixels, [[0, 0, 0, 0]]);
    host.history.undo(); assert.deepEqual(historyPixels.at(-1), [0, 0, 255, 255]);
    host.history.redo(); assert.deepEqual(historyPixels.at(-1), [0, 0, 0, 0]);
    disposeHistory();
  } finally { restore(); }
});

test('history snapshot revision is monotonic across execute undo and redo', () => {
  const host = new EditorHost({});
  const before = host.history.snapshot().revision;
  host.history.execute({ do() {}, undo() {} });
  const afterExecute = host.history.snapshot().revision;
  host.history.undo(); const afterUndo = host.history.snapshot().revision;
  host.history.redo(); const afterRedo = host.history.snapshot().revision;
  assert.ok(afterExecute > before);
  assert.ok(afterUndo > afterExecute);
  assert.ok(afterRedo > afterUndo);
});

test('layers panel repairs authoritative selection after delete and Add undo', () => {
  verifyLayerSelectionRecovery();
});

test('layers panel sends map rename input through the registered map command', () => {
  verifyMapRenamePanelCallback();
});

test('autotiles panel refreshes its toolbar for prepared terrain Start and Done', () => {
  verifyTerrainToolbarRefresh();
});

test('tile router cancels a deleted tile gesture before pointer release', () => {
  verifyTileGestureCancellationAndCompletion();
});
