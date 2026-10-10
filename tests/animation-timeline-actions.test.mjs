// The Animations timeline's actions (animations.timeline.*), their keyboard
// shortcuts and context menus (spec 2026-10-10 §5), driven through the real
// presenter, action registry and commands on the fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { getAction, runAction } from '../js/features/shell/actions.js';
import { mountAnimationTimeline } from '../js/modes/animations/presentation/animation-timeline-presenter.js';
import { timelineShortcut, shortcutBlocked } from '../js/modes/animations/presentation/timeline-actions.js';
import { initFloatSession, registerFloatView } from '../js/components/canvas/float-session.js';
import { cancelNameClick } from '../js/components/panels/layer-tree.js';

const { Element } = installSpriteContextDom();
globalThis.alert = () => {};
let confirmAnswer = true;
globalThis.confirm = () => confirmAnswer;
globalThis.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', borderLeftWidth: '0', borderRightWidth: '0' });
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode]) host.registerMode(mode);
host.start('animations');
initFloatSession();
registerFloatView('canvas', { getSelection: () => null, setSelection() {}, getTargetRect: () => ({ x: 0, y: 0, w: 24, h: 16 }) });
const dock = new Element();
document.body.append(dock);
mountAnimationTimeline(dock);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const byTitle = title => dock.querySelectorAll('button').find(b => b.title === title);
const nums = () => dock.querySelectorAll('.anim-tl-num');
const grid = () => dock.querySelector('.anim-tl-grid');
const enabled = id => getAction(id).isEnabled();
const T = name => `animations.timeline.${name}`;

// Auto "Run" (A, B, D) then auto "Jump" (C), all 8x8, A with a red pixel.
async function reset() {
  cancelNameClick();
  document.activeElement = null;
  const project = createProject('Timeline');
  const sheet = createSheet(project, { name: 'Sheet', width: 24, height: 16, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const d = addFrame(sheet, { name: 'D', x: 16, y: 0, w: 8, h: 8 });
  const c = addFrame(sheet, { name: 'C', x: 0, y: 8, w: 8, h: 8 });
  const run = addAnimation(sheet, 'Run');
  Object.assign(run, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [a, b, d].map(f => ({ frameId: f.id, duration: null })) });
  const jump = addAnimation(sheet, 'Jump');
  Object.assign(jump, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: c.id, duration: null }] });
  const layer = sheetLayers(sheet)[0];
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]);
  host.setProject(project);
  if (host.store.getState().session.activeModeId !== 'animations') host.activateMode('animations');
  host.selections.patch({ animationId: run.id, frameId: a.id, entryIndex: 0, layerId: layer.id });
  host.history.clear();
  await tick();
  return { sheet, run, jump, a, b, c, d, layer };
}
// Selects Run's entries [from..to] with a click and a Shift-click.
async function selectRange(from, to) {
  nums()[from].fire('click', {});
  if (to !== from) nums()[to].fire('click', { shiftKey: true });
  await tick();
}
async function makeManual(anim) {
  anim.layout = 'manual'; anim.cell = null;
  host.history.execute({ do() {}, undo() {} }); host.history.clear();
  await tick();
}
// A window keydown, as the browser sends it (target: the focused element).
function press(key, { target, ...props } = {}) {
  const e = Object.assign(new Event('keydown', { cancelable: true }),
    { key, code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, ...props });
  if (target) Object.defineProperty(e, 'target', { value: target });
  window.dispatchEvent(e);
  return e;
}
const alt = letter => ({ altKey: true, code: `Key${letter.toUpperCase()}` });

// ---------------------------------------------------------------- pure

test('timelineShortcut maps the Aseprite keys to timeline actions', () => {
  const k = (key, props = {}) => timelineShortcut({ key, code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...props });
  assert.equal(k('Enter'), T('playStop'));
  assert.equal(k(','), T('prevFrame'));
  assert.equal(k('.'), T('nextFrame'));
  assert.equal(k('n', alt('n')), T('duplicate'));
  assert.equal(k('b', alt('b')), T('insertBlank'));
  assert.equal(k('m', alt('m')), T('insertLinked'));
  assert.equal(k('c', alt('c')), T('delete'));
  assert.equal(k('i', alt('i')), T('reverse'));
  assert.equal(k('˜', alt('n')), T('duplicate'), 'by key code, whatever Alt types on the layout');
  assert.equal(k('n'), null);
  assert.equal(k('n', { ...alt('n'), ctrlKey: true }), null);
  assert.equal(k('Enter', { shiftKey: true }), null);
  assert.equal(k('Enter', { ctrlKey: true }), null);
  assert.equal(k('.', { metaKey: true }), null);
});

