// js/modes/sprites/application/commands/animation-frame-commands.js
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

export const AUTO_TIMELINE = 'This animation is auto-laid-out: use the animations.* frame commands';

// Shared shape for every structural edit to an animation's `frames` array:
// clone before/after arrays of {frameId, duration, step} entries so do()/undo()
// just swap the whole array. `anim` is a stable object reference (never
// replaced by these commands), so do()/undo() mutate it directly and don't
// need runSheetCommand's `target` parameter -- runSheetCommand is still used
// for the store transaction + dirty flag + history push.
function commitFramesChange(services, sheetId, anim, label, beforeFrames, afterFrames) {
  runSheetCommand(services, sheetId, label,
    () => { anim.frames = afterFrames.map(f => ({ ...f })); },
    () => { anim.frames = beforeFrames.map(f => ({ ...f })); });
}

function findAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  return sheet?.animations.find(a => a.id === animationId) ?? null;
}

export function addAnimationFrame(services, sheetId, animationId, frameId) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  if (anim.layout === 'auto') return { ok: false, reason: AUTO_TIMELINE };
  const before = anim.frames.map(f => ({ ...f }));
  const after = [...before, { frameId, duration: null, step: null }];
  commitFramesChange(services, sheetId, anim, 'add frame to animation', before, after);
  return { ok: true };
}

export function removeAnimationFrame(services, sheetId, animationId, index) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  if (anim.layout === 'auto') return { ok: false, reason: AUTO_TIMELINE };
  const before = anim.frames.map(f => ({ ...f }));
  const after = before.filter((_, i) => i !== index);
  commitFramesChange(services, sheetId, anim, 'remove frame from animation', before, after);
  return { ok: true };
}

export function reorderAnimationFrame(services, sheetId, animationId, fromIndex, toIndex) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  if (anim.layout === 'auto') return { ok: false, reason: AUTO_TIMELINE };
  const before = anim.frames.map(f => ({ ...f }));
  const after = before.slice();
  const [item] = after.splice(fromIndex, 1);
  after.splice(Math.max(0, Math.min(after.length, toIndex)), 0, item);
  commitFramesChange(services, sheetId, anim, 'reorder animation frame', before, after);
  return { ok: true };
}

export function setAnimationFrameDuration(services, sheetId, animationId, index, duration) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].duration === duration) return;
  const after = before.map((f, i) => (i === index ? { ...f, duration } : f));
  commitFramesChange(services, sheetId, anim, 'edit frame duration', before, after);
}

export function setAnimationFrameStep(services, sheetId, animationId, index, step) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].step === step) return;
  const after = before.map((f, i) => (i === index ? { ...f, step } : f));
  commitFramesChange(services, sheetId, anim, 'edit frame step', before, after);
}
