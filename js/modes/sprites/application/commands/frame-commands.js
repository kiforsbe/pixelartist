import { addFrame, removeFrame } from '../../../../core/model.js';
import { sliceGrid } from '../../../../core/slicing.js';
import { blitRegion } from '../../../../core/pixels.js';
import { emit, markDirty } from '../../../../app/state.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';
import { stripLayersOf, buildMovePatches } from '../frame-pixel-motion.js';

export function findSpriteSheet(project, sheetId) {
  return project?.sheets.find(sheet => sheet.id === sheetId) ?? null;
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

// markDirty() keeps the legacy title-bar/unsaved-changes guard in sync with
// every do/undo until Phase 4 unifies the two state stores.
export function runSheetCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSpriteSheet(project, sheetId), apply, revert);
  markDirty();
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
  emit('selection');
}

// Shared by the keyboard Delete handler and the frames panel's Delete button.
export function deleteFrame(services, sheetId, frameId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.frames.indexOf(frame);
  // removeFrame rewrites EVERY animation's entries/breaks, so undo needs a
  // snapshot of all of them, not just the ones referencing this frame.
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = services.selections.get(doc)?.frameId === frameId;
  runSheetCommand(services, sheetId, 'delete frame',
    target => {
      removeFrame(target, frame.id);
      if (services.selections.get(doc)?.frameId === frame.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    },
    target => {
      target.frames.splice(Math.min(idx, target.frames.length), 0, frame);
      for (const snap of animSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), frameId: frame.id }, doc);
    });
  emit('selection');
}

export function resizeFrame(services, sheetId, frameId, before, after) {
  const frame = findSpriteSheet(services.projects.project, sheetId)?.frames.find(f => f.id === frameId);
  if (!frame) return;
  runSheetCommand(services, sheetId, 'resize frame',
    () => { frame.x = after.x; frame.y = after.y; frame.w = after.w; frame.h = after.h; },
    () => { frame.x = before.x; frame.y = before.y; frame.w = before.w; frame.h = before.h; });
}

// Frames are viewports onto the sheet, so dragging a PLAIN frame or a still-
// FLOATING strip is metadata-only. An ACCEPTED strip owns its own layers, so
// its frames carry their pixels with them instead of leaving them behind.
export function moveFrames(services, sheetId, frameIds, dx, dy, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || (dx === 0 && dy === 0)) return;
  const frames = frameIds.map(id => sheet.frames.find(f => f.id === id)).filter(Boolean);
  if (!frames.length) return;
  const anim = animationId ? sheet.animations.find(a => a.id === animationId) ?? null : null;
  const label = frames.length > 1 ? 'move strip' : 'move frame';
  const layers = stripLayersOf(sheet, anim);

  if (!layers) {
    const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
    runSheetCommand(services, sheetId, label,
      () => { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
      () => { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } });
    return;
  }

  const { patches, ur, beforeCoords, afterCoords } = buildMovePatches(frames, dx, dy, layers);
  runSheetCommand(services, sheetId, label,
    () => {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, ur.x, ur.y);
      for (const c of afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
    () => {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, ur.x, ur.y);
      for (const c of beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    });
}

// Slice-grid dialog's Create action, minus the DOM reads. `options` carries
// cellW/cellH/marginX/marginY/spacingX/spacingY/namePrefix already clamped by
// the dialog; sheetWidth/sheetHeight come from the sheet itself.
export function sliceSheetIntoFrames(services, sheetId, options, replace) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const newFrames = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...options });

  const beforeFrames = sheet.frames.slice();
  const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  if (replace) {
    sheet.frames = [];
    for (const a of sheet.animations) { a.frames = []; a.breaks = []; }
  }
  for (const nf of newFrames) addFrame(sheet, nf);
  const afterFrames = sheet.frames.slice();
  const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));

  runSheetCommand(services, sheetId, 'slice grid',
    target => {
      target.frames = afterFrames.slice();
      for (const snap of afterAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
    },
    target => {
      target.frames = beforeFrames.slice();
      for (const snap of beforeAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
    });
}
