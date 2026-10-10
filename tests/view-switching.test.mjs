import test from 'node:test';
import assert from 'node:assert/strict';
import { applyViewControllers } from '../js/features/workbench/view-switching.js';

function controller() { return { shown: false, show() { this.shown = true; }, hide() { this.shown = false; } }; }

test('only the active view controller is shown and the sheet canvas hides under it', () => {
  const frame = controller(), anim = controller(), sheetCanvas = { style: {} };
  const controllers = new Map([['sprites.sheet', { view: {} }], ['sprites.frame', frame], ['animations.canvas', anim]]);
  applyViewControllers('animations.canvas', controllers, sheetCanvas);
  assert.equal(anim.shown, true); assert.equal(frame.shown, false); assert.equal(sheetCanvas.style.display, 'none');
  applyViewControllers('sprites.sheet', controllers, sheetCanvas);
  assert.equal(anim.shown, false); assert.equal(sheetCanvas.style.display, '');
});
