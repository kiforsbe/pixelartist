// Returns the intact strip animation containing a frame. A broken-apart
// animation retains its frame entries but no longer owns frame geometry.
export function stripForFrame(sheet, frameId) {
  if (!sheet) return null;
  return sheet.animations.find(animation =>
    animation.strip && animation.frames.some(entry => entry.frameId === frameId)) ?? null;
}
