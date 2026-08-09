// Pure sheet-space frame stepping for the frame editor's Prev/Next controls.
// Walks the given animation's frame order when `frame` belongs to it, else
// falls back to sheet frame order. Clamped (no wraparound) at either end.
// `frame` must be the actual object reference held in `sheet.frames` when no
// animation match is found -- the sheet-order fallback locates it via
// `sheet.frames.indexOf(frame)`, matching the original frameeditor.js's
// `currentFrame()`-sourced usage.

export function computeNeighborFrame(sheet, frame, animation, dir) {
  if (animation) {
    const pos = animation.frames.findIndex(af => af.frameId === frame.id);
    if (pos !== -1) {
      const idx = Math.max(0, Math.min(animation.frames.length - 1, pos + dir));
      if (idx === pos) return null;
      const id = animation.frames[idx].frameId;
      return sheet.frames.find(fr => fr.id === id) ?? null;
    }
  }
  const idx2 = sheet.frames.indexOf(frame);
  const ni = Math.max(0, Math.min(sheet.frames.length - 1, idx2 + dir));
  if (ni === idx2) return null;
  return sheet.frames[ni] ?? null;
}
