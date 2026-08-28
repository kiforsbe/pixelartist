import { EditorHost } from '../../js/host/editor-host.js';
import { setEditorHost } from '../../js/host/runtime.js';
import { createProject, createSheet } from '../../js/core/model.js';
import { zipRead } from '../../js/core/zip.js';
import { fileSession, resetFileSession } from '../../js/features/project/file-session.js';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only external DOM, imaging and storage boundaries are inert. Controllers,
// host services, bundle snapshots and ZIP encoding are the real implementation.
export async function mountFileFixture() {
  const elements = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { classList: { add() {} }, addEventListener() {} });
      return elements.get(id);
    },
  };
  const intervals = [];
  globalThis.location = { search: '?autotest' };
  globalThis.setInterval = callback => { intervals.push(callback); return intervals.length; };
  globalThis.window = { addEventListener() {}, showOpenFilePicker() {} };
  globalThis.ImageData = class {};
  globalThis.OffscreenCanvas = class {
    getContext() { return { putImageData() {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0])]); }
  };
  const recovery = [], alerts = [];
  globalThis.alert = message => alerts.push(message);
  globalThis.indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        close() {},
        transaction() { return { objectStore() { return {
          delete(key) { recovery.push({ kind: 'delete', key }); return succeed(); },
          put(bytes, key) { recovery.push({ kind: 'put', bytes, key }); return succeed(); },
        }; } }; },
      };
      request.onsuccess();
    });
    return request;
  } };
  function succeed() { const req = {}; queueMicrotask(() => req.onsuccess()); return req; }
  const host = new EditorHost();
  setEditorHost(host);
  const { mountFileController } = await import('../../js/features/project/file-controller.js');
  const { runAction } = await import('../../js/features/shell/actions.js');
  mountFileController();
  await new Promise(resolve => setImmediate(resolve));
  const writes = [];
  const handle = { async createWritable() {
    return {
      async write(bytes) {
        const gate = deferred();
        writes.push({ bytes, gate });
        await gate.promise;
      },
      async close() {},
    };
  } };
  window.showSaveFilePicker = async () => handle;
  function reset() {
    host.history.clear(); resetFileSession(); writes.length = recovery.length = alerts.length = 0;
    const project = createProject('BeforeSave');
    createSheet(project, { kind: 'sprite', name: 'Sheet', width: 1, height: 1 });
    host.setProject(project, { dirty: true });
    return project;
  }
  async function waitForWrites(count) {
    for (let i = 0; writes.length < count && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
    if (writes.length < count) throw new Error(`Expected ${count} writes, received ${writes.length}`);
  }
  return { host, runAction, fileSession, reset, writes, recovery, alerts, handle, waitForWrites, autosave: () => intervals[0]() };
}

export async function savedName(bytes) {
  const entries = await zipRead(bytes);
  return JSON.parse(new TextDecoder().decode(entries.find(e => e.path === 'project.json').data)).name;
}
