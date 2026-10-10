// js/modes/sprites/application/commands/animation-layout-commands.js
// Layout-changing animation commands (the animations.* ids registered in
// ../../contributions.js). Each one makes its structural change in place,
// plans the auto layout (domain/sprites/auto-layout.js), applies it
// (core/sheet-layout.js) and records everything as ONE history step whose
// do/undo swap structural snapshots and replay the pixel record. A refusal
// rolls the structural change back and returns { ok: false, reason }
// without touching history. See
// docs/superpowers/specs/2026-10-09-animations-workbench-design.md §2.
import { addFrame, addAnimation, sheetLayers, MAX_DIM } from '../../../../core/model.js';
import { createBitmap, copyRegion, blitRegion } from '../../../../core/pixels.js';
import { applyLayout, undoLayout, redoLayout, hasPixels } from '../../../../core/sheet-layout.js';
import { planLayout, distinctFrameIds, autoAnimationOf } from '../../../../domain/sprites/auto-layout.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

export const NOT_AUTO = 'This animation is not auto-laid-out';
export const BAD_SIZE = `Canvas size must be whole numbers in 1..${MAX_DIM}`;
const NO_SUCH = 'No such animation or frame';

export function layoutMaxWidth(settings) {
  return settings?.sheetMaxWidth ?? settings?.spriteSheetW ?? 256;
}

export function sheetDocument(sheet) {
  return { kind: 'sprite-sheet', id: sheet.id };
}

export function validSize(w, h) {
  return [w, h].every(v => Number.isInteger(v) && v >= 1 && v <= MAX_DIM);
}

export function findAnimation(services, sheetId, animationId) {
  return findSpriteSheet(services.projects.project, sheetId)?.animations.find(a => a.id === animationId) ?? null;
}

export function animFrames(sheet, anim) {
  const byId = new Map(sheet.frames.map(f => [f.id, f]));
  return distinctFrameIds(anim).map(id => byId.get(id)).filter(Boolean);
}

