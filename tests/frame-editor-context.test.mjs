import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, addFrame, addAnimation, createLayerNode, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { mountFrameEditor } from '../js/modes/sprites/presentation/frame-editor-presenter.js';
import { mountTimeline } from '../js/modes/sprites/presentation/timeline-presenter.js';
import { initFloatSession, createFloat, activeFloating } from '../js/components/canvas/float-session.js';

const { Element } = installSpriteContextDom();
const host = new EditorHost(); setEditorHost(host); host.registerMode(spriteMode); host.start('sprites');
initFloatSession();
const surface = new Element(), timeline = new Element();
const editor = mountFrameEditor(surface); mountTimeline(timeline);
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];

async function reset() {
  host.history.clear();
  const project = createProject('Frames'); project.settings.onion.enabled = false;
  const sheet = createSheet(project, { name: 'Sheet', width: 16, height: 8, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 4, h: 4 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const first = addAnimation(sheet, 'First'), second = addAnimation(sheet, 'Second');
  for (const anim of [first, second]) anim.frames = [{ frameId: a.id, duration: 100 }, { frameId: b.id, duration: 100 }];
  const layer = sheetLayers(sheet)[0];
  const other = createLayerNode('Other', sheet.width, sheet.height);
  sheet.layerTree.children.push(other);
  setPixel(layer.bitmap, 0, 0, red); setPixel(layer.bitmap, 8, 0, blue);
  host.setProject(project);
  host.selections.patch({ animationId: first.id, layerId: layer.id, frameId: a.id, editingFrameId: a.id });
  host.store.updateSession({ activeViewId: 'sprites.frame', activeToolId: 'move' });
  editor.show(); await Promise.resolve();
  return { sheet, a, b, layer, other, second };
}

test('timeline click refreshes dimensions and toolbar in the already-open frame editor', async () => {
  await reset();
  assert.equal(editor.view.width, 4);
  timeline.querySelectorAll('.timeline-cell')[1].fire('click');
  assert.equal(host.store.getState().session.activeViewId, 'sprites.frame');
  assert.equal(editor.view.width, 8); assert.equal(editor.view.height, 8);
  assert.equal(surface.querySelector('.frame-editor-name').textContent, 'B');
});

test('same-view frame change settles a moved float inside its original frame', async () => {
  const { layer } = await reset();
  assert.equal(createFloat({ region: { x: 0, y: 0, w: 1, h: 1 } }), true);
  activeFloating().transform.tx = 1;
  timeline.querySelectorAll('.timeline-cell')[1].fire('click');
  assert.equal(activeFloating(), null);
  assert.deepEqual(getPixel(layer.bitmap, 1, 0), red);
  assert.deepEqual(getPixel(layer.bitmap, 8, 0), blue);
});

test('same-frame animation/layer change invalidates raster context without resetting pan', async () => {
  const { second, other } = await reset();
  function paintedPixel() {
    const context = editor.view.canvas.getContext('2d');
    editor.view.onPaint(context);
    return [...context.drawImages.at(-1)[0].getContext('2d').imageData.data.slice(0, 4)];
  }
  assert.deepEqual(paintedPixel(), red);
  editor.view.panX = 23;
  setPixel(other.bitmap, 0, 0, blue); // a silent edit only a fresh raster shows
  host.selections.patch({ animationId: second.id, layerId: other.id });
  assert.deepEqual(paintedPixel(), blue);
  assert.equal(editor.view.panX, 23);
});

test('same-frame animation/layer change settles the old layer float before further editing', async () => {
  const { layer, other, second } = await reset();
  createFloat({ region: { x: 0, y: 0, w: 1, h: 1 } }); activeFloating().transform.tx = 1;
  host.selections.patch({ animationId: second.id, layerId: other.id });
  assert.equal(activeFloating(), null);
  assert.deepEqual(getPixel(layer.bitmap, 1, 0), red);
  assert.deepEqual(getPixel(other.bitmap, 0, 0), [0, 0, 0, 0]);
});
