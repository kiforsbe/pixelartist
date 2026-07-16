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
  const nx0 = Math.min(x0, x1), ny0 = Math.min(y0, y1);
  const nx1 = Math.max(x0, x1), ny1 = Math.max(y0, y1);
  return { x: nx0, y: ny0, w: Math.max(1, nx1 - nx0), h: Math.max(1, ny1 - ny0) };
}
