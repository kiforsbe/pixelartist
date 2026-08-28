import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addLayer, flattenSheet, mergeDown } from '../js/core/model.js';
import { getPixel, setPixel } from '../js/core/pixels.js';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { mergeLayerDownCmd as mergeSpriteLayer } from '../js/modes/sprites/application/commands/layer-commands.js';
import { mergeLayerDownCmd as mergeTileLayer } from '../js/modes/tiles/application/commands/layer-commands.js';
import { createTerrainSet, assignSlot } from '../js/core/terrainsets.js';
import { setTileSize } from '../js/modes/tiles/application/commands/tile-sheet-commands.js';
import { paintTerrainStroke } from '../js/modes/tiles/application/commands/autotile-paint-commands.js';

function fixture(kind = 'tile') {
  const project = createProject('review regressions');
  const sheet = createSheet(project, { name: 'sheet', width: 16, height: 8, kind });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }) };
  return { project, sheet, services };
}

for (const reverse of [false, true]) {
  test(`R10 rejected terrain owners block dependent moves while independent moves succeed (reverse=${reverse})`, () => {
    const { sheet, services } = fixture();
    const terrain = createTerrainSet(sheet, { name: 'Ground', tileW: 8, tileH: 8 });
    // Blob slots: isolated=0, North=1, East=2, North+East=3, North+NE+East=4.
    const a = { id: 'a', w: 8, h: 8 };
    const b = { id: 'b', w: 8, h: 8 };
    const c = { id: 'c', w: 8, h: 8 };
    const d = { id: 'd', w: 8, h: 8, duplicateOf: 'c' };
    sheet.tiles.push(a, b, c, d);
    assignSlot(sheet, terrain, 1, a);
    assignSlot(sheet, terrain, 3, b);
    assignSlot(sheet, terrain, 0, c);
    const masks = [['a', 0], ['b', 1], ['d', 4]];
    if (reverse) masks.reverse();

    const { conflicts } = paintTerrainStroke(services, sheet.id, terrain.id, new Map(masks));

    assert.deepEqual([...conflicts].sort(), [['a', 0], ['b', 1]]);
    const assertPainted = () => {
      assert.deepEqual(terrain.slots, { 0: 'c', 1: 'a', 2: 'd', 3: 'b' });
      for (const tile of sheet.tiles) {
        assert.equal(tile.terrainSetId, terrain.id);
        assert.equal(terrain.slots[tile.blobIndex], tile.id, 'slot and tile back-reference must agree');
      }
      assert.equal(d.duplicateOf, undefined);
    };
    assertPainted();
    for (let n = 0; n < 3; n++) {
      services.history.undo();
      assert.deepEqual(terrain.slots, { 0: 'c', 1: 'a', 3: 'b' });
      assert.equal(a.blobIndex, 1);
      assert.equal(b.blobIndex, 3);
      assert.equal(d.terrainSetId, undefined);
      assert.equal(d.duplicateOf, 'c');
      services.history.redo();
      assertPainted();
    }
  });
}

test('R10 a wholly blocked ownership chain creates no history entry', () => {
  const { sheet, services } = fixture();
  const terrain = createTerrainSet(sheet, { name: 'Ground', tileW: 8, tileH: 8 });
  for (const [id, slot] of [['a', 1], ['b', 3], ['c', 0], ['d', 4]]) {
    const tile = { id, w: 8, h: 8 };
    sheet.tiles.push(tile);
    assignSlot(sheet, terrain, slot, tile);
  }
  const { conflicts } = paintTerrainStroke(services, sheet.id, terrain.id, new Map([['d', 5], ['b', 1], ['a', 0]]));
  assert.deepEqual([...conflicts].sort(), [['a', 0], ['b', 1], ['d', 3]]);
  assert.deepEqual(terrain.slots, { 0: 'c', 1: 'a', 3: 'b', 4: 'd' });
  assert.equal(services.history.canUndo(), false);
  assert.equal(services.projects.dirty, false);
});

test('R10 simultaneous terrain slot swaps remain permitted', () => {
  const { sheet, services } = fixture();
  const terrain = createTerrainSet(sheet, { name: 'Ground', tileW: 8, tileH: 8 });
  const a = { id: 'a', w: 8, h: 8 }, b = { id: 'b', w: 8, h: 8 };
  sheet.tiles.push(a, b);
  assignSlot(sheet, terrain, 0, a);
  assignSlot(sheet, terrain, 1, b);
  const { conflicts } = paintTerrainStroke(services, sheet.id, terrain.id, new Map([['a', 1], ['b', 0]]));
  assert.equal(conflicts.size, 0);
  assert.deepEqual(terrain.slots, { 0: 'b', 1: 'a' });
  assert.equal(a.blobIndex, 1);
  assert.equal(b.blobIndex, 0);
});

