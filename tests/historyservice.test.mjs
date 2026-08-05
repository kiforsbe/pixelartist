import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/application/editor-store.js';
import { HistoryService } from '../js/application/history-service.js';

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
