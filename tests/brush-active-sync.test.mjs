// tests/brush-active-sync.test.mjs
//
// `workspace.drawing.brush` is a DETACHED SNAPSHOT, taken when a picker
// swatch was clicked. Nothing drove it from the library, so editing the
// active brush in the manager never reached the canvas: the dialog's own live
// preview changed, the picker went on highlighting the brush as the one being
// painted with, and the next stroke came out with the OLD ink, opacity,
// scatter, spacing and pressure. Undo/Redo inside the dialog had exactly the
// same problem. The dialog is non-modal SPECIFICALLY so a brush can be tried
// on the canvas while it is being edited, which is the workflow that did not
// work.
//
// The re-sync deliberately excludes `mask.size`: the Size input and the
// `[` / `]` keys patch it on the active copy without writing back, so it is a
// live per-use override rather than part of the stored definition. Both
// halves of that decision are pinned below.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EditorHost } from '../js/host/editor-host.js';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary, bindActiveBrushSync } from '../js/features/brushes/brush-library.js';
import { createBrushHistory, createBrushEditor } from '../js/features/brushes/brush-manager.js';

function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? JSON.parse(store.get(k)) : d),
    set: (k, v) => store.set(k, JSON.stringify(v)),
    remove: (k) => store.delete(k),
  };
}

// A library holding one brush, that brush active on a real store, and the
// sync bound between them -- the production wiring, minus the DOM.
function setup(overrides = {}) {
  const host = new EditorHost();
  const lib = createBrushLibrary(fakePrefs());
  lib.add(normalizeBrush({ name: 'Active', ink: { kind: 'solid', opacity: 100 }, ...overrides }));
  const id = lib.list().at(-1).id;
  // The same call the picker swatch makes: the WHOLE brush object, straight
  // into drawing settings.
  host.store.updateDrawingSettings({ brush: lib.get(id) });
  const dispose = bindActiveBrushSync(lib, host.store);
  return {
    lib, id, dispose, store: host.store,
    active: () => host.store.getState().workspace.drawing.brush,
    setActive: brush => host.store.updateDrawingSettings({ brush }),
  };
}

test('editing a brush in the library reaches the active brush on the canvas', (t) => {
  // IF THE MECHANISM WERE ABSENT the active brush would still read `solid`
  // and opacity 100 -- the values it was snapshotted with -- which is exactly
  // what the assertions below deny.
  const s = setup();
  t.after(s.dispose);
  assert.equal(s.active().ink.kind, 'solid', 'sanity: the snapshot starts where the library does');

  s.lib.update({ ...s.lib.get(s.id), ink: { ...s.lib.get(s.id).ink, kind: 'dither', opacity: 40 } });

  assert.equal(s.active().ink.kind, 'dither', 'the ink change never reached the canvas');
  assert.equal(s.active().ink.opacity, 40);
  assert.equal(s.active().id, s.id, 'the active brush must still be the same brush');
});

test("the manager's own undo reaches the canvas as well as its redo", (t) => {
  // Driven through the real edit-command shape the dialog's controls use, so
  // this covers the undo/redo path rather than just a bare library.update.
  const s = setup();
  t.after(s.dispose);
  const history = createBrushHistory();
  const editBrush = createBrushEditor(s.lib, history, () => s.id, () => {});

  editBrush('brush mask scatter', b => { b.mask.scatter = 6; return b; });
  assert.equal(s.active().mask.scatter, 6, 'the edit never reached the canvas');

  history.undo();
  assert.equal(s.active().mask.scatter, 0, 'undoing in the dialog left the canvas on the edited brush');

  history.redo();
  assert.equal(s.active().mask.scatter, 6, 'redoing in the dialog left the canvas on the old brush');
});

test('a live mask.size override survives an unrelated library edit', (t) => {
  // The Size input and the `[` / `]` keys patch mask.size on the ACTIVE COPY
  // and never write it back to the library. A re-sync that carried size
  // across would stomp that the moment anything else touched the library --
  // change opacity in the dialog and the size just nudged with `]` snaps
  // back.
  //
  // IF THE EXCLUSION WERE ABSENT the size below would revert to the stored 1
  // while the opacity came through, so the two assertions fail and pass
  // respectively -- which is why both are made.
  const s = setup();
  t.after(s.dispose);
  const cur = s.active();
  s.setActive({ ...cur, mask: { ...cur.mask, size: 7 } }); // what the Size input does
  assert.equal(s.lib.get(s.id).mask.size, 1, 'sanity: the override must NOT have reached the library');

  s.lib.update({ ...s.lib.get(s.id), ink: { ...s.lib.get(s.id).ink, opacity: 25 } });

  assert.equal(s.active().mask.size, 7, 'the live size override was stomped by an unrelated library edit');
  assert.equal(s.active().ink.opacity, 25, 'the unrelated edit itself must still come through');
});

test('a library change to a DIFFERENT brush leaves the active one alone', (t) => {
  const s = setup();
  t.after(s.dispose);
  s.lib.add(normalizeBrush({ name: 'Other' }));
  const other = s.lib.list().at(-1);
  const before = s.active();

  s.lib.update({ ...other, ink: { ...other.ink, kind: 'dither' } });

  assert.equal(s.active(), before, 'an edit to an unrelated brush replaced the active brush');
});

test('a library write that changes nothing does not churn the active brush', (t) => {
  // Every library write notifies, including ones that never touched the
  // active brush. Pushing an identical brush back through the store would
  // fire a `drawing` transaction -- and every subscriber behind it -- for
  // nothing. Object identity is the assertion because that is precisely what
  // a needless store write would break.
  const s = setup();
  t.after(s.dispose);
  const before = s.active();
  s.lib.update({ ...s.lib.get(s.id) });
  assert.equal(s.active(), before, 'an unchanged library write still replaced the active brush');
});

test('a brush that is no longer in the library is left exactly as it is', (t) => {
  // The user is still painting with it and there is nothing to reconcile it
  // against, so it must not be blanked or reset to a default.
  const s = setup();
  t.after(s.dispose);
  const before = s.active();
  s.lib.remove(s.id);
  assert.equal(s.active(), before, 'removing the brush from the library disturbed the active brush');
  assert.equal(s.active().id, s.id);
});

test('the sync is actually MOUNTED, not just exported', async () => {
  // The failure mode this whole fix round exists to close: a correct pure
  // function that no production code ever calls. These tests drive
  // bindActiveBrushSync directly, so every one of them would stay green with
  // the call site removed. mountToolPalette needs a DOM and cannot run under
  // `node --test`, so its wiring is asserted at the source level -- the same
  // idiom architecture.test.mjs already uses for the composition root.
  const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, v => v.slice(1));
  const source = await readFile(`${root}js/components/tool-palette.js`, 'utf8');
  assert.match(source, /bindActiveBrushSync\s*\(\s*lib\s*,\s*store\s*\)/,
    'tool-palette.js no longer binds the library-to-canvas brush sync');
  assert.match(source, /disposeBrushSync\s*\(\s*\)/,
    'the brush sync subscription is never disposed of');
});
