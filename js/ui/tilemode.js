// Tile mode: tile tool (select/swap/move on the atlas), and the tile
// context panel (tile size, tile count, selected-tile name + "Edit tile").
//
// Mirrors frames.js's split: registerTileTool() adds the palette button
// (isAvailable gates it to tile mode, like frametool gates to sprite mode),
// bindTileTool(view) wraps a CanvasView's onPointer/onOverlay the same way
// bindFrameTool does, and mountTilePanel(el) targets the SAME #panel-context
// element frames.js's mountFramesPanel does — see mountFramesPanel's wrap-div
// comment for how the two coexist without clobbering each other.

import { state, on, emit, activeSheet, markDirty } from '../app/state.js';
import { tileCount, tileRect } from '../core/model.js';
import { copyRegion, blitRegion, fillRegion } from '../core/pixels.js';
import { registerTool } from './tools.js';

const DBLCLICK_MS = 400;
const TILE_GHOST = '#fff';
const TILE_GHOST_MOVE = '#ffb020';

// In-progress drag state — one tile-tool drag at a time (module-scoped, like
// frames.js's `drag`). {from, to, shift}: `to` tracks the tile under the
// pointer (null once it leaves the grid), `shift` tracks swap vs move.
let drag = null;
// {index, time} of the last completed down, for double-click detection —
// CanvasView only forwards down/move/up, not a native dblclick.
let lastClick = null;

// ------------------------------------------------------------- geometry

function tileIndexAt(sheet, x, y) {
  if (!sheet.tile) return null;
  const tw = sheet.tile.tileWidth, th = sheet.tile.tileHeight;
  if (!(tw > 0) || !(th > 0)) return null;
  if (x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return null;
  const cols = Math.floor(sheet.width / tw);
  const rows = Math.floor(sheet.height / th);
  if (cols <= 0 || rows <= 0) return null;
  const col = Math.floor(x / tw), row = Math.floor(y / th);
  if (col >= cols || row >= rows) return null;
  return row * cols + col;
}

// ------------------------------------------------------------- commands

function setOrDelete(obj, key, val) {
  if (val === undefined) delete obj[key];
  else obj[key] = val;
}

// Deep-clone neighbors preset values, guarded for undefined
const cloneNb = v => v === undefined ? undefined : structuredClone(v);

// Check if element is a typing target (input, textarea, contenteditable, or in open dialog)
function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// Pixel-carrying swap across all layers, plus names[a]<->names[b] and
// neighbors[a]<->neighbors[b], as one undo/redo step. Follows frames.js's
// commitMove pattern: apply the real mutation now (patches/before values
// captured first), then push a command whose do()/undo() replay the exact
// same after/before states — do() re-running on redo is then idempotent
// regardless of how many times it's called.
function commitSwapTile(sheet, a, b) {
  const ra = tileRect(sheet, a), rb = tileRect(sheet, b);
  const patches = sheet.layers.map((layer) => {
    const beforeA = copyRegion(layer.bitmap, ra.x, ra.y, ra.w, ra.h);
    const beforeB = copyRegion(layer.bitmap, rb.x, rb.y, rb.w, rb.h);
    blitRegion(layer.bitmap, beforeB, ra.x, ra.y);
    blitRegion(layer.bitmap, beforeA, rb.x, rb.y);
    return { layer, beforeA, beforeB };
  });

  const namesBefore = { a: sheet.tile.names[a], b: sheet.tile.names[b] };
  const neighborsBefore = { a: cloneNb(sheet.tile.neighbors[a]), b: cloneNb(sheet.tile.neighbors[b]) };
  setOrDelete(sheet.tile.names, a, namesBefore.b);
  setOrDelete(sheet.tile.names, b, namesBefore.a);
  setOrDelete(sheet.tile.neighbors, a, cloneNb(neighborsBefore.b));
  setOrDelete(sheet.tile.neighbors, b, cloneNb(neighborsBefore.a));

  const cmd = {
    label: 'swap tiles',
    do() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeB, ra.x, ra.y);
        blitRegion(p.layer.bitmap, p.beforeA, rb.x, rb.y);
      }
      setOrDelete(sheet.tile.names, a, namesBefore.b);
      setOrDelete(sheet.tile.names, b, namesBefore.a);
      setOrDelete(sheet.tile.neighbors, a, cloneNb(neighborsBefore.b));
      setOrDelete(sheet.tile.neighbors, b, cloneNb(neighborsBefore.a));
    },
    undo() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, ra.x, ra.y);
        blitRegion(p.layer.bitmap, p.beforeB, rb.x, rb.y);
      }
      setOrDelete(sheet.tile.names, a, namesBefore.a);
      setOrDelete(sheet.tile.names, b, namesBefore.b);
      setOrDelete(sheet.tile.neighbors, a, cloneNb(neighborsBefore.a));
      setOrDelete(sheet.tile.neighbors, b, cloneNb(neighborsBefore.b));
    },
  };
  state.commands.push(cmd);
  markDirty();
}

