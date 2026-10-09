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
  const observers = new Set();
  function changed() { for (const observer of [...observers]) observer(); }
  function waitFor(predicate, description) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const observer = () => { if (predicate()) { cleanup(); resolve(); } };
      const timeout = setTimeout(() => { cleanup(); reject(new Error(description)); }, 5000);
      function cleanup() { clearTimeout(timeout); observers.delete(observer); }
      observers.add(observer);
    });
  }
  const elements = new Map(), downloads = [], blobs = new Map();
  class Element {
    constructor() { this.children = []; this.handlers = {}; this.classList = { add() {} }; }
    set id(value) { this.elementId = value; elements.set(value, this); }
    get id() { return this.elementId; }
    addEventListener(type, callback) { (this.handlers[type] ??= []).push(callback); }
    emit(type) { return Promise.all((this.handlers[type] ?? []).map(callback => callback())); }
    set innerHTML(value) { this.children = []; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    showModal() {} close() {}
    click() {
      if (this.href) { downloads.push({ name: this.download, blob: blobs.get(this.href) }); changed(); }
      else return this.emit('click');
    }
  }
  URL.createObjectURL = blob => { const url = `blob:fixture-${blobs.size}`; blobs.set(url, blob); return url; };
  URL.revokeObjectURL = url => blobs.delete(url);
  globalThis.Option = class extends Element { constructor(text, value) { super(); this.textContent = text; this.value = value; } };
  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) { const element = new Element(); element.id = id; }
      return elements.get(id);
    },
    createElement: () => new Element(),
    querySelector: () => ({ value: 'zip' }),
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
        transaction() {
          const tx = {};
          tx.objectStore = () => ({
            delete(key) { recovery.push({ kind: 'delete', key }); changed(); return succeed(tx); },
            put(bytes, key) { recovery.push({ kind: 'put', bytes, key }); changed(); return succeed(tx); },
          });
          return tx;
        },
      };
      request.onsuccess();
    });
    return request;
  } };
  // Real IndexedDB order: the request succeeds, then its transaction
  // completes. Autosave settles on the latter (see project-io.js idbOp).
  function succeed(tx) {
    const req = {};
    queueMicrotask(() => { req.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
    return req;
  }
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
        changed();
        await gate.promise;
      },
      async close() {},
    };
  } };
  window.showSaveFilePicker = async () => handle;
  function reset() {
    host.history.clear(); resetFileSession(); writes.length = recovery.length = alerts.length = downloads.length = 0;
    const project = createProject('BeforeSave');
    createSheet(project, { kind: 'sprite', name: 'Sheet', width: 1, height: 1 });
    host.setProject(project, { dirty: true });
    return project;
  }
  const waitForWrites = count => waitFor(() => writes.length >= count, `Expected ${count} writes`);
  const waitForRecovery = kind => waitFor(() => recovery.some(op => op.kind === kind), `Expected recovery ${kind}`);
  const waitForDownloads = count => waitFor(() => downloads.length >= count, `Expected ${count} downloads`);
  return { host, runAction, fileSession, reset, writes, recovery, alerts, handle, waitForWrites, waitForRecovery, downloads, waitForDownloads, elements, autosave: () => intervals[0]() };
}

export async function savedName(bytes) {
  const entries = await zipRead(bytes);
  return JSON.parse(new TextDecoder().decode(entries.find(e => e.path === 'project.json').data)).name;
}
