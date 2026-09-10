import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBrush, applyCurve, pressureValue, effectiveMaskSize } from '../js/core/brushes.js';
import { createBitmap, setPixel, getPixel } from '../js/core/pixels.js';
import { normalizePalette } from '../js/core/palettes.js';
import { makeInk } from '../js/core/brush-ink.js';

const sizeBrush = (extra = {}) => normalizeBrush({
  mask: { kind: 'square', size: 4 },
  pressure: { target: 'size', min: 1, max: 9, curve: 'linear', ...extra },
});

test('applyCurve is identity at the endpoints for every curve', () => {
  for (const curve of ['linear', 'soft', 'hard']) {
    assert.equal(applyCurve(0, curve), 0, curve);
    assert.equal(applyCurve(1, curve), 1, curve);
  }
});

test('soft gives less output at low pressure than linear; hard gives more', () => {
  assert.ok(applyCurve(0.3, 'soft') < applyCurve(0.3, 'linear'));
  assert.ok(applyCurve(0.3, 'hard') > applyCurve(0.3, 'linear'));
});

test('pressure is IGNORED for a mouse -- a mouse reports a constant 0.5', () => {
  assert.equal(pressureValue(sizeBrush(), 0.5, 'mouse'), null);
  assert.equal(pressureValue(sizeBrush(), 1.0, 'mouse'), null);
});

test('pressure is ignored for touch', () => {
  assert.equal(pressureValue(sizeBrush(), 0.7, 'touch'), null);
});

test('pressure applies for a pen', () => {
  assert.equal(typeof pressureValue(sizeBrush(), 0.5, 'pen'), 'number');
});

test('target none ignores pressure even for a pen', () => {
  const b = normalizeBrush({ pressure: { target: 'none' } });
  assert.equal(pressureValue(b, 0.9, 'pen'), null);
});

test('pressure maps across the full min..max range', () => {
  assert.equal(pressureValue(sizeBrush(), 0, 'pen'), 1);
  assert.equal(pressureValue(sizeBrush(), 1, 'pen'), 9);
});

test('every pressure output is an integer -- no fractional brush sizes', () => {
  for (let p = 0; p <= 1.0001; p += 0.05) {
    const v = pressureValue(sizeBrush(), p, 'pen');
    assert.equal(Number.isInteger(v), true, `pressure ${p} gave ${v}`);
  }
});

test('effectiveMaskSize falls back to the static size without a pen', () => {
  assert.equal(effectiveMaskSize(sizeBrush(), 0.9, 'mouse'), 4);
});

test('effectiveMaskSize uses pressure with a pen and stays within 1..16', () => {
  assert.equal(effectiveMaskSize(sizeBrush(), 1, 'pen'), 9);
  assert.equal(effectiveMaskSize(sizeBrush({ max: 99 }), 1, 'pen'), 16);
  assert.equal(effectiveMaskSize(sizeBrush({ min: 0 }), 0, 'pen'), 1);
});

// --- amendment (Ruling 21): pressure targets 'opacity' and 'shade-step' ---

const RED = [255, 0, 0, 255];

function ctx(extra = {}) {
  return { primary: RED, secondary: null, palette: null, seed: 1, alt: false, pressure: 1, pointerType: 'pen', ...extra };
}

function greyPalette() {
  const colors = [[20, 20, 20], [70, 70, 70], [130, 130, 130], [200, 200, 200]].map(c => [...c, 255]);
  return normalizePalette({ id: 'p', name: 'P', indexed: true, colors, empty: colors.map(() => false) });
}

function countPainted(bmp, w, h) {
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (getPixel(bmp, x, y)[3] > 0) n++;
  return n;
}

test('opacity target: a pen at full pressure paints strictly more pixels than at low pressure', () => {
  const brush = normalizeBrush({
    mask: { kind: 'square', size: 1 },
    ink: { kind: 'solid', opacity: 100 },
    pressure: { target: 'opacity', min: 5, max: 95, curve: 'linear' },
  });
  const fill = (pressure) => {
    const bmp = createBitmap(16, 16);
    const ink = makeInk(brush, ctx({ pressure, pointerType: 'pen' }));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) ink.write(bmp, x, y);
    return countPainted(bmp, 16, 16);
  };
  const low = fill(0);
  const high = fill(1);
  assert.ok(high > low, `expected high pressure (${high}) to paint more than low pressure (${low})`);
});

test('opacity target: a mouse is unaffected by pressure -- identical output at 0.1 and 1.0', () => {
  const brush = normalizeBrush({
    mask: { kind: 'square', size: 1 },
    ink: { kind: 'solid', opacity: 100 },
    pressure: { target: 'opacity', min: 5, max: 95, curve: 'linear' },
  });
  const fill = (pressure) => {
    const bmp = createBitmap(16, 16);
    const ink = makeInk(brush, ctx({ pressure, pointerType: 'mouse' }));
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) ink.write(bmp, x, y);
    const out = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) out.push(getPixel(bmp, x, y).join(','));
    return out;
  };
  assert.deepEqual(fill(0.1), fill(1.0));
});

