import { isPinnedFrame, PINNED_HINT, spriteSizeHint } from '../../../../domain/sprites/auto-layout.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

const GEOMETRY_KEYS = new Set(['x', 'y', 'w', 'h', 'pivotX', 'pivotY']);

// A pinned frame keeps its name editable; its rect and pivot belong to the
// auto layout (the shared pivot is animations.setPivot).
export function setFrameField(services, sheetId, frameId, key, value) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  if (GEOMETRY_KEYS.has(key) && isPinnedFrame(sheet, frameId)) return { ok: false, reason: PINNED_HINT };
  const size = sheet.spriteSize;
  if (size && ((key === 'w' && value !== size.w) || (key === 'h' && value !== size.h))) return { ok: false, reason: spriteSizeHint(size) };
  const before = frame[key];
  if (before === value) return { ok: true };
  runSheetCommand(services, sheetId, `edit frame ${key}`,
    () => { frame[key] = value; },
    () => { frame[key] = before; });
  return { ok: true };
}

// Both pivot coordinates as one history step (a pivot drag on the
// Animations canvas). A pinned frame's pivot is animations.setPivot.
export function setFramePivot(services, sheetId, frameId, pivotX, pivotY) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  if (isPinnedFrame(sheet, frameId)) return { ok: false, reason: PINNED_HINT };
  const before = { pivotX: frame.pivotX, pivotY: frame.pivotY };
  if (before.pivotX === pivotX && before.pivotY === pivotY) return { ok: true };
  runSheetCommand(services, sheetId, 'edit frame pivot',
    () => { frame.pivotX = pivotX; frame.pivotY = pivotY; },
    () => { Object.assign(frame, before); });
  return { ok: true };
}
