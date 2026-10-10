import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { createProject, createSheet, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { mountAnimationTimeline } from '../js/modes/animations/presentation/animation-timeline-presenter.js';
import { mountPreviewPanel } from '../js/components/panels/preview-panel.js';
import { renderAnimationsPreview } from '../js/modes/animations/preview.js';
import { initFloatSession, registerFloatView, createFloat, activeFloating } from '../js/components/canvas/float-session.js';
import { cancelNameClick } from '../js/components/panels/layer-tree.js';
import { playingFrameId, stopPlayback } from '../js/modes/animations/presentation/timeline-playback.js';

const { Element, stepAnimationFrames } = installSpriteContextDom();
globalThis.alert = () => {};
let confirmAnswer = true;
globalThis.confirm = () => confirmAnswer;
globalThis.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', borderLeftWidth: '0', borderRightWidth: '0' });
const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode]) host.registerMode(mode);
host.start('animations');
// The float session without the canvas presenter: a stand-in animations.canvas view.
initFloatSession();
registerFloatView('canvas', { getSelection: () => null, setSelection() {}, getTargetRect: () => ({ x: 0, y: 0, w: 24, h: 16 }) });
const dock = new Element();
document.body.append(dock); // connected, as drag-reorder requires
mountAnimationTimeline(dock);
const previewEl = new Element(); previewEl.parentElement = new Element();
mountPreviewPanel(previewEl);
const previewDraws = () => previewEl.querySelector('canvas').getContext('2d').drawImages.length;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const byTitle = title => dock.querySelectorAll('button').find(b => b.title === title);
const sizeInput = () => dock.querySelector('.anim-tl-size');
// Widens the columns past the thumbnail threshold (composite row + per-layer thumbnails).
async function expand(width = '48') { sizeInput().value = width; sizeInput().fire('input'); await tick(); }

// Auto "Run" (A, B) then auto "Jump" (C), all 8x8.
async function reset() {
  cancelNameClick(); // a tag click's deferred render from the previous test
  const project = createProject('Timeline');
  const sheet = createSheet(project, { name: 'Sheet', width: 24, height: 16, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  const c = addFrame(sheet, { name: 'C', x: 0, y: 8, w: 8, h: 8 });
  const run = addAnimation(sheet, 'Run');
  Object.assign(run, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: a.id, duration: null }, { frameId: b.id, duration: null }] });
  const jump = addAnimation(sheet, 'Jump');
  Object.assign(jump, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: c.id, duration: null }] });
  setPixel(sheetLayers(sheet)[0].bitmap, 1, 1, [255, 0, 0, 255]);
  host.setProject(project);
  host.activateMode('sprites'); host.activateMode('animations');
  host.selections.patch({ animationId: run.id, frameId: a.id, entryIndex: 0 });
  host.history.clear();
  if (sizeInput()) { sizeInput().value = '24'; sizeInput().fire('input'); }
  await tick();
  return { sheet, run, jump, a, b, c };
}

test('tags and cells render one column per entry', async () => {
  await reset(); await expand();
  assert.deepEqual(dock.querySelectorAll('.anim-tag').map(t => t.textContent), ['Run', 'Jump']);
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 3);
  assert.equal(dock.querySelectorAll('.anim-tl-cell')[0].classList.contains('selected'), true);
  assert.deepEqual(dock.querySelectorAll('.anim-tl-num').map(n => n.textContent), ['1', '2', '3']);
});

test('clicking a cell of another animation selects that animation and frame', async () => {
  const { jump } = await reset(); await expand();
  dock.querySelectorAll('.anim-tl-cell')[2].fire('click');
  const sel = host.selections.get();
  assert.equal(sel.animationId, jump.id); assert.equal(sel.frameId, jump.frames[0].frameId); assert.equal(sel.entryIndex, 0);
});

test('clicking a tag selects that animation at its first column', async () => {
  const { jump } = await reset();
  dock.querySelectorAll('.anim-tag')[1].fire('click');
  assert.equal(host.selections.get().animationId, jump.id);
  assert.equal(host.selections.get().frameId, jump.frames[0].frameId);
});

test('+ Frame inserts after the selected column and selects the new frame', async () => {
  const { run } = await reset(); await expand();
  byTitle('Add a blank frame after this one').fire('click');
  assert.equal(run.frames.length, 3);
  assert.equal(host.selections.get().frameId, run.frames[1].frameId);
  await tick();
  assert.equal(dock.querySelectorAll('.anim-tl-cell')[1].classList.contains('selected'), true);
});

test('Duplicate copies the selected frame after it', async () => {
  const { run, a } = await reset();
  byTitle('Duplicate this frame').fire('click');
  assert.equal(run.frames.length, 3);
  assert.notEqual(run.frames[1].frameId, a.id);
});

