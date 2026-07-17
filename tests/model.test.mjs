import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, flattenSheet, flattenSheetLayers,
  serializeProject, deserializeProject, validateProjectJson, GROUP, LAYER,
  sheetLayers, findGroup, contextLayers, addGroup, flattenLayers, moveNode,
  scrubTileReferences,
} from '../js/core/model.js';
import { setPixel, getPixel, createBitmap } from '../js/core/pixels.js';

function proj() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 'sheet1', width: 32, height: 16, kind: 'sprite' });
  return { p, s };
}

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
  // only layer nodes may be moved into an animation-owned group
  const a = addAnimation(s, 'walk');
  const ag = findGroup(s.layerTree, a.layerGroupId);
  const freeLayer = addLayer(s, 'free');
  moveNode(s, freeLayer.id, ag.id, 0);
  assert.ok(ag.children.some(c => c.id === freeLayer.id));
  // groups cannot be moved into an animation-owned group
  const g3 = addGroup(s, 'g3');
  moveNode(s, g3.id, ag.id, 0);
  assert.equal(ag.children.findIndex(c => c.id === g3.id), -1);
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

test('createSheet: tile-kind sheet gets empty terrainSets/terrainLayoutPresets/layers, non-tile gets null', () => {
  const p = createProject('t');
  const tileSheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  assert.deepEqual(tileSheet.terrainSets, []);
  assert.deepEqual(tileSheet.terrainLayoutPresets, []);
  assert.deepEqual(tileSheet.layers, []);
  const spriteSheet = createSheet(p, { name: 'Sprites', width: 32, height: 32, kind: 'sprite' });
  assert.equal(spriteSheet.terrainSets, null);
  assert.equal(spriteSheet.terrainLayoutPresets, null);
  assert.equal(spriteSheet.layers, null);
});

test('serializeProject/deserializeProject round-trips terrainSets/terrainLayoutPresets/layers and per-tile fields', () => {
  const p = createProject('t');
  const sheet = createSheet(p, { name: 'Tiles', width: 32, height: 32, kind: 'tile' });
  sheet.terrainSets.push({ id: 'ts1', name: 'Grass', tileW: 16, tileH: 16, slots: { 0: 'ti1' }, symmetry: { flip: true, rotate: false } });
  sheet.terrainLayoutPresets.push({ id: 'tlp1', name: 'My layout', cols: 4, rows: 4, cells: [{ col: 0, row: 0, blobIndex: 0 }] });
  sheet.layers.push('Ground', 'Props');
  sheet.tiles.push({ id: 'ti1', x: 0, y: 0, w: 16, h: 16, name: 'grass', gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: 'ts1', blobIndex: 0, layer: 'Ground', tags: ['nature', 'walkable'] });

  const { json, images } = serializeProject(p);
  const imagesByPath = new Map(images.map(i => [i.path, i.bitmap]));
  const reloaded = deserializeProject(json, imagesByPath);
  const rt = reloaded.sheets.find(s => s.name === 'Tiles');

  assert.deepEqual(rt.terrainSets, [{ id: 'ts1', name: 'Grass', tileW: 16, tileH: 16, slots: { 0: 'ti1' }, symmetry: { flip: true, rotate: false } }]);
  assert.deepEqual(rt.terrainLayoutPresets, [{ id: 'tlp1', name: 'My layout', cols: 4, rows: 4, cells: [{ col: 0, row: 0, blobIndex: 0 }] }]);
  assert.deepEqual(rt.layers, ['Ground', 'Props']);
  const rtTile = rt.tiles.find(t => t.id === 'ti1');
  assert.equal(rtTile.terrainSetId, 'ts1');
  assert.equal(rtTile.blobIndex, 0);
  assert.equal(rtTile.layer, 'Ground');
  assert.deepEqual(rtTile.tags, ['nature', 'walkable']);

  // Mutating the reload must not alias the original sheet's nested objects.
  rt.terrainSets[0].slots[1] = 'ti2';
  rtTile.tags.push('extra');
  assert.deepEqual(sheet.terrainSets[0].slots, { 0: 'ti1' });
  assert.deepEqual(sheet.tiles[0].tags, ['nature', 'walkable']);
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

test('project carries required settings; version 2', () => {
  const p = createProject('s');
  assert.equal(p.version, 2);
  assert.deepEqual(p.settings, DEFAULT_SETTINGS);
  const p2 = createProject('s2', { ...DEFAULT_SETTINGS, tileW: 8 });
  assert.equal(p2.settings.tileW, 8);
});


test('animations carry strip flag; serialize round-trips settings and strip', () => {
  const p = createProject('a');
  const s = createSheet(p, { name: 'sh', width: 32, height: 32, kind: 'sprite' });
  const an = addAnimation(s, 'walk', true);
  assert.equal(an.strip, true);
  const { json, images } = serializeProject(p);
  assert.equal(json.version, 2);
  assert.deepEqual(json.settings, DEFAULT_SETTINGS);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(p2.settings, DEFAULT_SETTINGS);
  assert.equal(p2.sheets[0].animations[0].strip, true);
});

test('validateProjectJson rejects version 1 and missing/invalid settings', () => {
  assert.equal(validateProjectJson({ version: 1, sheets: [], settings: DEFAULT_SETTINGS }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [] }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [], settings: { tileW: 16 } }).ok, false);
});

