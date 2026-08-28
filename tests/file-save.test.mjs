import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountFileFixture, savedName } from './helpers/file-controller-fixture.mjs';

const f = await mountFileFixture();
f.host.documents.registerProvider({
  kind: 'sprite-sheet', list: project => project.sheets,
  get: (project, id) => project.sheets.find(sheet => sheet.id === id),
  create() {}, remove() {}, rename(sheet, name) { sheet.name = name; },
});

for (const action of ['file.save', 'file.saveAs']) {
  test(`${action} preserves edits made while an older snapshot is writing`, async () => {
    const project = f.reset();
    const saving = f.runAction(action);
    await f.waitForWrites(1);
    f.host.projects.mutate('rename', model => { model.name = 'AfterSave'; });
    f.writes[0].gate.resolve(); await saving;
    assert.equal(await savedName(f.writes[0].bytes), 'BeforeSave');
    assert.equal(project.name, 'AfterSave');
    assert.equal(f.host.projects.dirty, true);
    assert.equal(f.recovery.length, 0);
  });
}

test('repeated dirty notifications while already dirty invalidate a save', async () => {
  const project = f.reset();
  const saving = f.runAction('file.save'); await f.waitForWrites(1);
  project.name = 'Direct edit'; f.host.projects.markDirty();
  f.writes[0].gate.resolve(); await saving;
  assert.equal(f.host.projects.dirty, true);
  assert.equal(f.recovery.length, 0);
});

test('live pixel edits while saving cannot clear dirty or recovery state', async () => {
  f.reset();
  const saving = f.runAction('file.save'); await f.waitForWrites(1);
  f.host.store.notifyPixelsChanged();
  f.writes[0].gate.resolve(); await saving;
  assert.equal(f.host.projects.dirty, true);
  assert.equal(f.recovery.length, 0);
});

test('document-service mutations invalidate an in-flight save', async () => {
  const project = f.reset();
  const saving = f.runAction('file.save'); await f.waitForWrites(1);
  f.host.documents.rename({ kind: 'sprite-sheet', id: project.sheets[0].id }, 'Changed');
  f.writes[0].gate.resolve(); await saving;
  assert.equal(f.host.projects.dirty, true);
});

test('old project save cannot overwrite the new project file session', async () => {
  f.reset();
  const saving = f.runAction('file.saveAs'); await f.waitForWrites(1);
  f.host.setProject({ name: 'Replacement', sheets: [], maps: [] }, { dirty: true });
  const replacementHandle = {};
  Object.assign(f.fileSession, { fileHandle: replacementHandle, dirHandle: null, saveMode: 'packed' });
  f.writes[0].gate.resolve(); await saving;
  assert.equal(f.host.projects.dirty, true);
  assert.equal(f.fileSession.fileHandle, replacementHandle);
  assert.equal(f.recovery.length, 0);
});

test('overlapping saves write snapshots in request order', async () => {
  f.reset();
  const first = f.runAction('file.save'); await f.waitForWrites(1);
  f.host.projects.mutate('rename', model => { model.name = 'Second'; });
  const second = f.runAction('file.save');
  await new Promise(resolve => setImmediate(resolve));
  const concurrentWrites = f.writes.length;
  f.writes[0].gate.resolve(); await first;
  await f.waitForWrites(2); f.writes[1].gate.resolve(); await second;
  assert.equal(concurrentWrites, 1);
  assert.equal(await savedName(f.writes[1].bytes), 'Second');
  assert.equal(f.host.projects.dirty, false);
  assert.equal(f.recovery.filter(op => op.kind === 'delete').length, 1);
});

test('autosave queued behind an older save retains the newer edit', async () => {
  f.reset();
  const saving = f.runAction('file.save'); await f.waitForWrites(1);
  f.host.projects.mutate('rename', model => { model.name = 'Recovery'; });
  f.autosave();
  f.writes[0].gate.resolve(); await saving;
  await f.waitForRecovery('put');
  const writes = f.recovery.filter(op => op.kind === 'put');
  assert.equal(writes.length, 1);
  assert.equal(await savedName(writes[0].bytes), 'Recovery');
  assert.equal(f.recovery.filter(op => op.kind === 'delete').length, 0);
  assert.equal(f.host.projects.dirty, true);
});

test('failed save keeps edits dirty and does not prevent a later successful save', async () => {
  f.reset();
  const first = f.runAction('file.save'); await f.waitForWrites(1);
  f.writes[0].gate.reject(new Error('write failed')); await first;
  assert.equal(f.host.projects.dirty, true);
  assert.equal(f.recovery.length, 0);
  assert.match(f.alerts[0], /write failed/);
  const second = f.runAction('file.save'); await f.waitForWrites(2);
  f.writes[1].gate.resolve(); await second;
  assert.equal(f.host.projects.dirty, false);
  assert.equal(f.fileSession.fileHandle, f.handle);
});

test('queued saves for a replaced project never write into its replacement', async () => {
  f.reset();
  const first = f.runAction('file.save'); await f.waitForWrites(1);
  const queued = f.runAction('file.saveAs');
  f.host.setProject({ name: 'Replacement', sheets: [], maps: [] }, { dirty: true });
  f.writes[0].gate.resolve(); await Promise.all([first, queued]);
  assert.equal(f.writes.length, 1);
  assert.equal(f.fileSession.fileHandle, null);
  assert.equal(f.host.projects.dirty, true);
});

test('republishing the same model creates a new file-session generation', async () => {
  const project = f.reset();
  const saving = f.runAction('file.save'); await f.waitForWrites(1);
  f.host.setProject(project, { dirty: true });
  f.writes[0].gate.resolve(); await saving;
  assert.equal(f.host.projects.dirty, true);
  assert.equal(f.fileSession.fileHandle, null);
  assert.equal(f.recovery.length, 0);
});
