import { state, markDirty } from '../../app/state.js';
import { segmentsOf, segmentMembers } from '../../core/strips.js';
import { frameBounds } from '../../domain/sprites/frames.js';

export function commitFrameField(frame, key, value) {
  const before = frame[key];
  if (before === value) return;
  state.commands.push({
    label: `edit frame ${key}`,
    do() { frame[key] = value; },
    undo() { frame[key] = before; },
  });
  markDirty();
}

export function stripMembers(sheet, animation) {
  return animation.frames
    .map(entry => sheet.frames.find(frame => frame.id === entry.frameId))
    .filter(Boolean);
}

function commitStripEdit(label, members, mutate) {
  const snapshot = () => members.map(frame =>
    [frame.x, frame.y, frame.w, frame.h, frame.pivotX, frame.pivotY]);
  const apply = values => members.forEach((frame, index) => {
    [frame.x, frame.y, frame.w, frame.h, frame.pivotX, frame.pivotY] = values[index];
  });
  const before = snapshot();
  mutate();
  const after = snapshot();
  state.commands.push({
    label,
    do() { apply(after); },
    undo() { apply(before); },
  });
  markDirty();
}

export function moveStripTo(sheet, members, nextX, nextY) {
  const bounds = frameBounds(members);
  const dx = Math.max(-bounds.x, Math.min(sheet.width - bounds.x - bounds.w, Math.round(nextX) - bounds.x));
  const dy = Math.max(-bounds.y, Math.min(sheet.height - bounds.y - bounds.h, Math.round(nextY) - bounds.y));
  if (dx === 0 && dy === 0) return;
  commitStripEdit('move strip', members, () => {
    for (const frame of members) { frame.x += dx; frame.y += dy; }
  });
}

export function setStripFrameSize(sheet, animation, members, key, value) {
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
  commitStripEdit(`strip frame ${key}`, members, () => {
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

export function setStripPivot(members, key, value) {
  if (members.every(frame => frame[key] === value)) return;
  commitStripEdit('strip pivot', members, () => {
    for (const frame of members) frame[key] = value;
  });
}
