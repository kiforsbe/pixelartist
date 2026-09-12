// Task 15a: the editing controls' edit-command shape (createBrushEditor) and
// the live preview's engine composition (renderBrushPreview). Both are
// exported specifically so they are testable without a DOM -- mountBrushManager
// itself needs `document` and is exercised only by manual verification
// (see task-15a-report.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush, validateBrush, PRESSURE_RANGES, MAX_MASK_SIZE } from '../js/core/brushes.js';
import { createBrushLibrary } from '../js/features/brushes/brush-library.js';
import {
  createBrushHistory, createBrushEditor, renderBrushPreview,
  commitCoercedNumber, commitCoercedName,
} from '../js/features/brushes/brush-manager.js';

function fakePrefs() {
  const store = new Map();
  return {
    get: (k, d = null) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    remove: (k) => store.delete(k),
  };
}

function setup(brushOverrides = {}) {
  const lib = createBrushLibrary(fakePrefs());
  const history = createBrushHistory();
  const brush = normalizeBrush({ name: 'Before', ...brushOverrides });
  lib.add(brush);
  let currentId = brush.id;
  let refreshCount = 0;
  const editBrush = createBrushEditor(lib, history, () => currentId, () => { refreshCount++; });
  return { lib, history, brush, editBrush, refreshes: () => refreshCount, setCurrent: id => { currentId = id; } };
}

// --- PRESSURE_RANGES export -------------------------------------------

test('PRESSURE_RANGES is exported with the per-target defaults normalizePressure uses', () => {
  assert.deepEqual(PRESSURE_RANGES.none, [1, 8]);
  assert.deepEqual(PRESSURE_RANGES.opacity, [0, 100]);
  assert.deepEqual(PRESSURE_RANGES['shade-step'], [1, 3]);
});

// The `size` target's ceiling gets its own test, written against
// MAX_MASK_SIZE rather than a literal. The 8 that used to sit in the table
// was the RETIRED brush-size cap, and it was a literal here too -- so this
// assertion agreed with the bug and kept it alive. The manager wires these
// numbers onto the pressure min/max inputs' HTML bounds, so a stale ceiling
// meant typing 16 into pressure max came back "out of range -- used 8
// instead" while the Size input beside it accepted 16.
test('the size pressure target offers the whole mask range, not the retired brush-size cap', () => {
  assert.deepEqual(PRESSURE_RANGES.size, [1, MAX_MASK_SIZE]);
  // The ceiling is what a typed value is clamped against in the dialog
  // (commitCoercedNumber reads the input's own max, wired from this table),
  // so the bound has to admit MAX_MASK_SIZE itself.
  const { lib, brush, editBrush } = setup({ pressure: { target: 'size' } });
  const [, max] = PRESSURE_RANGES.size;
  const { value, message } = commitCoercedNumber(
    editBrush, 'brush pressure max', String(MAX_MASK_SIZE), 1, max, (b, v) => { b.pressure.max = v; });
  assert.equal(value, MAX_MASK_SIZE, `typing ${MAX_MASK_SIZE} was clamped to ${value}`);
  assert.equal(message, null, 'a legal maximum must not be reported as out of range');
  assert.equal(lib.get(brush.id).pressure.max, MAX_MASK_SIZE);
});

// --- createBrushEditor: the basic edit-command shape --------------------

test('a committed edit records one undo step, applies immediately, and undo/redo restore it', () => {
  const { lib, history, brush, editBrush } = setup();
  const result = editBrush('rename', b => { b.name = 'After'; return b; });
  assert.equal(result.ok, true);
  assert.equal(lib.get(brush.id).name, 'After');
  assert.equal(history.canUndo(), true);
  history.undo();
  assert.equal(lib.get(brush.id).name, 'Before');
  history.redo();
  assert.equal(lib.get(brush.id).name, 'After');
});

test('editBrush with no current brush is a no-op and returns null', () => {
  const { editBrush, history, setCurrent } = setup();
  setCurrent(null);
  const result = editBrush('rename', b => { b.name = 'After'; return b; });
  assert.equal(result, null);
  assert.equal(history.canUndo(), false);
});

