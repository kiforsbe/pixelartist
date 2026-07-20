import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, DEFAULT_SETTINGS, defaultOnionSettings, createProject, createSheet, addLayer, removeLayer,
  moveLayer, mergeDown, addFrame, removeFrame, addAnimation, acceptAnimation, flattenSheet, flattenSheetLayers,
  serializeProject, deserializeProject, validateProjectJson, GROUP, LAYER,
  sheetLayers, findGroup, contextLayers, addGroup, flattenLayers, moveNode,
  scrubTileReferences, layerAnimationContext, removeSheet, activePaletteColors, resolvePixelSnapperPalette,
  effectiveDuration, fpsStepToMs, msToFps,
} from '../js/core/model.js';
import { createPalette, setEntry } from '../js/core/palettes.js';
import { setPixel, getPixel, createBitmap } from '../js/core/pixels.js';

function proj() {
  const p = createProject('demo');
  const s = createSheet(p, { name: 'sheet1', width: 32, height: 16, kind: 'sprite' });
  return { p, s };
}

test('removeSheet splices the matching sheet out of project.sheets and returns it', () => {
  const p = createProject('t');
  const s1 = createSheet(p, { name: 'a', width: 8, height: 8, kind: 'sprite' });
  const s2 = createSheet(p, { name: 'b', width: 8, height: 8, kind: 'tile' });
  const removed = removeSheet(p, s1.id);
  assert.equal(removed, s1);
  assert.deepEqual(p.sheets, [s2]);
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
  // only layer nodes may be moved into an animation-owned group
  const a = addAnimation(s, 'walk');
  acceptAnimation(s, a);
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

test('addAnimation creates a floating animation with no layer group yet', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'walk');
  assert.equal(a.layerGroupId, null);
  assert.equal(a.name, 'walk');
  assert.deepEqual(a.frames, []);
  assert.deepEqual(a.breaks, []);
  assert.equal(contextLayers(s, a.id).length, sheetLayers(s).length, 'falls back to whole sheet while floating');
});

test('acceptAnimation freezes the current composite under the animation\'s own frames into a new layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 1, 1, [1, 2, 3, 255]);
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  assert.equal(a.layerGroupId, null, 'floating until accepted');

  acceptAnimation(s, a);
  assert.ok(a.layerGroupId, 'animation has layerGroupId after accept');
  const g = findGroup(s.layerTree, a.layerGroupId);
  assert.equal(g.animationId, a.id);
  assert.equal(flattenLayers(g).length, 1);
  assert.deepEqual(getPixel(flattenLayers(g)[0].bitmap, 1, 1), [1, 2, 3, 255]);
  // mutation on the strip's own layer does not bleed back to the root layer
  setPixel(flattenLayers(g)[0].bitmap, 1, 1, [9, 9, 9, 255]);
  assert.deepEqual(getPixel(sheetLayers(s)[0].bitmap, 1, 1), [1, 2, 3, 255]);
});

test('acceptAnimation with zero frames yields a blank layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [1, 2, 3, 255]);
  const a = addAnimation(s, 'walk'); // plain animation, no frames yet
  acceptAnimation(s, a);
  const g = findGroup(s.layerTree, a.layerGroupId);
  assert.deepEqual(getPixel(flattenLayers(g)[0].bitmap, 0, 0), [0, 0, 0, 0]);
});

test('acceptAnimation only freezes pixels under its own frames, not another animation\'s private layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a1 = addAnimation(s, 'walk', true);
  a1.frames = [{ frameId: f1.id, duration: 100 }];
  acceptAnimation(s, a1);
  setPixel(flattenLayers(findGroup(s.layerTree, a1.layerGroupId))[0].bitmap, 0, 0, [255, 0, 0, 255]);

  const f2 = addFrame(s, { name: 'f1', x: 4, y: 0, w: 4, h: 4 }); // adjacent, non-overlapping rect
  const a2 = addAnimation(s, 'run', true);
  a2.frames = [{ frameId: f2.id, duration: 100 }];
  acceptAnimation(s, a2);
  const g2 = findGroup(s.layerTree, a2.layerGroupId);
  // a2's own frame rect (x:4..8) never touched a1's red pixel at (0,0)
  assert.deepEqual(getPixel(flattenLayers(g2)[0].bitmap, 0, 0), [0, 0, 0, 0]);
});

test('acceptAnimation flattens multiple visible layers (with opacity) under its own frames', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [255, 0, 0, 255]); // opaque red
  const top = addLayer(s, 'top');
  top.opacity = 0.5;
  setPixel(top.bitmap, 0, 0, [0, 0, 255, 255]); // blue @ 50% over red
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  acceptAnimation(s, a);
  const g = findGroup(s.layerTree, a.layerGroupId);
  const groupLayers = flattenLayers(g);
  assert.equal(groupLayers.length, 1);
  assert.equal(groupLayers[0].visible, true);
  assert.equal(groupLayers[0].opacity, 1);
  assert.deepEqual(getPixel(groupLayers[0].bitmap, 0, 0), [128, 0, 128, 255]);
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

