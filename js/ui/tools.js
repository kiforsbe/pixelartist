// Drawing tools: tool palette (buttons + options + keyboard shortcuts) and the
// pointer-driven stroke lifecycle bound to a CanvasView.
//
// Rendering note: pixel edits mutate layer bitmaps directly (in-place, for live
// preview) and main.js caches a flattened "scratch" composite that is normally
// only invalidated on the 'project' event. To keep the canvas visually in sync
// during an in-progress stroke (before the undo command is committed) this
// module emits a lightweight 'pixels' event on every bitmap-affecting pointer
// step; main.js listens for it and just invalidates the scratch cache + repaints
// (no full setContent/dirty-flag work). The authoritative commit still goes
// through markDirty() -> 'project' at stroke finalize, and undo/redo is covered
// by main.js listening on 'history' the same way.

import { state, on, emit, activeSheet, activeLayer, markDirty } from '../app/state.js';
import {
  cloneBitmap, drawLine, drawRect, drawEllipse, floodFill, softFloodFill,
  copyRegion, blitRegion, fillRegion, getPixel,
} from '../core/pixels.js';
import { makePixelPatch } from '../core/commands.js';
import { forwardPoint, inversePoint, floatBounds, solveScaleTransform } from '../core/floating.js';
import { nearestColor } from '../core/palettes.js';
import { flattenSheet, animationGroup, flattenLayers } from '../core/model.js';
import { segmentAt } from '../core/strips.js';
import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat } from './floatsession.js';
import { commitAcceptAnimation } from '../features/animations/commands.js';
import { stripForFrame as stripOf } from '../domain/sprites/strips.js';
import { HANDLES_ALL, handlePoint, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../core/resizeAnchor.js';
import { drawRectDims, drawAngleLabel } from './dimlabels.js';

export const TOOLS = [
  { id: 'pencil', icon: '✏️', key: 'b', isAvailable: () => state.mode !== 'maps' },
  { id: 'eraser', icon: '🧽', key: 'e', isAvailable: () => state.mode !== 'maps' },
  { id: 'fill', icon: '🪣', key: 'g', isAvailable: () => state.mode !== 'maps' },
  { id: 'softflood', label: 'Soft flood', icon: '🫗', key: 'k', isAvailable: () => state.mode !== 'maps' },
  { id: 'line', icon: '📏', key: 'l', isAvailable: () => state.mode !== 'maps' },
  { id: 'rect', icon: '▭', key: 'u', isAvailable: () => state.mode !== 'maps' },
  { id: 'ellipse', icon: '◯', key: 'o', isAvailable: () => state.mode !== 'maps' },
  { id: 'eyedropper', icon: '💉', key: 'i', isAvailable: () => state.mode !== 'maps' },
  // These are shared with Maps mode; mapmode.js intercepts their pointer events.
  { id: 'select', icon: '⛶', key: 'm' },
  { id: 'move', icon: '✋', key: 'v' },
];

const BRUSH_TOOLS = new Set(['pencil', 'eraser']);
const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse']);

// Shared tool options (fill contiguity, shape fill) — read by bindDrawing,
// edited by the tool-options row built in mountToolPalette.
export const toolOptions = {
  contiguous: true,
  filled: false,
  softFlood: { tolerance: 0, feather: 0, contiguous: true },
};

// Maps the evenly-spaced tolerance/feather slider positions onto
// exponentially-spaced RGBA distances. This gives precise control over the
// small distances commonly used for pixel art while retaining 0–255 at the end.
const SOFT_FLOOD_DISTANCE_CURVE = 5;
const SOFT_FLOOD_DISTANCE_SCALE = Math.exp(SOFT_FLOOD_DISTANCE_CURVE) - 1;
function softFloodDistanceFromSlider(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return Math.round(((Math.exp(SOFT_FLOOD_DISTANCE_CURVE * progress) - 1) / SOFT_FLOOD_DISTANCE_SCALE) * 255);
}
function softFloodDistanceToSlider(value) {
  const tolerance = Math.max(0, Math.min(255, Number(value) || 0)) / 255;
  return Math.round((Math.log(1 + tolerance * SOFT_FLOOD_DISTANCE_SCALE) / SOFT_FLOOD_DISTANCE_CURVE) * 100);
}

// ---------------------------------------------------------- external tools
//
// Small registration hook so other UI modules (frames.js's frame tool) can
// add a button + an options row to the palette WITHOUT tools.js knowing
// anything about them. `mountToolPalette(el)` is called once by main.js;
// `registerTool()` may be called any time after that (main.js calls it right
// after mountToolPalette), so it must be able to append into an
// already-rendered palette rather than requiring a remount (a remount would
// re-add the window keydown listener and duplicate hotkey handling).
//
// def: {id, icon, key, isAvailable?: () => bool} — isAvailable gates both the
// button's visibility and whether its hotkey fires (re-checked on every
// 'view' event, e.g. sprite/tile mode switches).
// buildOptionsRow?: (optionsRowEl) => rowEl — appends the tool's own option
// controls into the shared options row and returns the element(s) whose
// visibility should be toggled on/off with the built-in rows (shown only
// while that tool is active). May return an array of elements.
const extraTools = [];
let paletteApi = null; // set once mountToolPalette has run; used for late registrations

export function registerTool(def, buildOptionsRow) {
  const entry = { ...def, buildOptionsRow };
  extraTools.push(entry);
  if (paletteApi) paletteApi.addTool(entry);
}

function activePalette() {
  const p = state.project;
  if (!p) return null;
  return p.palettes.find(pl => pl.id === p.activePaletteId) ?? null;
}

// ---------------------------------------------------------------- palette UI

export function mountToolPalette(el) {
  el.innerHTML = '<h3>Tools</h3>';

  const buttonsHost = el;
  const btnRow = document.createElement('div');
  btnRow.className = 'tool-buttons';
  const buttons = new Map();
  const extraRows = []; // [{id, els: [el,...]}] for tools registered via registerTool()

  function makeButton(t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon-lg';
    btn.dataset.tool = t.id;
    btn.textContent = t.icon;
    btn.title = `${t.label ?? t.id} (${t.key})`;
    btn.addEventListener('click', () => selectTool(t.id));
    buttons.set(t.id, btn);
    btnRow.appendChild(btn);
    return btn;
  }
  for (const t of TOOLS) makeButton(t);
  buttonsHost.appendChild(btnRow);

  // ---- separate tool options panel ----
  const optionsPanel = document.createElement('div');
  optionsPanel.className = 'tool-options-panel';
  buttonsHost.appendChild(optionsPanel);

  const toolNameEl = document.createElement('h3');
  toolNameEl.className = 'tool-options-title';
  optionsPanel.appendChild(toolNameEl);

  const optionsRow = document.createElement('div');
  optionsRow.className = 'tool-options';
  optionsPanel.appendChild(optionsRow);

  // Common options are always rendered in the same layout so their position
  // does not jump when switching between tools that share them.
  const brushRow = document.createElement('label');
  brushRow.className = 'tool-option-row';
  brushRow.dataset.commonOption = 'size';
  brushRow.appendChild(document.createTextNode('Size'));
  const brushInput = document.createElement('input');
  brushInput.type = 'number'; brushInput.min = '1'; brushInput.max = '8';
  brushInput.value = String(state.brushSize);
  brushInput.addEventListener('change', () => {
    let v = parseInt(brushInput.value, 10);
    if (!Number.isFinite(v)) v = 1;
    v = Math.max(1, Math.min(8, v));
    brushInput.value = String(v);
    state.brushSize = v;
  });
  brushRow.appendChild(brushInput);
  optionsRow.appendChild(brushRow);
  // main.js's `[`/`]` brush-size shortcut mutates state.brushSize directly and
  // emits 'brushSize' so this input (the only other writer of that value)
  // stays in sync without main.js needing a reference to it.
  on('brushSize', () => { brushInput.value = String(state.brushSize); });

  const optionChecks = document.createElement('div');
  optionChecks.className = 'tool-option-checks';
  optionChecks.dataset.commonOption = 'checks';

  const contiguousRow = document.createElement('label');
  contiguousRow.className = 'tool-option-row';
  const contiguousInput = document.createElement('input');
  contiguousInput.type = 'checkbox';
  contiguousInput.checked = toolOptions.contiguous;
  contiguousInput.addEventListener('change', () => { toolOptions.contiguous = contiguousInput.checked; });
  contiguousRow.append(document.createTextNode('Contiguous'), contiguousInput);
  optionChecks.appendChild(contiguousRow);

  const filledRow = document.createElement('label');
  filledRow.className = 'tool-option-row';
  const filledInput = document.createElement('input');
  filledInput.type = 'checkbox';
  filledInput.checked = toolOptions.filled;
  filledInput.addEventListener('change', () => { toolOptions.filled = filledInput.checked; });
  filledRow.append(document.createTextNode('Filled'), filledInput);
  optionChecks.appendChild(filledRow);

  optionsRow.appendChild(optionChecks);

  const softFloodRow = document.createElement('div');
  softFloodRow.className = 'tool-options';
  for (const [label, key] of [['Tolerance', 'tolerance'], ['Feather', 'feather']]) {
    const row = document.createElement('label');
    row.className = 'tool-option-row soft-flood-control';
    const labelEl = document.createElement('span'); labelEl.textContent = label;
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '100';
    input.value = String(softFloodDistanceToSlider(toolOptions.softFlood[key]));
    const value = document.createElement('span'); value.textContent = input.value;
    input.addEventListener('input', () => {
      const actual = softFloodDistanceFromSlider(input.value);
      toolOptions.softFlood[key] = actual;
      value.textContent = String(actual);
    });
    value.textContent = String(toolOptions.softFlood[key]);
    row.append(labelEl, value, input);
    softFloodRow.appendChild(row);
  }
  const softContiguous = document.createElement('label');
  softContiguous.className = 'tool-option-row';
  const softContiguousInput = document.createElement('input');
  softContiguousInput.type = 'checkbox'; softContiguousInput.checked = toolOptions.softFlood.contiguous;
  softContiguousInput.addEventListener('change', () => { toolOptions.softFlood.contiguous = softContiguousInput.checked; });
  softContiguous.append(document.createTextNode('Contiguous'), softContiguousInput);
  softFloodRow.appendChild(softContiguous);
  optionsRow.appendChild(softFloodRow);

  function toolLabel(id) {
    const t = TOOLS.find(x => x.id === id) ?? extraTools.find(x => x.id === id);
    return t ? `${t.icon} ${t.label ?? t.id}` : id;
  }

  function toolTitle(id) {
    const t = TOOLS.find(x => x.id === id) ?? extraTools.find(x => x.id === id);
    if (!t) return id;
    return t.label ?? (t.id.charAt(0).toUpperCase() + t.id.slice(1));
  }

  function optionVisibleFor(id) {
    return {
      size: BRUSH_TOOLS.has(id),
      contiguous: id === 'fill',
      filled: id === 'rect' || id === 'ellipse',
      softFlood: id === 'softflood',
    };
  }

  function refresh() {
    for (const [id, btn] of buttons) {
      const entry = TOOLS.find(t => t.id === id) ?? extraTools.find(t => t.id === id);
      btn.classList.toggle('active', state.tool === id);
      btn.hidden = !!entry?.isAvailable && !entry.isAvailable();
    }
    for (const extra of extraTools) {
      const btn = buttons.get(extra.id);
      if (btn && extra.isAvailable) btn.hidden = !extra.isAvailable();
    }
    toolNameEl.textContent = toolTitle(state.tool);
    const vis = optionVisibleFor(state.tool);
    brushRow.style.display = vis.size ? '' : 'none';
    contiguousRow.style.display = vis.contiguous ? '' : 'none';
    filledRow.style.display = vis.filled ? '' : 'none';
    optionChecks.style.display = (vis.contiguous || vis.filled) ? '' : 'none';
    softFloodRow.style.display = vis.softFlood ? '' : 'none';
    for (const { id, els } of extraRows)
      for (const rEl of els) rEl.style.display = state.tool === id ? '' : 'none';
  }

  function selectTool(id) {
    state.tool = id;
    emit('tool');
    refresh();
  }

  function addTool(entry) {
    makeButton(entry);
    if (entry.buildOptionsRow) {
      const built = entry.buildOptionsRow(optionsRow);
      const els = Array.isArray(built) ? built : (built ? [built] : []);
      extraRows.push({ id: entry.id, els });
    }
    refresh();
  }

  // pick up any tools registered before this (re)mount
  for (const entry of extraTools) addTool(entry);
  paletteApi = { addTool, refresh };

  refresh();
  on('view', refresh); // re-check isAvailable() (e.g. sprite/tile mode switch)
  on('tool', refresh);

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const t = [...TOOLS, ...extraTools].find(t => t.key === e.key.toLowerCase() && (!t.isAvailable || t.isAvailable()));
    if (!t) return;
    e.preventDefault();
    selectTool(t.id);
  });
}

