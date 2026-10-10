// Screen-space hit-testing for the frame tool's corner handles. Callers pass a
// `toScreen(x, y) -> {x, y}` projector (presentation supplies
// `(x, y) => view.imageToScreen(x, y)`), keeping this module pure.
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';

export const HANDLE_SCREEN_PX = 6;

export function hitHandle(toScreen, frame, sx, sy) {
  if (!frame) return null;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? frame.x : frame.x + frame.w;
    const iy = h[0] === 'n' ? frame.y : frame.y + frame.h;
    const p = toScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}
