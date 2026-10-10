import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, addFrame } from '../js/core/model.js';
import { createFrameCanvas } from '../js/components/canvas/frame-canvas.js';
import { buildOnionControls } from '../js/components/canvas/onion-controls.js';

const { Element } = installSpriteContextDom();
const host = new EditorHost(); setEditorHost(host); host.registerMode(spriteMode); host.start('sprites');
let frame = null, changes = 0;
const canvas = createFrameCanvas(new Element(), {
  viewKind: 'frame', getFrame: () => frame, getOnionAnimation: () => null, onStateChange: () => { changes++; },
});

function reset() {
  const project = createProject('Canvas'); project.settings.onion.enabled = false;
  const sheet = createSheet(project, { name: 'Sheet', width: 16, height: 8, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 4, h: 4 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  host.setProject(project);
  frame = a; changes = 0;
  return { project, sheet, a, b };
}

test('sync sizes the view to the frame and maps overlays from sheet space', () => {
  const { b } = reset();
  frame = b; canvas.shown();
  assert.equal(canvas.view.width, 8);
  assert.deepEqual(canvas.view.imageToScreen(b.x, b.y), { x: canvas.view.panX, y: canvas.view.panY });
});

test('sync keeps pan and zoom while the frame stays the same', () => {
  const { a } = reset();
  frame = a; canvas.shown();
  canvas.view.panX += 13;
  const pan = canvas.view.panX;
  canvas.sync();
  assert.equal(canvas.view.panX, pan);
});

test('history changes reach onStateChange only while visible', () => {
  reset(); canvas.shown();
  host.history.execute({ do() {}, undo() {} });
  assert.equal(changes, 1);
  canvas.hidden();
  host.history.execute({ do() {}, undo() {} });
  assert.equal(changes, 1);
});

test('sync with no frame returns null', () => {
  reset(); frame = null;
  assert.equal(canvas.sync(), null);
});

test('onion controls read and write the project onion settings', () => {
  const { project } = reset();
  let repaints = 0;
  const controls = buildOnionControls({ onChange: () => { repaints++; } });
  controls.sync();
  const [enable] = controls.element.querySelectorAll('input');
  assert.equal(enable.checked, false);
  enable.checked = true; enable.fire('change');
  assert.equal(project.settings.onion.enabled, true);
  assert.ok(repaints > 0);
});
