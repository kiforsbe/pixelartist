// tests/animation-direction.test.mjs
// Animation direction and colour (timeline-dock-dragdrop design §3): the
// model defaults, save/load, the playback order, exports and the commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { SelectionService } from '../js/host/selection-service.js';
import {
  createProject, createSheet, addFrame, addAnimation, sheetLayers, normalizeAnimation,
  serializeProject, deserializeProject, ANIMATION_DIRECTIONS,
} from '../js/core/model.js';
import { setPixel } from '../js/core/pixels.js';
import { playbackSequence, playOrder, advancePlayback } from '../js/domain/sprites/playback.js';
import { buildAnimationGifFrames, buildAnimationImageSequence } from '../js/core/export/animationExport.js';
import {
  newAnimation, setAnimationDirection, setAnimationColor,
} from '../js/modes/sprites/application/commands/animation-lifecycle-commands.js';
import { newAutoAnimation, duplicateAnimation } from '../js/modes/sprites/application/commands/animation-layout-commands.js';

function setup() {
  const project = createProject('t');
  const sheet = createSheet(project, { name: 'S', width: 64, height: 64, kind: 'sprite' });
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  store.updateSession({ activeDocument: { kind: 'sprite-sheet', id: sheet.id } });
  const services = { store, projects: new ProjectService(store, null), history: new HistoryService({ store }), selections: new SelectionService(store) };
  return { project, sheet, services };
}

// ---- model ----

test('new animations default to forward with no colour', () => {
  const { sheet, services } = setup();
  assert.deepEqual(ANIMATION_DIRECTIONS, ['forward', 'reverse', 'pingpong', 'pingpong-reverse']);
  const plain = addAnimation(sheet, 'a');
  assert.deepEqual([plain.direction, plain.color], ['forward', null]);
  newAnimation(services, sheet.id);
  newAutoAnimation(services, sheet.id, { name: 'run', w: 8, h: 8 });
  for (const a of sheet.animations) assert.deepEqual([a.direction, a.color], ['forward', null]);
});

test('normalizeAnimation fills missing or invalid direction/colour and lowercases the colour', () => {
  const base = { id: 'a', name: 'a', loop: true, frames: [], layout: 'manual', cell: null };
  assert.deepEqual([normalizeAnimation(base).direction, normalizeAnimation(base).color], ['forward', null]);
  const bad = normalizeAnimation({ ...base, direction: 'sideways', color: 'red' });
  assert.deepEqual([bad.direction, bad.color], ['forward', null]);
  const good = normalizeAnimation({ ...base, direction: 'pingpong-reverse', color: '#A0B1C2' });
  assert.deepEqual([good.direction, good.color], ['pingpong-reverse', '#a0b1c2']);
});

test('direction and colour round-trip through save and load; files without them load with defaults', () => {
  const { project, sheet } = setup();
  const a = addAnimation(sheet, 'a');
  a.direction = 'pingpong'; a.color = '#ff8800';
  addAnimation(sheet, 'b');
  const { json, images } = serializeProject(project);
  assert.deepEqual([json.sheets[0].animations[0].direction, json.sheets[0].animations[0].color], ['pingpong', '#ff8800']);
  assert.deepEqual([json.sheets[0].animations[1].direction, json.sheets[0].animations[1].color], ['forward', null]);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const loaded = deserializeProject(structuredClone(json), map).sheets[0].animations;
  assert.deepEqual(loaded.map(x => [x.direction, x.color]), [['pingpong', '#ff8800'], ['forward', null]]);
  const old = structuredClone(json);
  for (const x of old.sheets[0].animations) { delete x.direction; delete x.color; }
  assert.deepEqual(deserializeProject(old, map).sheets[0].animations.map(x => [x.direction, x.color]), [['forward', null], ['forward', null]]);
});

// ---- playback order ----