export function rectOf(f) {
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

// A frame's current pixels on every layer, for content-replacing writes.
export function frameContent(sheet, frame) {
  return new Map(sheetLayers(sheet).map(l => [l.id, copyRegion(l.bitmap, frame.x, frame.y, frame.w, frame.h)]));
}

// Every layer's pixels of `frame`, re-framed onto a w x h canvas with the
// old content's top-left at (ox, oy) -- cropping or padding as needed.
export function reframedContent(sheet, frame, w, h, ox, oy) {
  return new Map(sheetLayers(sheet).map(l => {
    const bitmap = createBitmap(w, h);
    blitRegion(bitmap, copyRegion(l.bitmap, frame.x, frame.y, frame.w, frame.h), ox, oy);
    return [l.id, bitmap];
  }));
}

export function uniqueFrameName(sheet, base) {
  const names = new Set(sheet.frames.map(f => f.name));
  for (let i = 0; ; i++) if (!names.has(`${base}_${i}`)) return `${base}_${i}`;
}

// True while any animation entry on the sheet, or any map sprite placement
// of this sheet, still names the frame (maps place frames by id as assetId).
export function isFrameReferenced(project, sheet, frameId) {
  if (sheet.animations.some(a => a.frames.some(e => e.frameId === frameId))) return true;
  return (project?.maps ?? []).some(m => m.layers.some(l => l.type === 'sprite' &&
    (l.sprites ?? []).some(s => s.sheetId === sheet.id && s.kind !== 'animation' && s.assetId === frameId)));
}

function snapshot(sheet) {
  return {
    frames: sheet.frames.slice(),
    frameFields: sheet.frames.map(f => [f, { name: f.name, x: f.x, y: f.y, w: f.w, h: f.h, pivotX: f.pivotX, pivotY: f.pivotY }]),
    animations: sheet.animations.slice(),
    animFields: sheet.animations.map(a => [a, { name: a.name, layout: a.layout, cell: a.cell ? { ...a.cell } : null, frames: a.frames.map(e => ({ ...e })) }]),
  };
}

function restore(sheet, snap) {
  sheet.frames = snap.frames.slice();
  for (const [f, v] of snap.frameFields) Object.assign(f, v);
  sheet.animations = snap.animations.slice();
  for (const [a, v] of snap.animFields) {
    a.name = v.name; a.layout = v.layout; a.cell = v.cell ? { ...v.cell } : null;
    a.frames = v.frames.map(e => ({ ...e }));
  }
}

// mutate(sheet) changes the structure in place and returns either
// { ok: false, reason } or { content?, clears?, selection? }: the frames
// whose pixels are replaced (see applyLayout), the rects to empty, and a
// selection patch applied on do.
export function runLayoutCommand(services, sheetId, label, mutate) {
  const project = services.projects.project;
  const sheet = findSpriteSheet(project, sheetId);
  if (!sheet) return { ok: false, reason: NO_SUCH };
  const doc = sheetDocument(sheet);
  const before = snapshot(sheet);
  const selectionBefore = services.selections?.get(doc) ?? null;
  const change = mutate(sheet) ?? {};
  if (change.ok === false) { restore(sheet, before); return change; }
  const { content = new Map(), clears = [], selection = null } = change;
  const plan = planLayout(sheet, {
    maxWidth: layoutMaxWidth(project.settings), maxHeight: MAX_DIM,
    fresh: new Set(content.keys()), ignoreRects: clears,
  });
  if (!plan.ok) { restore(sheet, before); return plan; }
  const applied = applyLayout(sheet, plan, { content, clears });
  if (!applied.ok) { restore(sheet, before); return applied; }
  const after = snapshot(sheet);
  // HistoryService.execute runs do() immediately; restoring `after` and
  // replaying the record is idempotent, so the net effect is one apply.
  runSheetCommand(services, sheetId, label,
    target => {
      restore(target, after);
      redoLayout(target, applied.record);
      if (selection) services.selections?.patch(selection, doc);
    },
    target => {
      undoLayout(target, applied.record);
      restore(target, before);
      // Only the keys this command patched: later selection changes that
      // were not history (the active layer, say) survive the undo.
      if (selection) services.selections?.patch(Object.fromEntries(Object.keys(selection).map(k => [k, selectionBefore?.[k] ?? null])), doc);
    });
  return { ok: true };
}

function autoIn(sheet, animationId) {
  const anim = sheet.animations.find(a => a.id === animationId);
  return anim?.layout === 'auto' ? anim : null;
}

function sharedPivot(sheet, anim) {
  const first = animFrames(sheet, anim)[0];
  return { pivotX: first?.pivotX ?? 0, pivotY: first?.pivotY ?? 0 };
}

export function newAutoAnimation(services, sheetId, { name, w, h }) {
  if (!validSize(w, h)) return { ok: false, reason: BAD_SIZE };
  let ids = null;
  const r = runLayoutCommand(services, sheetId, 'new animation', sheet => {
    const anim = addAnimation(sheet, name ?? `anim_${sheet.animations.length}`, services.projects.project?.settings);
    anim.layout = 'auto';
    anim.cell = { w, h };
    const frame = addFrame(sheet, { name: uniqueFrameName(sheet, anim.name), x: 0, y: 0, w, h });
    anim.frames.push({ frameId: frame.id, duration: null, step: null });
    ids = { animationId: anim.id, frameId: frame.id };
    return { content: new Map([[frame.id, null]]), selection: ids };
  });
  return r.ok ? { ...r, ...ids } : r;
}

export function addAutoFrame(services, sheetId, animationId, at, { copyOf = null } = {}) {
  let frameId = null;
  const r = runLayoutCommand(services, sheetId, copyOf ? 'duplicate frame' : 'add frame', sheet => {
    const anim = autoIn(sheet, animationId);
    if (!anim) return { ok: false, reason: NOT_AUTO };
    const source = copyOf ? sheet.frames.find(f => f.id === copyOf) : null;
    if (copyOf && (!source || !anim.frames.some(e => e.frameId === copyOf)))
      return { ok: false, reason: 'Can only copy a frame of this animation' };
    const frame = addFrame(sheet, { name: uniqueFrameName(sheet, anim.name), x: 0, y: 0, w: anim.cell.w, h: anim.cell.h, ...sharedPivot(sheet, anim) });
    anim.frames.splice(Math.max(0, Math.min(anim.frames.length, at)), 0, { frameId: frame.id, duration: null, step: null });
    frameId = frame.id;
    return { content: new Map([[frame.id, source ? frameContent(sheet, source) : null]]), selection: { frameId: frame.id } };
  });
  return r.ok ? { ...r, frameId } : r;
}

export function linkAutoFrame(services, sheetId, animationId, at, frameId) {
  return runLayoutCommand(services, sheetId, 'link frame', sheet => {
    const anim = autoIn(sheet, animationId);
    if (!anim) return { ok: false, reason: NOT_AUTO };
    if (!anim.frames.some(e => e.frameId === frameId)) return { ok: false, reason: 'Can only link a frame of this animation' };
    anim.frames.splice(Math.max(0, Math.min(anim.frames.length, at)), 0, { frameId, duration: null, step: null });
    return {};
  });
}

export function deleteAutoFrame(services, sheetId, animationId, index) {
  return runLayoutCommand(services, sheetId, 'delete frame', sheet => {
    const anim = autoIn(sheet, animationId);
    if (!anim) return { ok: false, reason: NOT_AUTO };
    if (!(index >= 0 && index < anim.frames.length)) return { ok: false, reason: NO_SUCH };
    const [entry] = anim.frames.splice(index, 1);
    if (isFrameReferenced(services.projects.project, sheet, entry.frameId)) return {};
    const frame = sheet.frames.find(f => f.id === entry.frameId);
    if (!frame) return {};
    sheet.frames = sheet.frames.filter(f => f !== frame);
    const selected = services.selections?.get(sheetDocument(sheet))?.frameId === frame.id;
    return { clears: [rectOf(frame)], selection: selected ? { frameId: null } : null };
  });
}

export function moveAutoFrame(services, sheetId, animationId, from, to) {
  const anim = findAnimation(services, sheetId, animationId);
  if (anim?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  if (!(from >= 0 && from < anim.frames.length)) return { ok: false, reason: NO_SUCH };
  const target = Math.max(0, Math.min(anim.frames.length - 1, to));
  if (target === from) return { ok: true };
  return runLayoutCommand(services, sheetId, 'reorder animation frame', sheet => {
    const a = autoIn(sheet, animationId);
    const [entry] = a.frames.splice(from, 1);
    a.frames.splice(target, 0, entry);
    return {};
  });
}

export const SIZE_NEEDED = 'Frames differ in size or pivot: choose a canvas size';

const ANCHORS = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0],
  w: [0, 0.5], c: [0.5, 0.5], e: [1, 0.5],
  sw: [0, 1], s: [0.5, 1], se: [1, 1],
};

