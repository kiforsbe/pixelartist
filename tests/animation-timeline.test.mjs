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

const { Element } = installSpriteContextDom();
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
const dragData = { setData() {}, effectAllowed: '' };
const dropData = { getData: () => '' };

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
  nums()[0].fire('dragstart', { dataTransfer: dragData });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: dropData });
  assert.deepEqual(run.frames.map(e => e.frameId), [b.id, a.id]);
});

test('Ctrl+drop inserts a linked use of the dragged frame', async () => {
  const { run, a } = await reset();
  nums()[0].fire('dragstart', { dataTransfer: dragData });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: true, dataTransfer: dropData });
  assert.equal(run.frames.length, 3);
  assert.equal(run.frames[2].frameId, a.id);
});

test('a column dropped on another animation is ignored', async () => {
  const { run, jump } = await reset();
  nums()[0].fire('dragstart', { dataTransfer: dragData });
  let allowed = false;
  nums()[2].fire('dragover', { clientX: 0, dataTransfer: {}, preventDefault() { allowed = true; } });
  nums()[2].fire('drop', { clientX: 0, ctrlKey: false, dataTransfer: dropData });
  assert.equal(allowed, false, 'not a drop target');
  assert.equal(run.frames.length, 2); assert.equal(jump.frames.length, 1);
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
  nums()[0].fire('dragstart', { dataTransfer: dragData });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: dropData });
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
      nums()[0].fire('dragstart', { dataTransfer: dragData });
      nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: dropData });
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
      nums()[0].fire('dragstart', { dataTransfer: dragData });
      nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: dropData });
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
  nums()[0].fire('dragstart', { dataTransfer: dragData });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: true, dataTransfer: dropData });
  assert.equal(run.layout, 'auto'); assert.equal(run.frames.length, 3);
  host.history.undo();
  assert.equal(run.layout, 'manual'); assert.equal(run.frames.length, 2);
  assert.deepEqual(run.frames.map(e => e.frameId), [a.id, b.id]);
});

test('accepting the offer and reordering is one undo step', async () => {
  const { run, a, b } = await reset();
  run.layout = 'manual'; run.cell = null; host.history.execute({ do() {}, undo() {} }); await tick();
  nums()[0].fire('dragstart', { dataTransfer: dragData });
  nums()[1].fire('drop', { clientX: 200, ctrlKey: false, dataTransfer: dropData });
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
