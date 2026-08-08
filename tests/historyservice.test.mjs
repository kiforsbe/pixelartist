import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';

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

test('HistoryService can own an existing compatibility stack without dirtying on reset', () => {
  const store = new EditorStore();
  const stack = new CommandStack();
  const history = new HistoryService({ store, stack });
  let value = 0;
  stack.push({ do: () => { value++; }, undo: () => { value--; } });
  assert.equal(history.canUndo(), true);
  assert.equal(store.getState().project.dirty, true);
  store.markDirty(false);
  history.clear();
  assert.equal(history.canUndo(), false);
  assert.equal(store.getState().project.dirty, false);
});