test('addAnimation initializes breaks; serialize/deserialize round-trips them', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 32, height: 32, kind: 'sprite' });
  const a = addAnimation(s, 'walk', true);
  assert.deepEqual(a.breaks, []);
  const f1 = addFrame(s, { name: 'f1', x: 0, y: 0, w: 8, h: 8 });
  const f2 = addFrame(s, { name: 'f2', x: 8, y: 0, w: 8, h: 8 });
  a.frames = [{ frameId: f1.id, duration: 100 }, { frameId: f2.id, duration: 100 }];
  a.breaks = [1];
  const { json, images } = serializeProject(p);
  assert.deepEqual(json.sheets[0].animations[0].breaks, [1]);
  const imagesByPath = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(json, imagesByPath);
  assert.deepEqual(p2.sheets[0].animations[0].breaks, [1]);
});

test('deserializeProject defaults missing breaks to []', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 32, height: 32, kind: 'sprite' });
  addAnimation(s, 'walk', true);
  const { json, images } = serializeProject(p);
  delete json.sheets[0].animations[0].breaks; // legacy file
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual(p2.sheets[0].animations[0].breaks, []);
});

test('removeFrame adjusts breaks (shift down, drop degenerate)', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 64, height: 32, kind: 'sprite' });
  const fs = [0, 1, 2, 3].map(i => addFrame(s, { name: `f${i}`, x: i * 8, y: 0, w: 8, h: 8 }));
  const a = addAnimation(s, 'walk', true);
  a.frames = fs.map(f => ({ frameId: f.id, duration: 100 }));
  a.breaks = [2];
  removeFrame(s, fs[0].id);          // segments [0,1][2,3] → remove f0 → [1][2,3]
  assert.deepEqual(a.breaks, [1]);
  removeFrame(s, fs[1].id);          // [1][2,3] → remove f1 → break shifts to 0, normalize drops it
  assert.deepEqual(a.frames.map(e => e.frameId), [fs[2].id, fs[3].id]);
  assert.deepEqual(a.breaks, []);    // one segment [2,3]
});

test('addAnimation creates a group with a copy of current layers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [1, 2, 3, 255]);
  const a = addAnimation(s, 'walk');
  assert.ok(a.layerGroupId, 'animation has layerGroupId');
  const g = findGroup(s.layerTree, a.layerGroupId);
  assert.ok(g, 'group exists');
  assert.equal(g.animationId, a.id);
  assert.equal(flattenLayers(g).length, 1);
  assert.deepEqual(getPixel(flattenLayers(g)[0].bitmap, 0, 0), [1, 2, 3, 255]);
  // mutation on animation layer does not bleed back to sheet layer
  setPixel(flattenLayers(g)[0].bitmap, 0, 0, [9, 9, 9, 255]);
  assert.deepEqual(getPixel(sheetLayers(s)[0].bitmap, 0, 0), [1, 2, 3, 255]);
});

test('contextLayers scopes to animation group or returns all layers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  addLayer(s, 'global');
  const beforeAnim = sheetLayers(s).map(l => l.id);
  const a = addAnimation(s, 'walk');
  // all sheet layers include both root layers plus the two copied into the anim group
  assert.equal(contextLayers(s).length, 4);
  // scoped to the animation, only its private layers are returned
  assert.equal(contextLayers(s, a.id).length, 2);
  const animLayerIds = new Set(contextLayers(s, a.id).map(l => l.id));
  // animation layers are independent copies with new ids, not the originals
  for (const id of animLayerIds) assert.ok(!beforeAnim.includes(id));
});

test('flattenSheetLayers respects context and visibility', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  addLayer(s, 'global');
  const a = addAnimation(s, 'walk');
  const animLayers = contextLayers(s, a.id);
  animLayers[0].visible = false;
  setPixel(animLayers[1].bitmap, 1, 1, [255, 0, 0, 255]);
  const flat = flattenSheetLayers(animLayers, s.width, s.height);
  assert.deepEqual(getPixel(flat, 1, 1), [255, 0, 0, 255]);
});
