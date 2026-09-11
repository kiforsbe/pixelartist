// Task 15b: brush-files.js's pure parts.
//
// exportBrush/importBrush themselves need `window`/`document`/File System
// Access, so they are exercised by manual verification instead (see
// task-15b-report.md); parseImportedBrushJson and brushFilename are split
// out specifically so the format-sniffing decision and the name-to-filename
// mapping stay testable without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush } from '../js/core/brushes.js';
import { bitmapToBrush, serializeBrushJson } from '../js/core/brush-io.js';
import { createBitmap, setPixel } from '../js/core/pixels.js';
import { parseImportedBrushJson, brushFilename } from '../js/features/brushes/brush-files.js';

// Mutation used to prove this discriminates: drop the `Array.isArray(raw) ||
// Array.isArray(raw?.brushes)` sniff and always call parseBrushJson. Without
// it, a whole-library file (an array, or `{version, brushes}`) would either
// throw (parseBrushJson rejects an array outright) or -- worse -- silently
// misparse, since a bare brush-shaped access on an array/`{brushes}` object
// would come back with mostly-undefined fields that normalizeBrush would
// paper over with defaults instead of surfacing the mismatch.
test('parseImportedBrushJson treats a single-brush file as one Brush', () => {
  const brush = normalizeBrush({ name: 'Solo', mask: { kind: 'circle', size: 4 } });
  const result = parseImportedBrushJson(JSON.stringify(brush));
  assert.equal(Array.isArray(result), false);
  assert.equal(result.name, 'Solo');
  assert.equal(result.mask.size, 4);
});

test('parseImportedBrushJson treats a {version, brushes} library file as an array', () => {
  const lib = { version: 1, brushes: [normalizeBrush({ name: 'A' }), normalizeBrush({ name: 'B' })] };
  const result = parseImportedBrushJson(JSON.stringify(lib));
  assert.equal(Array.isArray(result), true);
  assert.deepEqual(result.map(b => b.name), ['A', 'B']);
});

test('parseImportedBrushJson treats a bare array file as a library too', () => {
  const bare = [normalizeBrush({ name: 'X' })];
  const result = parseImportedBrushJson(JSON.stringify(bare));
  assert.equal(Array.isArray(result), true);
  assert.equal(result[0].name, 'X');
});

test('parseImportedBrushJson round-trips a custom mask\'s Uint8Array bitmap', () => {
  // serializeBrushJson, not a raw JSON.stringify(brush) -- that's what a real
  // exported FILE actually contains (toPlain runs bits through Array.from
  // first; a bare Uint8Array serializes as a {"0":1,...} object instead of an
  // array, which is exactly the trap toPlain/fromPlain exist to avoid).
  const src = createBitmap(2, 2);
  setPixel(src, 0, 0, [9, 9, 9, 255]);
  const brush = bitmapToBrush(src, 'Custom');
  const result = parseImportedBrushJson(serializeBrushJson(brush));
  assert.ok(result.mask.bitmap.bits instanceof Uint8Array,
    'a plain-object bitmap.bits (post-JSON) must be rehydrated to a real Uint8Array');
  assert.equal(result.mask.bitmap.bits[0], 1);
});

// brushFilename: no metadata channel to fold in (unlike paletteFilename's
// lock suffix) -- just the brush's own name, sanitized, with the format's
// extension.
test('brushFilename uses .brush.json for the json format', () => {
  assert.equal(brushFilename({ name: 'Foliage' }, 'json'), 'Foliage.brush.json');
});

test('brushFilename uses .png for the png format', () => {
  assert.equal(brushFilename({ name: 'Foliage' }, 'png'), 'Foliage.png');
});

test('brushFilename sanitizes filesystem-hostile characters out of the name', () => {
  assert.equal(brushFilename({ name: 'A/B:C*D?E"F<G>H|I' }, 'json'), 'A_B_C_D_E_F_G_H_I.brush.json');
});
