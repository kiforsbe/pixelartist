export function frameBounds(frames) {
  const x = Math.min(...frames.map(frame => frame.x));
  const y = Math.min(...frames.map(frame => frame.y));
  const right = Math.max(...frames.map(frame => frame.x + frame.w));
  const bottom = Math.max(...frames.map(frame => frame.y + frame.h));
  return { x, y, w: right - x, h: bottom - y };
}

// The topmost frame (last in sheet.frames) containing the pixel (x, y).
export function frameAt(sheet, x, y) {
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h) return f;
  }
  return null;
}
