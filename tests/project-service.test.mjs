import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';

test('ProjectService.mutate applies a callback to the live project model and marks dirty', () => {
  const store = new EditorStore();
  store.setProject({ sheets: [] }, { dirty: false });
  const projects = new ProjectService(store, null);

  const result = projects.mutate('sheets.add', project => {
    project.sheets.push({ id: 'sheet-1' });
    return project.sheets.length;
  });

  assert.equal(result, 1);
  assert.deepEqual(store.getState().project.model.sheets, [{ id: 'sheet-1' }]);
  assert.equal(store.getState().project.dirty, true);
});

test('ProjectService.mutate batches store notifications into a single transaction', () => {
  const store = new EditorStore();
  store.setProject({ sheets: [] }, { dirty: false });
  const projects = new ProjectService(store, null);
  let notifications = 0;
  store.subscribe(state => state.project.model.sheets.length, () => { notifications++; });

  projects.mutate('sheets.add', project => {
    project.sheets.push({ id: 'a' });
    project.sheets.push({ id: 'b' });
  });

  assert.equal(notifications, 1);
});

test('ProjectService.mutate throws when no project is loaded', () => {
  const store = new EditorStore();
  const projects = new ProjectService(store, null);
  assert.throws(() => projects.mutate('noop', () => {}), /no project is loaded/);
});

test('ProjectService.mutate throws when given a non-function callback', () => {
  const store = new EditorStore();
  store.setProject({ sheets: [] });
  const projects = new ProjectService(store, null);
  assert.throws(() => projects.mutate('noop', null), TypeError);
});
