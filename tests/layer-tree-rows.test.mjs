// Layer rows through the real Layers panel / Animations timeline: pointer
// drag-reorder (tree and map layers), eye/lock solo and paint gestures, and
// the row context menu. Drags are driven on the fake DOM (no browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { animationsMode } from '../js/modes/animations/index.js';
import { tileMode } from '../js/modes/tiles/index.js';
import { mapMode } from '../js/modes/maps/index.js';
import { createProject, createSheet, createMap, sheetLayers, findNode, addFrame, addAnimation } from '../js/core/model.js';
import { mountLayersPanel } from '../js/components/panels/layers-panel.js';
import { mountAnimationTimeline } from '../js/modes/animations/presentation/animation-timeline-presenter.js';
import { closeContextMenu } from '../js/components/context-menu.js';

const { Element } = installSpriteContextDom();
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0', borderLeftWidth: '0', borderRightWidth: '0' });
// startRename swaps the name for an input in place.
Element.prototype.replaceWith ??= function (other) {
  const parent = this.parentElement;
  if (!parent) return;
  parent.children[parent.children.indexOf(this)] = other;
  other.parentElement = parent;
  this.parentElement = null;
};
Element.prototype.select ??= function () {};

const host = new EditorHost();
setEditorHost(host);
for (const mode of [spriteMode, animationsMode, tileMode, mapMode]) host.registerMode(mode);
host.start('sprites');
const panel = new Element();
document.body.append(panel);
mountLayersPanel(panel);
const dock = new Element();
document.body.append(dock);
mountAnimationTimeline(dock);

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const exec = (id, args) => host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
const ev = (type, props = {}) => Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, ...props });
const list = () => panel.querySelector('.layer-list');
const ROW = 22; // rows are 20 px with a 2 px gap
function layout(container, selector) {
  const items = container.querySelectorAll(selector);
  items.forEach((el, i) => { el.rect = { left: 0, top: i * ROW, width: 200, height: 20 }; });
  return items;
}
// Presses `item`, drags to y (inside the row grid), releases.
function drag(item, y) {
  const top = item.rect.top;
  item.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 10, clientY: top + 5 });
  window.dispatchEvent(ev('pointermove', { clientX: 10, clientY: y }));
  window.dispatchEvent(ev('pointerup', { clientX: 10, clientY: y }));
}
const rowIds = () => list().querySelectorAll('.layer-row').map(r => r.dataset.nodeId);
const rowOf = id => list().querySelectorAll('.layer-row').find(r => r.dataset.nodeId === id);
const eyeOf = id => rowOf(id).querySelectorAll('button').find(b => b.title === 'Toggle visibility');
const lockOf = id => rowOf(id).querySelectorAll('button').find(b => /lock layer/i.test(b.title));

// Root children [l1, l2, l3]: shown top to bottom l3, l2, l1.
async function flatSheet() {
  const project = createProject('Rows');
  const sheet = createSheet(project, { name: 'S', width: 4, height: 4, kind: 'sprite' });
  host.activateMode('sprites');
  host.setProject(project);
  const l1 = sheetLayers(sheet)[0].id;
  const l2 = exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: null });
  const l3 = exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: null });
  host.history.clear();
  await tick();
  return { sheet, l1, l2, l3 };
}

test('dropping below a row lands visually below it (inversion regression)', async () => {
  const { sheet, l1, l2, l3 } = await flatSheet();
  assert.deepEqual(rowIds(), [l3, l2, l1]);
  const items = layout(list(), '.layer-tree-item');
  drag(items[0], ROW + 15); // lower half of l2
  assert.deepEqual(rowIds(), [l2, l3, l1]);
  assert.deepEqual(sheet.layerTree.children.map(n => n.id), [l1, l3, l2]);
  host.history.undo();
  assert.deepEqual(rowIds(), [l3, l2, l1], 'one undo step');

  drag(layout(list(), '.layer-tree-item')[2], 3); // l1 above l3
  assert.deepEqual(rowIds(), [l1, l3, l2]);
});

