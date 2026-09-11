import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { createBitmap } from '../js/core/pixels.js';
import { createPalette, setEntry } from '../js/core/palettes.js';
import { stepAlongRamp } from '../js/core/ramps.js';
import {
  createNewPalette, duplicatePalette, renamePalette, deletePalette,
  addPaletteSwatch, setSwatchColor, remapSwatchColor, clearSwatch,
  removePaletteSwatch, movePaletteSwatch, sortPalette, setPaletteLock,
  setPaletteEmptyColor, setPaletteIndexed, countSwatchPixels,
  nameRamp, deleteRamp,
} from '../js/features/palettes/palette-commands.js';

function makeServices(project, activeSheetId = null) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: activeSheetId ? { kind: 'sprite-sheet', id: activeSheetId } : null });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makePalette(name = 'Pal') {
  const p = createPalette({ name, indexed: true, size: 4, lockReason: 'NES' });
  [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]]
    .forEach((c, i) => setEntry(p, i, c));
  return p;
}

function fillBitmap(bmp, color) {
  for (let i = 0; i < bmp.data.length; i += 4) {
    bmp.data[i] = color[0]; bmp.data[i + 1] = color[1]; bmp.data[i + 2] = color[2]; bmp.data[i + 3] = color[3];
  }
  return bmp;
}

function projectWithSheet(palettes, bmp) {
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: bmp.width, height: bmp.height, kind: 'sprite', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  return { sheets: [sheet], maps: [], palettes, activePaletteId: palettes[0]?.id ?? null };
}

test('createNewPalette adds and selects it; undo removes it and restores the old selection', () => {
  const existing = makePalette('Old');
  const project = { sheets: [], maps: [], palettes: [existing], activePaletteId: existing.id };
  const services = makeServices(project);
  const fresh = makePalette('Fresh');

  createNewPalette(services, fresh);
  assert.deepEqual(project.palettes.map(p => p.name), ['Old', 'Fresh']);
  assert.equal(project.activePaletteId, fresh.id);

  services.history.undo();
  assert.deepEqual(project.palettes.map(p => p.name), ['Old']);
  assert.equal(project.activePaletteId, existing.id);

  services.history.redo();
  assert.equal(project.activePaletteId, fresh.id);
});

test('duplicatePalette produces an independent copy with a new id', () => {
  const src = makePalette();
  const project = { sheets: [], maps: [], palettes: [src], activePaletteId: src.id };
  const services = makeServices(project);

  duplicatePalette(services, src.id);
  const copy = project.palettes[1];
  assert.notEqual(copy.id, src.id);
  assert.match(copy.name, /copy/i);
  assert.deepEqual(copy.colors, src.colors);
  copy.colors[0][0] = 1;
  assert.equal(src.colors[0][0], 255, 'the copy must not alias the source colors');

  services.history.undo();
  assert.equal(project.palettes.length, 1);
});

test('renamePalette is undoable', () => {
  const p = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  renamePalette(services, p.id, 'Renamed');
  assert.equal(p.name, 'Renamed');
  services.history.undo();
  assert.equal(p.name, 'Pal');
});

test('deletePalette restores the palette at its original position on undo', () => {
  const a = makePalette('A'), b = makePalette('B'), c = makePalette('C');
  const project = { sheets: [], maps: [], palettes: [a, b, c], activePaletteId: b.id };
  const services = makeServices(project);

  deletePalette(services, b.id);
  assert.deepEqual(project.palettes.map(p => p.name), ['A', 'C']);
  assert.notEqual(project.activePaletteId, b.id);

  services.history.undo();
  assert.deepEqual(project.palettes.map(p => p.name), ['A', 'B', 'C']);
  assert.equal(project.activePaletteId, b.id);
});

test('addPaletteSwatch fills a locked palette empty slot and undo re-empties exactly that slot', () => {
  const p = createPalette({ name: 'L', indexed: true, size: 2, lockReason: 'x' });
  setEntry(p, 0, [1, 1, 1, 255]);
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  addPaletteSwatch(services, p.id, [7, 7, 7, 255]);
  assert.deepEqual(p.colors[1], [7, 7, 7, 255]);
  assert.deepEqual(p.empty, [false, false]);

  services.history.undo();
  assert.deepEqual(p.empty, [false, true]);
  assert.deepEqual(p.colors[1], p.emptyColor);
});

