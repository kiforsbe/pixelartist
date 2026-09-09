import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBrush, normalizeBrush, validateBrush, BUILTIN_BRUSHES, DEFAULT_BRUSH,
} from '../js/core/brushes.js';

test('createBrush fills every field with retro-safe defaults', () => {
  const b = createBrush({ name: 'Test' });
  assert.equal(b.name, 'Test');
  assert.equal(b.mask.kind, 'square');
  assert.equal(b.mask.size, 1);
  assert.equal(b.mask.spacing, 1);
  assert.equal(b.mask.scatter, 0);
  assert.equal(b.mask.rotate, 0);
  assert.equal(b.mask.flipH, false);
  assert.equal(b.mask.rotateJitter, false);
  assert.equal(b.ink.kind, 'solid');
  assert.equal(b.ink.opacity, 100);
  assert.equal(b.ink.trueAlpha, false);
  assert.equal(b.ink.jitter, 0);
  assert.equal(b.pressure.target, 'none');
  assert.ok(b.id);
});

test('normalizeBrush accepts a partial object and never returns undefined fields', () => {
  const b = normalizeBrush({ name: 'Partial', mask: { kind: 'circle', size: 5 } });
  assert.equal(b.mask.kind, 'circle');
  assert.equal(b.mask.size, 5);
  assert.equal(b.mask.spacing, 1);
  assert.equal(b.ink.kind, 'solid');
  assert.equal(b.pressure.target, 'none');
});

test('normalizeBrush clamps size to 1..16 and spacing to at least 1', () => {
  assert.equal(normalizeBrush({ mask: { size: 99 } }).mask.size, 16);
  assert.equal(normalizeBrush({ mask: { size: 0 } }).mask.size, 1);
  assert.equal(normalizeBrush({ mask: { spacing: 0 } }).mask.spacing, 1);
  assert.equal(normalizeBrush({ mask: { scatter: -3 } }).mask.scatter, 0);
});

test('normalizeBrush snaps rotate to a quarter turn', () => {
  assert.equal(normalizeBrush({ mask: { rotate: 37 } }).mask.rotate, 0);
  assert.equal(normalizeBrush({ mask: { rotate: 90 } }).mask.rotate, 90);
  assert.equal(normalizeBrush({ mask: { rotate: 450 } }).mask.rotate, 90);
});

test('validateBrush rejects stamp ink on a non-custom mask', () => {
  const bad = normalizeBrush({ mask: { kind: 'square' }, ink: { kind: 'stamp' } });
  assert.equal(validateBrush(bad).ok, false);
  const good = normalizeBrush({
    mask: { kind: 'custom', bitmap: { width: 1, height: 1, bits: [1] } },
    ink: { kind: 'stamp' },
  });
  assert.equal(validateBrush(good).ok, true);
});

test('validateBrush rejects a custom mask with no bitmap', () => {
  const bad = normalizeBrush({ mask: { kind: 'custom' } });
  assert.equal(validateBrush(bad).ok, false);
});

test('validateBrush rejects replace ink with no target color', () => {
  const bad = normalizeBrush({ ink: { kind: 'replace' } });
  assert.equal(validateBrush(bad).ok, false);
});

test('built-ins are all valid and include the default square 1', () => {
  for (const b of BUILTIN_BRUSHES) assert.equal(validateBrush(b).ok, true, b.name);
  assert.equal(DEFAULT_BRUSH.mask.size, 1);
  assert.equal(DEFAULT_BRUSH.ink.kind, 'solid');
});

// Built-in ids must be stable across processes: a saved project embeds them,
// and Task 12's library dedupe matches incoming brushes against the library
// by id. Asserting the literal ids is the cheapest proof that they are fixed
// rather than derived from newBrushId()'s per-process counter.
test('built-in brushes have fixed ids stable across processes', () => {
  assert.equal(BUILTIN_BRUSHES[0].id, 'brush_builtin_square1');
  assert.equal(BUILTIN_BRUSHES[1].id, 'brush_builtin_square2');
  assert.equal(BUILTIN_BRUSHES[2].id, 'brush_builtin_square3');
  assert.equal(BUILTIN_BRUSHES[3].id, 'brush_builtin_circle3');
  assert.equal(BUILTIN_BRUSHES[4].id, 'brush_builtin_circle5');
  assert.equal(DEFAULT_BRUSH.id, 'brush_builtin_square1');
});
