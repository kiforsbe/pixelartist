// js/modes/sprites/application/commands/animation-range-commands.js
// Range commands over an animation's entries (the animations.* ids in
// ../../contributions.js), for the Animations timeline's range selection.
// See docs/superpowers/specs/2026-10-10-timeline-dock-dragdrop-design.md §4.
//
// Each command is ONE history step. On an auto animation it runs the layout
// engine through runLayoutCommand, exactly as the single-entry commands in
// animation-layout-commands.js do (pixels follow the timeline). On a manual
// animation it edits the entry list only -- no frame or pixel moves. The
// commands that create frames (copy, duplicate, unlink) refuse a manual
// animation with NEEDS_AUTO; the timeline offers the auto layout first.
//
// Ranges are inclusive entry indices [from..to]; a reversed pair is
// accepted, anything empty, fractional or outside the animation is refused.
// Results: { ok: true, ... } or { ok: false, reason } (nothing changed, no
// history), the same shape dispatchLayout (components/layout-dispatch.js)
// explains to the user.
import { addFrame, addAnimation, findLayer, sheetLayers } from '../../../../core/model.js';
import { copyRegion, blitRegion, fillRegion } from '../../../../core/pixels.js';
import { hasPixels } from '../../../../core/sheet-layout.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';
import {
  runLayoutCommand, findAnimation, frameContent, uniqueFrameName, uniqueAnimationName, isFrameReferenced, rectOf, sheetDocument,
  NEEDS_AUTO,
} from './animation-layout-commands.js';

const NO_ANIMATION = 'No such animation';
const BAD_RANGE = 'No such frames in this animation';
const BAD_SLOT = 'No such place in this animation';
const WHOLE_ANIMATION = 'These are all of its frames: rename the animation instead';
const BAD_DURATION = 'A duration must be a positive number of milliseconds, a step a positive whole number, or null for the default';
const CLEAR = [0, 0, 0, 0];

// The inclusive range [from..to] of `anim`'s entries, ordered, or null.
function entryRange(anim, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  const lo = Math.min(from, to), hi = Math.max(from, to);
  return lo >= 0 && hi < anim.frames.length ? { from: lo, to: hi } : null;
}

// An insertion slot 0..length (clamped), or null when not a whole number.
function slotIn(anim, at) {
  return Number.isInteger(at) ? Math.max(0, Math.min(anim.frames.length, at)) : null;
}

const sameEntries = (a, b) => a.length === b.length &&
  a.every((e, i) => e.frameId === b[i].frameId && e.duration === b[i].duration && e.step === b[i].step);

// One history step that swaps a manual animation's whole entry list.
function commitEntries(services, sheetId, animationId, label, before, after) {
  const entries = list => list.map(e => ({ ...e }));
  const anim = sheet => sheet.animations.find(a => a.id === animationId);
  runSheetCommand(services, sheetId, label,
    target => { anim(target).frames = entries(after); },
    target => { anim(target).frames = entries(before); });
}

// A new entry list for `anim`: the auto layout re-plans; a manual animation
// just swaps the list. `edit(list)` returns the edited copy of the entries.
function editEntries(services, sheetId, anim, label, edit) {
  if (anim.layout === 'auto') {
    return runLayoutCommand(services, sheetId, label, sheet => {
      const a = sheet.animations.find(x => x.id === anim.id);
      a.frames = edit(a.frames.map(e => ({ ...e })));
      return {};
    });
  }
  const before = anim.frames.map(e => ({ ...e }));
  commitEntries(services, sheetId, anim.id, label, before, edit(before.map(e => ({ ...e }))));
  return { ok: true };
}

// A copy cannot write into a locked layer, so its pixels there would be lost.
function lockedInkIn(sheet, frames) {
  const layer = sheetLayers(sheet).find(l => l.locked && frames.some(f => hasPixels(l.bitmap, f)));
  return layer ? { ok: false, reason: `Layer "${layer.name}" is locked and has pixels that would be copied` } : null;
}