test('addPaletteSwatch on a full locked palette records no history at all', () => {
  const p = createPalette({ name: 'L', indexed: true, size: 1, lockReason: 'x' });
  setEntry(p, 0, [1, 1, 1, 255]);
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  addPaletteSwatch(services, p.id, [7, 7, 7, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('setSwatchColor never touches pixels, and is a no-op when the color is unchanged', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), p.colors[0]);
  const services = makeServices(projectWithSheet([p], bmp), 'sheet1');

  setSwatchColor(services, p.id, 0, [9, 9, 9, 255]);
  assert.deepEqual(p.colors[0], [9, 9, 9, 255]);
  assert.equal(bmp.data[0], 255, 'setSwatchColor must not remap pixels');

  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);

  setSwatchColor(services, p.id, 0, [255, 0, 0, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('remapSwatchColor rewrites the entry and matching pixels in one undo step', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), p.colors[0]);
  const before = Uint8ClampedArray.from(bmp.data);
  const services = makeServices(projectWithSheet([p], bmp), 'sheet1');

  remapSwatchColor(services, p.id, 0, [9, 8, 7, 255]);
  assert.deepEqual(p.colors[0], [9, 8, 7, 255]);
  assert.equal(bmp.data[0], 9);

  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);
  assert.deepEqual(Array.from(bmp.data), Array.from(before));
});

test('remapSwatchColor works with no active sheet -- the maps-mode case that used to be a silent no-op', () => {
  const p = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  remapSwatchColor(services, p.id, 0, [1, 1, 1, 255]);
  assert.deepEqual(p.colors[0], [1, 1, 1, 255]);
  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);
});

test('countSwatchPixels counts exact matches on the active sheet and returns 0 with no sheet', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), p.colors[0]);
  assert.equal(countSwatchPixels(makeServices(projectWithSheet([p], bmp), 'sheet1'), p.colors[0]), 4);
  assert.equal(countSwatchPixels(makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id }), p.colors[0]), 0);
});

test('clearSwatch and removePaletteSwatch are undoable and respect the lock', () => {
  const locked = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [locked], activePaletteId: locked.id });

  clearSwatch(services, locked.id, 1);
  assert.equal(locked.empty[1], true);
  assert.equal(locked.colors.length, 4);
  services.history.undo();
  assert.deepEqual(locked.colors[1], [0, 255, 0, 255]);
  assert.equal(locked.empty[1], false);

  // locked: remove clears in place rather than shrinking
  removePaletteSwatch(services, locked.id, 1);
  assert.equal(locked.colors.length, 4);
  assert.equal(locked.empty[1], true);
  services.history.undo();
  assert.deepEqual(locked.colors[1], [0, 255, 0, 255]);
});

test('removePaletteSwatch splices an unlocked palette and undo restores order', () => {
  const p = createPalette({ name: 'free' });
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  addPaletteSwatch(services, p.id, [1, 1, 1, 255]);
  addPaletteSwatch(services, p.id, [2, 2, 2, 255]);

  removePaletteSwatch(services, p.id, 0);
  assert.deepEqual(p.colors, [[2, 2, 2, 255]]);
  services.history.undo();
  assert.deepEqual(p.colors, [[1, 1, 1, 255], [2, 2, 2, 255]]);
});

test('movePaletteSwatch and sortPalette reorder colors and flags together, undoably', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 3, lockReason: '' });
  setEntry(p, 0, [255, 255, 255, 255]);
  setEntry(p, 2, [0, 0, 0, 255]);

  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  movePaletteSwatch(services, p.id, 2, 0);
  assert.deepEqual(p.colors[0], [0, 0, 0, 255]);
  assert.deepEqual(p.empty, [false, false, true]);
  services.history.undo();
  assert.deepEqual(p.empty, [false, true, false]);

  sortPalette(services, p.id, 'luminance');
  assert.deepEqual(p.colors[p.colors.length - 1], [255, 255, 255, 255]);
  assert.equal(p.colors.length, 3);
  assert.equal(p.empty.length, 3);
  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 255, 255, 255]);
});