test('playbackSequence gives one cycle of entry indices; ping-pong does not repeat the ends', () => {
  assert.deepEqual(playbackSequence(4, 'forward'), [0, 1, 2, 3]);
  assert.deepEqual(playbackSequence(4, 'reverse'), [3, 2, 1, 0]);
  assert.deepEqual(playbackSequence(4, 'pingpong'), [0, 1, 2, 3, 2, 1]);
  assert.deepEqual(playbackSequence(4, 'pingpong-reverse'), [3, 2, 1, 0, 1, 2]);
  assert.deepEqual(playbackSequence(2, 'pingpong'), [0, 1]);
  assert.deepEqual(playbackSequence(1, 'pingpong-reverse'), [0]);
  assert.deepEqual(playbackSequence(0, 'reverse'), []);
  assert.deepEqual(playbackSequence(3), [0, 1, 2]);
  assert.deepEqual(playbackSequence(3, 'bogus'), [0, 1, 2]);
});

test('playOrder: a non-looping ping-pong pass ends back on its first frame', () => {
  const anim = n => ({ direction: 'pingpong', frames: Array.from({ length: n }, () => ({})) });
  assert.deepEqual(playOrder(anim(3), true), [0, 1, 2, 1]);
  assert.deepEqual(playOrder(anim(3), false), [0, 1, 2, 1, 0]);
  assert.deepEqual(playOrder({ ...anim(3), direction: 'reverse' }, false), [2, 1, 0]);
  assert.deepEqual(playOrder({ ...anim(2), direction: 'pingpong-reverse' }, false), [1, 0, 1]);
  assert.deepEqual(playOrder({ frames: [{}, {}] }, false), [0, 1]); // no direction = forward
});

function timedAnim(direction) {
  return {
    direction, baseDuration: 100,
    frames: [{ frameId: 'a', duration: 100 }, { frameId: 'b', duration: 100 }, { frameId: 'c', duration: 100 }],
  };
}

test('advancePlayback follows a reverse animation and wraps to its last entry', () => {
  const anim = timedAnim('reverse');
  let r = advancePlayback(anim, 2, 0, 100, true);
  assert.deepEqual([r.position, r.stopped], [1, false]);
  r = advancePlayback(anim, 0, 0, 100, true, r.cursor + 1);
  assert.deepEqual([r.position, r.stopped], [2, false]);
  r = advancePlayback(anim, 1, 0, 100, false);
  assert.deepEqual([r.position, r.stopped], [0, false]);
  r = advancePlayback(anim, 0, 0, 100, false);
  assert.deepEqual([r.position, r.stopped], [0, true]);
});

test('advancePlayback ping-pongs using the cursor to tell the way back from the way out', () => {
  const anim = timedAnim('pingpong');
  const positions = [];
  let position = 0, acc = 0, cursor = null;
  for (let i = 0; i < 6; i++) {
    const r = advancePlayback(anim, position, acc, 100, true, cursor);
    ({ position, acc, cursor } = r);
    positions.push(position);
  }
  assert.deepEqual(positions, [1, 2, 1, 0, 1, 2]);
});

test('advancePlayback: a non-looping ping-pong stops back on the first frame', () => {
  const anim = timedAnim('pingpong');
  const r = advancePlayback(anim, 0, 0, 1000, false);
  assert.deepEqual([r.position, r.stopped], [0, true]);
});

test('advancePlayback ignores a cursor that no longer matches the position', () => {
  const r = advancePlayback(timedAnim('forward'), 0, 0, 100, true, 7);
  assert.deepEqual([r.position, r.cursor], [1, 1]);
});

// ---- exports ----

function exportSheet(direction) {
  const project = createProject('e');
  const sheet = createSheet(project, { name: 'Hero', width: 6, height: 2, kind: 'sprite' });
  const layer = sheetLayers(sheet)[0];
  const colours = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]];
  const anim = addAnimation(sheet, 'walk');
  colours.forEach((c, i) => {
    setPixel(layer.bitmap, i * 2, 0, c);
    const f = addFrame(sheet, { name: `walk_${i}`, x: i * 2, y: 0, w: 2, h: 2 });
    anim.frames.push({ frameId: f.id, duration: 100 + i });
  });
  anim.direction = direction;
  return { sheet, anim };
}