// --- the no-dead-step guard ----------------------------------------------
//
// Mutation used to prove this discriminates: delete the
// `if (deepEqualValue(before, after)) return ...` guard inside
// createBrushEditor (brush-manager.js). Without it, the second call below
// pushes a second, no-op step, so after ONE undo() the stack would still
// have one left and canUndo() would read true instead of false.

test('an edit that reproduces the brush\'s current value does not record a second undo step', () => {
  const { history, editBrush } = setup();
  editBrush('rename', b => { b.name = 'After'; return b; });
  editBrush('rename', b => { b.name = 'After'; return b; }); // re-applies the identical value
  assert.equal(history.canUndo(), true);
  history.undo();
  assert.equal(history.canUndo(), false, 'a second identical edit must not have pushed a dead step');
});

test('an edit that reproduces the value refreshes nothing and writes nothing new to the library', () => {
  const { lib, brush, editBrush, refreshes } = setup();
  editBrush('rename', b => { b.name = 'After'; return b; });
  const refreshesAfterFirst = refreshes();
  const result = editBrush('rename', b => { b.name = 'After'; return b; });
  assert.equal(result.ok, true);
  assert.equal(refreshes(), refreshesAfterFirst, 'a guarded no-op must not call refresh again');
  assert.equal(lib.get(brush.id).name, 'After');
});

// --- validateBrush integration --------------------------------------------
//
// Mutation used to prove this discriminates: delete the
// `if (!check.ok) return check;` line. Without it, the invalid brush would
// be written and the step recorded, so `lib.get(...).ink.kind` would read
// 'stamp' and canUndo() would read true.

test('an edit that validateBrush rejects is not written, and its reason is returned', () => {
  const { lib, history, brush, editBrush } = setup({ mask: { kind: 'square' }, ink: { kind: 'solid' } });
  const result = editBrush('ink kind', b => { b.ink.kind = 'stamp'; return b; });
  assert.equal(result.ok, false);
  assert.equal(result.reason, validateBrush({ ...brush, ink: { ...brush.ink, kind: 'stamp' } }).reason);
  assert.equal(lib.get(brush.id).ink.kind, 'solid', 'the invalid edit must not have been written');
  assert.equal(history.canUndo(), false);
});

// --- structuredClone, not JSON ---------------------------------------------
//
// Mutation used to prove this discriminates: swap `structuredClone` for
// `JSON.parse(JSON.stringify(...))` inside createBrushEditor. A plain JSON
// round-trip turns mask.bitmap.bits (a Uint8Array) into a {"0":1,...} plain
// object; brush-io.js's fromPlain then runs it through Uint8Array.from,
// which -- for a non-iterable, length-less plain object -- produces an
// EMPTY typed array. The assertion on `[...bits]` below would then read []
// instead of the original four values.

test('an unrelated edit carries a custom mask\'s Uint8Array bitmap through untouched', () => {
  const bits = new Uint8Array([1, 0, 1, 1]);
  const { lib, brush, editBrush } = setup({
    mask: { kind: 'custom', bitmap: { width: 2, height: 2, bits } },
    ink: { kind: 'stamp' },
  });
  const result = editBrush('rename', b => { b.name = 'Renamed'; return b; });
  assert.equal(result.ok, true);
  const after = lib.get(brush.id);
  assert.equal(after.name, 'Renamed');
  assert.ok(after.mask.bitmap.bits instanceof Uint8Array, 'bitmap.bits must survive as a real Uint8Array');
  assert.deepEqual([...after.mask.bitmap.bits], [1, 0, 1, 1]);
});

