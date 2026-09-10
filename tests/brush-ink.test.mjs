// tests/brush-ink.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitmap, setPixel, getPixel, drawRect, drawEllipse, floodFill, softFloodFill } from '../js/core/pixels.js';
import { normalizePalette } from '../js/core/palettes.js';
import { normalizeBrush, INK_KINDS } from '../js/core/brushes.js';
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

test('lock-alpha preserves a pixel\'s alpha exactly, blending or not', () => {
  // The whole point of lock-alpha is painting colour without touching alpha.
  // Blending recomputes the alpha channel, so it must be pinned back or soft
  // edges erode: a 128-alpha pixel came back as 192 before this was guarded.
  for (const trueAlpha of [false, true]) {
    for (const opacity of [100, 50]) {
      for (const destAlpha of [255, 128, 64]) {
        const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'lock-alpha', opacity, trueAlpha } });
        const bmp = createBitmap(2, 2);
        setPixel(bmp, 0, 0, [255, 255, 255, destAlpha]);
        const ink = makeInk(brush, ctx({ primary: BLACK }));
        ink.write(bmp, 0, 0);
        assert.equal(getPixel(bmp, 0, 0)[3], destAlpha,
          `trueAlpha=${trueAlpha} opacity=${opacity} changed alpha ${destAlpha}`);
      }
    }
  }
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

// ===========================================================================
// Fix round 1
// ===========================================================================

// --- 1. the caller's colour reaches the ink --------------------------------
//
// pixels.js `put` used to drop `rgba` the moment an ink was present, so every
// primitive that varies colour across its own geometry collapsed to the ink's
// primary. drawRect/drawEllipse do exactly that: outline in `rgba`, interior
// in `filled`. A filled rect with a red outline and a blue interior came back
// solid red. `ink.write(bitmap, x, y, srcColor)` is the general mechanism --
// the same one the `stamp` ink will use to paint a mask's per-pixel colour
// payload -- not a special case for drawRect.

const GREEN = [0, 255, 0, 255];

test('a filled rect keeps outline and interior distinct under an ink', () => {
  const bmp = createBitmap(5, 5);
  const ink = makeInk(normalizeBrush({}), ctx({ primary: RED }));
  drawRect(bmp, 0, 0, 4, 4, RED, BLUE, ink);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const border = x === 0 || x === 4 || y === 0 || y === 4;
    assert.deepEqual([...getPixel(bmp, x, y)], border ? RED : BLUE,
      `pixel ${x},${y} should be the ${border ? 'outline' : 'interior'} colour`);
  }
});

test('a filled ellipse keeps outline and interior distinct under an ink', () => {
  const bmp = createBitmap(9, 9);
  const ink = makeInk(normalizeBrush({}), ctx({ primary: RED }));
  drawEllipse(bmp, 0, 0, 8, 8, RED, BLUE, ink);
  // The centre is unambiguously interior; the middle of the left edge is
  // unambiguously outline. Both must survive, and neither may be the other.
  assert.deepEqual([...getPixel(bmp, 4, 4)], BLUE, 'ellipse interior');
  assert.deepEqual([...getPixel(bmp, 0, 4)], RED, 'ellipse outline');
});

test('an unfilled rect under an ink is unchanged: outline painted, interior blank', () => {
  const bmp = createBitmap(5, 5);
  const ink = makeInk(normalizeBrush({}), ctx({ primary: RED }));
  drawRect(bmp, 0, 0, 4, 4, RED, false, ink);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    const border = x === 0 || x === 4 || y === 0 || y === 4;
    assert.deepEqual([...getPixel(bmp, x, y)], border ? RED : CLEAR, `pixel ${x},${y}`);
  }
});

