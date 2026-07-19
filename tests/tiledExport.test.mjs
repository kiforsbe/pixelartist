import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet } from '../js/core/model.js';
import { createTerrainSet, assignSlot } from '../js/core/terrainsets.js';
import { blobIndexToMask, maskToBlobIndex, NEIGHBOR_BITS } from '../js/core/blob47.js';
import { BLOB47_7X7_RAW } from '../js/core/blob47templates.js';
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

test('buildTiledTsx: one space per nesting level, matching Tiled\'s own .tsx indentation exactly', () => {
  // Structure pinned against a real Tiled 1.10.2 export of this project's
  // own blob47-7x7-reference.png (user-provided ground truth): 0 spaces
  // for <?xml?>/<tileset>/</tileset>, 1 for <image>/<wangsets>, 2 for
  // <wangset>, 3 for <wangcolor>/<wangtile>.
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 16, height: 16, kind: 'tile' });
  const t = addTile(sheet, 0, 0, 16, 16);
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, t);

  const xml = buildTiledTsx(sheet);
  assert.equal(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tileset version="1.10" tiledversion="1.10.2" name="Ground" tilewidth="16" tileheight="16" tilecount="1" columns="1">',
    ' <image source="Ground.png" width="16" height="16"/>',
    ' <wangsets>',
    '  <wangset name="Grass" type="mixed" tile="-1">',
    '   <wangcolor name="Grass" color="#ff0000" tile="-1" probability="1"/>',
    '   <wangtile tileid="0" wangid="0,0,0,0,0,0,0,0"/>',
    '  </wangset>',
    ' </wangsets>',
    '</tileset>',
    '',
  ].join('\n'));
});

test('buildTiledTsx: unassigned/unresolvable blob slots produce no wangtile', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Empty', width: 16, height: 16, kind: 'tile' });
  createTerrainSet(sheet, { name: 'Water', tileW: 16, tileH: 16 });
  const xml = buildTiledTsx(sheet);
  assert.match(xml, /<wangset name="Water"[^>]*>\n\s*<wangcolor[^/]*\/>\n\s*<\/wangset>/);
  assert.doesNotMatch(xml, /<wangtile/);
});

test('buildTiledTsx: tileid comes from raster (x,y) position, not sheet.tiles insertion order', () => {
  // Regression test: js/core/tilegrids.js's resizeGridAxis can append a
  // newly-grown cell to the END of sheet.tiles even though it lands at the
  // START of the visual grid (e.g. growing a grid leftward/upward), and
  // multiple tileGrids/standalone tiles can coexist in arbitrary creation
  // order. tileid must reflect where the tile actually sits on the image
  // (row*columns+col), never its array index.
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Ground', width: 32, height: 16, kind: 'tile' });
  // Inserted in reverse of raster order: the col-1 tile is pushed first.
  const tCol1 = { id: 'tCol1', x: 16, y: 0, w: 16, h: 16 };
  const tCol0 = { id: 'tCol0', x: 0, y: 0, w: 16, h: 16 };
  sheet.tiles.push(tCol1, tCol0);
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 16, tileH: 16 });
  assignSlot(sheet, ts, 0, tCol0); // isolated -> should be raster tileid 0
  const fullMask = Object.values(NEIGHBOR_BITS).reduce((a, b) => a | b, 0);
  assignSlot(sheet, ts, blobIndexToMask.indexOf(fullMask), tCol1); // fully surrounded -> raster tileid 1

  const xml = buildTiledTsx(sheet);
  assert.match(xml, /<wangtile tileid="0" wangid="0,0,0,0,0,0,0,0"\/>/);
  assert.match(xml, /<wangtile tileid="1" wangid="1,1,1,1,1,1,1,1"\/>/);
});