test('the remove button deletes the selected column and selects its neighbour', async () => {
  const { run, b } = await reset();
  byTitle('Remove this frame').fire('click');
  assert.equal(run.frames.length, 1);
  assert.equal(host.selections.get().frameId, b.id);
});

test('Next walks into the following animation and Previous walks back', async () => {
  const { run, jump } = await reset();
  byTitle('Next frame').fire('click'); byTitle('Next frame').fire('click');
  assert.equal(host.selections.get().animationId, jump.id);
  byTitle('Previous frame').fire('click');
  assert.equal(host.selections.get().animationId, run.id);
  assert.equal(host.selections.get().entryIndex, 1);
});

test('Last and First stay within the selected animation', async () => {
  const { run, b, a } = await reset();
  byTitle('Last frame').fire('click');
  assert.equal(host.selections.get().frameId, b.id);
  byTitle('First frame').fire('click');
  assert.equal(host.selections.get().frameId, a.id);
  assert.equal(host.selections.get().animationId, run.id);
});

test('the selected column is shown in the Preview', async () => {
  const { b } = await reset();
  const before = previewDraws();
  host.selections.patch({ frameId: b.id, entryIndex: 1 }); await tick();
  assert.ok(previewDraws() > before);
});

test('playback stops on a structural change', async () => {
  await reset();
  byTitle('Play').fire('click');
  assert.ok(byTitle('Stop'), 'playing');
  byTitle('Remove this frame').fire('click');
  assert.ok(byTitle('Play'), 'stopped');
});

test('a sheet without animations shows an empty timeline with playback disabled', async () => {
  const { sheet } = await reset();
  sheet.animations.length = 0; host.history.execute({ do() {}, undo() {} });
  await tick();
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 0);
  assert.equal(byTitle('Play').disabled, true);
});

test('on a manual animation the add buttons explain why they are disabled', async () => {
  const { run } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} });
  await tick();
  assert.equal(byTitle('Auto-layout this animation first').disabled, true);
});

test('selecting another animation while playing stops playback', async () => {
  const { jump } = await reset();
  byTitle('Play').fire('click');
  host.selections.patch({ animationId: jump.id, frameId: jump.frames[0].frameId, entryIndex: 0 });
  await tick();
  assert.ok(byTitle('Play'), 'stopped');
});

test('playback stops when the playing entry disappears from outside the timeline', async () => {
  const { sheet, run, b } = await reset();
  host.selections.patch({ frameId: b.id, entryIndex: 1 }); await tick();
  byTitle('Play').fire('click');
  host.registries.commands.execute('animations.deleteFrame', { modeId: 'animations' }, { sheetId: sheet.id, animationId: run.id, index: 1 });
  await tick();
  assert.ok(byTitle('Play'), 'stopped');
});

test('without a filter override the Preview provider renders the selected column from real pixels', async () => {
  const { c, run } = await reset();
  const shown = renderAnimationsPreview();
  assert.equal(shown.managed, undefined);
  assert.equal(getPixel(shown.bitmap, 1, 1)[3], 255, 'frame A with its red pixel');
  host.selections.patch({ animationId: run.id, frameId: c.id, entryIndex: 0 }); // C is not in Run
  assert.equal(renderAnimationsPreview().bitmap, null);
});

const layerRows = () => dock.querySelectorAll('.anim-tl-layer');
const celsOf = row => row.querySelectorAll('.anim-tl-cel');

test('each layer row has one cel per column, with a filled dot where the layer has pixels', async () => {
  await reset();
  assert.equal(layerRows().length, 1);
  const dots = celsOf(layerRows()[0]).map(c => c.querySelector('.anim-tl-dot').classList.contains('filled'));
  assert.deepEqual(dots, [true, false, false]);
});

test('clicking a cel selects that frame and that layer', async () => {
  const { sheet, b } = await reset();
  const layer = sheetLayers(sheet)[0];
  host.selections.patch({ layerId: null });
  celsOf(layerRows()[0])[1].fire('click');
  const sel = host.selections.get();
  assert.equal(sel.frameId, b.id); assert.equal(sel.entryIndex, 1); assert.equal(sel.layerId, layer.id);
  await tick();
  assert.equal(celsOf(layerRows()[0])[1].classList.contains('selected'), true);
});

test('adding a layer adds a row with one cel per column', async () => {
  await reset();
  byTitle('Add layer').fire('click');
  await tick();
  assert.equal(layerRows().length, 2);
  assert.equal(celsOf(layerRows()[0]).length, 3);
  host.history.undo(); await tick();
  assert.equal(layerRows().length, 1);
});

