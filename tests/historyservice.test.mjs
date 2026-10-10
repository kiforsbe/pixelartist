import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { HistoryService, PROJECT_SCOPE } from '../js/host/history-service.js';

test('HistoryService executes undoable edits separately from UI commands', () => {
  const store = new EditorStore();
  const history = new HistoryService({ store });
  let value = 0;
  history.execute({ label: 'increment', do: () => { value++; }, undo: () => { value--; } });
  assert.equal(value, 1);
  assert.equal(history.canUndo(), true);
  assert.equal(store.getState().project.dirty, true);
  history.undo();
  assert.equal(value, 0);
  history.redo();
  assert.equal(value, 1);
});

test('HistoryService.clear() suppresses the dirty flag unless markDirty is passed', () => {
  const store = new EditorStore();
  const history = new HistoryService({ store });
  let value = 0;
  history.execute({ do: () => { value++; }, undo: () => { value--; } });
  assert.equal(history.canUndo(), true);
  assert.equal(store.getState().project.dirty, true);
  store.markDirty(false);
  history.clear();
  assert.equal(history.canUndo(), false);
  assert.equal(store.getState().project.dirty, false);
});

// ---- per-document scoping ----
// Undo/redo must only ever touch the document the user is looking at; the
// old single global stack silently reverted edits on whatever sheet you had
// last touched, with no visible change on the canvas in front of you.

function scopedFixture() {
  const store = new EditorStore();
  const history = new HistoryService({ store });
  const log = [];
  const activate = (kind, id) => store.updateSession({ activeDocument: kind ? { kind, id } : null });
  const command = name => ({ label: name, do: () => log.push(`do:${name}`), undo: () => log.push(`undo:${name}`) });
  return { store, history, log, activate, command };
}

test('undo skips commands belonging to another document', () => {
  const { history, log, activate, command } = scopedFixture();
  activate('sprite-sheet', 'a');
  history.execute(command('a1'));
  activate('sprite-sheet', 'b');
  history.execute(command('b1'));

  history.undo();
  assert.deepEqual(log, ['do:a1', 'do:b1', 'undo:b1'], 'undo on B reverts B, never A');
  assert.equal(history.canUndo(), false, 'B has nothing left to undo');

  activate('sprite-sheet', 'a');
  assert.equal(history.canUndo(), true, "A's own edit is still undoable");
  history.undo();
  assert.deepEqual(log.at(-1), 'undo:a1');
});

test('redo is scoped the same way as undo', () => {
  const { history, log, activate, command } = scopedFixture();
  activate('sprite-sheet', 'a');
  history.execute(command('a1'));
  history.undo();
  activate('map', 'm');
  assert.equal(history.canRedo(), false, "A's undone edit is not redoable from another document");
  history.redo();
  activate('sprite-sheet', 'a');
  assert.equal(history.canRedo(), true);
  history.redo();
  assert.deepEqual(log, ['do:a1', 'undo:a1', 'do:a1']);
});

test('project-scoped commands stay undoable from any document', () => {
  const { history, log, activate, command } = scopedFixture();
  activate('sprite-sheet', 'a');
  history.execute(command('palette'), { scope: PROJECT_SCOPE });
  activate('map', 'm');
  assert.equal(history.canUndo(), true);
  history.undo();
  assert.deepEqual(log, ['do:palette', 'undo:palette']);
  history.redo();
  assert.deepEqual(log.at(-1), 'do:palette');
});

test('a new command drops only the redo entries visible from its own document', () => {
  const { history, activate, command } = scopedFixture();
  activate('sprite-sheet', 'a');
  history.execute(command('a1'));
  history.undo();
  activate('sprite-sheet', 'b');
  history.execute(command('b1'));
  history.undo();
  history.execute(command('b2'));
  assert.equal(history.canRedo(), false, "B's own redo was branched away");
  activate('sprite-sheet', 'a');
  assert.equal(history.canRedo(), true, "A's redo survived edits made in B");
});

test('with no active document everything shares the project scope', () => {
  const { history, log, command } = scopedFixture();
  history.execute(command('one'));
  history.undo();
  assert.deepEqual(log, ['do:one', 'undo:one']);
});



// ---- mark / combineSince / rollbackTo ----
// Position-based gesture helpers: mark() before a multi-command gesture, then
// either fold what it executed into one undo step or roll all of it back.

function valueCommand(box, label) {
  return { label, do: () => { box.log.push(`do:${label}`); box.value++; }, undo: () => { box.log.push(`undo:${label}`); box.value--; } };
}

test('combineSince folds the entries since the mark into one undo step, undone newest-first', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const box = { value: 0, log: [] };
  history.execute(valueCommand(box, 'before'));
  const token = history.mark();
  history.execute(valueCommand(box, 'a'));
  history.execute(valueCommand(box, 'b'));
  assert.equal(history.combineSince(token), true);
  box.log.length = 0;
  history.undo();
  assert.deepEqual(box.log, ['undo:b', 'undo:a']);
  history.redo();
  assert.deepEqual(box.log, ['undo:b', 'undo:a', 'do:a', 'do:b']);
  history.undo();
  assert.equal(history.canUndo(), true, 'the pre-mark entry stayed separate');
  history.undo();
  assert.equal(box.log.at(-1), 'undo:before');
  assert.equal(history.canUndo(), false);
});

