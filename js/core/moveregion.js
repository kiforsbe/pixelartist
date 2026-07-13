import { copyRegion, fillRegion, blitRegion } from './pixels.js';

// Moves the pixels of `rect` by (dx, dy): vacated area becomes transparent,
// pixels landing outside the bitmap are cropped. Returns the union dirty rect
// (old ∪ new, clamped to the bitmap), or null when nothing changes.
export function shiftRegion(bmp, rect, dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(bmp.width, rect.x + rect.w);
  const y1 = Math.min(bmp.height, rect.y + rect.h);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const clip = copyRegion(bmp, x0, y0, w, h);
  fillRegion(bmp, x0, y0, w, h, [0, 0, 0, 0]);
  blitRegion(bmp, clip, x0 + dx, y0 + dy);
  const ux0 = Math.max(0, Math.min(x0, x0 + dx));
  const uy0 = Math.max(0, Math.min(y0, y0 + dy));
  const ux1 = Math.min(bmp.width, Math.max(x1, x1 + dx));
  const uy1 = Math.min(bmp.height, Math.max(y1, y1 + dy));
  return { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
}
