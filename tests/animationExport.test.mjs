import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation, sheetLayers } from '../js/core/model.js';
import { setPixel } from '../js/core/pixels.js';
import {
  selectAnimations, buildAnimationSpritesheet, buildAnimationImageSequence, buildAnimationGifFrames,
} from '../js/app/animationExport.js';

function makeSheetWithTwoFrameAnim() {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Hero', width: 8, height: 4, kind: 'sprite' });
  const layer = sheetLayers(sheet)[0];
  // frame 0 = (0,0,2,2) solid red; frame 1 = (2,0,2,2) solid green
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) setPixel(layer.bitmap, x, y, [255, 0, 0, 255]);
  for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) setPixel(layer.bitmap, x, y, [0, 255, 0, 255]);
  const f0 = addFrame(sheet, { name: 'walk_0', x: 0, y: 0, w: 2, h: 2 });
  const f1 = addFrame(sheet, { name: 'walk_1', x: 2, y: 0, w: 2, h: 2 });
  const anim = addAnimation(sheet, 'walk');
  anim.frames.push({ frameId: f0.id, duration: 80 });
  anim.frames.push({ frameId: f1.id, duration: 120 });
  return { sheet, anim };
}

test('selectAnimations: by id, or every animation when animId is null', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  assert.deepEqual(selectAnimations(sheet, anim.id), [anim]);
  assert.deepEqual(selectAnimations(sheet, null), sheet.animations);
});

test('buildAnimationSpritesheet: frames packed left-to-right, correct pixels/offsets/durations', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  const { bitmap, json } = buildAnimationSpritesheet(sheet, anim);
  assert.equal(bitmap.width, 4);
  assert.equal(bitmap.height, 2);
  // frame 0 (red) at x=0..1, frame 1 (green) at x=2..3
  assert.deepEqual([...bitmap.data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...bitmap.data.slice(8, 12)], [0, 255, 0, 255]);
  assert.deepEqual(json.frames.map(f => [f.name, f.x, f.w]), [['walk_0', 0, 2], ['walk_1', 2, 2]]);
  assert.deepEqual(json.animations[0].frames.map(f => f.duration), [80, 120]);
});

test('buildAnimationImageSequence: one named entry per frame, in order', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  const seq = buildAnimationImageSequence(sheet, anim);
  assert.deepEqual(seq.map(s => s.name), ['walk_000', 'walk_001']);
  assert.equal(seq[0].bitmap.width, 2);
});

test('buildAnimationGifFrames: pixels/dimensions/delay ready for encodeGif', () => {
  const { sheet, anim } = makeSheetWithTwoFrameAnim();
  const frames = buildAnimationGifFrames(sheet, anim);
  assert.deepEqual(frames.map(f => f.delayMs), [80, 120]);
  assert.equal(frames[0].width, 2);
  assert.deepEqual([...frames[0].pixels.slice(0, 4)], [255, 0, 0, 255]);
});
