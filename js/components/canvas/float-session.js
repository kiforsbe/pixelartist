// Floating-selection session: owns state.floating's lifecycle (create /
// transform / commit / cancel), the internal clipboard, and the global
// keyboard bindings (Enter/Escape commit/cancel, Ctrl+X/C/V clipboard).
// Pointer GESTURES (drag/scale/rotate) live in drawing-engine.js's move tool;
// every state change funnels through here so stepwise undo and auto-commit
// stay consistent. This module must never import drawing-engine.js
// (drawing-engine.js imports us).
import { state, on, emit, activeSheet, activeLayer, activeLayerScope, maybeSnapPixels } from '../../app/state.js';
import { copyRegion, fillRegion, blitRegion, blitOver, cloneBitmap, createBitmap } from '../../core/pixels.js';
import { findLayer } from '../../core/model.js';
import { makeTransform, isIdentity, rasterizeFloat, floatBounds } from '../../core/floating.js';
import { decodePng } from '../../app/pngcodec.js';
import { exportPngBlob } from '../../app/io.js';
import { isTypingTarget } from '../dom-utils.js';
import { getEditorHost } from '../../host/runtime.js';

export { isTypingTarget };

const views = new Map(); // viewKind ('sheet'|'frame'|'tile') -> {getSelection, setSelection, getTargetRect}
let floatCtx = null;     // { viewKind, targetRect } frozen at float creation (frame-editor confinement)
let clipboard = null;    // { srcRect, layers: [{layerId, buffer}], allLayers }

export function registerFloatView(viewKind, api) { views.set(viewKind, api); }

// Selection-or-target region for the CURRENT view, same rule createFloat
// uses (selection clamped to target, or the whole target when there's no
// selection) -- null when there's no active view/sheet or the target is
// empty. Read-only: unlike createFloat, never touches state.floating.
export function currentEditRegion() {
  const viewApi = activeView();
  return viewApi ? resolveRegion(viewApi, false, null) : null;
}
function activeView() { return views.get(state.view) ?? null; }
function sheetById(id) { return state.project?.sheets.find(s => s.id === id) ?? null; }
function layerIn(sheet, layerId) { return findLayer(sheet.layerTree, layerId); }

function rectIntersect(a, b) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// region + frozen target for float/cut/copy: the view's selection clamped to
// its target rect, or the whole target rect when there is no selection.
// `anchor` is the point passed to getTargetRect() to resolve which segment
// of an accepted strip applies (see docs/superpowers/specs/2026-07-18-
// strip-area-constraint-design.md) -- callers with a more specific point
// than the current selection (e.g. createFloat's frame-segment region) pass
// it explicitly; otherwise this falls back to the selection's own corner.
function resolveRegion(viewApi, requireSelection = false, anchor = null) {
  const sel = viewApi.getSelection();
  const point = anchor ?? (sel ? { x: sel.x, y: sel.y } : null);
  const target = viewApi.getTargetRect(point?.x, point?.y);
  if (target.w <= 0 || target.h <= 0) return null;
  if (!sel) return requireSelection ? null : { region: { ...target }, target };
  const region = rectIntersect(sel, target);
  return region ? { region, target } : null;
}

function captureLayers(sheet, region, allLayers, explicitLayers = null) {
  const layers = explicitLayers ?? (allLayers ? activeLayerScope() : (activeLayer() ? [activeLayer()] : []));
  return layers.map(l => ({
    layerId: l.id,
    buffer: copyRegion(l.bitmap, region.x, region.y, region.w, region.h),
  }));
}

// Composites captured {layerId, buffer} entries (bottom-to-top, same order
// captureLayers/currentContextLayers produced) into one bitmap -- used both
// for the OS-clipboard PNG (always merged) and for pasteClipboard's
// reattach-fails fallback (paste merged onto the active layer).
function flattenCaptured(captured, w, h) {
  const flat = createBitmap(w, h);
  for (const e of captured) blitOver(flat, e.buffer, 0, 0);
  return flat;
}