test('flattenSheet gives an accepted strip exclusive, opaque ownership of its own frame rects', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [255, 0, 0, 255]); // root pixel under the strip's frame
  setPixel(sheetLayers(s)[0].bitmap, 8, 0, [0, 255, 0, 255]); // root pixel OUTSIDE the strip's frame

  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  acceptAnimation(s, a); // freezes root's (0,0) red pixel into the strip's own layer

  // erase the strip's own copy of that pixel so it's transparent on the strip's layer
  const g = findGroup(s.layerTree, a.layerGroupId);
  setPixel(flattenLayers(g)[0].bitmap, 0, 0, [0, 0, 0, 0]);

  const flat = flattenSheet(s);
  // inside the strip's own frame rect: transparent strip pixel wins -- root's red does NOT show through
  assert.deepEqual(getPixel(flat, 0, 0), [0, 0, 0, 0]);
  // outside the strip's frame rect: root layer composites normally
  assert.deepEqual(getPixel(flat, 8, 0), [0, 255, 0, 255]);
});

test('flattenSheet leaves a floating (not-yet-accepted) strip transparent to whatever is underneath', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 8, kind: 'sprite' });
  setPixel(sheetLayers(s)[0].bitmap, 0, 0, [255, 0, 0, 255]);
  const f1 = addFrame(s, { name: 'f0', x: 0, y: 0, w: 4, h: 4 });
  const a = addAnimation(s, 'walk', true);
  a.frames = [{ frameId: f1.id, duration: 100 }];
  // not accepted -- a.layerGroupId is still null
  assert.deepEqual(getPixel(flattenSheet(s), 0, 0), [255, 0, 0, 255]);
});

test('layerAnimationContext returns null for a root layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  assert.equal(layerAnimationContext(s, sheetLayers(s)[0]), null);
});

test('layerAnimationContext returns null for a layer under a plain (non-animation) group', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const g = addGroup(s, 'g1');
  const layer = addLayer(s, 'inside', g.id);
  assert.equal(layerAnimationContext(s, layer), null);
});

test('layerAnimationContext returns null for a null layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  assert.equal(layerAnimationContext(s, null), null);
});

test('layerAnimationContext resolves the owning animation for an accepted strip\'s own layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'walk', true);
  acceptAnimation(s, a);
  const group = findGroup(s.layerTree, a.layerGroupId);
  const layer = flattenLayers(group)[0];
  const ctx = layerAnimationContext(s, layer);
  assert.equal(ctx.anim, a);
  assert.equal(ctx.group, group);
});

test('layerAnimationContext also resolves a plain (non-strip) animation\'s own layer', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  const a = addAnimation(s, 'anim_0'); // strip: false
  acceptAnimation(s, a);
  const group = findGroup(s.layerTree, a.layerGroupId);
  const layer = flattenLayers(group)[0];
  const ctx = layerAnimationContext(s, layer);
  assert.equal(ctx.anim, a);
  assert.equal(ctx.anim.strip, false);
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


test('animations carry strip flag; serialize round-trips settings and strip', () => {
  const p = createProject('a');
  const s = createSheet(p, { name: 'sh', width: 32, height: 32, kind: 'sprite' });
  const an = addAnimation(s, 'walk', true);
  assert.equal(an.strip, true);
  const { json, images } = serializeProject(p);
  assert.equal(json.version, 2);
  assert.deepEqual(json.settings, { ...DEFAULT_SETTINGS, onion: defaultOnionSettings() });
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(p2.settings, { ...DEFAULT_SETTINGS, onion: defaultOnionSettings() });
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

test('contextLayers scopes to animation group or returns all layers', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' });
  addLayer(s, 'global');
  const beforeAnim = sheetLayers(s).map(l => l.id);
  const a = addAnimation(s, 'walk');
  acceptAnimation(s, a);
  // 2 root layers + the single (blank, since the animation has no frames yet) layer created for the new anim group
  assert.equal(contextLayers(s).length, 3);
  // scoped to the animation, only its own (single) layer is returned
  assert.equal(contextLayers(s, a.id).length, 1);
  const animLayerIds = new Set(contextLayers(s, a.id).map(l => l.id));
  // animation layers are independent copies with new ids, not the originals
  for (const id of animLayerIds) assert.ok(!beforeAnim.includes(id));
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

  const a2 = addAnimation(s, 'run', false, { durationMs: 80 });
  assert.equal(a2.baseDuration, 80);

  const a3 = addAnimation(s, 'jump', false, { durationMs: 83, baseFps: 24, baseStep: 2 });
  assert.equal(a3.baseDuration, 83);
  assert.equal(a3.baseFps, 24);
  assert.equal(a3.baseStep, 2);
});

test('serializeProject/deserializeProject round-trip anim base-duration fields and settings.baseFps/baseStep via the existing spreads -- no explicit per-field code needed', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 16, kind: 'sprite' });
  addAnimation(s, 'walk', false, { durationMs: 83, baseFps: 24, baseStep: 2 });
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

