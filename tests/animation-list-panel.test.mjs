import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { mountAnimationListPanel } from '../js/modes/animations/presentation/animation-list-panel.js';
import { mountAnimationInspectorPanel } from '../js/modes/animations/presentation/animation-inspector-panel.js';

const { Element } = installSpriteContextDom();
const alerts = [];
globalThis.alert = message => alerts.push(message);
globalThis.confirm = () => true;
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode]) host.registerMode(mode);
host.start('animations');
const panel = new Element();
document.body.append(panel); // drags cancel when their row is not in the document
mountAnimationListPanel(panel);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
// The selected animation's details are their own panel, below the list.
const inspector = new Element();
document.body.append(inspector);
mountAnimationInspectorPanel(inspector);
const button = text => [...panel.querySelectorAll('button'), ...inspector.querySelectorAll('button')].find(b => b.textContent === text);

// An 8x8 sprite. "Run": auto, two frames. "Idle": manual, two frames whose
// pivots differ.
async function reset() {
  alerts.length = 0;
  const project = createProject('Panel');
  const sheet = createSheet(project, { name: 'Sheet', width: 40, height: 16, kind: 'sprite', spriteSize: { w: 8, h: 8 } });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const c = addFrame(sheet, { name: 'C', x: 0, y: 8, w: 8, h: 8 });
  const d = addFrame(sheet, { name: 'D', x: 16, y: 8, w: 8, h: 8, pivotX: 4, pivotY: 8 });
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

test('New asks only for a name and makes an animation of the sprite size', async () => {
  const { sheet } = await reset();
  button('➕').fire('click');
  const form = panel.querySelector('.anim-new-form');
  assert.equal(form.hidden, false);
  const inputs = form.querySelectorAll('input');
  assert.equal(inputs.length, 1);
  inputs[0].value = 'Jump';
  button('Create').fire('click');
  const jump = sheet.animations.at(-1);
  assert.equal(jump.name, 'Jump'); assert.deepEqual(jump.cell, { w: 8, h: 8 });
  assert.equal(host.selections.get().animationId, jump.id);
});

test('Auto-layout of frames whose pivots differ offers to align them instead of alerting', async () => {
  const { idle } = await reset();
  host.selections.patch({ animationId: idle.id }); await tick();
  button('Auto-layout').fire('click'); await tick();
  assert.deepEqual(alerts, []);
  const form = inspector.querySelector('.anim-align-form');
  assert.equal(form.hidden, false);
  assert.match(form.querySelector('.frame-field').textContent, /8×8/);
  form.querySelectorAll('button').find(b => b.textContent === 'Apply').fire('click');
  assert.equal(idle.layout, 'auto'); assert.deepEqual(idle.cell, { w: 8, h: 8 });
});

test('Sprite size… re-frames the whole sheet with the chosen anchor, without a selected animation', async () => {
  const { sheet, run, idle } = await reset();
  button('📐').fire('click'); await tick();
  const form = panel.querySelector('.anim-size-form');
  assert.equal(form.hidden, false);
  const [w, h] = form.querySelectorAll('input');
  assert.deepEqual([w.value, h.value], ['8', '8']);
  w.value = '10'; h.value = '8';
  form.querySelector('.anchor-grid').querySelectorAll('button').find(b => b.dataset.anchor === 'w').fire('click');
  button('Apply').fire('click');
  assert.deepEqual([sheet.spriteSize, run.cell], [{ w: 10, h: 8 }, { w: 10, h: 8 }]);
  assert.ok(sheet.frames.every(f => f.w === 10 && f.h === 8));
  assert.equal(idle.layout, 'manual');
  host.history.undo(); assert.deepEqual([sheet.spriteSize, run.cell], [{ w: 8, h: 8 }, { w: 8, h: 8 }]);
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
  button('🗑').fire('click');
  assert.equal(sheet.animations.some(a => a.id === run.id), false);
});

test('Duplicate copies the selected auto animation', async () => {
  const { run, sheet } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  button('⧉').fire('click');
  assert.equal(sheet.animations.length, 3);
});

test('renaming in the details updates the animation', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  const name = inspector.querySelector('.anim-details').querySelectorAll('input')[0];
  name.value = 'Sprint'; name.fire('change');
  assert.equal(run.name, 'Sprint');
});

// Rows 36 px tall with a 2 px gap: row i spans [38i, 38i + 36).
function layoutRows() {
  const rows = panel.querySelectorAll('.anim-row');
  rows.forEach((row, i) => { row.rect = { left: 0, top: i * 38, width: 200, height: 36 }; });
  return rows;
}
const pointer = (type, props) => Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, ...props });
const down = (el, x, y) => el.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: x, clientY: y });
const move = (x, y) => window.dispatchEvent(pointer('pointermove', { clientX: x, clientY: y }));
const up = (x, y) => window.dispatchEvent(pointer('pointerup', { clientX: x, clientY: y }));
const lines = () => document.body.querySelectorAll('.dr-line');

