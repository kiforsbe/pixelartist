import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { createLayerNode, createGroupNode } from '../js/core/model.js';
import { state } from '../js/app/state.js';
import {
  insertStripFrame, splitStrip, resizeStripSegment, removeStripMember,
  mergeStripSegments, newStripFromFrame,
} from '../js/modes/sprites/application/commands/strip-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject({ width = 64, height = 64 } = {}) {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width, height,
    frames: [], animations: [],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

// Frames laid out left-to-right at 16x16 starting at x0, plus one intact
// strip animation ('an1') owning them in order.
function addStrip(sheet, ids, { breaks = [], x0 = 0 } = {}) {
  ids.forEach((id, index) => sheet.frames.push({ id, name: id, x: x0 + index * 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }));
  const anim = {
    id: 'an1', name: 'strip_0', loop: true, strip: true, breaks: breaks.slice(),
    frames: ids.map(id => ({ frameId: id, duration: 100 })), layerGroupId: null, baseDuration: 100,
  };
  sheet.animations.push(anim);
  return anim;
}

// Turns a floating strip animation into an "accepted" one: gives it its own
// layer group (with animationId set) attached to the sheet's layer tree, and
// points anim.layerGroupId at it -- this is what stripLayersOf() requires to
// return a non-null layer list, switching handlers from metadata-only to
// pixel-carrying.
function acceptStrip(sheet, anim) {
  const group = createGroupNode(anim.name, { animationId: anim.id });
  const layer = createLayerNode('Layer 1', sheet.width, sheet.height);
  group.children.push(layer);
  sheet.layerTree.children.push(group);
  anim.layerGroupId = group.id;
  return layer;
}

function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
  state.selectedFrameId = null;
  state.selectedAnimationId = null;
}

const frameIds = anim => anim.frames.map(entry => entry.frameId);

test('splitStrip adds a break, and re-splitting the same boundary is a no-op with no history entry', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c']);

  splitStrip(services, 'sheet1', 'an1', 1);
  assert.deepEqual(anim.breaks, [1]);
  assert.equal(state.dirty, true);

  splitStrip(services, 'sheet1', 'an1', 1);
  assert.deepEqual(anim.breaks, [1]);

  services.history.undo();
  assert.deepEqual(anim.breaks, []);
  assert.equal(services.history.canUndo(), false);
});

test('insertStripFrame inserts a blank frame at the boundary and shifts the tail right', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);

  insertStripFrame(services, 'sheet1', 'an1', 0, 1);

  assert.equal(sheet.frames.length, 3);
  const inserted = sheet.frames[2];
  assert.deepEqual({ x: inserted.x, y: inserted.y, w: inserted.w, h: inserted.h }, { x: 16, y: 0, w: 16, h: 16 });
  assert.deepEqual(frameIds(anim), ['a', inserted.id, 'b']);
  assert.equal(anim.frames[1].duration, 100);
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 32);
  assert.equal(state.selectedFrameId, inserted.id);

  services.history.undo();
  assert.equal(sheet.frames.length, 2);
  assert.deepEqual(frameIds(anim), ['a', 'b']);
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 16);
});

test('insertStripFrame on an accepted strip carries the tail pixels and undo restores them', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);
  const layer = acceptStrip(sheet, anim);
  setPixel(layer.bitmap, 17, 1, [255, 0, 0, 255]); // inside frame b (x:16-31)

  insertStripFrame(services, 'sheet1', 'an1', 0, 1);

  const inserted = sheet.frames[2];
  assert.equal(inserted.x, 16);
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 32);
  assert.deepEqual(getPixel(layer.bitmap, 33, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 33, 1), [0, 0, 0, 0]);
});

test('insertStripFrame refuses (no history entry) when one more frame width would overflow the sheet', () => {
  const project = makeProject({ width: 32 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);

  insertStripFrame(services, 'sheet1', 'an1', 0, 1);

  assert.equal(sheet.frames.length, 2);
  assert.deepEqual(frameIds(anim), ['a', 'b']);
  assert.equal(services.history.canUndo(), false);
});

test('resizeStripSegment grows by appending blank frames at the dragged end with the neighbour duration', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 4);

  assert.equal(sheet.frames.length, 4);
  assert.equal(anim.frames.length, 4);
  assert.deepEqual(sheet.frames.slice(2).map(f => f.x), [32, 48]);
  assert.deepEqual(anim.frames.map(e => e.duration), [100, 100, 100, 100]);

  services.history.undo();
  assert.equal(sheet.frames.length, 2);
  assert.equal(anim.frames.length, 2);
});