// --- renderBrushPreview: the preview composes the REAL engine -------------
//
// Two independent 50%-ish effects stack for a dither ink at 50% opacity: the
// Bayer density gate (dither.js's passesOpacity) admits ~half the touched
// pixels regardless of ink kind, and -- ONLY for `dither` -- the checker
// pattern (patternPicksSecondary) then splits those admitted pixels 50/50
// between primary and secondary. Neither phase blends a color; both write a
// real palette-legal value or nothing. So the PRIMARY color's own coverage
// at 50% opacity lands near 25% of a fully-covered baseline (solid@100),
// not ~50% -- measuring "any non-transparent pixel" would miss this,
// because the secondary-colored half is also fully opaque.
//
// Mutation used to prove this discriminates: replace the stamp()/makeInk()
// loop with an approximation that paints every touched pixel in `primary`
// at a flat alpha of opacity/100 (i.e. treats opacity as alpha, the exact
// misconception this preview exists to correct). That approximation would
// put primaryCoverage(dither@50) at ~100% of solid@100 (every pixel gets
// SOME amount of primary), so the ratio assertion below -- which depends on
// roughly 3/4 of the mask's pixels having NO primary in them at all --
// would fail (ratio near 1, not < 0.4).

function countColor(bmp, rgb) {
  let n = 0;
  for (let i = 0; i < bmp.data.length; i += 4) {
    if (bmp.data[i] === rgb[0] && bmp.data[i + 1] === rgb[1] && bmp.data[i + 2] === rgb[2] && bmp.data[i + 3] > 0) n++;
  }
  return n;
}

test('renderBrushPreview: a dither ink at 50% opacity shows its primary color on near 25%, not ~50%, of a fully-covered baseline', () => {
  const primary = [255, 0, 0, 255], secondary = [0, 0, 255, 255];
  const ctx = { primary, secondary, palette: null, seed: 7 };
  const solid = normalizeBrush({ mask: { kind: 'square', size: 2 }, ink: { kind: 'solid', opacity: 100 } });
  // 'lines' rather than 'checker': dither.js's Bayer-4 density gate is ITSELF
  // a checkerboard at exactly the 50%-opacity threshold (a documented
  // property of ordered-dither matrices), which perfectly aligns with the
  // `checker` pattern's own 2x2 split and cancels the effect this test wants
  // to observe -- every admitted pixel would land on `checker`'s primary
  // phase and secondary would never be chosen. `lines` splits on y parity
  // alone, which is NOT aligned with the density gate's own checkerboard.
  const dithered = normalizeBrush({ mask: { kind: 'square', size: 2 }, ink: { kind: 'dither', opacity: 50, pattern: 'lines' } });

  const solidCoverage = countColor(renderBrushPreview(solid, ctx, { width: 32, height: 32 }), primary);
  const ditherPrimaryCoverage = countColor(renderBrushPreview(dithered, ctx, { width: 32, height: 32 }), primary);

  assert.ok(solidCoverage > 0, 'sanity: the solid stroke should paint something');
  assert.ok(ditherPrimaryCoverage > 0, 'the dithered stroke should still show some primary');
  const ratio = ditherPrimaryCoverage / solidCoverage;
  assert.ok(ratio > 0.1 && ratio < 0.4,
    `dither@50 opacity's primary coverage should land near 25% of the solid@100 baseline, not ~50%+ (ratio ${ratio.toFixed(2)}, dither-primary=${ditherPrimaryCoverage}, solid=${solidCoverage})`);
});

test('renderBrushPreview draws an S-curve spanning the frame, not a single dot or a straight line', () => {
  const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'solid', opacity: 100 } });
  const ctx = { primary: [0, 0, 0, 255], secondary: null, palette: null, seed: 1 };
  const bmp = renderBrushPreview(brush, ctx, { width: 40, height: 40 });

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      if (bmp.data[(y * 40 + x) * 4 + 3] > 0) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
  assert.ok(maxX - minX > 20, `stroke should span most of the frame's width (got ${maxX - minX})`);
  assert.ok(maxY - minY > 5, `an S-curve should vary meaningfully in y, not run along one row (got ${maxY - minY})`);
});

test('renderBrushPreview is deterministic for a fixed seed -- identical settings render identical bytes', () => {
  const brush = normalizeBrush({ mask: { kind: 'circle', size: 3, scatter: 2, rotateJitter: true }, ink: { kind: 'solid', opacity: 100 } });
  const ctx = { primary: [10, 20, 30, 255], secondary: null, palette: null, seed: 42 };
  const a = renderBrushPreview(brush, ctx, { width: 24, height: 24 });
  const b = renderBrushPreview(brush, ctx, { width: 24, height: 24 });
  assert.deepEqual([...a.data], [...b.data]);
});

