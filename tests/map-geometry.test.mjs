import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapXY, findSheet, snap, terrainAt, terrainResolution,
  selectedTile, selectedTerrain, selectedSprite, itemSize,
  hitSprite, hitMapItem, brushSpacing, strokeSamples, claimStrokeCell, MAP_ORIGIN,
} from '../js/modes/maps/application/map-geometry.js';

test('mapXY offsets an event point by MAP_ORIGIN', () => {
  assert.deepEqual(mapXY({ x: MAP_ORIGIN + 5, y: MAP_ORIGIN - 3 }), { x: 5, y: -3 });
});

test('findSheet looks up a sheet by id within a project', () => {
  const project = { sheets: [{ id: 's1' }, { id: 's2' }] };
  assert.equal(findSheet(project, 's2'), project.sheets[1]);
  assert.equal(findSheet(project, 'missing'), null);
});

test('snap respects map-grid mode', () => {
  const map = { snap: { mode: 'map', gridW: 16, gridH: 16 } };
  assert.deepEqual(snap(map, { x: 20, y: 33 }, { w: 8, h: 8 }), { x: 16, y: 32 });
});

test('snap respects asset-grid mode using the brush size', () => {
  const map = { snap: { mode: 'asset', gridW: 16, gridH: 16 } };
  assert.deepEqual(snap(map, { x: 20, y: 33 }, { w: 8, h: 8 }), { x: 16, y: 32 });
});

test('snap normalizes terrain tile dimensions for asset-grid cells, including negative positions', () => {
  const map = { snap: { mode: 'asset', gridW: 16, gridH: 16 } };
  const terrain = { tileW: 8, tileH: 12 };
  assert.deepEqual(snap(map, { x: 23, y: -13 }, terrain), { x: 16, y: -24 });
});

test('snap passes through unchanged when off', () => {
  const map = { snap: { mode: 'off', gridW: 16, gridH: 16 } };
  assert.deepEqual(snap(map, { x: 20, y: 33 }, { w: 8, h: 8 }), { x: 20, y: 33 });
});

test('terrainAt finds a matching terrain entry', () => {
  const entry = { sheetId: 's1', terrainSetId: 't1', x: 16, y: 32 };
  const layer = { terrain: [entry] };
  assert.equal(terrainAt(layer, { id: 's1' }, { id: 't1' }, 16, 32), entry);
  assert.equal(terrainAt(layer, { id: 's1' }, { id: 't1' }, 0, 0), undefined);
});

test('selectedTile resolves the brush sheet/tile from asset ids', () => {
  const tile = { id: 'ti1' };
  const project = { sheets: [{ id: 's1', tiles: [tile] }] };
  const asset = { tileSheetId: 's1', tileId: 'ti1' };
  assert.deepEqual(selectedTile(project, asset), { sheet: project.sheets[0], tile });
});

test('selectedSprite resolves an animation brush using its first frame size', () => {
  const frame = { id: 'f1', w: 16, h: 24 };
  const anim = { id: 'a1', frames: [{ frameId: 'f1' }] };
  const project = { sheets: [{ id: 's1', frames: [frame], animations: [anim] }] };
  const asset = { spriteSheetId: 's1', spriteKind: 'animation', spriteId: 'a1' };
  assert.deepEqual(selectedSprite(project, asset), { sheet: project.sheets[0], item: anim, size: { w: 16, h: 24 } });
});

test('itemSize resolves tile, terrain, and first-frame sprite sizes', () => {
  const project = {
    sheets: [{
      id: 's1',
      tiles: [{ id: 'ti1', w: 16, h: 16 }],
      terrainSets: [{ id: 'te1', tileW: 32, tileH: 32 }],
      frames: [{ id: 'f1', w: 8, h: 12 }],
      animations: [{ id: 'a1', frames: [{ frameId: 'f1' }] }],
    }],
  };
  assert.deepEqual(itemSize(project, { sheetId: 's1', tileId: 'ti1' }), { w: 16, h: 16 });
  assert.deepEqual(itemSize(project, { sheetId: 's1', terrainSetId: 'te1' }), { w: 32, h: 32 });
  assert.deepEqual(itemSize(project, { sheetId: 's1', kind: 'animation', assetId: 'a1' }), { w: 8, h: 12 });
});

test('hitMapItem finds tiles, terrain, and sprites by point, topmost first', () => {
  const project = { sheets: [{ id: 's1', tiles: [{ id: 'ti1', w: 16, h: 16 }] }] };
  const under = { id: 'i1', sheetId: 's1', tileId: 'ti1', x: 0, y: 0 };
  const over = { id: 'i2', sheetId: 's1', tileId: 'ti1', x: 0, y: 0 };
  const layer = { type: 'tile', tiles: [under, over], terrain: [] };
  assert.equal(hitMapItem(project, layer, { x: 4, y: 4 }), over);
  assert.equal(hitMapItem(project, layer, { x: 100, y: 100 }), null);
});

test('hitSprite hit-tests using first-frame size', () => {
  const project = { sheets: [{ id: 's1', frames: [{ id: 'f1', w: 20, h: 10 }] }] };
  const entry = { id: 'sp1', sheetId: 's1', kind: 'frame', assetId: 'f1', x: 0, y: 0 };
  const layer = { type: 'sprite', sprites: [entry] };
  assert.equal(hitSprite(project, layer, { x: 5, y: 5 }), entry);
  assert.equal(hitSprite(project, layer, { x: 25, y: 5 }), null);
});

test('brushSpacing uses map grid unless asset-snap picks the brush footprint', () => {
  const project = { sheets: [{ id: 's1', tiles: [{ id: 'ti1', w: 8, h: 8 }] }] };
  const asset = { tileKind: 'tile', tileSheetId: 's1', tileId: 'ti1' };
  const gridMap = { snap: { mode: 'map', gridW: 16, gridH: 16 } };
  assert.deepEqual(brushSpacing(gridMap, 'maptile', asset, project), { w: 16, h: 16 });
  const assetMap = { snap: { mode: 'asset', gridW: 16, gridH: 16 } };
  assert.deepEqual(brushSpacing(assetMap, 'maptile', asset, project), { w: 8, h: 8 });
  const offMap = { snap: { mode: 'off', gridW: 16, gridH: 16 } };
  assert.equal(brushSpacing(offMap, 'maptile', asset, project), null);
});

test('strokeSamples interpolates evenly spaced points between two drag positions', () => {
  const samples = strokeSamples({}, { x: 0, y: 0 }, { x: 20, y: 0 }, { w: 10, h: 10 });
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[1], { x: 20, y: 0 });
});

test('claimStrokeCell only allows a stroke to touch a cell once', () => {
  const stroke = { visited: new Set() };
  assert.equal(claimStrokeCell(stroke, 'a'), true);
  assert.equal(claimStrokeCell(stroke, 'a'), false);
  assert.equal(claimStrokeCell(null, 'a'), false);
});
