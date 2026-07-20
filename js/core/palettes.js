let nextId = 1;
export const INDEXED_SIZE_PRESETS = [2, 4, 16, 256];

export function newId(prefix) { return `${prefix}${Date.now().toString(36)}${(nextId++).toString(36)}`; }

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

// Mutates `bitmap` in place: every pixel with alpha > 0 is replaced by its
// nearest-RGB-distance match in `palette.colors` (alpha untouched, exact
// per-pixel semantics as nearestColor). Fully transparent pixels are
// skipped -- no visual effect, and skipping avoids bloating an undo diff
// with invisible changes.
export function quantizeBitmapToPalette(bitmap, palette) {
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