export function resizeAutoCanvas(services, sheetId, animationId, w, h, anchor = 'c') {
  if (!validSize(w, h)) return { ok: false, reason: BAD_SIZE };
  const current = findAnimation(services, sheetId, animationId);
  if (current?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  if (current.cell.w === w && current.cell.h === h) return { ok: true };
  const [fx, fy] = ANCHORS[anchor] ?? ANCHORS.c;
  return runLayoutCommand(services, sheetId, 'resize animation canvas', sheet => {
    const anim = autoIn(sheet, animationId);
    const ox = Math.floor(fx * (w - anim.cell.w)), oy = Math.floor(fy * (h - anim.cell.h));
    const content = new Map(), clears = [];
    for (const f of animFrames(sheet, anim)) {
      clears.push(rectOf(f));
      content.set(f.id, reframedContent(sheet, f, w, h, ox, oy));
      f.w = w; f.h = h; f.pivotX += ox; f.pivotY += oy;
    }
    anim.cell = { w, h };
    return { content, clears };
  });
}

export function autoLayoutAnimation(services, sheetId, animationId, size = null) {
  if (size && !validSize(size.w, size.h)) return { ok: false, reason: BAD_SIZE };
  const sheet0 = findSpriteSheet(services.projects.project, sheetId);
  const anim0 = sheet0?.animations.find(a => a.id === animationId);
  if (!anim0) return { ok: false, reason: NO_SUCH };
  if (anim0.layout === 'auto') return { ok: false, reason: 'Already auto-laid-out' };
  const frames0 = animFrames(sheet0, anim0);
  if (!frames0.length) return { ok: false, reason: 'The animation has no frames' };
  for (const f of frames0) {
    const other = autoAnimationOf(sheet0, f.id);
    if (other) return { ok: false, reason: `Frame "${f.name}" is already laid out by "${other.name}"` };
  }
  const first = frames0[0];
  const uniform = frames0.every(f => f.w === first.w && f.h === first.h && f.pivotX === first.pivotX && f.pivotY === first.pivotY);
  if (!uniform && !size) {
    return {
      ok: false, reason: SIZE_NEEDED, needsSize: true,
      suggested: { w: Math.max(...frames0.map(f => f.w)), h: Math.max(...frames0.map(f => f.h)) },
    };
  }
  return runLayoutCommand(services, sheetId, 'auto-layout animation', sheet => {
    const anim = sheet.animations.find(a => a.id === animationId);
    const frames = animFrames(sheet, anim);
    const head = frames[0];
    anim.layout = 'auto';
    if (!size || (uniform && size.w === head.w && size.h === head.h)) {
      anim.cell = { w: head.w, h: head.h };
      return {};
    }
    // Every frame's pivot lands on the same point: the first frame's pivot,
    // shifted by centring the first frame on the new canvas.
    const px = head.pivotX + Math.floor((size.w - head.w) / 2);
    const py = head.pivotY + Math.floor((size.h - head.h) / 2);
    const content = new Map(), clears = [];
    for (const f of frames) {
      clears.push(rectOf(f));
      content.set(f.id, reframedContent(sheet, f, size.w, size.h, Math.round(px - f.pivotX), Math.round(py - f.pivotY)));
      f.w = size.w; f.h = size.h; f.pivotX = px; f.pivotY = py;
    }
    anim.cell = { w: size.w, h: size.h };
    return { content, clears };
  });
}

export function makeManual(services, sheetId, animationId) {
  const anim = findAnimation(services, sheetId, animationId);
  if (anim?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  const cell = { ...anim.cell };
  runSheetCommand(services, sheetId, 'make animation manual',
    target => { const a = target.animations.find(x => x.id === animationId); a.layout = 'manual'; a.cell = null; },
    target => { const a = target.animations.find(x => x.id === animationId); a.layout = 'auto'; a.cell = { ...cell }; });
  return { ok: true };
}

export function reorderAnimations(services, sheetId, from, to) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || !(from >= 0 && from < sheet.animations.length)) return { ok: false, reason: NO_SUCH };
  const target = Math.max(0, Math.min(sheet.animations.length - 1, to));
  if (target === from) return { ok: true };
  return runLayoutCommand(services, sheetId, 'reorder animations', s => {
    const [anim] = s.animations.splice(from, 1);
    s.animations.splice(target, 0, anim);
    return {};
  });
}