test('shortcutBlocked: typing targets, an open dialog or menu, and Enter on a focused button', () => {
  const div = new Element('div'), input = new Element('input'), button = new Element('button');
  const e = (key, target) => ({ key, target });
  assert.equal(shortcutBlocked(e('.', div), { activeElement: div, overlayOpen: false }), false);
  assert.equal(shortcutBlocked(e('.', input), { activeElement: div, overlayOpen: false }), true);
  assert.equal(shortcutBlocked(e('.', div), { activeElement: input, overlayOpen: false }), true);
  assert.equal(shortcutBlocked(e('.', div), { activeElement: div, overlayOpen: true }), true);
  assert.equal(shortcutBlocked(e('Enter', button), { activeElement: div, overlayOpen: false }), true);
  assert.equal(shortcutBlocked(e('Enter', div), { activeElement: button, overlayOpen: false }), true);
  assert.equal(shortcutBlocked(e('.', button), { activeElement: button, overlayOpen: false }), false);
  assert.equal(shortcutBlocked(e('Enter', div), { activeElement: div, overlayOpen: false }), false);
});

// ---------------------------------------------------------- shortcuts

test('Alt+N duplicates the selected range after it and selects the copies', async () => {
  const { run, a, b, d } = await reset();
  await selectRange(0, 1);
  const e = press('n', alt('n'));
  assert.equal(e.defaultPrevented, true);
  assert.equal(run.frames.length, 5);
  assert.deepEqual([run.frames[0], run.frames[1], run.frames[4]].map(x => x.frameId), [a.id, b.id, d.id]);
  assert.equal(host.selections.get().entryIndex, 3, 'the copy of the selected column (B)');
  await tick();
  assert.deepEqual(nums().map(n => n.classList.contains('in-range')), [false, false, true, true, false, false]);
  host.history.undo();
  assert.equal(run.frames.length, 3);
});

test('Alt+B inserts a blank frame after the selection and selects it', async () => {
  const { run, a, b } = await reset();
  await selectRange(0, 1);
  press('b', alt('b'));
  assert.equal(run.frames.length, 4);
  assert.ok(![a.id, b.id].includes(run.frames[2].frameId));
  assert.equal(host.selections.get().entryIndex, 2);
});

test('a frame-creating shortcut on a manual animation offers the auto layout first, as one undo step', async () => {
  const { run } = await reset();
  await makeManual(run);
  assert.equal(enabled(T('insertBlank')), true, 'offered, not disabled');
  confirmAnswer = false;
  press('b', alt('b'));
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 3);
  confirmAnswer = true;
  press('b', alt('b'));
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 4);
  host.history.undo();
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 3);
});

test('Alt+M inserts a linked use of the selected frame after the range', async () => {
  const { run, b } = await reset();
  await selectRange(0, 1);
  press('m', alt('m'));
  assert.equal(run.frames.length, 4);
  assert.equal(run.frames[2].frameId, b.id, 'the selected (last clicked) column\'s frame');
  assert.equal(host.selections.get().entryIndex, 2);
});

test('Alt+C deletes the range and selects its neighbour', async () => {
  const { run, d } = await reset();
  await selectRange(0, 1);
  press('c', alt('c'));
  assert.deepEqual(run.frames.map(e => e.frameId), [d.id]);
  assert.equal(host.selections.get().frameId, d.id);
  host.history.undo();
  assert.equal(run.frames.length, 3);
});

test('Delete on the focused grid deletes the range', async () => {
  const { run, d } = await reset();
  await selectRange(0, 1);
  grid().fire('keydown', { key: 'Delete', target: grid(), preventDefault() {} });
  assert.deepEqual(run.frames.map(e => e.frameId), [d.id]);
});

test('Alt+I reverses the range; with one column it is disabled', async () => {
  const { run, a, b, d } = await reset();
  await selectRange(0, 0);
  assert.equal(enabled(T('reverse')), false);
  await selectRange(0, 2);
  assert.equal(enabled(T('reverse')), true);
  press('i', alt('i'));
  assert.deepEqual(run.frames.map(e => e.frameId), [d.id, b.id, a.id]);
});

