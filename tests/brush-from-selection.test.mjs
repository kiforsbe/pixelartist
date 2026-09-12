// Task 15b: Make Brush From Selection.
//
// brushFromSelection(bitmap, rect, name) itself (js/core/brush-io.js, moved
// there from brush-manager.js in fix round 1 -- it has no DOM dependency and
// belongs beside bitmapToBrush) is deliberately opinion-free about WHICH
// bitmap it is handed -- it just crops `rect` out of whatever it's given.
// The decision that matters lives at the call site (the `brush.fromSelection`
// action, in brush-manager.js): it passes flattenSheet(sheet), the COMPOSITE
// of every visible layer, not activeLayer().bitmap. That call site needs a
// live host/DOM (activeSheet, commitFloatIfAny, lib.add) and is exercised by
// manual verification instead (see task-15b-report.md); what's unit-tested
// here is the crop itself, and -- the part this branch has gotten wrong
// eleven times -- proof that capturing the COMPOSITE actually differs from
// capturing one layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenSheet, createGroupNode } from '../js/core/model.js';
import { createBitmap, setPixel } from '../js/core/pixels.js';
import { brushFromSelection } from '../js/core/brush-io.js';

function bit(brush, x, y) {
  const { width } = brush.mask.bitmap;
  return brush.mask.bitmap.bits[y * width + x];
}

test('brushFromSelection crops the given rect, translating to local coordinates', () => {
  const bmp = createBitmap(6, 6);
  setPixel(bmp, 3, 3, [10, 20, 30, 255]); // inside rect {x:2,y:2,w:3,h:3} at local (1,1)
  setPixel(bmp, 0, 0, [1, 2, 3, 255]);    // outside the rect entirely
  const brush = brushFromSelection(bmp, { x: 2, y: 2, w: 3, h: 3 }, 'Cropped');
  assert.equal(brush.mask.bitmap.width, 3);
  assert.equal(brush.mask.bitmap.height, 3);
  assert.equal(bit(brush, 1, 1), 1, 'the in-rect pixel must be captured at its LOCAL position');
  assert.equal([...brush.mask.bitmap.bits].filter(Boolean).length, 1,
    'the out-of-rect pixel must not leak into the crop');
});

// --- the composite-vs-active-layer trap -----------------------------------
//
// Absent-mechanism baseline: if the call site captured activeLayer().bitmap
// instead of flattenSheet(sheet), this test's assertion on the LOWER layer's
// pixel (1,1) would read 0 -- that pixel exists only on l1, which an
// active-layer-only capture (of l2, the "active" one) never sees. A fixture
// where the two layers happened to look the same could not tell "composite"
// from "active layer" apart; this one deliberately makes them differ, with
// the lower layer holding a pixel the upper layer does not.
test('capturing the sheet COMPOSITE sees a lower layer\'s pixel that the active layer alone would miss', () => {
  const l1 = { id: 'l1', type: 'layer', visible: true, opacity: 1, bitmap: createBitmap(4, 4) };
  const l2 = { id: 'l2', type: 'layer', visible: true, opacity: 1, bitmap: createBitmap(4, 4) };
  setPixel(l1.bitmap, 1, 1, [255, 0, 0, 255]); // ONLY on the lower (non-active) layer
  setPixel(l2.bitmap, 2, 2, [0, 255, 0, 255]); // ONLY on the "active" (upper) layer
  const root = createGroupNode('root');
  root.children.push(l1, l2);
  const sheet = { id: 'sh', width: 4, height: 4, layerTree: root };

  const composite = flattenSheet(sheet);
  const fromComposite = brushFromSelection(composite, { x: 0, y: 0, w: 4, h: 4 }, 'Selection');
  assert.equal(bit(fromComposite, 1, 1), 1,
    'a COMPOSITE capture must see the lower layer\'s own pixel');
  assert.equal(bit(fromComposite, 2, 2), 1,
    'a COMPOSITE capture must also still see the active layer\'s pixel');

  // Contrast case, proving the two capture sources actually disagree here
  // (not just that the composite happens to contain everything): capturing
  // the "active" layer (l2) alone misses the lower layer's pixel entirely.
  const fromActiveLayerOnly = brushFromSelection(l2.bitmap, { x: 0, y: 0, w: 4, h: 4 }, 'ActiveOnly');
  assert.equal(bit(fromActiveLayerOnly, 1, 1), 0,
    'sanity: an active-layer-only capture must NOT see the lower layer\'s pixel -- ' +
    'this is the exact difference the composite decision exists to avoid');
});
