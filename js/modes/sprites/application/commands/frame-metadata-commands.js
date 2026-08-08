import { segmentsOf, segmentMembers } from '../../../../core/strips.js';
import { frameBounds } from '../../../../domain/sprites/frames.js';
import { stripMembers } from '../frame-geometry.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function resolveStrip(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const animation = sheet?.animations.find(a => a.id === animationId) ?? null;
  const members = sheet && animation ? stripMembers(sheet, animation) : [];
  return { sheet, animation, members };
}

export function setFrameField(services, sheetId, frameId, key, value) {
  const frame = findSpriteSheet(services.projects.project, sheetId)?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const before = frame[key];
  if (before === value) return;
  runSheetCommand(services, sheetId, `edit frame ${key}`,
    () => { frame[key] = value; },
    () => { frame[key] = before; });
}

// Whole-member x/y/w/h/pivot snapshot before and after `mutate`, so any strip
// geometry edit becomes one reversible command regardless of how many frames
// it touched.
function commitStripEdit(services, sheetId, label, members, mutate) {
  const snapshot = () => members.map(frame =>
    [frame.x, frame.y, frame.w, frame.h, frame.pivotX, frame.pivotY]);
  const apply = values => members.forEach((frame, index) => {
    [frame.x, frame.y, frame.w, frame.h, frame.pivotX, frame.pivotY] = values[index];
  });
  const before = snapshot();
  mutate();
  const after = snapshot();
  runSheetCommand(services, sheetId, label, () => apply(after), () => apply(before));
}

export function moveStripTo(services, sheetId, animationId, nextX, nextY) {
  const { sheet, members } = resolveStrip(services, sheetId, animationId);
  if (!sheet || !members.length) return;
  const bounds = frameBounds(members);
  const dx = Math.max(-bounds.x, Math.min(sheet.width - bounds.x - bounds.w, Math.round(nextX) - bounds.x));
  const dy = Math.max(-bounds.y, Math.min(sheet.height - bounds.y - bounds.h, Math.round(nextY) - bounds.y));
  if (dx === 0 && dy === 0) return;
  commitStripEdit(services, sheetId, 'move strip', members, () => {
    for (const frame of members) { frame.x += dx; frame.y += dy; }
  });
}

export function setStripFrameSize(services, sheetId, animationId, key, value) {
  const { sheet, animation, members } = resolveStrip(services, sheetId, animationId);
  if (!sheet || !animation || !members.length) return;
  let next = Math.max(1, Math.round(value));
  if (key === 'w') {
    for (const run of segmentsOf(animation)) {
      const runMembers = segmentMembers(sheet, animation, run);
      if (runMembers.length) next = Math.min(next, Math.floor((sheet.width - runMembers[0].x) / runMembers.length));
    }
  } else {
    for (const frame of members) next = Math.min(next, sheet.height - frame.y);
  }
  next = Math.max(1, next);
  if (members.every(frame => frame[key] === next)) return;
  commitStripEdit(services, sheetId, `strip frame ${key}`, members, () => {
    if (key === 'w') {
      for (const run of segmentsOf(animation)) {
        const runMembers = segmentMembers(sheet, animation, run);
        let x = runMembers[0]?.x ?? 0;
        for (const frame of runMembers) { frame.x = x; frame.w = next; x += next; }
      }
    } else {
      for (const frame of members) frame.h = next;
    }
  });
}

export function setStripPivot(services, sheetId, animationId, key, value) {
  const { members } = resolveStrip(services, sheetId, animationId);
  if (!members.length) return;
  if (members.every(frame => frame[key] === value)) return;
  commitStripEdit(services, sheetId, 'strip pivot', members, () => {
    for (const frame of members) frame[key] = value;
  });
}
