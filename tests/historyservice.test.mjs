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
