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
// A custom mask's bitmap dimensions are attacker-controlled the moment file
// import exists (Task 12): a brush file claiming {width:1e9,height:1e9}
// would otherwise reach `new Uint8Array(width*height)` in rasterizeMask and
// throw RangeError on the first paint, after import appeared to succeed.
// 256 is far beyond any real brush -- MAX_MASK_SIZE (16) already bounds the
// scalar square/circle masks -- so this only ever clips hostile input.
export const MAX_CUSTOM_BITMAP_DIM = 256;

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
    pattern: raw.pattern ?? 'checker',
    rampName: raw.rampName ?? null,
    replaceColor: raw.replaceColor ?? null,
  };
}

// Default pressure ranges are per target, because the targets are measured in
// different units. A single 1..8 default suits `size` (pixels) and is close to
// useless for `opacity`, where it would swing a stroke over 1%..8% of full
// density -- invisible paint at maximum pen pressure. `shade-step` counts ramp
// entries, and a typical ramp is 4-6 long, so a range wider than a few steps
// saturates before the pen does.
// Exported (Task 15a) so the brush manager's min/max inputs can drive their
// own `min`/`max` HTML attributes from the same table rather than a second,
// hand-copied one -- otherwise a `shade-step` brush's max input would go on
// offering 100 after the target switched away from `opacity`. Exporting
// changes nothing here: the values and normalizePressure's own clamping
// (always 0..100, regardless of target) are unchanged.
export const PRESSURE_RANGES = {
  none: [1, 8],
  size: [1, 8],
  opacity: [0, 100],
  'shade-step': [1, 3],
};

function normalizePressure(raw = {}) {
  const target = oneOf(raw.target, PRESSURE_TARGETS, 'none');
  const [defMin, defMax] = PRESSURE_RANGES[target];
  return {
    target,
    // An explicit range always wins; these defaults only fill in for a brush
    // that never named one.
    min: clampInt(raw.min, 0, 100, defMin),
    max: clampInt(raw.max, 0, 100, defMax),
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

// Shared by both custom-bitmap branches below. Clamps to MAX_CUSTOM_BITMAP_DIM
// so no declared dimension can make `emptyGrid`'s `new Uint8Array(w*h)` throw
// -- this is the last line of defence and must not depend on a parser having
// already validated the file (see brush-io.js's parseBrushJson for the other
// half: rejecting a hostile file outright instead of silently clamping it).
// Negative/NaN inputs fall back to 1 exactly as before this cap existed.
function clampCustomDim(v) {
  const n = Math.trunc(v) || 0;
  return Math.max(1, Math.min(MAX_CUSTOM_BITMAP_DIM, n));
}

// `mask.colors` is the stamp ink's per-cell payload (see brush-io.js's
// bitmapToBrush): one entry per source cell, aligned to the SOURCE bitmap's
// bits -- not to `grid`, whose dimensions may already be clamped/truncated.
// Attached onto `grid` only where the bit is actually set, so a caller never
// has to null-check bit-vs-colour agreement itself.
function attachColors(grid, colors) {
  if (!Array.isArray(colors) || !colors.length) return;
  const out = new Array(grid.bits.length).fill(null);
  const n = Math.min(out.length, colors.length);
  for (let i = 0; i < n; i++) if (grid.bits[i]) out[i] = colors[i] ?? null;
  grid.colors = out;
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
      const width = clampCustomDim(bmp.width);
      const height = clampCustomDim(bmp.height);
      const grid = emptyGrid(width, height);
      const n = Math.min(grid.bits.length, bmp.bits.length ?? 0);
      for (let i = 0; i < n; i++) grid.bits[i] = bmp.bits[i] ? 1 : 0;
      attachColors(grid, mask.colors);
      return grid;
    }
    if (bmp.data) {
      const width = clampCustomDim(bmp.width);
      const height = clampCustomDim(bmp.height);
      const grid = emptyGrid(width, height);
      for (let i = 0, p = 0; i < grid.bits.length; i++, p += 4) {
        grid.bits[i] = bmp.data[p + 3] > 0 ? 1 : 0;
      }
      attachColors(grid, mask.colors);
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
  if (deg === 0) {
    const out = { width: grid.width, height: grid.height, bits: Uint8Array.from(grid.bits) };
    if (grid.colors) out.colors = grid.colors.slice();
    return out;
  }
  const { width: w, height: h, bits } = grid;
  const swapped = deg === 90 || deg === 270;
  const out = emptyGrid(swapped ? h : w, swapped ? w : h);
  if (grid.colors) out.colors = new Array(out.bits.length).fill(null);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      let nx, ny;
      if (deg === 90) { nx = h - 1 - y; ny = x; }
      else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      out.bits[ny * out.width + nx] = 1;
      if (grid.colors) out.colors[ny * out.width + nx] = grid.colors[y * w + x];
    }
  }
  return out;
}