test('collapsing a folder hides its rows and keeps the active layer', async () => {
  const { sheet } = await reset();
  byTitle('Add folder').fire('click'); await tick();
  const folder = sheet.layerTree.children.find(n => n.type === 'group');
  byTitle('Add layer').fire('click'); await tick(); // added into the selected folder
  const inner = folder.children[0];
  assert.equal(host.selections.get().layerId, inner.id);
  assert.equal(layerRows().length, 3);
  layerRows()[0].querySelector('.tree-toggle').fire('click'); await tick();
  assert.equal(layerRows().length, 2);
  assert.equal(host.selections.get().layerId, inner.id);
});

test('a linked column shows its link mark on the frame number', async () => {
  const { run, a } = await reset();
  run.frames.push({ frameId: a.id, duration: null }); host.history.execute({ do() {}, undo() {} });
  await tick();
  assert.ok(dock.querySelectorAll('.anim-tl-num')[2].querySelector('.anim-tl-linked'));
});

test('the compact timeline shows dots and no composite row', async () => {
  await reset();
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 0);
  assert.ok(celsOf(layerRows()[0])[0].querySelector('.anim-tl-dot'));
  assert.equal(celsOf(layerRows()[0])[0].style.width, '24px');
});

test('widening past the threshold shows per-layer thumbnails and the composite row', async () => {
  await reset(); await expand();
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 3);
  const cel = celsOf(layerRows()[0])[0];
  assert.ok(cel.querySelector('.anim-tl-cel-thumb'));
  assert.equal(cel.querySelector('.anim-tl-dot'), null);
  assert.equal(cel.style.width, '48px');
});

test('the playing column is marked on its number and, expanded, its composite cell', async () => {
  await reset(); await expand();
  byTitle('Play').fire('click');
  assert.equal(dock.querySelectorAll('.anim-tl-num')[0].classList.contains('playhead'), true);
  assert.equal(dock.querySelectorAll('.anim-tl-cell')[0].classList.contains('playhead'), true);
  assert.equal(dock.querySelectorAll('.anim-tl-cell')[1].classList.contains('playhead'), false);
  byTitle('Stop').fire('click');
});

const nums = () => dock.querySelectorAll('.anim-tl-num');
const gaps = () => dock.querySelectorAll('.anim-tl-gap');
const grid = () => dock.querySelector('.anim-tl-grid');
const pointerEvent = (type, props) => Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, ...props });
// Drags frame number `from` (numbers sit 24px apart from x = 0) to clientX
// `toX` and drops it there, with modifier keys held throughout.
function dragNum(from, toX, mods = {}) {
  nums().forEach((n, i) => { n.rect = { left: i * 24, top: 0, width: 24, height: 20 }; });
  nums()[from].dispatch('pointerdown', { pointerId: 1, button: 0, clientX: from * 24 + 12, clientY: 10, ...mods });
  window.dispatchEvent(pointerEvent('pointermove', { clientX: toX, clientY: 10, ...mods }));
  window.dispatchEvent(pointerEvent('pointerup', { clientX: toX, clientY: 10, ...mods }));
}

test('a gap inserts a blank frame there; Alt duplicates the frame to its left', async () => {
  const { run, a } = await reset();
  gaps()[1].fire('click', { altKey: false }); // between A and B
  assert.equal(run.frames.length, 3);
  assert.notEqual(run.frames[1].frameId, a.id);
  assert.equal(host.selections.get().entryIndex, 1);
  await tick();
  gaps()[1].fire('click', { altKey: true }); // copies A, the frame to its left
  assert.equal(run.frames.length, 4);
  assert.notEqual(run.frames[1].frameId, a.id);
  assert.equal(host.history.canUndo(), true);
});

test('the gap after an animation\'s last column appends to that animation', async () => {
  const { run, jump } = await reset();
  const endGap = gaps().find(g => g.classList.contains('end'));
  endGap.fire('click', {});
  assert.equal(run.frames.length, 3);
  assert.equal(jump.frames.length, 1);
});

test('dragging a header onto another column of its animation reorders it', async () => {
  const { run, a, b } = await reset();
  dragNum(0, 44);
  assert.deepEqual(run.frames.map(e => e.frameId), [b.id, a.id]);
});

test('Ctrl+drop inserts a linked use of the dragged frame', async () => {
  const { run, a } = await reset();
  dragNum(0, 44, { ctrlKey: true });
  assert.equal(run.frames.length, 3);
  assert.equal(run.frames[2].frameId, a.id);
});

test('a column dropped on another animation is ignored', async () => {
  const { run, jump } = await reset();
  dragNum(0, 52);
  dragNum(0, 70, { ctrlKey: true });
  assert.equal(run.frames.length, 2); assert.equal(jump.frames.length, 1);
  assert.equal(document.body.querySelectorAll('.dr-line').length, 0, 'the drag cleaned up');
});

