import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { mountAnimationListPanel } from '../js/modes/animations/presentation/animation-list-panel.js';

const { Element } = installSpriteContextDom();
const alerts = [];
globalThis.alert = message => alerts.push(message);
globalThis.confirm = () => true;
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode]) host.registerMode(mode);
host.start('animations');
const panel = new Element();
mountAnimationListPanel(panel);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const button = text => panel.querySelectorAll('button').find(b => b.textContent === text);

// "Run": auto, two 8x8 frames. "Idle": manual, a 4x4 and an 8x8 frame.
async function reset() {
  alerts.length = 0;
  const project = createProject('Panel');
  const sheet = createSheet(project, { name: 'Sheet', width: 32, height: 16, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const c = addFrame(sheet, { name: 'C', x: 0, y: 8, w: 4, h: 4 });
  const d = addFrame(sheet, { name: 'D', x: 8, y: 8, w: 8, h: 8 });
  const run = addAnimation(sheet, 'Run');
  Object.assign(run, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: a.id, duration: null }, { frameId: b.id, duration: null }] });
  const idle = addAnimation(sheet, 'Idle');
  idle.frames = [{ frameId: c.id, duration: null }, { frameId: d.id, duration: null }];
  host.setProject(project);
  host.activateMode('sprites'); host.activateMode('animations');
  host.history.clear();
  await tick();
  return { project, sheet, run, idle };
}

test('rows list every animation with its layout badge', async () => {
  await reset();
  assert.deepEqual(panel.querySelectorAll('.anim-row').map(r => r.querySelector('.anim-badge').textContent), ['auto', 'manual']);
});

test('clicking a row selects the animation and its first frame', async () => {
  const { idle } = await reset();
  panel.querySelectorAll('.anim-row')[1].fire('click');
  const sel = host.selections.get();
  assert.equal(sel.animationId, idle.id);
  assert.equal(sel.frameId, idle.frames[0].frameId);
  assert.equal(sel.entryIndex, 0);
});

test('New creates an auto animation of the entered size', async () => {
  const { sheet } = await reset();
  button('New…').fire('click');
  const form = panel.querySelector('.anim-new-form');
  assert.equal(form.hidden, false);
  const [name, w, h] = form.querySelectorAll('input');
  assert.deepEqual([w.value, h.value], ['16', '16'], 'defaults to the project frame size');
  name.value = 'Jump'; w.value = '12'; h.value = '10';
  button('Create').fire('click');
  const jump = sheet.animations.at(-1);
  assert.equal(jump.name, 'Jump'); assert.deepEqual(jump.cell, { w: 12, h: 10 });
  assert.equal(host.selections.get().animationId, jump.id);
});

test('Auto-layout of mixed sizes asks for a canvas size instead of alerting', async () => {
  const { idle } = await reset();
  host.selections.patch({ animationId: idle.id }); await tick();
  button('Auto-layout').fire('click'); await tick();
  assert.deepEqual(alerts, []);
  const form = panel.querySelector('.anim-size-form');
  assert.equal(form.hidden, false);
  const [w, h] = form.querySelectorAll('input');
  assert.deepEqual([w.value, h.value], ['8', '8']);
  button('Apply').fire('click');
  assert.equal(idle.layout, 'auto'); assert.deepEqual(idle.cell, { w: 8, h: 8 });
});

test('Canvas size applies with the chosen anchor', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  button('Canvas size…').fire('click'); await tick();
  const form = panel.querySelector('.anim-size-form');
  const [w, h] = form.querySelectorAll('input'); w.value = '10'; h.value = '8';
  form.querySelector('.anchor-grid').querySelectorAll('button').find(b => b.dataset.anchor === 'w').fire('click');
  button('Apply').fire('click');
  assert.deepEqual(run.cell, { w: 10, h: 8 });
  host.history.undo(); assert.deepEqual(run.cell, { w: 8, h: 8 });
});

test('Make manual turns an auto animation manual', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  button('Make manual').fire('click');
  assert.equal(run.layout, 'manual');
});

test('Delete removes the selected animation', async () => {
  const { run, sheet } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  button('Delete').fire('click');
  assert.equal(sheet.animations.some(a => a.id === run.id), false);
});

test('Duplicate copies the selected auto animation', async () => {
  const { run, sheet } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  button('Duplicate').fire('click');
  assert.equal(sheet.animations.length, 3);
});

test('renaming in the details updates the animation', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  const name = panel.querySelector('.anim-details').querySelectorAll('input')[0];
  name.value = 'Sprint'; name.fire('change');
  assert.equal(run.name, 'Sprint');
});

test('dropping a row reorders animations', async () => {
  const { sheet, idle } = await reset();
  const rows = panel.querySelectorAll('.anim-row');
  const data = new Map();
  const dataTransfer = { setData: (k, v) => data.set(k, v), getData: k => data.get(k), effectAllowed: '', dropEffect: '' };
  rows[1].fire('dragstart', { dataTransfer });
  rows[0].fire('drop', { dataTransfer });
  assert.equal(sheet.animations[0].id, idle.id);
});

test('New… is disabled without a sprite sheet', async () => {
  await reset();
  host.setProject(createProject('Empty')); await tick();
  assert.equal(button('New…').disabled, true);
  await reset();
  assert.equal(button('New…').disabled, false);
});

test('a fractional size is refused, not truncated', async () => {
  const { sheet } = await reset();
  button('New…').fire('click');
  const [, w, h] = panel.querySelector('.anim-new-form').querySelectorAll('input');
  w.value = '12.9'; h.value = '10';
  button('Create').fire('click');
  assert.equal(sheet.animations.length, 2, 'nothing created');
  assert.equal(alerts.length, 1, 'the refusal says why');
});

test('external text dropped on a row does not reorder', async () => {
  const { sheet, run } = await reset();
  const rows = panel.querySelectorAll('.anim-row');
  const dataTransfer = { types: ['text/plain'], getData: k => (k === 'text/plain' ? '1' : ''), dropEffect: '' };
  let accepted = false;
  rows[0].fire('dragover', { dataTransfer, preventDefault() { accepted = true; } });
  rows[0].fire('drop', { dataTransfer });
  assert.equal(accepted, false, 'not a drop target for outside text');
  assert.equal(sheet.animations[0].id, run.id);
});
