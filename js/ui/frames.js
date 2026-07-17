// Frame tool (create/select/resize/pixel-carrying move), frames panel, and
// the slice-grid dialog.
//
// API shape mirrors tools.js's existing split between "mount UI" and "bind a
// CanvasView": `registerTool()` (from tools.js) only takes a definition, so
// `registerFrameTool()` here stays argument-free too — it adds the palette
// button + its tool-options row (snap checkbox, grid size) and the Delete-key
// handler. Wiring pointer/overlay behavior onto a specific CanvasView needs
// the view instance, so that's a second export, `bindFrameTool(view)`,
// exactly the same shape as tools.js's `mountToolPalette(el)` / `bindDrawing
// (view, getTargetRect)` pair. main.js calls both, in that order, after
// bindDrawing() (bindFrameTool wraps the view's existing onPointer/onOverlay,
// so it must run after bindDrawing has installed its own).

import { state, on, emit, activeSheet, markDirty, currentContextLayers } from '../app/state.js';
import { addFrame, removeFrame, addAnimation, renameAnimation } from '../core/model.js';
import { sliceGrid } from '../core/slicing.js';
import { findFreeRect, buildStripFrames, segmentsOf, segmentOfFrame, insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks } from '../core/strips.js';
import { copyRegion, fillRegion, blitRegion } from '../core/pixels.js';
import { registerTool } from './tools.js';
import { drawRectDims, drawChainDims } from './dimlabels.js';

const HANDLE_SCREEN_PX = 6;
const HANDLES = ['nw', 'ne', 'sw', 'se'];

// Tool options (snap checkbox + grid size number input), read by the
// pointer-drag math below and edited by the row built in buildOptionsRow().
const frameToolOptions = { snap: false, gridSize: 8 };

// In-progress drag state (create/move/resize), module-scoped like tools.js's
// `selection`/`stroke` — there is only ever one frame-tool drag at a time.
let drag = null;

// Last pointerdown's { frameId, t } for double-click detection in handleDown,
// module-scoped alongside `drag` for the same reason (one frame-tool pointer
// stream at a time).
let lastClick = null;

// Live Slice-grid preview: dialog's current values while it is open, else
// null. The sheet view handle lets dialog input events trigger repaints.
let slicePreviewOpts = null;
let sheetViewForPreview = null;

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// ------------------------------------------------------------- geometry

function snapValue(v) {
  if (!frameToolOptions.snap) return v;
  const g = Math.max(1, frameToolOptions.gridSize);
  return Math.round(v / g) * g;
}

function snapPoint(x, y) {
  return { x: snapValue(x), y: snapValue(y) };
}