// Run becomes A, B, D (D a new auto frame); Jump stays C.
async function resetThree() {
  const fixture = await reset();
  const d = addFrame(fixture.sheet, { name: 'D', x: 16, y: 0, w: 8, h: 8 });
  fixture.run.frames.push({ frameId: d.id, duration: null });
  host.history.execute({ do() {}, undo() {} }); host.history.clear();
  await tick();
  return { ...fixture, d };
}

test('frame numbers are pointer-drag items, no longer native draggables', async () => {
  await reset();
  assert.ok(nums().every(n => n.draggable !== true));
  assert.deepEqual(nums().map(n => n.dataset.dragKey), ['0', '1', '2']);
});

test('dragging a column inside the range moves the whole range as one undo step', async () => {
  const { run, a, b, d } = await resetThree();
  nums()[0].fire('click', {}); nums()[1].fire('click', { shiftKey: true }); await tick();
  dragNum(1, 68); // after D
  assert.deepEqual(run.frames.map(e => e.frameId), [d.id, a.id, b.id]);
  assert.equal(host.selections.get().entryIndex, 2, 'the dragged column stays selected');
  await tick();
  assert.deepEqual(rangeOfNums(), [false, true, true, false], 'the range moved with it');
  host.history.undo();
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id, d.id]);
});

test('dragging a column outside the range moves only that column', async () => {
  const { run, a, b, d } = await resetThree();
  nums()[0].fire('click', {}); nums()[1].fire('click', { shiftKey: true }); await tick();
  dragNum(2, 4); // D before A
  assert.deepEqual(run.frames.map(e => e.frameId), [d.id, a.id, b.id]);
  assert.equal(host.selections.get().frameId, d.id);
});

test('Alt+drop copies the dragged range there as one undo step', async () => {
  const { run, a, b, d } = await resetThree();
  nums()[0].fire('click', {}); nums()[1].fire('click', { shiftKey: true }); await tick();
  dragNum(0, 68, { altKey: true });
  assert.equal(run.frames.length, 5);
  assert.deepEqual(run.frames.slice(0, 3).map(e => e.frameId), [a.id, b.id, d.id]);
  assert.ok(run.frames.slice(3).every(e => ![a.id, b.id, d.id].includes(e.frameId)), 'independent copies');
  assert.equal(host.selections.get().entryIndex, 3, 'the copy of the dragged column is selected');
  host.history.undo();
  assert.equal(run.frames.length, 3);
});

test('Alt+drop on a manual animation offers the auto layout; accepting is one undo step', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  confirmAnswer = false;
  dragNum(0, 44, { altKey: true });
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  confirmAnswer = true;
  dragNum(0, 44, { altKey: true });
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
  host.history.undo();
  assert.equal(run.layout, 'manual');
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id]);
});

test('Alt-dragging frame 3 to just after itself duplicates it in place, one undo step', async () => {
  const { run, a, b, d } = await resetThree();
  dragNum(2, 70, { altKey: true }); // the right half of frame 3 itself
  assert.equal(run.frames.length, 4);
  assert.deepEqual(run.frames.slice(0, 3).map(e => e.frameId), [a.id, b.id, d.id]);
  assert.ok(![a.id, b.id, d.id].includes(run.frames[3].frameId), 'an independent copy');
  assert.equal(host.selections.get().entryIndex, 3, 'the copy is selected');
  host.history.undo();
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id, d.id]);
});

test('Ctrl-dragging a frame number next to itself inserts a linked use there', async () => {
  const { run, a, b } = await reset();
  dragNum(1, 30, { ctrlKey: true }); // the left half of frame 2 itself
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id, b.id]);
  host.history.undo();
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id]);
});

test('a plain drag next to itself still does nothing', async () => {
  const { run, a, b } = await reset();
  dragNum(1, 30);
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id]);
  assert.equal(host.history.canUndo(), false);
});

test('Ctrl+drag links only the dragged column, even inside a range', async () => {
  const { run, a, d } = await resetThree();
  nums()[0].fire('click', {}); nums()[1].fire('click', { shiftKey: true }); await tick();
  dragNum(0, 68, { ctrlKey: true });
  assert.equal(run.frames.length, 4);
  assert.equal(run.frames[3].frameId, a.id);
  assert.equal(run.frames[2].frameId, d.id);
});

test('Delete on the focused timeline removes the selected column', async () => {
  const { run } = await reset();
  let prevented = false;
  grid().fire('keydown', { key: 'Delete', target: grid(), preventDefault() { prevented = true; } });
  assert.equal(run.frames.length, 1);
  assert.equal(prevented, true);
});

