import { addFrame, removeFrame, addAnimation, animationGroup } from '../../../../core/model.js';
import { createBitmap, copyRegion, blitRegion } from '../../../../core/pixels.js';
import {
  segmentsOf, segmentOfFrame, segmentMembers,
  insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks,
} from '../../../../core/strips.js';
import { frameBounds } from '../../../../domain/sprites/frames.js';
import { state, emit, activeSheet, currentContextLayers } from '../../../../app/state.js';
import { stripLayersOf, buildMovePatches } from '../frame-pixel-motion.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function resolve(services, sheetId, animationId, runIndex) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId) ?? null;
  const run = anim && runIndex != null ? segmentsOf(anim)[runIndex] ?? null : null;
  return { sheet, anim, run };
}

function defaultDuration(services) {
  return services.projects.project?.settings?.durationMs ?? 100;
}

// Word-style insert-column at boundary k of a segment (0=before first,
// n=after last): the tail shifts right one frame width (pixel-carrying), a
// blank frame fills the gap, an animation entry lands at the matching order
// index with its neighbor's duration.
export function insertStripFrame(services, sheetId, animationId, runIndex, k) {
  const { sheet, anim, run } = resolve(services, sheetId, animationId, runIndex);
  if (!sheet || !anim || !run) return;
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const fw = members[0].w, fh = members[0].h;
  const b = frameBounds(members);
  if (b.x + b.w + fw > sheet.width) return;
  const index = run.start + k;
  const attachLeft = k === members.length;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();

  const tail = members.slice(k);
  // ASSUMES sheetId === state.activeSheetId -- currentContextLayers() reads
  // the ACTIVE sheet, not the sheetId this handler was dispatched with.
  // Callers must ensure they match; see final-review finding for context.
  const mv = tail.length ? buildMovePatches(tail, fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
  const frame = addFrame(sheet, {
    name: `${anim.name}_${anim.frames.length}`,
    x: b.x + k * fw, y: b.y, w: fw, h: fh,
  });
  const duration = beforeEntries[index - 1]?.duration ?? beforeEntries[index]?.duration ?? defaultDuration(services);
  const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, attachLeft);
  anim.frames = r.entries;
  anim.breaks = r.breaks;

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();

  runSheetCommand(services, sheetId, 'insert frame',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = frame.id;
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    });
  emit('selection');
}

// Split = add a break. Nothing moves; the dashed separator marks the cut
// until one side is dragged away.
export function splitStrip(services, sheetId, animationId, index) {
  const { anim } = resolve(services, sheetId, animationId, null);
  if (!anim) return;
  const before = (anim.breaks ?? []).slice();
  const after = normalizeBreaks([...before, index], anim.frames.length);
  if (after.length === before.length) return;
  runSheetCommand(services, sheetId, 'split strip',
    () => { anim.breaks = after.slice(); },
    () => { anim.breaks = before.slice(); });
}

