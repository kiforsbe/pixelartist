// Tile mode: tile tool (select/swap/move on the atlas), and the tile
// context panel (tile size, tile count, selected-tile name + "Edit tile").
//
// Mirrors frames.js's split: registerTileTool() adds the palette button
// (isAvailable gates it to tile mode, like frametool gates to sprite mode),
// bindTileTool(view) wraps a CanvasView's onPointer/onOverlay the same way
// bindFrameTool does, and mountTilePanel(el) targets the SAME #panel-context
// element frames.js's mountFramesPanel does — see mountFramesPanel's wrap-div
// comment for how the two coexist without clobbering each other.

import { state, on, emit, activeSheet, markDirty, currentContextLayers } from '../app/state.js';
import { copyRegion, blitRegion, fillRegion } from '../core/pixels.js';
import { registerTool } from './tools.js';
import {
  gridCellRect, ownedTiles, relayoutGrid, resizeGridCols, resizeGridRows,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
} from '../core/tilegrids.js';
import { newId } from '../core/palettes.js';

// ------------------------------------------------------------- geometry

function tileAt(sheet, x, y) {
  for (let i = sheet.tiles.length - 1; i >= 0; i--) {
    const t = sheet.tiles[i];
    if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
  }
  return null;
}

// Inclusive rect (create-drag: both points are pixel indices, w = |dx|+1)
// vs. non-inclusive (resize: points are rect EDGE coords). Duplicated from
// frames.js's private helper of the same name/shape — small enough, and
// this codebase already duplicates isTypingTarget the same way across
// tileeditor.js/tilemode.js/frames.js.
function rectBetween(ax, ay, bx, by, inclusive) {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  if (inclusive) return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

const HANDLES = ['nw', 'ne', 'sw', 'se'];
const HANDLE_SCREEN_PX = 6;
const GRID_HANDLE_SCREEN_PX = 6;

function oppositeCorner(t, handle) {
  const map = {
    nw: { x: t.x + t.w, y: t.y + t.h },
    ne: { x: t.x, y: t.y + t.h },
    sw: { x: t.x + t.w, y: t.y },
    se: { x: t.x, y: t.y },
  };
  return map[handle];
}

// Resize handles only ever apply to a STANDALONE (gridId == null) selected
// tile — a grid-owned tile's size is controlled by its grid's cellW/cellH.
function hitHandle(view, tile, sx, sy) {
  if (!tile || tile.gridId != null) return null;
  for (const h of HANDLES) {
    const ix = h[1] === 'w' ? tile.x : tile.x + tile.w;
    const iy = h[0] === 'n' ? tile.y : tile.y + tile.h;
    const p = view.imageToScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}

// A grid's own drag handle sits at its origin corner — dragging an owned
// TILE is reserved for the swap/move interaction below, so moving the whole
// grid needs a separate, always-visible affordance.
function hitGridHandle(view, sheet, sx, sy) {
  for (const g of sheet.tileGrids) {
    const p = view.imageToScreen(g.x, g.y);
    if (Math.abs(sx - p.x) <= GRID_HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= GRID_HANDLE_SCREEN_PX) return g;
  }
  return null;
}

// ------------------------------------------------------------- commands

// Deep-clone a neighbors preset value, guarded for undefined.
const cloneNb = v => v === undefined ? undefined : structuredClone(v);

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// Pixel-carrying swap across all layers, plus name<->name and
// neighbors<->neighbors, as one undo/redo step. Same size required by the
// caller (handleUp) before this is invoked — a and b's rects are used
// as-is, whatever their current x/y/w/h (grid-owned or standalone).
function commitSwapTile(sheet, a, b) {
  const patches = currentContextLayers().map((layer) => {
    const beforeA = copyRegion(layer.bitmap, a.x, a.y, a.w, a.h);
    const beforeB = copyRegion(layer.bitmap, b.x, b.y, b.w, b.h);
    blitRegion(layer.bitmap, beforeB, a.x, a.y);
    blitRegion(layer.bitmap, beforeA, b.x, b.y);
    return { layer, beforeA, beforeB };
  });

  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };
  a.name = namesBefore.b; b.name = namesBefore.a;
  a.neighbors = cloneNb(neighborsBefore.b); b.neighbors = cloneNb(neighborsBefore.a);

  const cmd = {
    label: 'swap tiles',
    do() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeB, a.x, a.y);
        blitRegion(p.layer.bitmap, p.beforeA, b.x, b.y);
      }
      a.name = namesBefore.b; b.name = namesBefore.a;
      a.neighbors = cloneNb(neighborsBefore.b); b.neighbors = cloneNb(neighborsBefore.a);
    },
    undo() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(p.layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    },
  };
  state.commands.push(cmd);
  markDirty();
}

