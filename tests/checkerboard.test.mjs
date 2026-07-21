import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkerboardRemoveBitmap, detectCheckerboardColors, estimateCheckerCellSize, detectGuideLines, removeGuideLines } from '../js/core/checkerboard.js';

// Builds a w x h bitmap that's a checkerboard of `cell`-px squares
// alternating colorA/colorB, with an opaque solid-colored rect of `fill`
// painted at [rx,ry,rw,rh] on top (simulating real art sitting over the
// baked-in background).
function checkerBitmap(w, h, cell, colorA, colorB, rect = null) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const parity = ((x / cell) | 0) + ((y / cell) | 0);
      const c = parity % 2 === 0 ? colorA : colorB;
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
    }
  }
  if (rect) {
    const [rx, ry, rw, rh, fill] = rect;
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = (y * w + x) * 4;
        data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = 255;
      }
    }
  }
  return { width: w, height: h, data };
}

test('checkerboardRemoveBitmap: removes a regular checker background, leaves a solid-color rect on top untouched', () => {
  const bmp = checkerBitmap(64, 64, 8, [255, 255, 255], [192, 192, 192], [20, 20, 24, 24, [200, 40, 40]]);
  const out = checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [192, 192, 192], tolerance: 10, windowRadius: 12, minMixFraction: 0.1 });

  // Corner (pure checker) is gone.
  let i = (0 * 64 + 0) * 4;
  assert.deepEqual([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]], [0, 0, 0, 0]);

  // Center of the painted rect is untouched.
  i = (32 * 64 + 32) * 4;
  assert.deepEqual([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]], [200, 40, 40, 255]);
});

test('checkerboardRemoveBitmap: a large solid white/grey area (no alternation nearby) survives even though its color matches a checker shade', () => {
  const w = 64, h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  // Whole bitmap is flat white -- same color as colorA, but never alternates.
  for (let i = 0; i < data.length; i += 4) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255; }
  const bmp = { width: w, height: h, data };
  const out = checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [192, 192, 192], tolerance: 10, windowRadius: 12, minMixFraction: 0.1 });
  assert.deepEqual([...out.data], [...data]);
});

test('checkerboardRemoveBitmap: replace mode recolors checker pixels instead of erasing them, alpha untouched', () => {
  const bmp = checkerBitmap(32, 32, 8, [255, 255, 255], [192, 192, 192]);
  const out = checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [192, 192, 192], tolerance: 10, windowRadius: 10, minMixFraction: 0.1, mode: 'replace', replacementColor: [10, 20, 30] });
  const i = 0;
  assert.deepEqual([out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]], [10, 20, 30, 255]);
});

test('checkerboardRemoveBitmap: fully transparent pixels are skipped', () => {
  const bmp = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 0]) };
  const out = checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [192, 192, 192], tolerance: 10, windowRadius: 10, minMixFraction: 0.1 });
  assert.deepEqual([...out.data], [255, 255, 255, 0]);
});

test('checkerboardRemoveBitmap: does not mutate the input bitmap', () => {
  const bmp = checkerBitmap(32, 32, 8, [255, 255, 255], [192, 192, 192]);
  const before = [...bmp.data];
  checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [192, 192, 192], tolerance: 10, windowRadius: 10, minMixFraction: 0.1 });
  assert.deepEqual([...bmp.data], before);
});

test('detectCheckerboardColors: finds the two dominant near-neutral luma levels as light/dark colors', () => {
  const bmp = checkerBitmap(64, 64, 8, [255, 255, 255], [192, 192, 192], [10, 10, 8, 8, [200, 40, 40]]);
  const result = detectCheckerboardColors([bmp]);
  assert.ok(result);
  assert.deepEqual(result.colorA, [255, 255, 255]);
  assert.deepEqual(result.colorB, [192, 192, 192]);
});

test('detectCheckerboardColors: returns null when there is no second dominant neutral level', () => {
  const w = 16, h = 16;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 128; data[i + 1] = 30; data[i + 2] = 30; data[i + 3] = 255; }
  const result = detectCheckerboardColors([{ width: w, height: h, data }]);
  assert.equal(result, null);
});

