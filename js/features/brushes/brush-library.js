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
// Where unreadable stored brushes are set aside. Nothing reads this yet; its
// job is to exist, so a user whose library will not parse has something to
// recover from rather than a key that got quietly overwritten.
const UNREADABLE_KEY = 'brushes.library.unreadable';

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
    catch (e) {
      // Dropping keeps one bad entry from costing the whole library, but a
      // blank catch would swallow a genuine regression in normalizeBrush just
      // as silently as it swallows corrupt data. Say something.
      console.warn(`Dropped an unreadable stored brush: ${e.message}`);
    }
  }
  return out;
}

export function createBrushLibrary(preferences) {
  let brushes = null;
  const listeners = new Set();

  function load() {
    if (brushes) return brushes;
    const raw = preferences.get(KEY, null);
    const hadStored = Array.isArray(raw) && raw.length > 0;
    const stored = hadStored ? loadStored(raw) : [];
    // Anything dropped means the stored copy holds data this build cannot read.
    // The very next save() overwrites that key, so set the original aside FIRST
    // -- otherwise a user whose brushes fail to parse loses them permanently
    // the moment they add their next brush, with no warning and nothing to
    // recover from. Seeding the built-ins over an empty result is right for a
    // first run and catastrophic for a corrupt one; the two are only
    // distinguishable here, before that write happens.
    if (hadStored && stored.length !== raw.length) {
      preferences.set(UNREADABLE_KEY, raw);
      console.warn(`Set aside ${raw.length - stored.length} unreadable brush(es) under "${UNREADABLE_KEY}".`);
    }
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

// App-wide accessor: memoizes one library per `preferences` store instead of
// each caller constructing its own via createBrushLibrary(). Two independent
// instances over the SAME store diverge -- one's add()/update() writes
// through to preferences, but the other's already-loaded `brushes` cache is
// never reloaded and its own subscribe() listeners never fire, so it keeps
// showing pre-edit brushes until something forces a reload (see
// brush-library.test.mjs's characterization test for the concrete failure
// this produces). The brush manager dialog is the only production caller
// today; a Task 15 brush-picker strip is the second one this exists for.
//
// Keyed by the `preferences` object itself (a WeakMap, not a bare singleton
// that ignores its argument after the first call) so tests can still get
// isolated libraries by passing separate fakePrefs() objects, while two
// calls with the SAME store -- the only case that happens in production,
// since EditorHost hands out one `preferences` instance for its whole
// lifetime -- return the identical instance.
const sharedLibraries = new WeakMap();
export function getBrushLibrary(preferences) {
  let lib = sharedLibraries.get(preferences);
  if (!lib) {
    lib = createBrushLibrary(preferences);
    sharedLibraries.set(preferences, lib);
  }
  return lib;
}

// Compares by id, so a brush that travelled inside a project file and one
// already in the library are recognised as the same brush.
export function mergeIncoming(library, incoming) {
  const known = new Set(library.list().map(b => b.id));
  const added = [], existing = [];
  for (const b of incoming) (known.has(b.id) ? existing : added).push(normalizeBrush(b));
  return { added, existing };
}
