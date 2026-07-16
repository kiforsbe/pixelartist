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

function stamp(bmp, x, y, rgba, size) {
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) setPixel(bmp, x + dx, y + dy, rgba);
}

export function drawLine(bmp, x0, y0, x1, y1, rgba, size = 1) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(bmp, x0, y0, rgba, size);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function drawRect(bmp, x0, y0, x1, y1, rgba, filled) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++)
    for (let x = xa; x <= xb; x++)
      if (filled || x === xa || x === xb || y === ya || y === yb)
        setPixel(bmp, x, y, rgba);
}

export function drawEllipse(bmp, x0, y0, x1, y1, rgba, filled) {
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
  const rx = (xb - xa) / 2, ry = (yb - ya) / 2;
  const cx = xa + rx, cy = ya + ry;
  if (rx < 0.5 || ry < 0.5) { drawRect(bmp, xa, ya, xb, yb, rgba, true); return; }
  // scanline test against ellipse equation; outline = inside but a 1px-shrunk ellipse misses
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const nx = (x + 0.5 - (cx + 0.5)) / (rx + 0.5);
      const ny = (y + 0.5 - (cy + 0.5)) / (ry + 0.5);
      const inside = nx * nx + ny * ny <= 1;
      if (!inside) continue;
      if (filled) { setPixel(bmp, x, y, rgba); continue; }
      const ix = (x + 0.5 - (cx + 0.5)) / Math.max(rx - 0.5, 0.5);
      const iy = (y + 0.5 - (cy + 0.5)) / Math.max(ry - 0.5, 0.5);
      if (ix * ix + iy * iy > 1) setPixel(bmp, x, y, rgba);
    }
  }
}

export function floodFill(bmp, x, y, rgba, contiguous = true) {
  const target = getPixel(bmp, x, y);
  if (!target || colorsEqual(target, rgba)) return null;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const mark = (px, py) => {
    setPixel(bmp, px, py, rgba);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  };
  if (!contiguous) {
    for (let py = 0; py < bmp.height; py++)
      for (let px = 0; px < bmp.width; px++)
        if (colorsEqual(getPixel(bmp, px, py), target)) mark(px, py);
  } else {
    const stack = [[x, y]];
    while (stack.length) {
      const [px, py] = stack.pop();
      if (!colorsEqual(getPixel(bmp, px, py), target)) continue;
      mark(px, py);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
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
