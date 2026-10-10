// js/modes/animations/application/timeline-model.js
// Pure column/tag math for the Animations timeline (spec §3 "Timeline"):
// every animation's entries, animation after animation in sheet order, under
// one lane of tags. Frames that belong to no animation have no column.
import { regionHasPixels } from '../../../core/pixels.js';

export function timelineColumns(sheet) {
  const columns = [];
  for (const anim of sheet?.animations ?? []) {
    const seen = new Set();
    anim.frames.forEach((entry, index) => {
      columns.push({ animationId: anim.id, index, frameId: entry.frameId, linked: seen.has(entry.frameId) });
      seen.add(entry.frameId);
    });
  }
  return columns;
}

export function tagSpans(sheet) {
  const spans = [];
  let start = 0;
  for (const anim of sheet?.animations ?? []) {
    if (anim.frames.length) spans.push({ animationId: anim.id, name: anim.name, start, length: anim.frames.length });
    start += anim.frames.length;
  }
  return spans;
}

// The selected column: the remembered entry while it still holds the
// selected frame, else the animation's first use of that frame (undo/redo
// and the layout commands patch frameId, not entryIndex). -1 when none.
export function selectedColumn(columns, { animationId, frameId, entryIndex } = {}) {
  const exact = columns.findIndex(c => c.animationId === animationId && c.index === entryIndex && c.frameId === frameId);
  if (exact !== -1) return exact;
  return columns.findIndex(c => c.animationId === animationId && c.frameId === frameId);
}

// A cel is filled when the layer has pixels inside the frame's rect.
export function celFilled(sheet, layer, frameId) {
  const f = sheet.frames.find(fr => fr.id === frameId);
  return !!f && regionHasPixels(layer.bitmap, f.x, f.y, f.w, f.h);
}