for (const key of ['w', 'h']) {
  test(`R09 tile ${key} history restores populated terrain slots and preserves duplicate markers`, () => {
    const { sheet, services } = fixture();
    const terrain = createTerrainSet(sheet, { name: 'Ground', tileW: 8, tileH: 8 });
    const tile = { id: 'canonical', x: 0, y: 0, w: 8, h: 8, gridId: null };
    const duplicate = { id: 'duplicate', x: 8, y: 0, w: 8, h: 8, gridId: null, duplicateOf: tile.id };
    sheet.tiles.push(tile, duplicate);
    assignSlot(sheet, terrain, 3, tile);
    setTileSize(services, sheet.id, tile.id, key, 4);
    assert.deepEqual(terrain.slots, {});
    assert.equal(tile.terrainSetId, undefined);

    for (let n = 0; n < 3; n++) {
      services.history.undo();
      assert.equal(tile[key], 8);
      assert.deepEqual(terrain.slots, { 3: 'canonical' });
      assert.equal(tile.terrainSetId, terrain.id);
      assert.equal(tile.blobIndex, 3);
      assert.equal(sheet.tiles[0], tile);
      assert.equal(duplicate.duplicateOf, 'canonical');
      assert.equal(duplicate.terrainSetId, undefined);
      services.history.redo();
      assert.equal(tile[key], 4);
      assert.deepEqual(terrain.slots, {});
      assert.equal(tile.terrainSetId, undefined);
      assert.equal(tile.blobIndex, undefined);
      assert.equal(duplicate.duplicateOf, 'canonical');
    }
  });
}

for (const { label, bottomOpacity, topOpacity, bottomVisible, topVisible, pixel } of [
  { label: 'translucent destination', bottomOpacity: 0.5, topOpacity: 1, bottomVisible: true, topVisible: true, pixel: [255, 0, 0, 255] },
  { label: 'both translucent', bottomOpacity: 0.5, topOpacity: 0.5, bottomVisible: true, topVisible: true, pixel: [170, 0, 85, 192] },
  { label: 'hidden destination', bottomOpacity: 0.5, topOpacity: 1, bottomVisible: false, topVisible: true, pixel: [255, 0, 0, 255] },
  { label: 'hidden source', bottomOpacity: 0.5, topOpacity: 1, bottomVisible: true, topVisible: false, pixel: [0, 0, 255, 128] },
  { label: 'both hidden', bottomOpacity: 0.5, topOpacity: 1, bottomVisible: false, topVisible: false, pixel: [0, 0, 0, 0] },
]) {
  test(`R08 mergeDown preserves the visible composite: ${label}`, () => {
    const { sheet } = fixture();
    const bottom = sheet.layerTree.children[0];
    const top = addLayer(sheet, 'top');
    Object.assign(bottom, { opacity: bottomOpacity, visible: bottomVisible });
    Object.assign(top, { opacity: topOpacity, visible: topVisible });
    setPixel(bottom.bitmap, 0, 0, [0, 0, 255, 255]);
    setPixel(top.bitmap, 0, 0, [255, 0, 0, 255]);
    assert.deepEqual(getPixel(flattenSheet(sheet), 0, 0), pixel);
    const bitmap = bottom.bitmap;

    mergeDown(sheet, top.id);

    assert.equal(bottom.bitmap, bitmap, 'bitmap identity survives merging');
    assert.deepEqual(getPixel(flattenSheet(sheet), 0, 0), pixel);
  });
}

for (const [kind, merge] of [['sprite', mergeSpriteLayer], ['tile', mergeTileLayer]]) {
  for (const visible of [true, false]) {
    test(`R08 ${kind} merge history restores destination pixels and metadata (visible=${visible})`, () => {
      const { sheet, services } = fixture(kind);
      const bottom = sheet.layerTree.children[0];
      const top = addLayer(sheet, 'top');
      bottom.opacity = 0.5;
      bottom.visible = visible;
      setPixel(bottom.bitmap, 0, 0, [0, 0, 255, 255]);
      setPixel(top.bitmap, 0, 0, [255, 0, 0, 255]);
      merge(services, sheet.id, top.id);
      assert.deepEqual(getPixel(flattenSheet(sheet), 0, 0), [255, 0, 0, 255]);

      for (let n = 0; n < 3; n++) {
        services.history.undo();
        assert.deepEqual(sheet.layerTree.children, [bottom, top]);
        assert.deepEqual(getPixel(bottom.bitmap, 0, 0), [0, 0, 255, 255]);
        assert.equal(bottom.opacity, 0.5);
        assert.equal(bottom.visible, visible);
        services.history.redo();
        assert.deepEqual(sheet.layerTree.children, [bottom]);
        assert.deepEqual(getPixel(flattenSheet(sheet), 0, 0), [255, 0, 0, 255]);
      }
    });
  }
}
