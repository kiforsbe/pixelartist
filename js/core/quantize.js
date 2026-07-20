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
// alpha never enters median-cut, see the note above medianCutPalette).
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

// Index of the box (of length >= 2) with the widest range on any RGB
// channel; -1 when every box has length 1 (nothing left to split -- this
// is what lets medianCutPalette return fewer than maxColors entries when
// the source has few distinct colors).
function widestBoxIndex(boxes) {
  let idx = -1, bestRange = -1;
  boxes.forEach((box, i) => {
    if (box.length < 2) return;
    for (let ch = 0; ch < 3; ch++) {
      const range = channelRange(box, ch);
      if (range > bestRange) { bestRange = range; idx = i; }
    }
  });
  return idx;
}

// Splits `box` on its widest channel at the count-weighted median.
function splitBox(box) {
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
  const total = sorted.reduce((s, c) => s + c.count, 0);
  let acc = 0, splitAt = 1;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i].count;
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
export function medianCutPalette(bitmaps, maxColors) {
  const hist = rgbHistogram(bitmaps);
  if (hist.length <= maxColors) return hist.map(c => [c.r, c.g, c.b]);
  let boxes = [hist];
  while (boxes.length < maxColors) {
    const idx = widestBoxIndex(boxes);
    if (idx === -1) break;
    const [left, right] = splitBox(boxes[idx]);
    boxes.splice(idx, 1, left, right);
  }
  return boxes.map(averageColor);
}
