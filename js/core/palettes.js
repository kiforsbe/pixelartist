export { newId } from '../domain/shared/ids.js';
import { newId } from '../domain/shared/ids.js';
export const INDEXED_SIZE_PRESETS = [2, 4, 16, 256];

// The color an "unset" slot carries until the user picks something. Real,
// not null: an empty slot is an ordinary color to everything outside the
// editor (brush snapping, quantize, export), and `empty` is only how the
// editor knows to DRAW it as undecided. Per-palette, so a palette whose
// artwork genuinely uses black can move its unset color out of the way.
export const DEFAULT_EMPTY_COLOR = [0, 0, 0, 255];

// `size > 0` creates that many empty slots AND locks the palette to that
// count -- the two are the same decision at creation time. `indexed` is
// independent of both: it only means "snap the brush to these colors, and
// use them as the quantize/export source".
export function createPalette({ name, indexed = false, size = 0, lockReason = '' }) {
  const emptyColor = [...DEFAULT_EMPTY_COLOR];
  return {
    id: newId('pal'), name, indexed,
    colors: Array.from({ length: size }, () => [...emptyColor]),
    empty: Array.from({ length: size }, () => true),
    emptyColor,
    lock: size > 0 ? { size, reason: lockReason } : null,
    ramps: [],
  };
}

// Brings a palette read from a project file up to the current shape. Old
// files have {indexed, size, colors} and none of empty/emptyColor/lock.
// An old indexed palette was fixed-size under the old rules, so locking it
// preserves exactly the behavior the file was saved with; the empty reason
// renders as an unlabeled lock the user can name or clear.
//
// A file written by the current shape is trusted as-is, INCLUDING a null
// lock on an indexed palette -- the two are independent now, and re-deriving
// the lock from `indexed` would silently re-lock a palette the user unlocked.
// `emptyColor`/`lock` are what tell the two apart: serializeProject always
// writes them, and no legacy file has them.
//
// colors.length always wins over a stored lock.size or size: every consumer
// already reads the array, so the count is the array's to state.
export function normalizePalette(raw) {
  const { size: _legacySize, ...rest } = raw;
  const colors = (raw.colors ?? []).map(c => [c[0], c[1], c[2], c[3] ?? 255]);
  const empty = Array.isArray(raw.empty) && raw.empty.length === colors.length
    ? raw.empty.map(Boolean)
    : colors.map(() => false);
  const emptyColor = raw.emptyColor ? [...raw.emptyColor] : [...DEFAULT_EMPTY_COLOR];
  const isCurrentShape = 'emptyColor' in raw || 'lock' in raw;
  const reason = isCurrentShape
    ? (raw.lock ? raw.lock.reason ?? '' : null)
    : (raw.indexed ? '' : null);
  return {
    ...rest, indexed: !!raw.indexed, colors, empty, emptyColor,
    lock: reason !== null && colors.length > 0 ? { size: colors.length, reason } : null,
    // Indices are bounds-checked against this palette's own color count --
    // a saved file can outlive swatches a named ramp once referenced (an
    // edit that removed colors, a hand-edited or corrupted project file).
    ramps: Array.isArray(raw.ramps)
      ? raw.ramps
          .filter(r => r && typeof r.name === 'string' && Array.isArray(r.indices))
          .map(r => ({
            name: r.name,
            indices: r.indices.filter(i => Number.isInteger(i) && i >= 0 && i < colors.length),
          }))
      : [],
  };
}

export function parseHexColors(str) {
  return str.trim().split(/\s+/).map(h => [
    parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16), 255,
  ]);
}

export function setEntry(palette, index, rgba) {
  palette.colors[index] = [...rgba];
  palette.empty[index] = false;
}

// Every helper below maintains `colors` and `empty` together. That pairing
// is the whole cost of keeping `colors` a plain color array (which is what
// lets nearestColor/quantizeBitmapToPalette/serialization stay untouched),
// so nothing outside this file may splice either array on its own.

export function clearEntry(palette, index) {
  palette.colors[index] = [...palette.emptyColor];
  palette.empty[index] = true;
}

// Returns the index written, or -1 when a locked palette has no empty slot
// left. A locked palette fills its first empty slot rather than growing --
// its entry count is the point of the lock.
export function addSwatch(palette, rgba) {
  if (palette.lock) {
    const slot = palette.empty.indexOf(true);
    if (slot === -1) return -1;
    setEntry(palette, slot, rgba);
    return slot;
  }
  palette.colors.push([...rgba]);
  palette.empty.push(false);
  return palette.colors.length - 1;
}

// On a locked palette this CLEARS the slot instead of splicing it out, so
// every index below it keeps its number -- an indexed palette's indices are
// referenced by the artwork, and resequencing them silently would recolor it.
export function removeSwatch(palette, index) {
  if (index < 0 || index >= palette.colors.length) return;
  if (palette.lock) { clearEntry(palette, index); return; }
  palette.colors.splice(index, 1);
  palette.empty.splice(index, 1);
}

