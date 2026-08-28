import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { createProject, createSheet, createMap, createMapLayer } from '../js/core/model.js';
import { hitMapItem, MAP_ORIGIN } from '../js/modes/maps/application/map-geometry.js';
import { deleteMapItem } from '../js/modes/maps/application/commands/map-paint-commands.js';
import { clearMapRasterCache, paintMap } from '../js/modes/maps/presentation/map-renderer.js';

const host = new EditorHost();
setEditorHost(host);
const documentBefore = globalThis.document, imageDataBefore = globalThis.ImageData;

before(() => {
  // Only the browser canvas boundary is replaced. Capture drawImage output
  // from the real renderer, raster cache, sheet flattening, and terrain solver.
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      return { getContext: () => ({ putImageData() {} }) };
    },
  };
  globalThis.ImageData = class {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  };
});

after(() => {
  globalThis.document = documentBefore;
  globalThis.ImageData = imageDataBefore;
  host.dispose();
});

function fixture() {
  const project = createProject('Map order');
  const sheet = createSheet(project, { name: 'Assets', kind: 'tile', width: 96, height: 16 });
  sheet.tiles.push(
    { id: 'tile1', x: 0, y: 0, w: 16, h: 16 },
    { id: 'tile2', x: 16, y: 0, w: 16, h: 16 },
    { id: 'terrainTile1', x: 32, y: 0, w: 16, h: 16 },
    { id: 'terrainTile2', x: 48, y: 0, w: 16, h: 16 },
  );
  sheet.terrainSets.push(
    { id: 'terrain1', tileW: 16, tileH: 16, slots: { 0: 'terrainTile1' }, symmetry: { flip: false, rotate: false } },
    { id: 'terrain2', tileW: 16, tileH: 16, slots: { 0: 'terrainTile2' }, symmetry: { flip: false, rotate: false } },
  );
  sheet.frames.push({ id: 'frame1', x: 64, y: 0, w: 16, h: 16 }, { id: 'frame2', x: 80, y: 0, w: 16, h: 16 });
  sheet.animations.push({ id: 'animation1', frames: [{ frameId: 'frame2' }] });
  const map = createMap(project), tileLayer = map.layers[0];
  const spriteLayer = createMapLayer(map, { type: 'sprite' });
  const tileBack = { id: 'tileBack', sheetId: sheet.id, tileId: 'tile1', x: 0, y: 0 };
  const tileFront = { id: 'tileFront', sheetId: sheet.id, tileId: 'tile2', x: 4, y: 0 };
  const terrainBack = { id: 'terrainBack', sheetId: sheet.id, terrainSetId: 'terrain1', x: 0, y: 0 };
  const terrainFront = { id: 'terrainFront', sheetId: sheet.id, terrainSetId: 'terrain2', x: 4, y: 0 };
  const spriteBack = { id: 'spriteBack', sheetId: sheet.id, kind: 'frame', assetId: 'frame1', x: 0, y: 0 };
  const spriteFront = { id: 'spriteFront', sheetId: sheet.id, kind: 'animation', assetId: 'animation1', x: 4, y: 0 };
  tileLayer.tiles.push(tileBack, tileFront);
  tileLayer.terrain.push(terrainBack, terrainFront);
  spriteLayer.sprites.push(spriteBack, spriteFront);
  host.setProject(project);
  host.history.clear();
  clearMapRasterCache();
  return { project, map, tileLayer, spriteLayer, tileBack, tileFront, terrainBack, terrainFront, spriteBack, spriteFront };
}

function renderSources(project, map) {
  const sources = [];
  const ctx = {
    globalAlpha: 1, save() {}, restore() {}, fillRect() {},
    drawImage(canvas, sx, sy, sw, sh, dx, dy, dw, dh) {
      // Every placement overlaps this map point; the last call covers it.
      assert.ok(dx <= MAP_ORIGIN + 8 && dx + dw > MAP_ORIGIN + 8);
      assert.ok(dy <= MAP_ORIGIN + 1 && dy + dh > MAP_ORIGIN + 1);
      sources.push(sx);
    },
  };
  paintMap(ctx, project, map);
  return sources;
}

test('hit testing follows the reverse of actual overlapping tile, terrain, and sprite draw order', () => {
  const { project, map, tileLayer, spriteLayer, terrainFront, spriteFront } = fixture();
  assert.deepEqual(renderSources(project, map), [0, 16, 32, 48, 64, 80]);
  assert.equal(hitMapItem(project, tileLayer, { x: 8, y: 1 }), terrainFront);
  assert.equal(hitMapItem(project, spriteLayer, { x: 8, y: 1 }), spriteFront);
});

for (const [kind, expectedAfterDelete] of [
  ['tile', [16, 32, 48, 64, 80]],
  ['terrain', [0, 16, 48, 64, 80]],
  ['sprite', [0, 16, 32, 48, 80]],
]) {
  test(`undoing an exposed ${kind} deletion restores the actual overlapping draw sequence`, () => {
    const state = fixture(), { project, map } = state;
    const layer = kind === 'sprite' ? state.spriteLayer : state.tileLayer;
    const item = state[`${kind}Back`];
    deleteMapItem(host.services, map.id, layer.id, item.id);
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.deepEqual(renderSources(project, map), expectedAfterDelete);
      host.history.undo();
      assert.deepEqual(renderSources(project, map), [0, 16, 32, 48, 64, 80]);
      host.history.redo();
    }
  });
}