test('Delete in an input does not remove a column', async () => {
  const { run } = await reset();
  const input = document.createElement('input');
  grid().fire('keydown', { key: 'Delete', target: input });
  assert.equal(run.frames.length, 2);
});

test('ArrowRight on the timeline steps to the next column', async () => {
  const { b } = await reset();
  grid().fire('keydown', { key: 'ArrowRight', target: grid() });
  assert.equal(host.selections.get().frameId, b.id);
});

test('a manual animation is offered auto-layout before an insert; declining changes nothing', async () => {
  const { run } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  confirmAnswer = false;
  gaps()[1].fire('click', {});
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  confirmAnswer = true;
  gaps()[1].fire('click', {});
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
});

test('accepting the offer for differently sized frames lays out at the suggested size', async () => {
  const { run, b } = await reset();
  run.layout = 'manual'; run.cell = null; b.w = 10; host.history.execute({ do() {}, undo() {} }); await tick();
  gaps()[1].fire('click', {});
  assert.equal(run.layout, 'auto');
  assert.deepEqual(run.cell, { w: 10, h: 8 });
});

test('declining the offer still reorders a manual animation without layout', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  confirmAnswer = false;
  dragNum(0, 44);
  confirmAnswer = true;
  assert.equal(run.layout, 'manual');
  assert.deepEqual(run.frames.map(e => e.frameId), [b.id, a.id]);
});

test('the header edits the selected column\'s duration as one undoable step', async () => {
  const { run } = await reset();
  const input = dock.querySelector('.anim-tl-duration').querySelector('input');
  input.value = '250'; input.fire('change');
  assert.equal(run.frames[0].duration, 250);
  host.history.undo();
  assert.equal(run.frames[0].duration, null);
});

test('an animation\'s first and end gaps sit inside their own numbers, so a tag boundary has one gap per side', async () => {
  await reset();
  const startGaps = num => num.querySelectorAll('.anim-tl-gap').filter(g => g.classList.contains('start'));
  assert.equal(startGaps(nums()[0]).length, 1, 'Run starts');
  assert.equal(startGaps(nums()[1]).length, 0, 'mid-animation gap spans two numbers');
  assert.equal(startGaps(nums()[2]).length, 1, 'Jump starts next to Run\'s end gap');
  assert.ok(nums()[1].querySelectorAll('.anim-tl-gap').some(g => g.classList.contains('end')));
});

test('an offer that needs a size names it and warns before re-framing; declining changes nothing', async () => {
  const { run, b } = await reset();
  run.layout = 'manual'; run.cell = null; b.pivotX = 2; host.history.execute({ do() {}, undo() {} }); await tick();
  const asked = [];
  globalThis.confirm = message => { asked.push(message); return asked.length === 1; };
  try { gaps()[1].fire('click', {}); } finally { globalThis.confirm = () => confirmAnswer; }
  assert.equal(asked.length, 2);
  assert.match(asked[1], /8×8/);
  assert.match(asked[1], /crop/i);
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
});

test('painting refreshes the selected frame\'s cels in place instead of rebuilding the grid', async () => {
  const { sheet, b } = await reset();
  host.selections.patch({ frameId: b.id, entryIndex: 1 }); await tick();
  const row = layerRows()[0];
  const cel = celsOf(row)[1];
  assert.ok(cel.querySelector('.anim-tl-dot').classList.contains('empty'));
  setPixel(sheetLayers(sheet)[0].bitmap, 9, 1, [255, 0, 0, 255]);
  host.store.notifyPixelsChanged(); await tick();
  assert.equal(layerRows()[0], row, 'rows are not rebuilt');
  assert.ok(cel.querySelector('.anim-tl-dot').classList.contains('filled'));
});

test('a click on a layer name does not rebuild the timeline before a double-click can land on it', async () => {
  const { sheet } = await reset();
  byTitle('Add layer').fire('click'); await tick();
  const other = sheetLayers(sheet).find(l => l.id !== host.selections.get().layerId);
  const row = layerRows().find(r => r.querySelector('.layer-name')?.textContent === other.name);
  row.querySelector('.layer-name').fire('click'); await tick();
  assert.equal(host.selections.get().layerId, other.id, 'selected at once');
  assert.ok(layerRows().includes(row), 'the row (and its name) is still the one under the pointer');
  await new Promise(resolve => setTimeout(resolve, 250)); // the grace window ends
  assert.ok(!layerRows().includes(row), 'then the selection renders');
});

test('accepting the offer and inserting is one undo step', async () => {
  const { run } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  gaps()[1].fire('click', {});
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
  host.history.undo();
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
});

