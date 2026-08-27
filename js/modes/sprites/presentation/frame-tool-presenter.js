// js/modes/sprites/presentation/frame-tool-presenter.js
// Humble Object for the frame/strip tool: binds pointer + keyboard events,
// calls pure Application-layer geometry for every decision, dispatches
// Commands BY ID, and delegates all drawing to frame-overlay-renderer.js.
//
// API shape mirrors tool-palette.js/drawing-engine.js's split between "mount
// UI" and "bind a CanvasView": registerFrameTool() adds the palette button +
// its tool-options row (snap checkbox, grid size, slice button) and the
// Delete/Enter key handlers; bindFrameTool(view) wraps the view's existing
// onPointer/onOverlay, so it must run after bindDrawing() has installed its own.
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { registerTool } from '../../../components/tool-palette.js';
import { isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../../core/resizeAnchor.js';
import { segmentOfFrame, segmentMembers } from '../../../core/strips.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';
import { frameToolOptions } from '../application/frame-tool-state.js';
import {
  snapPoint, snapRect, rectBetween, frameAt, clampMoveDelta, stripResizeCount,
} from '../application/frame-geometry.js';
import {
  hitHandle, hitGrip, hitChrome, chromeGeometry, standaloneGripGeometry, selectedSegment, findSnap,
} from '../application/frame-chrome-geometry.js';
import { paintFrameToolGhost, paintStripChrome } from './frame-overlay-renderer.js';
import { buildSliceDialog, setSlicePreviewView, slicePreviewOptions } from './slice-grid-dialog.js';
import { bindDragCancelGuard } from '../../../components/canvas/drag-cancel-guard.js';

// In-progress drag state (create/move/resize/stripresize), module-scoped like
// drawing-engine.js's `selection`/`stroke` — there is only ever one frame-tool drag
// at a time. `lastClick` is the previous pointerdown's { frameId, t } for
// double-click detection; `hover` is the chrome part under the pointer.
let drag = null;
let lastClick = null;
let hover = null;

// Set once by registerFrameTool() (which builds the dialog before the tool
// palette can render its options row); the button just defers to whatever's
// there.
let sliceDialogApi = null;

// Sheet-space -> screen-space projector handed to the Application layer's
// chrome geometry, so it never has to know about CanvasView.
function projector(view) { return (x, y) => view.imageToScreen(x, y); }

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly — this Presenter lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
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

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet('sprite');
  if (!sheet) return;
  const toScreen = projector(view);
  if (currentToolId() === 'frametool') {
    // Chrome is always visible for the selected segment, so hit-test it
    // directly at the down position — no dependence on hover state.
    const sel = selectedSegment(sheet, sheetSelection(sheet).frameId ?? null);
    const g = sel && chromeGeometry(toScreen, sheet, sel.anim, sel.run);
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
    if (part?.type === 'insert') {
      dispatch('sprites.insertStripFrame', { sheetId: sheet.id, animationId: sel.anim.id, runIndex: sel.run.index, k: part.k });
      view.requestRender();
      return;
    }
    if (part?.type === 'split') {
      dispatch('sprites.splitStrip', { sheetId: sheet.id, animationId: sel.anim.id, index: sel.run.start + part.k });
      view.requestRender();
      return;
    }
  }
  // Double-click (two downs on the same frame within 350ms) opens the frame
  // editor and points the timeline at the frame's animation.
  const clickHit = frameAt(sheet, ev.x, ev.y);
  const now = performance.now();
  if (clickHit && lastClick && lastClick.frameId === clickHit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === clickHit.id)) ?? null;
    setSheetSelection(sheet, { animationId: owner ? owner.id : null, editingFrameId: clickHit.id });
    getEditorHost().store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
    return;
  }
  lastClick = clickHit ? { frameId: clickHit.id, t: now } : null;
  const selected = sheet.frames.find(f => f.id === sheetSelection(sheet).frameId) || null;
  // Intact-strip members have no resize handles: skip hit detection entirely
  // rather than just refusing the resulting drag, so a pointer-down on a
  // handle-shaped spot falls through to the move/create checks below.
  const handle = (selected && !stripForFrame(sheet, selected.id)) ? hitHandle(toScreen, selected, ev.sx, ev.sy) : null;
  if (handle) {
    drag = {
      kind: 'resize', frame: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }
  // Standalone frame's own "drag out as a new strip" grip -- checked after
  // corner handles (so a corner still resizes) but before the plain move/
  // create checks below. Reuses the 'stripresize' drag kind with anim: null
  // to mean "no strip exists yet"; the ghost/dims are anim-agnostic already,
  // so only handleUp branches (newStripFromFrame vs resizeStripSegment).
  if (selected && !stripForFrame(sheet, selected.id)) {
    const sg = standaloneGripGeometry(toScreen, selected);
    const gripHit = hitGrip(sg.grips, ev.sx, ev.sy);
    if (gripHit) {
      drag = {
        kind: 'stripresize', anim: null, run: null, frame: selected, side: gripHit.side,
        fw: sg.fw, fh: sg.fh, bbox: sg.bbox, count0: 1, count: 1,
      };
      view.requestRender();
      return;
    }
  }
  const hit = frameAt(sheet, ev.x, ev.y);
  if (hit) {
    // Selecting a frame also selects its owning animation (or clears the
    // animation selection when the frame is standalone), so the timeline
    // and layers panel never keep a stale animation highlighted.
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === hit.id)) ?? null;
    const ownerId = owner ? owner.id : null;
    const current = sheetSelection(sheet);
    const frameChanged = current.frameId !== hit.id;
    const animChanged = current.animationId !== ownerId;
    if (frameChanged || animChanged) setSheetSelection(sheet, { frameId: hit.id, animationId: ownerId });
    // If `hit` belongs to an intact strip, the drag targets every member of
    // the grabbed SEGMENT together (move-as-unit); otherwise just the frame.
    const strip = stripForFrame(sheet, hit.id);
    const run = strip ? segmentOfFrame(strip, hit.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : [hit];
    drag = {
      kind: 'move', frame: hit, anim: strip, run, members, snap: null,
      bbox: frameBounds(members),
      anchor: { x: ev.x, y: ev.y }, delta: { dx: 0, dy: 0 },
    };
    view.requestRender();
    return;
  }
  const cleared = sheetSelection(sheet);
  if (cleared.frameId != null || cleared.animationId != null) {
    setSheetSelection(sheet, { frameId: null, animationId: null });
  }
  drag = { kind: 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) { updateHover(ev, view); return; }
  if (drag.kind === 'create') {
    drag.rect = snapRect(rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true), frameToolOptions);
  } else if (drag.kind === 'move') {
    const target = snapPoint(drag.frame.x + (ev.x - drag.anchor.x), drag.frame.y + (ev.y - drag.anchor.y), frameToolOptions);
    drag.delta = { dx: target.x - drag.frame.x, dy: target.y - drag.frame.y };
    const sheet = activeSheet('sprite');
    drag.snap = (drag.anim && sheet && (drag.delta.dx !== 0 || drag.delta.dy !== 0)) ? findSnap(sheet, drag, view.zoom) : null;
  } else if (drag.kind === 'resize') {
    drag.rect = snapRect(resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    }), frameToolOptions);
  } else if (drag.kind === 'stripresize') {
    drag.count = stripResizeCount(activeSheet('sprite'), drag, ev.x);
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

  if (d.kind === 'create') {
    const moved = ev.x !== d.anchor.x || ev.y !== d.anchor.y;
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1)
      dispatch('sprites.createFrame', { sheetId: sheet.id, rect: d.rect });
    return;
  }
  if (d.kind === 'move') {
    if (d.snap) {
      dispatch('sprites.mergeStripSegments', {
        sheetId: sheet.id, animationId: d.anim.id, runIndex: d.run.index,
        targetAnimationId: d.snap.anim.id, targetRunIndex: d.snap.run.index,
        side: d.snap.side, dx: d.snap.dx, dy: d.snap.dy,
      });
      return;
    }
    // Clamp the common delta so the whole bounding box (single frame or every
    // strip member) stays fully on-sheet. A zero delta is a no-op inside the
    // moveFrames handler, so no guard is needed here.
    const { dx, dy } = clampMoveDelta(sheet, d.bbox, d.delta);
    dispatch('sprites.moveFrames', {
      sheetId: sheet.id, frameIds: d.members.map(f => f.id), dx, dy,
      animationId: d.anim ? d.anim.id : null,
    });
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      dispatch('sprites.resizeFrame', { sheetId: sheet.id, frameId: d.frame.id, before: d.before, after: r });
    return;
  }
  if (d.kind === 'stripresize') {
    if (d.count === d.count0) return;
    if (d.anim) dispatch('sprites.resizeStripSegment', { sheetId: sheet.id, animationId: d.anim.id, runIndex: d.run.index, side: d.side, count: d.count });
    else dispatch('sprites.newStripFromFrame', { sheetId: sheet.id, frameId: d.frame.id, side: d.side, count: d.count });
    return;
  }
}

