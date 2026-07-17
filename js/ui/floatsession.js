// Floating-selection session: owns state.floating's lifecycle (create /
// transform / commit / cancel), the internal clipboard, and the global
// keyboard bindings (Enter/Escape commit/cancel, Ctrl+X/C/V clipboard).
// Pointer GESTURES (drag/scale/rotate) live in tools.js's move tool; every
// state change funnels through here so stepwise undo and auto-commit stay
// consistent. This module must never import tools.js (tools.js imports us).
import { state, on, emit, activeSheet, activeLayer, markDirty } from '../app/state.js';
import { copyRegion, fillRegion, blitRegion, blitOver, cloneBitmap, createBitmap } from '../core/pixels.js';
import { makeTransform, isIdentity, rasterizeFloat, floatBounds } from '../core/floating.js';

const views = new Map(); // viewKind ('sheet'|'frame'|'tile') -> {getSelection, setSelection, getTargetRect}
let floatCtx = null;     // { viewKind, targetRect } frozen at float creation (frame-editor confinement)
let clipboard = null;    // { srcRect, layers: [{layerId, buffer}] }

export function registerFloatView(viewKind, api) { views.set(viewKind, api); }
function activeView() { return views.get(state.view) ?? null; }
function sheetById(id) { return state.project?.sheets.find(s => s.id === id) ?? null; }
function layerIn(sheet, layerId) { return sheet.layers.find(l => l.id === layerId) ?? null; }

export function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

function rectIntersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// region + frozen target for float/cut/copy: the view's selection clamped to
// its target rect, or the whole target rect when there is no selection
function resolveRegion(viewApi, requireSelection = false) {
  const target = viewApi.getTargetRect();
  if (target.w <= 0 || target.h <= 0) return null;
  const sel = viewApi.getSelection();
  if (!sel) return requireSelection ? null : { region: { ...target }, target };
  const region = rectIntersect(sel, target);
  return region ? { region, target } : null;
}

function captureLayers(sheet, region, allLayers) {
  const layers = allLayers ? sheet.layers.slice() : (activeLayer() ? [activeLayer()] : []);
  return layers.map(l => ({
    layerId: l.id,
    buffer: copyRegion(l.bitmap, region.x, region.y, region.w, region.h),
  }));
}

// region/frameIds: the move tool passes these when the drag starts on a frame
// or strip segment (frame-float): the float cuts exactly that rect, and on
// commit the named frames' rects move with the pixels. Only honored when no
// marquee selection exists — an explicit selection always wins.
export function createFloat({ allLayers = false, region = null, frameIds = null } = {}) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return false;
  const rr = resolveRegion(viewApi);
  if (!rr) return false;
  let { region: reg, target } = rr;
  const frameFloat = !!(region && frameIds && !viewApi.getSelection());
  if (frameFloat) {
    const clamped = rectIntersect(region, target);
    if (!clamped) return false;
    reg = clamped;
  }
  const captured = captureLayers(sheet, reg, allLayers);
  if (!captured.length) return false;
  const float = {
    sheetId: sheet.id, srcRect: { ...reg }, cut: true,
    layers: captured, transform: makeTransform(),
    frameIds: frameFloat ? frameIds.slice() : null,
    // Original rect origins of the floated frames: the live-sync target
    // (rects follow the translation during the drag) and the undo baseline.
    frameOrig: frameFloat
      ? frameIds.map(id => sheet.frames.find(f => f.id === id))
          .filter(Boolean).map(f => ({ id: f.id, x: f.x, y: f.y }))
      : null,
  };
  const ctx = { viewKind: state.view, targetRect: { ...target } };
  const prevSelection = viewApi.getSelection();
  state.commands.push({
    label: 'float selection',
    do() {
      for (const { layerId } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, reg.x, reg.y, reg.w, reg.h, [0, 0, 0, 0]);
      }
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null); // float outline replaces the marquee
      emit('pixels');
    },
    undo() {
      for (const { layerId, buffer } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, reg.x, reg.y);
      }
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(prevSelection ? { ...prevSelection } : null);
      emit('pixels');
    },
  });
  markDirty();
  return true;
}