// Move: A's pixels overwrite B (all layers), A clears to transparent.
// A's name/neighbors move to B; B's originals are dropped.
function commitMoveTile(sheet, a, b) {
  const patches = currentContextLayers().map((layer) => {
    const beforeA = copyRegion(layer.bitmap, a.x, a.y, a.w, a.h);
    const beforeB = copyRegion(layer.bitmap, b.x, b.y, b.w, b.h);
    blitRegion(layer.bitmap, beforeA, b.x, b.y);
    fillRegion(layer.bitmap, a.x, a.y, a.w, a.h, [0, 0, 0, 0]);
    return { layer, beforeA, beforeB };
  });

  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };
  b.name = namesBefore.a; a.name = undefined;
  b.neighbors = cloneNb(neighborsBefore.a); a.neighbors = undefined;

  const cmd = {
    label: 'move tile',
    do() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, b.x, b.y);
        fillRegion(p.layer.bitmap, a.x, a.y, a.w, a.h, [0, 0, 0, 0]);
      }
      b.name = namesBefore.a; a.name = undefined;
      b.neighbors = cloneNb(neighborsBefore.a); a.neighbors = undefined;
    },
    undo() {
      for (const p of patches) {
        blitRegion(p.layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(p.layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    },
  };
  state.commands.push(cmd);
  markDirty();
}

// Standalone tile: metadata-only reposition (frame-style), clamped so the
// caller's delta keeps the tile fully on-sheet.
function commitMoveStandaloneTile(tile, dx, dy) {
  const before = { x: tile.x, y: tile.y };
  state.commands.push({
    label: 'move tile',
    do() { tile.x = before.x + dx; tile.y = before.y + dy; },
    undo() { tile.x = before.x; tile.y = before.y; },
  });
  markDirty();
}

function commitResizeTile(tile, before, after) {
  state.commands.push({
    label: 'resize tile',
    do() { tile.x = after.x; tile.y = after.y; tile.w = after.w; tile.h = after.h; },
    undo() { tile.x = before.x; tile.y = before.y; tile.w = before.w; tile.h = before.h; },
  });
  markDirty();
}

function commitCreateTile(sheet, rect) {
  let created = null;
  const cmd = {
    label: 'add tile',
    do() {
      if (!created) {
        created = { id: newId('ti'), x: rect.x, y: rect.y, w: rect.w, h: rect.h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined };
        sheet.tiles.push(created);
      } else if (!sheet.tiles.includes(created)) {
        sheet.tiles.push(created);
      }
      state.selectedTileId = created.id;
    },
    undo() {
      sheet.tiles = sheet.tiles.filter(t => t !== created);
      if (state.selectedTileId === created.id) state.selectedTileId = null;
    },
  };
  state.commands.push(cmd);
  markDirty();
  emit('selection');
}

// Grid-owned tiles aren't deleted individually (that would desync the grid
// — shrink the grid, or detach first).
function deleteTile(sheet, tileId) {
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!tile || tile.gridId != null) return;
  const idx = sheet.tiles.indexOf(tile);
  const wasSelected = state.selectedTileId === tileId;
  state.commands.push({
    label: 'delete tile',
    do() {
      sheet.tiles = sheet.tiles.filter(t => t !== tile);
      if (state.selectedTileId === tile.id) state.selectedTileId = null;
    },
    undo() {
      sheet.tiles.splice(Math.min(idx, sheet.tiles.length), 0, tile);
      if (wasSelected) state.selectedTileId = tile.id;
    },
  });
  markDirty();
  emit('selection');
}

function commitMoveGrid(sheet, grid, dx, dy) {
  const before = { x: grid.x, y: grid.y };
  state.commands.push({
    label: 'move grid',
    do() { grid.x = before.x + dx; grid.y = before.y + dy; relayoutGrid(sheet, grid); },
    undo() { grid.x = before.x; grid.y = before.y; relayoutGrid(sheet, grid); },
  });
  markDirty();
}

function openTileEditor(tileId) {
  state.editingTileId = tileId;
  state.view = 'tile';
  emit('view');
}

// ------------------------------------------------------------- pointer

const DBLCLICK_MS = 400;
const TILE_GHOST = '#fff';
const TILE_GHOST_MOVE = '#ffb020';

let drag = null;
let lastClick = null; // { tileId, time }

