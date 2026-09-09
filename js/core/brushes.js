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