test('estimateCheckerCellSize: recovers the cell size of an 8px checker', () => {
  const bmp = checkerBitmap(128, 128, 8, [255, 255, 255], [0, 0, 0]);
  const size = estimateCheckerCellSize([bmp], [255, 255, 255], [0, 0, 0]);
  assert.equal(size, 8);
});

test('estimateCheckerCellSize: recovers the cell size of a much larger 32px checker', () => {
  const bmp = checkerBitmap(256, 256, 32, [255, 255, 255], [0, 0, 0]);
  const size = estimateCheckerCellSize([bmp], [255, 255, 255], [0, 0, 0]);
  assert.equal(size, 32);
});

test('checkerboardRemoveBitmap: a windowRadius fixed too small for a large checker cell leaves un-removed islands at cell centers (regression guard for the bug estimateCheckerCellSize exists to fix)', () => {
  const bmp = checkerBitmap(128, 128, 32, [255, 255, 255], [0, 0, 0]);
  const tooSmall = checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [0, 0, 0], tolerance: 10, windowRadius: 14, minMixFraction: 0.12 });
  // Center of a 32px white cell (e.g. the one at cell-grid [1,1], pixel (32+16, 32+16)) is
  // 32px from the nearest opposite-color cell in every direction -- well outside a
  // radius-14 window, so it wrongly survives as opaque.
  let i = (48 * 128 + 48) * 4;
  assert.equal(tooSmall.data[i + 3], 255);

  // A windowRadius sized off the real cell size (via estimateCheckerCellSize) reaches the
  // neighboring cell from anywhere, including dead center, and removes it correctly.
  const cellSize = estimateCheckerCellSize([bmp], [255, 255, 255], [0, 0, 0], { tolerance: 10 });
  const sizedRight = checkerboardRemoveBitmap(bmp, { colorA: [255, 255, 255], colorB: [0, 0, 0], tolerance: 10, windowRadius: cellSize, minMixFraction: 0.12 });
  i = (48 * 128 + 48) * 4;
  assert.equal(sizedRight.data[i + 3], 0);
});

test('checkerboardRemoveBitmap: softness lets a stray pixel just past tolerance fade out instead of surviving at full opacity (the "stray lines left behind" case)', () => {
  // A checker of near-white/near-grey (dist 20 apart), plus one stray "grid line" pixel
  // sitting between the two shades (dist 10 from colorB, just past a tolerance of 8).
  const w = 16, h = 16;
  const colorA = [255, 255, 255], colorB = [235, 235, 235];
  const bmp = checkerBitmap(w, h, 4, colorA, colorB);
  const strayIdx = (8 * w + 8) * 4;
  bmp.data[strayIdx] = 225; bmp.data[strayIdx + 1] = 225; bmp.data[strayIdx + 2] = 225; bmp.data[strayIdx + 3] = 255;

  const hard = checkerboardRemoveBitmap(bmp, { colorA, colorB, tolerance: 8, softness: 0, windowRadius: 6, minMixFraction: 0.1 });
  assert.equal(hard.data[strayIdx + 3], 255); // untouched: dist 10 > tolerance 8, no softness to feather it

  const soft = checkerboardRemoveBitmap(bmp, { colorA, colorB, tolerance: 8, softness: 8, windowRadius: 6, minMixFraction: 0.1 });
  assert.ok(soft.data[strayIdx + 3] < 255 && soft.data[strayIdx + 3] > 0); // faded, not left fully opaque
});