// Normalizes two points into a rect. `inclusive` treats both points as pixel
// indices (create-drag, matches the select-tool marquee convention: w =
// |dx|+1); non-inclusive treats them as rect EDGE coordinates (resize, since
// frame corners already live in that space: f.x, f.x+f.w, ...).
function rectBetween(ax, ay, bx, by, inclusive) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  if (inclusive) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function snapRect(rect) {
  if (!frameToolOptions.snap) return rect;
  const g = Math.max(1, frameToolOptions.gridSize);
  const x0 = Math.round(rect.x / g) * g;
  const y0 = Math.round(rect.y / g) * g;
  const x1 = Math.round((rect.x + rect.w) / g) * g;
  const y1 = Math.round((rect.y + rect.h) / g) * g;
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function frameAt(sheet, x, y) {
  for (let i = sheet.frames.length - 1; i >= 0; i--) {
    const f = sheet.frames[i];
    if (x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h) return f;
  }
  return null;
}

// The intact-strip animation (strip === true) containing `frameId`, else
// null. "Intact" here just means strip === true — break-apart flips that
// flag, after which the animation's frames behave like any other manually
// built sequence (move individually, resizable again).
export function stripOf(sheet, frameId) {
  if (!sheet) return null;
  return sheet.animations.find(a => a.strip && a.frames.some(af => af.frameId === frameId)) ?? null;
}

// Frame objects of one segment run, in animation order (=== spatial order per
// the segment invariant). Skips dangling frameIds defensively.
function segmentMembers(sheet, anim, run) {
  return anim.frames.slice(run.start, run.end)
    .map(e => sheet.frames.find(f => f.id === e.frameId))
    .filter(Boolean);
}

// Union bounding box of a list of frames (their CURRENT x/y/w/h) — used both
// as the strip drag's ghost outline and as the clamp region for its delta.
function boundingBoxOf(frames) {
  const x0 = Math.min(...frames.map(f => f.x));
  const y0 = Math.min(...frames.map(f => f.y));
  const x1 = Math.max(...frames.map(f => f.x + f.w));
  const y1 = Math.max(...frames.map(f => f.y + f.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const SNAP_SCREEN_PX = 10;

// While dragging a segment, find the best end-to-end join: dragged RIGHT edge
// to a target's LEFT edge (side 'before' — dragged frames come first) or
// dragged LEFT edge to a target's RIGHT edge (side 'after'). Same frame w/h
// required; snapped position must stay on-sheet.
function findSnap(view, sheet, drag) {
  const d = drag.bbox;
  const fw = drag.members[0].w, fh = drag.members[0].h;
  const tol = SNAP_SCREEN_PX / view.zoom;
  const gx = d.x + drag.delta.dx, gy = d.y + drag.delta.dy;
  let best = null;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    for (const run of segmentsOf(a)) {
      if (a === drag.anim && run.index === drag.run.index) continue;
      const members = segmentMembers(sheet, a, run);
      if (!members.length || members[0].w !== fw || members[0].h !== fh) continue;
      const t = boundingBoxOf(members);
      const cands = [
        { side: 'before', dx: t.x - d.w - d.x, dy: t.y - d.y,
          err: Math.hypot(gx + d.w - t.x, gy - t.y) },
        { side: 'after', dx: t.x + t.w - d.x, dy: t.y - d.y,
          err: Math.hypot(gx - (t.x + t.w), gy - t.y) },
      ];
      for (const c of cands) {
        if (c.err > tol) continue;
        if (d.x + c.dx < 0 || d.x + c.dx + d.w > sheet.width) continue;
        if (d.y + c.dy < 0 || d.y + c.dy + d.h > sheet.height) continue;
        if (!best || c.err < best.err) best = { anim: a, run, side: c.side, dx: c.dx, dy: c.dy, err: c.err };
      }
    }
  }
  return best;
}

function oppositeCorner(f, handle) {
  const map = {
    nw: { x: f.x + f.w, y: f.y + f.h },
    ne: { x: f.x, y: f.y + f.h },
    sw: { x: f.x + f.w, y: f.y },
    se: { x: f.x, y: f.y },
  };
  return map[handle];
}

function hitHandle(view, frame, sx, sy) {
  if (!frame) return null;
  for (const h of HANDLES) {
    const ix = h[1] === 'w' ? frame.x : frame.x + frame.w;
    const iy = h[0] === 'n' ? frame.y : frame.y + frame.h;
    const p = view.imageToScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}

// ------------------------------------------------------------- commands

function commitCreate(sheet, rect) {
  const name = `frame_${sheet.frames.length}`;
  let created = null;
  const cmd = {
    label: 'add frame',
    do() {
      if (!created) created = addFrame(sheet, { name, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      else if (!sheet.frames.includes(created)) sheet.frames.push(created);
      state.selectedFrameId = created.id;
    },
    undo() {
      sheet.frames = sheet.frames.filter(f => f !== created);
      if (state.selectedFrameId === created.id) state.selectedFrameId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}

// Pixel-carrying shift for one or more frames sharing a common delta — used
// by CONTENT operations only (insert-column's tail shift, remove-column's
// gap close). Plain frame/strip moves are metadata-only (commitMoveFrames);
// moving pixel content is the move tool's job, same as for a selection.
// For every layer: copy ALL member regions first (their CURRENT pixels),
// THEN clear all of them, THEN blit all of them at their new positions —
// copying before clearing avoids corruption when member frames are adjacent
// (clearing frame A before copying frame B's original pixels would clobber B
// if A and B overlap/touch). Captures a per-layer clone of the UNION of
// every member's before/after rect so undo restores all pixels and all
// frames' x/y in one step.
function buildMovePatches(sheet, frames, dx, dy) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const patches = currentContextLayers().map((layer) => {
    const before = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    const copies = frames.map(f => copyRegion(layer.bitmap, f.x, f.y, f.w, f.h));
    for (const f of frames) fillRegion(layer.bitmap, f.x, f.y, f.w, f.h, [0, 0, 0, 0]);
    frames.forEach((f, i) => blitRegion(layer.bitmap, copies[i], f.x + dx, f.y + dy));
    const after = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    return { layer, before, after };
  });
  for (const f of frames) { f.x += dx; f.y += dy; }
  const afterCoords = beforeCoords.map(c => ({ frame: c.frame, x: c.x + dx, y: c.y + dy }));
  return { patches, ur, beforeCoords, afterCoords };
}

// Metadata-only move: frames are viewports onto the sheet, so dragging them
// with the frame tool never moves or clears pixels — exactly like dragging a
// selection marquee. Use the move tool to move the underlying content.
function commitMoveFrames(sheet, frames, dx, dy) {
  const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
  const cmd = {
    label: frames.length > 1 ? 'move strip' : 'move frame',
    do() { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
    undo() { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } },
  };
  state.commands.push(cmd);
  markDirty();
}

// Snap-merge: one undoable command = metadata reposition of the dragged
// members (no pixels move — the frame tool is metadata-only) + order/breaks
// rewrite (+ possible source-animation deletion). Whole-array snapshots keep
// do()/undo() idempotent per the codebase idiom.
function commitMergeSegments(sheet, d, snap) {
  const srcAnim = d.anim, dstAnim = snap.anim;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: state.selectedAnimationId,
  };
  const coords = d.members.map(f => ({ frame: f, x: f.x, y: f.y }));
  for (const f of d.members) { f.x += snap.dx; f.y += snap.dy; }
  if (sameAnim) {
    const r = mergeSegments(srcAnim, d.run.index, snap.run.index, snap.side);
    srcAnim.frames = r.frames; srcAnim.breaks = r.breaks;
  } else {
    const r = transferSegment(srcAnim, dstAnim, d.run.index, snap.run.index, snap.side);
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
  state.commands.push({
    label: 'merge strips',
    do() {
      for (const c of coords) { c.frame.x = c.x + snap.dx; c.frame.y = c.y + snap.dy; }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      sheet.animations = after.animations.slice();
      state.selectedAnimationId = dstAnim.id;
    },
    undo() {
      for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; }
      srcAnim.frames = before.srcFrames.map(e => ({ ...e })); srcAnim.breaks = before.srcBreaks.slice();
      dstAnim.frames = before.dstFrames.map(e => ({ ...e })); dstAnim.breaks = before.dstBreaks.slice();
      sheet.animations = before.animations.slice();
      state.selectedAnimationId = before.selectedAnimationId;
    },
  });
  markDirty();
  emit('selection');
}

function commitResize(frame, before, after) {
  const cmd = {
    label: 'resize frame',
    do() { frame.x = after.x; frame.y = after.y; frame.w = after.w; frame.h = after.h; },
    undo() { frame.x = before.x; frame.y = before.y; frame.w = before.w; frame.h = before.h; },
  };
  state.commands.push(cmd);
  markDirty();
}

// Shared by the keyboard Delete handler and the frames panel's Delete button.
function deleteFrame(sheet, frameId) {
  const frame = sheet.frames.find(f => f.id === frameId);
  if (!frame) return;
  const idx = sheet.frames.indexOf(frame);
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = state.selectedFrameId === frameId;
  const cmd = {
    label: 'delete frame',
    do() {
      removeFrame(sheet, frame.id);
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    },
    undo() {
      sheet.frames.splice(Math.min(idx, sheet.frames.length), 0, frame);
      for (const snap of animSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
      if (wasSelected) state.selectedFrameId = frame.id;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}

// Word-style insert-column at boundary k of a segment (0=before first,
// n=after last): the tail shifts right one frame width (pixel-carrying), a
// blank frame fills the gap, an animation entry lands at the matching order
// index with its neighbor's duration.
function commitInsertFrame(sheet, anim, run, k) {
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const fw = members[0].w, fh = members[0].h;
  const b = boundingBoxOf(members);
  if (b.x + b.w + fw > sheet.width) return;
  const index = run.start + k;
  const attachLeft = k === members.length;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();

  const tail = members.slice(k);
  const mv = tail.length ? buildMovePatches(sheet, tail, fw, 0) : null;
  const frame = addFrame(sheet, {
    name: `${anim.name}_${anim.frames.length}`,
    x: b.x + k * fw, y: b.y, w: fw, h: fh,
  });
  const duration = beforeEntries[index - 1]?.duration ?? beforeEntries[index]?.duration
    ?? (state.project?.settings?.durationMs ?? 100);
  const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, attachLeft);
  anim.frames = r.entries;
  anim.breaks = r.breaks;

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();

  state.commands.push({
    label: 'insert frame',
    do() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = frame.id;
    },
    undo() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    },
  });
  markDirty();
  emit('selection');
}

// Split = add a break. Nothing moves; the dashed separator (Task 3) marks the
// cut until one side is dragged away.
function commitSplitStrip(anim, index) {
  const before = (anim.breaks ?? []).slice();
  const after = normalizeBreaks([...before, index], anim.frames.length);
  if (after.length === before.length) return;
  state.commands.push({
    label: 'split strip',
    do() { anim.breaks = after.slice(); },
    undo() { anim.breaks = before.slice(); },
  });
  markDirty();
}

// Resize = add/remove whole frames at the dragged end. Grow appends blank
// frames (right: rightward; left: leftward, prepended in order). Shrink
// removes frames + entries from that end; PIXELS STAY on the sheet by design
// (growing back re-adopts the art). Neighbor's duration is copied.
function commitResizeSegment(sheet, d) {
  const { anim, run, side, fw, fh, bbox } = d;
  const delta = d.count - d.count0;
  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();
  const beforeSelected = state.selectedFrameId;
  const neighbor = side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start];
  const duration = neighbor?.duration ?? (state.project?.settings?.durationMs ?? 100);

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
      sheet.frames = sheet.frames.filter(f => f.id !== frameId);
      const r = removeEntry(anim.frames, anim.breaks, index);
      anim.frames = r.entries;
      anim.breaks = r.breaks;
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    }
  }

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();
  const afterSelected = state.selectedFrameId;

  state.commands.push({
    label: 'resize strip',
    do() {
      sheet.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      state.selectedFrameId = afterSelected;
    },
    undo() {
      sheet.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      state.selectedFrameId = beforeSelected;
    },
  });
  markDirty();
  emit('selection');
}

// Delete on a strip member removes the frame AND closes the gap: the rest of
// its segment shifts left one frame width. model.removeFrame keeps every
// animation's entries/breaks consistent; snapshots cover them all for undo.
function commitRemoveMember(sheet, anim, frameId) {
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
  const mv = tail.length ? buildMovePatches(sheet, tail, -fw, 0) : null;
  removeFrame(sheet, frameId);

  const afterSheetFrames = sheet.frames.slice();
  const afterAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));

  state.commands.push({
    label: 'remove strip frame',
    do() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = afterSheetFrames.slice();
      for (const s of afterAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (state.selectedFrameId === frameId) state.selectedFrameId = null;
    },
    undo() {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      sheet.frames = beforeSheetFrames.slice();
      for (const s of beforeAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (wasSelected) state.selectedFrameId = frameId;
    },
  });
  markDirty();
  emit('selection');
}

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet();
  if (!sheet) return;
  if (state.tool === 'frametool') {
    // Chrome is always visible for the selected segment, so hit-test it
    // directly at the down position — no dependence on hover state.
    const sel = selectedSegment(sheet);
    const g = sel && chromeGeometry(view, sheet, sel.anim, sel.run);
    const part = g && hitChrome(g, ev.sx, ev.sy);
    if (part?.type === 'grip') {
      const members = g.members;
      drag = {
        kind: 'stripresize', anim: sel.anim, run: sel.run, side: part.side,
        fw: g.fw, fh: members[0].h, bbox: g.bbox,
        count0: members.length, count: members.length,
      };
      view.requestRender();
      return;
    }
    if (part?.type === 'insert') { commitInsertFrame(sheet, sel.anim, sel.run, part.k); view.requestRender(); return; }
    if (part?.type === 'split') { commitSplitStrip(sel.anim, sel.run.start + part.k); view.requestRender(); return; }
  }
  // Double-click (two downs on the same frame within 350ms) opens the frame
  // editor and points the timeline at the frame's animation.
  const clickHit = frameAt(sheet, ev.x, ev.y);
  const now = performance.now();
  if (clickHit && lastClick && lastClick.frameId === clickHit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    state.editingFrameId = clickHit.id;
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === clickHit.id));
    if (owner) state.selectedAnimationId = owner.id;
    state.view = 'frame';
    emit('view');
    emit('selection');
    return;
  }
  lastClick = clickHit ? { frameId: clickHit.id, t: now } : null;
  const selected = sheet.frames.find(f => f.id === state.selectedFrameId) || null;
  // Intact-strip members have no resize handles: skip hit detection entirely
  // rather than just refusing the resulting drag, so a pointer-down on a
  // handle-shaped spot falls through to the move/create checks below.
  const handle = (selected && !stripOf(sheet, selected.id)) ? hitHandle(view, selected, ev.sx, ev.sy) : null;
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      anchor: oppositeCorner(selected, handle),
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
  const hit = frameAt(sheet, ev.x, ev.y);
  if (hit) {
    if (state.selectedFrameId !== hit.id) { state.selectedFrameId = hit.id; emit('selection'); }
    // If `hit` belongs to an intact strip, the drag targets every member of
    // the grabbed SEGMENT together (move-as-unit); otherwise just the single frame.
    const strip = stripOf(sheet, hit.id);
    const run = strip ? segmentOfFrame(strip, hit.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : [hit];
    drag = {
      kind: 'move', frame: hit, anim: strip, run, members, snap: null,
      bbox: boundingBoxOf(members),
      anchor: { x: ev.x, y: ev.y }, delta: { dx: 0, dy: 0 },
    };
    view.requestRender();
    return;
  }
  if (state.selectedFrameId !== null) { state.selectedFrameId = null; emit('selection'); }
  drag = { kind: 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) { updateHover(ev, view); return; }
  if (drag.kind === 'create') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true));
  } else if (drag.kind === 'move') {
    const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y));
    drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
    const sheet = activeSheet();
    drag.snap = (drag.anim && sheet && (drag.delta.dx !== 0 || drag.delta.dy !== 0)) ? findSnap(view, sheet, drag) : null;
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false));
  } else if (drag.kind === 'stripresize') {
    const sheet = activeSheet();
    const raw = drag.side === 'right'
      ? ev.x - (drag.bbox.x + drag.bbox.w)
      : drag.bbox.x - ev.x;
    let count = drag.count0 + Math.round(raw / drag.fw);
    count = Math.max(1, count);
    if (sheet) {
      const maxCount = drag.side === 'right'
        ? Math.floor((sheet.width - drag.bbox.x) / drag.fw)
        : Math.floor((drag.bbox.x + drag.bbox.w) / drag.fw);
      count = Math.min(count, Math.max(1, maxCount));
    }
    drag.count = count;
  }
  view.requestRender();
}