test('an insert refused after accepting the offer leaves the animation manual', async () => {
  const { sheet, run } = await reset();
  byTitle('Add layer').fire('click'); await tick();
  const blocker = sheetLayers(sheet).find(l => l.id === host.selections.get().layerId);
  setPixel(blocker.bitmap, 9, 1, [0, 0, 255, 255]); // under B, which the insert must move
  blocker.locked = true;
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  gaps()[1].fire('click', {});
  assert.equal(run.frames.length, 2);
  assert.equal(run.layout, 'manual');
});

test('a declined offer is not asked again when reordering that animation', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  let asked = 0;
  globalThis.confirm = () => { asked++; return false; };
  try {
    for (let i = 0; i < 2; i++) {
      dragNum(0, 44);
    }
  } finally { globalThis.confirm = () => confirmAnswer; }
  assert.equal(asked, 1);
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id], 'reordered twice, by hand');
  assert.equal(run.layout, 'manual');
});

test('a declined crop prompt is not asked again when reordering that animation', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; b.pivotX = 2; host.history.execute({ do() {}, undo() {} }); await tick();
  const asked = [];
  globalThis.confirm = message => { asked.push(message); return /laid out by hand/.test(message); };
  try {
    for (let i = 0; i < 2; i++) {
      dragNum(0, 44);
    }
  } finally { globalThis.confirm = () => confirmAnswer; }
  assert.equal(asked.length, 2, 'both prompts once, not again on the second reorder');
  assert.match(asked[0], /laid out by hand/);
  assert.match(asked[1], /crop/i);
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id], 'reordered twice, by hand');
  assert.equal(run.layout, 'manual');
});

test('accepting the offer and Ctrl+dropping a linked use is one undo step', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  dragNum(0, 44, { ctrlKey: true });
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
  host.history.undo();
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id]);
});

test('accepting the offer and reordering is one undo step', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  dragNum(0, 44);
  assert.equal(run.layout, 'auto');
  assert.deepEqual(run.frames.map(e => e.frameId), [b.id, a.id]);
  host.history.undo();
  assert.equal(run.layout, 'manual');
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id]);
});

test('a pending float is committed as its own undo step before an accepted offer', async () => {
  const { sheet, run } = await reset();
  const layer = sheetLayers(sheet)[0];
  assert.equal(createFloat({ region: { x: 0, y: 0, w: 8, h: 8 } }), true);
  activeFloating().transform.tx = 1; // moved, so committing is a real step and not a cancel
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  gaps()[1].fire('click', {});
  assert.equal(activeFloating(), null, 'the float was committed');
  assert.deepEqual(getPixel(layer.bitmap, 2, 1), [255, 0, 0, 255]);
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
  host.history.undo();
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  assert.equal(activeFloating(), null, 'the float commit is a separate step, still applied');
  host.history.undo();
  assert.ok(activeFloating(), 'the second undo reverses the float commit');
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  assert.deepEqual(getPixel(layer.bitmap, 2, 1), [0, 0, 0, 0]);
  host.history.clear();
  await reset(); // setProject drops any float state
});

test('focus returns to the grid when a click re-renders the element that had it', async () => {
  const { run } = await reset();
  const gap = gaps()[1];
  gap.focus();
  gap.fire('click', {}); await tick();
  assert.equal(run.frames.length, 3);
  assert.equal(document.activeElement, grid());
});

test('keys on a control inside the grid (a layer row button) do not edit columns', async () => {
  const { run } = await reset();
  const button = layerRows()[0].querySelector('button');
  grid().fire('keydown', { key: 'Delete', target: button });
  assert.equal(run.frames.length, 2);
});

test('clicking a frame number selects its column', async () => {
  const { b } = await reset();
  nums()[1].fire('click', {});
  assert.equal(host.selections.get().frameId, b.id);
  assert.equal(host.selections.get().entryIndex, 1);
});

test('the Animations timeline dock keeps the shared dock resizer first across re-renders', async () => {
  await reset(); await expand();
  assert.equal(dock.children[0].classList.contains('dock-resizer'), true);
  assert.equal(dock.querySelectorAll('.dock-resizer').length, 1);
});

// ---- range selection, durations, tags, column width (spec 2026-10-10 §5) ----

const inRange = el => el.classList.contains('in-range');
const rangeOfNums = () => nums().map(inRange);

test('Shift-clicking a frame number extends a range from the last plain click', async () => {
  const { b } = await reset();
  nums()[0].fire('click', {});
  nums()[1].fire('click', { shiftKey: true }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, false]);
  assert.equal(host.selections.get().frameId, b.id, 'the clicked column is the selected one');
  assert.deepEqual(celsOf(layerRows()[0]).map(inRange), [true, true, false], 'cels show the range too');
  nums()[1].fire('click', {}); await tick();
  assert.deepEqual(rangeOfNums(), [false, false, false], 'a plain click selects one column');
});