export function moveSwatch(palette, from, to) {
  const [c] = palette.colors.splice(from, 1);
  const [e] = palette.empty.splice(from, 1);
  palette.colors.splice(to, 0, c);
  palette.empty.splice(to, 0, e);
}

// The unset color is a per-palette choice, so changing it re-assigns every
// slot still flagged empty -- it stays this palette's unset color rather
// than becoming a one-time fill that later edits drift away from.
export function setEmptyColor(palette, rgba) {
  palette.emptyColor = [...rgba];
  for (let i = 0; i < palette.colors.length; i++) {
    if (palette.empty[i]) palette.colors[i] = [...rgba];
  }
}

// size === null unlocks. Unlocking discards empty slots: they have no
// meaning in a free-growing list. Locking pads with empty slots, or drops
// entries from the end -- the CALLER confirms a lossy truncate first (see
// the manager's setPaletteLock flow); this helper just applies the decision.
export function setLock(palette, size, reason = '') {
  if (size === null) {
    const keep = [];
    for (let i = 0; i < palette.colors.length; i++) if (!palette.empty[i]) keep.push(i);
    palette.colors = keep.map(i => palette.colors[i]);
    palette.empty = keep.map(() => false);
    palette.lock = null;
    return;
  }
  while (palette.colors.length > size) { palette.colors.pop(); palette.empty.pop(); }
  while (palette.colors.length < size) { palette.colors.push([...palette.emptyColor]); palette.empty.push(true); }
  palette.lock = { size, reason };
}

// Greys have no hue; -1 parks them ahead of every real hue rather than
// scattering them through the ramp at an arbitrary angle.
function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return -1;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export function lumaOf([r, g, b]) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// Returns an index permutation rather than sorted colors, so the caller can
// carry `empty` (and anything else parallel) through the same reordering --
// see applyOrder. Ties break by original index, so a sort is deterministic
// and re-sorting an already-sorted palette is a no-op.
// mode: 'hue' | 'luminance' | 'usage'. `usage` is a per-slot count array
// (see countPaletteUsage); most-used sorts first.
export function sortOrder(colors, mode, usage = null) {
  const key = mode === 'hue' ? i => hueOf(colors[i])
    : mode === 'luminance' ? i => lumaOf(colors[i])
    : i => -(usage?.[i] ?? 0);
  return colors.map((_, i) => i).sort((a, b) => key(a) - key(b) || a - b);
}

export function applyOrder(palette, order) {
  palette.colors = order.map(i => palette.colors[i]);
  palette.empty = order.map(i => palette.empty[i]);
}

// Per-slot exact-RGBA hit counts across `bitmaps`. Duplicate colors in the
// palette all report against their first slot; fully transparent pixels are
// never counted (they need no palette entry).
export function countPaletteUsage(palette, bitmaps) {
  const counts = palette.colors.map(() => 0);
  const index = new Map();
  palette.colors.forEach((c, i) => { const k = c.join(','); if (!index.has(k)) index.set(k, i); });
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const at = index.get(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      if (at !== undefined) counts[at]++;
    }
  }
  return counts;
}

export function nearestColor(palette, rgba) {
  let best = null, bestD = Infinity;
  for (const c of palette.colors) {
    const d = (c[0]-rgba[0])**2 + (c[1]-rgba[1])**2 + (c[2]-rgba[2])**2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? [best[0], best[1], best[2], rgba[3]] : [...rgba];
}

// Nearest AND second-nearest colors by squared RGB distance, plus how far
// along the segment from the nearest to the second-nearest `rgba` actually
// projects (t=0 -> exactly the nearest color, t=1 -> exactly the
// second-nearest). Used by ditherOrdered to generalize Bayer dithering to
// an arbitrary, possibly tiny and unevenly-spaced palette: a classic Bayer
// matrix assumes evenly-spaced per-channel quantization levels, which a
// hand-picked or median-cut palette never has, so instead of thresholding
// each channel independently, threshold how far the true color sits
// between its two closest palette entries.
function nearestTwoColors(colors, rgba) {
  let bestI = -1, bestD = Infinity, secondI = -1, secondD = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    const d = (c[0]-rgba[0])**2 + (c[1]-rgba[1])**2 + (c[2]-rgba[2])**2;
    if (d < bestD) { secondD = bestD; secondI = bestI; bestD = d; bestI = i; }
    else if (d < secondD) { secondD = d; secondI = i; }
  }
  if (secondI === -1) return { a: colors[bestI], b: colors[bestI], t: 0 };
  const a = colors[bestI], b = colors[secondI];
  const abx = b[0]-a[0], aby = b[1]-a[1], abz = b[2]-a[2];
  const lenSq = abx*abx + aby*aby + abz*abz;
  let t = 0;
  if (lenSq > 0) {
    t = Math.max(0, Math.min(1, ((rgba[0]-a[0])*abx + (rgba[1]-a[1])*aby + (rgba[2]-a[2])*abz) / lenSq));
  }
  return { a, b, t };
}