function handleUp(ev, view) {
  if (!drag) return;
  handleMove(ev, view);
  const sheet = activeSheet();
  const d = drag;
  drag = null;
  view.requestRender();
  if (!sheet) return;

  if (d.kind === 'create') {
    const moved = ev.x !== d.anchor.x || ev.y !== d.anchor.y;
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1) commitCreate(sheet, d.rect);
    return;
  }
  if (d.kind === 'move') {
    if (d.snap) { commitMergeSegments(sheet, d, d.snap); return; }
    // Clamp the common delta so the whole bounding box (single frame or
    // every strip member) stays fully on-sheet — no pixels are silently
    // clipped by out-of-bounds copy/blit (pixels.js bounds-checks every
    // write/read).
    const dx = Math.max(-d.bbox.x, Math.min(sheet.width - (d.bbox.x + d.bbox.w), d.delta.dx));
    const dy = Math.max(-d.bbox.y, Math.min(sheet.height - (d.bbox.y + d.bbox.h), d.delta.dy));
    if (dx !== 0 || dy !== 0) commitMoveFrames(sheet, d.members, dx, dy);
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      commitResize(d.frame, d.before, r);
    return;
  }
  if (d.kind === 'stripresize') {
    if (d.count !== d.count0) commitResizeSegment(sheet, d);
    return;
  }
}

// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

// Ghost rect for an in-progress edge-grip resize: grows/shrinks from the
// dragged end while the opposite edge stays put.
function resizeGhostRect(d) {
  const w = d.count * d.fw;
  const x = d.side === 'right' ? d.bbox.x : d.bbox.x + d.bbox.w - w;
  return { x, y: d.bbox.y, w, h: d.bbox.h };
}

const FRAME_HANDLE = '#4f8cff';

function drawHandles(ctx, view, f) {
  ctx.fillStyle = FRAME_HANDLE;
  for (const h of HANDLES) {
    const ix = h[1] === 'w' ? f.x : f.x + f.w;
    const iy = h[0] === 'n' ? f.y : f.y + f.h;
    const p = view.imageToScreen(ix, iy);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
}

// Strip dimensions: level-0 width chain (one dimension per member, in x
// order) below the bbox, level-1 overall width, single level-0 height
// (members share it), origin marker on the bbox. dx/dy shift everything to
// the drag-ghost position; opts carries quiet/dx/dy for drawRectDims.
function drawStripDims(ctx, view, members, dx, dy, opts = {}) {
  const bbox = boundingBoxOf(members);
  const r = { x: bbox.x + dx, y: bbox.y + dy, w: bbox.w, h: bbox.h };
  const alpha = opts.quiet ? 0.7 : 1;
  const sorted = members.slice().sort((m, n) => m.x - n.x);
  drawChainDims(ctx, view, {
    axis: 'h', edge: r.y + r.h,
    spans: sorted.map(m => ({ from: m.x + dx, to: m.x + m.w + dx, text: `${m.w}` })),
    alpha,
  });
  drawRectDims(ctx, view, r, { ...opts, wLevel: 1, hLevel: 0 });
}

// Ghost grid + CAD chains for the open Slice-grid dialog: cell outlines in
// the standard dashed ghost style; level-0 chains along the TOP edge (one
// dimension per column width) and LEFT edge (one per row height); level-1
// overall region dimensions. Uses core sliceGrid so the preview always
// matches exactly what Create would produce. Degenerate inputs draw nothing.
function drawSlicePreview(ctx, view, sheet) {
  const o = slicePreviewOpts;
  if (o.cellW < 1 || o.cellH < 1) return;
  let cells;
  try {
    cells = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...o });
  } catch {
    return;
  }
  if (!cells.length) return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const c of cells) strokeGhostRect(ctx, view, c);
  ctx.restore();
  const firstRow = cells.filter(c => c.y === cells[0].y);
  const firstCol = cells.filter(c => c.x === cells[0].x);
  drawChainDims(ctx, view, {
    axis: 'h', side: 'start', edge: cells[0].y,
    spans: firstRow.map(c => ({ from: c.x, to: c.x + c.w, text: `${c.w}` })),
  });
  drawChainDims(ctx, view, {
    axis: 'v', side: 'start', edge: cells[0].x,
    spans: firstCol.map(c => ({ from: c.y, to: c.y + c.h, text: `${c.h}` })),
  });
  const lastX = Math.max(...firstRow.map(c => c.x + c.w));
  const lastY = Math.max(...firstCol.map(c => c.y + c.h));
  drawChainDims(ctx, view, {
    axis: 'h', side: 'start', edge: cells[0].y, level: 1,
    spans: [{ from: cells[0].x, to: lastX, text: `${lastX - cells[0].x}` }],
  });
  drawChainDims(ctx, view, {
    axis: 'v', side: 'start', edge: cells[0].x, level: 1,
    spans: [{ from: cells[0].y, to: lastY, text: `${lastY - cells[0].y}` }],
  });
}

// ------------------------------------------------------- in-strip chrome
// Hovering a strip segment (frame tool, idle) shows Word-style "+" insert
// call-outs above every frame boundary, "✂" split call-outs below interior
// boundaries (Task 6), and resize grips on the ends (Task 7). All geometry is
// computed in screen space per render; hits are tested on pointer-down before
// frame hit-testing.
const CALLOUT_R = 8;
const CALLOUT_OFF = 16;
let hover = null; // hovered chrome part from hitChrome() ({type,k|side}) | null

function chromeGeometry(view, sheet, anim, run) {
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return null;
  const b = boundingBoxOf(members);
  const fw = members[0].w;
  const n = members.length;
  const canInsert = b.x + b.w + fw <= sheet.width; // any insert shifts/extends right
  const inserts = [];
  if (canInsert)
    for (let k = 0; k <= n; k++) {
      const p = view.imageToScreen(b.x + k * fw, b.y);
      inserts.push({ k, cx: p.x, cy: p.y - CALLOUT_OFF });
    }
  const splits = [];
  for (let k = 1; k < n; k++) {
    const p = view.imageToScreen(b.x + k * fw, b.y + b.h);
    splits.push({ k, cx: p.x, cy: p.y + CALLOUT_OFF });
  }
  const p0 = view.imageToScreen(b.x, b.y);
  const p1 = view.imageToScreen(b.x + b.w, b.y + b.h);
  const grips = [
    { side: 'left', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { side: 'right', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
  ];
  return { members, bbox: b, fw, inserts, splits, grips };
}

function hitChrome(g, sx, sy) {
  for (const c of g.inserts)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'insert', k: c.k };
  for (const c of g.splits)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'split', k: c.k };
  for (const gr of g.grips)
    if (sx >= gr.x - 2 && sx <= gr.x + gr.w + 2 && sy >= gr.y && sy <= gr.y + gr.h)
      return { type: 'grip', side: gr.side };
  return null;
}