test('a drop on the dragged row itself, or the slot it already has, changes nothing', async () => {
  const { l1, l2, l3 } = await flatSheet();
  let items = layout(list(), '.layer-tree-item');
  drag(items[1], ROW + 14); // within l2 itself
  items = layout(list(), '.layer-tree-item');
  drag(items[1], 16); // below l3 = where l2 already is
  assert.deepEqual(rowIds(), [l3, l2, l1]);
  assert.equal(host.history.canUndo(), false);
});

test('a drop below the last row goes to the bottom of the root, outside any open group', async () => {
  const { sheet, l1 } = await flatSheet();
  const g = exec('sprites.addGroup', { sheetId: sheet.id, targetGroupId: null });
  const a = exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: g });
  const b = exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: g });
  // The group goes to the root bottom: shown ..., g, b, a (a is the last row).
  exec('sprites.dragMoveNode', { sheetId: sheet.id, nodeId: g, destParentId: null, destIndex: 0 });
  host.history.clear();
  await tick();
  const ids = rowIds();
  assert.deepEqual(ids.slice(-3), [g, b, a]);
  const items = layout(list(), '.layer-tree-item');
  assert.equal(items.length, ids.length + 1, 'the empty space below the rows is a drop target');
  drag(items[0], items.length * ROW + 40); // far below the last row
  assert.equal(rowIds().at(-1), items[0].dataset.nodeId);
  assert.equal(sheet.layerTree.children[0].id, items[0].dataset.nodeId, 'root, index 0 in model order');
  assert.ok(findNode(sheet.layerTree, g).children.every(n => n.id !== items[0].dataset.nodeId));
  assert.ok(l1);
});

test('a group cannot be dropped into its own subtree', async () => {
  const { sheet } = await flatSheet();
  const g = exec('sprites.addGroup', { sheetId: sheet.id, targetGroupId: null });
  exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: g });
  host.history.clear();
  await tick();
  const before = rowIds();
  const items = layout(list(), '.layer-tree-item');
  assert.equal(items[0].dataset.nodeId, g);
  drag(items[0], ROW + 15); // below its own child
  assert.deepEqual(rowIds(), before);
  assert.equal(host.history.canUndo(), false);
});

test('rows are not native-draggable', async () => {
  await flatSheet();
  assert.ok(list().querySelectorAll('.layer-row').every(r => r.draggable !== true));
});

test('map layers reorder by dragging (one maps.moveLayer step)', async () => {
  const project = createProject('Map');
  const map = createMap(project, { name: 'Map' });
  host.activateMode('maps');
  host.setProject(project);
  exec('maps.addLayer', { mapId: map.id, type: 'tile' });
  exec('maps.addLayer', { mapId: map.id, type: 'tile' });
  host.history.clear();
  await tick();
  const [t0, t1, t2] = map.layers.map(l => l.id);
  const items = layout(list(), '.map-layer-row');
  assert.equal(items.length, 3);
  drag(items[0], ROW + 15); // top row (t2) below t1
  assert.deepEqual(map.layers.map(l => l.id), [t0, t2, t1]);
  host.history.undo();
  assert.deepEqual(map.layers.map(l => l.id), [t0, t1, t2]);
  assert.equal(host.history.canUndo(), false);
  host.activateMode('sprites');
});

