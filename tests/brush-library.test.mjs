import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary, getBrushLibrary, mergeIncoming } from '../js/features/brushes/brush-library.js';

// Mirrors BrowserPreferences: values cross a JSON boundary on the way in and
// out. Storing them by reference would hide precisely the bug toStored and
// fromStored exist to prevent -- a Uint8Array mask JSONs to a plain object,
// and Uint8Array.from() on an object with no length gives an EMPTY array.
function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? JSON.parse(store.get(k)) : d),
    set: (k, v) => store.set(k, JSON.stringify(v)),
    remove: (k) => store.delete(k),
  };
}

test('a fresh library seeds the built-ins', () => {
  const lib = createBrushLibrary(fakePrefs());
  assert.ok(lib.list().length >= 5);
  assert.ok(lib.list().some(b => b.mask.size === 1 && b.mask.kind === 'square'));
});

test('added brushes persist through the preferences store', () => {
  const prefs = fakePrefs();
  const a = createBrushLibrary(prefs);
  a.add(normalizeBrush({ name: 'Grass' }));
  const b = createBrushLibrary(prefs);
  assert.ok(b.list().some(x => x.name === 'Grass'));
});

// getBrushLibrary is the app-wide accessor brush-manager.js (and, from Task
// 15, the tool-palette brush picker) use instead of calling
// createBrushLibrary() directly. This is deliberately NOT the same scenario
// as the persistence test just above: that test creates its second instance
// AFTER the first one's write, which persistence-through-preferences alone
// already makes look correct -- the one ordering in which two independent
// instances cannot diverge. This test needs the two retrievals to be the
// SAME instance while both are alive, so a mutation through either one is
// visible -- and notified -- through the other.
test('getBrushLibrary returns one shared instance per preferences store', () => {
  const prefs = fakePrefs();
  const a = getBrushLibrary(prefs);
  const b = getBrushLibrary(prefs);
  assert.equal(a, b, 'two retrievals for the same preferences store must be the identical object');

  let fired = false;
  b.subscribe(() => { fired = true; });
  a.add(normalizeBrush({ name: 'Shared' }));
  assert.ok(fired, 'a mutation made through one retrieval must fire a listener registered through another');
  assert.ok(b.list().some(x => x.name === 'Shared'));
});

// CHARACTERIZATION TEST -- this documents the bug getBrushLibrary exists to
// prevent, using createBrushLibrary directly (never getBrushLibrary). Do not
// delete this as "redundant" with the test above: the test above proves the
// accessor is correct; this one proves the failure mode is real when the
// accessor is bypassed, which is exactly the mistake Task 15 could make by
// calling createBrushLibrary() a second time instead of getBrushLibrary().
//
// b.list() is called BEFORE a's write so b's cache is actually loaded --
// otherwise b would lazily load fresh from `prefs` on its first list() call
// after a's write and this test would pass for the wrong reason (looking
// fixed while nothing was fixed), the same trap the persistence test above
// falls into.
test('CHARACTERIZATION: two concurrent createBrushLibrary(prefs) instances diverge -- this is why getBrushLibrary exists', () => {
  const prefs = fakePrefs();
  const a = createBrushLibrary(prefs);
  const b = createBrushLibrary(prefs);
  b.list(); // force b's cache to load BEFORE a's mutation lands

  let fired = false;
  b.subscribe(() => { fired = true; });
  a.add(normalizeBrush({ name: 'Ghost' }));

  assert.equal(fired, false, 'an independent second instance must NOT be notified of a mutation made through the first');
  assert.ok(!b.list().some(x => x.name === 'Ghost'), 'an independent second instance must NOT see the mutation until it reloads');
});

test('update replaces a brush by id and leaves the rest alone', () => {
  const lib = createBrushLibrary(fakePrefs());
  const brush = normalizeBrush({ name: 'Old' });
  lib.add(brush);
  const before = lib.list().length;
  lib.update({ ...brush, name: 'New' });
  assert.equal(lib.list().length, before);
  assert.ok(lib.list().some(b => b.id === brush.id && b.name === 'New'));
});