test('resizeStripSegment shrinks from the dragged end and undo restores the removed frames', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c', 'd']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 2);

  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b']);
  assert.deepEqual(frameIds(anim), ['a', 'b']);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(frameIds(anim), ['a', 'b', 'c', 'd']);
});

test('resizeStripSegment shrink on an accepted strip clears the removed frames\' pixels and undo restores them', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c', 'd']);
  const layer = acceptStrip(sheet, anim);
  setPixel(layer.bitmap, 33, 1, [255, 0, 0, 255]); // inside frame c (x:32-47)
  setPixel(layer.bitmap, 49, 1, [0, 255, 0, 255]); // inside frame d (x:48-63)

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 2);

  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b']);
  assert.deepEqual(getPixel(layer.bitmap, 33, 1), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(layer.bitmap, 49, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual(getPixel(layer.bitmap, 33, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 49, 1), [0, 255, 0, 255]);
});

test('resizeStripSegment grows on the left side, prepending frames in descending x with correct left-to-right entry order', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b'], { x0: 32 });

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'left', 4);

  assert.equal(sheet.frames.length, 4);
  assert.equal(anim.frames.length, 4);
  // Creation order in sheet.frames: original a, b, then new frames appended
  // as they're created, nearest-to-run first (x=16, then x=0).
  assert.deepEqual(sheet.frames.slice(2).map(f => f.x), [16, 0]);
  // Entry order in anim.frames must read left-to-right by x, not reversed.
  const byX = frameIds(anim).map(id => sheet.frames.find(f => f.id === id).x);
  assert.deepEqual(byX, [0, 16, 32, 48]);
  assert.deepEqual(anim.frames.map(e => e.duration), [100, 100, 100, 100]);

  services.history.undo();
  assert.equal(sheet.frames.length, 2);
  assert.equal(anim.frames.length, 2);
  assert.deepEqual(frameIds(anim), ['a', 'b']);
});

test('resizeStripSegment clamps grow past the sheet edge to what fits, rather than placing frames off-sheet', () => {
  const project = makeProject({ width: 32 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 5);

  assert.equal(sheet.frames.length, 2);
  assert.equal(anim.frames.length, 2);
  assert.equal(sheet.frames[1].x, 16);
  assert.ok(sheet.frames.every(f => f.x + f.w <= sheet.width));

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
});

test('resizeStripSegment grow with zero room left on the sheet is a no-op with no history entry', () => {
  const project = makeProject({ width: 16 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  addStrip(sheet, ['a']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 3);

  assert.equal(sheet.frames.length, 1);
  assert.equal(services.history.canUndo(), false);
});

test('resizeStripSegment with an unchanged count is a no-op with no history entry', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  addStrip(project.sheets[0], ['a', 'b']);

  resizeStripSegment(services, 'sheet1', 'an1', 0, 'right', 2);
  assert.equal(services.history.canUndo(), false);
});

test('removeStripMember deletes the frame and closes the gap by shifting the tail left', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c']);

  removeStripMember(services, 'sheet1', 'an1', 'b');

  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'c']);
  assert.deepEqual(frameIds(anim), ['a', 'c']);
  assert.equal(sheet.frames.find(f => f.id === 'c').x, 16);

  services.history.undo();
  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'b', 'c']);
  assert.deepEqual(frameIds(anim), ['a', 'b', 'c']);
  assert.equal(sheet.frames.find(f => f.id === 'c').x, 32);
});

test('removeStripMember on an accepted strip carries the tail pixels and undo restores them', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b', 'c']);
  const layer = acceptStrip(sheet, anim);
  setPixel(layer.bitmap, 33, 1, [255, 0, 0, 255]); // inside frame c (x:32-47)

  removeStripMember(services, 'sheet1', 'an1', 'b');

  assert.deepEqual(sheet.frames.map(f => f.id), ['a', 'c']);
  assert.equal(sheet.frames.find(f => f.id === 'c').x, 16);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 33, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual(getPixel(layer.bitmap, 33, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 17, 1), [0, 0, 0, 0]);
});

