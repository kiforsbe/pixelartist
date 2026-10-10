import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, defaultOnionSettings, createProject, newDefaultProject, createSheet, createMap, createMapLayer, mapContentBounds, refreshMapBounds, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, flattenSheet, flattenSheetLayers,
  serializeProject, deserializeProject, validateProjectJson, GROUP, LAYER,
  sheetLayers, findGroup, addGroup, flattenLayers, moveNode,
  scrubTileReferences, removeSheet, activePaletteColors, resolvePixelSnapperPalette,
  effectiveDuration, fpsStepToMs, msToFps,
} from '../js/core/model.js';
import { createPalette, setEntry, addSwatch, setEmptyColor } from '../js/core/palettes.js';
import { setPixel, getPixel, createBitmap } from '../js/core/pixels.js';
import { normalizeBrush } from '../js/core/brushes.js';

function proj() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 'sheet1', width: 32, height: 16, kind: 'sprite' });
  return { p, s };
}

test('newDefaultProject creates the initial sprite and tile sheets from settings', () => {
  const settings = { ...DEFAULT_SETTINGS, spriteSheetW: 24, spriteSheetH: 12, tileSheetW: 40, tileSheetH: 20 };
  const p = newDefaultProject(settings);
  assert.equal(p.name, 'untitled');
  assert.deepEqual(p.sheets.map(({ name, width, height, kind }) => ({ name, width, height, kind })), [
    { name: 'Sprites', width: 24, height: 12, kind: 'sprite' },
    { name: 'Tiles', width: 40, height: 20, kind: 'tile' },
  ]);
});

test('removeSheet splices the matching sheet out of project.sheets and returns it', () => {
  const p = createProject('t');
  const s1 = createSheet(p, { name: 'a', width: 8, height: 8, kind: 'sprite' });
  const s2 = createSheet(p, { name: 'b', width: 8, height: 8, kind: 'tile' });
  const removed = removeSheet(p, s1.id);
  assert.equal(removed, s1);
  assert.deepEqual(p.sheets, [s2]);
});

test('maps serialize, migrate, and preserve typed layer content', () => {
  const p = createProject('map');
  const map = createMap(p, { name: 'Test', gridW: 8, gridH: 12 });
  map.layers[0].tiles.push({ id: 'a', sheetId: 's', tileId: 't', x: -8, y: 12 });
  const { json, images } = serializeProject(p);
  assert.equal(json.version, PROJECT_VERSION);
  assert.deepEqual(json.maps[0].snap, { mode: 'map', gridW: 8, gridH: 12 });
  assert.equal(deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap]))).maps[0].layers[0].tiles[0].x, -8);
  const v2 = { version: 2, name: 'old', settings: { ...DEFAULT_SETTINGS }, sheets: [] };
  assert.deepEqual(deserializeProject(v2, new Map()).maps, []);
});

test('map bounds are the grid-aligned union of contents across every typed layer and shrink after removal', () => {
  const p = createProject('map bounds');
  const tiles = createSheet(p, { name:'tiles', width:32, height:16, kind:'tile' });
  tiles.tiles.push({ id:'tile', x:0, y:0, w:8, h:6 });
  tiles.terrainSets.push({ id:'terrain', tileW:16, tileH:10, slots:[], symmetry:{ flip:false, rotate:false } });
  const sprites = createSheet(p, { name:'sprites', width:16, height:16, kind:'sprite' });
  const frame = addFrame(sprites, { name:'frame', x:0, y:0, w:7, h:9 });
  const map = createMap(p);
  map.layers[0].tiles.push({ id:'tile-item', sheetId:tiles.id, tileId:'tile', x:10, y:20 });
  map.layers[0].terrain.push({ id:'terrain-item', sheetId:tiles.id, terrainSetId:'terrain', x:-16, y:-8 });
  const spriteLayer = createMapLayer(map, { type:'sprite' });
  spriteLayer.visible = false; spriteLayer.locked = true;
  spriteLayer.sprites.push({ id:'sprite-item', sheetId:sprites.id, kind:'frame', assetId:frame.id, x:40, y:-20 });

  assert.deepEqual(mapContentBounds(p, map), { x:-16, y:-32, w:64, h:64 });
  map.bounds = { x:0, y:0, w:999, h:999 };
  assert.deepEqual(refreshMapBounds(p, map), { x:-16, y:-32, w:64, h:64 });

  spriteLayer.sprites.length = 0;
  assert.deepEqual(refreshMapBounds(p, map), { x:-16, y:-16, w:48, h:48 });
  map.layers[0].tiles.length = 0; map.layers[0].terrain.length = 0;
  assert.deepEqual(refreshMapBounds(p, map), { x:0, y:0, w:320, h:240 });
});