test(', and . step within the animation and wrap around it', async () => {
  const { run, a, d } = await reset();
  press(',');
  assert.equal(host.selections.get().frameId, d.id, 'wraps to the last');
  press('.');
  assert.equal(host.selections.get().frameId, a.id, 'wraps to the first, never into Jump');
  assert.equal(host.selections.get().animationId, run.id);
});

test('Enter plays and stops; not while a button has focus or on a key repeat', async () => {
  await reset();
  press('Enter');
  assert.ok(byTitle('Stop'), 'playing');
  press('Enter', { repeat: true });
  assert.ok(byTitle('Stop'), 'a held Enter does not toggle again');
  press('Enter');
  assert.ok(byTitle('Play'), 'stopped');
  const button = new Element('button');
  document.activeElement = button;
  press('Enter', { target: button });
  assert.ok(byTitle('Play'), 'the focused button gets its own Enter');
  document.activeElement = null;
});

test('shortcuts do nothing on a typing target, in another mode, or with a dialog open', async () => {
  const { run } = await reset();
  press('b', { ...alt('b'), target: new Element('input') });
  assert.equal(run.frames.length, 3, 'typing target');
  const savedQuery = document.querySelector;
  document.querySelector = selector => (selector.includes('dialog[open]') ? new Element('dialog') : null);
  try { press('b', alt('b')); } finally { document.querySelector = savedQuery; }
  assert.equal(run.frames.length, 3, 'dialog open');
  host.activateMode('sprites');
  const e = press('b', alt('b'));
  assert.equal(run.frames.length, 3, 'other mode');
  assert.equal(e.defaultPrevented, false);
  host.activateMode('animations');
  press('b', alt('b'));
  assert.equal(run.frames.length, 4, 'and back in Animations it works');
});

test('a key another handler already took is left alone', async () => {
  const { run } = await reset();
  const e = Object.assign(new Event('keydown', { cancelable: true }), { key: 'b', ...alt('b') });
  e.preventDefault();
  window.dispatchEvent(e);
  assert.equal(run.frames.length, 3);
});

// ---------------------------------------------------------------- actions

test('every frame action shows its shortcut', () => {
  const shortcuts = Object.fromEntries(['playStop', 'prevFrame', 'nextFrame', 'duplicate', 'insertBlank', 'insertLinked', 'delete', 'reverse']
    .map(name => [name, getAction(T(name)).shortcut]));
  assert.deepEqual(shortcuts, {
    playStop: 'Enter', prevFrame: ',', nextFrame: '.', duplicate: 'Alt+N', insertBlank: 'Alt+B',
    insertLinked: 'Alt+M', delete: 'Alt+C', reverse: 'Alt+I',
  });
});

test('without a selected animation the frame and tag actions are disabled', async () => {
  await reset();
  host.selections.patch({ animationId: null, frameId: null, entryIndex: null }); await tick();
  for (const name of ['playStop', 'nextFrame', 'duplicate', 'insertBlank', 'insertLinked', 'delete', 'reverse', 'unlink',
    'clearCel', 'duration', 'renameTag', 'direction', 'color', 'loop', 'duplicateAnimation', 'deleteAnimation']) {
    assert.equal(enabled(T(name)), false, name);
  }
});

test('Unlink is enabled on a linked column and gives it its own frame', async () => {
  const { run, a } = await reset();
  assert.equal(enabled(T('unlink')), false, 'A is used once');
  run.frames.push({ frameId: a.id, duration: null }); host.history.execute({ do() {}, undo() {} }); host.history.clear(); await tick();
  nums()[3].fire('click', {});
  assert.equal(enabled(T('unlink')), true);
  runAction(T('unlink'));
  assert.notEqual(run.frames[3].frameId, a.id);
  assert.equal(host.selections.get().frameId, run.frames[3].frameId);
});

test('Clear cel clears the selected layer in the selected frame; a locked layer disables it', async () => {
  const { layer } = await reset();
  assert.equal(enabled(T('clearCel')), true);
  runAction(T('clearCel'));
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [0, 0, 0, 0]);
  host.history.undo();
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  layer.locked = true;
  assert.equal(enabled(T('clearCel')), false);
  layer.locked = false;
});

