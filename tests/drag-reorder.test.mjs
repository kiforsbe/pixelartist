import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { moveNode } from '../js/core/model.js';
import {
  attachDragReorder, computePlacement, slotToFinalIndex, isNoOpDrop, placementSlot, treeDropDestination,
} from '../js/components/drag-reorder.js';

const { stepAnimationFrames } = installSpriteContextDom();

// ------------------------------------------------------------------ pure

// Rows 20 px tall with a 2 px gap: row i spans [22i, 22i + 20).
const rowRects = n => Array.from({ length: n }, (_, i) => ({ left: 0, top: i * 22, width: 100, height: 20 }));
const colRects = n => Array.from({ length: n }, (_, i) => ({ left: i * 32, top: 0, width: 30, height: 20 }));

test('computePlacement splits flat rows at their halves', () => {
  const rects = rowRects(3);
  assert.deepEqual(computePlacement(rects, { x: 5, y: 3 }, 'y'), { index: 0, place: 'before' });
  assert.deepEqual(computePlacement(rects, { x: 5, y: 15 }, 'y'), { index: 0, place: 'after' });
  assert.deepEqual(computePlacement(rects, { x: 5, y: 23 }, 'y'), { index: 1, place: 'before' });
});

test('computePlacement clamps outside the list to the first and last items', () => {
  const rects = rowRects(3);
  assert.deepEqual(computePlacement(rects, { x: 5, y: -40 }, 'y'), { index: 0, place: 'before' });
  assert.deepEqual(computePlacement(rects, { x: 5, y: 500 }, 'y'), { index: 2, place: 'after' });
  assert.equal(computePlacement([], { x: 0, y: 0 }, 'y'), null);
});

test('computePlacement snaps a point in a gap to the nearest item', () => {
  const rects = [{ left: 0, top: 0, width: 100, height: 20 }, { left: 0, top: 30, width: 100, height: 20 }];
  assert.deepEqual(computePlacement(rects, { x: 5, y: 22 }, 'y'), { index: 0, place: 'after' });
  assert.deepEqual(computePlacement(rects, { x: 5, y: 28 }, 'y'), { index: 1, place: 'before' });
});

test('computePlacement on the x axis reads the horizontal position', () => {
  const rects = colRects(3);
  assert.deepEqual(computePlacement(rects, { x: 40, y: 500 }, 'x'), { index: 1, place: 'before' });
  assert.deepEqual(computePlacement(rects, { x: 60, y: -5 }, 'x'), { index: 1, place: 'after' });
});

test('computePlacement in a tree uses thirds on groups and halves on leaves', () => {
  const rects = rowRects(2);
  const tree = [{ depth: 0, isGroup: true }, { depth: 1, isGroup: false }];
  assert.deepEqual(computePlacement(rects, { x: 0, y: 5 }, 'y', tree), { index: 0, place: 'before' });
  assert.deepEqual(computePlacement(rects, { x: 0, y: 10 }, 'y', tree), { index: 0, place: 'into' });
  assert.deepEqual(computePlacement(rects, { x: 0, y: 15 }, 'y', tree), { index: 0, place: 'after' });
  assert.deepEqual(computePlacement(rects, { x: 0, y: 29 }, 'y', tree), { index: 1, place: 'before' });
  assert.deepEqual(computePlacement(rects, { x: 0, y: 33 }, 'y', tree), { index: 1, place: 'after' });
});

test('placementSlot and slotToFinalIndex turn a placement into indexes', () => {
  assert.equal(placementSlot({ index: 2, place: 'before' }), 2);
  assert.equal(placementSlot({ index: 2, place: 'after' }), 3);
  assert.equal(placementSlot({ index: 2, place: 'into' }), null);
  assert.equal(slotToFinalIndex(0, 3), 2);
  assert.equal(slotToFinalIndex(3, 0), 0);
  assert.equal(slotToFinalIndex(1, 1), 1);
  assert.equal(slotToFinalIndex(1, 2), 1);
});