// Chrome only ever targets the segment containing the currently SELECTED
// frame — never whatever the pointer happens to be over — so a non-selected
// strip's call-outs/grips can't sit in front of and block the selected
// strip's commands when strips are close together or overlap. A sub-strip
// wins over its parent strip by construction: the selected frame's run IS
// the sub-strip. Chrome is VISIBLE whenever such a segment is selected;
// hovering only highlights the part under the pointer.
function selectedSegment(sheet) {
  const anim = stripOf(sheet, state.selectedFrameId);
  const run = anim ? segmentOfFrame(anim, state.selectedFrameId) : null;
  return run ? { anim, run } : null;
}

function updateHover(ev, view) {
  let next = null;
  const sheet = activeSheet();
  if (sheet && state.mode === 'sprites' && state.tool === 'frametool' && !drag) {
    const sel = selectedSegment(sheet);
    const g = sel && chromeGeometry(view, sheet, sel.anim, sel.run);
    if (g) next = hitChrome(g, ev.sx, ev.sy);
  }
  if (JSON.stringify(next) !== JSON.stringify(hover)) {
    hover = next;
    view.requestRender();
  }
}

function drawCallout(ctx, c, glyph, active) {
  ctx.beginPath();
  ctx.arc(c.cx, c.cy, CALLOUT_R, 0, Math.PI * 2);
  ctx.fillStyle = active ? '#4f8cff' : 'rgba(20,20,24,.85)';
  ctx.fill();
  ctx.strokeStyle = '#4f8cff';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = active ? '#fff' : '#a9c7ff';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, c.cx, c.cy + 0.5);
}

function drawChrome(ctx, view, sheet) {
  if (drag) return;
  const sel = selectedSegment(sheet);
  if (!sel) return;
  const g = chromeGeometry(view, sheet, sel.anim, sel.run);
  if (!g) return;
  ctx.save();
  for (const c of g.inserts)
    drawCallout(ctx, c, '+', hover?.type === 'insert' && hover.k === c.k);
  for (const c of g.splits)
    drawCallout(ctx, c, '✂', hover?.type === 'split' && hover.k === c.k);
  for (const gr of g.grips) {
    const active = hover?.type === 'grip' && hover.side === gr.side;
    ctx.globalAlpha = active ? 1 : 0.7;
    ctx.fillStyle = '#4f8cff';
    ctx.fillRect(gr.x, gr.y, gr.w, gr.h);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// A split whose halves haven't moved yet is invisible geometry — mark it.
function drawBreakSeparators(ctx, view, sheet) {
  ctx.save();
  ctx.strokeStyle = '#ffb454';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    const runs = segmentsOf(a);
    for (let i = 1; i < runs.length; i++) {
      const prev = segmentMembers(sheet, a, runs[i - 1]);
      const next = segmentMembers(sheet, a, runs[i]);
      if (!prev.length || !next.length) continue;
      const pl = prev[prev.length - 1], nf = next[0];
      if (nf.x !== pl.x + pl.w || nf.y !== pl.y) continue;
      const p0 = view.imageToScreen(nf.x, nf.y);
      const p1 = view.imageToScreen(nf.x, nf.y + nf.h);
      ctx.beginPath();
      ctx.moveTo(p0.x + 0.5, p0.y);
      ctx.lineTo(p1.x + 0.5, p1.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawFrameToolGhost(ctx, view) {
  if (state.mode !== 'sprites') return;
  const sheet = activeSheet();
  if (!sheet) return;

  if (slicePreviewOpts) drawSlicePreview(ctx, view, sheet);
  if (state.tool === 'frametool') drawBreakSeparators(ctx, view, sheet);

  if (drag) {
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
    else if (drag.kind === 'move' && drag.bbox) {
      const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
      const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
      if (drag.snap) ctx.strokeStyle = '#6adf7a';
      // Single frame or strip: the bbox already covers just the grabbed
      // frame in the non-strip case, so this one branch handles both.
      strokeGhostRect(ctx, view, { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h });
    }
    else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
    else if (drag.kind === 'stripresize') strokeGhostRect(ctx, view, resizeGhostRect(drag));
    ctx.restore();

    if (drag.kind === 'create' && drag.rect) {
      drawRectDims(ctx, view, drag.rect);
    } else if (drag.kind === 'move' && drag.bbox) {
      const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
      const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
      if (drag.members.length > 1) {
        drawStripDims(ctx, view, drag.members, dx, dy, { dx, dy });
      } else {
        const r = { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h };
        drawRectDims(ctx, view, r, { dx, dy });
      }
    } else if (drag.kind === 'resize' && drag.rect) {
      drawRectDims(ctx, view, drag.rect, {
        dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h,
      });
    } else if (drag.kind === 'stripresize') {
      const r = resizeGhostRect(drag);
      drawChainDims(ctx, view, {
        axis: 'h', edge: r.y + r.h,
        spans: Array.from({ length: drag.count }, (_, i) =>
          ({ from: r.x + i * drag.fw, to: r.x + (i + 1) * drag.fw, text: `${drag.fw}` })),
      });
      const df = drag.count - drag.count0;
      drawRectDims(ctx, view, r, {
        wLevel: 1, hLevel: 0,
        wOverride: `${r.w}${df ? ` (${df > 0 ? '+' : ''}${df}f)` : ''}`,
      });
    }

    if (drag.kind === 'move' && drag.snap) {
      const jx = drag.snap.side === 'before'
        ? drag.bbox.x + drag.snap.dx + drag.bbox.w   // dragged right edge
        : drag.bbox.x + drag.snap.dx;                 // dragged left edge
      const jy = drag.bbox.y + drag.snap.dy;
      const p0 = view.imageToScreen(jx, jy);
      const p1 = view.imageToScreen(jx, jy + drag.bbox.h);
      ctx.save();
      ctx.strokeStyle = '#6adf7a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
      ctx.restore();
    }
  }

}

// Selection chrome — the idle dims, resize handles, and the strip call-outs/
// grips — must render above EVERYTHING on the sheet overlay (including the
// frame/tile label overlays main.js chains after bindFrameTool), so it is not
// drawn inside drawFrameToolGhost — main.js chains this as the final overlay
// layer instead.
export function drawStripChrome(ctx, view) {
  if (state.mode !== 'sprites' || state.tool !== 'frametool') return;
  const sheet = activeSheet();
  if (!sheet) return;
  const selected = sheet.frames.find(f => f.id === state.selectedFrameId);
  const strip = selected ? stripOf(sheet, selected.id) : null;
  if (selected && !drag) {
    const run = strip ? segmentOfFrame(strip, selected.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : null;
    // A 1-member strip degenerates to the plain single-frame case (no
    // chain, no level-1 row) — matching the drag path's members.length gate.
    if (members && members.length > 1) drawStripDims(ctx, view, members, 0, 0, { quiet: true });
    else drawRectDims(ctx, view, selected, { quiet: true });
  }
  // No resize handles on intact-strip members.
  if (selected && !strip) drawHandles(ctx, view, selected);
  drawChrome(ctx, view, sheet);
}

// ------------------------------------------------------------- tool options row

function buildOptionsRow(optionsRow) {
  const row = document.createElement('div');
  row.className = 'tool-option-row';
  const snapInput = document.createElement('input');
  snapInput.type = 'checkbox';
  snapInput.checked = frameToolOptions.snap;
  snapInput.addEventListener('change', () => { frameToolOptions.snap = snapInput.checked; });
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number'; sizeInput.min = '1'; sizeInput.value = String(frameToolOptions.gridSize);
  sizeInput.addEventListener('change', () => {
    let v = parseInt(sizeInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    sizeInput.value = String(v);
    frameToolOptions.gridSize = v;
  });
  row.append(snapInput, document.createTextNode('Snap'), sizeInput);
  optionsRow.appendChild(row);
  return row;
}

// ------------------------------------------------------------- public API

export function registerFrameTool() {
  registerTool({ id: 'frametool', icon: '🖼', key: 'f', isAvailable: () => state.mode === 'sprites' }, buildOptionsRow);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'frametool' || state.mode !== 'sprites') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripOf(sheet, state.selectedFrameId);
    if (strip) commitRemoveMember(sheet, strip, state.selectedFrameId);
    else deleteFrame(sheet, state.selectedFrameId);
  });
}

export function bindFrameTool(view) {
  sheetViewForPreview = view;
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'sprites' && state.tool === 'frametool') {
      if (ev.type === 'down') handleDown(ev, view);
      else if (ev.type === 'move') handleMove(ev, view);
      else if (ev.type === 'up') handleUp(ev, view);
      return;
    }
    prevPointer(ev);
  };

  const prevOverlay = view.onOverlay;
  view.onOverlay = (ctx) => {
    prevOverlay(ctx);
    drawFrameToolGhost(ctx, view);
  };

  on('project', () => { if (drag) { drag = null; view.requestRender(); } });
  on('tool', () => { if (state.tool !== 'frametool' && drag) { drag = null; view.requestRender(); } });
}

// ------------------------------------------------------------- frames panel

function fieldRow(labelText, value, { step, onCommit }) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  if (step != null) input.step = String(step);
  input.value = String(value);
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => onCommit(Number(input.value)));
  label.appendChild(input);
  return label;
}

