// Palette resolution + nearest-color quantization shared by GIF and C99
// export (both need an indexed palette; sheet pixels are stored as RGBA
// truecolor, see the export-system design doc's "Palette source" section).

// Counts exact RGBA occurrences across one or more bitmaps, most-frequent
// first. Fully-transparent pixels never need a palette slot.
export function colorFrequency(bitmaps) {
  const counts = new Map();
  const order = [];
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const key = `${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`;
      if (!counts.has(key)) order.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return order
    .map(key => ({ key, count: counts.get(key) }))
    .sort((a, b) => b.count - a.count)
    .map(({ key }) => key.split(',').map(Number));
}

// Builds a palette for a set of bitmaps: an indexed source palette's colors
// directly if given, otherwise the bitmaps' own most-frequent distinct
// colors, capped at maxColors.
export function buildPalette(bitmaps, maxColors, sourcePalette = null) {
  if (sourcePalette?.indexed) return sourcePalette.colors.slice(0, maxColors);
  return colorFrequency(bitmaps).slice(0, maxColors);
}

// Maps every pixel of `bmp` to its nearest palette index (0-based, by RGB
// distance -- these target formats have no partial transparency, so alpha
// is ignored once buildPalette has already excluded fully-transparent
// pixels from consideration).
export function quantizeBitmap(bmp, palette) {
  const indices = new Uint8Array(bmp.width * bmp.height);
  const d = bmp.data;
  for (let p = 0; p < indices.length; p++) {
    const i = p * 4;
    let best = 0, bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const pc = palette[c];
      const dist = (pc[0] - d[i]) ** 2 + (pc[1] - d[i + 1]) ** 2 + (pc[2] - d[i + 2]) ** 2;
      if (dist < bestD) { bestD = dist; best = c; }
    }
    indices[p] = best;
  }
  return indices;
}