// Resize = add/remove whole frames at the dragged end. Grow appends blank
// frames (right: rightward; left: leftward, prepended in order) -- always a
// pure array operation, no pixel effects. Shrink removes frames + entries
// from that end and, once the strip is accepted (has its own layer), also
// clears the removed frame's own pixels from it: each strip owns its own
// layer, so there's no shared underlying sheet art left to preserve for a
// future regrow. A floating strip has no layer yet, so shrink stays
// pixel-free too. Neighbor's duration is copied.
export function resizeStripSegment(services, sheetId, animationId, runIndex, side, count) {
  const { sheet, anim, run } = resolve(services, sheetId, animationId, runIndex);
  if (!sheet || !anim || !run) return;
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const count0 = members.length;
  if (count === count0) return;
  const fw = members[0].w, fh = members[0].h;
  const bbox = frameBounds(members);
  let delta = count - count0;
  if (delta > 0) {
    // Bounds-clamp the grow: mirrors insertStripFrame's sheet.width refusal
    // guard, but clamps to what fits rather than refusing outright (this is
    // a variable-count drag-driven grow, unlike insertStripFrame's fixed
    // single-frame insert, so partial fulfillment is meaningful). Strips are
    // horizontal-only here (no sheet.height counterpart exists in this file).
    const room = side === 'right' ? sheet.width - (bbox.x + bbox.w) : bbox.x;
    const maxGrow = Math.max(0, Math.floor(room / fw));
    if (maxGrow === 0) return;
    delta = Math.min(delta, maxGrow);
  }

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();
  const beforeSelected = state.selectedFrameId;
  const neighbor = side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start];
  const duration = neighbor?.duration ?? defaultDuration(services);

  const group = anim.layerGroupId ? animationGroup(sheet, anim.id) : null;
  const layer = group ? group.children[0] : null;
  const clearPatches = [];

  if (delta > 0) {
    for (let j = 0; j < delta; j++) {
      const x = side === 'right' ? bbox.x + bbox.w + j * fw : bbox.x - (j + 1) * fw;
      const frame = addFrame(sheet, {
        name: `${anim.name}_${anim.frames.length}`, x, y: bbox.y, w: fw, h: fh,
      });
      const index = side === 'right' ? run.end + j : run.start;
      const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, side === 'right');
      anim.frames = r.entries;
      anim.breaks = r.breaks;
    }
  } else {
    for (let j = 0; j < -delta; j++) {
      const index = side === 'right' ? run.end - 1 - j : run.start;
      const frameId = anim.frames[index].frameId;
      const frame = sheet.frames.find(f => f.id === frameId);
      if (layer && frame) {
        clearPatches.push({ x: frame.x, y: frame.y, before: copyRegion(layer.bitmap, frame.x, frame.y, fw, fh) });
      }
      sheet.frames = sheet.frames.filter(f => f.id !== frameId);
      const r = removeEntry(anim.frames, anim.breaks, index);
      anim.frames = r.entries;
      anim.breaks = r.breaks;
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    }
    if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
  }

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();
  const afterSelected = state.selectedFrameId;

  runSheetCommand(services, sheetId, 'resize strip',
    target => {
      target.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = afterSelected;
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
    },
    target => {
      target.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      state.selectedFrameId = beforeSelected;
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, p.before, p.x, p.y);
    });
  emit('selection');
}

// Delete on a strip member removes the frame AND closes the gap: the rest of
// its segment shifts left one frame width. removeFrame keeps every
// animation's entries/breaks consistent; snapshots cover them all for undo.
export function removeStripMember(services, sheetId, animationId, frameId) {
  const { sheet, anim } = resolve(services, sheetId, animationId, null);
  if (!sheet || !anim) return;
  const run = segmentOfFrame(anim, frameId);
  if (!run) return;
  const members = segmentMembers(sheet, anim, run);
  const index = anim.frames.findIndex(e => e.frameId === frameId);
  const k = index - run.start;
  const fw = members[0].w;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = state.selectedFrameId === frameId;

  const tail = members.slice(k + 1);
  // ASSUMES sheetId === state.activeSheetId -- currentContextLayers() reads
  // the ACTIVE sheet, not the sheetId this handler was dispatched with.
  // Callers must ensure they match; see final-review finding for context.
  const mv = tail.length ? buildMovePatches(tail, -fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
  removeFrame(sheet, frameId);

  const afterSheetFrames = sheet.frames.slice();
  const afterAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));

  runSheetCommand(services, sheetId, 'remove strip frame',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = afterSheetFrames.slice();
      for (const s of afterAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = beforeSheetFrames.slice();
      for (const s of beforeAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (wasSelected) state.selectedFrameId = frameId;
    });
  emit('selection');
}

