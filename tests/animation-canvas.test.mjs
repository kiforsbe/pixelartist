import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { mapMode } from '../js/modes/maps/index.js';
import { createProject, createSheet, createMap, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { mountAnimationCanvas } from '../js/modes/animations/presentation/animation-canvas-presenter.js';
import { initFloatSession, createFloat, activeFloating, hasSelection } from '../js/components/canvas/float-session.js';
import { setPlayingFrame, registerPlaybackStop } from '../js/modes/animations/presentation/timeline-playback.js';

const { Element } = installSpriteContextDom();
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode, mapMode]) host.registerMode(mode);
host.start('sprites');
initFloatSession();
const surface = new Element();
const canvas = mountAnimationCanvas(surface);
const blue = [0, 0, 255, 255];

// An auto animation "Run" of two 8x8 frames, A at (0,0) and B at (8,0).
async function reset() {
  setPlayingFrame(null);
  host.activateMode('sprites');
  const project = createProject('Anim'); project.settings.onion.enabled = false;
  const sheet = createSheet(project, { name: 'Sheet', width: 16, height: 8, kind: 'sprite' });
  createMap(project, { name: 'Map' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const anim = addAnimation(sheet, 'Run');
  Object.assign(anim, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: a.id, duration: null }, { frameId: b.id, duration: null }] });
  const layer = sheetLayers(sheet)[0];
  setPixel(layer.bitmap, 9, 1, blue);
  host.setProject(project);
  host.selections.patch({ animationId: anim.id, layerId: layer.id, frameId: a.id });
  host.activateMode('animations');
  host.store.updateSession({ activeToolId: 'move' });
  canvas.show(); await Promise.resolve();
  host.history.clear();
  return { sheet, a, b, anim, layer };
}

test('the canvas shows the selected frame at its own size', async () => {
  const { b } = await reset();
  assert.equal(canvas.view.width, 8);
  host.selections.patch({ frameId: b.id });
  assert.equal(surface.querySelector('.frame-editor-name').textContent, 'Run · B');
  assert.equal(surface.querySelector('.anim-canvas-empty').hidden, true);
});

test('with no frame the canvas shows the empty hint', async () => {
  await reset();
  host.selections.patch({ frameId: null });
  assert.equal(surface.querySelector('.anim-canvas-empty').hidden, false);
});

test('a float made on the animations canvas settles when the column changes', async () => {
  const { a, b, layer } = await reset();
  host.selections.patch({ frameId: b.id });
  assert.equal(createFloat({ region: { x: 8, y: 0, w: 8, h: 8 } }), true);
  activeFloating().transform.tx = 1;
  host.selections.patch({ frameId: a.id });
  assert.equal(activeFloating(), null);
  assert.deepEqual(getPixel(layer.bitmap, 10, 1), blue);
});

test('switching to Sprite Sheets settles a float made on the animations canvas', async () => {
  const { b, layer } = await reset();
  host.selections.patch({ frameId: b.id });
  assert.equal(createFloat({ region: { x: 8, y: 0, w: 8, h: 8 } }), true);
  activeFloating().transform.tx = 1;
  host.activateMode('sprites');
  assert.equal(activeFloating(), null);
  assert.deepEqual(getPixel(layer.bitmap, 10, 1), blue);
});

test('maps mode paste does not reach the animations canvas', async () => {
  await reset();
  host.activateMode('maps');
  assert.equal(createFloat({ region: { x: 0, y: 0, w: 1, h: 1 } }), false);
});

test('dropping the pivot on an auto frame sets the shared pivot in one step', async () => {
  const { a, b } = await reset();
  surface.querySelector('.anim-pivot-toggle').fire('click');
  const layerEl = surface.querySelector('.anim-pivot-layer');
  assert.equal(layerEl.hidden, false);
  const at = canvas.view.imageToScreen(a.x + 2, a.y + 6);
  layerEl.fire('pointerdown', { clientX: at.x, clientY: at.y, pointerId: 1, button: 0 });
  layerEl.fire('pointerup', { clientX: at.x, clientY: at.y, pointerId: 1, button: 0 });
  for (const f of [a, b]) assert.deepEqual([f.pivotX, f.pivotY], [2, 6]);
  host.history.undo();
  assert.deepEqual([a.pivotX, a.pivotY], [0, 0]);
});