function updateHover(ev, view) {
  let next = null;
  const sheet = activeSheet('sprite');
  if (sheet && currentModeId() === 'sprites' && currentToolId() === 'frametool' && !drag) {
    const toScreen = projector(view);
    const sel = selectedSegment(sheet, sheetSelection(sheet).frameId ?? null);
    if (sel) {
      const g = chromeGeometry(toScreen, sheet, sel.anim, sel.run);
      if (g) next = hitChrome(g, ev.sx, ev.sy);
    } else {
      const selectedFrame = sheet.frames.find(f => f.id === sheetSelection(sheet).frameId);
      if (selectedFrame && !stripForFrame(sheet, selectedFrame.id))
        next = hitGrip(standaloneGripGeometry(toScreen, selectedFrame).grips, ev.sx, ev.sy);
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(hover)) {
    hover = next;
    view.requestRender();
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

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (currentToolId() !== 'frametool' || currentModeId() !== 'sprites') return;
    const sheet = activeSheet('sprite');
    if (!sheet) return;
    const frameId = sheetSelection(sheet).frameId ?? null;
    if (!frameId) return;
    const strip = stripForFrame(sheet, frameId);
    if (strip) dispatch('sprites.removeStripMember', { sheetId: sheet.id, animationId: strip.id, frameId });
    else dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId });
  });

  // Accepts whichever animation is currently selected in the timeline dock,
  // if it's still floating -- works for plain animations too, not just
  // strips, since it keys off the selected animation rather than the
  // selected frame (a plain animation's frames aren't reliably discoverable
  // via stripForFrame(), which requires strip: true).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (currentToolId() !== 'frametool' || currentModeId() !== 'sprites') return;
    const sheet = activeSheet('sprite');
    if (!sheet) return;
    const animationId = sheetSelection(sheet).animationId ?? null;
    if (!animationId) return;
    const anim = sheet.animations.find(a => a.id === animationId);
    if (anim && !anim.layerGroupId) dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: anim.id });
  });
}

function drawFrameToolGhost(ctx, view) {
  if (currentModeId() !== 'sprites') return;
  paintFrameToolGhost(ctx, view, activeSheet('sprite'), {
    tool: currentToolId(), drag, slicePreview: slicePreviewOptions(),
  });
}

export function drawStripChrome(ctx, view) {
  if (currentModeId() !== 'sprites') return;
  const sheet = activeSheet('sprite');
  paintStripChrome(ctx, view, sheet, {
    tool: currentToolId(), drag, hover, selectedFrameId: sheet ? (sheetSelection(sheet).frameId ?? null) : null,
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
}