// Snap-merge: one undoable command = reposition of the dragged members +
// order/breaks rewrite (+ possible source-animation deletion). Whole-array
// snapshots keep do()/undo() idempotent per the codebase idiom.
export function mergeStripSegments(services, sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy) {
  const { sheet, anim: srcAnim, run: srcRun } = resolve(services, sheetId, animationId, runIndex);
  const { anim: dstAnim, run: dstRun } = resolve(services, sheetId, targetAnimationId, targetRunIndex);
  if (!sheet || !srcAnim || !dstAnim || !srcRun || !dstRun) return;
  const members = segmentMembers(sheet, srcAnim, srcRun);
  if (!members.length) return;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: state.selectedAnimationId,
  };
  // findSnap only ever offers same-strip targets now (cross-animation
  // merging is disabled), so this is always same-strip pixel motion when the
  // strip is accepted; stripLayersOf returns null for a floating strip,
  // falling back to a metadata-only reposition.
  const layers = stripLayersOf(sheet, srcAnim);
  const mv = layers ? buildMovePatches(members, dx, dy, layers) : null;
  const coords = mv ? null : members.map(f => ({ frame: f, x: f.x, y: f.y }));
  if (!mv) for (const f of members) { f.x += dx; f.y += dy; }
  if (sameAnim) {
    const r = mergeSegments(srcAnim, srcRun.index, dstRun.index, side);
    srcAnim.frames = r.frames; srcAnim.breaks = r.breaks;
  } else {
    const r = transferSegment(srcAnim, dstAnim, srcRun.index, dstRun.index, side);
    srcAnim.frames = r.src.frames; srcAnim.breaks = r.src.breaks;
    dstAnim.frames = r.dst.frames; dstAnim.breaks = r.dst.breaks;
    if (srcAnim.frames.length === 0)
      sheet.animations = sheet.animations.filter(a => a !== srcAnim);
  }
  const after = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: srcAnim.breaks.slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: dstAnim.breaks.slice(),
    animations: sheet.animations.slice(),
  };

  runSheetCommand(services, sheetId, 'merge strips',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; }
      }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      target.animations = after.animations.slice();
      state.selectedAnimationId = dstAnim.id;
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      srcAnim.frames = before.srcFrames.map(e => ({ ...e })); srcAnim.breaks = before.srcBreaks.slice();
      dstAnim.frames = before.dstFrames.map(e => ({ ...e })); dstAnim.breaks = before.dstBreaks.slice();
      target.animations = before.animations.slice();
      state.selectedAnimationId = before.selectedAnimationId;
    });
  emit('selection');
}

// Dragging a standalone (non-strip) frame's own edge grip promotes it into a
// brand-new intact-strip animation: the frame itself becomes member 0 (kept
// at its own id/position -- never duplicated), renamed to match the new
// strip, and `count - 1` additional blank frames are appended in the dragged
// direction, exactly like growing an existing strip via the grip.
export function newStripFromFrame(services, sheetId, frameId, side, count) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!sheet || !frame) return;
  let extra = count - 1;
  if (extra <= 0) return;
  const fw = frame.w, fh = frame.h;
  // Bounds-clamp the grow: mirrors resizeStripSegment's grow-side clamp (see
  // that comment for rationale) so a promoted strip never places frames off
  // the sheet edge. Horizontal-only, like the rest of this file.
  const room = side === 'right' ? sheet.width - (frame.x + fw) : frame.x;
  const maxExtra = Math.max(0, Math.floor(room / fw));
  if (maxExtra === 0) return;
  extra = Math.min(extra, maxExtra);
  const duration = defaultDuration(services);
  const name = `strip_${sheet.animations.length}`;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();
  const beforeFrameName = frame.name;
  const beforeSelectedAnimationId = state.selectedAnimationId;

  const anim = addAnimation(sheet, name, true, services.projects.project?.settings);
  frame.name = `${name}_0`;
  const entries = [{ frameId: frame.id, duration }];
  for (let j = 0; j < extra; j++) {
    const x = side === 'right' ? frame.x + (j + 1) * fw : frame.x - (j + 1) * fw;
    const nf = addFrame(sheet, { name: `${name}_${j + 1}`, x, y: frame.y, w: fw, h: fh });
    if (side === 'right') entries.push({ frameId: nf.id, duration });
    else entries.unshift({ frameId: nf.id, duration });
  }
  anim.frames = entries;

  const afterSheetFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(e => ({ ...e }));
  const afterFrameName = frame.name;
  const animId = anim.id;

  runSheetCommand(services, sheetId, 'new strip from frame',
    target => {
      target.frames = afterSheetFrames.slice();
      target.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(e => ({ ...e }));
      frame.name = afterFrameName;
      if (target === activeSheet()) {
        state.selectedFrameId = frameId;
        state.selectedAnimationId = animId;
      }
    },
    target => {
      target.frames = beforeSheetFrames.slice();
      target.animations = beforeAnimations.slice();
      frame.name = beforeFrameName;
      state.selectedFrameId = frameId;
      state.selectedAnimationId = beforeSelectedAnimationId;
    });
  emit('selection');
}