test('project serialization derives current map bounds instead of preserving stale bounds', () => {
  const p = createProject('map bounds');
  const tiles = createSheet(p, { name:'tiles', width:16, height:16, kind:'tile' });
  tiles.tiles.push({ id:'tile', x:0, y:0, w:8, h:6 });
  const map = createMap(p); map.bounds = { x:0, y:0, w:999, h:999 };
  map.layers[0].tiles.push({ id:'item', sheetId:tiles.id, tileId:'tile', x:-5, y:7 });
  assert.deepEqual(serializeProject(p).json.maps[0].bounds, { x:-16, y:0, w:32, h:16 });
});

test('removeSheet returns null and leaves sheets untouched for an unknown id', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'a', width: 8, height: 8, kind: 'sprite' });
  assert.equal(removeSheet(p, 'nope'), null);
  assert.deepEqual(p.sheets, [s]);
});

test('createSheet defaults: one layer, bounds enforced', () => {
  const { p, s } = proj();
  assert.equal(sheetLayers(s).length, 1);
  assert.equal(sheetLayers(s)[0].bitmap.width, 32);
  assert.throws(() => createSheet(p, { name: 'x', width: 0, height: 5, kind: 'sprite' }));
  assert.throws(() => createSheet(p, { name: 'x', width: 5000, height: 5, kind: 'sprite' }));
});

test('layer ops: add, move, mergeDown composites with opacity', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  top.opacity = 0.5;
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [0, 0, 0, 255]);
  setPixel(top.bitmap, 0, 0, [255, 255, 255, 255]);
  mergeDown(s, top.id);
  assert.equal(sheetLayers(s).length, 1);
  const px = getPixel(sheetLayers(s)[0].bitmap, 0, 0);
  assert.ok(px[0] > 100 && px[0] < 155, `blended, got ${px}`);
  assert.throws(() => mergeDown(s, sheetLayers(s)[0].id)); // bottom layer
  const l2 = addLayer(s, 'b'); moveLayer(s, l2.id, 0);
  assert.equal(sheetLayers(s)[0].id, l2.id);
  removeLayer(s, l2.id);
  assert.equal(sheetLayers(s).length, 1);
});

test('moveNode reorders layers and moves between groups', () => {
  const { s } = proj();
  const l1 = sheetLayers(s)[0];
  const l2 = addLayer(s, 'b');
  const g = addGroup(s, 'g');
  const l3 = addLayer(s, 'c');
  // root children: [l1, l2, g, l3] (created in order)
  // move l3 into g
  moveNode(s, l3.id, g.id, 0);
  assert.deepEqual(g.children.map(c => c.id), [l3.id]);
  // move l2 before l1
  moveNode(s, l2.id, s.layerTree.id, 0);
  assert.deepEqual(s.layerTree.children.map(c => c.id), [l2.id, l1.id, g.id]);
  // move l1 into g after l3
  moveNode(s, l1.id, g.id, 1);
  assert.deepEqual(g.children.map(c => c.id), [l3.id, l1.id]);
});

test('moveNode prevents invalid moves', () => {
  const { s } = proj();
  const g1 = addGroup(s, 'g1');
  const g2 = addGroup(s, 'g2');
  addLayer(s, 'inside', g1.id);
  // cannot move g1 into g2 because g1 contains a layer (g1 into itself/descendant would be next)
  moveNode(s, g1.id, g1.id, 0);
  assert.equal(findGroup(s.layerTree, g1.id).children.length, 1);
  // cannot move g1 into its own descendant
  moveNode(s, g1.id, g1.id, 0);
  assert.ok(s.layerTree.children.some(c => c.id === g1.id));
});

test('frames and animations; removeFrame cleans references', () => {
  const { s } = proj();
  const f1 = addFrame(s, { name: 'walk0', x: 0, y: 0, w: 16, h: 16 });
  const f2 = addFrame(s, { name: 'walk1', x: 16, y: 0, w: 16, h: 16 });
  const a = addAnimation(s, 'walk');
  a.frames.push({ frameId: f1.id, duration: 100 }, { frameId: f2.id, duration: 150 });
  removeFrame(s, f1.id);
  assert.equal(s.frames.length, 1);
  assert.deepEqual(a.frames.map(x => x.frameId), [f2.id]);
});

test('addAnimation creates a manual animation with no frames and no legacy fields', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'walk');
  assert.deepEqual([a.name, a.frames, a.layout, a.cell], ['walk', [], 'manual', null]);
  assert.equal(['strip', 'breaks', 'layerGroupId'].some(k => k in a), false);
});