test('isNoOpDrop detects drops that leave the item where it is', () => {
  assert.equal(isNoOpDrop(2, { index: 2, place: 'before' }), true);
  assert.equal(isNoOpDrop(2, { index: 2, place: 'after' }), true);
  assert.equal(isNoOpDrop(2, { index: 1, place: 'after' }), true);
  assert.equal(isNoOpDrop(2, { index: 3, place: 'before' }), true);
  assert.equal(isNoOpDrop(2, { index: 1, place: 'before' }), false);
  assert.equal(isNoOpDrop(2, { index: 3, place: 'after' }), false);
  assert.equal(isNoOpDrop(2, null), true);
});

// ----------------------------------------------------------- tree helper

const leaf = id => ({ id, type: 'layer' });
const group = (id, children, open = true) => ({ id, type: 'group', open, children });
// Same order as layer-tree.js layerTreeRows: last child first.
function rowsOf(root) {
  const rows = [];
  (function walk(g, depth) {
    for (let i = g.children.length - 1; i >= 0; i--) {
      const node = g.children[i];
      rows.push({ node, depth });
      if (node.type === 'group' && node.open !== false) walk(node, depth + 1);
    }
  })(root, 0);
  return rows;
}
const ids = root => rowsOf(root).map(r => r.node.id);
const rowIndex = (root, id) => ids(root).indexOf(id);
function drop(root, sourceId, targetId, place) {
  const rows = rowsOf(root);
  const dest = treeDropDestination(root, rows, sourceId, { index: rowIndex(root, targetId), place });
  if (dest && !dest.noOp) moveNode({ layerTree: root }, sourceId, dest.destParentId ?? root.id, dest.destIndex);
  return dest;
}

test('treeDropDestination: dropping below a row lands visually below it (inversion regression)', () => {
  // Shown top to bottom: A, B, C (children stored bottom first).
  let root = group('root', [leaf('C'), leaf('B'), leaf('A')]);
  const dest = treeDropDestination(root, rowsOf(root), 'A', { index: rowIndex(root, 'B'), place: 'after' });
  assert.deepEqual(dest, { destParentId: null, destIndex: 1, noOp: false }); // B's own child index, not +1
  drop(root, 'A', 'B', 'after');
  assert.deepEqual(ids(root), ['B', 'A', 'C']);

  root = group('root', [leaf('C'), leaf('B'), leaf('A')]);
  drop(root, 'C', 'A', 'after');
  assert.deepEqual(ids(root), ['A', 'C', 'B']);

  root = group('root', [leaf('C'), leaf('B'), leaf('A')]);
  drop(root, 'C', 'A', 'before');
  assert.deepEqual(ids(root), ['C', 'A', 'B']);

  root = group('root', [leaf('C'), leaf('B'), leaf('A')]);
  drop(root, 'A', 'C', 'before');
  assert.deepEqual(ids(root), ['B', 'A', 'C']);
});

test('treeDropDestination: a drop on itself or the slot it already has is a no-op', () => {
  const root = group('root', [leaf('C'), leaf('B'), leaf('A')]);
  const rows = rowsOf(root);
  for (const [target, place] of [['B', 'before'], ['B', 'after'], ['A', 'after'], ['C', 'before']]) {
    const dest = treeDropDestination(root, rows, 'B', { index: rowIndex(root, target), place });
    assert.equal(dest.noOp, true, `${target} ${place}`);
  }
  assert.deepEqual(ids(root), ['A', 'B', 'C']);
});

test('treeDropDestination: into a group puts the node at its top', () => {
  const root = group('root', [leaf('L'), group('G', [leaf('g0'), leaf('g1')])]);
  const dest = drop(root, 'L', 'G', 'into');
  assert.deepEqual(dest, { destParentId: 'G', destIndex: 2, noOp: false });
  assert.deepEqual(ids(root), ['G', 'L', 'g1', 'g0']);
});

test('treeDropDestination: below an expanded group goes into it first', () => {
  const root = group('root', [leaf('L'), group('G', [leaf('g0'), leaf('g1')])]);
  const dest = drop(root, 'L', 'G', 'after');
  assert.equal(dest.destParentId, 'G');
  assert.deepEqual(ids(root), ['G', 'L', 'g1', 'g0']);
});

