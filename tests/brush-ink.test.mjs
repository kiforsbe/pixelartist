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
  for (const kind of ['solid', 'ramp-shade', 'dither', 'lock-alpha']) {
    for (const opacity of [100, 75, 50, 25]) {
      const bmp = createBitmap(8, 8);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        setPixel(bmp, x, y, palette.colors[(x + y) % palette.colors.length]);
      }
      const brush = normalizeBrush({ ink: { kind, opacity } });
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