test('checkerboardRemoveBitmap: protectColor shields real content even when tolerance/softness is widened aggressively to mop up stray pixels', () => {
  // A thin 1px-wide line of real content sitting IN the checkerboard field (like a stray
  // design-grid line, or the outline-fringe case) -- close enough to colorB to get swept up
  // once tolerance/softness is opened wide enough to also catch stray in-between-shade pixels.
  const colorA = [255, 255, 255], colorB = [192, 192, 192];
  const bmp = checkerBitmap(64, 64, 8, colorA, colorB);
  for (let y = 0; y < 64; y++) {
    const i = (y * 64 + 10) * 4;
    bmp.data[i] = 150; bmp.data[i + 1] = 150; bmp.data[i + 2] = 150; bmp.data[i + 3] = 255;
  }
  const lineIdx = (32 * 64 + 10) * 4;

  const aggressive = checkerboardRemoveBitmap(bmp, { colorA, colorB, tolerance: 40, softness: 40, windowRadius: 12, minMixFraction: 0.1 });
  assert.ok(aggressive.data[lineIdx + 3] < 100); // mostly erased along with the checker

  const protectedOut = checkerboardRemoveBitmap(bmp, {
    colorA, colorB, tolerance: 40, softness: 40, windowRadius: 12, minMixFraction: 0.1,
    protectColor: [150, 150, 150], protectTolerance: 20, protectSoftness: 0,
  });
  assert.deepEqual([protectedOut.data[lineIdx], protectedOut.data[lineIdx + 1], protectedOut.data[lineIdx + 2], protectedOut.data[lineIdx + 3]], [150, 150, 150, 255]);
});

// Draws full-span guide lines into an existing checker bitmap at the given
// row (axis='row') or column (axis='col') positions. `colorAt(index)` lets
// a test vary each line's color slightly, simulating a guide line that's
// actually a blend with whatever checker cell sits underneath at each
// point (see detectGuideLines's own note on why this varies in practice).
function drawGuideLines(bmp, axis, positions, colorAt) {
  const { width: w, height: h, data } = bmp;
  positions.forEach((pos, idx) => {
    const color = colorAt(idx);
    if (axis === 'row') {
      if (pos < 0 || pos >= h) return;
      for (let x = 0; x < w; x++) { const i = (pos * w + x) * 4; data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255; }
    } else {
      if (pos < 0 || pos >= w) return;
      for (let y = 0; y < h; y++) { const i = (y * w + pos) * 4; data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255; }
    }
  });
}

