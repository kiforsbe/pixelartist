import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import { createTerrainSet, assignSlot } from '../js/core/terrainsets.js';
import { blobIndexToMask, NEIGHBOR_BITS } from '../js/core/blob47.js';
import { buildTiledTsx } from '../js/app/tiledExport.js';

function addTile(sheet, x, y, w, h) {
  const tile = { id: `t${sheet.tiles.length}`, x, y, w, h };
  sheet.tiles.push(tile);
  return tile;
}

test('buildTiledTsx: only tile sheets are meaningful; wangid encodes N,NE,E,SE,S,SW,W,NW presence', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 32, height: 16, kind: 'tile' });
  const tIsolated = addTile(sheet, 0, 0, 16, 16);
  const tFull = addTile(sheet, 16, 0, 16, 16);
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });

  // blobIndex 0 is always the fully-isolated (no neighbors) configuration.
  assignSlot(sheet, ts, 0, tIsolated);
  // find the blobIndex whose canonical mask is "all 8 bits set" (fully surrounded)
  const fullMask = Object.values(NEIGHBOR_BITS).reduce((a, b) => a | b, 0);
  const fullIndex = blobIndexToMask.indexOf(fullMask);
  assignSlot(sheet, ts, fullIndex, tFull);

  const xml = buildTiledTsx(sheet);
  assert.match(xml, /<tileset[^>]*name="Ground"/);
  assert.match(xml, /<image source="Ground\.png" width="32" height="16"\/>/);
  assert.match(xml, /<wangset name="Grass"/);
  assert.match(xml, /<wangtile tileid="0" wangid="0,0,0,0,0,0,0,0"\/>/);
  assert.match(xml, /<wangtile tileid="1" wangid="1,1,1,1,1,1,1,1"\/>/);
});

test('buildTiledTsx: unassigned/unresolvable blob slots produce no wangtile', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Empty', width: 16, height: 16, kind: 'tile' });
  createTerrainSet(sheet, { name: 'Water', tileW: 16, tileH: 16 });
  const xml = buildTiledTsx(sheet);
  assert.match(xml, /<wangset name="Water"[^>]*><wangcolor[^/]*\/><\/wangset>/);
});