test('shade-step target: a pen at high pressure moves a pixel further along a ramp than at low pressure', () => {
  const palette = greyPalette();
  const brush = normalizeBrush({
    mask: { kind: 'square', size: 1 },
    ink: { kind: 'ramp-shade' },
    pressure: { target: 'shade-step', min: 1, max: 3, curve: 'linear' },
  });

  const bmpLow = createBitmap(4, 4);
  setPixel(bmpLow, 1, 1, [20, 20, 20, 255]);
  makeInk(brush, ctx({ palette, pressure: 0, pointerType: 'pen' })).write(bmpLow, 1, 1);
  const low = getPixel(bmpLow, 1, 1);

  const bmpHigh = createBitmap(4, 4);
  setPixel(bmpHigh, 1, 1, [20, 20, 20, 255]);
  makeInk(brush, ctx({ palette, pressure: 1, pointerType: 'pen' })).write(bmpHigh, 1, 1);
  const high = getPixel(bmpHigh, 1, 1);

  // min:1, max:3 -- low pressure (t=0) rounds to step 1 (one ramp entry);
  // full pressure (t=1) rounds to step 3 (three ramp entries).
  assert.deepEqual([...low], [70, 70, 70, 255], 'low pressure should step exactly one entry');
  assert.deepEqual([...high], [200, 200, 200, 255], 'high pressure should step three entries');
});

test('setPressure mid-stroke changes subsequent writes but does not reset the touched dedup', () => {
  const palette = greyPalette();
  const brush = normalizeBrush({
    mask: { kind: 'square', size: 1 },
    ink: { kind: 'ramp-shade' },
    pressure: { target: 'shade-step', min: 1, max: 3, curve: 'linear' },
  });
  const bmp = createBitmap(4, 4);
  setPixel(bmp, 1, 1, [20, 20, 20, 255]);
  const ink = makeInk(brush, ctx({ palette, pressure: 0, pointerType: 'pen' }));
  ink.write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [70, 70, 70, 255], 'first write should step one entry');
  ink.setPressure(1, 'pen');
  ink.write(bmp, 1, 1);
  assert.deepEqual([...getPixel(bmp, 1, 1)], [70, 70, 70, 255], 'second write to the same pixel must be a no-op');
});

test('target none (default) produces byte-identical output whatever the pressure', () => {
  const palette = greyPalette();
  const brush = normalizeBrush({ mask: { kind: 'square', size: 1 }, ink: { kind: 'ramp-shade' } });
  assert.equal(brush.pressure.target, 'none');

  const runWith = (pressure) => {
    const bmp = createBitmap(4, 4);
    setPixel(bmp, 1, 1, [20, 20, 20, 255]);
    makeInk(brush, ctx({ palette, pressure, pointerType: 'pen' })).write(bmp, 1, 1);
    return [...getPixel(bmp, 1, 1)];
  };
  assert.deepEqual(runWith(0), runWith(1));
});

// --- target-aware default ranges (Ruling 22) -------------------------------

test('the default pressure range suits the chosen target', () => {
  // One 1..8 default across every target left `opacity` swinging over 1%..8%
  // of full density -- an invisible brush at maximum pen pressure.
  assert.deepEqual(
    [normalizeBrush({ pressure: { target: 'size' } }).pressure.min,
     normalizeBrush({ pressure: { target: 'size' } }).pressure.max], [1, 8]);
  assert.deepEqual(
    [normalizeBrush({ pressure: { target: 'opacity' } }).pressure.min,
     normalizeBrush({ pressure: { target: 'opacity' } }).pressure.max], [0, 100]);
  assert.deepEqual(
    [normalizeBrush({ pressure: { target: 'shade-step' } }).pressure.min,
     normalizeBrush({ pressure: { target: 'shade-step' } }).pressure.max], [1, 3]);
});

test('an explicitly given pressure range still wins over the default', () => {
  const b = normalizeBrush({ pressure: { target: 'opacity', min: 10, max: 20 } });
  assert.equal(b.pressure.min, 10);
  assert.equal(b.pressure.max, 20);
});

test('an opacity-target brush with default range actually paints across the range', () => {
  const brush = normalizeBrush({
    mask: { kind: 'square', size: 1 },
    ink: { kind: 'solid', opacity: 100 },
    pressure: { target: 'opacity' },
  });
  const coverage = (pressure) => {
    const bmp = createBitmap(8, 8);
    const ink = makeInk(brush, ctx({ pressure, pointerType: 'pen' }));
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ink.write(bmp, x, y);
    return countPainted(bmp, 8, 8);
  };
  // Before the per-target defaults this was 0, 4 and 4 of 64.
  assert.equal(coverage(0), 0, 'no pressure should paint nothing');
  assert.ok(coverage(0.5) > 16 && coverage(0.5) < 48, `half pressure painted ${coverage(0.5)}/64`);
  assert.equal(coverage(1), 64, 'full pressure should paint everything');
});