// Move: A's pixels overwrite B (all layers), A is cleared to transparent.
// A's name/neighbors move to B; B's originals are dropped. One command.
function commitMoveTile(sheet, a, b) {
  const ra = tileRect(sheet, a), rb = tileRect(sheet, b);
  const patches = sheet.layers.map((layer) => {
    const beforeA = copyRegion(layer.bitmap, ra.x, ra.y, ra.w, ra.h);
    const beforeB = copyRegion(layer.bitmap, rb.x, rb.y, rb.w, rb.h);
    blitRegion(layer.bitmap, beforeA, rb.x, rb.y);
    fillRegion(layer.bitmap, ra.x, ra.y, ra.w, ra.h, [0, 0, 0, 0]);
    return { layer, beforeA, beforeB };
  });

  const namesBefore = { a: sheet.tile.names[a], b: sheet.tile.names[b] };
  const neighborsBefore = { a: cloneNb(sheet.tile.neighbors[a]), b: cloneNb(sheet.tile.neighbors[b]) };
  setOrDelete(sheet.tile.names, b, namesBefore.a);
  setOrDelete(sheet.tile.names, a, undefined);
  setOrDelete(sheet.tile.neighbors, b, cloneNb(neighborsBefore.a));
  setOrDelete(sheet.tile.neighbors, a, undefined);

  const cmd = {
    label: 'move tile',
    do() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, rb.x, rb.y);
        fillRegion(p.layer.bitmap, ra.x, ra.y, ra.w, ra.h, [0, 0, 0, 0]);
      }
      setOrDelete(sheet.tile.names, b, namesBefore.a);
      setOrDelete(sheet.tile.names, a, undefined);
      setOrDelete(sheet.tile.neighbors, b, cloneNb(neighborsBefore.a));
      setOrDelete(sheet.tile.neighbors, a, undefined);
    },
    undo() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, ra.x, ra.y);
        blitRegion(p.layer.bitmap, p.beforeB, rb.x, rb.y);
      }
      setOrDelete(sheet.tile.names, a, namesBefore.a);
      setOrDelete(sheet.tile.names, b, namesBefore.b);
      setOrDelete(sheet.tile.neighbors, a, cloneNb(neighborsBefore.a));
      setOrDelete(sheet.tile.neighbors, b, cloneNb(neighborsBefore.b));
    },
  };
  state.commands.push(cmd);
  markDirty();
}

function openTileEditor(index) {
  state.editingTileIndex = index;
  state.view = 'tile';
  emit('view');
}

// ------------------------------------------------------------- pointer

function handleDown(ev, view) {
  const sheet = activeSheet();
  if (!sheet || !sheet.tile) return;
  const idx = tileIndexAt(sheet, ev.x, ev.y);
  if (idx === null) {
    if (state.selectedTileIndex !== null) { state.selectedTileIndex = null; emit('selection'); }
    lastClick = null;
    drag = null;
    view.requestRender();
    return;
  }
  const now = performance.now();
  if (lastClick && lastClick.index === idx && (now - lastClick.time) < DBLCLICK_MS) {
    lastClick = null;
    drag = null;
    openTileEditor(idx);
    return;
  }
  lastClick = { index: idx, time: now };
  if (state.selectedTileIndex !== idx) { state.selectedTileIndex = idx; emit('selection'); }
  drag = { from: idx, to: idx, shift: ev.shiftKey };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) return;
  const sheet = activeSheet();
  if (!sheet) return;
  drag.to = tileIndexAt(sheet, ev.x, ev.y);
  drag.shift = ev.shiftKey;
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
  // Plain click (no movement) or dropped outside the grid: selection was
  // already set on pointerdown, nothing further to do.
  if (d.to === null || d.to === d.from) return;
  if (d.shift) commitMoveTile(sheet, d.from, d.to);
  else commitSwapTile(sheet, d.from, d.to);
  if (state.selectedTileIndex !== d.to) { state.selectedTileIndex = d.to; emit('selection'); }
}