test('honouring the caller colour must not turn a dithered interior solid', () => {
  // The source colour takes the dither's PRIMARY slot; the secondary swatch
  // stays the secondary. If srcColor replaced both slots the interior would
  // flood solid, which is the exact opposite of what this ink is for.
  const bmp = createBitmap(6, 6);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'dither', pattern: 'checker' } }),
    ctx({ primary: RED, secondary: GREEN }));
  drawRect(bmp, 0, 0, 5, 5, RED, BLUE, ink);
  const interior = [];
  for (let y = 1; y <= 4; y++) for (let x = 1; x <= 4; x++) interior.push(getPixel(bmp, x, y).join());
  assert.deepEqual([...new Set(interior)].sort(), [BLUE.join(), GREEN.join()].sort(),
    'the interior must dither between the caller colour and the secondary');
  assert.ok(!interior.includes(RED.join()), 'no interior pixel may be the OUTLINE colour');
  // And the outline still dithers between primary and secondary.
  const border = [];
  for (let x = 0; x < 6; x++) border.push(getPixel(bmp, x, 0).join());
  assert.ok(border.includes(RED.join()) && border.includes(GREEN.join()), 'outline still dithers');
});

test('each ink kind makes its own decision about a caller-supplied colour', () => {
  const palette = greyPalette();
  // solid: paints it.
  {
    const bmp = createBitmap(2, 2);
    makeInk(normalizeBrush({}), ctx({ primary: RED })).write(bmp, 0, 0, GREEN);
    assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN, 'solid must paint the caller colour');
  }
  // solid without one: falls back to primary.
  {
    const bmp = createBitmap(2, 2);
    makeInk(normalizeBrush({}), ctx({ primary: RED })).write(bmp, 0, 0);
    assert.deepEqual([...getPixel(bmp, 0, 0)], RED, 'no caller colour means primary');
  }
  // stamp: paints it -- this is how a custom mask's colour payload will arrive.
  {
    const bmp = createBitmap(2, 2);
    makeInk(normalizeBrush({ ink: { kind: 'stamp' } }), ctx({ primary: RED })).write(bmp, 0, 0, GREEN);
    assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN, 'stamp must paint the caller colour');
  }
  // replace: decides WHICH pixels are painted, not what colour goes down.
  {
    const bmp = createBitmap(2, 2);
    setPixel(bmp, 0, 0, BLUE);
    makeInk(normalizeBrush({ ink: { kind: 'replace', replaceColor: BLUE } }), ctx({ primary: RED }))
      .write(bmp, 0, 0, GREEN);
    assert.deepEqual([...getPixel(bmp, 0, 0)], GREEN, 'replace must paint the caller colour');
  }
  // lock-alpha: paints the colour, keeps the destination's alpha.
  {
    const bmp = createBitmap(2, 2);
    setPixel(bmp, 0, 0, [9, 9, 9, 128]);
    makeInk(normalizeBrush({ ink: { kind: 'lock-alpha' } }), ctx({ primary: RED }))
      .write(bmp, 0, 0, GREEN);
    assert.deepEqual([...getPixel(bmp, 0, 0)], [0, 255, 0, 128],
      'lock-alpha must paint the caller colour and keep the destination alpha');
  }
  // ramp-shade: output comes from the destination pixel and a ramp, so a
  // source colour is meaningless and must be ignored.
  {
    const bmp = createBitmap(2, 2);
    setPixel(bmp, 0, 0, [70, 70, 70, 255]);
    makeInk(normalizeBrush({ ink: { kind: 'ramp-shade' } }), ctx({ palette, primary: RED }))
      .write(bmp, 0, 0, GREEN);
    assert.deepEqual([...getPixel(bmp, 0, 0)], [130, 130, 130, 255],
      'ramp-shade must ignore a caller colour and stay on the ramp');
  }
});

// --- 2. dither stays screen-anchored through a detached sub-bitmap ---------
//
// The fill tools copy the target region out to a `sub` whose origin is (0,0),
// flood that and blit it back. Without an origin offset the ink indexes the
// Bayer cell from sub-local coordinates, so the same run of pixels dithers
// "#.#.#.#." locally where absolute x=17 demands ".#.#.#.#" -- exactly
// inverted. Bucket-filling at an odd offset and then pencilling the same
// pixels then produced a SOLID region out of two complementary checkerboards.

const OFFSET = 17;

function phaseRow(bmp, x0, n = 8) {
  return Array.from({ length: n }, (_, i) => (getPixel(bmp, x0 + i, 0)[3] > 0 ? '#' : '.')).join('');
}

function ditherRow(originX) {
  const bmp = createBitmap(8, 1);
  const ink = makeInk(normalizeBrush({ ink: { opacity: 50 } }), ctx({ originX }));
  for (let x = 0; x < 8; x++) ink.write(bmp, x, 0);
  return phaseRow(bmp, 0);
}

