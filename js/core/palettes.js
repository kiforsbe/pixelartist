export { newId } from '../domain/shared/ids.js';
import { newId } from '../domain/shared/ids.js';
export const INDEXED_SIZE_PRESETS = [2, 4, 16, 256];

export function createPalette({ name, indexed = false, size = 0 }) {
  const colors = indexed ? Array.from({ length: size }, () => [0, 0, 0, 255]) : [];
  return { id: newId('pal'), name, indexed, size: indexed ? size : 0, colors };
}

export function parseHexColors(str) {
  return str.trim().split(/\s+/).map(h => [
    parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16), 255,
  ]);
}

export function setEntry(palette, index, rgba) { palette.colors[index] = [...rgba]; }

export function addSwatch(palette, rgba) {
  if (palette.indexed) throw new Error('indexed palette has fixed size');
  palette.colors.push([...rgba]);
}

export function removeSwatch(palette, index) {
  if (palette.indexed) throw new Error('indexed palette has fixed size');
  palette.colors.splice(index, 1);
}

export function moveSwatch(palette, from, to) {
  const [c] = palette.colors.splice(from, 1);
  palette.colors.splice(to, 0, c);
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