test('update ignores an unknown id rather than appending', () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  lib.update(normalizeBrush({ id: 'nope', name: 'Ghost' }));
  assert.equal(lib.list().length, before);
});

test('remove deletes by id', () => {
  const lib = createBrushLibrary(fakePrefs());
  const brush = normalizeBrush({ name: 'Doomed' });
  lib.add(brush);
  lib.remove(brush.id);
  assert.equal(lib.list().some(b => b.id === brush.id), false);
});

test('a custom mask survives a save/reload cycle as a typed array', () => {
  const prefs = fakePrefs();
  const a = createBrushLibrary(prefs);
  a.add(normalizeBrush({
    name: 'Custom',
    mask: { kind: 'custom', bitmap: { width: 2, height: 2, bits: Uint8Array.from([1, 0, 0, 1]) } },
  }));
  const reloaded = createBrushLibrary(prefs).list().find(b => b.name === 'Custom');
  // Without toStored/fromStored, the Uint8Array JSONs to {"0":1,"1":0,"2":0,"3":1}
  // and Uint8Array.from() on that (no .length) yields an EMPTY array -- so this
  // assertion, plus the instanceof check below, are what catch that silently.
  assert.equal([...reloaded.mask.bitmap.bits].join(''), '1001');
  assert.ok(reloaded.mask.bitmap.bits instanceof Uint8Array);
});

test('mergeIncoming reports which project brushes are new to the library', () => {
  const lib = createBrushLibrary(fakePrefs());
  const known = lib.list()[0];
  const stranger = normalizeBrush({ name: 'Stranger' });
  const { added, existing } = mergeIncoming(lib, [known, stranger]);
  assert.deepEqual(added.map(b => b.name), ['Stranger']);
  assert.equal(existing.length, 1);
});

test('mergeIncoming does not mutate the library -- the caller decides', () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  mergeIncoming(lib, [normalizeBrush({ name: 'Stranger' })]);
  assert.equal(lib.list().length, before);
});

test('a corrupt stored brush is dropped without costing the whole library', () => {
  // localStorage is editable by hand and by any script on the origin, so a
  // stored brush gets the same suspicion as a downloaded file -- fromPlain's
  // hostile-dimension check runs on this path too. But that check THROWS, and
  // one bad entry must not brick the library, so it is caught per entry.
  const prefs = fakePrefs();
  const good = normalizeBrush({ name: 'Keeper' });
  prefs.set('brushes.library', [
    { ...good, mask: { ...good.mask, bitmap: { width: 1e9, height: 1e9, bits: [1] } } },
    good,
  ]);
  const lib = createBrushLibrary(prefs);
  const names = lib.list().map(b => b.name);
  assert.ok(names.includes('Keeper'), 'the sound brush must survive its corrupt neighbour');
  assert.ok(!names.some(n => n === undefined), 'no half-built brush may be admitted');
});

test('a library where EVERY stored brush is unreadable is set aside, not destroyed', () => {
  // The partial-corruption test above passes even with this bug present, so it
  // cannot stand in for this one. When nothing survives, `load()` falls back to
  // the built-ins -- correct for a first run, catastrophic here -- and the next
  // save() overwrites the stored key. Without setting the original aside first,
  // the user's brushes are gone permanently the moment they add their next one.
  const prefs = fakePrefs();
  const bad = (name) => {
    const b = normalizeBrush({ name });
    return { ...b, mask: { ...b.mask, kind: 'custom', bitmap: { width: 1e9, height: 1e9, bits: [1] } } };
  };
  prefs.set('brushes.library', [bad('Mine1'), bad('Mine2')]);
  const lib = createBrushLibrary(prefs);
  lib.add(normalizeBrush({ name: 'New' }));   // the write that would destroy them
  const kept = prefs.get('brushes.library.unreadable', null);
  assert.ok(Array.isArray(kept), 'the unreadable originals must be set aside');
  assert.deepEqual(kept.map(b => b.name), ['Mine1', 'Mine2']);
});