test('a fill into a detached sub-bitmap dithers in the sheet phase, not the sub phase', () => {
  // What the pencil produces at absolute x = 17..24, painting the sheet direct.
  const sheet = createBitmap(32, 1);
  const direct = makeInk(normalizeBrush({ ink: { opacity: 50 } }), ctx());
  for (let x = 0; x < 8; x++) direct.write(sheet, OFFSET + x, 0);
  const absolute = phaseRow(sheet, OFFSET);

  assert.equal(ditherRow(OFFSET), absolute,
    'a sub-bitmap told where it sits must dither in absolute phase');
  // Built-in mutation proof: drop the offset and the phase inverts. If this
  // ever stops holding, the assertion above has stopped discriminating.
  const unanchored = ditherRow(0);
  assert.notEqual(unanchored, absolute,
    'without the origin offset the phases must differ -- otherwise this test proves nothing');
  assert.equal(unanchored, absolute.replace(/[#.]/g, c => (c === '#' ? '.' : '#')),
    'at 50% density the unanchored phase is the exact inverse');
});

test('the origin offset moves the ramp-shade jitter hash too, not just the dither', () => {
  // Same argument, different pattern: jitter is hashed from the pixel's
  // ABSOLUTE coordinates, so a fill into a sub-bitmap must hash from where the
  // region really sits or its shading crawls relative to a pencil stroke.
  const palette = greyPalette();
  const brush = normalizeBrush({ ink: { kind: 'ramp-shade', jitter: 3 } });
  const paint = (bmp, ink, x0) => { for (let x = 0; x < 8; x++) ink.write(bmp, x0 + x, 0); };
  const readRow = (bmp, x0) => Array.from({ length: 8 }, (_, i) => getPixel(bmp, x0 + i, 0).join());
  const fresh = (w) => {
    const b = createBitmap(w, 1);
    for (let x = 0; x < w; x++) setPixel(b, x, 0, palette.colors[1]);
    return b;
  };
  const sheet = fresh(32);
  paint(sheet, makeInk(brush, ctx({ palette, seed: 909 })), OFFSET);
  const absolute = readRow(sheet, OFFSET);

  const sub = fresh(8);
  paint(sub, makeInk(brush, ctx({ palette, seed: 909, originX: OFFSET })), 0);
  assert.deepEqual(readRow(sub, 0), absolute, 'jitter must be hashed from the absolute position');

  const unanchored = fresh(8);
  paint(unanchored, makeInk(brush, ctx({ palette, seed: 909 })), 0);
  assert.notDeepEqual(readRow(unanchored, 0), absolute,
    'without the origin offset the jitter must differ -- otherwise this test proves nothing');
});

test('the origin offset changes ONLY the pattern index, never where a pixel lands', () => {
  // The ink is handed the sub-bitmap; every read and write must stay in that
  // bitmap's own coordinates or a fill would paint outside itself.
  const bmp = createBitmap(4, 4);
  makeInk(normalizeBrush({}), ctx({ originX: 100, originY: 100 })).write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], RED, 'the write must land at the local coordinate');
});

// --- 3. a fully transparent pixel has no colour ----------------------------
//
// nearestColor replaces RGB but PRESERVES alpha, so on an indexed palette the
// eraser's [0,0,0,0] came back as a palette entry under alpha 0 -- a fully
// transparent RED. floodFill compares with colorsEqual, so a bucket fill then
// stopped dead at an erase boundary, and exports fringed.

function brightPalette() {
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]].map(c => [...c, 255]);
  return normalizePalette({ id: 'b', name: 'B', indexed: true, colors, empty: colors.map(() => false) });
}

test('erasing over an indexed palette leaves exactly [0,0,0,0]', () => {
  for (const palette of [brightPalette(), greyPalette()]) {
    // Sanity: this palette really would have coloured the pixel in.
    assert.notDeepEqual(applyPaletteClosure(palette, CLEAR), CLEAR,
      'this palette must snap transparent black to a coloured entry, or the test is vacuous');
    const bmp = createBitmap(4, 4);
    setPixel(bmp, 1, 1, [255, 0, 0, 255]);
    // The eraser builds its ink with primary [0,0,0,0] and hands the same
    // colour down through the primitive.
    makeInk(normalizeBrush({}), ctx({ palette, primary: CLEAR })).write(bmp, 1, 1, CLEAR);
    assert.deepEqual([...getPixel(bmp, 1, 1)], CLEAR, 'an erased pixel must carry no colour at all');
  }
});