test('flattenSheet composites visible layers only', () => {
  const { s } = proj();
  const top = addLayer(s, 'top');
  setPixel(sheetLayers(s)[0].bitmap, 1, 1, [255, 0, 0, 255]);
  setPixel(top.bitmap, 1, 1, [0, 255, 0, 255]);
  top.visible = false;
  assert.deepEqual(getPixel(flattenSheet(s), 1, 1), [255, 0, 0, 255]);
  top.visible = true;
  assert.deepEqual(getPixel(flattenSheet(s), 1, 1), [0, 255, 0, 255]);
});

test('createSheet tile kind starts with empty grids/tiles', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'x', width: 64, height: 64, kind: 'tile' });
  assert.deepEqual(s.tileGrids, []);
  assert.deepEqual(s.tiles, []);
});

test('createSheet sprite kind has null tileGrids/tiles', () => {
  const { s } = proj();
  assert.equal(s.tileGrids, null);
  assert.equal(s.tiles, null);
});

test('createSheet: tile-kind sheet gets empty terrain metadata, non-tile gets null', () => {
  const p = createProject('t');
  const tileSheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  assert.deepEqual(tileSheet.terrainSets, []);
  assert.deepEqual(tileSheet.terrainLayoutPresets, []);
  assert.deepEqual(tileSheet.tileLayerNames, []);
  const spriteSheet = createSheet(p, { name: 'Sprites', width: 32, height: 32, kind: 'sprite' });
  assert.equal(spriteSheet.terrainSets, null);
  assert.equal(spriteSheet.terrainLayoutPresets, null);
  assert.equal(spriteSheet.tileLayerNames, null);
});

test('serializeProject/deserializeProject keeps the layers wire key for tileLayerNames and preserves per-tile metadata', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.terrainSets.push({ id: 'ts1', name: 'Grass', tileW: 16, tileH: 16, slots: { 0: 'ti1' }, symmetry: { flip: true, rotate: false } });
  sheet.terrainLayoutPresets.push({ id: 'tlp1', name: 'My layout', cols: 4, rows: 4, cells: [{ col: 0, row: 0, blobIndex: 0 }] });
  sheet.tileLayerNames.push('Ground', 'Props');
  sheet.tiles.push({ id: 'ti1', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: 'ts1', blobIndex: 0, layer: 'Ground', tags: ['nature', 'walkable'] });

  const { json, images } = serializeProject(p);
  assert.equal(json.version, 4);
  assert.deepEqual(json.sheets[0].layers, ['Ground', 'Props']);
  assert.equal(Object.hasOwn(json.sheets[0], 'tileLayerNames'), false);
  const imagesByPath = new Map(images.map(i => [i.path, i.bitmap]));
  const reloaded = deserializeProject(json, imagesByPath);
  const rt = reloaded.sheets.find(s => s.name === 'Tiles');

  assert.deepEqual(rt.terrainSets, [{ id: 'ts1', name: 'Grass', tileW: 16, tileH: 16, slots: { 0: 'ti1' }, symmetry: { flip: true, rotate: false } }]);
  assert.deepEqual(rt.terrainLayoutPresets, [{ id: 'tlp1', name: 'My layout', cols: 4, rows: 4, cells: [{ col: 0, row: 0, blobIndex: 0 }] }]);
  assert.deepEqual(rt.tileLayerNames, ['Ground', 'Props']);
  const rtTile = rt.tiles.find(t => t.id === 'ti1');
  assert.equal(rtTile.terrainSetId, 'ts1');
  assert.equal(rtTile.blobIndex, 0);
  assert.equal(rtTile.layer, 'Ground');
  assert.deepEqual(rtTile.tags, ['nature', 'walkable']);

  // Mutating the reload must not alias the original sheet's nested objects.
  rt.terrainSets[0].slots[1] = 'ti2';
  rtTile.tags.push('extra');
  rt.tileLayerNames.push('Above');
  assert.deepEqual(sheet.tileLayerNames, ['Ground', 'Props']);
  assert.deepEqual(sheet.terrainSets[0].slots, { 0: 'ti1' });
  assert.deepEqual(sheet.tiles[0].tags, ['nature', 'walkable']);
});

test('deserializeProject reads existing layers metadata and defaults missing tile/sprite metadata', () => {
  for (const version of [2, 3]) {
    for (const { kind, metadata, want } of [
      { kind: 'tile', metadata: { layers: ['Ground', 'Props'] }, want: ['Ground', 'Props'] },
      { kind: 'tile', metadata: {}, want: [] },
      { kind: 'sprite', metadata: { layers: null }, want: null },
      { kind: 'sprite', metadata: {}, want: null },
    ]) {
      const json = { version, name: 'saved', settings: DEFAULT_SETTINGS, sheets: [{
        id: 's1', name: 'Sheet', width: 8, height: 8, kind, ...metadata,
        layerTree: { id: 'root', type: GROUP, name: 'root', children: [] },
      }] };
      assert.equal(validateProjectJson(json).ok, true);
      const project = deserializeProject(json, new Map());
      assert.deepEqual(project.sheets[0].tileLayerNames, want);
      const saved = serializeProject(project).json;
      assert.deepEqual(saved.sheets[0].layers, want);
      assert.equal(Object.hasOwn(saved.sheets[0], 'tileLayerNames'), false);
    }
  }
});