function commitFrameField(frame, key, value) {
  const before = frame[key];
  if (before === value) return;
  state.commands.push({
    label: `edit frame ${key}`,
    do() { frame[key] = value; },
    undo() { frame[key] = before; },
  });
  markDirty();
}

// ---- strip-wide edits (the frames panel's strip detail) ----
// The panel shows ONE detail block: the selected loose frame, or — when the
// selection is a strip member — the whole STRIP, where every edit applies to
// all member frames at once.

// All members of a strip animation, in animation order.
function stripMembers(sheet, anim) {
  return anim.frames.map(e => sheet.frames.find(f => f.id === e.frameId)).filter(Boolean);
}

// One undoable command over every member's geometry/pivot fields: eager-
// mutate via `mutate()`, snapshot absolutes before/after, do()/undo() swap.
function commitStripEdit(label, members, mutate) {
  const snap = () => members.map(f => [f.x, f.y, f.w, f.h, f.pivotX, f.pivotY]);
  const apply = (vals) => members.forEach((f, i) => {
    [f.x, f.y, f.w, f.h, f.pivotX, f.pivotY] = vals[i];
  });
  const before = snap();
  mutate();
  const after = snap();
  state.commands.push({
    label,
    do() { apply(after); },
    undo() { apply(before); },
  });
  markDirty();
}

// Renames the animation, its layer group, AND its member frames (`name_0`, `name_1`, …).
function commitRenameStrip(sheet, anim, members, newName) {
  const beforeAnim = anim.name;
  const beforeNames = members.map(f => f.name);
  state.commands.push({
    label: 'rename strip',
    do() { renameAnimation(sheet, anim.id, newName); members.forEach((f, i) => { f.name = `${newName}_${i}`; }); },
    undo() { renameAnimation(sheet, anim.id, beforeAnim); members.forEach((f, i) => { f.name = beforeNames[i]; }); },
  });
  markDirty();
}

// Rigid move of the whole strip (every segment keeps its relative offset) so
// its bounding box lands at (nx, ny), clamped on-sheet. Metadata-only.
function moveStripTo(sheet, members, nx, ny) {
  const b = boundingBoxOf(members);
  const dx = Math.max(-b.x, Math.min(sheet.width - b.x - b.w, Math.round(nx) - b.x));
  const dy = Math.max(-b.y, Math.min(sheet.height - b.y - b.h, Math.round(ny) - b.y));
  if (dx === 0 && dy === 0) return;
  commitStripEdit('move strip', members, () => {
    for (const f of members) { f.x += dx; f.y += dy; }
  });
}

// Shared frame size for ALL members. Width re-lays each segment out
// contiguously from its origin; height applies in place. Clamped so every
// segment stays on-sheet.
function setStripFrameSize(sheet, anim, members, key, value) {
  let v = Math.max(1, Math.round(value));
  if (key === 'w') {
    for (const run of segmentsOf(anim)) {
      const ms = segmentMembers(sheet, anim, run);
      if (ms.length) v = Math.min(v, Math.floor((sheet.width - ms[0].x) / ms.length));
    }
  } else {
    for (const f of members) v = Math.min(v, sheet.height - f.y);
  }
  v = Math.max(1, v);
  if (members.every(f => f[key] === v)) return;
  commitStripEdit(`strip frame ${key}`, members, () => {
    if (key === 'w') {
      for (const run of segmentsOf(anim)) {
        const ms = segmentMembers(sheet, anim, run);
        let x = ms[0]?.x ?? 0;
        for (const f of ms) { f.x = x; f.w = v; x += v; }
      }
    } else {
      for (const f of members) f.h = v;
    }
  });
}

