import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { mountFrameEditor } from '../js/modes/sprites/presentation/frame-editor-presenter.js';
import { mountTimeline } from '../js/modes/sprites/presentation/timeline-presenter.js';
import { initFloatSession, createFloat, activeFloating } from '../js/components/canvas/float-session.js';

const { Element } = installSpriteContextDom();
const alerts = [];
globalThis.alert = message => alerts.push(message);
const host = new EditorHost();
setEditorHost(host); host.registerMode(spriteMode); host.registerMode(animationsMode); host.start('sprites');
initFloatSession();
const timeline = new Element();
const editor = mountFrameEditor(new Element());
mountTimeline(timeline);
const red = [255, 0, 0, 255], blue = [0, 0, 255, 255];

// An auto animation of two 8x8 frames laid out side by side in one band.
async function reset() {
  alerts.length = 0;
  host.activateMode('sprites');
  const project = createProject('Timeline'); project.settings.onion.enabled = false;
  const sheet = createSheet(project, { name: 'Sheet', width: 16, height: 8, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const anim = addAnimation(sheet, 'Run');
  Object.assign(anim, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: a.id, duration: 100 }, { frameId: b.id, duration: 100 }] });
  const layer = sheetLayers(sheet)[0];
  setPixel(layer.bitmap, 9, 1, blue);
  host.setProject(project);
  host.selections.patch({ animationId: anim.id, layerId: layer.id, frameId: b.id, editingFrameId: b.id });
  host.store.updateSession({ activeViewId: 'sprites.frame', activeToolId: 'move' });
  editor.show(); await Promise.resolve();
  host.history.clear();
  return { sheet, a, b, anim, layer };
}

function removeButtons() { return timeline.querySelectorAll('.timeline-remove'); }

test('removing an auto entry settles an active float before the layout moves frames', async () => {
  const { sheet, layer } = await reset();
  createFloat({ region: { x: 8, y: 0, w: 8, h: 8 } }); activeFloating().transform.tx = 1;
  removeButtons()[0].fire('click');
  assert.equal(activeFloating(), null);
  assert.equal(sheet.frames.length, 1);
  assert.deepEqual(getPixel(layer.bitmap, 2, 1), blue, 'the settled pixels moved with frame B');
});

test('a refused layout says why', async () => {
  const { sheet, layer } = await reset();
  setPixel(layer.bitmap, 10, 1, red);
  layer.locked = true;
  removeButtons()[0].fire('click');
  assert.equal(sheet.frames.length, 2, 'nothing changed');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /Layer 1/);
});

test('removing an auto entry stops playback first', async () => {
  await reset();
  const play = timeline.querySelectorAll('button').find(b => b.textContent === '▶');
  play.fire('click');
  assert.notEqual(play.textContent, '▶', 'playing');
  removeButtons()[0].fire('click');
  assert.equal(play.textContent, '▶');
});

test('Edit in Animations opens the Animations workbench on the selected animation', async () => {
  const { anim, a } = await reset();
  host.selections.patch({ frameId: 'not-in-anim' });
  timeline.querySelectorAll('button').find(b => b.textContent === 'Edit in Animations').fire('click');
  assert.equal(host.store.getState().session.activeModeId, 'animations');
  const sel = host.selections.get();
  assert.equal(sel.animationId, anim.id); assert.equal(sel.frameId, a.id); assert.equal(sel.entryIndex, 0);
});

test('Edit in Animations keeps a selected frame that the animation uses', async () => {
  const { b } = await reset();
  host.selections.patch({ frameId: b.id });
  timeline.querySelectorAll('button').find(b => b.textContent === 'Edit in Animations').fire('click');
  const sel = host.selections.get();
  assert.equal(sel.frameId, b.id); assert.equal(sel.entryIndex, 1);
});

test('the Sprites timeline dock gets the shared dock resizer as its first child', async () => {
  await reset();
  const handle = timeline.children[0];
  assert.equal(handle.classList.contains('dock-resizer'), true);
  assert.equal(timeline.querySelectorAll('.timeline-resize-handle').length, 0, 'the old inline handle is gone');
  handle.fire('keydown', { key: 'ArrowUp', preventDefault() {} });
  assert.match(timeline.style.height, /^\d+px$/);
});
