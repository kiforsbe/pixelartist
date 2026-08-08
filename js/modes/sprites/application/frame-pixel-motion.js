import { animationGroup, flattenLayers } from '../../../core/model.js';
import { copyRegion, fillRegion, blitRegion } from '../../../core/pixels.js';

// The accepted strip's own layers to move pixels on when repositioning
// `anim`'s frames -- null when `anim` is null (a single plain frame, not
// part of an intact strip) or floating (no layer yet), meaning the caller
// falls back to its own metadata-only behavior. See
// docs/superpowers/specs/2026-07-18-strip-area-constraint-design.md.
export function stripLayersOf(sheet, anim) {
  if (!anim?.strip || !anim.layerGroupId) return null;
  const group = animationGroup(sheet, anim.id);
  return group ? flattenLayers(group) : null;
}

// Pixel-carrying shift for one or more frames sharing a common delta.
// For every layer: copy ALL member regions first (their CURRENT pixels),
// THEN clear all of them, THEN blit all of them at their new positions --
// copying before clearing avoids corruption when member frames are adjacent
// (clearing frame A before copying frame B's original pixels would clobber B
// if A and B overlap/touch). Captures a per-layer clone of the UNION of
// every member's before/after rect so undo restores all pixels and all
// frames' x/y in one step.
//
// NOTE: this eagerly applies the move (pixels and frame x/y). Callers push a
// command whose do() re-applies `after` idempotently -- CommandStack.push
// invokes do() immediately, so the net effect is a single applied move.
export function buildMovePatches(frames, dx, dy, layers) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const patches = layers.map((layer) => {
    const before = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    const copies = frames.map(f => copyRegion(layer.bitmap, f.x, f.y, f.w, f.h));
    for (const f of frames) fillRegion(layer.bitmap, f.x, f.y, f.w, f.h, [0, 0, 0, 0]);
    frames.forEach((f, i) => blitRegion(layer.bitmap, copies[i], f.x + dx, f.y + dy));
    const after = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    return { layer, before, after };
  });
  for (const f of frames) { f.x += dx; f.y += dy; }
  const afterCoords = beforeCoords.map(c => ({ frame: c.frame, x: c.x + dx, y: c.y + dy }));
  return { patches, ur, beforeCoords, afterCoords };
}