test('Alt-click an eye solos the layer; Alt-click again restores, each one undo step', async () => {
  const { sheet, l1, l2, l3 } = await flatSheet();
  exec('sprites.toggleLayerVisible', { sheetId: sheet.id, layerId: l2 });
  host.history.clear();
  const visibility = () => [l1, l2, l3].map(id => findNode(sheet.layerTree, id).visible);
  assert.deepEqual(visibility(), [true, false, true]);
  eyeOf(l1).dispatch('pointerdown', { pointerId: 1, button: 0, altKey: true });
  window.dispatchEvent(ev('pointerup'));
  assert.deepEqual(visibility(), [true, false, false]);
  host.history.undo();
  assert.deepEqual(visibility(), [true, false, true], 'solo is one undo step');
  assert.equal(host.history.canUndo(), false);
  host.history.redo();
  eyeOf(l1).dispatch('pointerdown', { pointerId: 1, button: 0, altKey: true });
  window.dispatchEvent(ev('pointerup'));
  assert.deepEqual(visibility(), [true, false, true], 'restored to the visibility saved at solo time');
  host.history.undo();
  assert.deepEqual(visibility(), [true, false, false], 'restore is one undo step');
});

test('pressing an eye and dragging across others paints that state, as one undo step', async () => {
  const { sheet, l1, l2, l3 } = await flatSheet();
  const visibility = () => [l1, l2, l3].map(id => findNode(sheet.layerTree, id).visible);
  eyeOf(l3).dispatch('pointerdown', { pointerId: 1, button: 0 });
  assert.deepEqual(visibility(), [true, true, false], 'the press toggles at once');
  eyeOf(l2).fire('pointerenter', { pointerId: 1, buttons: 1 });
  eyeOf(l3).fire('pointerenter', { pointerId: 1, buttons: 1 }); // back over the first: stays hidden
  eyeOf(l1).fire('pointerenter', { pointerId: 1, buttons: 1 });
  window.dispatchEvent(ev('pointerup'));
  eyeOf(l1).fire('click', { detail: 1 }); // the press already toggled
  assert.deepEqual(visibility(), [false, false, false]);
  eyeOf(l2).fire('pointerenter', { pointerId: 1, buttons: 1 }); // gesture over: nothing
  assert.deepEqual(visibility(), [false, false, false]);
  host.history.undo();
  assert.deepEqual(visibility(), [true, true, true]);
  assert.equal(host.history.canUndo(), false, 'the whole gesture is one step');
  // A keyboard click (detail 0) still toggles.
  eyeOf(l2).fire('click', { detail: 0 });
  assert.deepEqual(visibility(), [true, false, true]);
});

test('dragging across locks paints the lock state, as one undo step', async () => {
  const { sheet, l1, l2, l3 } = await flatSheet();
  const locked = () => [l1, l2, l3].map(id => !!findNode(sheet.layerTree, id).locked);
  lockOf(l1).dispatch('pointerdown', { pointerId: 1, button: 0 });
  lockOf(l2).fire('pointerenter', { pointerId: 1, buttons: 1 });
  eyeOf(l3).fire('pointerenter', { pointerId: 1, buttons: 1 }); // an eye is not part of a lock gesture
  window.dispatchEvent(ev('pointerup'));
  assert.deepEqual(locked(), [true, true, false]);
  host.history.undo();
  assert.deepEqual(locked(), [false, false, false]);
  assert.equal(host.history.canUndo(), false);
});

test('hovering an eye without the primary button pressed does not paint and ends the gesture', async () => {
  const { sheet, l1, l2, l3 } = await flatSheet();
  const visibility = () => [l1, l2, l3].map(id => findNode(sheet.layerTree, id).visible);
  eyeOf(l3).dispatch('pointerdown', { pointerId: 1, button: 0 });
  // The pointerup was missed (e.g. released outside the window).
  eyeOf(l2).fire('pointerenter', { pointerId: 1, buttons: 0 });
  assert.deepEqual(visibility(), [true, true, false], 'no paint without the button down');
  eyeOf(l1).fire('pointerenter', { pointerId: 1, buttons: 1 });
  assert.deepEqual(visibility(), [true, true, false], 'the gesture ended');
  // An unrelated edit, then a stray pointerup: not folded into the paint step.
  exec('sprites.toggleLayerLocked', { sheetId: sheet.id, layerId: l1 });
  window.dispatchEvent(ev('pointerup'));
  host.history.undo();
  assert.equal(!!findNode(sheet.layerTree, l1).locked, false, 'undo restores the unrelated edit');
  assert.deepEqual(visibility(), [true, true, false], '... and only it');
  host.history.undo();
  assert.deepEqual(visibility(), [true, true, true]);
  assert.equal(host.history.canUndo(), false);
});