test('buildTiledTsx: every wangid for the real Blob-47 7x7 reference sheet matches the ground-truth Tiled file', () => {
  // BLOB47_7X7_RAW is pixel-verified (tests/blob47templates.test.mjs)
  // against assets/blob47-templates/blob47-7x7-reference.png -- the exact
  // image a real, hand-authored Tiled .tsx for this sheet was diffed
  // against to derive this table. tileid 0/6/42 are the isolated
  // configuration's two duplicate positions plus its primary -- Tiled only
  // gets one wangtile per distinct wangid, so this test skips the two
  // non-primary duplicates the same way the reference file's author did.
  const REFERENCE_WANGID_BY_TILEID = {
    1: '0,0,1,0,0,0,0,0', 2: '0,0,1,1,1,0,1,0', 3: '0,0,1,1,1,1,1,0', 4: '0,0,1,0,1,1,1,0', 5: '0,0,0,0,1,0,1,0',
    7: '0,0,0,0,1,0,0,0', 8: '0,0,1,0,1,0,0,0', 9: '1,1,1,0,1,0,1,0', 10: '1,1,1,1,1,0,1,1', 11: '1,0,0,0,1,1,1,1',
    12: '1,0,1,0,1,0,0,0', 13: '0,0,0,0,0,0,1,0', 14: '1,0,1,1,1,0,0,0', 15: '1,0,1,0,1,1,1,0', 16: '1,0,1,0,1,0,1,0',
    17: '1,1,1,0,0,0,1,0', 18: '1,0,1,1,1,0,1,1', 19: '1,0,1,1,1,1,1,0', 20: '0,0,0,0,1,1,1,0', 21: '1,1,1,1,1,0,0,0',
    22: '1,0,1,1,1,1,1,1', 23: '1,0,0,0,1,1,1,0', 24: '0,0,1,1,1,0,0,0', 25: '1,1,1,1,1,1,1,0', 26: '1,1,1,0,1,1,1,1',
    27: '1,0,0,0,1,0,1,1', 28: '1,1,1,0,1,0,0,0', 29: '1,1,1,0,0,0,1,1', 30: '1,0,1,0,1,0,1,1', 31: '1,1,1,1,1,0,1,0',
    32: '1,1,1,1,1,1,1,1', 33: '1,0,1,0,1,1,1,1', 34: '1,0,0,0,1,0,1,0', 35: '1,0,1,0,0,0,0,0', 36: '0,0,1,0,1,0,1,0',
    37: '1,0,1,1,1,0,1,0', 38: '1,1,1,0,1,1,1,0', 39: '1,1,1,0,1,0,1,1', 40: '1,0,0,0,0,0,1,1', 41: '1,0,0,0,1,0,0,0',
    43: '1,0,0,0,0,0,0,0', 44: '1,1,1,0,0,0,0,0', 45: '1,0,1,0,0,0,1,1', 46: '1,0,1,0,0,0,1,0', 47: '0,0,1,0,0,0,1,0',
    48: '1,0,0,0,0,0,1,0',
  };

  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'blob47', width: 224, height: 224, kind: 'tile' });
  sheet.tiles = [];
  const tileByBlobIndex = new Map();
  // Insert in a deliberately non-raster order (reversed rows) to prove
  // tileid is derived from position, not insertion order.
  for (let row = 6; row >= 0; row--) {
    for (let col = 0; col < 7; col++) {
      const raw = BLOB47_7X7_RAW[row][col];
      const blobIndex = maskToBlobIndex[raw];
      const tile = { id: `t_${row}_${col}`, x: col * 32, y: row * 32, w: 32, h: 32 };
      sheet.tiles.push(tile);
      if (!tileByBlobIndex.has(blobIndex)) tileByBlobIndex.set(blobIndex, tile); // first wins, mirrors groupCellsByBlobIndex
    }
  }
  const ts = createTerrainSet(sheet, { name: 'Grass', tileW: 32, tileH: 32 });
  for (const [blobIndex, tile] of tileByBlobIndex) assignSlot(sheet, ts, blobIndex, tile);

  const xml = buildTiledTsx(sheet);
  for (const [tileid, wangid] of Object.entries(REFERENCE_WANGID_BY_TILEID)) {
    assert.match(xml, new RegExp(`<wangtile tileid="${tileid}" wangid="${wangid}"/>`),
      `tileid ${tileid} should have wangid ${wangid}`);
  }
});
