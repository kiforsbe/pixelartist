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
  cloneBitmap, drawLine, drawRect, drawEllipse, floodFill,
  copyRegion, blitRegion, fillRegion, getPixel,
} from '../core/pixels.js';
import { makePixelPatch } from '../core/commands.js';
import { nearestColor } from '../core/palettes.js';
import { flattenSheet } from '../core/model.js';

export const TOOLS = [
  { id: 'pencil', icon: '✏️', key: 'b' },
  { id: 'eraser', icon: '🧽', key: 'e' },
  { id: 'fill', icon: '🪣', key: 'g' },
  { id: 'line', icon: '📏', key: 'l' },
  { id: 'rect', icon: '▭', key: 'u' },
  { id: 'ellipse', icon: '◯', key: 'o' },
  { id: 'eyedropper', icon: '💉', key: 'i' },
  { id: 'select', icon: '⛶', key: 'm' },
];

const BRUSH_TOOLS = new Set(['pencil', 'eraser']);
const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse']);

// Shared tool options (fill contiguity, shape fill) — read by bindDrawing,
// edited by the tool-options row built in mountToolPalette.
export const toolOptions = { contiguous: true, filled: false };

// Current marquee selection, image-space {x,y,w,h} or null. Module state per
// the task brief ("select: ... store selection rect in module state").
let selection = null;

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

function activePalette() {
  const p = state.project;
  if (!p) return null;
  return p.palettes.find(pl => pl.id === p.activePaletteId) ?? null;
}

// ---------------------------------------------------------------- palette UI

export function mountToolPalette(el) {
  el.innerHTML = '';

  const btnRow = document.createElement('div');
  btnRow.className = 'tool-buttons';
  const buttons = new Map();
  for (const t of TOOLS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tool = t.id;
    btn.textContent = t.icon;
    btn.title = `${t.id} (${t.key})`;
    btn.addEventListener('click', () => selectTool(t.id));
    buttons.set(t.id, btn);
    btnRow.appendChild(btn);
  }
  el.appendChild(btnRow);

  const optionsRow = document.createElement('div');
  optionsRow.className = 'tool-options';
  el.appendChild(optionsRow);

  const brushRow = document.createElement('label');
  brushRow.className = 'tool-option-row';
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

  const contiguousRow = document.createElement('label');
  contiguousRow.className = 'tool-option-row';
  const contiguousInput = document.createElement('input');
  contiguousInput.type = 'checkbox';
  contiguousInput.checked = toolOptions.contiguous;
  contiguousInput.addEventListener('change', () => { toolOptions.contiguous = contiguousInput.checked; });
  contiguousRow.append(contiguousInput, document.createTextNode('Contiguous'));
  optionsRow.appendChild(contiguousRow);

  const filledRow = document.createElement('label');
  filledRow.className = 'tool-option-row';
  const filledInput = document.createElement('input');
  filledInput.type = 'checkbox';
  filledInput.checked = toolOptions.filled;
  filledInput.addEventListener('change', () => { toolOptions.filled = filledInput.checked; });
  filledRow.append(filledInput, document.createTextNode('Filled'));
  optionsRow.appendChild(filledRow);

  function refresh() {
    for (const [id, btn] of buttons) btn.classList.toggle('active', state.tool === id);
    contiguousRow.style.display = state.tool === 'fill' ? '' : 'none';
    filledRow.style.display = (state.tool === 'rect' || state.tool === 'ellipse') ? '' : 'none';
  }
  refresh();

  function selectTool(id) {
    state.tool = id;
    emit('tool');
    refresh();
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const t = TOOLS.find(t => t.key === e.key.toLowerCase());
    if (!t) return;
    e.preventDefault();
    selectTool(t.id);
  });
}

// -------------------------------------------------------------- stroke logic