function handleDown(ev, view) {
  const sheet = activeSheet();
  if (!sheet) return;

  const gridHit = hitGridHandle(view, sheet, ev.sx, ev.sy);
  if (gridHit) {
    drag = { kind: 'gridmove', grid: gridHit, anchor: { x: ev.x, y: ev.y }, dx: 0, dy: 0 };
    view.requestRender();
    return;
  }

  const selected = sheet.tiles.find(t => t.id === state.selectedTileId) || null;
  const handle = hitHandle(view, selected, ev.sx, ev.sy);
  if (handle) {
    drag = {
      kind: 'resize', tile: selected, handle,
      before: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
      anchor: oppositeCorner(selected, handle),
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }

  const hit = tileAt(sheet, ev.x, ev.y);
  const now = performance.now();
  if (hit && lastClick && lastClick.tileId === hit.id && now - lastClick.time < DBLCLICK_MS) {
    lastClick = null;
    drag = null;
    openTileEditor(hit.id);
    return;
  }
  lastClick = hit ? { tileId: hit.id, time: now } : null;

  if (!hit) {
    if (state.selectedTileId !== null) { state.selectedTileId = null; emit('selection'); }
    drag = { kind: 'create', anchor: { x: ev.x, y: ev.y }, rect: null };
    view.requestRender();
    return;
  }

  if (state.selectedTileId !== hit.id) { state.selectedTileId = hit.id; emit('selection'); }
  drag = { kind: 'tiledrag', from: hit, anchor: { x: ev.x, y: ev.y }, to: { x: ev.x, y: ev.y }, shift: ev.shiftKey };
  view.requestRender();
}

function handleMove(ev, view) {
  if (!drag) return;
  if (drag.kind === 'create') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, true);
  } else if (drag.kind === 'resize') {
    drag.rect = rectBetween(drag.anchor.x, drag.anchor.y, ev.x, ev.y, false);
  } else if (drag.kind === 'gridmove') {
    drag.dx = ev.x - drag.anchor.x;
    drag.dy = ev.y - drag.anchor.y;
  } else if (drag.kind === 'tiledrag') {
    drag.to = { x: ev.x, y: ev.y };
    drag.shift = ev.shiftKey;
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
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1) commitCreateTile(sheet, d.rect);
    return;
  }
  if (d.kind === 'gridmove') {
    if (d.dx !== 0 || d.dy !== 0) commitMoveGrid(sheet, d.grid, d.dx, d.dy);
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      commitResizeTile(d.tile, d.before, r);
    return;
  }
  if (d.kind === 'tiledrag') {
    const from = d.from;
    const target = tileAt(sheet, ev.x, ev.y);
    if (target && target !== from && target.w === from.w && target.h === from.h) {
      if (d.shift) commitMoveTile(sheet, from, target);
      else commitSwapTile(sheet, from, target);
      state.selectedTileId = target.id;
      emit('selection');
      return;
    }
    if (from.gridId != null) return; // grid-owned, no same-size target: snaps back
    const dx = Math.max(-from.x, Math.min(sheet.width - (from.x + from.w), ev.x - d.anchor.x));
    const dy = Math.max(-from.y, Math.min(sheet.height - (from.y + from.h), ev.y - d.anchor.y));
    if (dx !== 0 || dy !== 0) commitMoveStandaloneTile(from, dx, dy);
    return;
  }
}

// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

function drawGridHandles(ctx, view, sheet) {
  ctx.save();
  ctx.fillStyle = '#4f8cff';
  for (const g of sheet.tileGrids) {
    const p = view.imageToScreen(g.x, g.y);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.restore();
}

function drawTileToolGhost(ctx, view) {
  if (state.mode !== 'tiles') return;
  const sheet = activeSheet();
  if (!sheet) return;

  if (addGridPreviewOpts) drawAddGridPreview(ctx, view);

  if (state.tool === 'tiletool') drawGridHandles(ctx, view, sheet);

  if (!drag) return;
  ctx.save();
  ctx.strokeStyle = TILE_GHOST;
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 2;
  if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'gridmove') {
    for (const t of ownedTiles(sheet, drag.grid.id))
      strokeGhostRect(ctx, view, { x: t.x + drag.dx, y: t.y + drag.dy, w: t.w, h: t.h });
  } else if (drag.kind === 'tiledrag' && drag.to) {
    const target = tileAt(sheet, drag.to.x, drag.to.y);
    const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
    if (swapCandidate) {
      ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
      strokeGhostRect(ctx, view, target);
    } else if (drag.from.gridId == null) {
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      strokeGhostRect(ctx, view, { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h });
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------- public API

let tileToolView = null; // set by bindTileTool; read by Task 7's Add Grid dialog preview

export function registerTileTool() {
  registerTool({ id: 'tiletool', icon: '🔲', key: 't', isAvailable: () => state.mode === 'tiles' });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.tool !== 'tiletool' || state.mode !== 'tiles') return;
    const sheet = activeSheet();
    if (!sheet || !state.selectedTileId) return;
    deleteTile(sheet, state.selectedTileId);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (state.mode === 'tiles' && state.selectedTileId !== null) {
      state.selectedTileId = null;
      drag = null;
      emit('selection');
    }
  });
}

export function bindTileTool(view) {
  tileToolView = view;
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
