// Autosave durability: an IndexedDB write is only on disk once its
// TRANSACTION completes. A request's `success` can fire and the transaction
// still abort afterwards (quota exceeded is the usual cause), so resolving on
// request success reported "saved" for data that was rolled back.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { clearAutosave } from '../js/platform/browser/project-io.js';

// A minimal fake of the IndexedDB surface idbOp touches. `outcome` decides
// how the transaction ends after its single request has succeeded.
function installFakeIdb(outcome) {
  const events = [];
  globalThis.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          close() {},
          transaction() {
            const tx = { error: null };
            tx.objectStore = () => ({
              delete() {
                const r = { result: undefined };
                setTimeout(() => {
                  events.push('request-success');
                  r.onsuccess?.();
                  setTimeout(() => {
                    if (outcome === 'complete') { events.push('complete'); tx.oncomplete?.(); }
                    else { tx.error = new Error('QuotaExceededError'); events.push('abort'); tx.onabort?.(); }
                  }, 0);
                }, 0);
                return r;
              },
            });
            return tx;
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };
  return events;
}

afterEach(() => { delete globalThis.indexedDB; });

test('an autosave operation resolves only after its transaction completes', async () => {
  const events = installFakeIdb('complete');
  await clearAutosave();
  assert.deepEqual(events, ['request-success', 'complete']);
});

test('an autosave operation rejects when its transaction aborts after the request succeeded', async () => {
  installFakeIdb('abort');
  await assert.rejects(() => clearAutosave(), /Quota/);
});
