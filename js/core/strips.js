// Free-space finder for auto-placing animation strips. Candidate positions are
// the sheet origin plus every existing frame's right/bottom edge — the only
// places a first-fit rectangle can start.
export function findFreeRect(sheet, w, h) {
  if (w > sheet.width || h > sheet.height) return null;
  const frames = sheet.frames;
  const xs = [...new Set([0, ...frames.map(f => f.x + f.w)])]
    .filter(x => x >= 0 && x + w <= sheet.width).sort((a, b) => a - b);
  const ys = [...new Set([0, ...frames.map(f => f.y + f.h)])]
    .filter(y => y >= 0 && y + h <= sheet.height).sort((a, b) => a - b);
  for (const y of ys)
    for (const x of xs)
      if (!frames.some(f => x < f.x + f.w && f.x < x + w && y < f.y + f.h && f.y < y + h))
        return { x, y };
  return null;
}

export function buildStripFrames(name, x, y, frameW, frameH, count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${name}_${i}`, x: x + i * frameW, y, w: frameW, h: frameH,
    pivotX: 0, pivotY: 0,
  }));
}