test('mergeStripSegments fuses two segments of one animation and repositions the dragged members', () => {
  const project = makeProject({ width: 128 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b'], { breaks: [1] });
  sheet.frames.find(f => f.id === 'b').x = 40;

  mergeStripSegments(services, 'sheet1', 'an1', 0, 'an1', 1, 'before', 24, 0);

  assert.deepEqual(frameIds(anim), ['a', 'b']);
  assert.deepEqual(anim.breaks, []);
  assert.equal(sheet.frames.find(f => f.id === 'a').x, 24);
  assert.equal(state.selectedAnimationId, 'an1');

  services.history.undo();
  assert.deepEqual(anim.breaks, [1]);
  assert.equal(sheet.frames.find(f => f.id === 'a').x, 0);
});

test("mergeStripSegments on an accepted strip carries the dragged member's pixels and undo restores them", () => {
  const project = makeProject({ width: 128 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  const anim = addStrip(sheet, ['a', 'b'], { breaks: [1] });
  sheet.frames.find(f => f.id === 'b').x = 40;
  const layer = acceptStrip(sheet, anim);
  setPixel(layer.bitmap, 1, 1, [255, 0, 0, 255]); // inside frame a (x:0-15)

  mergeStripSegments(services, 'sheet1', 'an1', 0, 'an1', 1, 'before', 24, 0);

  assert.equal(sheet.frames.find(f => f.id === 'a').x, 24);
  assert.deepEqual(getPixel(layer.bitmap, 25, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [0, 0, 0, 0]);

  services.history.undo();
  assert.deepEqual(getPixel(layer.bitmap, 1, 1), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(layer.bitmap, 25, 1), [0, 0, 0, 0]);
});

test('newStripFromFrame promotes a standalone frame into a strip and renames it', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'right', 3);

  assert.equal(sheet.animations.length, 1);
  const anim = sheet.animations[0];
  assert.equal(anim.name, 'strip_0');
  assert.equal(anim.strip, true);
  assert.equal(sheet.frames.length, 3);
  assert.deepEqual(sheet.frames.map(f => f.name), ['strip_0_0', 'strip_0_1', 'strip_0_2']);
  assert.deepEqual(sheet.frames.map(f => f.x), [0, 16, 32]);
  assert.deepEqual(frameIds(anim), ['f1', sheet.frames[1].id, sheet.frames[2].id]);
  assert.equal(state.selectedAnimationId, anim.id);

  services.history.undo();
  assert.equal(sheet.animations.length, 0);
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].name, 'frame_0');
});

test('newStripFromFrame promotes a standalone frame growing to the left, in ascending x order with the original frame last', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 32, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'left', 3);

  assert.equal(sheet.animations.length, 1);
  const anim = sheet.animations[0];
  assert.equal(anim.name, 'strip_0');
  assert.equal(sheet.frames.length, 3);
  // Creation order in sheet.frames: original f1 unchanged, then new frames
  // appended as they're created, nearest-to-original first (x=16, then x=0).
  assert.deepEqual(sheet.frames.map(f => f.x), [32, 16, 0]);
  // Entry order must read ascending left-to-right by x, and end with the
  // original promoted frame (not start with it -- new frames were unshifted
  // ahead of it, one per iteration).
  const ids = frameIds(anim);
  const byX = ids.map(id => sheet.frames.find(f => f.id === id).x);
  assert.deepEqual(byX, [0, 16, 32]);
  assert.equal(ids[ids.length - 1], 'f1');
  assert.equal(state.selectedAnimationId, anim.id);

  services.history.undo();
  assert.equal(sheet.animations.length, 0);
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].name, 'frame_0');
});

test('newStripFromFrame clamps grow past the sheet edge to what fits, rather than placing frames off-sheet', () => {
  const project = makeProject({ width: 32 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'left', 5);

  assert.equal(sheet.frames.length, 2);
  const anim = sheet.animations[0];
  assert.equal(anim.frames.length, 2);
  assert.ok(sheet.frames.every(f => f.x >= 0));

  services.history.undo();
  assert.equal(sheet.frames.length, 1);
});

test('newStripFromFrame grow with zero room left on the sheet is a no-op with no history entry', () => {
  const project = makeProject({ width: 16 });
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
  sheet.frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'right', 3);

  assert.equal(sheet.animations.length, 0);
  assert.equal(services.history.canUndo(), false);
});

test('newStripFromFrame is a no-op with no history entry when the count would add nothing', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  project.sheets[0].frames.push({ id: 'f1', name: 'frame_0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 });

  newStripFromFrame(services, 'sheet1', 'f1', 'right', 1);

  assert.equal(project.sheets[0].animations.length, 0);
  assert.equal(services.history.canUndo(), false);
});