test('legacy flat pixel layers migrate into the tree without becoming tile metadata', () => {
  for (const version of [2, 3]) {
    for (const kind of ['tile', 'sprite']) {
      const bitmap = createBitmap(8, 8);
      setPixel(bitmap, 1, 2, [10, 20, 30, 255]);
      const json = { version, name: 'legacy', settings: DEFAULT_SETTINGS, sheets: [{
        id: 's1', name: 'Sheet', width: 8, height: 8, kind,
        tiles: kind === 'tile' ? [{ id: 't1', x: 0, y: 0, w: 8, h: 8, name: 'grass' }] : null,
        layers: [{ id: 'ly1', name: 'Ink', visible: true, opacity: 1, image: 'images/s1/ly1.png' }],
      }] };
      assert.equal(validateProjectJson(json).ok, true);
      const project = deserializeProject(json, new Map([['images/s1/ly1.png', bitmap]]));
      const sheet = project.sheets[0];
      assert.deepEqual(sheet.tileLayerNames, kind === 'tile' ? [] : null);
      assert.equal(sheetLayers(sheet)[0].name, 'Ink');
      assert.deepEqual(getPixel(flattenSheet(sheet), 1, 2), [10, 20, 30, 255]);
      if (kind === 'tile') assert.equal(sheet.tiles[0].name, 'grass');
      const saved = serializeProject(project).json.sheets[0];
      assert.deepEqual(saved.layers, kind === 'tile' ? [] : null);
      assert.equal(saved.layerTree.children[0].image, 'images/s1/ly1.png');
      assert.throws(() => deserializeProject(json, new Map()), /missing image/);
      delete json.sheets[0].layers[0].image;
      assert.equal(validateProjectJson(json).ok, false);
    }
  }
});

test('metadata names cannot substitute for pixel layers when the saved sheet has no layer tree', () => {
  const json = { version: 3, name: 'invalid', settings: DEFAULT_SETTINGS, sheets: [{
    id: 's1', name: 'Sheet', width: 8, height: 8, kind: 'tile', layers: ['Ground'],
  }] };
  assert.equal(validateProjectJson(json).ok, false);
  assert.throws(() => deserializeProject(json, new Map()), /missing image path/);
});

test('scrubTileReferences clears dangling neighbors slots and terrain-set slots pointing at a removed tile', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  const a = { id: 'a', x: 0, y: 0, w: 8, h: 8, name: undefined, gridId: null, neighbors: { n: { mode: 'tile', tileId: 'b', flipH: false, flipV: false } } };
  const b = { id: 'b', x: 8, y: 0, w: 8, h: 8, name: undefined, gridId: null, neighbors: undefined };
  sheet.tiles.push(a, b);
  sheet.terrainSets.push({ id: 'ts1', name: 'Grass', tileW: 8, tileH: 8, slots: { 0: 'b', 1: 'a' }, symmetry: { flip: false, rotate: false } });

  scrubTileReferences(sheet, 'b');

  assert.deepEqual(a.neighbors.n, { mode: 'empty', tileId: null, flipH: false, flipV: false });
  assert.deepEqual(sheet.terrainSets[0].slots, { 1: 'a' });
});

test('serialize/deserialize round-trips tileGrids and tiles', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'Tiles', width: 32, height: 16, kind: 'tile' });
  s.tileGrids.push({ id: 'tg1', x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1, spacingX: 0, spacingY: 0 });
  s.tiles.push({ id: 'ti1', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: 'tg1', gridCol: 0, gridRow: 0, neighbors: undefined });
  s.tiles.push({ id: 'ti2', x: 16, y: 0, w: 16, h: 16, name: undefined, gridId: 'tg1', gridCol: 1, gridRow: 0, neighbors: { n: { mode: 'empty', tileId: null, flipH: false, flipV: false } } });
  const { json, images } = serializeProject(p);
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  const s2 = p2.sheets[0];
  assert.deepEqual(s2.tileGrids, s.tileGrids);
  assert.equal(s2.tiles.length, 2);
  assert.equal(s2.tiles[0].name, 'grass');
  assert.deepEqual(s2.tiles[1].neighbors, { n: { mode: 'empty', tileId: null, flipH: false, flipV: false } });
});

