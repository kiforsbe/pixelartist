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
//
// `refine` runs the box-split result through refinePalette's perceptual
// Lloyd/K-means pass (see its own comment for why box-splitting alone can
// leave a slot's average dragged away from the color that actually
// dominates it). It's the "Perceptual refinement" UI checkbox -- on by
// default since it never makes the match worse, but it costs extra passes
// over the histogram, which matters when findMinimalColorCount calls this
// once per candidate count.
export function medianCutPalette(bitmaps, maxColors, weightExponent = 1, refine = true) {
  const hist = rgbHistogram(bitmaps);
  if (hist.length <= maxColors) return hist.map(c => [c.r, c.g, c.b]);
  let boxes = [hist];
  while (boxes.length < maxColors) {
    const idx = widestErrorBoxIndex(boxes, weightExponent);
    if (idx === -1) break;
    const [left, right] = splitBox(boxes[idx], weightExponent);
    boxes.splice(idx, 1, left, right);
  }
  const initial = boxes.map(averageColor);
  return refine ? refinePalette(hist, initial) : initial;
}

// Lloyd/K-means relaxation over medianCutPalette's box-split centroids.
// Median-cut makes each split once and never revisits it, so a box can end
// up "contaminated" by a handful of unrelated, low-count colors that simply
// happened to fall inside its boundary -- e.g. a checkerboard's true
// (0,0,0) squares coming out as something like (39,39,39) because a few
// unrelated dark sprite pixels got lumped into the same box and dragged its
// average away from the value that actually dominates it. Each round
// reassigns every distinct histogram color to whichever CURRENT centroid it
// is nearest to (ignoring weightExponent -- that only decided which
// clusters WON a slot; this step just finds the truest center for the slots
// already won) and recomputes each centroid as the real count-weighted mean
// of its new members, same as averageColor. Stops as soon as no color's
// assignment changes, or after `maxIterations` rounds.
function refinePalette(hist, initialColors, maxIterations = 6) {
  let centroids = initialColors.map(c => [...c]);
  let assignments = null;
  for (let iter = 0; iter < maxIterations; iter++) {
    const next = hist.map(c => {
      let best = 0, bestD = Infinity;
      for (let k = 0; k < centroids.length; k++) {
        const cc = centroids[k];
        const d = (c.r - cc[0]) ** 2 + (c.g - cc[1]) ** 2 + (c.b - cc[2]) ** 2;
        if (d < bestD) { bestD = d; best = k; }
      }
      return best;
    });
    const converged = assignments !== null && next.every((v, i) => v === assignments[i]);
    assignments = next;
    const sums = centroids.map(() => ({ r: 0, g: 0, b: 0, w: 0 }));
    for (let i = 0; i < hist.length; i++) {
      const c = hist[i], s = sums[assignments[i]];
      s.r += c.r * c.count; s.g += c.g * c.count; s.b += c.b * c.count; s.w += c.count;
    }
    centroids = sums.map((s, k) => s.w > 0 ? [Math.round(s.r / s.w), Math.round(s.g / s.w), Math.round(s.b / s.w)] : centroids[k]);
    if (converged) break;
  }
  return centroids;
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

// 0-100 "match" score for one candidate palette against its source bitmap:
// 100 = every opaque pixel landed exactly on its original color, 0 = as far
// off (on average) as black vs. white can get. Fully-transparent pixels are
// excluded, mirroring quantizeBitmapToPalette's own alpha-skip rule --
// `indices` still has one entry per pixel (quantizeBitmap always assigns
// one, ignoring alpha), only the scoring ignores the transparent ones.
const MAX_RGB_DISTANCE = Math.sqrt(3 * 255 * 255);
function matchScore(original, indices, palette) {
  const d = original.data;
  let sum = 0, count = 0;
  for (let p = 0; p < indices.length; p++) {
    const i = p * 4;
    if (d[i + 3] === 0) continue;
    const c = palette[indices[p]];
    const dr = d[i] - c[0], dg = d[i + 1] - c[1], db = d[i + 2] - c[2];
    sum += Math.sqrt(dr * dr + dg * dg + db * db);
    count++;
  }
  return count === 0 ? 100 : 100 * (1 - (sum / count) / MAX_RGB_DISTANCE);
}

// Finds the smallest color count in [1, ceiling] whose median-cut palette
// reproduces `bitmaps` at or above `targetPercent` match (see matchScore) --
// mirrors pngquant's "quality" option (search for the least colors that
// still hit a quality bar) rather than committing to a fixed count up
// front. Falls back to `ceiling` itself when even the full budget can't
// reach the target. `weightExponent` is passed straight through to
// medianCutPalette so the Color-balance setting still applies to every
// candidate the sweep tries.
export function findMinimalColorCount(bitmaps, ceiling, weightExponent, targetPercent, refine = true) {
  for (let n = 1; n <= ceiling; n++) {
    const palette = medianCutPalette(bitmaps, n, weightExponent, refine);
    if (!palette.length) continue;
    const scores = bitmaps.map(bmp => matchScore(bmp, quantizeBitmap(bmp, palette), palette));
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    if (avg >= targetPercent) return n;
  }
  return ceiling;
}
