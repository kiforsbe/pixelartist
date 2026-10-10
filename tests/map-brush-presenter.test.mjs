import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { createProject, createSheet, createMap, createMapLayer } from '../js/core/model.js';
import { mapMode } from '../js/modes/maps/index.js';
import { mapBrushState } from '../js/modes/maps/application/map-brush-state.js';
import { MAP_ORIGIN } from '../js/modes/maps/application/map-geometry.js';
import { bindMapMode, mapHoverPoint } from '../js/modes/maps/presentation/map-tool-presenter.js';
import { clearMapRasterCache, drawMapOverlay } from '../js/modes/maps/presentation/map-renderer.js';

const host = new EditorHost();
setEditorHost(host);
host.registerMode(mapMode);
host.start('maps');

const view = {
  zoom: 1,
  onPointer() {},
  requestRender() {},
  imageToScreen: (x, y) => ({ x: x - MAP_ORIGIN, y: y - MAP_ORIGIN }),
};

const documentBefore = globalThis.document, imageDataBefore = globalThis.ImageData;
before(() => {
  // Only the browser raster/event boundary is replaced. The host, command
  // registry, pointer presenter, flattening, geometry, and overlay stay real.
  globalThis.document = Object.assign(new EventTarget(), {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return { getContext: () => ({ putImageData() {} }) };
    },
  });
  globalThis.ImageData = class {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  };
  bindMapMode(view);
});

after(() => {
  globalThis.document = documentBefore;
  globalThis.ImageData = imageDataBefore;
  host.dispose();
});

function fixture(kind) {
  const project = createProject('Brush snapping');
  const tiles = createSheet(project, { name: 'Tiles', kind: 'tile', width: 64, height: 64 });
  tiles.tiles.push({ id: 'tile1', x: 0, y: 0, w: 10, h: 6 }, { id: 'terrainTile', x: 16, y: 0, w: 8, h: 12 });
  tiles.terrainSets.push({ id: 'terrain1', tileW: 8, tileH: 12, slots: { 0: 'terrainTile' }, symmetry: { flip: false, rotate: false } });
  const sprites = createSheet(project, { name: 'Sprites', kind: 'sprite', width: 64, height: 64 });
  sprites.frames.push({ id: 'frame1', x: 0, y: 0, w: 7, h: 9 }, { id: 'animationFrame', x: 16, y: 0, w: 11, h: 5 });
  sprites.animations.push({ id: 'animation1', frames: [{ frameId: 'animationFrame' }, { frameId: 'frame1' }] });
  const map = createMap(project, { gridW: 16, gridH: 16 });
  map.snap.mode = 'asset';
  const layer = kind === 'frame' || kind === 'animation' ? createMapLayer(map, { type: 'sprite' }) : map.layers[0];
  const tool = layer.type === 'sprite' ? 'mapsprite' : 'maptile';
  host.setProject(project);
  host.history.clear();
  host.store.updateSession({ activeToolId: tool });
  host.selections.set({ layerId: layer.id }, { kind: 'map', id: map.id });
  Object.assign(mapBrushState, {
    tileKind: kind === 'terrain' ? 'terrain' : 'tile', tileSheetId: tiles.id, tileId: 'tile1',
    terrainSheetId: tiles.id, terrainSetId: 'terrain1',
    spriteSheetId: sprites.id, spriteKind: kind === 'animation' ? 'animation' : 'frame',
    spriteId: kind === 'animation' ? 'animation1' : 'frame1',
  });
  clearMapRasterCache();
  return { project, map, layer, tool, tiles };
}

const brushCases = [
  { kind: 'terrain', collection: 'terrain', at: { x: 16, y: -24 }, rect: [16, -24, 8, 12] },
  { kind: 'tile', collection: 'tiles', at: { x: 20, y: -18 }, rect: [20, -18, 10, 6] },
  { kind: 'frame', collection: 'sprites', at: { x: 21, y: -18 }, rect: [21, -18, 7, 9] },
  { kind: 'animation', collection: 'sprites', at: { x: 22, y: -15 }, rect: [22, -15, 11, 5] },
];

function pointer(type, buttons) {
  view.onPointer({ type, buttons, x: MAP_ORIGIN + 23, y: MAP_ORIGIN - 13 });
}

function overlay({ project, map, layer, tool }) {
  const rectangles = [], images = [];
  const ctx = {
    save() {}, restore() {}, setLineDash() {}, fillText() {},
    strokeRect(...args) { rectangles.push(args); },
    drawImage(...args) { images.push(args); },
  };
  drawMapOverlay(view, ctx, project, map, { tool, hover: mapHoverPoint(), activeLayerId: layer.id });
  return { rectangles, images };
}

for (const { kind, collection, at, rect } of brushCases) {
  test(`${kind} pointer brush places an asset-grid-snapped item with signed finite coordinates`, () => {
    const { layer } = fixture(kind);
    pointer('down', 1);
    pointer('up', 0);
    assert.equal(layer[collection].length, 1);
    const item = layer[collection][0];
    assert.deepEqual({ x: item.x, y: item.y }, at);
    host.history.undo();
    assert.equal(layer[collection].length, 0);
    host.history.redo();
    assert.deepEqual({ x: layer[collection][0].x, y: layer[collection][0].y }, at);
  });

  test(`${kind} hover preview uses the same asset-grid cell and footprint`, () => {
    const state = fixture(kind);
    pointer('move', 0);
    const { rectangles, images } = overlay(state);
    assert.deepEqual(rectangles.at(-1), rect);
    assert.deepEqual(images.at(-1).slice(-4), rect);
    assert.equal(host.history.canUndo(), false);
  });
}

test('terrain missing-slot hover preview still has finite snapped bounds', () => {
  const state = fixture('terrain');
  state.tiles.terrainSets[0].slots = {};
  pointer('move', 0);
  const { rectangles, images } = overlay(state);
  assert.deepEqual(rectangles.at(-1), [16, -24, 8, 12]);
  assert.equal(images.length, 0);
});