// Counts pixels by exact (r,g,b) across all bitmaps, skipping alpha === 0
// (mirrors colorFrequency's transparency rule, but keys on RGB only --
// alpha never enters median-cut itself, see the note above
// medianCutPalette; per-pixel alpha handling for the "prefer opaque
// colors" option lives in resolveAlphaForQuantize instead).
function rgbHistogram(bitmaps) {
  const counts = new Map();
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const key = `${d[i]},${d[i + 1]},${d[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([key, count]) => {
    const [r, g, b] = key.split(',').map(Number);
    return { r, g, b, count };
  });
}

function channelRange(box, ch) {
  let min = Infinity, max = -Infinity;
  for (const c of box) {
    const v = ch === 0 ? c.r : ch === 1 ? c.g : c.b;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

// Each entry's pull on box selection/splitting, as count^exponent -- see
// medianCutPalette's "Color balance" note for what exponent means. Kept
// separate from a color's real pixel count (used unweighted in
// averageColor) so the exponent decides which colors WIN a palette slot
// without also distorting the representative shade chosen for that slot.
function weight(c, exponent) { return exponent === 1 ? c.count : Math.pow(c.count, exponent); }

// Weighted sum-of-squared-error a box would contribute at its current
// weighted mean, summed across all 3 channels -- a lightweight Wu-style
// substitute for "biggest raw range" (see widestErrorBoxIndex): a box only
// scores high here if it's both spread out AND made of colors that matter
// under the current weighting, so a huge but visually-flat dithered region
// no longer automatically outranks a smaller, more distinct cluster just
// because its raw numeric range happens to be wider.
function weightedSSE(box, exponent) {
  let sse = 0;
  for (let ch = 0; ch < 3; ch++) {
    let sumW = 0, sumWV = 0, sumWV2 = 0;
    for (const c of box) {
      const v = ch === 0 ? c.r : ch === 1 ? c.g : c.b;
      const w = weight(c, exponent);
      sumW += w; sumWV += w * v; sumWV2 += w * v * v;
    }
    if (sumW > 0) sse += sumWV2 - (sumWV * sumWV) / sumW;
  }
  return sse;
}

// Index of the box (of length >= 2) with the highest weighted SSE; -1 when
// every box has length 1 (nothing left to split -- this is what lets
// medianCutPalette return fewer than maxColors entries when the source has
// few distinct colors).
function widestErrorBoxIndex(boxes, exponent) {
  let idx = -1, best = -1;
  boxes.forEach((box, i) => {
    if (box.length < 2) return;
    const sse = weightedSSE(box, exponent);
    if (sse > best) { best = sse; idx = i; }
  });
  return idx;
}

// Splits `box` on its widest channel (still plain numeric range -- which
// AXIS to cut along doesn't need reweighting, only which box and where
// along it) at the weighted median.
function splitBox(box, exponent) {
  let widestCh = 0, bestRange = -1;
  for (let ch = 0; ch < 3; ch++) {
    const range = channelRange(box, ch);
    if (range > bestRange) { bestRange = range; widestCh = ch; }
  }
  const sorted = [...box].sort((a, b) => {
    const va = widestCh === 0 ? a.r : widestCh === 1 ? a.g : a.b;
    const vb = widestCh === 0 ? b.r : widestCh === 1 ? b.g : b.b;
    return va - vb;
  });
  const total = sorted.reduce((s, c) => s + weight(c, exponent), 0);
  let acc = 0, splitAt = 1;
  for (let i = 0; i < sorted.length; i++) {
    acc += weight(sorted[i], exponent);
    if (acc >= total / 2) { splitAt = i + 1; break; }
  }
  splitAt = Math.min(Math.max(splitAt, 1), sorted.length - 1);
  return [sorted.slice(0, splitAt), sorted.slice(splitAt)];
}

function averageColor(box) {
  let r = 0, g = 0, b = 0, total = 0;
  for (const c of box) {
    r += c.r * c.count; g += c.g * c.count; b += c.b * c.count; total += c.count;
  }
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

// Builds an N-color palette from the given bitmaps via weighted median-cut
// over their opaque pixels' RGB values (alpha is never part of the cut --
// nearestColor/quantizeBitmapToPalette never read a palette entry's alpha,
// only the source pixel's, so it would only add noise). Returns up to
// maxColors [r,g,b] triples, fewer if there are fewer distinct RGB values
// than maxColors in the input.
//
// `weightExponent` is the "Color balance" knob (see filter-controller.js's
// qz-balance UI): each histogram entry pulls on box selection/splitting as
// count^weightExponent. At 1 (Favor common colors, the historical default)
// a color's real pixel count is its full weight, so a large flat/dithered
// region -- many pixels spread across many near-duplicate shades -- can
// dominate every split and leave few slots for smaller, more visually
// distinct clusters. At 0 (Favor distinct colors) every unique shade counts
// equally regardless of population, so that region competes on equal
// footing, one slot at a time, against everything else. 0.5 (Balanced)
// splits the difference. The final representative color for each box is
// still its true count-weighted average (see averageColor) regardless of
// exponent -- this only decides which clusters WIN a slot, never distorts
// the shade chosen to represent one once it has.
export function medianCutPalette(bitmaps, maxColors, weightExponent = 1) {
  const hist = rgbHistogram(bitmaps);
  if (hist.length <= maxColors) return hist.map(c => [c.r, c.g, c.b]);
  let boxes = [hist];
  while (boxes.length < maxColors) {
    const idx = widestErrorBoxIndex(boxes, weightExponent);
    if (idx === -1) break;
    const [left, right] = splitBox(boxes[idx], weightExponent);
    boxes.splice(idx, 1, left, right);
  }
  return boxes.map(averageColor);
}

// Transparency-cleanup pass for the "prefer opaque colors" quantize option:
// decides each opaque-ish pixel's OUTPUT alpha (RGB is left untouched) so
// the result mostly avoids in-between alpha values -- pixels that are
// mostly invisible become fully transparent, pixels that are mostly solid
// become fully opaque, and only a narrow near-opaque band (7%-25%
// transparent) can keep its real alpha, and only when that pixel's exact
// color is common enough to be "important" to the palette (its pixel count
// is at least totalWeight/maxColors -- roughly what an average palette
// slot's share would be, i.e. it would plausibly earn its own slot on its
// own merits). Returns new bitmaps; does not mutate the inputs, since
// callers also need the untouched originals for undo diffing.
export function resolveAlphaForQuantize(bitmaps, maxColors) {
  const hist = rgbHistogram(bitmaps);
  const totalWeight = hist.reduce((s, c) => s + c.count, 0);
  const threshold = totalWeight / maxColors;
  const weightByKey = new Map(hist.map(c => [`${c.r},${c.g},${c.b}`, c.count]));

  return bitmaps.map(bmp => {
    const data = new Uint8ClampedArray(bmp.data);
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0) continue;
      const transparency = 1 - a / 255;
      if (transparency >= 0.75) { data[i + 3] = 0; continue; }
      if (transparency < 0.07) { data[i + 3] = 255; continue; }
      if (transparency < 0.25) {
        const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
        const important = (weightByKey.get(key) ?? 0) >= threshold;
        data[i + 3] = important ? a : 255;
        continue;
      }
      data[i + 3] = 255;
    }
    return { width: bmp.width, height: bmp.height, data };
  });
}