test('Shift-clicking into another animation selects that column alone', async () => {
  const { jump } = await reset();
  nums()[0].fire('click', {});
  nums()[2].fire('click', { shiftKey: true }); await tick();
  assert.deepEqual(rangeOfNums(), [false, false, false]);
  assert.equal(host.selections.get().animationId, jump.id);
});

test('Shift-clicking a cel extends the range and selects its layer', async () => {
  const { sheet } = await reset();
  host.selections.patch({ layerId: null });
  celsOf(layerRows()[0])[0].fire('click', {});
  celsOf(layerRows()[0])[1].fire('click', { shiftKey: true }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, false]);
  assert.equal(host.selections.get().layerId, sheetLayers(sheet)[0].id);
});

test('Shift+Arrow on the focused grid extends the range within the animation', async () => {
  await reset();
  grid().fire('keydown', { key: 'ArrowRight', shiftKey: true, target: grid() }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, false]);
  grid().fire('keydown', { key: 'ArrowRight', shiftKey: true, target: grid() }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, false], 'never into the next animation');
  grid().fire('keydown', { key: 'ArrowLeft', shiftKey: true, target: grid() }); await tick();
  assert.deepEqual(rangeOfNums(), [false, false, false], 'back to the anchor alone');
});

test('the range clears when another animation is selected', async () => {
  const { run, jump, a } = await reset();
  nums()[1].fire('click', { shiftKey: true }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, false]);
  host.selections.patch({ animationId: jump.id, frameId: jump.frames[0].frameId, entryIndex: 0 }); await tick();
  host.selections.patch({ animationId: run.id, frameId: a.id, entryIndex: 0 }); await tick();
  assert.deepEqual(rangeOfNums(), [false, false, false]);
});

test('frame numbers show each entry\'s duration, or its held step in an fps animation', async () => {
  const { run } = await reset();
  run.frames[1].duration = 250; host.history.execute({ do() {}, undo() {} }); await tick();
  assert.deepEqual(nums().map(n => n.querySelector('.anim-tl-dur').textContent), ['100ms', '250ms', '100ms']);
  run.baseFps = 10; run.baseStep = 1; run.frames[1].step = 2; host.history.execute({ do() {}, undo() {} }); await tick();
  assert.deepEqual(nums().slice(0, 2).map(n => n.querySelector('.anim-tl-dur').textContent), ['×1', '×2']);
});

test('double-clicking a frame number focuses the duration input', async () => {
  await reset();
  nums()[1].fire('click', {});
  nums()[1].dispatch('dblclick', {});
  await tick();
  assert.equal(document.activeElement, dock.querySelector('.anim-tl-duration').querySelector('input'));
});

test('double-clicking a frame number inside a range keeps the range for the duration input', async () => {
  const { run } = await resetThree();
  nums()[0].fire('click', { detail: 1 }); nums()[2].fire('click', { shiftKey: true, detail: 1 }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, true, false]);
  // The browser's double-click: click (detail 1), click (detail 2), dblclick.
  nums()[1].fire('click', { detail: 1 }); await tick();
  nums()[1].fire('click', { detail: 2 }); await tick();
  nums()[1].dispatch('dblclick', { detail: 2 }); await tick();
  assert.deepEqual(rangeOfNums(), [true, true, true, false], 'the range survived the double-click');
  assert.equal(host.selections.get().entryIndex, 1, 'the double-clicked column is the selected one');
  const input = dock.querySelector('.anim-tl-duration').querySelector('input');
  assert.equal(document.activeElement, input);
  input.value = '40'; input.fire('change');
  assert.deepEqual(run.frames.map(e => e.duration), [40, 40, 40]);
  host.history.undo();
  assert.deepEqual(run.frames.map(e => e.duration), [null, null, null], 'one undo step');
});

test('double-clicking a frame number outside the range selects that column alone', async () => {
  await resetThree();
  nums()[0].fire('click', { detail: 1 }); nums()[1].fire('click', { shiftKey: true, detail: 1 }); await tick();
  nums()[2].fire('click', { detail: 1 }); await tick();
  nums()[2].fire('click', { detail: 2 }); await tick();
  nums()[2].dispatch('dblclick', { detail: 2 }); await tick();
  assert.deepEqual(rangeOfNums(), [false, false, false, false]);
  assert.equal(host.selections.get().entryIndex, 2);
});

test('with a range, the header duration sets every entry in it as one undo step', async () => {
  const { run } = await reset();
  nums()[1].fire('click', { shiftKey: true }); await tick();
  const input = dock.querySelector('.anim-tl-duration').querySelector('input');
  input.value = '40'; input.fire('change');
  assert.deepEqual(run.frames.map(e => e.duration), [40, 40]);
  host.history.undo();
  assert.deepEqual(run.frames.map(e => e.duration), [null, null]);
});

