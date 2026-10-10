// js/modes/animations/application/pivot.js
// Placing a frame's pivot by pointer on the Animations canvas.
import { autoAnimationOf } from '../../../domain/sprites/auto-layout.js';

const half = v => Math.round(v * 2) / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Frame-local point -> pivot, on the half-pixel grid the Frames panel uses.
export function pivotFromPoint(frame, x, y) {
  return { pivotX: clamp(half(x), 0, frame.w), pivotY: clamp(half(y), 0, frame.h) };
}

// The command that sets it: an auto frame's pivot is its animation's shared
// pivot; a manual frame keeps its own.
export function pivotCommand(sheet, frame, { pivotX, pivotY }) {
  const auto = autoAnimationOf(sheet, frame.id);
  return auto
    ? { id: 'animations.setPivot', args: { sheetId: sheet.id, animationId: auto.id, pivotX, pivotY } }
    : { id: 'sprites.setFramePivot', args: { sheetId: sheet.id, frameId: frame.id, pivotX, pivotY } };
}
