// Pure, domain-agnostic 2D rect math shared by every mode's pointer/drag tools.

// Normalizes two points into a rect. `inclusive` treats both points as pixel
// indices (create-drag, matches the select-tool marquee convention: w =
// |dx|+1); non-inclusive treats them as rect EDGE coordinates (resize, since
// frame/tile corners already live in that space: f.x, f.x+f.w, ...).
export function rectBetween(ax, ay, bx, by, inclusive) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  if (inclusive) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
