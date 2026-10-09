// Ordering operations on the brush library: positional insert and move.
//
// Order is the library's only organising axis -- there are no folders or
// tags -- and until now it was append-only. Every brush landed at the end,
// and an undone Delete re-appended rather than restoring the position it was
// removed from, so undo silently reordered the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary } from '../js/features/brushes/brush-library.js';

// Same JSON-boundary fake as brush-library.test.mjs: values must survive a
// real serialization round trip, not be held by reference.
function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? JSON.parse(store.get(k)) : d),
    set: (k, v) => store.set(k, JSON.stringify(v)),
    remove: (k) => store.delete(k),
  };
}

// A library of exactly four NAMED brushes, so every assertion below reads as
// an order rather than as indices into an anonymous list.
function libOf(...names) {
  const lib = createBrushLibrary(fakePrefs());
  lib.replaceAll(names.map(name => normalizeBrush({ name })));
  return lib;
}

const order = lib => lib.list().map(b => b.name);
const idOf = (lib, name) => lib.list().find(b => b.name === name).id;

test('add appends when given no position, exactly as before', () => {
  // The regression guard: every existing caller -- import, capture-from-
  // selection, the built-in seed -- calls add() with one argument.
  const lib = libOf('A', 'B');
  lib.add(normalizeBrush({ name: 'C' }));
  assert.deepEqual(order(lib), ['A', 'B', 'C']);
});

test('add inserts at a given position', () => {
  const lib = libOf('A', 'B', 'C');
  lib.add(normalizeBrush({ name: 'X' }), 1);
  assert.deepEqual(order(lib), ['A', 'X', 'B', 'C']);
  // Position 0 is a real slot, not a falsy one -- `at || list.length` would
  // send this to the end.
  lib.add(normalizeBrush({ name: 'Y' }), 0);
  assert.deepEqual(order(lib), ['Y', 'A', 'X', 'B', 'C']);
});

test('a position that names no slot appends rather than throwing or dropping', () => {
  const lib = libOf('A', 'B');
  lib.add(normalizeBrush({ name: 'C' }), 99);
  lib.add(normalizeBrush({ name: 'D' }), -3);   // clamps to the front
  lib.add(normalizeBrush({ name: 'E' }), 1.5);  // not an integer: appends
  lib.add(normalizeBrush({ name: 'F' }), null);
  assert.deepEqual(order(lib), ['D', 'A', 'B', 'C', 'E', 'F']);
});

test('move reorders in place and reports whether anything moved', () => {
  const lib = libOf('A', 'B', 'C', 'D');
  assert.equal(lib.move(idOf(lib, 'C'), 0), true);
  assert.deepEqual(order(lib), ['C', 'A', 'B', 'D']);

  // Rightwards, which is the direction a splice-out/splice-in pair gets
  // wrong if `to` is read against the list AFTER the removal.
  assert.equal(lib.move(idOf(lib, 'C'), 2), true);
  assert.deepEqual(order(lib), ['A', 'B', 'C', 'D']);
});

test('move is a no-op at either end and reports it, so no undo step is pushed', () => {
  const lib = libOf('A', 'B', 'C');
  assert.equal(lib.move(idOf(lib, 'A'), -1), false);
  assert.equal(lib.move(idOf(lib, 'C'), 99), false);
  assert.equal(lib.move(idOf(lib, 'B'), 1), false, 'moving to its own index moved nothing');
  assert.equal(lib.move('no-such-id', 0), false);
  assert.deepEqual(order(lib), ['A', 'B', 'C']);
});

test('move and positional add persist through the preferences store', () => {
  // Order is what these operations exist to change, and it only counts if it
  // survives a reload -- `save()` writes the whole list, so an operation that
  // mutated a copy instead of the live array would pass every assertion above
  // and lose the reorder the moment the dialog closed.
  const prefs = fakePrefs();
  const a = createBrushLibrary(prefs);
  a.replaceAll(['A', 'B', 'C'].map(name => normalizeBrush({ name })));
  a.move(a.list().find(b => b.name === 'C').id, 0);
  a.add(normalizeBrush({ name: 'X' }), 2);

  const b = createBrushLibrary(prefs);
  assert.deepEqual(b.list().map(x => x.name), ['C', 'A', 'X', 'B']);
});

test('move notifies subscribers, since the grid repaints from that alone', () => {
  // brush-manager binds its grid to lib.subscribe and deliberately does NOT
  // call refreshGrid() at any mutation site -- a mutation that skipped the
  // notification would reorder the stored list while the dialog kept showing
  // the old order.
  const lib = libOf('A', 'B', 'C');
  let notified = 0;
  lib.subscribe(() => { notified++; });

  lib.move(idOf(lib, 'C'), 0);
  assert.equal(notified, 1);
  lib.add(normalizeBrush({ name: 'X' }), 1);
  assert.equal(notified, 2);

  // A refused move must not notify either: a repaint with nothing to repaint
  // is the symptom of a no-op that still wrote.
  lib.move(idOf(lib, 'C'), 0);
  assert.equal(notified, 2);
});

test('indexOf locates a brush and reports -1 for one that is absent', () => {
  const lib = libOf('A', 'B', 'C');
  assert.equal(lib.indexOf(idOf(lib, 'B')), 1);
  assert.equal(lib.indexOf('no-such-id'), -1);
});

test('a delete-then-undo round trip restores the original position', () => {
  // The manager's Delete/undo pair in miniature: capture the index, remove,
  // then add it back at that index. This is the behaviour README-BRUSHES
  // listed as a known limitation.
  const lib = libOf('A', 'B', 'C', 'D');
  const id = idOf(lib, 'B');
  const at = lib.indexOf(id);
  const removed = structuredClone(lib.get(id));

  lib.remove(id);
  assert.deepEqual(order(lib), ['A', 'C', 'D']);

  lib.add(removed, at);
  assert.deepEqual(order(lib), ['A', 'B', 'C', 'D']);
  // And it is the same brush, not a fresh one -- undo has to restore the
  // edited state the user had, which is why the manager clones the whole
  // brush rather than keeping just the id.
  assert.equal(lib.get(id).name, 'B');
});