test('setPaletteLock pads, truncates and unlocks, all undoable byte-for-byte', () => {
  const p = createPalette({ name: 'free' });
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  addPaletteSwatch(services, p.id, [1, 1, 1, 255]);

  setPaletteLock(services, p.id, 4, 'NES');
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
  assert.deepEqual(p.empty, [false, true, true, true]);

  setPaletteLock(services, p.id, 2, 'Game Boy');
  assert.equal(p.colors.length, 2);

  services.history.undo();
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });

  services.history.undo();
  assert.equal(p.lock, null);
  assert.deepEqual(p.colors, [[1, 1, 1, 255]]);
});

test('setPaletteEmptyColor re-syncs empty slots and undo restores both color and flags', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2, lockReason: '' });
  setEntry(p, 0, [1, 1, 1, 255]);
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  setPaletteEmptyColor(services, p.id, [200, 0, 200, 255]);
  assert.deepEqual(p.emptyColor, [200, 0, 200, 255]);
  assert.deepEqual(p.colors[1], [200, 0, 200, 255]);
  assert.deepEqual(p.colors[0], [1, 1, 1, 255]);

  services.history.undo();
  assert.deepEqual(p.emptyColor, [0, 0, 0, 255]);
  assert.deepEqual(p.colors[1], [0, 0, 0, 255]);
});

test('setPaletteIndexed toggles only the brush-snap flag, never the size', () => {
  const p = makePalette();
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  setPaletteIndexed(services, p.id, false);
  assert.equal(p.indexed, false);
  assert.equal(p.colors.length, 4);
  assert.deepEqual(p.lock, { size: 4, reason: 'NES' });
  services.history.undo();
  assert.equal(p.indexed, true);
});

test('every palette command lands on the project scope, so it survives a document switch', () => {
  const p = makePalette();
  const bmp = fillBitmap(createBitmap(1, 1), [0, 0, 0, 255]);
  const project = projectWithSheet([p], bmp);
  const services = makeServices(project, 'sheet1');

  setSwatchColor(services, p.id, 0, [3, 3, 3, 255]);
  services.store.updateSession({ activeDocument: { kind: 'map', id: 'map1' } });
  assert.equal(services.history.canUndo(), true, 'palette edits stay undoable from another document');
  services.history.undo();
  assert.deepEqual(p.colors[0], [255, 0, 0, 255]);
});

test('commands re-resolve their palette by id, so undo hits the right one after the selection moves', () => {
  const first = makePalette('First'), second = makePalette('Second');
  const project = { sheets: [], maps: [], palettes: [first, second], activePaletteId: first.id };
  const services = makeServices(project);

  setSwatchColor(services, first.id, 0, [10, 20, 30, 255]);
  project.activePaletteId = second.id;
  services.history.undo();
  assert.deepEqual(first.colors[0], [255, 0, 0, 255]);
  assert.deepEqual(second.colors[0], [255, 0, 0, 255]);
});

test('setPaletteLock records nothing when the requested lock is the one already in force', () => {
  const p = createPalette({ name: 'idx', indexed: true, size: 2, lockReason: 'NES' });
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });

  setPaletteLock(services, p.id, 2, 'NES');
  assert.equal(services.history.canUndo(), false, 'an identical lock is not a change');

  // ...but a different reason at the same size still is one
  setPaletteLock(services, p.id, 2, 'Game Boy');
  assert.deepEqual(p.lock, { size: 2, reason: 'Game Boy' });
  services.history.undo();
  assert.deepEqual(p.lock, { size: 2, reason: 'NES' });
});

test('setPaletteLock(null) on an already-unlocked palette records nothing', () => {
  const p = createPalette({ name: 'free' });
  const services = makeServices({ sheets: [], maps: [], palettes: [p], activePaletteId: p.id });
  setPaletteLock(services, p.id, null);
  assert.equal(services.history.canUndo(), false);
});

// ---- named ramps ----

// Local to these tests: the two-line setup the existing tests in this file
// already repeat inline.
function rampFixture() {
  const palette = makePalette('Ramps');
  const project = { sheets: [], maps: [], palettes: [palette], activePaletteId: palette.id };
  return { palette, services: makeServices(project) };
}

test('nameRamp adds a named ramp and undo removes it', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1, 2]);
  assert.deepEqual(palette.ramps, [{ name: 'skin', indices: [0, 1, 2] }]);
  services.history.undo();
  assert.deepEqual(palette.ramps, []);
});

test('nameRamp replaces a ramp of the same name rather than duplicating it', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1]);
  nameRamp(services, palette.id, 'skin', [2, 3]);
  assert.equal(palette.ramps.length, 1);
  assert.deepEqual(palette.ramps[0].indices, [2, 3]);
});