test('treeDropDestination: below a collapsed group stays a sibling', () => {
  const root = group('root', [leaf('L'), group('G', [leaf('g0')], false), leaf('T')]);
  drop(root, 'T', 'G', 'after');
  assert.deepEqual(rowsOf(root).map(r => r.node.id), ['G', 'T', 'L']);
});

test('treeDropDestination: moves out of a group to the root', () => {
  const root = group('root', [leaf('L'), group('G', [leaf('g0'), leaf('g1')])]);
  drop(root, 'g0', 'L', 'before');
  assert.deepEqual(root.children.map(n => n.id), ['L', 'g0', 'G']);
  assert.deepEqual(ids(root), ['G', 'g1', 'g0', 'L']);
});

test('treeDropDestination refuses a group into itself or its descendants', () => {
  const root = group('root', [leaf('L'), group('G', [leaf('g0'), group('H', [leaf('h0')])])]);
  const rows = rowsOf(root);
  assert.equal(treeDropDestination(root, rows, 'G', { index: rowIndex(root, 'H'), place: 'into' }), null);
  assert.equal(treeDropDestination(root, rows, 'G', { index: rowIndex(root, 'h0'), place: 'after' }), null);
  assert.equal(treeDropDestination(root, rows, 'G', { index: rowIndex(root, 'G'), place: 'into' }).noOp, true);
  assert.equal(treeDropDestination(root, rows, 'missing', { index: 0, place: 'before' }), null);
  assert.equal(treeDropDestination(root, rows, 'L', { index: 99, place: 'before' }), null);
});

// ------------------------------------------------------------- component

const ev = (type, props = {}) => Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, button: 0, ...props });

// A list of `n` rows (20 px tall, 2 px gap), each holding a <span> and a
// <button>, attached to document.body.
function makeList(n, { rowsAt = i => ({ left: 0, top: i * 22, width: 100, height: 20 }) } = {}) {
  const container = document.createElement('div');
  container.rect = { left: 0, top: 0, width: 100, height: 22 * n };
  const items = [];
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.dragKey = `k${i}`;
    row.rect = rowsAt(i);
    const label = document.createElement('span');
    const button = document.createElement('button');
    row.append(label, button);
    container.append(row);
    items.push(row);
  }
  document.body.append(container);
  return { container, items };
}
const lines = () => document.body.querySelectorAll('.dr-line');
const down = (el, x, y, props = {}) => el.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: x, clientY: y, ...props });
const move = (x, y, props = {}) => window.dispatchEvent(ev('pointermove', { clientX: x, clientY: y, ...props }));
const up = (x, y, props = {}) => window.dispatchEvent(ev('pointerup', { clientX: x, clientY: y, ...props }));

test('a press released below the threshold is a click, not a drag', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[0], 10, 5);
  move(12, 7);
  assert.equal(lines().length, 0);
  assert.equal(items[0].classList.contains('dr-lifted'), false);
  up(12, 7);
  assert.equal(drops.length, 0);
  let prevented = false;
  container.fire('click', { preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  dispose();
});

test('dragging past the threshold lifts the source and draws one line between rows', () => {
  const { container, items } = makeList(4);
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop() {} });
  down(items[0].children[0], 10, 5);
  move(10, 60); // lower half of row 2 -> after row 2
  assert.equal(items[0].classList.contains('dr-lifted'), true);
  assert.equal(container.classList.contains('dr-active'), true);
  assert.equal(lines().length, 1);
  const line = lines()[0];
  assert.equal(line.hidden, false);
  assert.equal(line.style.top, '65px'); // middle of the gap between rows 2 and 3
  assert.equal(line.style.left, '0px');
  assert.equal(line.style.width, '100px');
  window.dispatchEvent(ev('keydown', { key: 'Escape' }));
  dispose();
});