// Moves entries [from..to] to slot `at`, counted before they are removed
// (the drop slot under the pointer). -> { ok, from, to }: the range's new
// place. A slot inside or touching the range changes nothing.
export function moveFrames(services, sheetId, animationId, from, to, at) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  const slot = slotIn(anim, at);
  if (slot === null) return { ok: false, reason: BAD_SLOT };
  const count = range.to - range.from + 1;
  if (slot >= range.from && slot <= range.to + 1) return { ok: true, ...range };
  const start = slot > range.to ? slot - count : slot;
  const r = editEntries(services, sheetId, anim, 'move frames', list => {
    const moved = list.splice(range.from, count);
    list.splice(start, 0, ...moved);
    return list;
  });
  return r.ok ? { ok: true, from: start, to: start + count - 1 } : r;
}

// Inserts independent copies of entries [from..to] at slot `at` (auto
// only). Linked uses inside the range stay linked to each other, not to
// their source: one new frame per distinct source frame. -> { ok, from, to,
// frameIds }: the copies' range and their new frames in order.
export function copyFrames(services, sheetId, animationId, from, to, at, label = 'copy frames') {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  const slot = slotIn(anim, at);
  if (slot === null) return { ok: false, reason: BAD_SLOT };
  if (anim.layout !== 'auto') return { ok: false, reason: NEEDS_AUTO };
  const sheet0 = findSpriteSheet(services.projects.project, sheetId);
  const sources = [...new Set(anim.frames.slice(range.from, range.to + 1).map(e => e.frameId))]
    .map(id => sheet0.frames.find(f => f.id === id)).filter(Boolean);
  const locked = lockedInkIn(sheet0, sources);
  if (locked) return locked;
  let frameIds = [];
  const r = runLayoutCommand(services, sheetId, label, sheet => {
    const a = sheet.animations.find(x => x.id === animationId);
    const ids = new Map(), content = new Map();
    for (const src of sources) {
      const f = addFrame(sheet, { name: uniqueFrameName(sheet, a.name), x: 0, y: 0, w: src.w, h: src.h, pivotX: src.pivotX, pivotY: src.pivotY });
      ids.set(src.id, f.id);
      content.set(f.id, frameContent(sheet, src));
    }
    const copies = a.frames.slice(range.from, range.to + 1).map(e => ({ ...e, frameId: ids.get(e.frameId) }));
    a.frames.splice(slot, 0, ...copies);
    frameIds = [...ids.values()];
    return { content, selection: { frameId: copies[0].frameId, entryIndex: slot } };
  });
  const count = range.to - range.from + 1;
  return r.ok ? { ok: true, from: slot, to: slot + count - 1, frameIds } : r;
}

// copyFrames right after the range. -> as copyFrames.
export function duplicateFrames(services, sheetId, animationId, from, to) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  return copyFrames(services, sheetId, animationId, range.from, range.to, range.to + 1, 'duplicate frames');
}

// Removes entries [from..to]. On an auto animation a frame no entry, other
// animation or map still uses is deleted and its rect cleared (the
// deleteAutoFrame rule); a manual animation keeps every frame. -> { ok }.
export function deleteFrames(services, sheetId, animationId, from, to) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  const count = range.to - range.from + 1;
  if (anim.layout !== 'auto') {
    return editEntries(services, sheetId, anim, 'delete frames', list => { list.splice(range.from, count); return list; });
  }
  return runLayoutCommand(services, sheetId, 'delete frames', sheet => {
    const a = sheet.animations.find(x => x.id === animationId);
    const removed = a.frames.splice(range.from, count);
    const selectedId = services.selections?.get(sheetDocument(sheet))?.frameId ?? null;
    const clears = [];
    let selectionGone = false;
    for (const id of new Set(removed.map(e => e.frameId))) {
      if (isFrameReferenced(services.projects.project, sheet, id)) continue;
      const frame = sheet.frames.find(f => f.id === id);
      if (!frame) continue;
      sheet.frames = sheet.frames.filter(f => f !== frame);
      clears.push(rectOf(frame));
      if (id === selectedId) selectionGone = true;
    }
    return { clears, selection: selectionGone ? { frameId: null } : null };
  });
}

