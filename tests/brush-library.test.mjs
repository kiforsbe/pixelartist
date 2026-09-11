import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary, mergeIncoming } from '../js/features/brushes/brush-library.js';

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