export function commitFloatIfAny() {
  const float = state.floating;
  if (!float) return;
  const ctx = floatCtx;
  const sheet = sheetById(float.sheetId);
  if (!sheet || !ctx) { state.floating = null; floatCtx = null; return; }
  // Untouched cut float: committing would restore the source exactly —
  // degrade to cancel so history gets one clean reversal, not a no-op patch.
  if (float.cut && isIdentity(float.transform)) { cancelFloatIfAny(); return; }

  const rect = rectIntersect(floatBounds(float), ctx.targetRect); // confinement
  const patches = [];
  if (rect) {
    for (const r of rasterizeFloat(float)) {
      const layer = layerIn(sheet, r.layerId);
      if (!layer) continue;
      const before = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
      const after = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
      blitOver(after, r.bitmap, r.x - rect.x, r.y - rect.y);
      patches.push({ layer, before, after });
    }
  }
  // Frame-float: the frames whose region was cut land with the pixels —
  // rects were live-synced during the drag, so the undo baseline is the
  // ORIGINAL origins captured at float creation, never the current rects.
  // (Frame-floats are translate-only — no scale handles, no rotation knob —
  // so the guard only skips degenerate states.)
  const t = float.transform;
  const dx = Math.round(t.tx), dy = Math.round(t.ty);
  const frameCoords = (float.frameOrig && t.sx === 1 && t.sy === 1 && t.rot === 0)
    ? float.frameOrig.map(o => {
        const f = sheet.frames.find(fr => fr.id === o.id);
        return f ? { frame: f, x: o.x, y: o.y } : null;
      }).filter(Boolean)
    : [];
  const sel = rect && !float.frameIds ? { ...rect } : null;
  state.commands.push({
    label: 'commit float',
    do() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, rect.x, rect.y);
      for (const c of frameCoords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; }
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(sel ? { ...sel } : null);
      emit('pixels');
    },
    undo() {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, rect.x, rect.y);
      for (const c of frameCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null);
      emit('pixels');
    },
  });
  markDirty();
}

export function cancelFloatIfAny() {
  const float = state.floating;
  if (!float) return;
  const ctx = floatCtx;
  const sheet = sheetById(float.sheetId);
  if (!sheet || !ctx) { state.floating = null; floatCtx = null; return; }
  // Live-synced frame-float rects snap back to their original origins on
  // cancel (and back to the cancelled translation on redo... i.e. undo).
  const cdx = Math.round(float.transform.tx), cdy = Math.round(float.transform.ty);
  const frameCoords = (float.frameOrig ?? []).map(o => {
    const f = sheet.frames.find(fr => fr.id === o.id);
    return f ? { frame: f, x: o.x, y: o.y } : null;
  }).filter(Boolean);
  state.commands.push({
    label: 'cancel float',
    do() {
      if (float.cut) for (const { layerId, buffer } of float.layers) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, float.srcRect.x, float.srcRect.y);
      }
      for (const c of frameCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      state.floating = null;
      floatCtx = null;
      // Frame-floats never leave a marquee behind — the frames ARE the shape.
      views.get(ctx.viewKind)?.setSelection(float.cut && !float.frameIds ? { ...float.srcRect } : null);
      emit('pixels');
    },
    undo() {
      if (float.cut) for (const { layerId } of float.layers) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, float.srcRect.x, float.srcRect.y, float.srcRect.w, float.srcRect.h, [0, 0, 0, 0]);
      }
      for (const c of frameCoords) { c.frame.x = c.x + cdx; c.frame.y = c.y + cdy; }
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null);
      emit('pixels');
    },
  });
  markDirty();
}

// Frame-float rects track the float's integer translation live, so the frame
// reads as moving (labels/overlays/panel follow) instead of a detached
// selection. No-op for plain floats.
export function syncFrameFloat() {
  const float = state.floating;
  if (!float?.frameOrig) return;
  const sheet = sheetById(float.sheetId);
  if (!sheet) return;
  const dx = Math.round(float.transform.tx), dy = Math.round(float.transform.ty);
  for (const o of float.frameOrig) {
    const f = sheet.frames.find(fr => fr.id === o.id);
    if (f) { f.x = o.x + dx; f.y = o.y + dy; }
  }
}

export function pushTransformCommand(before, after) {
  const float = state.floating;
  if (!float) return;
  if (before.tx === after.tx && before.ty === after.ty && before.sx === after.sx
    && before.sy === after.sy && before.rot === after.rot) return;
  state.commands.push({
    label: 'transform float',
    do() { float.transform = { ...after }; syncFrameFloat(); emit('pixels'); },
    undo() { float.transform = { ...before }; syncFrameFloat(); emit('pixels'); },
  });
  // no markDirty: bitmaps unchanged; state.dirty is already true from creation
}

