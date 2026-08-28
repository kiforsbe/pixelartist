// tests/sprites-palette-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { createBitmap } from '../js/core/pixels.js';
import { editPaletteColor, remapPaletteColor } from '../js/modes/sprites/application/commands/palette-commands.js';

function makeServices(project, activeSheetId = null) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: activeSheetId ? { kind: 'sprite-sheet', id: activeSheetId } : null });
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

test('editPaletteColor sets the palette entry and undo restores the exact prior entry', () => {
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
  const pal = makePalette();
  const bmp = fillBitmap(createBitmap(2, 2), pal.colors[0]);
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: 2, height: 2, kind: 'sprite', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project, 'sheet1');

  editPaletteColor(services, 0, [9, 9, 9, 255]);
  assert.equal(bmp.data[0], 255); // unchanged -- editPaletteColor never remaps pixels
});

test('editPaletteColor is a no-op when the color is unchanged', () => {
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);

  editPaletteColor(services, 0, [255, 0, 0, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('remapPaletteColor updates the palette entry and remaps matching pixels on the active sheet, and undo restores both byte-for-byte', () => {
  const pal = makePalette();
  const oldColor = pal.colors[0];
  const bmp = fillBitmap(createBitmap(2, 2), oldColor);
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: 2, height: 2, kind: 'sprite', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project, 'sheet1');

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
  const pal = makePalette();
  const oldColor = pal.colors[0]; // [255,0,0,255]
  const otherColor = [1, 2, 3, 255];
  const bmp = createBitmap(2, 1);
  bmp.data.set(oldColor, 0);
  bmp.data.set(otherColor, 4);
  const layer = { id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp };
  const sheet = { id: 'sheet1', width: 2, height: 1, kind: 'sprite', layerTree: { id: 'root', type: 'group', children: [layer] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project, 'sheet1');

  remapPaletteColor(services, 0, [50, 50, 50, 255]);
  assert.deepEqual(Array.from(bmp.data.slice(0, 4)), [50, 50, 50, 255]);
  assert.deepEqual(Array.from(bmp.data.slice(4, 8)), otherColor);

  services.history.undo();
  assert.deepEqual(Array.from(bmp.data.slice(0, 4)), oldColor);
  assert.deepEqual(Array.from(bmp.data.slice(4, 8)), otherColor);
});

test('remapPaletteColor with no active sheet still updates the palette entry (no layers to patch)', () => {
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);
  // activeDocument left unset -> no active sheet

  remapPaletteColor(services, 0, [1, 1, 1, 255]);
  assert.deepEqual(pal.colors[0], [1, 1, 1, 255]);

  services.history.undo();
  assert.deepEqual(pal.colors[0], [255, 0, 0, 255]);
});

test('remapPaletteColor is a no-op when the color is unchanged', () => {
  const pal = makePalette();
  const project = { sheets: [], maps: [], palettes: [pal], activePaletteId: 'pal1' };
  const services = makeServices(project);

  remapPaletteColor(services, 0, [255, 0, 0, 255]);
  assert.equal(services.history.canUndo(), false);
});

test('palette commands keep their original palette target when selection changes before undo and redo', () => {
  const first = makePalette();
  const second = { ...makePalette(), id: 'pal2', colors: [[100, 110, 120, 255], ...makePalette().colors.slice(1)] };
  const project = { sheets: [], maps: [], palettes: [first, second], activePaletteId: first.id };
  const services = makeServices(project);

  editPaletteColor(services, 0, [10, 20, 30, 255]);
  project.activePaletteId = second.id;
  services.history.undo();
  assert.deepEqual(first.colors[0], [255, 0, 0, 255]);
  assert.deepEqual(second.colors[0], [100, 110, 120, 255]);
  project.activePaletteId = null;
  services.history.redo();
  assert.deepEqual(first.colors[0], [10, 20, 30, 255]);
});

test('remapPaletteColor restores its original palette and pixels when selection changes or is cleared', () => {
  const first = makePalette();
  const second = { ...makePalette(), id: 'pal2', colors: [[100, 110, 120, 255], ...makePalette().colors.slice(1)] };
  const bmp = fillBitmap(createBitmap(1, 1), first.colors[0]);
  const sheet = { id: 'sheet1', width: 1, height: 1, kind: 'sprite', layerTree: { id: 'root', type: 'group', children: [{ id: 'l0', type: 'layer', name: 'L', visible: true, opacity: 1, bitmap: bmp }] }, animations: [] };
  const project = { sheets: [sheet], maps: [], palettes: [first, second], activePaletteId: first.id };
  const services = makeServices(project, sheet.id);

  remapPaletteColor(services, 0, [10, 20, 30, 255]);
  project.activePaletteId = second.id; services.history.undo();
  assert.deepEqual(first.colors[0], [255, 0, 0, 255]); assert.deepEqual(Array.from(bmp.data), [255, 0, 0, 255]);
  assert.deepEqual(second.colors[0], [100, 110, 120, 255]);
  project.activePaletteId = null; services.history.redo();
  assert.deepEqual(first.colors[0], [10, 20, 30, 255]); assert.deepEqual(Array.from(bmp.data), [10, 20, 30, 255]);
});