// Values 0-15 arranged so adjacent cells differ maximally -- the standard
// 4x4 Bayer threshold matrix.
const BAYER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// Ordered/Bayer dithering: no error propagation (unlike the diffusion
// methods below), so it can't smear across large flat regions -- trades
// that safety for a fixed, visible grid pattern. See nearestTwoColors for
// why this compares a PROJECTION against the threshold rather than
// thresholding raw channel values.
function ditherOrdered(bitmap, palette) {
  const { width, data } = bitmap;
  const count = data.length / 4;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    const x = p % width, y = (p / width) | 0;
    const threshold = (BAYER_4X4[y % 4][x % 4] + 0.5) / 16;
    const { a, b, t } = nearestTwoColors(palette.colors, [data[i], data[i + 1], data[i + 2], data[i + 3]]);
    const c = t > threshold ? b : a;
    data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
  }
}

// Floyd-Steinberg: the standard general-purpose error-diffusion kernel.
const FLOYD_STEINBERG_KERNEL = [
  { dx: 1, dy: 0, w: 7 / 16 },
  { dx: -1, dy: 1, w: 3 / 16 },
  { dx: 0, dy: 1, w: 5 / 16 },
  { dx: 1, dy: 1, w: 1 / 16 },
];
// Atkinson: only 6/8 of the error is redistributed (the rest is simply
// dropped), which keeps near-white/near-black regions closer to their true
// value at the cost of slightly less accurate midtones -- the classic
// original-Macintosh look.
const ATKINSON_KERNEL = [
  { dx: 1, dy: 0, w: 1 / 8 }, { dx: 2, dy: 0, w: 1 / 8 },
  { dx: -1, dy: 1, w: 1 / 8 }, { dx: 0, dy: 1, w: 1 / 8 }, { dx: 1, dy: 1, w: 1 / 8 },
  { dx: 0, dy: 2, w: 1 / 8 },
];

// Shared error-diffusion pass: quantizes pixels in scanline order against a
// float working copy of their (possibly error-adjusted) RGB value, then
// pushes each pixel's own quantization error forward onto not-yet-visited
// neighbors per `kernel`. Error never crosses into or out of a transparent
// pixel -- diffusing color into empty space (or losing error into it) would
// leak a visible tint across what should stay invisible.
function ditherErrorDiffusion(bitmap, palette, kernel) {
  const { width, height, data } = bitmap;
  const work = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    work[p * 3] = data[i]; work[p * 3 + 1] = data[i + 1]; work[p * 3 + 2] = data[i + 2];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x, i = p * 4;
      if (data[i + 3] === 0) continue;
      const wi = p * 3;
      const src = [work[wi], work[wi + 1], work[wi + 2]];
      const out = nearestColor(palette, [src[0], src[1], src[2], data[i + 3]]);
      data[i] = out[0]; data[i + 1] = out[1]; data[i + 2] = out[2];
      const er = src[0] - out[0], eg = src[1] - out[1], eb = src[2] - out[2];
      for (const { dx, dy, w } of kernel) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const np = ny * width + nx;
        if (data[np * 4 + 3] === 0) continue;
        const nwi = np * 3;
        work[nwi] += er * w; work[nwi + 1] += eg * w; work[nwi + 2] += eb * w;
      }
    }
  }
}

// Mutates `bitmap` in place: every pixel with alpha > 0 is replaced by a
// color from `palette.colors` (alpha untouched). Fully transparent pixels
// are skipped -- no visual effect, and skipping avoids bloating an undo
// diff with invisible changes. `dither` picks how pixels between palette
// entries get approximated: 'none' (default, plain nearest-color) hands
// back exactly the historical behavior; 'ordered', 'floyd-steinberg' and
// 'atkinson' trade that for a closer visual match to the source using far
// fewer colors, at the cost of a patterned or noisy result -- see
// ditherOrdered/ditherErrorDiffusion for how each works.
export function quantizeBitmapToPalette(bitmap, palette, dither = 'none') {
  if (dither === 'ordered') return ditherOrdered(bitmap, palette);
  if (dither === 'floyd-steinberg') return ditherErrorDiffusion(bitmap, palette, FLOYD_STEINBERG_KERNEL);
  if (dither === 'atkinson') return ditherErrorDiffusion(bitmap, palette, ATKINSON_KERNEL);
  const d = bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b, a] = nearestColor(palette, [d[i], d[i + 1], d[i + 2], d[i + 3]]);
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
}

export function remapColor(bitmap, from, to) {
  let count = 0;
  const d = bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === from[0] && d[i+1] === from[1] && d[i+2] === from[2] && d[i+3] === from[3]) {
      d[i] = to[0]; d[i+1] = to[1]; d[i+2] = to[2]; d[i+3] = to[3];
      count++;
    }
  }
  return count;
}
