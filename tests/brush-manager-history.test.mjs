import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary } from '../js/features/brushes/brush-library.js';
import { createBrushHistory } from '../js/features/brushes/brush-manager.js';

function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
}

test('a rename undoes and redoes on the local stack', () => {
  const lib = createBrushLibrary(fakePrefs());
  const history = createBrushHistory();
  const brush = normalizeBrush({ name: 'Before' });
  lib.add(brush);
  history.run({
    label: 'rename',
    redo: () => lib.update({ ...lib.get(brush.id), name: 'After' }),
    undo: () => lib.update({ ...lib.get(brush.id), name: 'Before' }),
  });
  assert.equal(lib.get(brush.id).name, 'After');
  history.undo();
  assert.equal(lib.get(brush.id).name, 'Before');
  history.redo();
  assert.equal(lib.get(brush.id).name, 'After');
});

test('canUndo and canRedo track the stack', () => {
  const history = createBrushHistory();
  assert.equal(history.canUndo(), false);
  history.run({ label: 'noop', redo: () => {}, undo: () => {} });
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);
  history.undo();
  assert.equal(history.canRedo(), true);
});

test('clear empties the stack -- the dialog calls this on close', () => {
  const history = createBrushHistory();
  history.run({ label: 'noop', redo: () => {}, undo: () => {} });
  history.clear();
  assert.equal(history.canUndo(), false);
});

test('a new action after an undo drops the redo branch', () => {
  const history = createBrushHistory();
  history.run({ label: 'a', redo: () => {}, undo: () => {} });
  history.undo();
  history.run({ label: 'b', redo: () => {}, undo: () => {} });
  assert.equal(history.canRedo(), false);
});

test('undo on an empty stack is a no-op, not a throw', () => {
  const history = createBrushHistory();
  assert.doesNotThrow(() => history.undo());
  assert.doesNotThrow(() => history.redo());
});

// Amendment section 1: none of the five tests above would catch a
// double-execution -- they all assert a final *state*, which is identical
// whether the rename ran once or twice. Count the invocations instead.
test('run performs the command exactly once', () => {
  const history = createBrushHistory();
  let n = 0;
  history.run({ label: 'count', redo: () => { n += 1; }, undo: () => { n -= 1; } });
  assert.equal(n, 1);
});