test('dragging a row below the next one reorders animations, with an insertion line', async () => {
  const { sheet, run, idle } = await reset();
  const rows = layoutRows();
  down(rows[0].querySelector('.anim-row-name'), 20, 10);
  move(20, 70); // lower half of row 1 -> after it
  assert.equal(lines().length, 1);
  assert.equal(lines()[0].hidden, false);
  up(20, 70);
  assert.deepEqual(sheet.animations.map(a => a.id), [idle.id, run.id]);
  assert.equal(lines().length, 0, 'the line is removed after the drop');
  host.history.undo();
  assert.deepEqual(sheet.animations.map(a => a.id), [run.id, idle.id]);
});

test('dragging a row above the first one moves it to the top', async () => {
  const { sheet, run, idle } = await reset();
  const rows = layoutRows();
  down(rows[1].querySelector('.anim-row-name'), 20, 48);
  move(20, 4);
  up(20, 4);
  assert.deepEqual(sheet.animations.map(a => a.id), [idle.id, run.id]);
});

test('a drop where the row already is records nothing', async () => {
  const { sheet, run } = await reset();
  const rows = layoutRows();
  down(rows[0].querySelector('.anim-row-name'), 20, 10);
  move(20, 30); // still over its own row
  up(20, 30);
  assert.equal(sheet.animations[0].id, run.id);
  assert.equal(host.history.canUndo(), false);
});

test('the direction select sets the selected animation\'s direction', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  const select = inspector.querySelector('.anim-details').querySelector('select');
  assert.deepEqual(select.children.map(o => o.value), ['forward', 'reverse', 'pingpong', 'pingpong-reverse']);
  assert.deepEqual(select.children.map(o => o.textContent), ['Forward', 'Reverse', 'Ping-pong', 'Ping-pong reverse']);
  assert.equal(select.value, 'forward');
  select.value = 'pingpong'; select.fire('change');
  assert.equal(run.direction, 'pingpong');
  host.history.undo(); await tick();
  assert.equal(run.direction, 'forward');
  assert.equal(select.value, 'forward', 'the control follows the model');
});

test('the colour control sets and clears the animation colour', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  const details = inspector.querySelector('.anim-details');
  const color = details.querySelectorAll('input').find(i => i.type === 'color');
  const none = details.querySelectorAll('button').find(b => b.textContent === 'None');
  assert.equal(none.disabled, true, 'nothing to clear yet');
  color.value = '#ff8800'; color.fire('change');
  assert.equal(run.color, '#ff8800');
  await tick();
  assert.equal(none.disabled, false);
  none.fire('click');
  assert.equal(run.color, null);
  host.history.undo();
  assert.equal(run.color, '#ff8800');
});

test('a coloured animation borders its row thumbnail in that colour', async () => {
  const { run } = await reset();
  host.selections.patch({ animationId: run.id }); await tick();
  const thumbs = () => panel.querySelectorAll('.anim-thumb');
  assert.equal(thumbs()[0].classList.contains('has-color'), false);
  const color = inspector.querySelector('.anim-details').querySelectorAll('input').find(i => i.type === 'color');
  color.value = '#00ff00'; color.fire('change'); await tick();
  assert.equal(thumbs()[0].classList.contains('has-color'), true);
  assert.equal(thumbs()[0].style.borderColor, '#00ff00');
  assert.equal(thumbs()[1].classList.contains('has-color'), false, 'Idle has no colour');
});

test('New… is disabled without a sprite sheet', async () => {
  await reset();
  host.setProject(createProject('Empty')); await tick();
  assert.equal(button('➕').disabled, true);
  await reset();
  assert.equal(button('➕').disabled, false);
});

test('a fractional size is refused, not truncated', async () => {
  const { sheet } = await reset();
  button('📐').fire('click');
  const [w, h] = panel.querySelector('.anim-size-form').querySelectorAll('input');
  w.value = '12.9'; h.value = '10';
  button('Apply').fire('click');
  assert.deepEqual(sheet.spriteSize, { w: 8, h: 8 }, 'nothing changed');
  assert.equal(alerts.length, 1, 'the refusal says why');
});

test('one row of icon command buttons sits below the list', async () => {
  await reset();
  const kids = panel.children.map(c => c.className);
  const at = cls => kids.findIndex(k => k.split(' ').includes(cls));
  assert.ok(at('anim-list') < at('anim-toolbar'));
  assert.deepEqual(panel.querySelector('.anim-toolbar').querySelectorAll('button').map(b => [b.textContent, b.className]), [['➕', 'btn-icon-md'], ['⧉', 'btn-icon-md'], ['🗑', 'btn-icon-md'], ['📐', 'btn-icon-md']]);
  assert.match(button('📐').title, /8×8/);
  assert.equal(panel.querySelector('.anim-details'), null, 'the details are the separate Animation panel');
});

test('the Animation panel asks for a selection when none is made', async () => {
  await reset();
  host.selections.patch({ animationId: null }); await tick();
  assert.equal(inspector.querySelector('.anim-details').hidden, true);
  assert.equal(inspector.querySelector('h3').textContent, 'Animation');
});