test('Duration… focuses the header duration input', async () => {
  await reset();
  runAction(T('duration'));
  await tick();
  assert.equal(document.activeElement, dock.querySelector('.anim-tl-duration').querySelector('input'));
});

test('Rename… opens the selected animation\'s tag for inline editing', async () => {
  const { run } = await reset();
  runAction(T('renameTag'));
  const input = dock.querySelectorAll('.anim-tag')[0].querySelector('input');
  assert.ok(input);
  input.value = 'Dash'; input.fire('keydown', { key: 'Enter' });
  assert.equal(run.name, 'Dash');
});

test('the Direction submenu lists four checked directions and sets one as one undo step', async () => {
  const { run } = await reset();
  const items = getAction(T('direction')).submenu;
  const list = typeof items === 'function' ? items() : items;
  assert.deepEqual(list.map(i => i.action), ['forward', 'reverse', 'pingpong', 'pingpongReverse'].map(d => T(`direction.${d}`)));
  assert.equal(getAction(T('direction.forward')).isChecked(), true);
  runAction(T('direction.pingpong'));
  assert.equal(run.direction, 'pingpong');
  assert.equal(getAction(T('direction.pingpong')).isChecked(), true);
  assert.equal(getAction(T('direction.forward')).isChecked(), false);
  runAction(T('setDirection'), 'reverse');
  assert.equal(run.direction, 'reverse');
  host.history.undo(); host.history.undo();
  assert.equal(run.direction, 'forward');
});

test('Colour… sets the tag colour from the picker; No Colour clears it', async () => {
  const { run } = await reset();
  assert.equal(enabled(T('clearColor')), false);
  runAction(T('color'));
  const picker = dock.querySelector('.anim-tl-color-input');
  picker.value = '#00ff00'; picker.fire('change');
  assert.equal(run.color, '#00ff00');
  assert.equal(enabled(T('clearColor')), true);
  runAction(T('clearColor'));
  assert.equal(run.color, null);
});

test('Loop toggles the animation\'s loop flag and shows it checked', async () => {
  const { run } = await reset();
  const before = !!run.loop;
  assert.equal(getAction(T('loop')).isChecked(), before);
  runAction(T('loop'));
  assert.equal(run.loop, !before);
  assert.equal(getAction(T('loop')).isChecked(), !before);
});

test('Duplicate Animation copies the animation and selects the copy; a manual one is offered the layout', async () => {
  const { sheet, run } = await reset();
  runAction(T('duplicateAnimation'));
  assert.equal(sheet.animations.length, 3);
  assert.equal(host.selections.get().animationId, sheet.animations[1].id);
  assert.equal(host.selections.get().frameId, sheet.animations[1].frames[0].frameId);
  host.history.undo();
  host.selections.patch({ animationId: run.id, frameId: run.frames[0].frameId, entryIndex: 0 });
  await makeManual(run);
  assert.equal(enabled(T('duplicateAnimation')), true);
  confirmAnswer = false;
  runAction(T('duplicateAnimation'));
  confirmAnswer = true;
  assert.equal(sheet.animations.length, 2);
  assert.equal(run.layout, 'manual');
});

test('Auto-layout and Make Manual are offered by layout', async () => {
  const { run } = await reset();
  assert.equal(getAction(T('autoLayout')).isAvailable(), false);
  assert.equal(getAction(T('makeManual')).isAvailable(), true);
  runAction(T('makeManual'));
  assert.equal(run.layout, 'manual');
  assert.equal(getAction(T('autoLayout')).isAvailable(), true);
  assert.equal(getAction(T('makeManual')).isAvailable(), false);
  runAction(T('autoLayout'));
  assert.equal(run.layout, 'auto');
});

test('Delete Animation asks first', async () => {
  const { sheet } = await reset();
  confirmAnswer = false;
  runAction(T('deleteAnimation'));
  assert.equal(sheet.animations.length, 2);
  confirmAnswer = true;
  runAction(T('deleteAnimation'));
  assert.equal(sheet.animations.length, 1);
});

test('Play/Stop and Previous/Next run from the actions too', async () => {
  const { b } = await reset();
  runAction(T('nextFrame'));
  assert.equal(host.selections.get().frameId, b.id);
  runAction(T('playStop'));
  assert.ok(byTitle('Stop'));
  runAction(T('playStop'));
  assert.ok(byTitle('Play'));
});
