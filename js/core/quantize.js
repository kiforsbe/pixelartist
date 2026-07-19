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
