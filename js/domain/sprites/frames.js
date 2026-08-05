export function frameBounds(frames) {
  const x = Math.min(...frames.map(frame => frame.x));
  const y = Math.min(...frames.map(frame => frame.y));
  const right = Math.max(...frames.map(frame => frame.x + frame.w));
  const bottom = Math.max(...frames.map(frame => frame.y + frame.h));
  return { x, y, w: right - x, h: bottom - y };
}
