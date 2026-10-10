import { addFrame, removeFrame } from '../../../../core/model.js';
import { sliceGrid } from '../../../../core/slicing.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';
import { isPinnedFrame, PINNED_HINT } from '../../../../domain/sprites/auto-layout.js';

export function findSpriteSheet(project, sheetId) {
  return project?.sheets.find(sheet => sheet.id === sheetId) ?? null;
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function runSheetCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSpriteSheet(project, sheetId), apply, revert);
}

export function createFrame(services, sheetId, rect) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const doc = sheetDocument(sheet);
  const name = `frame_${sheet.frames.length}`;
  let created = null;
  runSheetCommand(services, sheetId, 'add frame',
    target => {
      if (!created) created = addFrame(target, { name, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      else if (!target.frames.includes(created)) target.frames.push(created);
      services.selections.set({ ...services.selections.get(doc), frameId: created.id }, doc);
    },
    target => {
      target.frames = target.frames.filter(f => f !== created);
      if (services.selections.get(doc)?.frameId === created.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    });
}

// A plain (unpinned) frame's delete. contributions.js routes pinned frames
// to animation-layout-commands.js's deleteLaidOutFrame instead.
export function deleteFrame(services, sheetId, frameId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.frames.indexOf(frame);
  // removeFrame rewrites EVERY animation's entries, so undo needs a snapshot
  // of all of them, not just the ones referencing this frame.
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));
  const wasSelected = services.selections.get(doc)?.frameId === frameId;
  runSheetCommand(services, sheetId, 'delete frame',
    target => {
      removeFrame(target, frame.id);
      if (services.selections.get(doc)?.frameId === frame.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    },
    target => {
      target.frames.splice(Math.min(idx, target.frames.length), 0, frame);
      for (const snap of animSnapshots) snap.anim.frames = snap.frames.slice();
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), frameId: frame.id }, doc);
    });
}

export function resizeFrame(services, sheetId, frameId, before, after) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  if (isPinnedFrame(sheet, frameId)) return { ok: false, reason: PINNED_HINT };
  runSheetCommand(services, sheetId, 'resize frame',
    () => { frame.x = after.x; frame.y = after.y; frame.w = after.w; frame.h = after.h; },
    () => { frame.x = before.x; frame.y = before.y; frame.w = before.w; frame.h = before.h; });
  return { ok: true };
}

// Frames are viewports onto the sheet, so moving one is metadata-only. An
// auto-laid-out ("pinned") frame's rect belongs to its layout and is refused.
export function moveFrames(services, sheetId, frameIds, dx, dy) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || (dx === 0 && dy === 0)) return;
  const frames = frameIds.map(id => sheet.frames.find(f => f.id === id)).filter(Boolean);
  if (!frames.length) return;
  if (frames.some(f => isPinnedFrame(sheet, f.id))) return { ok: false, reason: PINNED_HINT };
  const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  runSheetCommand(services, sheetId, frames.length > 1 ? 'move frames' : 'move frame',
    () => { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
    () => { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } });
  return { ok: true };
}

// Slice-grid dialog's Create action, minus the DOM reads. `options` carries
// cellW/cellH/marginX/marginY/spacingX/spacingY/namePrefix already clamped by
// the dialog; sheetWidth/sheetHeight come from the sheet itself.
export function sliceSheetIntoFrames(services, sheetId, options, replace) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const newFrames = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...options });

  const beforeFrames = sheet.frames.slice();
  const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));
  if (replace) {
    sheet.frames = [];
    for (const a of sheet.animations) a.frames = [];
  }
  for (const nf of newFrames) addFrame(sheet, nf);
  const afterFrames = sheet.frames.slice();
  const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));

  runSheetCommand(services, sheetId, 'slice grid',
    target => {
      target.frames = afterFrames.slice();
      for (const snap of afterAnimSnapshots) snap.anim.frames = snap.frames.slice();
    },
    target => {
      target.frames = beforeFrames.slice();
      for (const snap of beforeAnimSnapshots) snap.anim.frames = snap.frames.slice();
    });
}