test('combineSince returns false with nothing since the mark, true for a single entry', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const box = { value: 0, log: [] };
  const empty = history.mark();
  assert.equal(history.combineSince(empty), false);
  const token = history.mark();
  history.execute(valueCommand(box, 'only'));
  assert.equal(history.combineSince(token), true);
  history.undo();
  assert.equal(box.value, 0);
  assert.equal(history.canUndo(), false, 'one undo removed the single entry');
});

test('combineSince refuses when the entries since the mark span two scopes', () => {
  const { history, log, activate, command } = scopedFixture();
  activate('sprite-sheet', 'a');
  const token = history.mark();
  history.execute(command('proj'), { scope: PROJECT_SCOPE });
  history.execute(command('doc'));
  assert.equal(history.combineSince(token), false);
  log.length = 0;
  history.undo();
  assert.deepEqual(log, ['undo:doc'], 'entries were left separate');
  history.undo();
  assert.deepEqual(log, ['undo:doc', 'undo:proj']);
  assert.equal(history.canUndo(), false);
});

test('combineSince does not notify subscribers', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const token = history.mark();
  history.execute({ do() {}, undo() {} });
  history.execute({ do() {}, undo() {} });
  let calls = 0;
  history.subscribe(() => { calls++; });
  assert.equal(history.combineSince(token), true);
  assert.equal(calls, 0);
});

test('rollbackTo undoes and forgets the entries since the mark', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const box = { value: 0, log: [] };
  history.execute(valueCommand(box, 'before'));
  const token = history.mark();
  history.execute(valueCommand(box, 'a'));
  history.execute(valueCommand(box, 'b'));
  assert.equal(box.value, 3);
  box.log.length = 0;
  history.rollbackTo(token);
  assert.deepEqual(box.log, ['undo:b', 'undo:a']);
  assert.equal(box.value, 1);
  assert.equal(history.canRedo(), false, 'rolled-back entries are not redoable');
  history.undo();
  assert.equal(box.value, 0);
  assert.equal(history.canUndo(), false, 'only the pre-mark entry was undoable');
});

test('rollbackTo restores the redo entries visible at mark time', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const box = { value: 0, log: [] };
  history.execute(valueCommand(box, 'A'));
  history.undo();
  assert.equal(history.canRedo(), true);
  const token = history.mark();
  history.execute(valueCommand(box, 'B'));
  assert.equal(history.canRedo(), false, "B's execute dropped A's redo");
  history.rollbackTo(token);
  assert.equal(box.value, 0);
  assert.equal(history.canRedo(), true);
  history.redo();
  assert.equal(box.value, 1);
  assert.equal(box.log.at(-1), 'do:A');
});

test('rollbackTo restores the dirty flag to its value at the mark', () => {
  const store = new EditorStore();
  const history = new HistoryService({ store });
  store.markDirty(false);
  const clean = history.mark();
  history.execute({ do() {}, undo() {} });
  assert.equal(store.getState().project.dirty, true);
  history.rollbackTo(clean);
  assert.equal(store.getState().project.dirty, false);

  store.markDirty(true);
  const dirty = history.mark();
  history.execute({ do() {}, undo() {} });
  history.rollbackTo(dirty);
  assert.equal(store.getState().project.dirty, true);
});

test('rollbackTo notifies subscribers once, and not at all with nothing since the mark', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const idle = history.mark();
  let calls = 0;
  history.subscribe(() => { calls++; });
  history.rollbackTo(idle);
  assert.equal(calls, 0);
  const token = history.mark();
  history.execute({ do() {}, undo() {} });
  history.execute({ do() {}, undo() {} });
  calls = 0;
  history.rollbackTo(token);
  assert.equal(calls, 1);
});

test('marks survive the history limit trimming the oldest entries', () => {
  const history = new HistoryService({ store: new EditorStore(), limit: 3 });
  let value = 0;
  const inc = () => ({ do: () => { value++; }, undo: () => { value--; } });
  for (let i = 0; i < 3; i++) history.execute(inc()); // at the limit
  let token = history.mark();
  history.execute(inc()); history.execute(inc()); // each trims the oldest
  assert.equal(history.combineSince(token), true);
  history.undo();
  assert.equal(value, 3, 'one undo reverts both gesture entries');
  token = history.mark();
  history.execute(inc());
  history.rollbackTo(token);
  assert.equal(value, 3, 'a rollback still undoes the gesture');
});

test('a mark whose newest entry was trimmed by the limit still finds the gesture', () => {
  const history = new HistoryService({ store: new EditorStore(), limit: 2 });
  let value = 0;
  const inc = () => ({ do: () => { value++; }, undo: () => { value--; } });
  history.execute(inc()); history.execute(inc());
  const token = history.mark();
  history.execute(inc()); history.execute(inc()); // both pre-mark entries trimmed
  history.rollbackTo(token);
  assert.equal(value, 2);
});

test('an entry undone between the mark and a rollback is not rolled back again', () => {
  const history = new HistoryService({ store: new EditorStore() });
  const log = [];
  const entry = name => ({ do: () => log.push(`do ${name}`), undo: () => log.push(`undo ${name}`) });
  history.execute(entry('a')); history.execute(entry('b'));
  const token = history.mark();
  history.undo(); // b
  history.execute(entry('c'));
  log.length = 0;
  history.rollbackTo(token);
  assert.deepEqual(log, ['undo c'], 'only the entry executed since the mark');
  assert.equal(history.canUndo(), true, 'a is untouched');
});
