// js/modes/animations/application/timeline-model.js
// Pure column/tag math for the Animations timeline (spec §3 "Timeline"):
// every animation's entries, animation after animation in sheet order, under
// one lane of tags. Frames that belong to no animation have no column.
import { regionHasPixels } from '../../../core/pixels.js';
import { effectiveDuration } from '../../../core/model.js';

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

// The duration shown under a frame number: the held step of an fps-based
// animation (frame-duration-input.js edits a step there), else its ms.
export function entryDurationLabel(anim, entry) {
  if (anim.baseFps != null) return `×${entry.step ?? anim.baseStep ?? 1}`;
  return `${effectiveDuration(anim, entry)}ms`;
}

const DIRECTION_GLYPHS = { forward: '→', reverse: '←', pingpong: '⇄', 'pingpong-reverse': '⇆' };

// A tag's playback-direction mark.
export function directionGlyph(direction) {
  return DIRECTION_GLYPHS[direction] ?? DIRECTION_GLYPHS.forward;
}

// True when `column` lies in `range` ({ animationId, from, to }, inclusive).
export function columnInRange(column, range) {
  return !!range && column.animationId === range.animationId && column.index >= range.from && column.index <= range.to;
}

// What dragging a tag's `edge` ('start' | 'end') by `delta` columns (right
// positive) does to an animation of `length` entries: outward adds `count`
// frames at entry `at`, inward cuts entries [from..to] -- never the last one.
// -> { op: 'add', at, count } | { op: 'cut', from, to } | null.
export function edgeDragPlan(length, edge, delta) {
  const grow = edge === 'end' ? delta : -delta;
  if (grow > 0) return { op: 'add', at: edge === 'end' ? length : 0, count: grow };
  const cut = Math.min(-grow, length - 1);
  if (cut <= 0) return null;
  return edge === 'end' ? { op: 'cut', from: length - cut, to: length - 1 } : { op: 'cut', from: 0, to: cut - 1 };
}