test('a bucket fill crosses a previously-erased region instead of stopping at it', () => {
  const palette = brightPalette();
  const bmp = createBitmap(6, 1);
  setPixel(bmp, 2, 0, [255, 0, 0, 255]);
  setPixel(bmp, 3, 0, [255, 0, 0, 255]);
  const eraser = makeInk(normalizeBrush({}), ctx({ palette, primary: CLEAR }));
  eraser.write(bmp, 2, 0, CLEAR);
  eraser.write(bmp, 3, 0, CLEAR);
  // Seed at x=0, which was never drawn on. Every pixel of the row must match.
  floodFill(bmp, 0, 0, GREEN, true);
  for (let x = 0; x < 6; x++) {
    assert.deepEqual([...getPixel(bmp, x, 0)], GREEN,
      `fill stopped at the erase boundary: pixel ${x} was not reached`);
  }
});

// --- 5. setPressure must not wipe the pressure it was given ----------------

test('setPressure keeps the current pressure when a pointer event carries none', () => {
  // A mouse PointerEvent has no `pressure`, and assigning that undefined
  // straight through left pressureValue computing Number(undefined) -> NaN
  // -> 0, collapsing an opacity-targeted brush to its minimum mid-stroke.
  const brush = normalizeBrush({ ink: { opacity: 100 }, pressure: { target: 'opacity', min: 0, max: 100 } });
  const bmp = createBitmap(4, 4);
  const ink = makeInk(brush, ctx({ primary: RED, pressure: 1, pointerType: 'pen' }));
  ink.setPressure(undefined, 'pen');
  ink.write(bmp, 0, 0);
  assert.deepEqual([...getPixel(bmp, 0, 0)], RED, 'a pressureless move wiped the stroke pressure');
});

test('setPressure still applies a real pressure value', () => {
  const brush = normalizeBrush({ ink: { opacity: 100 }, pressure: { target: 'opacity', min: 0, max: 100 } });
  const bmp = createBitmap(4, 4);
  const ink = makeInk(brush, ctx({ primary: RED, pressure: 1, pointerType: 'pen' }));
  ink.setPressure(0, 'pen');
  ink.write(bmp, 0, 0);
  assert.deepEqual([...getPixel(bmp, 0, 0)], CLEAR, 'pressure 0 at target opacity must paint nothing');
});

// --- fix round 2: soft-flood erase must erase -------------------------------
//
// softFloodFill already computes `target` -- `rgba` for a fill, [0,0,0,0] for
// an erase -- and then threw it away when an ink was present, so a right-click
// soft flood painted the ink's primary over the region instead of erasing it.
// The erase deliberately still goes through the ink: a brush that paints at
// 50% density erases at 50% density.

test('soft-flood erase under an ink erases instead of painting the ink primary', () => {
  // On an INDEXED palette, so this also pins that the erase composes with the
  // alpha-0 normalisation: without it nearestColor would snap the erased pixel
  // back to a coloured-but-invisible palette entry.
  const palette = brightPalette();
  const bmp = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, BLUE);
  const ink = makeInk(normalizeBrush({}), ctx({ palette, primary: RED }));
  // `rgba` is RED -- the colour a FILL would have used. Erase must ignore it.
  softFloodFill(bmp, 0, 0, RED, { mode: 'erase', tolerance: 0 }, ink);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.deepEqual([...getPixel(bmp, x, y)], CLEAR, `pixel ${x},${y} was painted, not erased`);
  }
});