test('detectGuideLines: finds horizontal guide lines recurring at a regular interval, without being told the period', () => {
  const w = 200, h = 200;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  const positions = [10, 50, 90, 130, 170]; // period 40
  drawGuideLines(bmp, 'row', positions, () => [150, 150, 150]);

  const { rowBands, colBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  assert.equal(colBands.length, 0);
  assert.equal(rowBands.length, positions.length);
  const foundYs = rowBands.map(([a, b]) => Math.round((a + b) / 2)).sort((a, b) => a - b);
  assert.deepEqual(foundYs, positions);
});

test('detectGuideLines: tolerates per-line color variance (simulating a guide blended with whatever checker cell is underneath) via chroma/tolerance matching, not exact color', () => {
  const w = 200, h = 200;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  const positions = [10, 50, 90, 130, 170];
  // Each line is a visibly different grey -- no single exact color to match.
  const shades = [[130, 130, 130], [150, 150, 150], [170, 170, 170], [140, 140, 140], [160, 160, 160]];
  drawGuideLines(bmp, 'row', positions, (idx) => shades[idx]);

  const { rowBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  const foundYs = rowBands.map(([a, b]) => Math.round((a + b) / 2)).sort((a, b) => a - b);
  assert.deepEqual(foundYs, positions);
});

test('detectGuideLines: does not treat a single one-off non-checker row as a periodic guide', () => {
  const w = 150, h = 150;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  drawGuideLines(bmp, 'row', [75], () => [150, 150, 150]); // just one row, no repetition
  const { rowBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  assert.equal(rowBands.length, 0);
});

test('detectGuideLines: a row of dense colorful content is not mistaken for a guide line', () => {
  const w = 200, h = 200;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  // A saturated (non-neutral) full-width stripe -- real content, not a grey guide.
  for (let x = 0; x < w; x++) {
    const i = (75 * w + x) * 4;
    bmp.data[i] = 200; bmp.data[i + 1] = 40; bmp.data[i + 2] = 40; bmp.data[i + 3] = 255;
  }
  const { rowBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  assert.equal(rowBands.length, 0);
});

test('removeGuideLines: erases confirmed guide-line pixels but leaves colorful content crossing the same row untouched, and leaves everything outside the band alone', () => {
  const w = 200, h = 200;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  const positions = [10, 50, 90, 130, 170];
  drawGuideLines(bmp, 'row', positions, () => [150, 150, 150]);
  // A colorful icon pixel that happens to sit ON one of the guide rows.
  const contentIdx = (50 * w + 100) * 4;
  bmp.data[contentIdx] = 200; bmp.data[contentIdx + 1] = 40; bmp.data[contentIdx + 2] = 40; bmp.data[contentIdx + 3] = 255;

  const { rowBands, colBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  const out = removeGuideLines(bmp, { rowBands, colBands });

  // Guide-line pixel: gone.
  const lineIdx = (10 * w + 20) * 4;
  assert.deepEqual([out.data[lineIdx], out.data[lineIdx + 1], out.data[lineIdx + 2], out.data[lineIdx + 3]], [0, 0, 0, 0]);
  // Colorful content on the same row: untouched.
  assert.deepEqual([out.data[contentIdx], out.data[contentIdx + 1], out.data[contentIdx + 2], out.data[contentIdx + 3]], [200, 40, 40, 255]);
  // A row between guide lines: byte-identical to the source (checker, untouched).
  const betweenIdx = (30 * w + 20) * 4;
  assert.deepEqual([out.data[betweenIdx], out.data[betweenIdx + 1], out.data[betweenIdx + 2], out.data[betweenIdx + 3]], [bmp.data[betweenIdx], bmp.data[betweenIdx + 1], bmp.data[betweenIdx + 2], bmp.data[betweenIdx + 3]]);
});

test('removeGuideLines: protectColor shields real near-neutral content that happens to fall inside a confirmed band', () => {
  const w = 200, h = 200;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  const positions = [10, 50, 90, 130, 170];
  drawGuideLines(bmp, 'row', positions, () => [150, 150, 150]);
  // A grey icon pixel sitting on a guide row -- e.g. a stone-tile icon's own fill color.
  const iconIdx = (90 * w + 60) * 4;
  bmp.data[iconIdx] = 110; bmp.data[iconIdx + 1] = 110; bmp.data[iconIdx + 2] = 110; bmp.data[iconIdx + 3] = 255;

  const { rowBands, colBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  const withoutProtect = removeGuideLines(bmp, { rowBands, colBands });
  assert.deepEqual([withoutProtect.data[iconIdx], withoutProtect.data[iconIdx + 1], withoutProtect.data[iconIdx + 2], withoutProtect.data[iconIdx + 3]], [0, 0, 0, 0]);

  const withProtect = removeGuideLines(bmp, { rowBands, colBands, protectColor: [110, 110, 110], protectTolerance: 10, protectSoftness: 0 });
  assert.deepEqual([withProtect.data[iconIdx], withProtect.data[iconIdx + 1], withProtect.data[iconIdx + 2], withProtect.data[iconIdx + 3]], [110, 110, 110, 255]);
});

test('detectGuideLines + removeGuideLines: works on both axes at once', () => {
  const w = 200, h = 200;
  const bmp = checkerBitmap(w, h, 8, [255, 255, 255], [192, 192, 192]);
  drawGuideLines(bmp, 'row', [10, 50, 90, 130, 170], () => [150, 150, 150]);
  drawGuideLines(bmp, 'col', [15, 55, 95, 135, 175], () => [160, 160, 160]);

  const { rowBands, colBands } = detectGuideLines([bmp], [255, 255, 255], [192, 192, 192]);
  assert.equal(rowBands.length, 5);
  assert.equal(colBands.length, 5);
  const out = removeGuideLines(bmp, { rowBands, colBands });
  const rowIdx = (10 * w + 60) * 4, colIdx = (60 * w + 15) * 4;
  assert.equal(out.data[rowIdx + 3], 0);
  assert.equal(out.data[colIdx + 3], 0);
});
