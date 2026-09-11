// js/features/brushes/brush-library.js
// The brush library: editor configuration, persisted per browser, carried
// between projects.
//
// This is the single EDITABLE source of truth. Brushes embedded in a project
// file are derived snapshots -- read on open and offered to the library,
// never edited in place -- so the two copies cannot drift apart.

import { normalizeBrush, BUILTIN_BRUSHES } from '../../core/brushes.js';
import { toPlain as toStored, fromPlain } from '../../core/brush-io.js';

const KEY = 'brushes.library';

// Storage and files face the identical problem -- a Uint8Array mask JSONs to an
// object and rehydrates to an EMPTY array -- so they share one answer rather
// than two that can drift. Reusing fromPlain also brings its hostile-dimension
// check to this path: localStorage is editable by hand and by any script on the
// origin, so stored brushes deserve the same suspicion as a downloaded file.
//
// That check throws, and one bad entry must not cost the user their whole
// library, so a brush that fails to load is dropped rather than propagated.
function fromStored(raw) {
  return fromPlain(raw);
}

function loadStored(raw) {
  const out = [];
  for (const entry of raw) {
    try { out.push(fromPlain(entry)); }
    catch { /* corrupt entry: drop it and keep the rest of the library */ }
  }
  return out;
}

export function createBrushLibrary(preferences) {
  let brushes = null;
  const listeners = new Set();

  function load() {
    if (brushes) return brushes;
    const raw = preferences.get(KEY, null);
    const stored = Array.isArray(raw) && raw.length ? loadStored(raw) : [];
    brushes = stored.length ? stored : BUILTIN_BRUSHES.map(b => normalizeBrush(b));
    return brushes;
  }

  function save() {
    preferences.set(KEY, brushes.map(toStored));
    for (const fn of listeners) fn(brushes);
  }

  return {
    list: () => [...load()],
    get: (id) => load().find(b => b.id === id) ?? null,
    add(brush) { load().push(fromStored(brush)); save(); },
    update(brush) {
      const list = load();
      const i = list.findIndex(b => b.id === brush.id);
      if (i === -1) return;
      list[i] = fromStored(brush);
      save();
    },
    remove(id) { brushes = load().filter(b => b.id !== id); save(); },
    replaceAll(next) { brushes = next.map(fromStored); save(); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// Compares by id, so a brush that travelled inside a project file and one
// already in the library are recognised as the same brush.
export function mergeIncoming(library, incoming) {
  const known = new Set(library.list().map(b => b.id));
  const added = [], existing = [];
  for (const b of incoming) (known.has(b.id) ? existing : added).push(normalizeBrush(b));
  return { added, existing };
}