test('deserializeProject migrates legacy sheet.tile shape into one grid + tiles', () => {
  const legacy = {
    version: 2, name: 't',
    settings: DEFAULT_SETTINGS,
    activePaletteId: null, palettes: [],
    sheets: [{
      id: 's1', name: 'Ground', width: 32, height: 16, kind: 'tile',
      tile: {
        tileWidth: 16, tileHeight: 16,
        names: { 1: 'grass' },
        neighbors: { 1: { e: { mode: 'tile', tileIndex: 0, flipH: true, flipV: false } } },
      },
      frames: [], animations: [],
      layerTree: { id: 'root', type: GROUP, name: 'root', animationId: null, open: true, children: [
        { id: 'ly1', type: LAYER, name: 'Layer 1', visible: true, opacity: 1, image: 'images/s1/ly1.png' },
      ] },
    }],
  };
  const bitmap = createBitmap(32, 16);
  const p2 = deserializeProject(legacy, new Map([['images/s1/ly1.png', bitmap]]));
  const s2 = p2.sheets[0];
  assert.equal(s2.tileGrids.length, 1);
  assert.deepEqual(s2.tileLayerNames, []);
  assert.deepEqual(s2.tileGrids[0], { id: s2.tileGrids[0].id, x: 0, y: 0, cellW: 16, cellH: 16, cols: 2, rows: 1, spacingX: 0, spacingY: 0 });
  assert.equal(s2.tiles.length, 2);
  const t0 = s2.tiles.find(t => t.gridCol === 0 && t.gridRow === 0);
  const t1 = s2.tiles.find(t => t.gridCol === 1 && t.gridRow === 0);
  assert.equal(t0.name, undefined);
  assert.equal(t1.name, 'grass');
  // Legacy neighbor slot referenced tileIndex: 0 (old row-major array
  // index) — migration must resolve that to t0's new id, not carry the
  // stale index over, since Task 3 re-keys neighbor cross-references onto
  // tileId everywhere else in the app.
  assert.deepEqual(t1.neighbors.e, { mode: 'tile', tileId: t0.id, flipH: true, flipV: false });
});

test('serialize/deserialize round-trip preserves pixels and structure', () => {
  const { p, s } = proj();
  setPixel(sheetLayers(s)[0].bitmap, 3, 2, [1, 2, 3, 255]);
  addFrame(s, { name: 'f', x: 0, y: 0, w: 8, h: 8 });
  const { json, images } = serializeProject(p);
  assert.equal(json.version, PROJECT_VERSION);
  assert.equal(images.length, 1);
  assert.match(images[0].path, /^images\/.+\/.+\.png$/);
  assert.equal(json.sheets[0].layerTree.children[0].image, images[0].path);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(getPixel(sheetLayers(p2.sheets[0])[0].bitmap, 3, 2), [1, 2, 3, 255]);
  assert.equal(p2.sheets[0].frames.length, 1);
});

test('validateProjectJson rejects bad input', () => {
  assert.equal(validateProjectJson({ version: 99 }).ok, false);
  assert.equal(validateProjectJson(null).ok, false);
  const { p } = proj();
  assert.equal(validateProjectJson(serializeProject(p).json).ok, true);
});

test('project carries required settings; version 4', () => {
  const p = createProject('s');
  assert.equal(p.version, 4);
  assert.deepEqual(p.settings, { ...DEFAULT_SETTINGS, onion: defaultOnionSettings() });
  const p2 = createProject('s2', { ...DEFAULT_SETTINGS, tileW: 8 });
  assert.equal(p2.settings.tileW, 8);
});

test('deserializeProject: targetPlatform/exportColorMode/pixelSnapper* fall back to their defaults for files saved before those fields existed', () => {
  const json = { version: 2, name: 's', settings: { spriteSheetW: 256, spriteSheetH: 256, tileSheetW: 256, tileSheetH: 256, tileW: 16, tileH: 16, frameW: 16, frameH: 16, durationMs: 100 }, sheets: [] };
  const p = deserializeProject(json, new Map());
  assert.equal(p.settings.targetPlatform, 'none');
  assert.equal(p.settings.exportColorMode, 'strict');
  assert.equal(p.settings.pixelSnapperEnabled, false);
  assert.equal(p.settings.pixelSnapperKColors, DEFAULT_SETTINGS.pixelSnapperKColors);
  assert.equal(p.settings.pixelSnapperPixelSizeOverride, null);
  assert.equal(p.settings.pixelSnapperPaletteId, '');
  // the 9 advanced tuning knobs -- spread-filled by the `startsWith('pixelSnapper')`
  // catch-all in deserializeProject, not listed individually there
  for (const key of [
    'pixelSnapperMaxIterations', 'pixelSnapperPeakThreshold', 'pixelSnapperPeakDistanceFilter',
    'pixelSnapperSearchWindowRatio', 'pixelSnapperMinSearchWindow', 'pixelSnapperStrengthThreshold',
    'pixelSnapperMinCutsPerAxis', 'pixelSnapperFallbackSegments', 'pixelSnapperMaxStepRatio',
  ]) {
    assert.equal(p.settings[key], DEFAULT_SETTINGS[key], `${key} should fall back to its default`);
  }
});