// Reverses the order of entries [from..to]. -> { ok }. A range that reads
// the same reversed records nothing.
export function reverseFrames(services, sheetId, animationId, from, to) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  const reverse = list => {
    list.splice(range.from, range.to - range.from + 1, ...list.slice(range.from, range.to + 1).reverse());
    return list;
  };
  if (sameEntries(anim.frames, reverse(anim.frames.slice()))) return { ok: true };
  const r = editEntries(services, sheetId, anim, 'reverse frames', reverse);
  return r.ok ? { ok: true } : r;
}

const validDuration = v => v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);
const validStep = v => v === null || (Number.isInteger(v) && v > 0);

// Sets `duration` (ms) and/or `step` (held frames, for an fps-based
// animation -- frame-duration-input.js's rule) on every entry [from..to];
// null resets an entry to the animation's base. Entry fields only, so both
// layouts take the same path. -> { ok }. An unchanged range records nothing.
export function setFrameDurations(services, sheetId, animationId, from, to, { duration, step } = {}) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  const hasDuration = duration !== undefined, hasStep = step !== undefined;
  if ((!hasDuration && !hasStep) || (hasDuration && !validDuration(duration)) || (hasStep && !validStep(step)))
    return { ok: false, reason: BAD_DURATION };
  const before = anim.frames.map(e => ({ ...e }));
  const after = before.map((e, i) => (i < range.from || i > range.to ? { ...e } : {
    ...e, ...(hasDuration ? { duration } : {}), ...(hasStep ? { step } : {}),
  }));
  if (sameEntries(before, after)) return { ok: true };
  commitEntries(services, sheetId, animationId, 'edit frame durations', before, after);
  return { ok: true };
}

// Gives entry `index` a frame of its own with a copy of the pixels -- the
// inverse of a linked use (auto only). The entry must share its frame with
// another entry. -> { ok, frameId }: the new frame.
export function unlinkFrame(services, sheetId, animationId, index) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  if (!entryRange(anim, index, index)) return { ok: false, reason: BAD_RANGE };
  if (anim.layout !== 'auto') return { ok: false, reason: NEEDS_AUTO };
  const sheet0 = findSpriteSheet(services.projects.project, sheetId);
  const sourceId = anim.frames[index].frameId;
  const uses = sheet0.animations.reduce((n, a) => n + a.frames.filter(e => e.frameId === sourceId).length, 0);
  if (uses < 2) return { ok: false, reason: 'This frame is not linked' };
  const source = sheet0.frames.find(f => f.id === sourceId);
  if (!source) return { ok: false, reason: BAD_RANGE };
  const locked = lockedInkIn(sheet0, [source]);
  if (locked) return locked;
  let frameId = null;
  const r = runLayoutCommand(services, sheetId, 'unlink frame', sheet => {
    const a = sheet.animations.find(x => x.id === animationId);
    const src = sheet.frames.find(f => f.id === sourceId);
    const f = addFrame(sheet, { name: uniqueFrameName(sheet, a.name), x: 0, y: 0, w: src.w, h: src.h, pivotX: src.pivotX, pivotY: src.pivotY });
    a.frames[index] = { ...a.frames[index], frameId: f.id };
    frameId = f.id;
    return { content: new Map([[f.id, frameContent(sheet, src)]]), selection: { frameId: f.id, entryIndex: index } };
  });
  return r.ok ? { ok: true, frameId } : r;
}

// A new animation named `name` with `source`'s timing and layout, placed
// right after it in the timeline.
function animationAfter(sheet, source, name, settings) {
  const made = addAnimation(sheet, name, settings);
  sheet.animations.splice(sheet.animations.indexOf(made), 1);
  sheet.animations.splice(sheet.animations.indexOf(source) + 1, 0, made);
  Object.assign(made, {
    loop: source.loop, baseDuration: source.baseDuration, baseFps: source.baseFps, baseStep: source.baseStep,
    direction: source.direction ?? 'forward', layout: source.layout, cell: source.cell ? { ...source.cell } : null,
  });
  return made;
}

