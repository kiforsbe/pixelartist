// Task 15b fix round 1, item 1 & 2: performBrushImport (brush-manager.js).
//
// Before this fix, brush-manager.js's Import button awaited importBrush()
// with no try/catch. importBrush() throws from decodePng (a corrupt PNG),
// from parseBrushJson/parseLibraryJson via parseImportedBrushJson ('Not a
// brush file' / 'Not a brush library file'), and from
// assertSaneCustomBitmap (Task 11's hostile-custom-bitmap guard) -- all
// three deliberately, rather than degrading to a garbage brush. An
// unhandled rejection meant a bad file made the dialog visibly do nothing.
//
// performBrushImport is the DOM-independent core the click handler wraps
// (mountBrushManager itself needs `document` and is exercised by manual
// verification instead). Every test here asserts the actual user-visible
// MESSAGE, not just that nothing threw -- a bare assert.doesNotThrow would
// pass against a `catch {}` that shows nothing, which is the defect itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { createBrushLibrary } from '../js/features/brushes/brush-library.js';
import { parseImportedBrushJson } from '../js/features/brushes/brush-files.js';
import { decodePng } from '../js/core/pngcodec.js';
import { performBrushImport } from '../js/features/brushes/brush-manager.js';

function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
}

// --- throw source 1: valid JSON, not a brush shape -----------------------
//
// Mutation used to prove this discriminates: delete the try/catch in
// performBrushImport (revert to the pre-fix `result = await pickImport()`
// with no wrapping). Without it, `await performBrushImport(...)` itself
// rejects instead of resolving to `{ ok: false, message }` -- this test's
// `await` (not wrapped in its own try/catch) then throws out of the test
// body, and node:test reports the test as failed/errored rather than the
// clean `result.ok === false` assertion below ever running. Either way the
// test fails, which is what "discriminates" means here; verified by
// actually applying that mutation, observing the failure, and reverting.
test('performBrushImport surfaces parseBrushJson\'s real "Not a brush file" message, not a swallowed throw', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  // '42' is valid JSON but not an object -- parseImportedBrushJson routes it
  // (not an array, no .brushes array) to the real parseBrushJson, which
  // rejects a non-object outright.
  const result = await performBrushImport(lib, () => parseImportedBrushJson('42'));
  assert.equal(result.ok, false);
  assert.equal(result.message, 'Not a brush file');
  assert.equal(lib.list().length, before, 'a failed import must add nothing');
});

// --- throw source 2: assertSaneCustomBitmap's hostile-file guard ---------
//
// Same hostile shape brush-io.test.mjs's own Ruling-30 tests use -- a real
// production throw, not a fabricated one.
test('performBrushImport surfaces the hostile-custom-bitmap guard\'s real message', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  const hostile = JSON.stringify({
    name: 'Hostile', mask: { kind: 'custom', bitmap: { width: 1e9, height: 1e9, bits: [] } },
  });
  const result = await performBrushImport(lib, () => parseImportedBrushJson(hostile));
  assert.equal(result.ok, false);
  assert.match(result.message, /exceeds the maximum allowed size/);
  assert.equal(lib.list().length, before, 'a failed import must add nothing');
});

// --- throw source 3: decodePng ---------------------------------------------
//
// decodePng (js/core/pngcodec.js) is itself built entirely on browser-only
// APIs (createImageBitmap, OffscreenCanvas) that do not exist under
// `node --test` -- there is no way to make it throw ON A CORRUPT PNG
// SPECIFICALLY in this environment, the same DOM-less constraint that keeps
// mountBrushManager itself out of this test file. What CAN be verified for
// real here is that performBrushImport's catch surfaces whatever the real
// decodePng call throws, via the exact same control-flow path importBrush()
// takes for a `.png` file -- calling decodePng is not simulated or stubbed
// out, only the "picker" step (choosing a file) is, same as every other
// test in this file.
test('performBrushImport surfaces a real decodePng failure through the same path (not a fabricated stand-in)', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  const result = await performBrushImport(lib, () => decodePng(new Uint8Array([0, 1, 2, 3])));
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0, 'the real thrown error must have a non-empty message to show the user');
  assert.equal(lib.list().length, before, 'a failed import must add nothing');
});

// --- success paths: added/existing counts, both directions of pluralization
//
// Mutation used to prove the pluralization split discriminates: hardcode
// the label as `${added.length} brushes` unconditionally. Without the
// singular branch, the exact-string assertion in the FIRST test below
// (one brush) would read "Imported 1 brushes." instead of "Imported 1
// brush." and fail.

test('performBrushImport reports a plain singular count when nothing collides', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  const fresh = normalizeBrush({ name: 'Fresh' });
  const result = await performBrushImport(lib, () => fresh);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'Imported 1 brush.');
  assert.equal(lib.list().length, before + 1);
  assert.ok(lib.list().some(b => b.name === 'Fresh'));
});

test('performBrushImport reports a plain plural count for a multi-brush library file with no collisions', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  const incoming = [normalizeBrush({ name: 'A' }), normalizeBrush({ name: 'B' })];
  const result = await performBrushImport(lib, () => incoming);
  assert.equal(result.ok, true);
  assert.equal(result.message, 'Imported 2 brushes.');
  assert.equal(lib.list().length, before + 2);
});

// --- collision reporting (fix round 1, item 2) -----------------------------
//
// Mutation used to prove this discriminates: revert to the pre-fix
// `const { added } = mergeIncoming(lib, incoming)`, discarding `existing`.
// Without it, this exact-string assertion would read "Imported 1 brush."
// instead of "Imported 1 brush (1 already in your library).", silently
// losing the fact that half the file was already known -- indistinguishable,
// from the user's side, from an import that partly failed. Verified by
// actually applying that mutation, observing the failure, and reverting.
test('performBrushImport reports collisions instead of dropping them, and never overwrites the existing entry', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const known = normalizeBrush({ name: 'Original Name' });
  lib.add(known);
  const before = lib.list().length;

  // A file re-offering the SAME id (as if re-importing an old export) with a
  // DIFFERENT name, plus one genuinely new brush.
  const collidingCopy = { ...known, name: 'Edited Elsewhere' };
  const fresh = normalizeBrush({ name: 'Genuinely New' });
  const result = await performBrushImport(lib, () => [collidingCopy, fresh]);

  assert.equal(result.ok, true);
  assert.equal(result.message, 'Imported 1 brush (1 already in your library).');
  assert.equal(lib.list().length, before + 1, 'only the genuinely new brush must be added');
  assert.equal(lib.get(known.id).name, 'Original Name',
    'the existing brush must NOT be overwritten by the colliding import');
});

// --- cancelled picker -------------------------------------------------------

test('performBrushImport reports nothing and adds nothing when the picker is cancelled', async () => {
  const lib = createBrushLibrary(fakePrefs());
  const before = lib.list().length;
  const result = await performBrushImport(lib, () => null);
  assert.equal(result.ok, true);
  assert.equal(result.message, null);
  assert.equal(lib.list().length, before);
});
