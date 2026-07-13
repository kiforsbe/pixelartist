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

import { state, on, emit, activeSheet, markDirty } from '../app/state.js';
import { addFrame, removeFrame, addAnimation } from '../core/model.js';
import { sliceGrid } from '../core/slicing.js';
import { findFreeRect, buildStripFrames } from '../core/strips.js';
import { copyRegion, fillRegion, blitRegion } from '../core/pixels.js';
import { registerTool } from './tools.js';

const HANDLE_SCREEN_PX = 6;
const HANDLES = ['nw', 'ne', 'sw', 'se'];

// Tool options (snap checkbox + grid size number input), read by the
// pointer-drag math below and edited by the row built in buildOptionsRow().
const frameToolOptions = { snap: false, gridSize: 8 };

// In-progress drag state (create/move/resize), module-scoped like tools.js's
// `selection`/`stroke` — there is only ever one frame-tool drag at a time.
let drag = null;

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

// Union bounding box of a list of frames (their CURRENT x/y/w/h) — used both
// as the strip drag's ghost outline and as the clamp region for its delta.
function boundingBoxOf(frames) {
  const x0 = Math.min(...frames.map(f => f.x));
  const y0 = Math.min(...frames.map(f => f.y));
  const x1 = Math.max(...frames.map(f => f.x + f.w));
  const y1 = Math.max(...frames.map(f => f.y + f.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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

// Pixel-carrying move for one or more frames sharing a common delta (single
// frame in the plain case, ALL members of an intact strip when dragged as a
// unit). For every layer: copy ALL member regions first (their CURRENT
// pixels), THEN clear all of them, THEN blit all of them at their new
// positions — copying before clearing avoids corruption when member frames
// are adjacent (clearing frame A before copying frame B's original pixels
// would clobber B if A and B overlap/touch). Captures a per-layer clone of
// the UNION of every member's before/after rect so undo restores all pixels
// and all frames' x/y in one step.
function commitMoveFrames(sheet, frames, dx, dy) {
  const ux0 = Math.min(...frames.map(f => Math.min(f.x, f.x + dx)));
  const uy0 = Math.min(...frames.map(f => Math.min(f.y, f.y + dy)));
  const ux1 = Math.max(...frames.map(f => Math.max(f.x + f.w, f.x + dx + f.w)));
  const uy1 = Math.max(...frames.map(f => Math.max(f.y + f.h, f.y + dy + f.h)));
  const ur = { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };

  const beforeCoords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));

  const patches = sheet.layers.map((layer) => {
    const before = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    const copies = frames.map(f => copyRegion(layer.bitmap, f.x, f.y, f.w, f.h));
    for (const f of frames) fillRegion(layer.bitmap, f.x, f.y, f.w, f.h, [0, 0, 0, 0]);
    frames.forEach((f, i) => blitRegion(layer.bitmap, copies[i], f.x + dx, f.y + dy));
    const after = copyRegion(layer.bitmap, ur.x, ur.y, ur.w, ur.h);
    return { layer, before, after };
  });
  for (const f of frames) { f.x += dx; f.y += dy; } // already true on the bitmaps above; keep metadata in sync now too
  const afterCoords = beforeCoords.map(c => ({ frame: c.frame, x: c.x + dx, y: c.y + dy }));

  const cmd = {
    label: frames.length > 1 ? 'move strip' : 'move frame',
    do() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, ur.x, ur.y);
      for (const c of afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
    undo() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, ur.x, ur.y);
      for (const c of beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
  };
  state.commands.push(cmd);
  markDirty();
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
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));
  const wasSelected = state.selectedFrameId === frameId;
  const cmd = {
    label: 'delete frame',
    do() {
      removeFrame(sheet, frame.id);
      if (state.selectedFrameId === frame.id) state.selectedFrameId = null;
    },
    undo() {
      sheet.frames.splice(Math.min(idx, sheet.frames.length), 0, frame);
      for (const snap of animSnapshots) snap.anim.frames = snap.frames.slice();
      if (wasSelected) state.selectedFrameId = frame.id;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet();
  if (!sheet) return;
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
    // that strip together (move-as-unit); otherwise just the single frame.
    const strip = stripOf(sheet, hit.id);
    const members = strip ? sheet.frames.filter(f => strip.frames.some(af => af.frameId === f.id)) : [hit];
    drag = {
      kind: 'move', frame: hit, members, bbox: boundingBoxOf(members),
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
  if (!drag) return;
  if (drag.kind === 'create') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true));
  } else if (drag.kind === 'move') {
    const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y));
    drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false));
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
  }
}

// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
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

function drawFrameToolGhost(ctx, view) {
  if (state.mode !== 'sprites') return;
  const sheet = activeSheet();
  if (!sheet) return;

  if (drag) {
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
    else if (drag.kind === 'move' && drag.bbox)
      // Single frame or strip: the bbox already covers just the grabbed
      // frame in the non-strip case, so this one branch handles both.
      strokeGhostRect(ctx, view, { x: drag.bbox.x + drag.delta.dx, y: drag.bbox.y + drag.delta.dy, w: drag.bbox.w, h: drag.bbox.h });
    else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
    ctx.restore();
  }

  if (state.tool === 'frametool') {
    const selected = sheet.frames.find(f => f.id === state.selectedFrameId);
    // No resize handles on intact-strip members.
    if (selected && !stripOf(sheet, selected.id)) drawHandles(ctx, view, selected);
  }
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
    deleteFrame(sheet, state.selectedFrameId);
  });
}

export function bindFrameTool(view) {
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
    const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));
    if (replace) {
      sheet.frames = [];
      for (const a of sheet.animations) a.frames = [];
    }
    for (const nf of newFrames) addFrame(sheet, nf);
    const afterFrames = sheet.frames.slice();
    const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice() }));

    state.commands.push({
      label: 'slice grid',
      do() {
        sheet.frames = afterFrames.slice();
        for (const snap of afterAnimSnapshots) snap.anim.frames = snap.frames.slice();
      },
      undo() {
        sheet.frames = beforeFrames.slice();
        for (const snap of beforeAnimSnapshots) snap.anim.frames = snap.frames.slice();
      },
    });
    markDirty();
    dlg.close();
  });
  return dlg;
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
  state.commands.push({
    label: 'break apart strip',
    do() { anim.strip = false; },
    undo() { anim.strip = true; },
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
  btnSlice.addEventListener('click', () => sliceDialog.showModal());

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

  function renderList() {
    if (state.mode !== 'sprites') { wrap.hidden = true; return; }
    wrap.hidden = false;
    list.innerHTML = '';
    const sheet = activeSheet();
    btnBreakApart.hidden = !(sheet && state.selectedFrameId && stripOf(sheet, state.selectedFrameId));
    if (!sheet) return;
    sheet.frames.forEach((f, index) => {
      const row = document.createElement('div');
      row.className = 'frame-row' + (f.id === state.selectedFrameId ? ' active' : '');
      row.addEventListener('click', () => {
        if (state.selectedFrameId !== f.id) { state.selectedFrameId = f.id; emit('selection'); }
      });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'frame-name';
      nameInput.value = f.name;
      nameInput.addEventListener('click', (e) => e.stopPropagation());
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

      const actions = document.createElement('div');
      actions.className = 'row';
      const btnEdit = document.createElement('button');
      btnEdit.type = 'button'; btnEdit.textContent = 'Edit';
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        // Frame editor lands in Task 16; for now this just points state at
        // the frame and switches the view mode — no view yet consumes it.
        state.editingFrameId = f.id;
        state.view = 'frame';
        emit('view');
      });
      const btnDelete = document.createElement('button');
      btnDelete.type = 'button'; btnDelete.textContent = 'Delete';
      btnDelete.addEventListener('click', (e) => { e.stopPropagation(); deleteFrame(sheet, f.id); });
      actions.append(btnEdit, btnDelete);

      row.append(nameInput, fields, actions);
      list.appendChild(row);
    });
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