// region/frameIds: the move tool passes these when the drag starts on a frame
// or strip segment (frame-float): the float cuts exactly that rect, and on
// commit the named frames' rects move with the pixels. Only honored when no
// marquee selection exists — an explicit selection always wins.
export function createFloat({ allLayers = false, region = null, frameIds = null, layers: explicitLayers = null, x = null, y = null } = {}) {
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return false;
  const anchor = region ? { x: region.x, y: region.y } : (x != null ? { x, y } : null);
  const rr = resolveRegion(viewApi, false, anchor);
  if (!rr) return false;
  let { region: reg, target } = rr;
  const frameFloat = !!(region && frameIds && !viewApi.getSelection());
  if (frameFloat) {
    const clamped = rectIntersect(region, target);
    if (!clamped) return false;
    reg = clamped;
  }
  const captured = captureLayers(sheet, reg, allLayers, explicitLayers);
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
  getEditorHost().history.execute({
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
  getEditorHost().projects.markDirty();
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
  getEditorHost().history.execute({
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
  getEditorHost().projects.markDirty();
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
  getEditorHost().history.execute({
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
  getEditorHost().projects.markDirty();
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
  getEditorHost().history.execute({
    label: 'transform float',
    do() { float.transform = { ...after }; syncFrameFloat(); emit('pixels'); },
    undo() { float.transform = { ...before }; syncFrameFloat(); emit('pixels'); },
  });
  // no markDirty: bitmaps unchanged; state.dirty is already true from creation
}

// ---- clipboard ----

// Fire-and-forget: mirrors a copy/cut onto the OS clipboard as a flattened
// PNG so it can be pasted into other apps (Word, an image editor, etc).
// Silently no-ops without navigator.clipboard/ClipboardItem support (older
// browsers, insecure context) or without permission -- the internal
// clipboard variable above already covers same-app paste either way.
async function writeSystemClipboardImage(captured, w, h) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
  try {
    const blob = await exportPngBlob(flattenCaptured(captured, w, h));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  } catch (e) {
    console.warn(`Could not write image to system clipboard: ${e.message}`);
  }
}

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
  clipboard = { srcRect: { ...region }, layers: captured, allLayers };
  writeSystemClipboardImage(captured, region.w, region.h);
  if (!clearSource) return;
  getEditorHost().history.execute({
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
  getEditorHost().projects.markDirty();
}

export function cutSelection(allLayers = false) { clipboardCapture(allLayers, true); }
export function copySelection(allLayers = false) { clipboardCapture(allLayers, false); }

export function hasSelection() { return !!activeView()?.getSelection(); }

// Shared by pasteClipboard (internal) and pasteSystemImage (OS clipboard):
// lands `layers` as a new cut:false float at `pos`, switches to the move
// tool, and pushes one undoable 'paste' command.
function installPastedFloat(viewApi, sheet, target, layers, w, h, pos) {
  const float = {
    sheetId: sheet.id, srcRect: { x: pos.x, y: pos.y, w, h },
    cut: false, layers, transform: makeTransform(),
  };
  const ctx = { viewKind: state.view, targetRect: { ...target } };
  const prevSelection = viewApi.getSelection();
  // switch to the move tool BEFORE pushing: the on('tool') auto-commit hook
  // skips 'move', so the fresh float survives its own tool switch
  if (state.tool !== 'move') { state.tool = 'move'; emit('tool'); }
  getEditorHost().history.execute({
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
  getEditorHost().projects.markDirty();
}

export function pasteClipboard() {
  if (!clipboard) return;
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  if (!viewApi || !sheet) return;
  const { srcRect } = clipboard;
  // Anchor the confinement lookup at the ORIGINAL copy position -- pasting
  // back into the same strip segment it was copied from is the common case,
  // and more precise than falling back to the currently selected frame.
  const target = viewApi.getTargetRect(srcRect.x, srcRect.y);
  if (target.w <= 0 || target.h <= 0) return;
  // land on the source position while it still intersects the target,
  // otherwise centered in the target
  const pos = rectIntersect(srcRect, target)
    ? { x: srcRect.x, y: srcRect.y }
    : { x: target.x + Math.floor((target.w - srcRect.w) / 2), y: target.y + Math.floor((target.h - srcRect.h) / 2) };
  let layers;
  if (clipboard.allLayers) {
    // Multi-layer copy: each buffer reattaches to its own original layer
    // when that layer still exists (preserves which pixels belonged to
    // which layer); otherwise flatten the whole capture onto the active layer.
    layers = clipboard.layers
      .filter(e => layerIn(sheet, e.layerId))
      .map(e => ({ layerId: e.layerId, buffer: cloneBitmap(e.buffer) }));
    if (!layers.length) {
      const al = activeLayer();
      if (!al) return;
      layers = [{ layerId: al.id, buffer: flattenCaptured(clipboard.layers, srcRect.w, srcRect.h) }];
    }
  } else {
    // Single-layer copy: always pastes onto whichever layer is active RIGHT
    // NOW, not the one it was copied from -- reattaching to the original
    // layer regardless of the current selection meant copying from layer A,
    // selecting layer B, and pasting still landed back on A.
    const al = activeLayer();
    if (!al) return;
    layers = [{ layerId: al.id, buffer: cloneBitmap(clipboard.layers[0].buffer) }];
  }
  installPastedFloat(viewApi, sheet, target, layers, srcRect.w, srcRect.h, pos);
}

// Reads the first image/* item off the OS clipboard and decodes it to a
// bitmap. decodePng's actual decode (createImageBitmap) sniffs the real
// image format from content, not the Blob's declared type, so this works
// for whatever format the source app offered (Windows normalizes most
// clipboard image sources -- Photos, Snipping Tool, Paint -- to image/png).
async function readSystemClipboardBitmap() {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      return await decodePng(new Uint8Array(await blob.arrayBuffer()));
    }
  } catch (e) {
    console.warn(`Could not read system clipboard: ${e.message}`);
  }
  return null;
}

// Pastes an image from the OS clipboard (e.g. copied in Windows Photos, a
// browser, Snipping Tool) as a new float on the active layer. Only called
// when the internal clipboard is empty -- see onKeydown -- so a same-app
// copy/paste always keeps its richer per-layer reattachment behavior.
// There's no "original position" for an externally-sourced image, so it
// always lands centered in the current view's target rect.
async function pasteSystemImage() {
  let bitmap = await readSystemClipboardBitmap();
  if (!bitmap) return;
  bitmap = maybeSnapPixels(bitmap);
  commitFloatIfAny();
  const viewApi = activeView();
  const sheet = activeSheet();
  const al = activeLayer();
  if (!viewApi || !sheet || !al) return;
  const target = viewApi.getTargetRect();
  if (target.w <= 0 || target.h <= 0) return;
  const pos = {
    x: target.x + Math.floor((target.w - bitmap.width) / 2),
    y: target.y + Math.floor((target.h - bitmap.height) / 2),
  };
  installPastedFloat(viewApi, sheet, target, [{ layerId: al.id, buffer: bitmap }], bitmap.width, bitmap.height, pos);
}

// Menu-facing paste: mirrors what Ctrl+V already does (internal clipboard
// first, OS clipboard image as fallback) as a single callable, since the
// keydown handler below inlines that branch instead of calling a function.
export function paste() {
  if (clipboard) pasteClipboard(); else pasteSystemImage();
}

// ---- auto-commit hooks + keyboard ----

function onKeydown(e) {
  if (document.querySelector('dialog[open]')) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
    if (key === 'x') { e.preventDefault(); cutSelection(e.altKey); return; }
    if (key === 'c') { e.preventDefault(); copySelection(e.altKey); return; }
    // internal clipboard wins when set (richer: per-layer reattachment,
    // lands back at the source position) -- system clipboard is the
    // fallback for pasting an image copied in another app.
    if (key === 'v') { e.preventDefault(); if (clipboard) pasteClipboard(); else pasteSystemImage(); return; }
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
