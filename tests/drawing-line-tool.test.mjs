// tests/drawing-line-tool.test.mjs
//
// The line tool drew with `drawLine`, which puts one stamp on every pixel of
// the Bresenham path and takes a single static mask grid. That silently
// discarded the brush's spacing, scatter and rotate jitter: a brush set to
// scatter 6 / spacing 8 dotted and scattered under the pencil and drew a
// solid, perfectly straight line under the line tool.
//
// The line tool is the caller brush-stroke.js's seeding machinery was built
// for (brush-stroke.js:3-12): shape tools restore and fully re-rasterize on
// every pointer move, so a scattered line has to be recomputed from the
// anchor each frame WITHOUT reshuffling. That is the prefix invariant pinned
// at the bottom of this file.
//
// These drive the real pointer path through bindDrawing rather than poking at
// internals -- the defect was in the tool, not in strokeStamps.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getPixel } from '../js/core/pixels.js';
import { normalizeBrush } from '../js/core/brushes.js';
import { drawingFixture } from './helpers/drawing-selection-fixtures.mjs';

const RED = [255, 0, 0, 255];

// A deterministic stand-in for Math.random, which is where newStrokeSeed()
// gets a stroke's seed. Every call returns a DIFFERENT value, so a mutation
// that re-seeds mid-stroke shows up as a reshuffle rather than being masked
// by a constant stub.
function withDeterministicSeeds(fn) {
  const original = Math.random;
  let s = 1;
  Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  try { return fn(); } finally { Math.random = original; }
}

function lineFixture(t, mask) {
  const f = drawingFixture(t, 'sheet');
  f.host.store.updateDrawingSettings({
    primary: RED,
    secondary: [0, 0, 255, 255],
    brush: normalizeBrush({ mask: { kind: 'square', size: 1, ...mask } }),
  });
  f.host.store.updateSession({ activeToolId: 'line' });
  return f;
}

// Every painted pixel, as "x,y" keys.
function painted(bmp) {
  const out = new Set();
  for (let y = 0; y < bmp.height; y++)
    for (let x = 0; x < bmp.width; x++)
      if (getPixel(bmp, x, y)[3] > 0) out.add(`${x},${y}`);
  return out;
}

test('a scattered brush does not draw a straight line under the line tool', (t) => {
  // The sheet is 20x8 and the line runs along y=4, so a scatter of 3 stays
  // entirely inside the target -- nothing here is an artefact of clamping.
  const f = lineFixture(t, { scatter: 3 });
  withDeterministicSeeds(() => {
    f.pointer('down', 2, 4);
    f.pointer('move', 17, 4);
    f.pointer('up', 17, 4);
  });
  const keys = [...painted(f.bitmap())];
  assert.ok(keys.length > 0, 'the line tool painted nothing at all');
  const offRow = keys.filter(k => k.split(',')[1] !== '4');
  assert.ok(offRow.length > 0,
    `every stamp landed on y=4: the brush's scatter was ignored (${keys.join(' ')})`);
});

test('the line tool honours brush spacing instead of stamping every pixel', (t) => {
  // 15 pixels of travel at spacing 5 is 4 stamps (travel 0, 5, 10, 15).
  // drawLine's own walk would put down all 16.
  const f = lineFixture(t, { spacing: 5 });
  withDeterministicSeeds(() => {
    f.pointer('down', 2, 4);
    f.pointer('move', 17, 4);
    f.pointer('up', 17, 4);
  });
  const keys = [...painted(f.bitmap())].sort();
  assert.deepEqual(keys, ['12,4', '17,4', '2,4', '7,4'].sort(),
    'spacing was ignored -- the line tool stamped every pixel of the path');
});

test('spacing 1 with no scatter still draws the plain solid line it always did', (t) => {
  const f = lineFixture(t, {});
  withDeterministicSeeds(() => {
    f.pointer('down', 2, 4);
    f.pointer('move', 8, 4);
    f.pointer('up', 8, 4);
  });
  const keys = [...painted(f.bitmap())].sort();
  assert.deepEqual(keys, ['2,4', '3,4', '4,4', '5,4', '6,4', '7,4', '8,4'].sort());
});

test('PREFIX INVARIANT: dragging further leaves the shorter line untouched', (t) => {
  // The tool restores and re-rasterizes the WHOLE line on every pointer move.
  // strokeStamps indexes a stamp's randomness by its ordinal along the path,
  // so the stamps of the shorter line must be a strict prefix of the longer
  // one's -- otherwise a scattered line reshuffles under the cursor as it is
  // dragged out. Every pixel the preview had painted must still be painted.
  const f = lineFixture(t, { scatter: 3, rotateJitter: true });
  withDeterministicSeeds(() => {
    f.pointer('down', 2, 4);
    f.pointer('move', 10, 4);
    const short = painted(f.bitmap());
    assert.ok(short.size > 0, 'the preview painted nothing');
    f.pointer('move', 17, 4);
    const long = painted(f.bitmap());
    for (const key of short) {
      assert.ok(long.has(key),
        `pixel ${key} was painted by the shorter preview and lost when the line grew`);
    }
    f.pointer('up', 17, 4);
  });
});

test('PREFIX INVARIANT: shrinking back reproduces the earlier preview exactly', (t) => {
  // The strongest form: drag out, drag back, and the bitmap must be byte
  // identical to the first time that endpoint was previewed.
  const f = lineFixture(t, { scatter: 3, rotateJitter: true });
  withDeterministicSeeds(() => {
    f.pointer('down', 2, 4);
    f.pointer('move', 10, 4);
    const first = [...painted(f.bitmap())].sort();
    f.pointer('move', 17, 4);
    f.pointer('move', 10, 4);
    assert.deepEqual([...painted(f.bitmap())].sort(), first,
      'the line reshuffled when it was dragged out and back');
    f.pointer('up', 10, 4);
  });
});
