// js/features/brushes/brush-library.js
// The brush library: editor configuration, persisted per browser, carried
// between projects.
//
// This is the single EDITABLE source of truth. Brushes embedded in a project
// file are derived snapshots -- read on open and offered to the library,
// never edited in place -- so the two copies cannot drift apart.

import { normalizeBrush, brushesEqual, BUILTIN_BRUSHES } from '../../core/brushes.js';
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
    indexOf: (id) => load().findIndex(b => b.id === id),
    // `at` is optional and only honoured when it names a real slot: an
    // omitted, out-of-range or non-integer position appends, which is what
    // every pre-existing caller passes and relies on. It exists so an undone
    // Delete can put the brush back WHERE IT WAS rather than at the end --
    // an undo that silently reorders the library is not an undo.
    add(brush, at) {
      const list = load();
      const i = Number.isInteger(at) ? Math.max(0, Math.min(list.length, at)) : list.length;
      list.splice(i, 0, fromStored(brush));
      save();
    },
    update(brush) {
      const list = load();
      const i = list.findIndex(b => b.id === brush.id);
      if (i === -1) return;
      list[i] = fromStored(brush);
      save();
    },
    // Reorder in place. Returns whether anything actually moved, so a caller
    // can decline to push a no-op onto its undo stack -- pressing the button
    // at either end of the list must not leave an undoable step behind.
    move(id, to) {
      const list = load();
      const from = list.findIndex(b => b.id === id);
      if (from === -1) return false;
      const target = Math.max(0, Math.min(list.length - 1, to));
      if (target === from) return false;
      // splice-out then splice-in, the same pair palettes.js's moveSwatch
      // uses: `to` is read against the list BEFORE removal, so dragging
      // rightwards lands after the entry currently at `to`, not before it.
      const [moved] = list.splice(from, 1);
      list.splice(target, 0, moved);
      save();
      return true;
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

// --- keeping the CANVAS's active brush in step with the library ----------
//
// `workspace.drawing.brush` is a detached SNAPSHOT, taken when a picker
// swatch was clicked (tool-palette.js). Nothing was driving it from the
// library, so editing the active brush in the manager never reached the
// canvas: the dialog's own live preview changed, the swatch stayed
// highlighted as "the brush you are painting with", and the next stroke came
// out with the OLD ink, opacity, scatter, spacing and pressure. Undo/Redo
// inside the dialog had the same problem. The dialog is non-modal
// specifically so a brush can be tried on the canvas while it is being
// edited (brush-manager.js:3-5), which is exactly the workflow that did not
// work.
//
// THE ONE EXCEPTION IS `mask.size`, and it is deliberate. The Size input
// (tool-palette.js) and the `[` / `]` keys (editor-workbench.js) patch
// mask.size on the ACTIVE COPY and never write it back to the library, so
// size is a live per-use override rather than part of the stored definition.
// Re-syncing it would stomp that override the moment the user touched any
// unrelated field -- change opacity in the dialog and the size you had just
// nudged with `]` silently snaps back. Writing it through to the library
// instead was the other option and is worse: a `]` keypress would then
// permanently resize a stored brush (a built-in included) and persist that to
// localStorage, from a canvas keypress, outside the manager's undo stack --
// turning an ephemeral adjustment into an unannounced library edit.
//
// What excluding it costs: a size change made IN the manager does not reach
// an already-active brush. That is the one brush field with its own
// always-visible canvas-side control sitting right next to the picker, so the
// user can set it there directly -- which is not true of any other field, and
// is the whole reason the rest of them have to be pushed through.
// Module-private, and it does NOT re-check that the two brushes share an id:
// its one caller resolves `stored` by looking up `active.id`, so the check
// could never fail. Dead defensive code is worse than none -- it reads as a
// guarded case when nothing guards anything, and no test can hold it honest
// (removing it changed no test result, which is how it was found).
function activeBrushFromLibrary(stored, active) {
  // `stored` is genuinely null when the active brush has been removed from
  // the library; everything below would throw on it.
  if (!stored) return null;
  const next = { ...stored, mask: { ...stored.mask, size: active.mask.size } };
  // A push that changes nothing must not become a store notification: every
  // library write notifies, including ones that never touched the active
  // brush at all.
  return brushesEqual(next, active) ? null : next;
}

// Subscribes the given store's active brush to the library. Returns the
// unsubscribe function, so a caller that mounts this can dispose of it the
// same way it disposes of its other subscriptions.
//
// `store` is only used through getState()/updateDrawingSettings(), the same
// pair tool-palette.js's own swatch click uses -- never a direct
// `workspace.drawing.brush =` assignment -- which is also what keeps this
// testable without a DOM.
export function bindActiveBrushSync(library, store) {
  return library.subscribe(() => {
    const active = store.getState().workspace.drawing.brush;
    const stored = active ? library.get(active.id) : null;
    // A brush that is no longer in the library (or never was) is left exactly
    // as it is: the user is still painting with it, and there is nothing to
    // reconcile it against.
    const next = activeBrushFromLibrary(stored, active);
    if (next) store.updateDrawingSettings({ brush: next });
  });
}

// Compares by id, so a brush that travelled inside a project file and one
// already in the library are recognised as the same brush.
export function mergeIncoming(library, incoming) {
  const known = new Set(library.list().map(b => b.id));
  const added = [], existing = [];
  for (const b of incoming) (known.has(b.id) ? existing : added).push(normalizeBrush(b));
  return { added, existing };
}
