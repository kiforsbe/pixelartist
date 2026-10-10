import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deserializeProject, serializeProject, flattenSheetLayers, sheetLayers, validateProjectJson, PROJECT_VERSION,
} from '../js/core/model.js';
import { createBitmap, setPixel, getPixel, copyRegion, blitRegion } from '../js/core/pixels.js';
import { COVERED_FOLDER_NAME } from '../js/core/legacy-animations.js';

const W = 64, H = 32;
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], NONE = [0, 0, 0, 0];

function v3Project(build) {
  const images = new Map();
  const layer = (id, pixels = []) => {
    const bitmap = createBitmap(W, H);
    for (const [x, y, c] of pixels) setPixel(bitmap, x, y, c);
    const path = `images/s/${id}.png`;
    images.set(path, bitmap);
    return { id, type: 'layer', name: id, visible: true, opacity: 1, image: path };
  };
  const group = (id, children, animationId = null) => ({ id, type: 'group', name: id, animationId, open: true, children });
  const { frames, animations, children } = build({ layer, group });
  const json = {
    version: 3, name: 'p',
    settings: { spriteSheetW: W, spriteSheetH: H, tileSheetW: 16, tileSheetH: 16, tileW: 16, tileH: 16, frameW: 16, frameH: 16, durationMs: 100 },
    sheets: [{ id: 's', name: 's', kind: 'sprite', width: W, height: H, frames, animations, layerTree: group('root', children) }],
    maps: [], palettes: [],
  };
  return { json, images };
}
const fr = (id, x, y, w = 16, h = 16, pivotX = 0, pivotY = 0) => ({ id, name: id, x, y, w, h, pivotX, pivotY });
const strip = (id, frameIds, extra = {}) => ({
  id, name: id, loop: true, strip: true, breaks: [], layerGroupId: null, baseDuration: 100,
  frames: frameIds.map(frameId => ({ frameId, duration: null, step: null })), ...extra,
});
const load = p => deserializeProject(p.json, p.images);

// The v3 compositor, kept as the reference the conversion must match:
// non-strip layers everywhere, then each accepted strip's own layers
// hard-replace its frame rects (later strips win). Call BEFORE load(),
// which converts the bitmaps in place.
function v3Render({ json, images }) {
  const s = json.sheets[0];
  const layers = [];
  (function walk(node, owner) {
    for (const c of node.children) {
      if (c.type === 'layer') layers.push({ ...c, bitmap: images.get(c.image), owner });
      else walk(c, c.animationId ?? owner);
    }
  })(s.layerTree, null);
  const accepted = s.animations.filter(a => a.strip && a.layerGroupId);
  const out = flattenSheetLayers(layers.filter(l => !accepted.some(a => a.id === l.owner)), s.width, s.height);
  for (const a of accepted) {
    const own = flattenSheetLayers(layers.filter(l => l.owner === a.id), s.width, s.height);
    for (const e of a.frames) {
      const f = s.frames.find(x => x.id === e.frameId);
      blitRegion(out, copyRegion(own, f.x, f.y, f.w, f.h), f.x, f.y);
    }
  }
  return out;
}
const render = sheet => flattenSheetLayers(sheetLayers(sheet), sheet.width, sheet.height);

test('an accepted, contiguous, ordered strip becomes auto and stays where it was', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 16, 16), fr('b', 32, 16)],
    animations: [strip('run', ['a', 'b'], { layerGroupId: 'g' })],
    children: [layer('base'), group('g', [layer('ink')], 'run')],
  }))).sheets[0];
  const run = sheet.animations[0];
  assert.deepEqual([run.layout, run.cell], ['auto', { w: 16, h: 16 }]);
  assert.equal(['strip', 'breaks', 'layerGroupId'].some(k => k in run), false);
  assert.deepEqual(sheet.frames.map(f => [f.x, f.y]), [[16, 16], [32, 16]]);
});

for (const [label, frames, extra] of [
  ['has breaks', [fr('a', 0, 0), fr('b', 16, 0)], { layerGroupId: 'g', breaks: [1] }],
  ['is floating', [fr('a', 0, 0), fr('b', 16, 0)], { layerGroupId: null }],
  ['is not a strip', [fr('a', 0, 0), fr('b', 16, 0)], { layerGroupId: 'g', strip: false }],
  ['mixes sizes', [fr('a', 0, 0), fr('b', 16, 0, 8, 16)], { layerGroupId: 'g' }],
  ['has a gap', [fr('a', 0, 0), fr('b', 20, 0)], { layerGroupId: 'g' }],
  ['runs right to left', [fr('a', 16, 0), fr('b', 0, 0)], { layerGroupId: 'g' }],
  ['spans two rows', [fr('a', 0, 0), fr('b', 16, 16)], { layerGroupId: 'g' }],
  ['has differing pivots', [fr('a', 0, 0), fr('b', 16, 0, 16, 16, 8, 8)], { layerGroupId: 'g' }],
]) {
  test(`a v3 animation that ${label} converts to manual`, () => {
    const sheet = load(v3Project(({ layer, group }) => ({
      frames, animations: [strip('run', ['a', 'b'], extra)],
      children: [layer('base'), group('g', [layer('ink')], 'run')],
    }))).sheets[0];
    assert.deepEqual([sheet.animations[0].layout, sheet.animations[0].cell], ['manual', null]);
  });
}