test('soft-flood erase at 50% density erases half the region and leaves the rest intact', () => {
  // The one that proves erase still respects the BRUSH rather than being
  // special-cased into a bypass. Opacity is dither density here, so an
  // opacity-50 ink must erase exactly the Bayer half of an 8x8 region and
  // leave the other half untouched -- a feathered erase.
  const bmp = createBitmap(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setPixel(bmp, x, y, BLUE);
  const ink = makeInk(normalizeBrush({ ink: { opacity: 50 } }), ctx({ primary: RED }));
  softFloodFill(bmp, 0, 0, RED, { mode: 'erase', tolerance: 0 }, ink);
  let erased = 0, kept = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = [...getPixel(bmp, x, y)];
    if (p.join() === CLEAR.join()) erased++;
    else if (p.join() === BLUE.join()) kept++;
    else assert.fail(`pixel ${x},${y} is neither erased nor intact: ${p}`);
  }
  assert.equal(erased, 32, 'an opacity-50 ink must erase exactly half the region');
  assert.equal(kept, 32, 'the other half must be left exactly as it was');
});

test('soft-flood FILL mode is unchanged by the erase fix', () => {
  // In fill mode `target` IS `rgba`, and drawing-engine builds this ink with
  // primary === the colour it passes as rgba (strokeInk(ev, sfColor, t) beside
  // softFloodFill(..., sfColor, ...)), so nothing on this path moved. This is
  // a no-regression assertion: it is EXPECTED to stay green under the mutation
  // that reverts the erase fix -- a failure there would mean fill mode had
  // changed, which is exactly what must not happen.
  const bmp = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, BLUE);
  const ink = makeInk(normalizeBrush({}), ctx({ primary: GREEN }));
  softFloodFill(bmp, 0, 0, GREEN, { tolerance: 0 }, ink);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.deepEqual([...getPixel(bmp, x, y)], GREEN, `pixel ${x},${y}`);
  }
});

// --- fix round 3: an ink declares whether it claims the secondary swatch ----
//
// The shape tools paint a filled shape's interior in the secondary. An ink
// that already uses the secondary as one of its own colours therefore
// collides with that convention, and drawing-engine needs to know -- WITHOUT
// switching on `kind`, which would put ink taxonomy in the wrong module.

test('usesSecondary is true for dither and false for every other ink', () => {
  // Enumerated from INK_KINDS rather than hand-listed, so a seventh ink shows
  // up here as a failure instead of being silently assumed not to use it.
  const expected = { dither: true, solid: false, stamp: false, replace: false, 'lock-alpha': false, 'ramp-shade': false };
  assert.deepEqual([...INK_KINDS].sort(), Object.keys(expected).sort(),
    'a new ink kind was added -- decide whether it consumes the secondary swatch');
  for (const kind of INK_KINDS) {
    const brush = normalizeBrush({ ink: { kind, replaceColor: RED } });
    assert.equal(makeInk(brush, ctx()).usesSecondary, expected[kind], `usesSecondary wrong for ${kind}`);
  }
});

test('usesMaskColors is true only for stamp', () => {
  // Enumerated from INK_KINDS, same as usesSecondary above: a new ink kind
  // must show up here as a failure rather than being silently assumed not to
  // want a custom mask's colour payload. Fail-closed either way -- an ink
  // absent from this expectation table is asserted false, matching
  // MASK_COLOR_CONSUMING_KINDS's own default for anything it doesn't list.
  const expected = { stamp: true, solid: false, dither: false, replace: false, 'lock-alpha': false, 'ramp-shade': false };
  assert.deepEqual([...INK_KINDS].sort(), Object.keys(expected).sort(),
    'a new ink kind was added -- decide whether it consumes a custom mask\'s colour payload');
  for (const kind of INK_KINDS) {
    const brush = normalizeBrush({ ink: { kind, replaceColor: RED } });
    assert.equal(makeInk(brush, ctx()).usesMaskColors, expected[kind], `usesMaskColors wrong for ${kind}`);
  }
});