function setStripPivot(members, key, value) {
  if (members.every(f => f[key] === value)) return;
  commitStripEdit('strip pivot', members, () => { for (const f of members) f[key] = value; });
}

function buildSliceDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Slice grid</h3>
    <div class="row"><label>Cell W <input type="number" id="sg-cellw" min="1" value="16"></label></div>
    <div class="row"><label>Cell H <input type="number" id="sg-cellh" min="1" value="16"></label></div>
    <div class="row"><label>Margin X <input type="number" id="sg-marginx" min="0" value="0"></label></div>
    <div class="row"><label>Margin Y <input type="number" id="sg-marginy" min="0" value="0"></label></div>
    <div class="row"><label>Spacing X <input type="number" id="sg-spacingx" min="0" value="0"></label></div>
    <div class="row"><label>Spacing Y <input type="number" id="sg-spacingy" min="0" value="0"></label></div>
    <div class="row"><label>Prefix <input type="text" id="sg-prefix" value="frame"></label></div>
    <div class="row"><label><input type="checkbox" id="sg-replace"> Replace existing frames</label></div>
    <div class="row"><button type="button" id="sg-create">Create</button><button type="button" id="sg-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  const readPreview = () => {
    const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
    return {
      cellW: intVal($('#sg-cellw'), 1), cellH: intVal($('#sg-cellh'), 1),
      marginX: intVal($('#sg-marginx'), 0), marginY: intVal($('#sg-marginy'), 0),
      spacingX: intVal($('#sg-spacingx'), 0), spacingY: intVal($('#sg-spacingy'), 0),
    };
  };
  for (const id of ['#sg-cellw', '#sg-cellh', '#sg-marginx', '#sg-marginy', '#sg-spacingx', '#sg-spacingy'])
    $(id).addEventListener('input', () => {
      if (!slicePreviewOpts) return;
      slicePreviewOpts = readPreview();
      sheetViewForPreview?.requestRender();
    });
  dlg.addEventListener('close', () => {
    slicePreviewOpts = null;
    sheetViewForPreview?.requestRender();
  });
  $('#sg-cancel').addEventListener('click', () => dlg.close());
  $('#sg-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
    const opts = {
      sheetWidth: sheet.width, sheetHeight: sheet.height,
      cellW: intVal($('#sg-cellw'), 1), cellH: intVal($('#sg-cellh'), 1),
      marginX: intVal($('#sg-marginx'), 0), marginY: intVal($('#sg-marginy'), 0),
      spacingX: intVal($('#sg-spacingx'), 0), spacingY: intVal($('#sg-spacingy'), 0),
      namePrefix: $('#sg-prefix').value.trim() || 'frame',
    };
    const newFrames = sliceGrid(opts);
    const replace = $('#sg-replace').checked;

    const beforeFrames = sheet.frames.slice();
    const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
    if (replace) {
      sheet.frames = [];
      for (const a of sheet.animations) { a.frames = []; a.breaks = []; }
    }
    for (const nf of newFrames) addFrame(sheet, nf);
    const afterFrames = sheet.frames.slice();
    const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));

    state.commands.push({
      label: 'slice grid',
      do() {
        sheet.frames = afterFrames.slice();
        for (const snap of afterAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
      },
      undo() {
        sheet.frames = beforeFrames.slice();
        for (const snap of beforeAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
      },
    });
    markDirty();
    dlg.close();
  });
  return {
    open() {
      slicePreviewOpts = readPreview();
      dlg.showModal();
      sheetViewForPreview?.requestRender();
    },
  };
}