test('DEFAULT_SETTINGS: pixelSnapper advanced knobs mirror pixelSnapper.js\'s own DEFAULT_PIXEL_SNAPPER_CONFIG exactly', () => {
  assert.equal(DEFAULT_SETTINGS.pixelSnapperMaxIterations, 15);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperPeakThreshold, 0.2);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperPeakDistanceFilter, 4);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperSearchWindowRatio, 0.35);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperMinSearchWindow, 2.0);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperStrengthThreshold, 0.5);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperMinCutsPerAxis, 4);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperFallbackSegments, 64);
  assert.equal(DEFAULT_SETTINGS.pixelSnapperMaxStepRatio, 1.8);
});

test('activePaletteColors: null when there is no active palette, or the active one has no colors yet', () => {
  const p = createProject('s');
  assert.equal(activePaletteColors(p), null);
  p.palettes.push(createPalette({ name: 'empty swatches', indexed: false }));
  p.activePaletteId = p.palettes[0].id;
  assert.equal(activePaletteColors(p), null);
});

test('activePaletteColors: returns the active indexed palette\'s colors as plain [r,g,b] triples (alpha dropped)', () => {
  const p = createProject('s');
  const palette = createPalette({ name: 'ramp', indexed: true, size: 2 });
  setEntry(palette, 0, [255, 0, 0, 255]);
  setEntry(palette, 1, [0, 255, 0, 128]);
  p.palettes.push(palette);
  p.activePaletteId = palette.id;
  assert.deepEqual(activePaletteColors(p), [[255, 0, 0], [0, 255, 0]]);
});

test('activePaletteColors: also works for non-indexed (free-form swatch) palettes -- the default "New Palette" shape', () => {
  const p = createProject('s');
  const palette = createPalette({ name: 'my swatches', indexed: false });
  palette.colors.push([10, 20, 30, 255], [40, 50, 60, 255]);
  p.palettes.push(palette);
  p.activePaletteId = palette.id;
  assert.deepEqual(activePaletteColors(p), [[10, 20, 30], [40, 50, 60]]);
});

test('resolvePixelSnapperPalette: "" (default) tracks the project\'s active palette', () => {
  const p = createProject('s');
  const palette = createPalette({ name: 'ramp', indexed: true, size: 1 });
  setEntry(palette, 0, [1, 2, 3, 255]);
  p.palettes.push(palette);
  p.activePaletteId = palette.id;
  p.settings.pixelSnapperPaletteId = '';
  assert.deepEqual(resolvePixelSnapperPalette(p), [[1, 2, 3]]);
});

test('resolvePixelSnapperPalette: "none" forces no target palette, even with an active palette set', () => {
  const p = createProject('s');
  const palette = createPalette({ name: 'ramp', indexed: true, size: 1 });
  setEntry(palette, 0, [1, 2, 3, 255]);
  p.palettes.push(palette);
  p.activePaletteId = palette.id;
  p.settings.pixelSnapperPaletteId = 'none';
  assert.equal(resolvePixelSnapperPalette(p), null);
});

test('resolvePixelSnapperPalette: a specific palette id picks that palette, independent of which one is active', () => {
  const p = createProject('s');
  const active = createPalette({ name: 'active', indexed: true, size: 1 });
  setEntry(active, 0, [9, 9, 9, 255]);
  const other = createPalette({ name: 'other', indexed: true, size: 1 });
  setEntry(other, 0, [7, 7, 7, 255]);
  p.palettes.push(active, other);
  p.activePaletteId = active.id;
  p.settings.pixelSnapperPaletteId = other.id;
  assert.deepEqual(resolvePixelSnapperPalette(p), [[7, 7, 7]]);
});

test('animations save as manual; serialize round-trips settings', () => {
  const p = createProject('a');
  const s = createSheet(p, { name: 'sh', width: 32, height: 32, kind: 'sprite' });
  addAnimation(s, 'walk');
  const { json, images } = serializeProject(p);
  assert.equal(json.version, 4);
  assert.deepEqual(json.settings, { ...DEFAULT_SETTINGS, onion: defaultOnionSettings() });
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(p2.settings, { ...DEFAULT_SETTINGS, onion: defaultOnionSettings() });
  assert.deepEqual([p2.sheets[0].animations[0].layout, p2.sheets[0].animations[0].cell, 'strip' in p2.sheets[0].animations[0]], ['manual', null, false]);
});

