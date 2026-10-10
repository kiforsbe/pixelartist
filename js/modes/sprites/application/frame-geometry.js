// Pure sheet-space math for the frame tool. Everything here takes the
// data it needs as explicit parameters (no legacy `state`, no CanvasView, no
// module-level singletons), so it unit-tests with plain object literals.

export { rectBetween } from '../../../core/rect.js';
export { frameAt } from '../../../domain/sprites/frames.js';

export function snapValue(value, options) {
  if (!options?.snap) return value;
  const g = Math.max(1, options.gridSize);
  return Math.round(value / g) * g;
}

export function snapPoint(x, y, options) {
  return { x: snapValue(x, options), y: snapValue(y, options) };
}

export function snapRect(rect, options) {
  if (!options?.snap) return rect;
  const g = Math.max(1, options.gridSize);
  const x0 = Math.round(rect.x / g) * g;
  const y0 = Math.round(rect.y / g) * g;
  const x1 = Math.round((rect.x + rect.w) / g) * g;
  const y1 = Math.round((rect.y + rect.h) / g) * g;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

// Clamps a drag delta so the frame's whole bounding box stays fully on-sheet.
export function clampMoveDelta(sheet, bbox, delta) {
  return {
    dx: Math.max(-bbox.x, Math.min(sheet.width - (bbox.x + bbox.w), delta.dx)),
    dy: Math.max(-bbox.y, Math.min(sheet.height - (bbox.y + bbox.h), delta.dy)),
  };
}
