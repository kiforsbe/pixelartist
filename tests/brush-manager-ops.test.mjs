// The brush manager's library operations (Duplicate / Delete / Reset) and the
// ink-taxonomy predicates that gate which controls an ink actually reads.
//
// All of these are exported specifically so they are testable without a DOM --
// mountBrushManager itself needs `document` and is exercised only by manual
// verification, the same convention brush-manager-controls.test.mjs follows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INK_KINDS, BUILTIN_BRUSHES, normalizeBrush, createBrush } from '../js/core/brushes.js';
import { inkUsesPattern, inkUsesJitter } from '../js/core/brush-ink.js';
import {
  builtinFor, isModifiedBuiltin, duplicateName, duplicateOf,
} from '../js/features/brushes/brush-manager.js';

// --- ink taxonomy predicates --------------------------------------------
//
// These gate whether the Pattern and Jitter controls are enabled. Before
// them both sat live next to every ink, so a Pattern dropdown beside a
// `solid` brush read as a setting that did something.

test('inkUsesPattern is true for dither and false for every other ink', () => {
  // Asserted over the WHOLE exported list rather than a hand-picked sample:
  // a seventh ink added without deciding this question fails here instead of
  // silently inheriting `false`.
  assert.deepEqual(INK_KINDS.filter(inkUsesPattern), ['dither']);
  // The control: the list really does contain the other five, so the
  // assertion above is not passing because the filter ran over nothing.
  assert.ok(INK_KINDS.length >= 6, `expected 6+ ink kinds, got ${INK_KINDS.length}`);
});

test('inkUsesJitter is true for ramp-shade and false for every other ink', () => {
  assert.deepEqual(INK_KINDS.filter(inkUsesJitter), ['ramp-shade']);
  // Pattern and Jitter must not collapse into one question: they are enabled
  // for DIFFERENT inks, which is the whole reason there are two predicates.
  // If a future edit derived one from the other, this fails.
  assert.notDeepEqual(INK_KINDS.filter(inkUsesPattern), INK_KINDS.filter(inkUsesJitter));
});

// --- built-in identity and Reset gating ---------------------------------

test('builtinFor matches by id, not by name', () => {
  const factory = BUILTIN_BRUSHES[3];
  // The asymmetric fixture: rename it AND change its mask, so a lookup that
  // matched on name (or on deep equality) would return null here and the
  // Reset button would go dead on exactly the brush that most needs it.
  const renamed = normalizeBrush({ ...structuredClone(factory), name: 'My Brush' });
  renamed.mask.kind = 'square';
  assert.equal(builtinFor(renamed)?.id, factory.id);
  // The control: a brush with no factory counterpart resolves to null, so
  // the assertion above is not passing because builtinFor returns something
  // for everything.
  assert.equal(builtinFor(createBrush({ name: 'User' })), null);
  assert.equal(builtinFor(null), null);
});

test('isModifiedBuiltin is false for a pristine built-in and true once it drifts', () => {
  const factory = BUILTIN_BRUSHES[4];
  // Round-tripped through normalizeBrush the way library.get() returns it,
  // so a false positive here would mean Reset offers itself on every
  // untouched built-in the moment the dialog opens.
  const pristine = normalizeBrush(structuredClone(factory));
  assert.equal(isModifiedBuiltin(pristine), false);

  const drifted = structuredClone(pristine);
  drifted.mask.kind = 'square';
  assert.equal(isModifiedBuiltin(drifted), true);

  // A user brush has no factory state, so Reset must stay disabled however
  // much it has been edited -- there is nothing to restore it to.
  assert.equal(isModifiedBuiltin(createBrush({ name: 'User' })), false);
});

// --- duplication ---------------------------------------------------------

test('duplicateName appends copy, then numbers from 2', () => {
  assert.equal(duplicateName('Circle 5', []), 'Circle 5 copy');
  assert.equal(duplicateName('Circle 5', ['Circle 5 copy']), 'Circle 5 copy 2');
  assert.equal(duplicateName('Circle 5', ['Circle 5 copy', 'Circle 5 copy 2']), 'Circle 5 copy 3');
  // A gap is filled rather than skipped past.
  assert.equal(duplicateName('Circle 5', ['Circle 5 copy', 'Circle 5 copy 3']), 'Circle 5 copy 2');
  // An unrelated name that merely starts the same must not consume a slot.
  assert.equal(duplicateName('Circle', ['Circle 5 copy']), 'Circle copy');
});

test('duplicating a duplicate numbers rather than chaining "copy copy"', () => {
  // Duplicate selects the brush it just created, so clicking it twice
  // duplicates the DUPLICATE -- this is the common path, not an edge case.
  assert.equal(duplicateName('Circle 5 copy', ['Circle 5', 'Circle 5 copy']), 'Circle 5 copy 2');
  assert.equal(
    duplicateName('Circle 5 copy 2', ['Circle 5', 'Circle 5 copy', 'Circle 5 copy 2']),
    'Circle 5 copy 3',
  );
  // The suffix is only stripped when it IS the suffix: a brush genuinely
  // named "Copycat" or ending in a word containing "copy" keeps its name.
  assert.equal(duplicateName('Copycat', []), 'Copycat copy');
  // The pattern needs the leading space, so a brush named exactly "copy" is
  // a base name like any other rather than an empty one.
  assert.equal(duplicateName('copy', []), 'copy copy');
});

test('duplicateOf gives the copy a fresh id and leaves the original alone', () => {
  const original = BUILTIN_BRUSHES[4];
  const copy = duplicateOf(original, BUILTIN_BRUSHES.map(b => b.name));
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name, `${original.name} copy`);
  // Same brush otherwise: everything but id and name survives the copy.
  assert.deepEqual(copy.mask, original.mask);
  assert.deepEqual(copy.ink, original.ink);

  // Mutating the copy must not reach the original -- BUILTIN_BRUSHES is
  // module state shared with every other consumer, so a shallow copy here
  // would let a duplicate's later edit rewrite the factory definition that
  // Reset itself restores from.
  copy.mask.size = 13;
  assert.notEqual(original.mask.size, 13);
});

test('duplicateOf deep-copies a custom mask bitmap as a real typed array', () => {
  const source = normalizeBrush({
    name: 'Stamp',
    mask: { kind: 'custom', size: 3, bitmap: { width: 2, height: 2, bits: Uint8Array.from([1, 0, 0, 1]) } },
  });
  const copy = duplicateOf(source, []);

  // The hazard this guards: a JSON round trip turns a Uint8Array into a
  // plain {"0":1,...} object, and Uint8Array.from() on THAT returns an EMPTY
  // array -- so the duplicate would be a custom brush with no mask at all,
  // selectable and painting nothing. This branch has shipped that bug once
  // already, which is why the assertion is on the TYPE and the contents, not
  // just on deep equality (a plain object deep-equals its typed original
  // under some comparers).
  assert.ok(copy.mask.bitmap.bits instanceof Uint8Array,
    `expected Uint8Array, got ${copy.mask.bitmap.bits?.constructor?.name}`);
  assert.equal(copy.mask.bitmap.bits.length, 4);
  assert.deepEqual([...copy.mask.bitmap.bits], [1, 0, 0, 1]);

  // And it is a copy, not the same buffer: editing the duplicate's mask must
  // not edit the brush it was duplicated from.
  copy.mask.bitmap.bits[0] = 0;
  assert.equal(source.mask.bitmap.bits[0], 1);
});