test('validateProjectJson rejects version 1 and missing/invalid settings', () => {
  assert.equal(validateProjectJson({ version: 1, sheets: [], settings: DEFAULT_SETTINGS }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [] }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [], settings: { tileW: 16 } }).ok, false);
});

test('flattenSheetLayers respects context and visibility', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const top = addLayer(s, 'global');
  const layers = sheetLayers(s);
  layers[0].visible = false;
  setPixel(top.bitmap, 1, 1, [255, 0, 0, 255]);
  const flat = flattenSheetLayers(layers, s.width, s.height);
  assert.deepEqual(getPixel(flat, 1, 1), [255, 0, 0, 255]);
});

test('effectiveDuration: ms-primary falls back through duration -> baseDuration -> 100', () => {
  const anim = { baseDuration: 80 };
  assert.equal(effectiveDuration(anim, { duration: null }), 80);
  assert.equal(effectiveDuration(anim, { duration: 40 }), 40);
  assert.equal(effectiveDuration({}, { duration: null }), 100);
});

test('effectiveDuration: fps-primary falls back through step -> baseStep -> 1, computed via baseFps', () => {
  const anim = { baseFps: 24, baseStep: 2 };
  assert.equal(effectiveDuration(anim, { step: null }), 83); // round(1000/24*2)
  assert.equal(effectiveDuration(anim, { step: 1 }), 42); // round(1000/24*1)
  assert.equal(effectiveDuration({ baseFps: 24 }, { step: null }), 42); // baseStep missing -> 1
});

test('effectiveDuration: dormant field is ignored -- only the field matching the current primary unit is honored', () => {
  const fpsAnim = { baseFps: 24, baseStep: 1 };
  assert.equal(effectiveDuration(fpsAnim, { duration: 5, step: null }), 42, 'fps-primary: duration override is dormant');
  const msAnim = { baseDuration: 50 };
  assert.equal(effectiveDuration(msAnim, { duration: null, step: 99 }), 50, 'ms-primary: step override is dormant');
});

test('fpsStepToMs computes rounded ms; msToFps is its exact inverse for whole-ms cases', () => {
  assert.equal(fpsStepToMs(24, 2), 83); // 1000/24*2 = 83.33.. -> 83
  assert.equal(fpsStepToMs(10, 1), 100);
  assert.equal(msToFps(1000), 1);
  assert.equal(msToFps(250), 4);
});

test('addAnimation seeds base duration from an optional defaults argument, falling back to ms-100', () => {
  const { s } = (() => { const p = createProject('t'); return { s: createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' }) }; })();
  const a1 = addAnimation(s, 'walk');
  assert.equal(a1.baseDuration, 100);
  assert.equal(a1.baseFps, undefined);
  assert.equal(a1.baseStep, undefined);

  const a2 = addAnimation(s, 'run', { durationMs: 80 });
  assert.equal(a2.baseDuration, 80);

  const a3 = addAnimation(s, 'jump', { durationMs: 83, baseFps: 24, baseStep: 2 });
  assert.equal(a3.baseDuration, 83);
  assert.equal(a3.baseFps, 24);
  assert.equal(a3.baseStep, 2);
});

test('serializeProject/deserializeProject round-trip anim base-duration fields and settings.baseFps/baseStep via the existing spreads -- no explicit per-field code needed', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 16, kind: 'sprite' });
  addAnimation(s, 'walk', { durationMs: 83, baseFps: 24, baseStep: 2 });
  p.settings.baseFps = 12;
  p.settings.baseStep = 3;
  const { json, images } = serializeProject(p);
  assert.equal(json.sheets[0].animations[0].baseDuration, 83);
  assert.equal(json.sheets[0].animations[0].baseFps, 24);
  assert.equal(json.settings.baseFps, 12);
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.equal(p2.sheets[0].animations[0].baseDuration, 83);
  assert.equal(p2.sheets[0].animations[0].baseStep, 2);
  assert.equal(p2.settings.baseFps, 12);
});

test('a locked palette with empty slots and a custom unset color survives save and reload', () => {
  const p = createProject('pal-roundtrip');
  const pal = createPalette({ name: 'Console', indexed: true, size: 3, lockReason: 'NES' });
  setEntry(pal, 0, [1, 2, 3, 255]);
  setEmptyColor(pal, [200, 0, 200, 255]);
  p.palettes.push(pal);
  p.activePaletteId = pal.id;

  const { json } = serializeProject(p);
  const back = deserializeProject(json, new Map()).palettes[0];

  assert.deepEqual(back.lock, { size: 3, reason: 'NES' });
  assert.deepEqual(back.empty, [false, true, true]);
  assert.deepEqual(back.emptyColor, [200, 0, 200, 255]);
  assert.deepEqual(back.colors[0], [1, 2, 3, 255]);
  assert.deepEqual(back.colors[1], [200, 0, 200, 255]);
  assert.equal('size' in back, false);
  // deep-copied, not aliased into the serialized json
  back.colors[0][0] = 99;
  assert.equal(pal.colors[0][0], 1);
});