export function bindDrawing(view, getTargetRect) {
  let stroke = null;   // pencil/eraser/line/rect/ellipse in-progress state
  let selStroke = null; // select tool in-progress state

  view.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function currentColor(ev) {
    if (state.tool === 'eraser') return [0, 0, 0, 0];
    let c = (ev.buttons & 2) ? state.secondary : state.primary;
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

  function finalize(layer, before, dirty, label) {
    if (!dirty) return;
    const target = getTargetRect();
    const x0 = Math.max(dirty.minX, target.x, 0);
    const y0 = Math.max(dirty.minY, target.y, 0);
    const x1 = Math.min(dirty.maxX, target.x + target.w - 1, layer.bitmap.width - 1);
    const y1 = Math.min(dirty.maxY, target.y + target.h - 1, layer.bitmap.height - 1);
    if (x1 < x0 || y1 < y0) return;
    const rect = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const beforeRegion = copyRegion(before, rect.x, rect.y, rect.w, rect.h);
    const afterRegion = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
    blitRegion(layer.bitmap, beforeRegion, rect.x, rect.y);
    state.commands.push(makePixelPatch(layer.bitmap, rect, beforeRegion, afterRegion, label));
    markDirty();
  }

  // ---- pencil / eraser / fill / line / rect / ellipse ----

  function handleDown(ev) {
    const layer = activeLayer();
    if (!layer) return;
    const tool = state.tool;
    const before = cloneBitmap(layer.bitmap);
    const color = currentColor(ev);

    if (tool === 'fill') {
      const r = floodFill(layer.bitmap, ev.x, ev.y, color, toolOptions.contiguous);
      const dirty = r ? extend(null, r.x, r.y, r.x + r.w - 1, r.y + r.h - 1) : null;
      finalize(layer, before, dirty, 'fill');
      stroke = null;
      emit('pixels');
      return;
    }
    if (BRUSH_TOOLS.has(tool)) {
      drawLine(layer.bitmap, ev.x, ev.y, ev.x, ev.y, color, state.brushSize);
      const dirty = extend(null, ev.x, ev.y, ev.x + state.brushSize - 1, ev.y + state.brushSize - 1);
      stroke = { tool, layer, before, color, dirty, last: { x: ev.x, y: ev.y } };
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      stroke = { tool, layer, before, color, dirty: null, anchor: { x: ev.x, y: ev.y } };
      emit('pixels');
      return;
    }
  }

  function handleMove(ev) {
    if (!stroke) return;
    const { tool, layer, before, color } = stroke;
    if (BRUSH_TOOLS.has(tool)) {
      const last = stroke.last;
      drawLine(layer.bitmap, last.x, last.y, ev.x, ev.y, color, state.brushSize);
      stroke.dirty = extend(
        stroke.dirty,
        Math.min(last.x, ev.x), Math.min(last.y, ev.y),
        Math.max(last.x, ev.x) + state.brushSize - 1, Math.max(last.y, ev.y) + state.brushSize - 1,
      );
      stroke.last = { x: ev.x, y: ev.y };
      emit('pixels');
      return;
    }
    if (SHAPE_TOOLS.has(tool)) {
      blitRegion(layer.bitmap, before, 0, 0);
      const a = stroke.anchor;
      if (tool === 'line') {
        drawLine(layer.bitmap, a.x, a.y, ev.x, ev.y, color, state.brushSize);
        stroke.dirty = extend(
          stroke.dirty,
          Math.min(a.x, ev.x), Math.min(a.y, ev.y),
          Math.max(a.x, ev.x) + state.brushSize - 1, Math.max(a.y, ev.y) + state.brushSize - 1,
        );
      } else if (tool === 'rect') {
        drawRect(layer.bitmap, a.x, a.y, ev.x, ev.y, color, toolOptions.filled);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, ev.x), Math.min(a.y, ev.y), Math.max(a.x, ev.x), Math.max(a.y, ev.y));
      } else if (tool === 'ellipse') {
        drawEllipse(layer.bitmap, a.x, a.y, ev.x, ev.y, color, toolOptions.filled);
        stroke.dirty = extend(stroke.dirty, Math.min(a.x, ev.x), Math.min(a.y, ev.y), Math.max(a.x, ev.x), Math.max(a.y, ev.y));
      }
      emit('pixels');
      return;
    }
  }

  function handleUp(ev) {
    if (!stroke) return;
    handleMove(ev); // commit final pointer position (handles click-without-move too)
    const { tool, layer, before, dirty } = stroke;
    finalize(layer, before, dirty, tool);
    stroke = null;
  }

  // ---- eyedropper ----

  function handleEyedropper(ev) {
    if (ev.type !== 'down') return;
    const sheet = activeSheet();
    if (!sheet) return;
    const flat = flattenSheet(sheet);
    const p = getPixel(flat, ev.x, ev.y);
    if (!p) return;
    if (ev.buttons & 2) state.secondary = p; else state.primary = p;
    emit('colors');
  }

  // ---- select (marquee + move) ----

  function insideRect(px, py, r) {
    return !!r && px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h;
  }

  function handleSelectDown(ev) {
    const layer = activeLayer();
    if (!layer) return;
    const target = getTargetRect();
    if (insideRect(ev.x, ev.y, selection)) {
      const before = cloneBitmap(layer.bitmap);
      const clip = copyRegion(layer.bitmap, selection.x, selection.y, selection.w, selection.h);
      fillRegion(layer.bitmap, selection.x, selection.y, selection.w, selection.h, [0, 0, 0, 0]);
      blitRegion(layer.bitmap, clip, selection.x, selection.y);
      selStroke = {
        mode: 'move', layer, before, clip, target,
        origin: { x: selection.x, y: selection.y },
        anchor: { x: ev.x, y: ev.y },
        offset: { x: 0, y: 0 },
        dirty: extend(null, selection.x, selection.y, selection.x + selection.w - 1, selection.y + selection.h - 1),
      };
    } else {
      selection = null;
      selStroke = { mode: 'new', target, anchor: { x: ev.x, y: ev.y } };
    }
    emit('pixels');
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
      emit('pixels');
      return;
    }
    // move mode
    const { layer, before, clip, anchor, origin } = selStroke;
    blitRegion(layer.bitmap, before, 0, 0);
    const offX = ev.x - anchor.x, offY = ev.y - anchor.y;
    const nx = origin.x + offX, ny = origin.y + offY;
    fillRegion(layer.bitmap, origin.x, origin.y, clip.width, clip.height, [0, 0, 0, 0]);
    blitRegion(layer.bitmap, clip, nx, ny);
    selStroke.offset = { x: offX, y: offY };
    selStroke.dirty = extend(
      selStroke.dirty,
      Math.min(origin.x, nx), Math.min(origin.y, ny),
      Math.max(origin.x + clip.width - 1, nx + clip.width - 1),
      Math.max(origin.y + clip.height - 1, ny + clip.height - 1),
    );
    emit('pixels');
  }

  function handleSelectUp(ev) {
    if (!selStroke) return;
    handleSelectMove(ev);
    if (selStroke.mode === 'new') {
      if (!selection || selection.w <= 0 || selection.h <= 0) selection = null;
      selStroke = null;
      emit('pixels');
      return;
    }
    const { layer, before, dirty, clip, origin, offset } = selStroke;
    finalize(layer, before, dirty, 'move selection');
    selection = { x: origin.x + offset.x, y: origin.y + offset.y, w: clip.width, h: clip.height };
    selStroke = null;
  }

  // ---- dispatch ----

  view.onPointer = (ev) => {
    const tool = state.tool;
    if (tool === 'select') {
      if (ev.type === 'down') handleSelectDown(ev);
      else if (ev.type === 'move') handleSelectMove(ev);
      else if (ev.type === 'up') handleSelectUp(ev);
      return;
    }
    if (tool === 'eyedropper') { handleEyedropper(ev); return; }
    if (ev.type === 'down') handleDown(ev);
    else if (ev.type === 'move') handleMove(ev);
    else if (ev.type === 'up') handleUp(ev);
  };

  view.onOverlay = (ctx) => {
    if (!selection) return;
    const p0 = view.imageToScreen(selection.x, selection.y);
    const p1 = view.imageToScreen(selection.x + selection.w, selection.y + selection.h);
    ctx.save();
    ctx.lineWidth = 1;
    const w = p1.x - p0.x, h = p1.y - p0.y;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = 0;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, w - 1, h - 1);
    ctx.strokeStyle = '#000';
    ctx.lineDashOffset = 4;
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, w - 1, h - 1);
    ctx.restore();
  };

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]')) return;
    if (selection) { selection = null; view.requestRender(); }
  });
}
