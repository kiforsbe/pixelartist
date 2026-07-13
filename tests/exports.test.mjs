import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { setSlot } from '../js/core/neighbors.js';
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

test('buildTilesJson: only named/preset tiles listed, full 8-dir neighbors', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 32, height: 16, kind: 'tile' });
  sheet.tile.tileWidth = 16;
  sheet.tile.tileHeight = 16;
  // 2 columns x 1 row = 2 tiles, indices 0 and 1.
  sheet.tile.names[0] = 'grass';
  setSlot(sheet, 1, 'e', { mode: 'tile', tileIndex: 0, flipH: true, flipV: false });

  const json = buildTilesJson(sheet);
  assert.equal(json.sheet, 'Ground.png');
  assert.equal(json.tileWidth, 16);
  assert.equal(json.tileHeight, 16);
  assert.equal(json.columns, 2);
  assert.equal(json.count, 2);
  assert.equal(json.tiles.length, 2); // both named-or-preset; none unlisted

  const named = json.tiles.find(t => t.index === 0);
  assert.equal(named.name, 'grass');
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
  sheet.tile.tileWidth = 16;
  sheet.tile.tileHeight = 16;
  const json = buildTilesJson(sheet);
  assert.equal(json.count, 2);
  assert.deepEqual(json.tiles, []);
});