export function duplicateAnimation(services, sheetId, animationId) {
  const source = findAnimation(services, sheetId, animationId);
  if (!source) return { ok: false, reason: NO_SUCH };
  if (source.layout !== 'auto') return { ok: false, reason: 'Auto-layout this animation first' };
  // The copy cannot write into a locked layer, so its pixels there would be lost.
  const sourceSheet = findSpriteSheet(services.projects.project, sheetId);
  const lockedInk = sheetLayers(sourceSheet).find(l => l.locked && animFrames(sourceSheet, source).some(f => hasPixels(l.bitmap, f)));
  if (lockedInk) return { ok: false, reason: `Layer "${lockedInk.name}" is locked and has pixels that would be copied` };
  let copyId = null;
  const r = runLayoutCommand(services, sheetId, 'duplicate animation', sheet => {
    const src = sheet.animations.find(a => a.id === animationId);
    const copy = addAnimation(sheet, `${src.name} copy`, services.projects.project?.settings);
    sheet.animations.splice(sheet.animations.indexOf(copy), 1);
    sheet.animations.splice(sheet.animations.indexOf(src) + 1, 0, copy);
    Object.assign(copy, {
      loop: src.loop, baseDuration: src.baseDuration, baseFps: src.baseFps, baseStep: src.baseStep,
      layout: 'auto', cell: { ...src.cell },
    });
    const ids = new Map(), content = new Map();
    for (const f of animFrames(sheet, src)) {
      const nf = addFrame(sheet, { name: uniqueFrameName(sheet, copy.name), x: 0, y: 0, w: f.w, h: f.h, pivotX: f.pivotX, pivotY: f.pivotY });
      ids.set(f.id, nf.id);
      content.set(nf.id, frameContent(sheet, f));
    }
    copy.frames = src.frames.filter(e => ids.has(e.frameId)).map(e => ({ ...e, frameId: ids.get(e.frameId) }));
    copyId = copy.id;
    return { content, selection: { animationId: copy.id } };
  });
  return r.ok ? { ...r, animationId: copyId } : r;
}

