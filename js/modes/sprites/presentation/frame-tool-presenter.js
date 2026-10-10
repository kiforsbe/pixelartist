// js/modes/sprites/presentation/frame-tool-presenter.js
// Humble Object for the frame tool: binds pointer + keyboard events, calls
// pure Application-layer geometry for every decision, dispatches Commands BY
// ID, and delegates all drawing to frame-overlay-renderer.js.
//
// registerFrameTool() adds the palette button + its tool-options row (snap
// checkbox, grid size, slice button) and the Delete key handler;
// bindFrameTool(view) wraps the view's existing onPointer/onOverlay, so it
// must run after bindDrawing() has installed its own.
//
// A frame an auto-laid-out animation places ("pinned", see
// domain/sprites/auto-layout.js) selects and opens like any other, but never
// drags or resizes here: its rect belongs to the layout.
//
// Every frame on a sprite sheet is the sheet's sprite size, so there a drag
// on empty sheet places a frame of that size (its outline follows the
// pointer; release makes it, Escape cancels, a plain click only deselects)
// and frames have no resize handles; Sprite size in Animations resizes them.
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { registerTool } from '../../../components/tool-palette.js';
import { isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../../core/resizeAnchor.js';
import { isPinnedFrame } from '../../../domain/sprites/auto-layout.js';
import { frameToolOptions } from '../application/frame-tool-state.js';
import { snapPoint, snapRect, rectBetween, frameAt, clampMoveDelta, stampRect } from '../application/frame-geometry.js';
import { hitHandle } from '../application/frame-chrome-geometry.js';
import { paintFrameToolGhost, paintFrameChrome } from './frame-overlay-renderer.js';
import { buildSliceDialog, setSlicePreviewView, slicePreviewOptions } from './slice-grid-dialog.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { bindDragCancelGuard } from '../../../components/canvas/drag-cancel-guard.js';

// In-progress drag state (create/stamp/move/resize), module-scoped like
// drawing-engine.js's `selection`/`stroke` -- there is only ever one
// frame-tool drag at a time. `lastClick` is the previous pointerdown's
// { frameId, t } for double-click detection.
let drag = null;
let lastClick = null;

// Set once by registerFrameTool() (which builds the dialog before the tool
// palette can render its options row); the button just defers to whatever's
// there.
let sliceDialogApi = null;

function projector(view) { return (x, y) => view.imageToScreen(x, y); }

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- tests/architecture.test.mjs bans
// presentation-layer code from importing anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function currentModeId() { return getEditorHost().store.getState().session.activeModeId; }
function currentToolId() { return getEditorHost().store.getState().session.activeToolId; }
function storeOn(event, handler) {
  const store = getEditorHost().store;
  if (event === 'project') return store.subscribe(s => s.project.model, handler);
  if (event === 'tool') return store.subscribe(s => s.session.activeToolId, handler);
  throw new Error(`storeOn: unsupported event "${event}"`);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
function sheetSelection(sheet) {
  return getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
}
function setSheetSelection(sheet, patch) {
  getEditorHost().selections.set({ ...sheetSelection(sheet), ...patch }, sheetDocument(sheet));
}
function ownerAnimationId(sheet, frameId) {
  return sheet.animations.find(a => a.frames.some(e => e.frameId === frameId))?.id ?? null;
}

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet('sprite');
  if (!sheet) return;
  const hit = frameAt(sheet, ev.x, ev.y);
  // Double-click (two downs on the same frame within 350ms) opens the frame
  // editor and points the timeline at the frame's animation.
  const now = performance.now();
  if (hit && lastClick && lastClick.frameId === hit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    setSheetSelection(sheet, { animationId: ownerAnimationId(sheet, hit.id), editingFrameId: hit.id });
    getEditorHost().store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
    return;
  }
  lastClick = hit ? { frameId: hit.id, t: now } : null;
  const selected = sheet.frames.find(f => f.id === sheetSelection(sheet).frameId) || null;
  // Pinned frames, and every frame on a sheet with one sprite size, have no
  // resize handles: skip the hit test entirely so a down on a handle-shaped
  // spot falls through to the select checks below.
  const resizable = selected && !sheet.spriteSize && !isPinnedFrame(sheet, selected.id);
  const handle = resizable ? hitHandle(projector(view), selected, ev.sx, ev.sy) : null;
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
  if (hit) {
    // Selecting a frame also selects its owning animation (or clears it for
    // a standalone frame), so the timeline never keeps a stale animation.
    const ownerId = ownerAnimationId(sheet, hit.id);
    const current = sheetSelection(sheet);
    if (current.frameId !== hit.id || current.animationId !== ownerId) setSheetSelection(sheet, { frameId: hit.id, animationId: ownerId });
    if (!isPinnedFrame(sheet, hit.id)) {
      drag = {
        kind: 'move', frame: hit, bbox: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
        anchor: { x: ev.x, y: ev.y }, delta: { dx: 0, dy: 0 },
      };
    }
    view.requestRender();
    return;
  }
  const cleared = sheetSelection(sheet);
  if (cleared.frameId != null || cleared.animationId != null) setSheetSelection(sheet, { frameId: null, animationId: null });
  // The rect appears once the pointer moves: a plain click only deselects.
  drag = { kind: sheet.spriteSize ? 'stamp' : 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) return;
  if (drag.kind === 'stamp') {
    const sheet = activeSheet('sprite');
    const moved = ev.x !== drag.anchor.x || ev.y !== drag.anchor.y;
    if (sheet?.spriteSize && moved) drag.rect = stampRect(sheet, sheet.spriteSize, ev.x, ev.y, frameToolOptions);
  } else if (drag.kind === 'create') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true), frameToolOptions);
  } else if (drag.kind === 'move') {
    const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y), frameToolOptions);
    drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    }), frameToolOptions);
  }
  view.requestRender();
}