test('only the ink that actually reads `secondary` reports usesSecondary', () => {
  // Behavioural cross-check on the flag, so it cannot drift away from the
  // code: paint a pixel with the secondary set, then again with a DIFFERENT
  // secondary. Only an ink that reads it can produce a different result.
  const palette = greyPalette();
  // Both probe secondaries are real palette entries, and so are the primary
  // and the destination. Off-palette probes would be snapped together by
  // applyPaletteClosure and every ink would look like it ignored the
  // secondary -- the probe has to survive the closure to prove anything. The
  // palette is kept (rather than dropped) so ramp-shade is genuinely
  // exercised instead of bailing out at its `if (!palette) return`.
  const DEST = palette.colors[1], INK_PRIMARY = palette.colors[2];
  const paint = (kind, secondary) => {
    const bmp = createBitmap(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, DEST);
    const brush = normalizeBrush({ ink: { kind, replaceColor: DEST } });
    const ink = makeInk(brush, ctx({ palette, primary: INK_PRIMARY, secondary }));
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ink.write(bmp, x, y);
    return Array.from({ length: 16 }, (_, i) => getPixel(bmp, i % 4, (i / 4) | 0).join()).join(' ');
  };
  for (const kind of INK_KINDS) {
    const brush = normalizeBrush({ ink: { kind } });
    const reads = paint(kind, palette.colors[0]) !== paint(kind, palette.colors[3]);
    assert.equal(makeInk(brush, ctx()).usesSecondary, reads,
      `${kind}: usesSecondary says ${makeInk(brush, ctx()).usesSecondary} but it ${reads ? 'does' : 'does not'} read the secondary`);
  }
});

// --- fix round 4: erase semantics -------------------------------------------
//
// Every drawing tool now paints through an ink, the eraser included, and the
// eraser's colour is the fully transparent [0,0,0,0] (drawing-engine's
// currentColor). The inks were designed for painting, so two of them answered
// "paint this transparent colour" by ADDING colour: dither painted its
// secondary swatch on the pattern's off-phase, and lock-alpha closed the
// sentinel's [0,0,0] to the palette's darkest entry under the destination's
// own alpha -- an eraser that filled the region SOLID BLACK. The rule now in
// brush-ink.js: a transparent source colour means ERASE; an ink may erase a
// pixel or leave it alone, and may never write a coloured or opaque value.

function erasePalette() {
  // Indexed, with a real four-step grey RAMP so ramp-shade is genuinely armed,
  // plus saturated entries that survive closure as distinct colours. Both
  // properties are ASSERTED below, never assumed: a palette whose colours lie
  // in no ramp makes ramp-shade look like a no-op when it is not one, and
  // probe colours that close together make every ink look like it ignores the
  // secondary. Three earlier probes on this branch were neutralised that way.
  const colors = [[20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200],
    [0, 255, 0], [0, 0, 255], [255, 0, 0]].map(c => [...c, 255]);
  return normalizePalette({ id: 'e', name: 'E', indexed: true, colors, empty: colors.map(() => false) });
}

// One 8x1 row of `dest`, written end to end through a fresh ink. `source` is
// the colour handed to write() -- CLEAR is what the eraser passes.
function eraseRow(kind, dest, { palette, primary = CLEAR, secondary = BLUE, source = CLEAR, ink = {} } = {}) {
  const bmp = createBitmap(8, 1);
  for (let x = 0; x < 8; x++) setPixel(bmp, x, 0, dest);
  const made = makeInk(normalizeBrush({ ink: { kind, ...ink } }), ctx({ palette, primary, secondary }));
  for (let x = 0; x < 8; x++) made.write(bmp, x, 0, source);
  return Array.from({ length: 8 }, (_, x) => [...getPixel(bmp, x, 0)]);
}

