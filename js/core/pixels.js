export function createBitmap(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneBitmap(bmp) {
  return { width: bmp.width, height: bmp.height, data: new Uint8ClampedArray(bmp.data) };
}

export function colorsEqual(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function getPixel(bmp, x, y) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return null;
  const i = (y * bmp.width + x) * 4;
  return [bmp.data[i], bmp.data[i + 1], bmp.data[i + 2], bmp.data[i + 3]];
}

export function setPixel(bmp, x, y, rgba) {
  if (x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return;
  const i = (y * bmp.width + x) * 4;
  bmp.data[i] = rgba[0]; bmp.data[i + 1] = rgba[1];
  bmp.data[i + 2] = rgba[2]; bmp.data[i + 3] = rgba[3];
}

// A write goes through the ink when one is supplied, and straight to the
// bitmap otherwise. Keeping the fallback here means every existing caller --
// layer compositing in model.js, snapping in pixelSnapper.js -- is unchanged.
//
// `rgba` is handed to the ink as its SOURCE COLOUR rather than dropped. A
// primitive can vary the colour across its own geometry -- drawRect and
// drawEllipse paint an outline in `rgba` and an interior in `filled` -- and
// an ink that has no colour of its own to insist on (solid, dither, replace,
// lock-alpha, stamp) must honour that, or a two-colour filled shape collapses
// to a single flat colour. An ink is still free to ignore it: ramp-shade
// derives its output from the destination pixel, so a source colour is
// meaningless there.
function put(bmp, x, y, rgba, ink) {
  if (ink) ink.write(bmp, x, y, rgba);
  else setPixel(bmp, x, y, rgba);
}

// `grid` is an optional 1-bit mask ({width,height,bits}); without one the
// stamp is a filled `size` x `size` square, which is the historical shape.
// Masks anchor on their CENTER so the cursor sits in the middle of the brush.
export function stamp(bmp, x, y, rgba, size, ink = null, grid = null) {
  if (grid) {
    const halfX = (grid.width - 1) >> 1, halfY = (grid.height - 1) >> 1;
    for (let gy = 0; gy < grid.height; gy++)
      for (let gx = 0; gx < grid.width; gx++) {
        const i = gy * grid.width + gx;
        if (!grid.bits[i]) continue;
        // A custom mask's own per-cell colour payload (the `stamp` ink's
        // stock in trade) travels ON THE GRID, not as a second argument --
        // see brushes.js's maskGridFor, which is what decides whether a
        // grid built for a non-stamp ink carries `colors` at all.
        const color = grid.colors ? (grid.colors[i] ?? rgba) : rgba;
        put(bmp, x + gx - halfX, y + gy - halfY, color, ink);
      }
    return;
  }
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) put(bmp, x + dx, y + dy, rgba, ink);
}

export function drawLine(bmp, x0, y0, x1, y1, rgba, size = 1, ink = null, grid = null) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(bmp, x0, y0, rgba, size, ink, grid);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// `filled` may be `true` (interior = rgba) or an rgba array (two-color shape:
// rgba outline, `filled` interior); falsy draws the outline only.
export function drawRect(bmp, x0, y0, x1, y1, rgba, filled, ink = null) {
  const fill = filled === true ? rgba : filled;
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++)
    for (let x = xa; x <= xb; x++) {
      if (x === xa || x === xb || y === ya || y === yb) put(bmp, x, y, rgba, ink);
      else if (fill) put(bmp, x, y, fill, ink);
    }
}

export function drawEllipse(bmp, x0, y0, x1, y1, rgba, filled, ink = null) {
  const fill = filled === true ? rgba : filled;
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  const rx = (xb - xa) / 2, ry = (yb - ya) / 2;
  const cx = xa + rx, cy = ya + ry;
  if (rx < 0.5 || ry < 0.5) { drawRect(bmp, xa, ya, xb, yb, rgba, true, ink); return; }
  // scanline test against ellipse equation; outline = inside but a 1px-shrunk ellipse misses
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const nx = (x + 0.5 - (cx + 0.5)) / (rx + 0.5);
      const ny = (y + 0.5 - (cy + 0.5)) / (ry + 0.5);
      const inside = nx * nx + ny * ny <= 1;
      if (!inside) continue;
      const ix = (x + 0.5 - (cx + 0.5)) / Math.max(rx - 0.5, 0.5);
      const iy = (y + 0.5 - (cy + 0.5)) / Math.max(ry - 0.5, 0.5);
      if (ix * ix + iy * iy > 1) put(bmp, x, y, rgba, ink);
      else if (fill) put(bmp, x, y, fill, ink);
    }
  }
}

