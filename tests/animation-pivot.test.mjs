import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { pivotFromPoint, pivotCommand } from '../js/modes/animations/application/pivot.js';

function sheetWith(layout) {
  const sheet = createSheet(createProject('P'), { name: 'S', width: 16, height: 8, kind: 'sprite' });
  const f = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const anim = addAnimation(sheet, 'Run');
  Object.assign(anim, { layout, cell: layout === 'auto' ? { w: 8, h: 8 } : null, frames: [{ frameId: f.id, duration: null }] });
  return { sheet, f, anim };
}

test('pivotFromPoint rounds to half pixels and clamps to the frame', () => {
  const frame = { w: 8, h: 8 };
  assert.deepEqual(pivotFromPoint(frame, 3.3, 4.8), { pivotX: 3.5, pivotY: 5 });
  assert.deepEqual(pivotFromPoint(frame, -2, 11), { pivotX: 0, pivotY: 8 });
});

test('an auto frame sets its animation pivot; a manual frame sets its own', () => {
  const auto = sheetWith('auto');
  assert.deepEqual(pivotCommand(auto.sheet, auto.f, { pivotX: 2, pivotY: 3 }),
    { id: 'animations.setPivot', args: { sheetId: auto.sheet.id, animationId: auto.anim.id, pivotX: 2, pivotY: 3 } });
  const manual = sheetWith('manual');
  assert.deepEqual(pivotCommand(manual.sheet, manual.f, { pivotX: 2, pivotY: 3 }),
    { id: 'sprites.setFramePivot', args: { sheetId: manual.sheet.id, frameId: manual.f.id, pivotX: 2, pivotY: 3 } });
});