test('ERASE TABLE: every ink either erases a pixel or leaves it exactly as it was', () => {
  const palette = erasePalette();
  const GREY1 = palette.colors[1], GREY2 = palette.colors[2];

  // Anti-vacuity for all four mechanisms this table leans on. If a mechanism
  // were ABSENT the table would read all-'D' for that ink and still pass, so
  // each of these has to be checked before the table means anything.
  assert.notDeepEqual([...applyPaletteClosure(palette, CLEAR)], CLEAR,
    'the palette must snap transparent black to a coloured entry, or lock-alpha could not have gone black');
  assert.notEqual(applyPaletteClosure(palette, GREEN).join(), applyPaletteClosure(palette, BLUE).join(),
    'GREEN and BLUE must survive closure as distinct entries, or dither would look like it ignored the secondary');
  assert.deepEqual(eraseRow('ramp-shade', GREY1, { palette, primary: RED, source: RED })[0], [...GREY2],
    'ramp-shade must actually step this palette when painting, or its erase row below proves nothing');
  const dithered = eraseRow('dither', GREEN, { palette, primary: RED, source: RED }).map(p => p.join());
  assert.ok(dithered.includes(BLUE.join()) && dithered.includes(RED.join()),
    'the dither secondary phase must be live when painting, or its erase row below proves nothing');

  // '.' erased, 'D' left exactly as it was, '!' anything else -- and '!' is
  // precisely the violation: a value that is neither the erase nor the pixel
  // that was already there.
  const expected = {
    solid: '........',
    stamp: '........',
    replace: '........',      // armed below: replaceColor IS the destination
    dither: '.D.D.D.D',       // no second colour to alternate with, so the
                              // pattern degrades to a density mask
    'lock-alpha': 'DDDDDDDD', // declines: pinning alpha and clearing it are
                              // contradictory intents
    'ramp-shade': 'DDDDDDDD', // declines: it ignores the source colour, so an
                              // erase would come out as an opaque shade
  };
  assert.deepEqual([...INK_KINDS].sort(), Object.keys(expected).sort(),
    'a new ink kind was added -- decide what it does when handed an erase');

  // Twice over: GREEN lies in no ramp (ramp-shade bails at stepAlongRamp),
  // GREY1 sits mid-ramp (ramp-shade would really step it). Only the second
  // pass can catch ramp-shade, which is why a probe run on a rampless palette
  // reported that arm as already a no-op when it was not one.
  for (const dest of [GREEN, GREY1]) {
    for (const kind of INK_KINDS) {
      const row = eraseRow(kind, dest, { palette, ink: { replaceColor: dest } });
      const got = row.map(p => (p.join() === CLEAR.join() ? '.' : p.join() === dest.join() ? 'D' : '!')).join('');
      assert.equal(got, expected[kind],
        `${kind} erasing over ${dest.join()}: ${row.map(p => p.join()).join(' | ')}`);
    }
  }
});

test('a dither brush erases at its density and leaves the untouched pixels UNTOUCHED', () => {
  // The headline case: with the off-phase still painting, a "feathered erase"
  // removed half the region and painted the SECONDARY SWATCH over the other
  // half -- an eraser that adds colour.
  const palette = erasePalette();
  const bmp = createBitmap(8, 8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) setPixel(bmp, x, y, GREEN);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'dither', pattern: 'checker' } }),
    ctx({ palette, primary: CLEAR, secondary: BLUE }));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y, CLEAR);
  let erased = 0, kept = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = [...getPixel(bmp, x, y)];
    if (p.join() === CLEAR.join()) erased++;
    else if (p.join() === GREEN.join()) kept++;
    else assert.fail(`pixel ${x},${y} is neither erased nor intact: ${p} (the secondary is ${BLUE})`);
  }
  assert.equal(erased, 32, 'a checker dither must erase exactly its own half of the region');
  assert.equal(kept, 32, 'the other half must be left exactly as it was, not repainted');
});

test('lock-alpha refuses an erase outright rather than filling the region black', () => {
  // nearestColor replaces RGB and preserves alpha, so the sentinel's [0,0,0]
  // closed to the palette's darkest entry under the destination's own alpha:
  // the eraser turned an opaque region opaque BLACK, the precise opposite of
  // erasing. lock-alpha now declines, and declining must change NOTHING.
  const palette = erasePalette();
  const bmp = createBitmap(4, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(bmp, x, y, GREEN);
  setPixel(bmp, 3, 3, CLEAR);                // a hole, which must stay a hole
  setPixel(bmp, 0, 3, [0, 255, 0, 128]);     // a partial-alpha pixel, kept verbatim
  const before = [...bmp.data];
  const ink = makeInk(normalizeBrush({ ink: { kind: 'lock-alpha' } }), ctx({ palette, primary: CLEAR }));
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) ink.write(bmp, x, y, CLEAR);
  assert.deepEqual([...bmp.data], before, 'a lock-alpha erase must change nothing at all');

  // Anti-vacuity: the same ink, handed a real colour, must still paint -- or
  // the assertion above would hold just as well for an ink that had stopped
  // working altogether.
  const live = createBitmap(2, 1);
  setPixel(live, 0, 0, GREEN);
  makeInk(normalizeBrush({ ink: { kind: 'lock-alpha' } }), ctx({ palette, primary: RED }))
    .write(live, 0, 0, RED);
  assert.deepEqual([...getPixel(live, 0, 0)], RED, 'lock-alpha must still paint a real colour');
});

