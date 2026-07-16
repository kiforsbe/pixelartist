// Resize a rect by dragging one of 8 handles ('nw','n','ne','e','se','s',
// 'sw','w'), pointer given as PIXEL coords (inclusive: dragging the east
// edge onto pixel column px puts the edge at px+1, matching the marquee
// creation convention w = |dx|+1). Flip-through normalizes (the formerly
// fixed edge becomes a boundary), result is min 1x1 and inside `target`.
export function resizeRect(orig, handle, px, py, target) {
  px = Math.max(target.x, Math.min(target.x + target.w - 1, px));
  py = Math.max(target.y, Math.min(target.y + target.h - 1, py));
  let x0 = orig.x, x1 = orig.x + orig.w;
  let y0 = orig.y, y1 = orig.y + orig.h;
  if (handle.includes('w')) x0 = px;
  if (handle.includes('e')) x1 = px + 1;
  if (handle.includes('n')) y0 = py;
  if (handle.includes('s')) y1 = py + 1;
  let nx0 = Math.min(x0, x1), ny0 = Math.min(y0, y1);
  let nx1 = Math.max(x0, x1), ny1 = Math.max(y0, y1);
  // Degenerate: the dragged edge landed exactly on the fixed edge — pin the
  // 1px rect INSIDE the fixed edge rather than extending 1px past it.
  if (nx1 === nx0) { if (handle.includes('w')) nx0 = nx1 - 1; else nx1 = nx0 + 1; }
  if (ny1 === ny0) { if (handle.includes('n')) ny0 = ny1 - 1; else ny1 = ny0 + 1; }
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}
