// Brush model. Pure data + validation; no DOM, no host access.
//
// A brush is two independent axes: a MASK (which pixels a stroke touches) and
// an INK (what value is written there). Keeping them separate is what lets a
// handful of masks and inks combine into a large brush vocabulary.

import { newId } from '../domain/shared/ids.js';

export const MASK_KINDS = ['square', 'circle', 'custom'];
export const INK_KINDS = ['solid', 'ramp-shade', 'dither', 'stamp', 'lock-alpha', 'replace'];
export const PRESSURE_TARGETS = ['none', 'size', 'opacity', 'shade-step'];
export const PRESSURE_CURVES = ['linear', 'soft', 'hard'];
export const MAX_MASK_SIZE = 16;

export function newBrushId() {
  return newId('brush_');
}

function clampInt(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

// Quarter turns only. Anything that is not already a multiple of 90 is not
// representable losslessly, so it snaps to 0 rather than being resampled.
function normalizeRotate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const r = ((Math.round(n) % 360) + 360) % 360;
  return r % 90 === 0 ? r : 0;
}

function normalizeMask(raw = {}) {
  return {
    kind: oneOf(raw.kind, MASK_KINDS, 'square'),
    size: clampInt(raw.size, 1, MAX_MASK_SIZE, 1),
    bitmap: raw.bitmap ?? null,
    colors: raw.colors ?? null,
    spacing: clampInt(raw.spacing, 1, 64, 1),
    scatter: clampInt(raw.scatter, 0, 64, 0),
    rotate: normalizeRotate(raw.rotate),
    flipH: !!raw.flipH,
    flipV: !!raw.flipV,
    rotateJitter: !!raw.rotateJitter,
  };
}

function normalizeInk(raw = {}) {
  return {
    kind: oneOf(raw.kind, INK_KINDS, 'solid'),
    opacity: clampInt(raw.opacity, 0, 100, 100),
    trueAlpha: !!raw.trueAlpha,
    jitter: clampInt(raw.jitter, 0, 8, 0),
    pattern: raw.pattern ?? 'bayer4',
    rampName: raw.rampName ?? null,
    replaceColor: raw.replaceColor ?? null,
  };
}

function normalizePressure(raw = {}) {
  return {
    target: oneOf(raw.target, PRESSURE_TARGETS, 'none'),
    min: clampInt(raw.min, 0, 100, 1),
    max: clampInt(raw.max, 0, 100, 8),
    curve: oneOf(raw.curve, PRESSURE_CURVES, 'linear'),
  };
}

export function normalizeBrush(raw = {}) {
  return {
    id: raw.id ?? newBrushId(),
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Brush',
    mask: normalizeMask(raw.mask),
    ink: normalizeInk(raw.ink),
    pressure: normalizePressure(raw.pressure),
  };
}

export function createBrush({ id, name = 'Brush', mask, ink, pressure } = {}) {
  return normalizeBrush({ id, name, mask, ink, pressure });
}

// `stamp` ink paints the mask's own color payload, so it is meaningless
// without one. The manager blocks the combination rather than saving a brush
// that would silently behave as `solid`.
export function validateBrush(brush) {
  if (brush.ink.kind === 'stamp' && brush.mask.kind !== 'custom') {
    return { ok: false, reason: 'Stamp ink requires a custom mask' };
  }
  if (brush.mask.kind === 'custom' && !brush.mask.bitmap) {
    return { ok: false, reason: 'Custom mask requires a bitmap' };
  }
  if (brush.ink.kind === 'replace' && !brush.ink.replaceColor) {
    return { ok: false, reason: 'Replace ink requires a target color' };
  }
  return { ok: true, reason: '' };
}

// Built-ins get fixed literal ids instead of newBrushId()'s process-specific
// counter. A saved project embeds brush ids, and Task 12's mergeIncoming
// dedupe matches an incoming brush against the library by id -- a random id
// per process would make every built-in in an opened project a "new" brush
// that never matches the library's own copy, duplicating it on every open.
export const DEFAULT_BRUSH = createBrush({
  id: 'brush_builtin_square1', name: 'Pixel', mask: { kind: 'square', size: 1 },
});

export const BUILTIN_BRUSHES = [
  DEFAULT_BRUSH,
  createBrush({ id: 'brush_builtin_square2', name: 'Square 2', mask: { kind: 'square', size: 2 } }),
  createBrush({ id: 'brush_builtin_square3', name: 'Square 3', mask: { kind: 'square', size: 3 } }),
  createBrush({ id: 'brush_builtin_circle3', name: 'Circle 3', mask: { kind: 'circle', size: 3 } }),
  createBrush({ id: 'brush_builtin_circle5', name: 'Circle 5', mask: { kind: 'circle', size: 5 } }),
];

