// tests/frame-chrome-geometry.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hitHandle, chromeGeometry, hitGrip, hitChrome, standaloneGripGeometry,
  selectedSegment, findSnap, CALLOUT_OFF,
} from '../js/modes/sprites/application/frame-chrome-geometry.js';

// Identity projector: screen space === image space, so expected coordinates
// stay readable. Presentation passes (x, y) => view.imageToScreen(x, y).
const identity = (x, y) => ({ x, y });

test('hitHandle returns the corner handle under the pointer, else null', () => {
  const frame = { x: 10, y: 20, w: 30, h: 40 };
  assert.equal(hitHandle(identity, frame, 10, 20), 'nw');
  assert.equal(hitHandle(identity, frame, 40, 60), 'se');
  assert.equal(hitHandle(identity, frame, 43, 63), 'se'); // within 6px slop
  assert.equal(hitHandle(identity, frame, 25, 40), null);
  assert.equal(hitHandle(identity, null, 10, 20), null);
});

test('chromeGeometry emits insert call-outs above every boundary and split call-outs between members', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 16, y: 0, w: 16, h: 16 },
  ];
  const sheet = { width: 64, height: 64, frames };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [] };
  const run = { start: 0, end: 2, index: 0 };
  const g = chromeGeometry(identity, sheet, anim, run);
  assert.deepEqual(g.bbox, { x: 0, y: 0, w: 32, h: 16 });
  assert.equal(g.fw, 16);
  assert.deepEqual(g.inserts.map(c => c.k), [0, 1, 2]);
  assert.equal(g.inserts[0].cy, 0 - CALLOUT_OFF);
  assert.deepEqual(g.splits.map(c => c.k), [1]);
  assert.deepEqual(g.grips.map(gr => gr.side), ['left', 'right']);
});

test('chromeGeometry suppresses inserts when one more frame width would overflow the sheet', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 16, y: 0, w: 16, h: 16 },
  ];
  const sheet = { width: 32, height: 64, frames };
  const anim = { frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [] };
  const g = chromeGeometry(identity, sheet, anim, { start: 0, end: 2, index: 0 });
  assert.deepEqual(g.inserts, []);
  assert.deepEqual(g.splits.map(c => c.k), [1]);
});

test('chromeGeometry returns null for an empty segment', () => {
  const sheet = { width: 64, height: 64, frames: [] };
  const anim = { frames: [{ frameId: 'gone' }], breaks: [] };
  assert.equal(chromeGeometry(identity, sheet, anim, { start: 0, end: 1, index: 0 }), null);
});

test('hitGrip and hitChrome prefer call-outs over grips', () => {
  const grips = [
    { side: 'left', x: 0, y: 0, w: 6, h: 16 },
    { side: 'right', x: 30, y: 0, w: 6, h: 16 },
  ];
  assert.deepEqual(hitGrip(grips, 1, 8), { type: 'grip', side: 'left' });
  assert.equal(hitGrip(grips, 15, 8), null);
  const geometry = { inserts: [{ k: 1, cx: 16, cy: -16 }], splits: [{ k: 1, cx: 16, cy: 32 }], grips };
  assert.deepEqual(hitChrome(geometry, 16, -16), { type: 'insert', k: 1 });
  assert.deepEqual(hitChrome(geometry, 16, 32), { type: 'split', k: 1 });
  assert.deepEqual(hitChrome(geometry, 31, 8), { type: 'grip', side: 'right' });
  assert.equal(hitChrome(geometry, 200, 200), null);
});

test('standaloneGripGeometry gives a bare frame the same edge grips a strip has', () => {
  const g = standaloneGripGeometry(identity, { x: 8, y: 4, w: 16, h: 16 });
  assert.deepEqual(g.bbox, { x: 8, y: 4, w: 16, h: 16 });
  assert.equal(g.fw, 16);
  assert.equal(g.fh, 16);
  assert.deepEqual(g.grips, [
    { side: 'left', x: 5, y: 4, w: 6, h: 16 },
    { side: 'right', x: 21, y: 4, w: 6, h: 16 },
  ]);
});

test('selectedSegment resolves the intact-strip segment owning the selected frame', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 16, y: 0, w: 16, h: 16 },
  ];
  const strip = { id: 'an1', strip: true, frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [1] };
  const sheet = { width: 64, height: 64, frames, animations: [strip] };
  assert.deepEqual(selectedSegment(sheet, 'b'), { anim: strip, run: { start: 1, end: 2, index: 1 } });
  assert.equal(selectedSegment(sheet, 'missing'), null);
  const loose = { width: 64, height: 64, frames, animations: [{ id: 'an2', strip: false, frames: [{ frameId: 'a' }] }] };
  assert.equal(selectedSegment(loose, 'a'), null);
});

test('findSnap offers an end-to-end join to another segment of the same animation only', () => {
  const frames = [
    { id: 'a', x: 0, y: 0, w: 16, h: 16 },
    { id: 'b', x: 40, y: 0, w: 16, h: 16 },
  ];
  const anim = { id: 'an1', strip: true, frames: [{ frameId: 'a' }, { frameId: 'b' }], breaks: [1] };
  const sheet = { width: 128, height: 64, frames, animations: [anim] };
  const drag = {
    anim, run: { start: 0, end: 1, index: 0 }, members: [frames[0]],
    bbox: { x: 0, y: 0, w: 16, h: 16 }, delta: { dx: 23, dy: 0 },
  };
  const snap = findSnap(sheet, drag, 1);
  assert.equal(snap.side, 'before');
  assert.equal(snap.dx, 24);
  assert.equal(snap.dy, 0);
  assert.equal(snap.run.index, 1);
  // Too far away for the 10px/zoom tolerance
  assert.equal(findSnap(sheet, { ...drag, delta: { dx: 0, dy: 0 } }, 1), null);
});