export function deleteAutoAnimation(services, sheetId, animationId) {
  if (findAnimation(services, sheetId, animationId)?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  return runLayoutCommand(services, sheetId, 'delete animation', sheet => {
    const anim = sheet.animations.find(a => a.id === animationId);
    sheet.animations = sheet.animations.filter(a => a !== anim);
    const clears = [];
    for (const f of animFrames(sheet, anim)) {
      if (isFrameReferenced(services.projects.project, sheet, f.id)) continue;
      clears.push(rectOf(f));
      sheet.frames = sheet.frames.filter(x => x !== f);
    }
    const selected = services.selections?.get(sheetDocument(sheet))?.animationId === animationId;
    return { clears, selection: selected ? { animationId: null, frameId: null } : null };
  });
}

export function setAnimationPivot(services, sheetId, animationId, pivotX, pivotY) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (anim?.layout !== 'auto') return { ok: false, reason: NOT_AUTO };
  const frames = animFrames(sheet, anim);
  if (frames.every(f => f.pivotX === pivotX && f.pivotY === pivotY)) return { ok: true };
  const before = frames.map(f => [f.pivotX, f.pivotY]);
  runSheetCommand(services, sheetId, 'set animation pivot',
    () => frames.forEach(f => { f.pivotX = pivotX; f.pivotY = pivotY; }),
    () => frames.forEach((f, i) => { [f.pivotX, f.pivotY] = before[i]; }));
  return { ok: true };
}

// Sprite Sheets' Delete on a pinned frame: the frame leaves every animation
// and the sheet, and its rect is cleared (otherwise its pixels would become
// stray obstacles for every later layout).
export function deleteLaidOutFrame(services, sheetId, frameId) {
  return runLayoutCommand(services, sheetId, 'delete frame', sheet => {
    const frame = sheet.frames.find(f => f.id === frameId);
    if (!frame) return { ok: false, reason: NO_SUCH };
    sheet.frames = sheet.frames.filter(f => f !== frame);
    for (const a of sheet.animations) a.frames = a.frames.filter(e => e.frameId !== frameId);
    const selected = services.selections?.get(sheetDocument(sheet))?.frameId === frameId;
    return { clears: [rectOf(frame)], selection: selected ? { frameId: null } : null };
  });
}