// --- mask rasterization and lossless transforms -------------------------
//
// A mask grid is 1-bit: { width, height, bits } where bits[y*width+x] is 0
// or 1. There is deliberately no alpha channel here -- a brush cannot
// produce partial coverage, which is what keeps every stroke pixel-crisp.

function emptyGrid(width, height) {
  return { width, height, bits: new Uint8Array(width * height) };
}

export function rasterizeMask(mask) {
  const size = Math.max(1, Math.min(MAX_MASK_SIZE, mask.size ?? 1));
  if (mask.kind === 'custom') {
    const bmp = mask.bitmap;
    if (!bmp) return emptyGrid(1, 1);
    // A custom mask may arrive as a 1-bit grid already, or as an RGBA bitmap
    // whose opaque pixels define coverage. Validation only checks that
    // `bitmap` is present, not that its shape is coherent, so guard against
    // a malformed one (missing dimensions/data) rather than trusting it.
    if (bmp.bits) {
      const width = Math.max(1, Math.trunc(bmp.width) || 0);
      const height = Math.max(1, Math.trunc(bmp.height) || 0);
      const grid = emptyGrid(width, height);
      const n = Math.min(grid.bits.length, bmp.bits.length ?? 0);
      for (let i = 0; i < n; i++) grid.bits[i] = bmp.bits[i] ? 1 : 0;
      return grid;
    }
    if (bmp.data) {
      const width = Math.max(1, Math.trunc(bmp.width) || 0);
      const height = Math.max(1, Math.trunc(bmp.height) || 0);
      const grid = emptyGrid(width, height);
      for (let i = 0, p = 0; i < grid.bits.length; i++, p += 4) {
        grid.bits[i] = bmp.data[p + 3] > 0 ? 1 : 0;
      }
      return grid;
    }
    return emptyGrid(1, 1);
  }
  const grid = emptyGrid(size, size);
  if (mask.kind === 'square' || size <= 2) {
    grid.bits.fill(1);
    return grid;
  }
  if (size === 3) {
    // At size 3, r = 1.5 so r^2 = 2.25 -- the corner distance^2 is exactly 2,
    // so the disc formula below never excludes a corner and size 3 would
    // render as a solid square indistinguishable from Square 3. Real
    // pixel-art tools (Aseprite, GraphicsGale) special-case the 3px round
    // brush as a plus/cross instead, so we do too:
    //   .#.
    //   ###
    //   .#.
    grid.bits.set([0, 1, 0, 1, 1, 1, 0, 1, 0]);
    return grid;
  }
  // Disc test against the pixel center, which keeps small odd sizes
  // symmetric and avoids the lopsided discs a corner test produces.
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r, dy = y + 0.5 - r;
      grid.bits[y * size + x] = dx * dx + dy * dy <= r * r ? 1 : 0;
    }
  }
  return grid;
}

// Clockwise quarter turns. Every source pixel lands on exactly one
// destination pixel, so the set-pixel count is invariant.
export function rotateMaskGrid(grid, degrees) {
  const deg = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  if (deg === 0) return { width: grid.width, height: grid.height, bits: Uint8Array.from(grid.bits) };
  const { width: w, height: h, bits } = grid;
  const swapped = deg === 90 || deg === 270;
  const out = emptyGrid(swapped ? h : w, swapped ? w : h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      let nx, ny;
      if (deg === 90) { nx = h - 1 - y; ny = x; }
      else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      out.bits[ny * out.width + nx] = 1;
    }
  }
  return out;
}

export function flipMaskGrid(grid, flipH, flipV) {
  if (!flipH && !flipV) return { width: grid.width, height: grid.height, bits: Uint8Array.from(grid.bits) };
  const { width: w, height: h, bits } = grid;
  const out = emptyGrid(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      const nx = flipH ? w - 1 - x : x;
      const ny = flipV ? h - 1 - y : y;
      out.bits[ny * w + nx] = 1;
    }
  }
  return out;
}

// `options.rotate` is the per-stamp override rotateJitter supplies; it
// composes with the brush's own static rotation.
export function maskGridFor(mask, options = {}) {
  let grid = rasterizeMask(mask);
  const rotate = (mask.rotate ?? 0) + (options.rotate ?? 0);
  grid = rotateMaskGrid(grid, rotate);
  return flipMaskGrid(grid, !!mask.flipH, !!mask.flipV);
}
