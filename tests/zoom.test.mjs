import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_STEPS, stepZoom, snapFitZoom } from '../js/core/zoom.js';

test('table matches spec', () => {
  assert.deepEqual(ZOOM_STEPS, [0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]);
});

test('stepZoom advances one entry from every entry (no sticky levels)', () => {
  for (let i = 0; i < ZOOM_STEPS.length - 1; i++)
    assert.equal(stepZoom(ZOOM_STEPS[i], 1), ZOOM_STEPS[i + 1], `up from ${ZOOM_STEPS[i]}`);
  for (let i = 1; i < ZOOM_STEPS.length; i++)
    assert.equal(stepZoom(ZOOM_STEPS[i], -1), ZOOM_STEPS[i - 1], `down from ${ZOOM_STEPS[i]}`);
});

test('stepZoom clamps at ends and snaps off-table values first', () => {
  assert.equal(stepZoom(0.25, -1), 0.25);
  assert.equal(stepZoom(64, 1), 64);
  assert.equal(stepZoom(5, 1), 6);   // nearest to 5 is 4 or 6 -> 4 (tie: lower index? no: |5-4|=1,|5-6|=1 -> first found = 4) then +1 -> 6
  assert.equal(stepZoom(5, -1), 3);  // nearest 4, -1 -> 3
});

test('snapFitZoom takes largest entry <= fit, floors at 0.25', () => {
  assert.equal(snapFitZoom(5.7), 4);
  assert.equal(snapFitZoom(1), 1);
  assert.equal(snapFitZoom(0.4), 0.25);
  assert.equal(snapFitZoom(0.01), 0.25);
  assert.equal(snapFitZoom(100), 64);
});