// Creates a strip's frames + its intact (strip: true) animation as ONE
// undoable command, mirroring buildSliceDialog's whole-array-snapshot idiom
// above: eager-mutate now (addFrame/addAnimation both push into the sheet
// immediately, matching the codebase's eager-mutate-then-snapshot idiom),
// snapshot before/after of sheet.frames/sheet.animations plus the new
// animation's own .frames array, then do()/undo() just swap whole arrays.
function commitNewStrip(sheet, name, x, y, frameW, frameH, count, duration) {
  const beforeFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();

  const descriptors = buildStripFrames(name, x, y, frameW, frameH, count);
  const frames = descriptors.map(d => addFrame(sheet, d));
  const anim = addAnimation(sheet, name, true);
  anim.frames = frames.map(f => ({ frameId: f.id, duration }));

  const afterFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(f => ({ ...f }));
  const firstFrameId = frames[0].id;
  const animId = anim.id;
  const createdIds = new Set(frames.map(f => f.id));

  const cmd = {
    label: 'new strip',
    do() {
      sheet.frames = afterFrames.slice();
      sheet.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(f => ({ ...f }));
      state.selectedFrameId = firstFrameId;
      state.selectedAnimationId = animId;
    },
    undo() {
      sheet.frames = beforeFrames.slice();
      sheet.animations = beforeAnimations.slice();
      if (createdIds.has(state.selectedFrameId)) state.selectedFrameId = null;
      if (state.selectedAnimationId === animId) state.selectedAnimationId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}

// Break apart: flips an intact strip's `strip` flag off so its frames stop
// moving as a unit and become resizable again (membership in the animation
// is unaffected). Exported so timeline.js's header button can push the same
// command shape for the currently selected animation.
export function commitBreakApartStrip(anim) {
  const beforeBreaks = (anim.breaks ?? []).slice();
  state.commands.push({
    label: 'break apart strip',
    do() { anim.strip = false; anim.breaks = []; },
    undo() { anim.strip = true; anim.breaks = beforeBreaks.slice(); },
  });
  markDirty();
}

// Wires the static #dlg-newstrip markup (index.html) the same way
// buildSliceDialog wires its own dynamically-built dialog — one-time
// listener setup, called once from mountFramesPanel. Returns null if the
// dialog markup isn't present (defensive; shouldn't happen in the shipped app).
function wireNewStripDialog() {
  const dlg = document.getElementById('dlg-newstrip');
  if (!dlg) return null;
  const $ = (sel) => dlg.querySelector(sel);
  $('#strip-cancel').addEventListener('click', () => dlg.close());
  $('#strip-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
    const name = $('#strip-name').value.trim() || 'strip';
    const frameW = intVal($('#strip-frame-w'), 1);
    const frameH = intVal($('#strip-frame-h'), 1);
    const count = intVal($('#strip-count'), 1);
    const duration = intVal($('#strip-duration'), 1);
    const pos = findFreeRect(sheet, count * frameW, frameH);
    if (!pos) { alert('No free space on the sheet for this strip.'); return; }
    commitNewStrip(sheet, name, pos.x, pos.y, frameW, frameH, count, duration);
    dlg.close();
  });
  return dlg;
}

export function mountFramesPanel(el) {
  // #panel-context is shared with tilemode.js's tile panel (mode-exclusive
  // visibility). Each panel gets its own wrapper appended to `el` and toggles
  // only that wrapper — never el.hidden/el.innerHTML directly — so the two
  // mount functions don't clobber or fight over the shared container.
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Frames';
  wrap.appendChild(h3);

  const list = document.createElement('div');
  list.className = 'frame-list';
  wrap.appendChild(list);

  const sliceDialog = buildSliceDialog();
  const btnSlice = document.createElement('button');
  btnSlice.type = 'button';
  btnSlice.textContent = 'Slice grid…';
  btnSlice.addEventListener('click', () => sliceDialog.open());

  const stripDialog = wireNewStripDialog();
  const btnNewStrip = document.createElement('button');
  btnNewStrip.type = 'button';
  btnNewStrip.textContent = 'New strip…';
  btnNewStrip.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || !stripDialog) return;
    const settings = state.project?.settings ?? {};
    const $ = (sel) => stripDialog.querySelector(sel);
    $('#strip-name').value = `strip_${sheet.animations.length}`;
    $('#strip-frame-w').value = String(settings.frameW ?? 16);
    $('#strip-frame-h').value = String(settings.frameH ?? 16);
    $('#strip-count').value = '4';
    $('#strip-duration').value = String(settings.durationMs ?? 100);
    stripDialog.showModal();
  });

  // Break apart: only visible when the selected frame is a member of an
  // intact strip; toggled in renderList() below on every re-render.
  const btnBreakApart = document.createElement('button');
  btnBreakApart.type = 'button';
  btnBreakApart.textContent = 'Break apart';
  btnBreakApart.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripOf(sheet, state.selectedFrameId);
    if (strip) commitBreakApartStrip(strip);
  });

  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  btnRow.append(btnSlice, btnNewStrip, btnBreakApart);
  wrap.appendChild(btnRow);

  // Edit + Delete for the SELECTED frame (strip mode deletes just that
  // member, closing the gap — same as the Delete key).
  function actionsRow(sheet, f, inStrip) {
    const actions = document.createElement('div');
    actions.className = 'row';
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button'; btnEdit.textContent = 'Edit';
    btnEdit.addEventListener('click', () => {
      state.editingFrameId = f.id;
      state.view = 'frame';
      emit('view');
    });
    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.textContent = inStrip ? 'Delete frame' : 'Delete';
    btnDelete.addEventListener('click', () => {
      const strip = stripOf(sheet, f.id);
      if (strip) commitRemoveMember(sheet, strip, f.id);
      else deleteFrame(sheet, f.id);
    });
    actions.append(btnEdit, btnDelete);
    return actions;
  }

  function renderFrameDetail(sheet, f) {
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = f.name;
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) commitFrameField(f, 'name', v);
      else nameInput.value = f.name;
    });

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      fieldRow('X', f.x, { onCommit: (v) => commitFrameField(f, 'x', Math.round(v)) }),
      fieldRow('Y', f.y, { onCommit: (v) => commitFrameField(f, 'y', Math.round(v)) }),
      fieldRow('W', f.w, { onCommit: (v) => commitFrameField(f, 'w', Math.max(1, Math.round(v))) }),
      fieldRow('H', f.h, { onCommit: (v) => commitFrameField(f, 'h', Math.max(1, Math.round(v))) }),
      fieldRow('PivotX', f.pivotX, { step: 0.5, onCommit: (v) => commitFrameField(f, 'pivotX', v) }),
      fieldRow('PivotY', f.pivotY, { step: 0.5, onCommit: (v) => commitFrameField(f, 'pivotY', v) }),
    );

    row.append(nameInput, fields, actionsRow(sheet, f, false));
    list.appendChild(row);
  }

  // Strip detail: one block for the whole strip; every field writes to ALL
  // member frames (X/Y move the strip rigidly, W/H set the shared frame
  // size, pivots apply to each member). Name renames animation + members.
  function renderStripDetail(sheet, anim, selected) {
    const members = stripMembers(sheet, anim);
    if (!members.length) return;
    const b = boundingBoxOf(members);
    const segs = segmentsOf(anim).length;
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const title = document.createElement('div');
    title.className = 'frame-field';
    title.textContent = `Strip · ${members.length} frames${segs > 1 ? ` · ${segs} sub-strips` : ''}`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = anim.name;
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v && v !== anim.name) commitRenameStrip(sheet, anim, members, v);
      else nameInput.value = anim.name;
    });

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      fieldRow('X', b.x, { onCommit: (v) => moveStripTo(sheet, members, v, b.y) }),
      fieldRow('Y', b.y, { onCommit: (v) => moveStripTo(sheet, members, b.x, v) }),
      fieldRow('W', members[0].w, { onCommit: (v) => setStripFrameSize(sheet, anim, members, 'w', v) }),
      fieldRow('H', members[0].h, { onCommit: (v) => setStripFrameSize(sheet, anim, members, 'h', v) }),
      fieldRow('PivotX', members[0].pivotX, { step: 0.5, onCommit: (v) => setStripPivot(members, 'pivotX', v) }),
      fieldRow('PivotY', members[0].pivotY, { step: 0.5, onCommit: (v) => setStripPivot(members, 'pivotY', v) }),
    );

    row.append(title, nameInput, fields, actionsRow(sheet, selected, true));
    list.appendChild(row);
  }

  function renderList() {
    if (state.mode !== 'sprites') { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.innerHTML = '';
    const sheet = activeSheet();
    const frame = sheet?.frames.find(f => f.id === state.selectedFrameId) ?? null;
    const strip = frame ? stripOf(sheet, frame.id) : null;
    btnBreakApart.hidden = !strip;
    if (!sheet) return;
    if (!frame) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = 'No frame selected — click one with the frame tool.';
      list.appendChild(hint);
      return;
    }
    if (strip) renderStripDetail(sheet, strip, frame);
    else renderFrameDetail(sheet, frame);
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; renderList(); });
  }

  on('project', scheduleRender);
  on('history', scheduleRender);
  on('view', scheduleRender);
  on('selection', scheduleRender);
  renderList();
}