test('ramp-shade refuses an erase instead of shading the region a step lighter', () => {
  // This arm reads as a no-op under a palette whose colours lie in no ramp:
  // stepAlongRamp returns null and it bails for an unrelated reason. Mid-ramp
  // it really would have written an opaque neighbour -- an eraser that SHADES.
  const palette = erasePalette();
  const GREY1 = palette.colors[1], GREY2 = palette.colors[2];
  assert.deepEqual(eraseRow('ramp-shade', GREY1, { palette, primary: RED, source: RED })[0], [...GREY2],
    'this palette must really step, or the assertion below is vacuous');
  for (const p of eraseRow('ramp-shade', GREY1, { palette })) {
    assert.deepEqual(p, [...GREY1], 'a ramp-shade erase must leave the pixel exactly as it was');
  }
});

test('replace erasing removes exactly the pixels matching replaceColor', () => {
  // replace also reads as a no-op under the DEFAULT replaceColor of null --
  // the guard at the top of its arm, not a property of erasing. Armed, it
  // gates WHICH pixels are written and never what value goes down, so it
  // erases its target and only its target. That is right, and is pinned here.
  const palette = erasePalette();
  const bmp = createBitmap(4, 1);
  setPixel(bmp, 0, 0, GREEN); setPixel(bmp, 1, 0, BLUE);
  setPixel(bmp, 2, 0, GREEN); setPixel(bmp, 3, 0, RED);
  const ink = makeInk(normalizeBrush({ ink: { kind: 'replace', replaceColor: GREEN } }),
    ctx({ palette, primary: CLEAR }));
  for (let x = 0; x < 4; x++) ink.write(bmp, x, 0, CLEAR);
  assert.deepEqual([...getPixel(bmp, 0, 0)], CLEAR);
  assert.deepEqual([...getPixel(bmp, 1, 0)], BLUE, 'a non-matching pixel must be left alone');
  assert.deepEqual([...getPixel(bmp, 2, 0)], CLEAR);
  assert.deepEqual([...getPixel(bmp, 3, 0)], RED, 'a non-matching pixel must be left alone');
});

test('an erase erases under trueAlpha, where a blend toward alpha 0 is a no-op', () => {
  // commit folds opacity into aSrc = (rgba[3] / 255) * (effOpacity / 100),
  // which is 0 for an erase source, so blendOver returned the destination
  // unchanged and the erase did nothing at all. Nothing in js/ sets trueAlpha
  // today; the next task exposes it in the brush-manager UI.
  const palette = erasePalette();

  // Anti-vacuity FIRST: prove the trueAlpha branch is really taken here. At
  // opacity 50 the blending path writes EVERY pixel (a half-alpha value),
  // where the density path would leave exactly half of them blank. If this
  // ever reads 32 then `blends` is off and the assertions below prove nothing
  // about trueAlpha at all.
  const probe = createBitmap(8, 8);
  const blending = makeInk(normalizeBrush({ ink: { opacity: 50, trueAlpha: true } }), ctx({ palette, primary: RED }));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blending.write(probe, x, y, RED);
  let written = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (getPixel(probe, x, y)[3] > 0) written++;
  assert.equal(written, 64, 'trueAlpha must be blending, not dithering by density, or this test is vacuous');

  // Every ink that can erase must erase with trueAlpha on exactly as it does
  // with it off -- compared against the plain path rather than hand-written,
  // so the two cannot drift apart.
  for (const kind of ['solid', 'stamp', 'dither', 'replace']) {
    const plain = eraseRow(kind, GREEN, { palette, ink: { replaceColor: GREEN } });
    const alpha = eraseRow(kind, GREEN, { palette, ink: { replaceColor: GREEN, trueAlpha: true } });
    assert.deepEqual(alpha, plain, `${kind}: a trueAlpha erase must match the plain erase`);
    assert.ok(alpha.some(p => p.join() === CLEAR.join()), `${kind}: the trueAlpha erase erased nothing`);
  }
});