test('a drop calls onDrop once with the placement, then cleans up', () => {
  const { container, items } = makeList(4);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[0], 10, 5);
  move(10, 60);
  up(10, 60);
  assert.deepEqual(drops, [{ sourceKey: 'k0', targetKey: 'k2', sourceIndex: 0, index: 2, place: 'after', slot: 3, modifiers: {} }]);
  assert.equal(slotToFinalIndex(drops[0].sourceIndex, drops[0].slot), 2);
  assert.equal(lines().length, 0);
  assert.equal(items[0].classList.contains('dr-lifted'), false);
  assert.equal(container.classList.contains('dr-active'), false);
  // The click that follows the drop is swallowed.
  let prevented = false;
  container.fire('click', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  dispose();
});

test('Escape cancels the drag without dropping', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[0], 10, 5);
  move(10, 50);
  const key = ev('keydown', { key: 'Escape' });
  window.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(lines().length, 0);
  assert.equal(items[0].classList.contains('dr-lifted'), false);
  up(10, 50);
  assert.equal(drops.length, 0);
  dispose();
});

test('pointercancel cancels the drag', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[0], 10, 5);
  move(10, 50);
  window.dispatchEvent(ev('pointercancel'));
  assert.equal(lines().length, 0);
  up(10, 50);
  assert.equal(drops.length, 0);
  dispose();
});

test('canDrop false marks the drop invalid and drops nothing', () => {
  const { container, items } = makeList(3);
  const drops = [], asked = [];
  const dispose = attachDragReorder(container, {
    itemSelector: '.row',
    canDrop: (sourceKey, target) => { asked.push([sourceKey, target.targetKey, target.place]); return false; },
    onDrop: p => drops.push(p),
  });
  down(items[0].children[0], 10, 5);
  move(10, 50);
  assert.deepEqual(asked.at(-1), ['k0', 'k2', 'before']);
  assert.equal(lines()[0].classList.contains('dr-invalid'), true);
  assert.equal(container.classList.contains('dr-no-drop'), true);
  up(10, 50);
  assert.equal(drops.length, 0);
  assert.equal(container.classList.contains('dr-no-drop'), false);
  dispose();
});

test('dropping where the item already is does nothing and hides the line', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[1].children[0], 10, 27);
  move(10, 15); // lower half of row 0 = the slot row 1 already has
  assert.equal(lines()[0].hidden, true);
  assert.equal(container.classList.contains('dr-no-drop'), false);
  up(10, 15);
  assert.equal(drops.length, 0);
  dispose();
});

test('modifiers are reported, follow key changes and mark the line', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, {
    itemSelector: '.row',
    modifiers: e => ({ copy: !!e.altKey, link: !!e.ctrlKey }),
    onDrop: p => drops.push(p),
  });
  down(items[0].children[0], 10, 5);
  move(10, 50);
  assert.equal(lines()[0].classList.contains('dr-copy'), false);
  window.dispatchEvent(ev('keydown', { key: 'Alt', altKey: true }));
  assert.equal(lines()[0].classList.contains('dr-copy'), true);
  move(10, 50, { ctrlKey: true });
  assert.equal(lines()[0].classList.contains('dr-link'), true);
  assert.equal(lines()[0].classList.contains('dr-copy'), false);
  up(10, 50, { altKey: true });
  assert.deepEqual(drops[0].modifiers, { copy: true, link: false });
  dispose();
});

test('a press on an ignored control or outside the handle never drags', () => {
  const { container, items } = makeList(3);
  const drops = [];
  let dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[1], 10, 5); // the <button>
  move(10, 50);
  assert.equal(lines().length, 0);
  up(10, 50);
  dispose();

  for (const item of items) item.children[0].className = 'grip';
  dispose = attachDragReorder(container, { itemSelector: '.row', handleSelector: '.grip', ignoreSelector: null, onDrop: p => drops.push(p) });
  down(items[0].children[1], 10, 5); // not the grip
  move(10, 50);
  assert.equal(lines().length, 0);
  up(10, 50);
  down(items[0].children[0], 10, 5); // the grip
  move(10, 50);
  up(10, 50);
  assert.equal(drops.length, 1);
  dispose();
});