export function flipMaskGrid(grid, flipH, flipV) {
  if (!flipH && !flipV) {
    const out = { width: grid.width, height: grid.height, bits: Uint8Array.from(grid.bits) };
    if (grid.colors) out.colors = grid.colors.slice();
    return out;
  }
  const { width: w, height: h, bits } = grid;
  const out = emptyGrid(w, h);
  if (grid.colors) out.colors = new Array(out.bits.length).fill(null);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      const nx = flipH ? w - 1 - x : x;
      const ny = flipV ? h - 1 - y : y;
      out.bits[ny * w + nx] = 1;
      if (grid.colors) out.colors[ny * w + nx] = grid.colors[y * w + x];
    }
  }
  return out;
}

// `options.rotate` is the per-stamp override rotateJitter supplies; it
// composes with the brush's own static rotation.
//
// A mask's colour payload (`mask.colors`, carried through
// rasterizeMask/rotate/flip above) is returned unconditionally here --
// whether the active ink actually wants it is NOT this function's decision.
// An earlier version of this function withheld `colors` itself based on a
// caller-supplied ink hint; that failed open (a caller that passed nothing
// -- every real call site -- kept the payload) and put ink taxonomy in a
// mask function, which is the same anti-pattern `usesSecondary` exists to
// avoid one layer over (Ruling 38). The payload is instead withheld at the
// one place that already knows, per-ink, whether it wants one:
// brush-ink.js's `ink.usesMaskColors`, consulted by pixels.js's `stamp()`.
export function maskGridFor(mask, options = {}) {
  let grid = rasterizeMask(mask);
  const rotate = (mask.rotate ?? 0) + (options.rotate ?? 0);
  grid = rotateMaskGrid(grid, rotate);
  return flipMaskGrid(grid, !!mask.flipH, !!mask.flipV);
}

// --- pressure -----------------------------------------------------------
//
// Pressure is honored ONLY for a pen. A mouse reports a constant pressure of
// 0.5 (or 1.0 while a button is held) and touch reports wildly inconsistent
// values across devices, so without this guard every mouse user would get a
// brush behaving as though it were held at half pressure forever.

export function applyCurve(t, curve) {
  const x = Math.max(0, Math.min(1, t));
  if (curve === 'soft') return x * x;
  if (curve === 'hard') return 1 - (1 - x) * (1 - x);
  return x;
}

export function pressureValue(brush, pressure, pointerType) {
  const p = brush.pressure;
  if (!p || p.target === 'none') return null;
  if (pointerType !== 'pen') return null;
  const t = applyCurve(Number(pressure) || 0, p.curve);
  // Every target quantizes: no fractional sizes, no continuous opacity.
  return Math.round(p.min + (p.max - p.min) * t);
}

export function effectiveMaskSize(brush, pressure, pointerType) {
  // Guarded the same way pressureValue guards `p`, so the two siblings behave
  // alike on a brush that somehow arrived without a pressure block.
  if (!brush.pressure || brush.pressure.target !== 'size') return brush.mask.size;
  const v = pressureValue(brush, pressure, pointerType);
  if (v === null) return brush.mask.size;
  return Math.max(1, Math.min(MAX_MASK_SIZE, v));
}
