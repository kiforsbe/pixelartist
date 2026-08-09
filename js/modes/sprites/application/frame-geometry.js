// Pure sheet-space math for the frame/strip tool. Everything here takes the
// data it needs as explicit parameters (no legacy `state`, no CanvasView, no
// module-level singletons), so it unit-tests with plain object literals.

export { rectBetween } from '../../../core/rect.js';

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

export function frameAt(sheet, x, y) {
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h) return f;
  }
  return null;
}

// An animation's entry list resolved to frame objects, in animation order.
// Skips dangling frameIds defensively.
export function stripMembers(sheet, animation) {
  return animation.frames
    .map(entry => sheet.frames.find(frame => frame.id === entry.frameId))
    .filter(Boolean);
}

// Clamps a common drag delta so the whole bounding box (single frame or every
// strip member) stays fully on-sheet — no pixels are silently clipped by an
// out-of-bounds copy/blit (pixels.js bounds-checks every write/read).
export function clampMoveDelta(sheet, bbox, delta) {
  return {
    dx: Math.max(-bbox.x, Math.min(sheet.width - (bbox.x + bbox.w), delta.dx)),
    dy: Math.max(-bbox.y, Math.min(sheet.height - (bbox.y + bbox.h), delta.dy)),
  };
}

// Pointer travel past the dragged edge, in whole frame widths, added to the
// segment's starting member count. Never below 1, never past the sheet edge.
export function stripResizeCount(sheet, drag, pointerX) {
  const raw = drag.side === 'right'
    ? pointerX - (drag.bbox.x + drag.bbox.w)
    : drag.bbox.x - pointerX;
  let count = drag.count0 + Math.round(raw / drag.fw);
  count = Math.max(1, count);
  if (sheet) {
    const maxCount = drag.side === 'right'
      ? Math.floor((sheet.width - drag.bbox.x) / drag.fw)
      : Math.floor((drag.bbox.x + drag.bbox.w) / drag.fw);
    count = Math.min(count, Math.max(1, maxCount));
  }
  return count;
}

// Ghost rect for an in-progress edge-grip resize: grows/shrinks from the
// dragged end while the opposite edge stays put.
export function resizeGhostRect(drag) {
  const w = drag.count * drag.fw;
  const x = drag.side === 'right' ? drag.bbox.x : drag.bbox.x + drag.bbox.w - w;
  return { x, y: drag.bbox.y, w, h: drag.bbox.h };
}
