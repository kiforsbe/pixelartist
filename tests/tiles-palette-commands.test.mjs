// tests/tiles-palette-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import { createBitmap } from '../js/core/pixels.js';
import { editPaletteColor, remapPaletteColor } from '../js/modes/tiles/application/commands/palette-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
}

function makePalette() {
  return { id: 'pal1', name: 'Pal', indexed: true, size: 4, colors: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]] };
}

function fillBitmap(bmp, color) {
  for (let i = 0; i < bmp.data.length; i += 4) {
    bmp.data[i] = color[0]; bmp.data[i + 1] = color[1]; bmp.data[i + 2] = color[2]; bmp.data[i + 3] = color[3];
  }
  return bmp;
}

function resetLegacy() {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = null;
  state.activeSheetId = null;
}

test('editPaletteColor sets the palette entry and undo restores the exact prior entry', () => {
  resetLegacy();
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);

  editPaletteColor(services, 0, [10, 20, 30, 255]);
  assert.deepEqual(pal.colors[0], [10, 20, 30, 255]);

  services.history.undo();
  assert.deepEqual(pal.colors[0], [255, 0, 0, 255]);

  services.history.redo();
  assert.deepEqual(pal.colors[0], [10, 20, 30, 255]);
});

test('editPaletteColor does not touch sheet bitmaps (no remap)', () => {
  resetLegacy();
  const pal = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), pal.colors[0]);
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: 2, height: 2, kind: 'tile', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);
  state.project = project; state.activeSheetId = 'sheet1';

  editPaletteColor(services, 0, [9, 9, 9, 255]);
  assert.equal(bmp.data[0], 255); // unchanged -- editPaletteColor never remaps pixels
});

test('editPaletteColor is a no-op when the color is unchanged', () => {
  resetLegacy();
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);

  editPaletteColor(services, 0, [255, 0, 0, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('remapPaletteColor updates the palette entry and remaps matching pixels on the active sheet, and undo restores both byte-for-byte', () => {
  resetLegacy();
  const pal = makePalette();
  const oldColor = pal.colors[0];
  const bmp = fillBitmap(createBitmap(2, 2), oldColor);
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: 2, height: 2, kind: 'tile', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);
  state.project = project; state.activeSheetId = 'sheet1';

  const beforeBytes = Uint8ClampedArray.from(bmp.data);

  remapPaletteColor(services, 0, [9, 8, 7, 255]);
  assert.deepEqual(pal.colors[0], [9, 8, 7, 255]);
  for (let i = 0; i < bmp.data.length; i += 4) {
    assert.equal(bmp.data[i], 9); assert.equal(bmp.data[i + 1], 8); assert.equal(bmp.data[i + 2], 7); assert.equal(bmp.data[i + 3], 255);
  }

  services.history.undo();
  assert.deepEqual(pal.colors[0], [255, 0, 0, 255]);
  assert.deepEqual(Array.from(bmp.data), Array.from(beforeBytes));

  services.history.redo();
  assert.deepEqual(pal.colors[0], [9, 8, 7, 255]);
  assert.equal(bmp.data[0], 9);
});

test('remapPaletteColor only remaps pixels matching the exact old color, leaving others untouched', () => {
  resetLegacy();
  const pal = makePalette();
  const oldColor = pal.colors[0]; // [255,0,0,255]
  const otherColor = [1, 2, 3, 255];
  const bmp = createBitmap(2, 1);
  bmp.data.set(oldColor, 0);
  bmp.data.set(otherColor, 4);
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: 2, height: 1, kind: 'tile', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);
  state.project = project; state.activeSheetId = 'sheet1';

  remapPaletteColor(services, 0, [50, 50, 50, 255]);
  assert.deepEqual(Array.from(bmp.data.slice(0, 4)), [50, 50, 50, 255]);
  assert.deepEqual(Array.from(bmp.data.slice(4, 8)), otherColor);

  services.history.undo();
  assert.deepEqual(Array.from(bmp.data.slice(0, 4)), oldColor);
  assert.deepEqual(Array.from(bmp.data.slice(4, 8)), otherColor);
});

test('remapPaletteColor with no active sheet still updates the palette entry (no layers to patch)', () => {
  resetLegacy();
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);
  // state.project / state.activeSheetId left unset -> activeSheet() returns null

  remapPaletteColor(services, 0, [1, 1, 1, 255]);
  assert.deepEqual(pal.colors[0], [1, 1, 1, 255]);

  services.history.undo();
  assert.deepEqual(pal.colors[0], [255, 0, 0, 255]);
});

test('remapPaletteColor is a no-op when the color is unchanged', () => {
  resetLegacy();
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);

  remapPaletteColor(services, 0, [255, 0, 0, 255]);
  assert.equal(services.history.canUndo(), false);
});
