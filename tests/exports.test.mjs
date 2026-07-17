import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { createTileGrid } from '../js/core/tilegrids.js';
import { setSlot } from '../js/core/neighbors.js';
import { createTerrainSet, assignSlot } from '../js/core/terrainsets.js';
import { buildFramesJson, buildTilesJson } from '../js/app/exports.js';

test('buildFramesJson: shape, indices, and animation frames-by-name', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Hero', width: 64, height: 64, kind: 'sprite' });
  const f0 = addFrame(sheet, { name: 'idle_0', x: 0, y: 0, w: 16, h: 16, pivotX: 8, pivotY: 16 });
  const f1 = addFrame(sheet, { name: 'idle_1', x: 16, y: 0, w: 16, h: 16 });
  const anim = addAnimation(sheet, 'idle');
  anim.loop = true;
  anim.frames.push({ frameId: f0.id, duration: 100 });
  anim.frames.push({ frameId: f1.id, duration: 120 });

  const json = buildFramesJson(sheet);
  assert.equal(json.sheet, 'Hero.png');
  assert.equal(json.width, 64);
  assert.equal(json.height, 64);
  assert.deepEqual(json.frames, [
    { name: 'idle_0', index: 0, x: 0, y: 0, w: 16, h: 16, pivotX: 8, pivotY: 16 },
    { name: 'idle_1', index: 1, x: 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 },
  ]);
  assert.deepEqual(json.animations, [
    {
      name: 'idle', loop: true,
      frames: [
        { frame: 'idle_0', duration: 100 },
        { frame: 'idle_1', duration: 120 },
      ],
    },
  ]);
});

test('buildFramesJson: no frames/animations yields empty arrays', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Empty', width: 32, height: 32, kind: 'sprite' });
  const json = buildFramesJson(sheet);
  assert.deepEqual(json.frames, []);
  assert.deepEqual(json.animations, []);
});

test('buildTilesJson: only named/preset tiles listed, full 8-dir neighbors, resolved tileIndex', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 32, height: 16, kind: 'tile' });
  const { tiles } = createTileGrid(sheet, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  const [t0, t1] = tiles;
  t0.name = 'grass';
  setSlot(t1, 'e', { mode: 'tile', tileId: t0.id, flipH: true, flipV: false });

  const json = buildTilesJson(sheet);
  assert.equal(json.sheet, 'Ground.png');
  assert.equal(json.count, 2);
  assert.equal(json.tiles.length, 2); // both named-or-preset; none unlisted

  const named = json.tiles.find(t => t.index === 0);
  assert.equal(named.name, 'grass');
  assert.deepEqual({ x: named.x, y: named.y, w: named.w, h: named.h }, { x: 0, y: 0, w: 16, h: 16 });
  assert.deepEqual(Object.keys(named.neighbors).sort(), ['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']);
  for (const dir of Object.keys(named.neighbors))
    assert.deepEqual(named.neighbors[dir], { mode: 'same', tileIndex: null, flipH: false, flipV: false });

  const presetOnly = json.tiles.find(t => t.index === 1);
  assert.equal(presetOnly.name, null);
  assert.deepEqual(presetOnly.neighbors.e, { mode: 'tile', tileIndex: 0, flipH: true, flipV: false });
  assert.deepEqual(presetOnly.neighbors.n, { mode: 'same', tileIndex: null, flipH: false, flipV: false });
});

test('buildTilesJson: unnamed, unset tiles are excluded entirely', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Blank', width: 32, height: 16, kind: 'tile' });
  createTileGrid(sheet, { x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1 });
  const json = buildTilesJson(sheet);
  assert.equal(json.count, 2);
  assert.deepEqual(json.tiles, []);
});

test('buildTilesJson: terrainSets export resolved {tileIndex,flipH,flipV,rotate} slots, omitted entirely when empty', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: undefined, gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined });
  let json = buildTilesJson(sheet);
  assert.equal(json.terrainSets, undefined);
  assert.equal(json.layers, undefined);

  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, sheet.tiles[0]); // blobIndex 0 = isolated/no-neighbors
  json = buildTilesJson(sheet);
  assert.equal(json.terrainSets.length, 1);
  assert.equal(json.terrainSets[0].name, 'Grass');
  assert.deepEqual(json.terrainSets[0].slots['0'], { tileIndex: 0, flipH: false, flipV: false, rotate: 0 });
});

test('buildTilesJson: layers export as an ordered array, per-tile layer/tags included, omitted when unset', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.layers.push('Ground', 'Props');
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: 'Ground', tags: ['nature'] });
  const json = buildTilesJson(sheet);
  assert.deepEqual(json.layers, ['Ground', 'Props']);
  assert.equal(json.tiles[0].layer, 'Ground');
  assert.deepEqual(json.tiles[0].tags, ['nature']);
});

test('buildTilesJson: a terrain-set tile omits the manual neighbors block', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, neighbors: { n: { mode: 'same', tileId: null, flipH: false, flipV: false } }, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined });
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, sheet.tiles[0]);
  const json = buildTilesJson(sheet);
  assert.equal(json.tiles[0].neighbors, undefined);
});

test('buildTilesJson: terrain set layer is included when set, omitted when null', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.tiles.push({ id: 't0', x: 0, y: 0, w: 16, h: 16, name: undefined, gridId: null, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined });
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, sheet.tiles[0]);

  let json = buildTilesJson(sheet);
  assert.equal(json.terrainSets[0].layer, undefined);

  ts.layer = 'Ground';
  json = buildTilesJson(sheet);
  assert.equal(json.terrainSets[0].layer, 'Ground');
});