// Takes entries [from..to] out of their animation into a new one, placed
// right after it ("New Animation from Frames"). Frames only the range uses
// move with it; on an auto animation a frame the original still uses gets
// a copy in the new one (an auto frame belongs to one auto animation), while
// a manual one just shares it. The whole animation is refused -- that is a
// rename. -> { ok, animationId }, with the new animation selected.
export function splitFrames(services, sheetId, animationId, from, to, { name } = {}) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return { ok: false, reason: NO_ANIMATION };
  const range = entryRange(anim, from, to);
  if (!range) return { ok: false, reason: BAD_RANGE };
  const count = range.to - range.from + 1;
  if (count === anim.frames.length) return { ok: false, reason: WHOLE_ANIMATION };
  const sheet0 = findSpriteSheet(services.projects.project, sheetId);
  const label = 'new animation from frames';
  const settings = services.projects.project?.settings;
  const newName = name ?? uniqueAnimationName(sheet0, anim.name);
  if (anim.layout === 'auto') {
    const kept = new Set(anim.frames.filter((_e, i) => i < range.from || i > range.to).map(e => e.frameId));
    const shared = [...new Set(anim.frames.slice(range.from, range.to + 1).map(e => e.frameId))]
      .filter(id => kept.has(id)).map(id => sheet0.frames.find(f => f.id === id)).filter(Boolean);
    const locked = lockedInkIn(sheet0, shared);
    if (locked) return locked;
    let madeId = null;
    const r = runLayoutCommand(services, sheetId, label, sheet => {
      const a = sheet.animations.find(x => x.id === animationId);
      const made = animationAfter(sheet, a, newName, settings);
      const ids = new Map(), content = new Map();
      for (const src of shared) {
        const f = addFrame(sheet, { name: uniqueFrameName(sheet, made.name), x: 0, y: 0, w: src.w, h: src.h, pivotX: src.pivotX, pivotY: src.pivotY });
        ids.set(src.id, f.id);
        content.set(f.id, frameContent(sheet, src));
      }
      made.frames = a.frames.splice(range.from, count).map(e => ({ ...e, frameId: ids.get(e.frameId) ?? e.frameId }));
      madeId = made.id;
      return { content, selection: { animationId: made.id, frameId: made.frames[0].frameId, entryIndex: 0 } };
    });
    return r.ok ? { ok: true, animationId: madeId } : r;
  }
  const before = anim.frames.map(e => ({ ...e }));
  const after = before.filter((_e, i) => i < range.from || i > range.to);
  const taken = before.slice(range.from, range.to + 1);
  const doc = sheetDocument(sheet0);
  const selectionBefore = services.selections?.get(doc) ?? null;
  const selection = { animationId: null, frameId: taken[0].frameId, entryIndex: 0 };
  let made = null;
  runSheetCommand(services, sheetId, label,
    target => {
      const a = target.animations.find(x => x.id === animationId);
      if (!made) made = animationAfter(target, a, newName, settings);
      else target.animations.splice(target.animations.indexOf(a) + 1, 0, made);
      made.frames = taken.map(e => ({ ...e }));
      a.frames = after.map(e => ({ ...e }));
      services.selections?.patch({ ...selection, animationId: made.id }, doc);
    },
    target => {
      target.animations = target.animations.filter(x => x !== made);
      target.animations.find(x => x.id === animationId).frames = before.map(e => ({ ...e }));
      services.selections?.patch(Object.fromEntries(Object.keys(selection).map(k => [k, selectionBefore?.[k] ?? null])), doc);
    });
  return { ok: true, animationId: made.id };
}

// Clears one layer's pixels inside one frame's rect -- any frame, either
// layout; a locked layer is refused. -> { ok }. An empty cel records nothing.
export function clearCel(services, sheetId, frameId, layerId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return { ok: false, reason: 'No such frame' };
  const layer = findLayer(sheet.layerTree, layerId);
  if (!layer) return { ok: false, reason: 'No such layer' };
  if (layer.locked) return { ok: false, reason: `Layer "${layer.name}" is locked` };
  const { x, y, w, h } = rectOf(frame);
  if (!hasPixels(layer.bitmap, { x, y, w, h })) return { ok: true };
  const before = copyRegion(layer.bitmap, x, y, w, h);
  runSheetCommand(services, sheetId, 'clear cel',
    target => fillRegion(findLayer(target.layerTree, layerId).bitmap, x, y, w, h, CLEAR),
    target => blitRegion(findLayer(target.layerTree, layerId).bitmap, before, x, y));
  return { ok: true };
}