function handleUp(ev, view) {
  if (!drag) return;
  handleMove(ev, view);
  const sheet = activeSheet('sprite');
  const d = drag;
  drag = null;
  view.requestRender();
  if (!sheet) return;

  if (d.kind === 'stamp') {
    const moved = ev.x !== d.anchor.x || ev.y !== d.anchor.y;
    if (!moved) return;
    if (d.rect) dispatch('sprites.createFrame', { sheetId: sheet.id, rect: d.rect });
    else if (sheet.spriteSize && typeof alert !== 'undefined') alert(`The sprite size (${sheet.spriteSize.w}×${sheet.spriteSize.h}) is larger than this sheet`);
    return;
  }
  if (d.kind === 'create') {
    const moved = ev.x !== d.anchor.x || ev.y !== d.anchor.y;
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1)
      dispatch('sprites.createFrame', { sheetId: sheet.id, rect: d.rect });
    return;
  }
  if (d.kind === 'move') {
    // Keep the whole frame on-sheet. A zero delta is a no-op in moveFrames.
    const { dx, dy } = clampMoveDelta(sheet, d.bbox, d.delta);
    dispatch('sprites.moveFrames', { sheetId: sheet.id, frameIds: [d.frame.id], dx, dy });
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      dispatch('sprites.resizeFrame', { sheetId: sheet.id, frameId: d.frame.id, before: d.before, after: r });
  }
}

// ------------------------------------------------------------- tool options row

function buildOptionsRow(optionsRow) {
  // Three controls (Snap checkbox, grid size, slice-grid button) don't fit on
  // one row in the 112px-wide tool palette -- split into stacked rows,
  // grouping the snap checkbox with its grid-size field (they're read
  // together) and giving the slice action its own row.
  const snapRow = document.createElement('label');
  snapRow.className = 'tool-option-row';
  const snapInput = document.createElement('input');
  snapInput.type = 'checkbox';
  snapInput.checked = frameToolOptions.snap;
  snapInput.addEventListener('change', () => { frameToolOptions.snap = snapInput.checked; });
  snapRow.append(document.createTextNode('Snap'), snapInput);

  const sizeRow = document.createElement('div');
  sizeRow.className = 'tool-option-row';
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number'; sizeInput.min = '1'; sizeInput.value = String(frameToolOptions.gridSize);
  sizeInput.addEventListener('change', () => {
    let v = parseInt(sizeInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    sizeInput.value = String(v);
    frameToolOptions.gridSize = v;
  });
  sizeRow.append(document.createTextNode('Grid'), sizeInput);

  const sliceRow = document.createElement('div');
  sliceRow.className = 'tool-option-row';
  const sliceBtn = document.createElement('button');
  sliceBtn.type = 'button';
  sliceBtn.className = 'btn-icon-md';
  sliceBtn.textContent = '▦';
  sliceBtn.title = 'Slice grid…';
  sliceBtn.addEventListener('click', () => sliceDialogApi?.open());
  sliceRow.append(document.createTextNode('Slice'), sliceBtn);

  optionsRow.append(snapRow, sizeRow, sliceRow);
  return [snapRow, sizeRow, sliceRow];
}

// ------------------------------------------------------------- public API

export function registerFrameTool() {
  sliceDialogApi = buildSliceDialog();
  registerTool({ id: 'frametool', icon: '🖼', key: 'f', isAvailable: () => currentModeId() === 'sprites' }, buildOptionsRow);

  // contributions.js routes a pinned frame's delete through the layout.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (currentToolId() !== 'frametool' || currentModeId() !== 'sprites') return;
    const sheet = activeSheet('sprite');
    const frameId = sheet ? (sheetSelection(sheet).frameId ?? null) : null;
    if (frameId) dispatchLayout('sprites.deleteFrame', { sheetId: sheet.id, frameId });
  });
}

function drawFrameToolGhost(ctx, view) {
  if (currentModeId() !== 'sprites') return;
  paintFrameToolGhost(ctx, view, activeSheet('sprite'), { drag, slicePreview: slicePreviewOptions() });
}

// Chained by contributions.js as the final sheet-overlay layer so selection
// chrome sits above the frame/tile label overlays.
export function drawFrameChrome(ctx, view) {
  if (currentModeId() !== 'sprites') return;
  const sheet = activeSheet('sprite');
  paintFrameChrome(ctx, view, sheet, {
    tool: currentToolId(), drag, selectedFrameId: sheet ? (sheetSelection(sheet).frameId ?? null) : null,
  });
}

export function bindFrameTool(view) {
  setSlicePreviewView(view);
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (currentModeId() === 'sprites' && currentToolId() === 'frametool') {
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

  bindDragCancelGuard(storeOn, {
    isToolActive: () => currentToolId() === 'frametool',
    hasDrag: () => !!drag,
    cancel: () => { drag = null; },
    requestRender: () => view.requestRender(),
  });
  // Escape abandons a frame-tool drag (the release then does nothing).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drag) return;
    drag = null;
    view.requestRender();
  });
}
