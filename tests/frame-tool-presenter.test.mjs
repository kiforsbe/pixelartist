// tests/frame-tool-presenter.test.mjs
// The Sprite Sheets frame tool on a sheet with one sprite size: a plain
// click on empty sheet only deselects; a frame is made by pressing and
// dragging (the sprite-size outline follows the pointer) and Escape cancels
// that drag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { bindFrameTool } from '../js/modes/sprites/presentation/frame-tool-presenter.js';

installSpriteContextDom();
globalThis.alert = () => {};
const host = new EditorHost();
setEditorHost(host);
host.registerMode(spriteMode);
host.start('sprites');

const view = {
  onPointer() {}, onOverlay() {}, requestRender() {},
  imageToScreen: (x, y) => ({ x, y }),
};
bindFrameTool(view);

// A 64x64 sheet of 16x16 sprites with one auto (pinned) frame at 0,0.
function reset() {
  const project = createProject('T');
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite', spriteSize: { w: 16, h: 16 } });
  const pinned = addFrame(sheet, { name: 'p', x: 0, y: 0, w: 16, h: 16 });
  Object.assign(addAnimation(sheet, 'run'), { layout: 'auto', cell: { w: 16, h: 16 }, frames: [{ frameId: pinned.id, duration: null }] });
  host.setProject(project);
  host.activateMode('sprites');
  host.store.updateSession({ activeToolId: 'frametool' }, 'tool');
  return { sheet, pinned };
}
const at = (type, x, y) => view.onPointer({ type, x, y, sx: x, sy: y, buttons: type === 'up' ? 0 : 1 });
const click = (x, y) => { at('down', x, y); at('up', x, y); };

test('a click on empty sheet deselects and makes no frame', () => {
  const { sheet, pinned } = reset();
  click(5, 5); // select the pinned frame
  click(40, 40);
  assert.equal(sheet.frames.length, 1);
  assert.equal(host.selections.get({ kind: 'sprite-sheet', id: sheet.id })?.frameId ?? null, null);
  assert.ok(pinned);
});

test('pressing and dragging on empty sheet makes one sprite-size frame where it is released', () => {
  const { sheet } = reset();
  at('down', 30, 30); at('move', 36, 36); at('up', 40, 40);
  assert.equal(sheet.frames.length, 2);
  const made = sheet.frames[1];
  assert.deepEqual([made.x, made.y, made.w, made.h], [32, 32, 16, 16]);
});

test('trying to drag a pinned frame leaves no mode behind: later clicks make no frames', () => {
  const { sheet } = reset();
  at('down', 5, 5); at('move', 30, 30); at('move', 45, 45); at('up', 45, 45);
  click(40, 40);
  click(50, 20);
  assert.equal(sheet.frames.length, 1);
});

test('Escape cancels a frame drag in progress', () => {
  const { sheet } = reset();
  at('down', 30, 30); at('move', 36, 36);
  window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  at('up', 40, 40);
  assert.equal(sheet.frames.length, 1);
});