test('a frame two qualifying strips share is auto only in the first', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('b', 16, 0)],
    animations: [strip('run', ['a', 'b'], { layerGroupId: 'g1' }), strip('walk', ['a', 'b'], { layerGroupId: 'g2' })],
    children: [group('g1', [layer('ink1')], 'run'), group('g2', [layer('ink2')], 'walk')],
  }))).sheets[0];
  assert.deepEqual(sheet.animations.map(a => a.layout), ['auto', 'manual']);
});

test('animation-owned groups become plain folders', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0)], animations: [strip('run', ['a'], { layerGroupId: 'g' })],
    children: [group('g', [layer('ink')], 'run')],
  }))).sheets[0];
  (function walk(node) {
    assert.equal('animationId' in node, false);
    for (const c of node.children) if (c.type === 'group') walk(c);
  })(sheet.layerTree);
  assert.equal(sheet.layerTree.children.some(c => c.id === 'g'), true);
});

test('pixels a v3 strip hid move to a hidden covered folder; the render is unchanged', () => {
  const p = v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('b', 16, 0)],
    animations: [strip('run', ['a', 'b'], { layerGroupId: 'g' })],
    children: [
      layer('base', [[2, 2, RED], [40, 2, RED]]),                  // (2,2) lies under the strip
      group('g', [layer('ink', [[3, 3, BLUE], [50, 20, BLUE]])], 'run'), // (50,20) lies outside its frames
    ],
  }));
  const expected = v3Render(p);
  const sheet = load(p).sheets[0];
  assert.deepEqual(render(sheet).data, expected.data);
  const folder = sheet.layerTree.children[0];
  assert.equal(folder.name, COVERED_FOLDER_NAME);
  assert.deepEqual(folder.children.map(l => [l.name, l.visible]), [['base', false], ['ink', false]]);
  assert.deepEqual(getPixel(folder.children[0].bitmap, 2, 2), RED);
  assert.deepEqual(getPixel(folder.children[1].bitmap, 50, 20), BLUE);
  const base = sheetLayers(sheet).find(l => l.name === 'base' && l.visible);
  assert.deepEqual([getPixel(base.bitmap, 2, 2), getPixel(base.bitmap, 40, 2)], [NONE, RED]);
});

test('converts overlapping accepted strips without changing the render', () => {
  const p = v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('c', 8, 0)],
    animations: [strip('run', ['a'], { layerGroupId: 'g1' }), strip('walk', ['c'], { layerGroupId: 'g2' })],
    children: [
      layer('base', [[12, 12, BLUE], [30, 30, BLUE]]),
      group('g1', [layer('ink1', [[2, 2, RED], [10, 2, RED]])], 'run'),
      group('g2', [layer('ink2', [[10, 3, GREEN], [2, 3, GREEN]])], 'walk'),
    ],
  }));
  const expected = v3Render(p);
  assert.deepEqual(render(load(p).sheets[0]).data, expected.data);
});

test('no covered folder is created when a strip hid nothing', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0)], animations: [strip('run', ['a'], { layerGroupId: 'g' })],
    children: [layer('base', [[40, 2, RED]]), group('g', [layer('ink', [[1, 1, BLUE]])], 'run')],
  }))).sheets[0];
  assert.equal(sheet.layerTree.children.some(c => c.name === COVERED_FOLDER_NAME), false);
});

test('v4 saves layout, cell, locked and sheetMaxWidth and loads them back', () => {
  const project = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('b', 16, 0)], animations: [strip('run', ['a', 'b'], { layerGroupId: 'g' })],
    children: [layer('base'), group('g', [layer('ink')], 'run')],
  })));
  sheetLayers(project.sheets[0])[0].locked = true;
  const { json, images } = serializeProject(project);
  assert.equal(json.version, PROJECT_VERSION);
  assert.equal(PROJECT_VERSION, 4);
  const saved = json.sheets[0].animations[0];
  assert.deepEqual([saved.layout, saved.cell, 'strip' in saved, 'animationId' in json.sheets[0].layerTree], ['auto', { w: 16, h: 16 }, false, false]);
  const again = deserializeProject(JSON.parse(JSON.stringify(json)), new Map(images.map(i => [i.path, i.bitmap])));
  assert.deepEqual([again.sheets[0].animations[0].layout, again.sheets[0].animations[0].cell], ['auto', { w: 16, h: 16 }]);
  assert.equal(sheetLayers(again.sheets[0])[0].locked, true);
  assert.equal(again.settings.sheetMaxWidth, W);
});

test('v4 requires sheetMaxWidth; unknown versions are rejected', () => {
  const p = v3Project(({ layer }) => ({ frames: [], animations: [], children: [layer('base')] }));
  p.json.version = 4;
  assert.match(validateProjectJson(p.json).error, /sheetMaxWidth/);
  p.json.version = 5;
  assert.match(validateProjectJson(p.json).error, /unsupported version 5/);
});

test('accepted strips whose frames overlap each other convert to manual', () => {
  const sheet = load(v3Project(({ layer, group }) => ({
    frames: [fr('a', 0, 0), fr('c', 8, 0)],
    animations: [strip('run', ['a'], { layerGroupId: 'g1' }), strip('walk', ['c'], { layerGroupId: 'g2' })],
    children: [layer('base'), group('g1', [layer('ink1')], 'run'), group('g2', [layer('ink2')], 'walk')],
  }))).sheets[0];
  assert.deepEqual(sheet.animations.map(a => a.layout), ['manual', 'manual']);
});