// -------------------------------------------------------------- stroke logic

// `mapPoint` is an optional (x, y) -> {x, y} hook applied to every pointer
// event BEFORE any tool logic runs. The sheet view passes nothing (its
// CanvasView's content space already IS sheet-global pixel space, so no
// translation is needed). The frame editor (Task 16) passes a hook that
// shifts its CanvasView's frame-local content coordinates (0..f.w, 0..f.h)
// into sheet-global bitmap coordinates (f.x..f.x+f.w, f.y..f.y+f.h) — the
// SAME layer bitmaps are edited either way, so everything downstream
// (clampPoint, maskOutsideTarget, finalize, flood fill, selection storage)
// stays sheet-global and unaware of which view produced the event.
export function bindDrawing(view, getTargetRect, mapPoint, viewKind = 'sheet') {
  let stroke = null;   // pencil/eraser/line/rect/ellipse in-progress state
  let selStroke = null; // select tool in-progress state
  let moveStroke = null; // move tool in-progress state
  // Current marquee selection, image-space {x,y,w,h} or null. Instance state
  // (per bindDrawing() call) — bindDrawing() is invoked once per CanvasView
  // (sheet view in main.js, frame editor in frameeditor.js), and each view
  // must own its own selection: a marquee made on the sheet must not leak
  // into the frame editor (or vice versa) since both operate on the same
  // underlying layer bitmaps but represent different visible regions.
  let selection = null;

  registerFloatView(viewKind, {
    getSelection: () => (selection ? { ...selection } : null),
    setSelection: (r) => { selection = r ? { ...r } : null; view.requestRender(); },
    getTargetRect,
  });

  view.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // A project switch (New/Open) invalidates any selection or in-progress
  // stroke — bitmaps and layer ids from the old project are gone. Guard on
  // project IDENTITY: markDirty() also emits 'project' after every committed
  // command, and that must NOT wipe a live selection or pending float.
  let lastProject = state.project;
  on('project', () => {
    if (state.project === lastProject) return;
    lastProject = state.project;
    selection = null;
    stroke = null;
    selStroke = null;
    moveStroke = null;
    view.requestRender();
  });

  // Clamp an image-space point into `target`; null when the target is empty
  // (no sheet, or outside any paintable segment). Live drawing pre-masks
  // coordinates with this so strokes cannot start or extend outside the
  // editable rect. `target` is resolved ONCE per stroke at handleDown and
  // threaded through explicitly (not re-queried via getTargetRect() on every
  // event) so a strip with multiple segments can't "flicker" mid-drag if the
  // pointer strays near another segment -- mirrors how the select tool
  // already freezes `selStroke.target` once at handleSelectDown.
  function clampPoint(x, y, target) {
    if (target.w <= 0 || target.h <= 0) return null;
    return {
      x: Math.max(target.x, Math.min(target.x + target.w - 1, x)),
      y: Math.max(target.y, Math.min(target.y + target.h - 1, y)),
    };
  }

  // Restore `before` pixels outside `target` within the given step bounds.
  // Catches writes that coordinate clamping alone cannot prevent (brush
  // stamps overflow up to brushSize-1 px past a clamped coordinate;
  // select-move can drag content past the target edge).
  function maskOutsideTarget(bitmap, before, x0, y0, x1, y1, target) {
    const t = target;
    const bx0 = Math.max(0, x0), by0 = Math.max(0, y0);
    const bx1 = Math.min(bitmap.width - 1, x1), by1 = Math.min(bitmap.height - 1, y1);
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) continue;
        const i = (y * bitmap.width + x) * 4;
        bitmap.data[i] = before.data[i];
        bitmap.data[i + 1] = before.data[i + 1];
        bitmap.data[i + 2] = before.data[i + 2];
        bitmap.data[i + 3] = before.data[i + 3];
      }
  }

  // swap=true returns the OTHER swatch for the pressed button (used as the
  // interior color of filled rect/ellipse shapes)
  function currentColor(ev, swap = false, forcePrimary = false) {
    if (state.tool === 'eraser') return [0, 0, 0, 0];
    const useSecondary = !forcePrimary && (!!(ev.buttons & 2) !== swap);
    let c = useSecondary ? state.secondary : state.primary;
    const pal = activePalette();
    if (pal && pal.indexed && pal.colors.length) c = nearestColor(pal, c);
    return c;
  }

  function extend(dirty, x0, y0, x1, y1) {
    if (!dirty) return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
    return {
      minX: Math.min(dirty.minX, x0), minY: Math.min(dirty.minY, y0),
      maxX: Math.max(dirty.maxX, x1), maxY: Math.max(dirty.maxY, y1),
    };
  }

  function finalize(layer, before, dirty, label, target) {
    if (!dirty) return;
    const bmp = layer.bitmap;
    // full extent the stroke may have touched, clamped to bitmap bounds only
    const fx0 = Math.max(dirty.minX, 0), fy0 = Math.max(dirty.minY, 0);
    const fx1 = Math.min(dirty.maxX, bmp.width - 1), fy1 = Math.min(dirty.maxY, bmp.height - 1);
    if (fx1 < fx0 || fy1 < fy0) return;
    const x0 = Math.max(fx0, target.x);
    const y0 = Math.max(fy0, target.y);
    const x1 = Math.min(fx1, target.x + target.w - 1);
    const y1 = Math.min(fy1, target.y + target.h - 1);
    if (x1 < x0 || y1 < y0) {
      // nothing inside the target: discard any stray live edits, no command
      blitRegion(bmp, copyRegion(before, fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1), fx0, fy0);
      emit('pixels');
      return;
    }
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const beforeRegion = copyRegion(before, rect.x, rect.y, rect.w, rect.h);
    const afterRegion = copyRegion(bmp, rect.x, rect.y, rect.w, rect.h);
    // restore EVERYTHING the stroke touched (including any out-of-target
    // bleed), then let the command re-apply the target-clamped patch — undo
    // is exact and nothing outside the target can persist.
    blitRegion(bmp, copyRegion(before, fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1), fx0, fy0);
    state.commands.push(makePixelPatch(bmp, rect, beforeRegion, afterRegion, label));
    markDirty();
  }

  // If the currently selected animation is floating (no layer yet -- see
  // acceptAnimation in core/model.js), accept it before resolving the
  // active layer to write into, so drawing "just works" without the user
  // needing to explicitly accept first (Enter key, frames.js's
  // registerFrameTool). No-ops for read-only tools (eyedropper doesn't call
  // this), tile mode (state.selectedAnimationId isn't used there), or
  // when nothing is selected/already accepted.
  function acceptFloatingContextIfAny() {
    const sheet = activeSheet();
    if (!sheet || !state.selectedAnimationId) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim && !anim.layerGroupId) commitAcceptAnimation(sheet, anim);
  }

  // ---- pencil / eraser / fill / soft flood / line / rect / ellipse ----

  function handleDown(ev) {
    acceptFloatingContextIfAny();
    const layer = activeLayer();
    if (!layer) return;
    const tool = state.tool;
    const before = cloneBitmap(layer.bitmap);
    const color = currentColor(ev);

    if (tool === 'fill') {
      // only act when the seed is inside the target; flood a copy of the
      // target region so the fill cannot leak outside it
      const t = getTargetRect(ev.x, ev.y);
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const r = floodFill(sub, ev.x - t.x, ev.y - t.y, color, toolOptions.contiguous);
      let dirty = null;
      if (r) {
        blitRegion(layer.bitmap, sub, t.x, t.y);
        dirty = extend(null, t.x + r.x, t.y + r.y, t.x + r.x + r.w - 1, t.y + r.y + r.h - 1);
      }
      finalize(layer, before, dirty, 'fill', t);
      stroke = null;
      emit('pixels');
      return;
    }
    if (tool === 'softflood') {
      // Work on a target-sized copy, preserving the same strip/tile boundary
      // guarantees as hard fill while the core algorithm computes its region.
      const t = getTargetRect(ev.x, ev.y);
      if (ev.x < t.x || ev.y < t.y || ev.x >= t.x + t.w || ev.y >= t.y + t.h) return;
      const sub = copyRegion(layer.bitmap, t.x, t.y, t.w, t.h);
      const r = softFloodFill(sub, ev.x - t.x, ev.y - t.y, currentColor(ev, false, true), {
        ...toolOptions.softFlood,
        mode: ev.buttons & 2 ? 'erase' : 'fill',
      });
      let dirty = null;
      if (r) {
        blitRegion(layer.bitmap, sub, t.x, t.y);
        dirty = extend(null, t.x + r.x, t.y + r.y, t.x + r.x + r.w - 1, t.y + r.y + r.h - 1);
      }
      finalize(layer, before, dirty, 'soft flood', t);
      stroke = null;
      emit('pixels');
      return;
    }
    if (BRUSH_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      drawLine(layer.bitmap, p.x, p.y, p.x, p.y, color, state.brushSize);
      maskOutsideTarget(layer.bitmap, before, p.x, p.y, p.x + state.brushSize - 1, p.y + state.brushSize - 1, target);
      const dirty = extend(null, p.x, p.y, p.x + state.brushSize - 1, p.y + state.brushSize - 1);
      stroke = { tool, layer, before, color, dirty, last: p, target };
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const target = getTargetRect(ev.x, ev.y);
      const p = clampPoint(ev.x, ev.y, target);
      if (!p) return;
      // filled shapes: outline in the pressed button's color, interior in the
      // opposite swatch (left = primary outline / secondary fill, right = swapped)
      const fill = (tool !== 'line' && toolOptions.filled) ? currentColor(ev, true) : null;
      stroke = { tool, layer, before, color, fill, dirty: null, anchor: p, target };
      emit('pixels');
      return;
    }
  }

  function handleMove(ev) {
    if (!stroke) return;
    const { tool, layer, before, color } = stroke;
    if (BRUSH_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      const last = stroke.last;
      drawLine(layer.bitmap, last.x, last.y, p.x, p.y, color, state.brushSize);
      const sx0 = Math.min(last.x, p.x), sy0 = Math.min(last.y, p.y);
      const sx1 = Math.max(last.x, p.x) + state.brushSize - 1;
      const sy1 = Math.max(last.y, p.y) + state.brushSize - 1;
      maskOutsideTarget(layer.bitmap, before, sx0, sy0, sx1, sy1, stroke.target);
      stroke.dirty = extend(stroke.dirty, sx0, sy0, sx1, sy1);
      stroke.last = p;
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      const p = clampPoint(ev.x, ev.y, stroke.target);
      if (!p) return;
      blitRegion(layer.bitmap, before, 0, 0);
      const a = stroke.anchor;
      if (tool === 'line') {
        drawLine(layer.bitmap, a.x, a.y, p.x, p.y, color, state.brushSize);
        const sx1 = Math.max(a.x, p.x) + state.brushSize - 1;
        const sy1 = Math.max(a.y, p.y) + state.brushSize - 1;
        maskOutsideTarget(layer.bitmap, before, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1, stroke.target);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), sx1, sy1);
      } else if (tool === 'rect') {
        drawRect(layer.bitmap, a.x, a.y, p.x, p.y, color, stroke.fill);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y));
      } else if (tool === 'ellipse') {
        drawEllipse(layer.bitmap, a.x, a.y, p.x, p.y, color, stroke.fill);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, p.x), Math.min(a.y, p.y), Math.max(a.x, p.x), Math.max(a.y, p.y));
      }
      emit('pixels');
      return;
    }
  }

  function handleUp(ev) {
    if (!stroke) return;
    handleMove(ev); // commit final pointer position (handles click-without-move too)
    const { tool, layer, before, dirty, target } = stroke;
    finalize(layer, before, dirty, tool, target);
    stroke = null;
  }

  // ---- eyedropper ----

  function handleEyedropper(ev) {
    if (ev.type !== 'down') return;
    const sheet = activeSheet();
    if (!sheet) return;
    const flat = flattenSheet(sheet, state.floating);
    const p = getPixel(flat, ev.x, ev.y);
    if (!p) return;
    if (ev.buttons & 2) state.secondary = p; else state.primary = p;
    emit('colors');
  }

  // ---- select (marquee only — the move tool is the only content mover) ----

  function insideRect(px, py, r) {
    return !!r && px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h;
  }

  // Keeps a moved selection rect fully inside the target rect.
  function clampRectToTarget(r, t) {
    const maxX = Math.max(t.x, t.x + t.w - r.w);
    const maxY = Math.max(t.y, t.y + t.h - r.h);
    return { x: Math.max(t.x, Math.min(maxX, r.x)), y: Math.max(t.y, Math.min(maxY, r.y)), w: r.w, h: r.h };
  }

  // 8 handle anchor points on the marquee, image-space EDGE coords
  const SEL_HANDLES = HANDLES_ALL;
  function hitSelHandle(ev) {
    if (!selection) return null;
    for (const h of SEL_HANDLES) {
      const p = toScreen(handlePoint(selection, h));
      if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) return h;
    }
    return null;
  }

  function handleSelectDown(ev) {
    acceptFloatingContextIfAny();
    if (!activeLayer()) return;
    const target = getTargetRect(ev.x, ev.y);
    const handle = hitSelHandle(ev);
    if (handle) {
      selStroke = { mode: 'resize', target, handle, orig: { ...selection }, anchor: { x: ev.x, y: ev.y }, moved: false };
      view.requestRender();
      return;
    }
    if (insideRect(ev.x, ev.y, selection)) {
      // drag the marquee rect itself — shape preserved, contents untouched
      selStroke = { mode: 'moverect', target, anchor: { x: ev.x, y: ev.y }, orig: { x: selection.x, y: selection.y, w: selection.w, h: selection.h } };
    } else {
      selection = null;
      selStroke = { mode: 'new', target, anchor: { x: ev.x, y: ev.y } };
    }
    view.requestRender();
  }

  function handleSelectMove(ev) {
    if (!selStroke) return;
    const target = selStroke.target;
    if (selStroke.mode === 'new') {
      const a = selStroke.anchor;
      const cx = Math.max(target.x, Math.min(target.x + target.w - 1, ev.x));
      const cy = Math.max(target.y, Math.min(target.y + target.h - 1, ev.y));
      const ax = Math.max(target.x, Math.min(target.x + target.w - 1, a.x));
      const ay = Math.max(target.y, Math.min(target.y + target.h - 1, a.y));
      const x0 = Math.min(ax, cx), x1 = Math.max(ax, cx);
      const y0 = Math.min(ay, cy), y1 = Math.max(ay, cy);
      selection = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    } else if (selStroke.mode === 'resize') {
      // A plain click on a handle must not nudge the rect: the e/s handle
      // centers sit ON the edge coordinate, which resizeRectFromHandle's
      // `inclusive: true` reads as an inclusive pixel (a no-move click
      // would grow the rect by 1) — only recompute once the pointer has
      // left the pointer-down pixel.
      if (ev.x !== selStroke.anchor.x || ev.y !== selStroke.anchor.y) selStroke.moved = true;
      if (selStroke.moved) selection = resizeRectFromHandle(selStroke.orig, selStroke.handle, ev.x, ev.y, {
        useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev), target, inclusive: true,
      });
    } else if (selStroke.mode === 'moverect') {
      const dx = ev.x - selStroke.anchor.x, dy = ev.y - selStroke.anchor.y;
      selection = clampRectToTarget(
        { x: selStroke.orig.x + dx, y: selStroke.orig.y + dy, w: selStroke.orig.w, h: selStroke.orig.h },
        target,
      );
    }
    view.requestRender();
  }

  function handleSelectUp(ev) {
    if (!selStroke) return;
    handleSelectMove(ev);
    if (selStroke.mode === 'new' && (!selection || selection.w <= 0 || selection.h <= 0)) selection = null;
    selStroke = null;
    view.requestRender();
  }

  // ---- move (floating selection) ----
  //
  // The move tool never edits bitmaps directly: pointer-down cuts the region
  // into state.floating (floatsession command), and every gesture only
  // mutates float.transform live, pushing one transform command per completed
  // drag. Enter/Escape/tool-switch commit or cancel via floatsession.

  const HANDLE_PX = 5;    // half-size of a scale handle hit box, screen px
  const KNOB_OFFSET = 20; // rotation knob distance beyond top-center, screen px
  const KNOB_R = 7;

  // sheet-global point -> screen px. Every view's imageToScreen accepts
  // sheet-global coords directly: the sheet view's content space already IS
  // sheet-global, and the frame/tile editors OVERRIDE imageToScreen to accept
  // sheet-global input and subtract their own offset internally (see their
  // module comments) — so no un-mapping is needed here.
  function toScreen(p) {
    return view.imageToScreen(p.x, p.y);
  }

  // 4 corners + 4 edge midpoints in buffer space, named so handleMoveDown
  // can identify which one was grabbed (needed by solveScaleTransform).
  function handleAnchors(float) {
    const { w, h } = float.srcRect;
    return [
      { handle: 'nw', u: 0, v: 0 }, { handle: 'ne', u: w, v: 0 },
      { handle: 'se', u: w, v: h }, { handle: 'sw', u: 0, v: h },
      { handle: 'n', u: w / 2, v: 0 }, { handle: 'e', u: w, v: h / 2 },
      { handle: 's', u: w / 2, v: h }, { handle: 'w', u: 0, v: h / 2 },
    ];
  }

  function floatCenter(float) {
    return forwardPoint(float, float.srcRect.w / 2, float.srcRect.h / 2);
  }

  function knobScreenPos(float) {
    const pTop = toScreen(forwardPoint(float, float.srcRect.w / 2, 0));
    const pC = toScreen(floatCenter(float));
    const dx = pTop.x - pC.x, dy = pTop.y - pC.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: pTop.x + (dx / len) * KNOB_OFFSET, y: pTop.y + (dy / len) * KNOB_OFFSET };
  }

  function handleMoveDown(ev) {
    const sheet = activeSheet();
    if (!sheet) return;
    const float = state.floating;
    if (float && float.sheetId === sheet.id) {
      // Frame-floats are translate-only: no rotation knob, no scale handles.
      const knob = !float.frameIds && knobScreenPos(float);
      if (knob && Math.hypot(ev.sx - knob.x, ev.sy - knob.y) <= KNOB_R + 2) {
        const c = floatCenter(float);
        moveStroke = {
          kind: 'rotate', t0: { ...float.transform },
          center: c, angle0: Math.atan2(ev.y + 0.5 - c.y, ev.x + 0.5 - c.x),
        };
        return;
      }
      if (!float.frameIds) for (const a of handleAnchors(float)) {
        const p = toScreen(forwardPoint(float, a.u, a.v));
        if (Math.abs(ev.sx - p.x) <= HANDLE_PX + 2 && Math.abs(ev.sy - p.y) <= HANDLE_PX + 2) {
          moveStroke = { kind: 'scale', t0: { ...float.transform }, handle: a.handle };
          return;
        }
      }
      const { u, v } = inversePoint(float, ev.x + 0.5, ev.y + 0.5);
      if (u >= 0 && v >= 0 && u < float.srcRect.w && v < float.srcRect.h) {
        moveStroke = { kind: 'translate', t0: { ...float.transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
      commitFloatIfAny(); // pressed outside: commit; next press starts fresh
      return;
    }
    // No float yet. On the sheet view with no marquee, a down on a frame or
    // strip segment starts a FRAME-FLOAT: the region's pixels float exactly
    // like a selection — live preview, commit on Enter/outside click — but
    // translate-only, and on commit the frame rects move with the pixels.
    // Everything else keeps the classic behavior: cut the selection (or
    // whole target) and drag it.
    if (state.view === 'sheet' && !selection) {
      const seg = segmentAt(sheet, ev.x, ev.y);
      if (seg) {
        // An accepted strip's own segment carries only ITS OWN layer(s) --
        // resolved from the segment's owning strip, never from whatever's
        // ambiently selected in the timeline (see docs/superpowers/specs/
        // 2026-07-18-strip-area-constraint-design.md). A floating strip or a
        // plain frame has no strip-owned layer to resolve, so falls back to
        // today's ambient allLayers:true capture.
        const owner = stripOf(sheet, seg.frameIds[0]);
        const ownGroup = owner?.layerGroupId ? animationGroup(sheet, owner.id) : null;
        const layers = ownGroup ? flattenLayers(ownGroup) : null;
        if (!createFloat({ allLayers: true, region: seg.rect, frameIds: seg.frameIds, layers, x: ev.x, y: ev.y })) return;
        moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
        return;
      }
    }
    if (!createFloat({ allLayers: !!ev.altKey, x: ev.x, y: ev.y })) return;
    moveStroke = { kind: 'translate', t0: { ...state.floating.transform }, anchor: { x: ev.x, y: ev.y } };
  }

  function handleMoveMove(ev) {
    if (!moveStroke || !state.floating) return;
    const float = state.floating;
    const t0 = moveStroke.t0;
    if (moveStroke.kind === 'translate') {
      float.transform.tx = t0.tx + Math.round(ev.x - moveStroke.anchor.x);
      float.transform.ty = t0.ty + Math.round(ev.y - moveStroke.anchor.y);
      if (float.frameIds) {
        // Frame rects must stay on-sheet, so the frame-float clamps where a
        // plain float may overhang (commit crops overhang pixels anyway).
        const sheet = activeSheet();
        if (sheet) {
          float.transform.tx = Math.max(-float.srcRect.x,
            Math.min(sheet.width - float.srcRect.x - float.srcRect.w, float.transform.tx));
          float.transform.ty = Math.max(-float.srcRect.y,
            Math.min(sheet.height - float.srcRect.y - float.srcRect.h, float.transform.ty));
        }
        syncFrameFloat(); // rects follow live — the frame itself is moving
      }
    } else if (moveStroke.kind === 'rotate') {
      const c = moveStroke.center;
      float.transform.rot = t0.rot + (Math.atan2(ev.y + 0.5 - c.y, ev.x + 0.5 - c.x) - moveStroke.angle0);
    } else { // scale
      float.transform = solveScaleTransform({
        srcRect: float.srcRect, t0, handle: moveStroke.handle,
        useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
        mx: ev.x + 0.5, my: ev.y + 0.5,
      });
    }
    emit('pixels');
  }

  function handleMoveUp(ev) {
    if (!moveStroke) return;
    handleMoveMove(ev);
    const t0 = moveStroke.t0;
    moveStroke = null;
    if (state.floating) pushTransformCommand(t0, { ...state.floating.transform });
  }

  // ---- dispatch ----

  view.onPointer = (ev) => {
    if (mapPoint) {
      const p = mapPoint(ev.x, ev.y);
      ev = { ...ev, x: p.x, y: p.y };
    }
    const tool = state.tool;
    // The frame tool (registered by frames.js via registerTool()) and the tile
    // tool (registered by tilemode.js) own pointer routing on the sheet view
    // when active — each wraps view.onPointer around this function and
    // delegates back for every other tool, so this dispatcher must ignore
    // their events rather than fight over them.
    if (tool === 'frametool' || tool === 'tiletool') return;
    if (tool === 'select') {
      if (ev.type === 'down') handleSelectDown(ev);
      else if (ev.type === 'move') handleSelectMove(ev);
      else if (ev.type === 'up') handleSelectUp(ev);
      return;
    }
    if (tool === 'move') {
      if (ev.type === 'down') handleMoveDown(ev);
      else if (ev.type === 'move') handleMoveMove(ev);
      else if (ev.type === 'up') handleMoveUp(ev);
      return;
    }
    if (tool === 'eyedropper') { handleEyedropper(ev); return; }
    if (ev.type === 'down') handleDown(ev);
    else if (ev.type === 'move') handleMove(ev);
    else if (ev.type === 'up') handleUp(ev);
  };

  function drawHandleSquare(ctx, p) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.fillRect(p.x - HANDLE_PX, p.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
    ctx.strokeRect(p.x - HANDLE_PX + 0.5, p.y - HANDLE_PX + 0.5, HANDLE_PX * 2 - 1, HANDLE_PX * 2 - 1);
  }

  view.onOverlay = (ctx) => {
    const float = state.floating;
    const sheet = activeSheet();
    if (float && sheet && float.sheetId === sheet.id && state.tool === 'move') {
      const { w, h } = float.srcRect;
      const corners = [[0, 0], [w, 0], [w, h], [0, h]]
        .map(([u, v]) => toScreen(forwardPoint(float, u, v)));
      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      // Frame-floats use the frame tool's ghost style (plain white dashes),
      // not the selection's white/black marching ants.
      const dashes = float.frameIds ? [['#fff', 0]] : [['#fff', 0], ['#000', 4]];
      for (const [color, off] of dashes) {
        ctx.strokeStyle = color;
        ctx.lineDashOffset = off;
        ctx.beginPath();
        corners.forEach((p, i) => (i ? ctx.lineTo(p.x + 0.5, p.y + 0.5) : ctx.moveTo(p.x + 0.5, p.y + 0.5)));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Frame-floats read as a moving frame, not a transformable selection:
      // outline + dimension chrome only — no scale handles, no rotation knob.
      let knob = null;
      if (!float.frameIds) {
        for (const a of handleAnchors(float)) {
          drawHandleSquare(ctx, toScreen(forwardPoint(float, a.u, a.v)));
        }
        knob = knobScreenPos(float);
        const top = toScreen(forwardPoint(float, w / 2, 0));
        ctx.strokeStyle = '#fff';
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(knob.x, knob.y); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
        ctx.beginPath(); ctx.arc(knob.x, knob.y, KNOB_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      const t = float.transform;
      const bounds = floatBounds(float);
      const scaledW = Math.round(float.srcRect.w * Math.abs(t.sx));
      const scaledH = Math.round(float.srcRect.h * Math.abs(t.sy));
      const opts = { wOverride: scaledW, hOverride: scaledH };
      if (moveStroke?.kind === 'translate') {
        opts.dx = t.tx - moveStroke.t0.tx;
        opts.dy = t.ty - moveStroke.t0.ty;
      } else if (moveStroke?.kind === 'scale') {
        opts.dw = scaledW - Math.round(float.srcRect.w * Math.abs(moveStroke.t0.sx));
        opts.dh = scaledH - Math.round(float.srcRect.h * Math.abs(moveStroke.t0.sy));
      } else if (!moveStroke) {
        opts.quiet = true;
      }
      drawRectDims(ctx, view, bounds, opts);
      if (knob && (moveStroke?.kind === 'rotate' || (!moveStroke && t.rot !== 0))) {
        drawAngleLabel(ctx, knob.x + KNOB_R + 4, knob.y, t.rot);
      }
      return;
    }
    if (!selection) return;
    const p0 = toScreen({ x: selection.x, y: selection.y });
    const p1 = toScreen({ x: selection.x + selection.w, y: selection.y + selection.h });
    ctx.save();
    ctx.lineWidth = 1;
    const rw = p1.x - p0.x, rh = p1.y - p0.y;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 0;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, rw - 1, rh - 1);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = 4;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, rw - 1, rh - 1);
    ctx.restore();
    if (state.tool === 'select') {
      for (const h of SEL_HANDLES) drawHandleSquare(ctx, toScreen(handlePoint(selection, h)));
      if (selStroke?.mode === 'resize') {
        drawRectDims(ctx, view, selection, {
          dw: selection.w - selStroke.orig.w, dh: selection.h - selStroke.orig.h,
        });
      } else if (selStroke?.mode === 'moverect') {
        drawRectDims(ctx, view, selection, {
          dx: selection.x - selStroke.orig.x, dy: selection.y - selStroke.orig.y,
        });
      } else if (selStroke?.mode === 'new') {
        drawRectDims(ctx, view, selection);
      } else {
        drawRectDims(ctx, view, selection, { quiet: true });
      }
    }
  };

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey
      && state.tool === 'select' && state.view === viewKind && selection && !state.floating) {
      const layer = activeLayer();
      if (!layer) return;
      const before = copyRegion(layer.bitmap, selection.x, selection.y, selection.w, selection.h);
      const after = cloneBitmap(before);
      fillRegion(after, 0, 0, after.width, after.height, [0, 0, 0, 0]);
      // Avoid adding a no-op history entry for an already-empty selection.
      if (before.data.every((value, index) => value === after.data[index])) return;
      state.commands.push(makePixelPatch(layer.bitmap, selection, before, after, 'delete selection'));
      markDirty();
      emit('pixels');
      view.requestRender();
      e.preventDefault();
      return;
    }
    if (e.key !== 'Escape') return;
    if (state.floating) return; // floatsession's capture handler owns Escape while floating
    if (selection) { selection = null; view.requestRender(); }
  });
}