test('with a range in an fps animation, the header sets the held step of every entry', async () => {
  const { run } = await reset();
  run.baseFps = 10; run.baseStep = 1; host.history.execute({ do() {}, undo() {} }); await tick();
  nums()[1].fire('click', { shiftKey: true }); await tick();
  const input = dock.querySelector('.anim-tl-duration').querySelector('input');
  input.value = '3'; input.fire('change');
  assert.deepEqual(run.frames.map(e => e.step), [3, 3]);
});

test('tags are drawn in their animation\'s colour (default accent) with a direction glyph', async () => {
  const { run } = await reset();
  run.color = '#ff0000'; run.direction = 'pingpong'; host.history.execute({ do() {}, undo() {} }); await tick();
  const [runTag, jumpTag] = dock.querySelectorAll('.anim-tag');
  assert.equal(runTag.style.borderColor, '#ff0000');
  assert.equal(runTag.querySelector('.anim-tag-dir').textContent, '⇄');
  assert.equal(jumpTag.style.borderColor, 'var(--accent)');
  assert.equal(jumpTag.querySelector('.anim-tag-dir').textContent, '→');
});

test('double-clicking a tag renames its animation inline as one undo step', async () => {
  const { run } = await reset();
  const tag = dock.querySelectorAll('.anim-tag')[0];
  tag.fire('dblclick', {});
  const input = tag.querySelector('input');
  assert.ok(input, 'an inline name field');
  assert.equal(document.activeElement, input);
  input.value = 'Sprint'; input.fire('keydown', { key: 'Enter' });
  assert.equal(run.name, 'Sprint');
  await tick();
  assert.equal(dock.querySelectorAll('.anim-tag')[0].textContent, 'Sprint');
  host.history.undo();
  assert.equal(run.name, 'Run');
});

test('Escape cancels an inline tag rename', async () => {
  const { run } = await reset();
  const tag = dock.querySelectorAll('.anim-tag')[0];
  tag.fire('dblclick', {});
  const input = tag.querySelector('input');
  input.value = 'Nope'; input.fire('keydown', { key: 'Escape' });
  assert.equal(run.name, 'Run');
  assert.equal(host.history.canUndo(), false);
});

test('Ctrl+wheel over the grid changes the column width; a plain wheel is left to scroll', async () => {
  await reset();
  const stored = [];
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => stored.push([k, v]) };
  try {
    let prevented = false;
    grid().fire('wheel', { ctrlKey: true, deltaY: -100, preventDefault() { prevented = true; } }); await tick();
    assert.equal(prevented, true);
    assert.equal(sizeInput().value, '28');
    assert.equal(celsOf(layerRows()[0])[0].style.width, '28px');
    assert.deepEqual(stored.at(-1), ['pixelartist.animTimelineColumn', '28']);
    prevented = false;
    grid().fire('wheel', { ctrlKey: false, deltaY: -100, preventDefault() { prevented = true; } }); await tick();
    assert.equal(prevented, false);
    assert.equal(sizeInput().value, '28');
    for (let i = 0; i < 20; i++) grid().fire('wheel', { ctrlKey: true, deltaY: -100, preventDefault() {} });
    await tick();
    assert.equal(sizeInput().value, '64', 'clamped');
  } finally { globalThis.localStorage = saved; }
});

// ---- playback in the main view (timeline-playback.js) ----

test('playing publishes the playing frame for the main view; it advances and clears on Stop', async () => {
  const { a, b } = await reset();
  assert.equal(playingFrameId(), null);
  byTitle('Play').fire('click');
  assert.equal(playingFrameId(), a.id);
  stepAnimationFrames(1000); stepAnimationFrames(1150);
  assert.equal(playingFrameId(), b.id);
  byTitle('Stop').fire('click');
  assert.equal(playingFrameId(), null);
});

test('stopping from the main view selects the frame it was showing', async () => {
  const { b } = await reset();
  byTitle('Play').fire('click');
  stepAnimationFrames(2000); stepAnimationFrames(2150);
  stopPlayback();
  assert.ok(byTitle('Play'), 'stopped');
  assert.equal(playingFrameId(), null);
  assert.deepEqual([host.selections.get().frameId, host.selections.get().entryIndex], [b.id, 1]);
});

test('Play settles a float first, so it is not drawn over the playing frames', async () => {
  await reset();
  createFloat({ region: { x: 0, y: 0, w: 8, h: 8 } });
  assert.ok(activeFloating());
  byTitle('Play').fire('click');
  assert.equal(activeFloating(), null);
  byTitle('Stop').fire('click');
});