// ------------------------------------------------------------- overlay

function drawTileToolGhost(ctx, view) {
  if (state.mode !== 'tiles' || state.tool !== 'tiletool') return;
  if (!drag || drag.to === null || drag.to === drag.from) return;
  const sheet = activeSheet();
  if (!sheet || !sheet.tile) return;
  const r = tileRect(sheet, drag.to);
  const p0 = view.imageToScreen(r.x, r.y);
  const p1 = view.imageToScreen(r.x + r.w, r.y + r.h);
  ctx.save();
  ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
  ctx.restore();
}

// ------------------------------------------------------------- public API

export function registerTileTool() {
  registerTool({ id: 'tiletool', icon: '🔲', key: 't', isAvailable: () => state.mode === 'tiles' });
}

export function bindTileTool(view) {
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'tiles' && state.tool === 'tiletool') {
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
    drawTileToolGhost(ctx, view);
  };

  on('project', () => { if (drag) { drag = null; lastClick = null; view.requestRender(); } });
  on('tool', () => { if (state.tool !== 'tiletool' && drag) { drag = null; view.requestRender(); } });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.mode === 'tiles' && state.selectedTileIndex !== null) {
      state.selectedTileIndex = null;
      drag = null;
      emit('selection');
      view.requestRender();
    }
  });
}

// ------------------------------------------------------------- tile panel

function commitTileSize(sheet, key, value) {
  const before = sheet.tile[key];
  if (before === value) return;
  state.commands.push({
    label: `edit tile ${key}`,
    do() { sheet.tile[key] = value; },
    undo() { sheet.tile[key] = before; },
  });
  markDirty();
}

function commitTileName(sheet, index, name) {
  const before = sheet.tile.names[index];
  const after = name || undefined;
  if (before === after) return;
  state.commands.push({
    label: 'rename tile',
    do() { setOrDelete(sheet.tile.names, index, after); },
    undo() { setOrDelete(sheet.tile.names, index, before); },
  });
  markDirty();
}

function sizeField(labelText, value, onCommit) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.value = String(value);
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    input.value = String(v);
    onCommit(v);
  });
  label.appendChild(input);
  return label;
}

export function mountTilePanel(el) {
  // Shares #panel-context with frames.js's mountFramesPanel — see that
  // function's wrap-div comment. This panel gets its own wrapper, toggled
  // independently, so the two never clobber each other's DOM.
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Tiles';
  wrap.appendChild(h3);

  const sizeRow = document.createElement('div');
  sizeRow.className = 'row';
  wrap.appendChild(sizeRow);

  const countRow = document.createElement('div');
  countRow.className = 'row';
  wrap.appendChild(countRow);

  const selRow = document.createElement('div');
  selRow.className = 'row tile-selected';
  wrap.appendChild(selRow);

  function render() {
    if (state.mode !== 'tiles') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const sheet = activeSheet();
    sizeRow.innerHTML = '';
    countRow.innerHTML = '';
    selRow.innerHTML = '';
    if (!sheet || !sheet.tile) return;

    sizeRow.append(
      sizeField('W', sheet.tile.tileWidth, (v) => commitTileSize(sheet, 'tileWidth', v)),
      sizeField('H', sheet.tile.tileHeight, (v) => commitTileSize(sheet, 'tileHeight', v)),
    );

    const count = tileCount(sheet);
    countRow.textContent = `${count} tile${count === 1 ? '' : 's'}`;

    const idx = state.selectedTileIndex;
    if (idx == null || idx < 0 || idx >= count) {
      const hint = document.createElement('span');
      hint.textContent = 'No tile selected';
      selRow.appendChild(hint);
      return;
    }

    const idxLabel = document.createElement('span');
    idxLabel.textContent = `#${idx}`;
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = sheet.tile.names[idx] || '';
    nameInput.placeholder = 'name';
    nameInput.addEventListener('change', () => commitTileName(sheet, idx, nameInput.value.trim()));
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.textContent = 'Edit tile';
    btnEdit.addEventListener('click', () => openTileEditor(idx));

    selRow.append(idxLabel, nameInput, btnEdit);
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  on('project', schedule);
  on('history', schedule);
  on('view', schedule);
  on('selection', schedule);
  render();
}