// --- fix round 1, item 1: coerce loudly, not silently ---------------------
//
// The trap the review specifically warned about: normalizeBrush's own
// clampInt (inside library.update, which editBrush already calls) clamps
// an out-of-range number regardless of whether commitCoercedNumber does
// anything at all. So asserting ONLY `lib.get(id).mask.spacing === 64`
// would still pass with commitCoercedNumber's clamping deleted (proved
// below, as its own test) -- it would be measuring normalizeBrush, the
// storage layer, not the handler this fix is actually about. Every test
// here also asserts the returned `message`, which normalizeBrush has no
// way to produce, to actually discriminate.

test('an out-of-range number is clamped, committed, AND reported with a message', () => {
  const { lib, brush, editBrush } = setup();
  const { result, value, message } = commitCoercedNumber(
    editBrush, 'brush mask spacing', '9999', 1, 64, (b, v) => { b.mask.spacing = v; });
  assert.equal(result.ok, true);
  assert.equal(value, 64);
  assert.equal(lib.get(brush.id).mask.spacing, 64, 'the clamped value must actually be committed');
  assert.ok(message && message.includes('64'), 'an out-of-range input must produce a user-visible message');
});

test('a fractional number is rounded, committed, and reported', () => {
  const { lib, brush, editBrush } = setup();
  const { value, message } = commitCoercedNumber(
    editBrush, 'brush ink jitter', '2.6', 0, 8, (b, v) => { b.ink.jitter = v; });
  assert.equal(value, 3);
  assert.equal(lib.get(brush.id).ink.jitter, 3);
  assert.ok(message, 'a rounded input must produce a message too -- 2.6 is not what the user will see stored');
});

test('a non-numeric value falls back to the minimum and is reported', () => {
  const { editBrush } = setup();
  const { value, message } = commitCoercedNumber(
    editBrush, 'brush mask scatter', 'abc', 0, 64, (b, v) => { b.mask.scatter = v; });
  assert.equal(value, 0);
  assert.ok(message);
});

test('an in-range number is committed with NO message', () => {
  const { lib, brush, editBrush } = setup();
  const { message } = commitCoercedNumber(
    editBrush, 'brush mask spacing', '10', 1, 64, (b, v) => { b.mask.spacing = v; });
  assert.equal(message, null, 'a value already within bounds must not be reported as coerced');
  assert.equal(lib.get(brush.id).mask.spacing, 10);
});

test('an empty name commits the "Brush" fallback AND is reported', () => {
  const { lib, brush, editBrush } = setup();
  const { result, value, message } = commitCoercedName(editBrush, 'rename brush', '   ');
  assert.equal(result.ok, true);
  assert.equal(value, 'Brush');
  assert.equal(lib.get(brush.id).name, 'Brush', 'the fallback must actually be committed');
  assert.ok(message, 'an emptied name must produce a user-visible message');
});

test('a non-empty name is committed with NO message', () => {
  const { lib, brush, editBrush } = setup();
  const { message } = commitCoercedName(editBrush, 'rename brush', 'Custom Name');
  assert.equal(message, null);
  assert.equal(lib.get(brush.id).name, 'Custom Name');
});

// Demonstrates the trap explicitly, rather than just asserting around it:
// this reimplements the OLD (pre-fix) handler shape -- hand the raw typed
// value straight to editBrush with no clamping in front of it at all -- and
// shows that normalizeBrush's own clamp still makes the "only assert the
// stored value" version of the test above pass anyway.
test('TRAP: asserting only the stored value cannot tell the old silent handler from the new one', () => {
  const { lib, brush, editBrush } = setup();
  // The pre-fix shape: `b.mask.spacing = Number(input.value)`, unclamped.
  editBrush('brush mask spacing', b => { b.mask.spacing = Number('9999'); return b; });
  assert.equal(lib.get(brush.id).mask.spacing, 64, 'normalizeBrush clamps regardless -- this line proves the trap, not the fix');
});