test('a non-primary button and a disposed list never drag', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[0], 10, 5, { button: 2 });
  move(10, 50);
  assert.equal(lines().length, 0);
  up(10, 50);
  dispose();
  down(items[0].children[0], 10, 5);
  move(10, 50);
  up(10, 50);
  assert.equal(lines().length, 0);
  assert.equal(drops.length, 0);
});

test('the source leaving the DOM cancels the drag', () => {
  const { container, items } = makeList(3);
  const drops = [];
  const dispose = attachDragReorder(container, { itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[0].children[0], 10, 5);
  move(10, 50);
  container.innerHTML = ''; // a re-render replaced the rows
  move(10, 55);
  assert.equal(lines().length, 0);
  up(10, 55);
  assert.equal(drops.length, 0);
  dispose();
});

test('the x axis draws a vertical line and reports column placements', () => {
  const { container, items } = makeList(3, { rowsAt: i => ({ left: i * 32, top: 0, width: 30, height: 20 }) });
  const drops = [];
  const dispose = attachDragReorder(container, { axis: 'x', itemSelector: '.row', onDrop: p => drops.push(p) });
  down(items[2].children[0], 70, 5);
  move(5, 5);
  const line = lines()[0];
  assert.equal(line.classList.contains('dr-x'), true);
  assert.equal(line.style.left, '0px');
  assert.equal(line.style.top, '0px');
  assert.equal(line.style.height, '20px');
  up(5, 5);
  assert.deepEqual(drops.map(d => [d.sourceKey, d.targetKey, d.place, d.slot]), [['k2', 'k0', 'before', 0]]);
  dispose();
});

test('tree mode marks a group row for into, indents the line, and refuses its own subtree', () => {
  // Rows: G (group, depth 0), g1 (1), g0 (1), L (0).
  const { container, items } = makeList(4);
  const depths = [0, 1, 1, 0];
  items.forEach((item, i) => { item.dataset.depth = String(depths[i]); });
  items[0].dataset.group = '1';
  const drops = [];
  const dispose = attachDragReorder(container, {
    itemSelector: '.row',
    tree: { depth: el => Number(el.dataset.depth), isGroup: el => el.dataset.group === '1' },
    onDrop: p => drops.push(p),
  });
  down(items[3].children[0], 10, 71);
  move(10, 10); // middle third of G
  assert.equal(items[0].classList.contains('dr-into'), true);
  assert.equal(lines()[0].hidden, true);
  move(10, 15); // bottom third of G: line indented into the open group
  assert.equal(items[0].classList.contains('dr-into'), false);
  assert.equal(lines()[0].style.left, '14px');
  assert.equal(lines()[0].style.width, '86px');
  move(10, 10);
  up(10, 10);
  assert.deepEqual(drops.map(d => [d.sourceKey, d.targetKey, d.place]), [['k3', 'k0', 'into']]);
  assert.equal(items[0].classList.contains('dr-into'), false);

  // Dragging the group itself over its own child is invalid.
  down(items[0].children[0], 10, 5);
  move(10, 40);
  assert.equal(lines()[0].classList.contains('dr-invalid'), true);
  up(10, 40);
  assert.equal(drops.length, 1);
  dispose();
});

test('auto-scrolls the scroller near its edge and re-measures', () => {
  const { container, items } = makeList(3);
  const scroller = document.createElement('div');
  scroller.rect = { left: 0, top: 0, width: 100, height: 66 };
  const dispose = attachDragReorder(container, { itemSelector: '.row', scroller, onDrop() {} });
  down(items[0].children[0], 10, 5);
  move(10, 62); // 4 px from the bottom edge
  assert.equal(stepAnimationFrames(), 1);
  assert.ok(scroller.scrollTop > 0);
  const after = scroller.scrollTop;
  move(10, 30); // away from the edges: the loop stops
  stepAnimationFrames();
  assert.equal(stepAnimationFrames(), 0);
  assert.equal(scroller.scrollTop, after);
  window.dispatchEvent(ev('keydown', { key: 'Escape' }));
  dispose();
});
