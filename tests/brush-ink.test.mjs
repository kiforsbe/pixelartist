// tests/brush-ink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { normalizePalette } from '../js/core/palettes.js';
import { normalizeBrush } from '../js/core/brushes.js';
import { makeInk, applyPaletteClosure } from '../js/core/brush-ink.js';

const RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255], CLEAR = [0, 0, 0, 0];

function greyPalette() {
  const colors = [[20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200]].map(c => [...c, 255]);
  return normalizePalette({ id: 'p', name: 'P', indexed: true, colors, empty: colors.map(() => false) });
}

function ctx(extra = {}) {
  return { primary: RED, secondary: BLUE, palette: null, seed: 1, alt: false, pressure: 1, ...extra };
}

test('solid ink writes the primary color', () => {
  const bmp = createBitmap(4, 4);
  makeInk(normalizeBrush({}), ctx()).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED);
});

test('solid ink at opacity 0 writes nothing', () => {
  const bmp = createBitmap(4, 4);
  makeInk(normalizeBrush({ ink: { opacity: 0 } }), ctx()).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], CLEAR);
});

test('opacity 50 writes about half the pixels of a filled area', () => {
  const bmp = createBitmap(8, 8);
  const ink = makeInk(normalizeBrush({ ink: { opacity: 50 } }), ctx());
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
  let n = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (getPixel(bmp, x, y)[3] > 0) n++;
  assert.equal(n, 32);
});

test('lock-alpha ink leaves transparent pixels untouched', () => {
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, BLUE);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'lock-alpha' } }), ctx());
  ink.write(bmp, 1, 1);
  ink.write(bmp, 2, 2);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED, 'existing pixel repainted');
  assert.deepEqual([...getPixel(bmp, 2, 2)], CLEAR, 'transparent pixel untouched');
});

test('replace ink writes only over its target color', () => {
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, BLUE);
  setPixel(bmp, 2, 2, [9, 9, 9, 255]);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'replace', replaceColor: BLUE } }), ctx());
  ink.write(bmp, 1, 1);
  ink.write(bmp, 2, 2);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED);
  assert.deepEqual([...getPixel(bmp, 2, 2)], [9, 9, 9, 255]);
});

test('dither ink writes primary and secondary, never a blend', () => {
  const bmp = createBitmap(8, 8);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'dither', pattern: 'checker' } }), ctx());
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = [...getPixel(bmp, x, y)];
    assert.ok(
      p.every((v, i) => v === RED[i]) || p.every((v, i) => v === BLUE[i]),
      `pixel ${x},${y} is neither primary nor secondary: ${p}`,
    );
  }
});

test('ramp-shade steps the destination pixel one entry toward light', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [70, 70, 70, 255]);
  makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [130, 130, 130, 255]);
});

test('ramp-shade with alt steps toward dark', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [130, 130, 130, 255]);
  makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette, alt: true })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [70, 70, 70, 255]);
});

test('ramp-shade steps a pixel ONCE per stroke however many times it is written', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [20, 20, 20, 255]);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette }));
  for (let i = 0; i < 10; i++) ink.write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [70, 70, 70, 255], 'ran up the ramp');
});

test('ramp-shade leaves a color that belongs to no ramp alone', () => {
  const palette = greyPalette();
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [1, 2, 3, 255]);
  makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [1, 2, 3, 255]);
});

test('applyPaletteClosure snaps to a palette entry for an indexed palette', () => {
  const palette = greyPalette();
  assert.deepEqual(applyPaletteClosure(palette, [75, 75, 75, 255]), [70, 70, 70, 255]);
});

test('applyPaletteClosure leaves a non-indexed palette alone', () => {
  const palette = greyPalette();
  palette.indexed = false;
  assert.deepEqual(applyPaletteClosure(palette, [75, 75, 75, 255]), [75, 75, 75, 255]);
});

test('PALETTE CLOSURE INVARIANT: no ink ever writes a color outside an indexed palette', () => {
  const palette = greyPalette();
  const entries = palette.colors.map(c => `${c[0]},${c[1]},${c[2]}`);
  // 'replace' and 'stamp' are included deliberately: this test is the safety net
  // for off-palette writes, and 'replace' was once the one kind it never swept.
  // replaceColor must match real canvas content or the sweep passes vacuously.
  for (const kind of ['solid', 'ramp-shade', 'dither', 'lock-alpha', 'replace', 'stamp']) {
    for (const opacity of [100, 75, 50, 25]) {
      const bmp = createBitmap(8, 8);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        setPixel(bmp, x, y, palette.colors[(x + y) % palette.colors.length]);
      }
      const brush = normalizeBrush({ ink: { kind, opacity, replaceColor: palette.colors[0] } });
      const ink = makeInk(brush, ctx({ palette, primary: [77, 77, 77, 255], secondary: [199, 199, 199, 255] }));
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const p = getPixel(bmp, x, y);
        if (p[3] === 0) continue;
        assert.ok(entries.includes(`${p[0]},${p[1]},${p[2]}`),
          `${kind}@${opacity} wrote off-palette ${p} at ${x},${y}`);
      }
    }
  }
});

// --- jitter is anchored to position, not to call order ---------------------
//
// tests/brush-determinism.test.mjs asserts this same invariant for the MASK
// phase (strokeStamps). These are its counterparts for the INK phase, which
// went untested and was where the invariant actually broke.

const BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];

function jitterBrush(extra = {}) {
  return normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'ramp-shade', opacity: 100, jitter: 2, ...extra } });
}

