import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPixel, getPixel } from '../js/core/pixels.js';
import { activeFloating, createFloat, commitFloatIfAny, cancelFloatIfAny, cutSelection, hasSelection, currentEditRegion } from '../js/components/canvas/float-session.js';
import { drawingFixture } from './helpers/drawing-selection-fixtures.mjs';

const red = [255, 0, 0, 255];
const blue = [0, 0, 255, 255];
const clear = [0, 0, 0, 0];

for (const viewKind of ['frame', 'tile']) {
  test(`${viewKind} navigation clears the old marquee before Delete`, t => {
    const f = drawingFixture(t, viewKind);
    setPixel(f.bitmap(), 1, 1, red);
    setPixel(f.bitmap(), 11, 1, blue);
    f.select();
    f.switchRegion(1);
    f.key('Delete');
    assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
    assert.deepEqual(getPixel(f.bitmap(), 11, 1), blue);
    assert.equal(hasSelection(), false);
    assert.equal(f.host.history.canUndo(), false);
    assert.equal(f.host.projects.dirty, false);
  });

  test(`${viewKind} navigation prevents cut from reusing an overlapping old marquee`, t => {
    const f = drawingFixture(t, viewKind);
    f.regions()[1].x = 1;
    setPixel(f.bitmap(), 1, 1, red);
    f.select();
    f.switchRegion(1);
    cutSelection();
    assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
    assert.equal(f.host.history.canUndo(), false);
  });

  test(`${viewKind} navigation lets move target the new region, not a stale marquee`, t => {
    const f = drawingFixture(t, viewKind);
    setPixel(f.bitmap(), 1, 1, red);
    setPixel(f.bitmap(), 11, 1, blue);
    f.select();
    f.switchRegion(1);
    f.host.store.updateSession({ activeToolId: 'move' });
    f.pointer('down', 11, 1);
    assert.deepEqual(activeFloating()?.srcRect, { x: 10, y: 0, w: 6, h: 6 });
    assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
    assert.deepEqual(getPixel(f.bitmap(), 11, 1), clear);
    f.host.history.undo();
    assert.deepEqual(getPixel(f.bitmap(), 11, 1), blue);
  });
}

for (const operation of ['Delete', 'cut', 'move']) {
  test(`sheet switch drops the old marquee before ${operation}`, t => {
    const f = drawingFixture(t, 'sheet');
    setPixel(f.bitmap(f.sheets[0]), 1, 1, red);
    setPixel(f.bitmap(f.sheets[1]), 1, 1, blue);
    f.select();
    f.switchSheet(1);
    if (operation === 'Delete') f.key('Delete');
    else if (operation === 'cut') cutSelection();
    else createFloat();
    assert.deepEqual(getPixel(f.bitmap(f.sheets[0]), 1, 1), red);
    if (operation === 'move') {
      assert.deepEqual(activeFloating()?.srcRect, { x: 0, y: 0, w: 20, h: 8 });
      f.host.history.undo();
    }
    assert.deepEqual(getPixel(f.bitmap(f.sheets[1]), 1, 1), blue);
    assert.equal(hasSelection(), false);
  });
}

for (const operation of ['Delete', 'cut', 'move']) {
  test(`${operation} confines an existing marquee after target geometry shrinks`, t => {
    const f = drawingFixture(t);
    setPixel(f.bitmap(), 1, 1, red);
    setPixel(f.bitmap(), 2, 1, blue);
    f.select(1, 1, 3, 1);
    Object.assign(f.regions()[0], { x: 2, w: 4 });
    if (operation === 'Delete') f.key('Delete');
    else if (operation === 'cut') cutSelection();
    else createFloat();
    assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
    assert.deepEqual(getPixel(f.bitmap(), 2, 1), clear);
    f.host.history.undo();
    assert.deepEqual(getPixel(f.bitmap(), 2, 1), blue);
    f.host.history.redo();
    assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
    assert.deepEqual(getPixel(f.bitmap(), 2, 1), clear);
  });
}

test('Delete with a marquee outside the current target does not edit pixels or history', t => {
  const f = drawingFixture(t);
  setPixel(f.bitmap(), 1, 1, red);
  f.select();
  Object.assign(f.regions()[0], { x: 10, w: 6 });
  f.key('Delete');
  assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
  assert.equal(f.host.history.canUndo(), false);
});

test('same-context store notifications preserve the marquee and normal delete undo', t => {
  const f = drawingFixture(t);
  setPixel(f.bitmap(), 1, 1, red);
  f.select();
  f.host.selections.patch({ frameId: f.regions()[0].id });
  f.host.projects.markDirty();
  f.host.store.notifyPixelsChanged();
  assert.deepEqual(currentEditRegion()?.region, { x: 1, y: 1, w: 2, h: 2 });
  f.key('Delete');
  assert.deepEqual(getPixel(f.bitmap(), 1, 1), clear);
  f.host.history.undo();
  assert.deepEqual(getPixel(f.bitmap(), 1, 1), red);
});

test('marquee move and float commit stay usable within one frame', t => {
  const f = drawingFixture(t);
  f.select(1, 1, 4, 4);
  f.pointer('down', 2, 2);
  f.pointer('up', 3, 2);
  assert.deepEqual(currentEditRegion()?.region, { x: 2, y: 1, w: 4, h: 4 });
  setPixel(f.bitmap(), 2, 1, red);
  createFloat();
  activeFloating().transform.ty = 1;
  commitFloatIfAny();
  assert.deepEqual(getPixel(f.bitmap(), 2, 1), clear);
  assert.deepEqual(getPixel(f.bitmap(), 2, 2), red);
  assert.deepEqual(currentEditRegion()?.region, { x: 2, y: 2, w: 4, h: 4 });
  f.host.history.undo();
  assert.equal(activeFloating()?.transform.ty, 1);
  f.host.history.undo();
  assert.deepEqual(getPixel(f.bitmap(), 2, 1), red);
  assert.deepEqual(currentEditRegion()?.region, { x: 2, y: 1, w: 4, h: 4 });
});

test('undoing a float after a sheet switch does not restore the old marquee into the new sheet', t => {
  const f = drawingFixture(t, 'sheet');
  setPixel(f.bitmap(f.sheets[0]), 1, 1, red);
  setPixel(f.bitmap(f.sheets[1]), 1, 1, blue);
  f.select();
  createFloat();
  f.switchSheet(1);
  f.host.history.undo();
  f.key('Delete');
  assert.deepEqual(getPixel(f.bitmap(f.sheets[0]), 1, 1), red);
  assert.deepEqual(getPixel(f.bitmap(f.sheets[1]), 1, 1), blue);
  assert.equal(hasSelection(), false);
});

for (const operation of ['commit', 'cancel']) {
  test(`${operation} after a frame change cannot put the old float marquee in the new frame`, t => {
    const f = drawingFixture(t);
    f.regions()[1].x = 1;
    setPixel(f.bitmap(), 1, 1, red);
    f.select();
    createFloat();
    if (operation === 'commit') activeFloating().transform.tx = 1;
    f.switchRegion(1);
    if (operation === 'commit') commitFloatIfAny();
    else cancelFloatIfAny();
    f.key('Delete');
    assert.deepEqual(getPixel(f.bitmap(), operation === 'commit' ? 2 : 1, 1), red);
    assert.equal(hasSelection(), false);
  });
}