test('losing window focus ends the paint gesture; later edits stay their own undo steps', async () => {
  const { sheet, l1, l2, l3 } = await flatSheet();
  const visibility = () => [l1, l2, l3].map(id => findNode(sheet.layerTree, id).visible);
  eyeOf(l3).dispatch('pointerdown', { pointerId: 1, button: 0 });
  eyeOf(l2).fire('pointerenter', { pointerId: 1, buttons: 1 });
  assert.deepEqual(visibility(), [true, false, false]);
  window.dispatchEvent(new Event('blur')); // Alt-Tab while pressing: the pointerup never comes
  eyeOf(l1).fire('pointerenter', { pointerId: 1, buttons: 1 });
  assert.deepEqual(visibility(), [true, false, false], 'the gesture ended on blur');
  exec('sprites.toggleLayerLocked', { sheetId: sheet.id, layerId: l1 });
  window.dispatchEvent(ev('pointerup'));
  host.history.undo();
  assert.equal(!!findNode(sheet.layerTree, l1).locked, false, 'undo restores only the unrelated edit');
  assert.deepEqual(visibility(), [true, false, false]);
  host.history.undo();
  assert.deepEqual(visibility(), [true, true, true], 'the paint is one step of its own');
  assert.equal(host.history.canUndo(), false);
});

const menu = () => document.body.querySelector('.context-menu');
const menuLabels = () => menu().querySelectorAll('button').map(b => b.children[0].textContent);
const menuItem = label => menu().querySelectorAll('button').find(b => b.children[0].textContent === label);

test('right-clicking a row selects it and opens the layer context menu', async () => {
  const { sheet, l1, l2 } = await flatSheet();
  const event = rowOf(l1).dispatch('contextmenu', { clientX: 20, clientY: 30 });
  assert.equal(event.defaultPrevented, true);
  assert.equal(host.selections.get().layerId, l1);
  assert.deepEqual(menuLabels(), ['Rename…', 'Add Layer', 'Add Group', 'Merge Down', 'Delete Layer']);
  menuItem('Delete Layer').fire('click');
  assert.equal(menu(), null, 'running an item closes the menu');
  assert.equal(findNode(sheet.layerTree, l1), null);

  rowOf(l2).dispatch('contextmenu', { clientX: 20, clientY: 30 });
  await tick();
  menuItem('Rename…').fire('click');
  const input = rowOf(l2).querySelector('input');
  assert.ok(input && input.className === 'layer-rename-input', 'rename starts inline on that row');
  closeContextMenu();
});

test('the timeline rows drag with the same mapping and no empty-space target', async () => {
  const project = createProject('Timeline');
  const sheet = createSheet(project, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const f = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const anim = addAnimation(sheet, 'Run');
  Object.assign(anim, { layout: 'auto', cell: { w: 8, h: 8 }, frames: [{ frameId: f.id, duration: null }] });
  host.setProject(project);
  host.activateMode('animations');
  const l1 = sheetLayers(sheet)[0].id;
  const l2 = exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: null });
  const l3 = exec('sprites.addLayer', { sheetId: sheet.id, targetGroupId: null });
  host.history.clear();
  await tick();
  const box = dock.querySelector('.anim-tl-layers');
  const items = layout(box, '.layer-tree-item');
  assert.deepEqual(items.map(r => r.dataset.nodeId), [l3, l2, l1], 'no end target in the timeline');
  drag(items[0], ROW + 15);
  assert.deepEqual(sheet.layerTree.children.map(n => n.id), [l1, l3, l2]);
  host.activateMode('sprites');
});