// Fill a w*h region of a fresh 10x10 bitmap with one mid palette entry, then
// ink it in the given visit order with a freshly built ink.
function rasterize(palette, seed, w, h, order = 'row') {
  const bmp = createBitmap(10, 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) setPixel(bmp, x, y, palette.colors[1]);
  const ink = makeInk(jitterBrush(), ctx({ palette, seed, primary: palette.colors[3] }));
  if (order === 'col') {
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) ink.write(bmp, x, y);
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) ink.write(bmp, x, y);
  }
  return bmp;
}

const dump = (bmp, w, h) => {
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(getPixel(bmp, x, y).join(','));
  return out;
};

test('jitter does not depend on the order pixels are visited', () => {
  const palette = greyPalette();
  assert.deepEqual(dump(rasterize(palette, 4242, 4, 4, 'row'), 4, 4),
    dump(rasterize(palette, 4242, 4, 4, 'col'), 4, 4));
});

test('PREFIX INVARIANT: re-rasterizing a growing shape leaves the shared prefix untouched', () => {
  // What a shape tool does: restore, rebuild the ink with the SAME seed, and
  // fully re-rasterize on every pointer move while the rect is still growing.
  const palette = greyPalette();
  const f3 = rasterize(palette, 4242, 3, 3);
  const f4 = rasterize(palette, 4242, 4, 4);
  const f5 = rasterize(palette, 4242, 5, 5);
  // Every shared pixel, not a sample: the original bug spared 3 of 9 by chance.
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    const a = getPixel(f3, x, y), b = getPixel(f4, x, y), c = getPixel(f5, x, y);
    assert.deepEqual(a, b, `pixel ${x},${y} changed between the 3x3 and 4x4 frames`);
    assert.deepEqual(b, c, `pixel ${x},${y} changed between the 4x4 and 5x5 frames`);
  }
});

test('jitter is seeded: one seed reproduces, a different seed diverges', () => {
  const palette = greyPalette();
  assert.deepEqual(dump(rasterize(palette, 77, 5, 5), 5, 5), dump(rasterize(palette, 77, 5, 5), 5, 5));
  assert.notDeepEqual(dump(rasterize(palette, 77, 5, 5), 5, 5), dump(rasterize(palette, 78, 5, 5), 5, 5));
});

// --- trueAlpha really blends ----------------------------------------------

function alphaFill(opacity, trueAlpha, palette = null) {
  const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'solid', opacity, trueAlpha } });
  const bmp = createBitmap(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setPixel(bmp, x, y, WHITE);
  const ink = makeInk(brush, ctx({ palette, primary: BLACK, secondary: WHITE }));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
  return bmp;
}

test('trueAlpha blends instead of writing full strength', () => {
  const bmp = alphaFill(50, true);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = getPixel(bmp, x, y);
    assert.notDeepEqual(p, BLACK, `pixel ${x},${y} painted full strength under trueAlpha`);
    assert.notDeepEqual(p, WHITE, `pixel ${x},${y} was left unpainted under trueAlpha`);
  }
});

test('trueAlpha honors opacity: lower opacity lands nearer the destination', () => {
  const low = getPixel(alphaFill(25, true), 0, 0)[0];
  const high = getPixel(alphaFill(75, true), 0, 0)[0];
  // Painting black over white, so a higher channel value means closer to white.
  assert.ok(low > high, `opacity 25 gave ${low}, opacity 75 gave ${high}`);
});

test('trueAlpha still snaps to the palette on an indexed palette', () => {
  const palette = greyPalette();
  const entries = palette.colors.map(c => `${c[0]},${c[1]},${c[2]}`);
  for (const opacity of [25, 50, 75]) {
    const bmp = alphaFill(opacity, true, palette);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const p = getPixel(bmp, x, y);
      assert.ok(entries.includes(`${p[0]},${p[1]},${p[2]}`),
        `trueAlpha@${opacity} wrote off-palette ${p}`);
    }
  }
});

test('the default (trueAlpha off) path still paints by density at full strength', () => {
  const bmp = alphaFill(50, false);
  let painted = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = getPixel(bmp, x, y);
    if (p[0] !== 255) { painted++; assert.deepEqual(p, BLACK, 'density mode must never blend'); }
  }
  assert.ok(painted > 16 && painted < 48, `expected roughly half of 64 painted, got ${painted}`);
});

// --- graceful degradation --------------------------------------------------

test('replace never touches a transparent pixel, even when replaceColor is black', () => {
  // createBitmap zero-fills, so every blank pixel is [0,0,0,0] -- RGB (0,0,0).
  // An RGB-only match against black would repaint the whole empty canvas.
  const bmp = createBitmap(8, 8);
  for (let i = 0; i < 4; i++) setPixel(bmp, i, 0, BLACK);
  const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'replace', opacity: 100, replaceColor: BLACK } });
  const ink = makeInk(brush, ctx({ primary: RED }));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
  let replaced = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = getPixel(bmp, x, y);
    if (y === 0 && x < 4) { assert.deepEqual(p, RED); replaced++; }
    else assert.deepEqual(p, CLEAR, `blank pixel ${x},${y} was flooded`);
  }
  assert.equal(replaced, 4);
});

test('dither falls back to primary when no secondary is set', () => {
  const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'dither', opacity: 100, pattern: 'checker' } });
  const bmp = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, WHITE);
  const ink = makeInk(brush, ctx({ primary: RED, secondary: undefined }));
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ink.write(bmp, x, y);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.deepEqual(getPixel(bmp, x, y), RED, `pixel ${x},${y} should have fallen back to primary`);
  }
});