test('GIF frames follow the playback order (reverse, looping ping-pong)', () => {
  const { sheet, anim } = exportSheet('reverse');
  assert.deepEqual(buildAnimationGifFrames(sheet, anim).map(f => f.delayMs), [102, 101, 100]);
  anim.direction = 'pingpong';
  assert.deepEqual(buildAnimationGifFrames(sheet, anim).map(f => f.delayMs), [100, 101, 102, 101]);
  anim.loop = false;
  assert.deepEqual(buildAnimationGifFrames(sheet, anim).map(f => f.delayMs), [100, 101, 102, 101, 100]);
});

test('the image sequence follows the playback order', () => {
  const { sheet, anim } = exportSheet('reverse');
  const seq = buildAnimationImageSequence(sheet, anim);
  assert.deepEqual(seq.map(s => s.name), ['walk_000', 'walk_001', 'walk_002']);
  assert.deepEqual([...seq[0].bitmap.data.slice(0, 4)], [0, 0, 255, 255]);
});

// ---- commands ----

test('setAnimationDirection sets, undoes and redoes; no-op records no history', () => {
  const { sheet, services } = setup();
  const a = addAnimation(sheet, 'a');
  assert.deepEqual(setAnimationDirection(services, sheet.id, a.id, 'forward'), { ok: true });
  assert.equal(services.history.canUndo(), false);
  assert.deepEqual(setAnimationDirection(services, sheet.id, a.id, 'pingpong'), { ok: true });
  assert.equal(a.direction, 'pingpong');
  services.history.undo();
  assert.equal(a.direction, 'forward');
  services.history.redo();
  assert.equal(a.direction, 'pingpong');
});

test('setAnimationDirection refuses an unknown direction or animation', () => {
  const { sheet, services } = setup();
  const a = addAnimation(sheet, 'a');
  assert.equal(setAnimationDirection(services, sheet.id, a.id, 'sideways').ok, false);
  assert.equal(setAnimationDirection(services, sheet.id, 'nope', 'reverse').ok, false);
  assert.equal(a.direction, 'forward');
  assert.equal(services.history.canUndo(), false);
});

test('setAnimationColor sets a colour (lowercased) or clears it with null; undo/redo', () => {
  const { sheet, services } = setup();
  const a = addAnimation(sheet, 'a');
  assert.deepEqual(setAnimationColor(services, sheet.id, a.id, '#00AAFF'), { ok: true });
  assert.equal(a.color, '#00aaff');
  assert.deepEqual(setAnimationColor(services, sheet.id, a.id, null), { ok: true });
  assert.equal(a.color, null);
  services.history.undo();
  assert.equal(a.color, '#00aaff');
  services.history.undo();
  assert.equal(a.color, null);
  services.history.redo();
  assert.equal(a.color, '#00aaff');
  setAnimationColor(services, sheet.id, a.id, '#00aaff');
  services.history.undo();
  assert.equal(a.color, null); // the repeated colour recorded nothing
});

test('setAnimationColor refuses anything but #rrggbb or null', () => {
  const { sheet, services } = setup();
  const a = addAnimation(sheet, 'a');
  for (const bad of ['red', '#fff', '#12345g', 12, undefined, '']) {
    assert.equal(setAnimationColor(services, sheet.id, a.id, bad).ok, false, String(bad));
  }
  assert.equal(a.color, null);
  assert.equal(services.history.canUndo(), false);
});

test('duplicateAnimation copies direction and colour', () => {
  const { sheet, services } = setup();
  const { animationId } = newAutoAnimation(services, sheet.id, { name: 'run', w: 8, h: 8 });
  const src = sheet.animations.find(a => a.id === animationId);
  src.direction = 'pingpong-reverse'; src.color = '#123456';
  const r = duplicateAnimation(services, sheet.id, animationId);
  const copy = sheet.animations.find(a => a.id === r.animationId);
  assert.deepEqual([copy.direction, copy.color], ['pingpong-reverse', '#123456']);
});