test('a palette unlocked by the user stays unlocked across save and reload, even while indexed', () => {
  const p = createProject('pal-unlocked');
  const pal = createPalette({ name: 'Free', indexed: true });
  addSwatch(pal, [4, 5, 6, 255]);
  p.palettes.push(pal);

  const back = deserializeProject(serializeProject(p).json, new Map()).palettes[0];
  assert.equal(back.lock, null, 'indexed must not silently re-lock an unlocked palette');
  assert.equal(back.indexed, true);
});

test('a project saved before the lock/empty model loads with its old palettes migrated', () => {
  // Exactly the shape older files carry: {indexed, size, colors} and nothing else.
  const { json } = serializeProject(createProject('legacy'));
  json.palettes = [
    { id: 'old1', name: 'Indexed', indexed: true, size: 4, colors: [[1, 1, 1, 255], [2, 2, 2, 255]] },
    { id: 'old2', name: 'Swatches', indexed: false, size: 0, colors: [[3, 3, 3, 255]] },
  ];
  const [indexedPal, freePal] = deserializeProject(json, new Map()).palettes;

  // colors.length wins over the stored size, and the old fixed-size rule
  // becomes an unlabeled lock the user can name or clear.
  assert.deepEqual(indexedPal.lock, { size: 2, reason: '' });
  assert.deepEqual(indexedPal.empty, [false, false]);
  assert.deepEqual(indexedPal.emptyColor, [0, 0, 0, 255]);
  assert.equal('size' in indexedPal, false);

  assert.equal(freePal.lock, null);
  assert.deepEqual(freePal.empty, [false]);
});

test('an empty palette slot is an ordinary color to brush snapping -- empty is editor-only', () => {
  const p = createProject('snap');
  const pal = createPalette({ name: 'Locked', indexed: true, size: 3, lockReason: 'x' });
  setEntry(pal, 0, [10, 20, 30, 255]);
  p.palettes.push(pal);
  p.activePaletteId = pal.id;
  // Two slots are still unset, and they are still offered as snap targets.
  assert.deepEqual(resolvePixelSnapperPalette(p), [[10, 20, 30], [0, 0, 0], [0, 0, 0]]);
  assert.equal(activePaletteColors(p).length, 3);
});

// --- embedded brushes -------------------------------------------------------

test('a project round-trips its embedded brushes', () => {
  const p = createProject('brushes');
  p.brushes = [normalizeBrush({ name: 'Embedded', mask: { kind: 'circle', size: 5 } })];
  const { json, images } = serializeProject(p);
  const back = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.equal(back.brushes.length, 1);
  assert.equal(back.brushes[0].name, 'Embedded');
  assert.equal(back.brushes[0].mask.size, 5);
});

test('an old project file with no brushes key loads with an empty list', () => {
  const p = createProject('old');
  const { json, images } = serializeProject(p);
  delete json.brushes;
  const back = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual(back.brushes, []);
});

test('a custom-mask brush survives the REAL JSON boundary a bundle writes', () => {
  // The two tests above cannot catch the hazard this one exists for, and it is
  // worth saying why. A `circle` mask has no bitmap, so there is no Uint8Array
  // to lose; and handing `json` straight to deserializeProject never crosses a
  // JSON boundary at all, so even a raw Uint8Array would survive. bundle.js
  // really does `JSON.stringify(json)` (bundle.js:7), and a Uint8Array JSONs to
  // an OBJECT -- `{"0":1,...}` -- which `Uint8Array.from` turns into an EMPTY
  // array. Without toPlain/fromPlain the brush comes back listed, selectable,
  // and painting nothing. So: custom mask, and a real stringify/parse.
  const p = createProject('custom');
  p.brushes = [normalizeBrush({
    name: 'Stamp',
    mask: { kind: 'custom', bitmap: { width: 2, height: 2, bits: Uint8Array.from([1, 0, 0, 1]) } },
  })];
  const { json, images } = serializeProject(p);
  const wire = JSON.parse(JSON.stringify(json));
  const back = deserializeProject(wire, new Map(images.map(i => [i.path, i.bitmap])));
  const bits = back.brushes[0].mask.bitmap.bits;
  assert.ok(bits instanceof Uint8Array, 'bits must rehydrate as a typed array');
  assert.equal(bits.length, 4, 'an empty array here is the exact failure this guards');
  assert.equal([...bits].join(''), '1001');
});