test('Show on sheet opens Sprite Sheets on the same frame', async () => {
  const { b } = await reset();
  host.selections.patch({ frameId: b.id });
  surface.querySelectorAll('button').find(button => button.textContent === 'Show on sheet').fire('click');
  assert.equal(host.store.getState().session.activeModeId, 'sprites');
  assert.equal(host.selections.get().frameId, b.id);
});

test('a marquee on the animations canvas belongs to its column', async () => {
  const { a, b } = await reset();
  host.store.updateSession({ activeToolId: 'select' });
  const el = canvas.view.canvas;
  const at = (x, y) => { const p = canvas.view.imageToScreen(a.x + x, a.y + y); return { clientX: p.x, clientY: p.y, pointerId: 1, button: 0, buttons: 1 }; };
  el.fire('pointerdown', at(1, 1)); el.fire('pointermove', at(4, 4)); el.fire('pointerup', at(4, 4));
  assert.equal(hasSelection(), true);
  host.selections.patch({ frameId: b.id });
  assert.equal(hasSelection(), false);
});

test('a selected frame in no column of the selected animation leaves the canvas empty', async () => {
  const { sheet } = await reset();
  const stray = addFrame(sheet, { name: 'Stray', x: 0, y: 0, w: 4, h: 4 });
  host.selections.patch({ frameId: stray.id });
  assert.equal(surface.querySelector('.anim-canvas-empty').hidden, false);
  assert.equal(surface.querySelector('.frame-editor-name').textContent, '');
});

test('without a sprite sheet the empty hint says so', async () => {
  await reset();
  const project = createProject('NoSheets');
  createMap(project, { name: 'Map' });
  host.setProject(project);
  host.activateMode('animations');
  canvas.show(); await Promise.resolve();
  const empty = surface.querySelector('.anim-canvas-empty');
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /no sprite sheet/i);
});

const pivotButton = () => surface.querySelectorAll('button').find(b => b.textContent === 'Pivot');
const keyEvent = (type, code) => { const e = new Event(type); Object.defineProperties(e, { code: { value: code }, key: { value: ' ' } }); return e; };

test('the wheel still zooms while Pivot is on', async () => {
  await reset();
  pivotButton().fire('click');
  const before = canvas.view.zoom;
  surface.querySelector('.anim-pivot-layer').fire('wheel', { deltaY: -100, clientX: 4, clientY: 4 });
  assert.ok(canvas.view.zoom > before);
  pivotButton().fire('click');
});

test('holding Space lets pointer input through the pivot overlay, for panning', async () => {
  await reset();
  pivotButton().fire('click');
  const layer = surface.querySelector('.anim-pivot-layer');
  window.dispatchEvent(keyEvent('keydown', 'Space'));
  assert.equal(layer.style.pointerEvents, 'none');
  window.dispatchEvent(keyEvent('keyup', 'Space'));
  assert.equal(layer.style.pointerEvents, '');
  pivotButton().fire('click');
});

// ---- timeline playback in the main view ----

const nameShown = () => surface.querySelector('.frame-editor-name').textContent;

test('while the timeline plays, the canvas shows the playing frame and keeps its zoom', async () => {
  const { b } = await reset();
  canvas.view.zoom = 7;
  setPlayingFrame(b.id);
  assert.equal(nameShown(), 'Run · B');
  assert.equal(canvas.view.zoom, 7, 'a same-size frame does not re-fit the view');
  setPlayingFrame(null);
  assert.equal(nameShown(), 'Run · A', 'stopping shows the selected column again');
  assert.equal(canvas.view.zoom, 7);
});

test('a press on the canvas while the timeline plays stops playback first', async () => {
  const { b } = await reset();
  let stops = 0;
  const dispose = registerPlaybackStop(() => { stops++; setPlayingFrame(null); });
  surface.querySelector('.frame-editor-canvas').fire('pointerdown', { button: 0 });
  assert.equal(stops, 0, 'nothing to stop');
  setPlayingFrame(b.id);
  surface.querySelector('.frame-editor-canvas').fire('pointerdown', { button: 0 });
  assert.equal(stops, 1);
  dispose();
});