test('deleteRamp removes one ramp and undo restores it', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1]);
  deleteRamp(services, palette.id, 'skin');
  assert.deepEqual(palette.ramps, []);
  services.history.undo();
  assert.equal(palette.ramps.length, 1);
});

test('deleteRamp on an unknown name records no history entry', () => {
  const { services, palette } = rampFixture();
  const before = services.history.canUndo();
  deleteRamp(services, palette.id, 'missing');
  assert.equal(services.history.canUndo(), before);
});

test('nameRamp is a no-op for an unknown palette', () => {
  const { services } = rampFixture();
  assert.doesNotThrow(() => nameRamp(services, 'missing', 'x', [0]));
});

test('nameRamp is a no-op when re-naming a ramp with identical indices (no dead undo step)', () => {
  const { services, palette } = rampFixture();
  nameRamp(services, palette.id, 'skin', [0, 1, 2]);
  assert.equal(services.history.canUndo(), true);

  // Byte-identical re-name: same name, same indices (a fresh array, per the
  // amendment -- the caller never hands back the same reference). The
  // manager's UI fires this on every re-selection, including one that just
  // re-confirms the ramp already stored, so this must not add a step.
  nameRamp(services, palette.id, 'skin', [0, 1, 2]);

  // Discriminating check: palette.ramps looks identical either way right
  // after the second call, because an unguarded re-name overwrites with the
  // same content rather than appending a visible change. Only counting undo
  // STEPS tells "one" from "two" apart: a single undo() must fully unwind
  // back to no ramp at all. If the guard were absent, this same undo() would
  // only unwind the second (no-op) command, leaving
  // palette.ramps === [{ name: 'skin', indices: [0, 1, 2] }] and
  // canUndo() === true -- exactly what asserting ramps.length alone would
  // miss.
  services.history.undo();
  assert.equal(services.history.canUndo(), false, 'the identical re-name must not have recorded a second undo step');
  assert.deepEqual(palette.ramps, []);
});

test('nameRamp drops out-of-range indices so the surviving ramp still resolves via stepAlongRamp', () => {
  const { services, palette } = rampFixture();

  // Control: a clean two-entry ramp (indices 0 and 1 are both real colors on
  // this 4-color palette). Stepping past its last entry must clamp to that
  // entry and return a real color -- never null.
  nameRamp(services, palette.id, 'clean', [0, 1]);
  const cleanStep = stepAlongRamp(palette, palette.colors[1], 1, 'clean');
  assert.deepEqual(cleanStep, palette.colors[1], 'control: a clean ramp must resolve a step, not go null');

  // Dirty: the SAME two real indices, plus 99 (past the palette's 4 colors)
  // and -3 (negative) -- an out-of-range index a caller could hand in from
  // stale UI state. If nameRamp stored these verbatim instead of filtering,
  // palette.ramps would carry a 4-entry indices array whose last two entries
  // never resolve to a color. js/core/ramps.js's stepAlongRamp clamps the
  // next step against that raw array LENGTH, not against how many entries
  // actually resolve, so stepping from index 1 by +1 would land on the bad
  // index 99 and return null -- exactly the "ramp silently does nothing"
  // failure the amendment's probe found, even though the ramp still "has"
  // its two good indices.
  nameRamp(services, palette.id, 'dirty', [0, 1, 99, -3]);
  assert.deepEqual(palette.ramps.find(r => r.name === 'dirty').indices, [0, 1],
    'out-of-range indices must be dropped at write time');
  const dirtyStep = stepAlongRamp(palette, palette.colors[1], 1, 'dirty');
  assert.deepEqual(dirtyStep, cleanStep,
    'the surviving ramp must actually resolve a step like the control -- an unfiltered ramp returns null here instead');
});

test('nameRamp refuses a ramp left with fewer than two usable indices after filtering', () => {
  const { services, palette } = rampFixture();
  const before = services.history.canUndo();
  // Only index 1 survives filtering (99 and -3 are out of range on this
  // 4-color palette); one index is not a ramp.
  nameRamp(services, palette.id, 'useless', [99, -3, 1]);
  assert.equal(services.history.canUndo(), before, 'an unusable ramp must record no history entry');
  assert.equal(palette.ramps.length, 0);
});
