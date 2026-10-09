// Which tools show the brush picker and which show the Size field.
//
// These were one gate (`BRUSH_TOOLS.has(id)`) driving both rows, so the
// picker -- the only way to choose a brush while drawing -- was hidden on
// five tools that honour brushes: the three shape tools stamp or ink with
// one, and both floods run the brush's ink.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brushControlsFor, BRUSH_TOOLS, SHAPE_TOOLS, FLOOD_TOOLS, TOOLS,
} from '../js/components/tool-palette.js';

const picker = id => brushControlsFor(id).picker;
const size = id => brushControlsFor(id).size;

test('the picker is shown for every tool whose output goes through a brush', () => {
  for (const id of [...BRUSH_TOOLS, ...SHAPE_TOOLS, ...FLOOD_TOOLS]) {
    assert.equal(picker(id), true, `${id} should offer the brush picker`);
  }
  // Five of these are tools the picker used to be hidden on entirely.
  assert.equal([...SHAPE_TOOLS, ...FLOOD_TOOLS].length, 5);
});

test('the Size field is shown only where a mask is actually stamped', () => {
  for (const id of [...BRUSH_TOOLS, ...SHAPE_TOOLS]) {
    assert.equal(size(id), true, `${id} stamps a mask and should offer Size`);
  }
  // The split that the single old gate could not express: a flood fills a
  // region the algorithm computed, so there is no stamp to give a size to --
  // but its ink is the brush's, so the picker above stays live.
  for (const id of FLOOD_TOOLS) {
    assert.equal(picker(id), true, `${id} should offer the picker`);
    assert.equal(size(id), false, `${id} has no mask and must not offer Size`);
  }
});

test('tools that touch no brush offer neither control', () => {
  // The control for the whole file: a gate that returned true for everything
  // would pass both tests above.
  for (const id of ['select', 'move', 'eyedropper']) {
    assert.equal(picker(id), false, `${id} should not offer the picker`);
    assert.equal(size(id), false, `${id} should not offer Size`);
  }
  assert.equal(picker('no-such-tool'), false);
});

test('Size never appears without the picker, across the real tool list', () => {
  // Swept over TOOLS rather than a hand-picked sample so a tool added later
  // is covered without anyone remembering to add it here.
  for (const t of TOOLS) {
    const c = brushControlsFor(t.id);
    // Size without a picker would mean "size the mask of a brush you cannot
    // choose" -- an impossible state, and the inverse of the bug being fixed.
    if (c.size) assert.equal(c.picker, true, `${t.id} offers Size but not the picker`);
  }
  // Anti-vacuity: the sweep above is only meaningful if TOOLS actually
  // contains tools of each classification, so an implication over an empty
  // or uniformly-false set cannot be what makes it pass.
  const verdicts = TOOLS.map(t => brushControlsFor(t.id));
  assert.ok(verdicts.some(c => c.size && c.picker), 'no stamping tool in TOOLS');
  assert.ok(verdicts.some(c => !c.size && c.picker), 'no ink-only tool in TOOLS');
  assert.ok(verdicts.some(c => !c.size && !c.picker), 'no brush-free tool in TOOLS');
});