// ---- clipboard ----

function clipboardCapture(allLayers, clearSource) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const rr = resolveRegion(viewApi, true); // cut/copy require a marquee
  if (!rr) return;
  const { region } = rr;
  const captured = captureLayers(sheet, region, allLayers);
  if (!captured.length) return;
  clipboard = { srcRect: { ...region }, layers: captured };
  if (!clearSource) return;
  state.commands.push({
    label: 'cut',
    do() {
      for (const { layerId } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, region.x, region.y, region.w, region.h, [0, 0, 0, 0]);
      }
      emit('pixels');
    },
    undo() {
      for (const { layerId, buffer } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, region.x, region.y);
      }
      emit('pixels');
    },
  });
  markDirty();
}

export function cutSelection(allLayers = false) { clipboardCapture(allLayers, true); }
export function copySelection(allLayers = false) { clipboardCapture(allLayers, false); }

export function pasteClipboard() {
  if (!clipboard) return;
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const target = viewApi.getTargetRect();
  if (target.w <= 0 || target.h <= 0) return;
  const { srcRect } = clipboard;
  // land on the source position while it still intersects the target,
  // otherwise centered in the target
  const pos = rectIntersect(srcRect, target)
    ? { x: srcRect.x, y: srcRect.y }
    : { x: target.x + Math.floor((target.w - srcRect.w) / 2), y: target.y + Math.floor((target.h - srcRect.h) / 2) };
  // buffers reattach to their original layers when those still exist;
  // otherwise flatten them (captured z-order) onto the active layer
  let layers = clipboard.layers
    .filter(e => layerIn(sheet, e.layerId))
    .map(e => ({ layerId: e.layerId, buffer: cloneBitmap(e.buffer) }));
  if (!layers.length) {
    const flat = createBitmap(srcRect.w, srcRect.h);
    for (const e of clipboard.layers) blitOver(flat, e.buffer, 0, 0);
    const al = activeLayer();
    if (!al) return;
    layers = [{ layerId: al.id, buffer: flat }];
  }
  const float = {
    sheetId: sheet.id, srcRect: { x: pos.x, y: pos.y, w: srcRect.w, h: srcRect.h },
    cut: false, layers, transform: makeTransform(),
  };
  const ctx = { viewKind: state.view, targetRect: { ...target } };
  const prevSelection = viewApi.getSelection();
  // switch to the move tool BEFORE pushing: the on('tool') auto-commit hook
  // skips 'move', so the fresh float survives its own tool switch
  if (state.tool !== 'move') { state.tool = 'move'; emit('tool'); }
  state.commands.push({
    label: 'paste',
    do() {
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null);
      emit('pixels');
    },
    undo() {
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(prevSelection ? { ...prevSelection } : null);
      emit('pixels');
    },
  });
  // paste can be the FIRST edit of a clean project — without this, the
  // beforeunload guard and autosave stay off until the float commits
  // (pushTransformCommand assumes dirty is already set at float creation).
  markDirty();
}

// ---- auto-commit hooks + keyboard ----

function onKeydown(e) {
  if (document.querySelector('dialog[open]')) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (key === 'x') { e.preventDefault(); cutSelection(e.altKey); return; }
    if (key === 'c') { e.preventDefault(); copySelection(e.altKey); return; }
    if (key === 'v') { e.preventDefault(); pasteClipboard(); return; }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !state.floating) return;
  // capture-phase + stopImmediatePropagation: Escape must cancel the float
  // WITHOUT also exiting the frame editor or clearing a marquee (their own
  // window listeners run in the bubble phase)
  if (e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); commitFloatIfAny(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancelFloatIfAny(); }
}

export function initFloatSession() {
  on('tool', () => { if (state.tool !== 'move') commitFloatIfAny(); });
  on('view', () => {
    if (!state.floating || !floatCtx) return;
    if (state.activeSheetId !== state.floating.sheetId || state.view !== floatCtx.viewKind) commitFloatIfAny();
  });
  // project REPLACEMENT (New/Open) drops the float without a command — the
  // command stack was cleared and the old bitmaps are gone
  let lastProject = state.project;
  on('project', () => {
    if (state.project === lastProject) return;
    lastProject = state.project;
    state.floating = null;
    floatCtx = null;
  });
  window.addEventListener('keydown', onKeydown, true);
}