// The contiguous branch tracks visited pixels with an explicit `seen` array
// (the same pattern softFloodFill already uses below), NOT by checking
// whether a pixel still equals `target`. An ink is free to decline to write
// -- opacity < 100, ramp-shade off-ramp, replace on a non-match, lock-alpha
// on a transparent pixel all do this routinely -- and a skipped pixel still
// equals `target`, so colour-as-visited-marker pushes it back onto the stack
// forever whenever two skipped pixels are orthogonally adjacent (e.g. a
// dots25 dither pattern). See task-8-brief-amendment.md (Ruling 24).
export function floodFill(bmp, x, y, rgba, contiguous = true, ink = null) {
  const target = getPixel(bmp, x, y);
  if (!target || colorsEqual(target, rgba)) return null;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  // Bounds cover the region test, not what the ink actually wrote: the
  // caller uses this as a dirty rect, and a pixel the ink skipped inside the
  // region still needs repainting (its neighbours' writes may show through).
  const mark = (px, py) => {
    put(bmp, px, py, rgba, ink);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  };
  if (!contiguous) {
    for (let py = 0; py < bmp.height; py++)
      for (let px = 0; px < bmp.width; px++)
        if (colorsEqual(getPixel(bmp, px, py), target)) mark(px, py);
  } else {
    const seen = new Uint8Array(bmp.width * bmp.height);
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= bmp.width || py >= bmp.height) continue;
      const index = py * bmp.width + px;
      if (seen[index]) continue;
      seen[index] = 1;
      if (!colorsEqual(getPixel(bmp, px, py), target)) continue;
      mark(px, py);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Floods pixels similar to the untouched seed color. Tolerance is a maximum
// per-channel RGBA distance; feather extends that range with a linear falloff.
// Fill blends toward `rgba`; erase blends toward transparent black.
export function softFloodFill(bmp, x, y, rgba, {
  mode = 'fill', tolerance = 0, feather = 0, contiguous = true,
} = {}, ink = null) {
  const seed = getPixel(bmp, x, y);
  if (!seed) return null;
  const source = new Uint8ClampedArray(bmp.data);
  const t = Math.max(0, Math.min(255, Number(tolerance) || 0));
  const f = Math.max(0, Math.min(255, Number(feather) || 0));
  const edge = t + f;
  const target = mode === 'erase' ? [0, 0, 0, 0] : rgba;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;

  const sourcePixel = (px, py) => {
    if (px < 0 || py < 0 || px >= bmp.width || py >= bmp.height) return null;
    const i = (py * bmp.width + px) * 4;
    return [source[i], source[i + 1], source[i + 2], source[i + 3]];
  };
  const strengthAt = (px, py) => {
    const p = sourcePixel(px, py);
    if (!p) return 0;
    const dist = Math.max(...p.map((v, i) => Math.abs(v - seed[i])));
    if (dist <= t) return 1;
    if (f <= 0 || dist >= edge) return 0;
    return (edge - dist) / f;
  };
  const apply = (px, py, strength) => {
    if (ink) {
      // An ink writes hard, palette-safe pixels and has no notion of partial
      // coverage, so under one the feather stops blending and becomes a
      // threshold -- the usual way to binarize a coverage mask. Blending here
      // would invent colours outside the palette, which is the one thing this
      // editor exists to prevent.
      if (strength < 0.5) return;
      // `target` -- not `rgba` -- is this primitive's source colour, because
      // `target` is already the answer to "what does this operation write":
      // `rgba` for a fill, transparent black for an erase. In fill mode the
      // two are the same value, so that path is untouched; in erase mode
      // passing `rgba` would have meant a right-click erase painting the ink's
      // primary instead of erasing, which is what it used to do.
      //
      // Erase still goes THROUGH the ink rather than round it. A brush that
      // paints at 50% density therefore erases at 50% density -- a feathered
      // erase, which is the point. Bypassing the ink here would silently
      // discard the brush the user chose.
      //
      // A transparent source colour lands as a clean [0,0,0,0]: brush-ink's
      // writePixel normalises an alpha-0 result, so an indexed palette cannot
      // snap the erased pixel back to a coloured-but-invisible entry.
      ink.write(bmp, px, py, target);
      // Bounds grow for every pixel OFFERED to the ink, not only those it
      // chose to paint -- same reasoning as floodFill's: the caller uses this
      // as a dirty rect, and a pixel the ink declined still needs repainting.
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      return;
    }
    const p = sourcePixel(px, py);
    const out = p.map((v, i) => Math.round(v + (target[i] - v) * strength));
    if (colorsEqual(p, out)) return;
    setPixel(bmp, px, py, out);
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  };

  if (!contiguous) {
    for (let py = 0; py < bmp.height; py++)
      for (let px = 0; px < bmp.width; px++) {
        const strength = strengthAt(px, py);
        if (strength > 0) apply(px, py, strength);
      }
  } else {
    const seen = new Uint8Array(bmp.width * bmp.height);
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= bmp.width || py >= bmp.height) continue;
      const index = py * bmp.width + px;
      if (seen[index]) continue;
      seen[index] = 1;
      const strength = strengthAt(px, py);
      if (strength <= 0) continue;
      apply(px, py, strength);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function copyRegion(bmp, x, y, w, h) {
  const out = createBitmap(w, h);
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      const p = getPixel(bmp, x + dx, y + dy);
      if (p) setPixel(out, dx, dy, p);
    }
  return out;
}

export function blitRegion(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      setPixel(dst, dx + x, dy + y, getPixel(src, x, y));
}

// Source-over alpha blend of `src` onto `dst` at (dx, dy) — unlike blitRegion
// (raw replace, transparent pixels erase), this composites: transparent source
// pixels leave dst untouched. Out-of-bounds writes are skipped.
export function blitOver(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const p = getPixel(src, x, y);
      if (!p || p[3] === 0) continue;
      const q = getPixel(dst, dx + x, dy + y);
      if (!q) continue;
      const sa = p[3] / 255, da = q[3] / 255;
      const oa = sa + da * (1 - sa);
      const mix = (sc, dc) => oa === 0 ? 0 : Math.round((sc * sa + dc * da * (1 - sa)) / oa);
      setPixel(dst, dx + x, dy + y, [mix(p[0], q[0]), mix(p[1], q[1]), mix(p[2], q[2]), Math.round(oa * 255)]);
    }
}

export function fillRegion(bmp, x, y, w, h, rgba) {
  for (let py = y; py < y + h; py++)
    for (let px = x; px < x + w; px++) setPixel(bmp, px, py, rgba);
}

// Nearest-neighbor resize -- pixel-art content should never end up blurred
// by interpolation, even when destW/destH doesn't evenly divide bmp's size.
export function scaleBitmap(bmp, destW, destH) {
  const out = createBitmap(destW, destH);
  for (let y = 0; y < destH; y++) {
    const sy = Math.min(bmp.height - 1, Math.floor((y * bmp.height) / destH));
    for (let x = 0; x < destW; x++) {
      const sx = Math.min(bmp.width - 1, Math.floor((x * bmp.width) / destW));
      setPixel(out, x, y, getPixel(bmp, sx, sy));
    }
  }
  return out;
}

export function flipBitmap(bmp, flipH, flipV) {
  const out = createBitmap(bmp.width, bmp.height);
  for (let y = 0; y < bmp.height; y++)
    for (let x = 0; x < bmp.width; x++) {
      const tx = flipH ? bmp.width - 1 - x : x;
      const ty = flipV ? bmp.height - 1 - y : y;
      setPixel(out, tx, ty, getPixel(bmp, x, y));
    }
  return out;
}
