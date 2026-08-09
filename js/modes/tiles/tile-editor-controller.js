// Tile-sheet geometry, pointer routing, and overlay rendering.

import { state, on, emit, activeSheet } from '../../app/state.js';
import { registerTool } from '../../ui/tools.js';
import { gridCellRect, ownedTiles } from '../../core/tilegrids.js';
import { rectBetween } from '../../core/rect.js';
import { HANDLES_CORNER, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../core/resizeAnchor.js';
import { isTypingTarget } from '../../components/dom-utils.js';
import { bindDragCancelGuard } from '../../components/canvas/drag-cancel-guard.js';
import { drawRectDims, drawChainDims } from '../../ui/dimlabels.js';
import {
  commitSwapTile, commitMoveTile, commitMoveStandaloneTile, commitResizeTile,
  commitCreateTile, deleteTile, commitMoveGrid, commitGrowTileIntoGrid,
  commitResizeGridAxis, openTileEditor,
} from './tile-sheet-commands.js';

// ------------------------------------------------------------- geometry

function tileAt(sheet, x, y) {
  for (let i = sheet.tiles.length - 1; i >= 0; i--) {
    const t = sheet.tiles[i];
    if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
  }
  return null;
}

const HANDLE_SCREEN_PX = 6;
const GRID_HANDLE_SCREEN_PX = 6;

// Resize handles only ever apply to a STANDALONE (gridId == null) selected
// tile — a grid-owned tile's size is controlled by its grid's cellW/cellH.
function hitHandle(view, tile, sx, sy) {
  if (!tile || tile.gridId != null) return null;
  for (const h of HANDLES_CORNER) {
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

// Outer bounding box of everything a grid owns, in sheet-space.
function gridBounds(grid) {
  return {
    x: grid.x, y: grid.y,
    w: grid.cols * (grid.cellW + grid.spacingX) - grid.spacingX,
    h: grid.rows * (grid.cellH + grid.spacingY) - grid.spacingY,
  };
}

// 4 edge-strip hit zones (screen space) around `bounds` (sheet-space
// {x,y,w,h}) -- either a standalone tile's own rect, or a grid's outer
// bounding box. Mirrors frames.js's standaloneGripGeometry/
// chromeGeometry grips, generalized from 2 sides (left/right) to 4.
// Each strip is inset by a fixed number of screen pixels at both ends
// (matching HANDLE_SCREEN_PX/GRID_HANDLE_SCREEN_PX's existing 6px corner-
// handle size) rather than spanning the full edge -- keeps the 4 grips
// visually/hit-testably distinct near the corners instead of meeting flush.
const GRIP_INSET_PX = 12;

function tileGripGeometry(view, bounds) {
  const p0 = view.imageToScreen(bounds.x, bounds.y);
  const p1 = view.imageToScreen(bounds.x + bounds.w, bounds.y + bounds.h);
  const gripH = Math.max(0, (p1.y - p0.y) - 2 * GRIP_INSET_PX);
  const gripW = Math.max(0, (p1.x - p0.x) - 2 * GRIP_INSET_PX);
  return [
    { axis: 'cols', side: 'start', x: p0.x - 3, y: p0.y + GRIP_INSET_PX, w: 6, h: gripH },
    { axis: 'cols', side: 'end', x: p1.x - 3, y: p0.y + GRIP_INSET_PX, w: 6, h: gripH },
    { axis: 'rows', side: 'start', x: p0.x + GRIP_INSET_PX, y: p0.y - 3, w: gripW, h: 6 },
    { axis: 'rows', side: 'end', x: p0.x + GRIP_INSET_PX, y: p1.y - 3, w: gripW, h: 6 },
  ];
}

function hitTileGrip(grips, sx, sy) {
  for (const g of grips)
    if (sx >= g.x - 2 && sx <= g.x + g.w + 2 && sy >= g.y - 2 && sy <= g.y + g.h + 2)
      return { axis: g.axis, side: g.side };
  return null;
}

// A synthetic grid-shaped object representing the LIVE state of an
// in-progress gridresize drag, for rendering only -- never touches real
// sheet data. Works uniformly whether d.grid is set (existing grid being
// resized) or null (a standalone tile being dragged into a brand-new
// grid): cellW/cellH/spacing fall back to the dragged tile's own size
// with no spacing when there's no real grid yet.
function ghostGridFor(d) {
  const cellW = d.grid ? d.grid.cellW : (d.axis === 'rows' ? d.tile.w : d.step);
  const cellH = d.grid ? d.grid.cellH : (d.axis === 'cols' ? d.tile.h : d.step);
  const spacingX = d.grid ? d.grid.spacingX : 0;
  const spacingY = d.grid ? d.grid.spacingY : 0;
  const cols = d.axis === 'cols' ? d.count : (d.grid ? d.grid.cols : 1);
  const rows = d.axis === 'rows' ? d.count : (d.grid ? d.grid.rows : 1);
  let x = d.bbox.x, y = d.bbox.y;
  if (d.axis === 'cols' && d.side === 'start') x = d.bbox.x + d.bbox.w - (cols * (cellW + spacingX) - spacingX);
  if (d.axis === 'rows' && d.side === 'start') y = d.bbox.y + d.bbox.h - (rows * (cellH + spacingY) - spacingY);
  return { x, y, cellW, cellH, cols, rows, spacingX, spacingY };
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
      rect: { x: selected.x, y: selected.y, w: selected.w, h: selected.h },
    };
    view.requestRender();
    return;
  }

  if (selected) {
    const grid = selected.gridId != null ? sheet.tileGrids.find(g => g.id === selected.gridId) : null;
    const bounds = grid ? gridBounds(grid) : { x: selected.x, y: selected.y, w: selected.w, h: selected.h };
    const gripHit = hitTileGrip(tileGripGeometry(view, bounds), ev.sx, ev.sy);
    if (gripHit) {
      const step = gripHit.axis === 'cols'
        ? (grid ? grid.cellW + grid.spacingX : selected.w)
        : (grid ? grid.cellH + grid.spacingY : selected.h);
      const count0 = grid ? (gripHit.axis === 'cols' ? grid.cols : grid.rows) : 1;
      drag = {
        kind: 'gridresize', axis: gripHit.axis, side: gripHit.side,
        grid, tile: selected, step, bbox: bounds, count0, count: count0,
      };
      view.requestRender();
      return;
    }
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
    drag.rect = resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, {
      useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev),
    });
  } else if (drag.kind === 'gridmove') {
    const sheet = activeSheet();
    const bounds = gridBounds(drag.grid);
    drag.dx = sheet ? Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - drag.anchor.x)) : ev.x - drag.anchor.x;
    drag.dy = sheet ? Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - drag.anchor.y)) : ev.y - drag.anchor.y;
  } else if (drag.kind === 'tiledrag') {
    drag.to = { x: ev.x, y: ev.y };
    drag.shift = ev.shiftKey;
  } else if (drag.kind === 'gridresize') {
    const raw = drag.side === 'end'
      ? (drag.axis === 'cols' ? ev.x - (drag.bbox.x + drag.bbox.w) : ev.y - (drag.bbox.y + drag.bbox.h))
      : (drag.axis === 'cols' ? drag.bbox.x - ev.x : drag.bbox.y - ev.y);
    let count = drag.count0 + Math.round(raw / drag.step);
    count = Math.max(1, count);
    const sheet = activeSheet();
    if (sheet) {
      const maxCount = drag.axis === 'cols'
        ? (drag.side === 'end'
            ? Math.floor((sheet.width - drag.bbox.x) / drag.step)
            : Math.floor((drag.bbox.x + drag.bbox.w) / drag.step))
        : (drag.side === 'end'
            ? Math.floor((sheet.height - drag.bbox.y) / drag.step)
            : Math.floor((drag.bbox.y + drag.bbox.h) / drag.step));
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
    if (from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === from.gridId);
      const bounds = gridBounds(grid);
      const dx = Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - d.anchor.x));
      const dy = Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - d.anchor.y));
      if (dx !== 0 || dy !== 0) commitMoveGrid(sheet, grid, dx, dy);
      return;
    }
    const target = tileAt(sheet, ev.x, ev.y);
    if (target && target !== from && target.w === from.w && target.h === from.h) {
      if (d.shift) commitMoveTile(sheet, from, target);
      else commitSwapTile(sheet, from, target);
      state.selectedTileId = target.id;
      emit('selection');
      return;
    }
    const dx = Math.max(-from.x, Math.min(sheet.width - (from.x + from.w), ev.x - d.anchor.x));
    const dy = Math.max(-from.y, Math.min(sheet.height - (from.y + from.h), ev.y - d.anchor.y));
    if (dx !== 0 || dy !== 0) commitMoveStandaloneTile(from, dx, dy);
    return;
  }
  if (d.kind === 'gridresize') {
    if (d.count === d.count0) return;
    if (d.grid) commitResizeGridAxis(sheet, d.grid, d.axis, d.side, d.count);
    else commitGrowTileIntoGrid(sheet, d.tile, d.axis, d.side, d.count);
    return;
  }
}

// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

// Solid outline around the whole selected tile/grid bounds -- the
// previously-missing piece that made selection hard to spot at a glance
// (dim quiet-mode labels + small corner/edge grips alone don't read as
// "this is selected" the way a full border does). Uses a distinct color
// from the blue handles/grips so the selected tile itself pops rather than
// blending into the rest of the chrome.
const SELECTION_OUTLINE = '#ffe066';
function drawTileSelectionOutline(ctx, view, bounds) {
  ctx.save();
  ctx.strokeStyle = SELECTION_OUTLINE;
  ctx.lineWidth = 2;
  strokeGhostRect(ctx, view, bounds);
  ctx.restore();
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

const TILE_HANDLE = '#4f8cff';

// Resize-grip squares at the 4 corners of a standalone selected tile —
// mirrors frames.js's drawHandles for a non-strip selected frame. Grid-owned
// tiles never get these (their size is fixed by the grid, matching
// hitHandle's gridId gate above).
function drawTileHandles(ctx, view, tile) {
  ctx.save();
  ctx.fillStyle = TILE_HANDLE;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? tile.x : tile.x + tile.w;
    const iy = h[0] === 'n' ? tile.y : tile.y + tile.h;
    const p = view.imageToScreen(ix, iy);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
  ctx.restore();
}

// Visible edge-grip squares -- mirrors frames.js's drawGrips look (filled
// blue rects), no hover-highlight tracking (out of scope for this pass;
// frames.js's hover state is a bigger refactor than this feature needs).
function drawTileGrips(ctx, grips) {
  ctx.save();
  ctx.fillStyle = TILE_HANDLE;
  ctx.globalAlpha = 0.7;
  for (const g of grips) ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.restore();
}

// Grid dimension chrome — mirrors frames.js's drawStripDims for a strip:
// level-0 chains for column widths (bottom edge) and row heights (right
// edge), level-1 overall bbox dims — same bottom/right edges as the default
// (side: 'end') drawRectDims/drawChainDims used everywhere else in this app.
// dx/dy shift everything to the drag-ghost position (grid move); opts
// carries quiet for idle display.
function drawGridDims(ctx, view, grid, opts = {}) {
  const dx = opts.dx ?? 0, dy = opts.dy ?? 0;
  const shifted = (dx || dy) ? { ...grid, x: grid.x + dx, y: grid.y + dy } : grid;
  const alpha = opts.quiet ? 0.7 : 1;
  const last = gridCellRect(shifted, grid.cols - 1, grid.rows - 1);
  // A single column's/row's per-cell width/height IS the overall width/
  // height -- drawing both would show the same number twice. Only draw the
  // per-cell chain (and push the overall dim out to level 1, out of its way)
  // when there's more than one cell to break down.
  if (grid.cols > 1) {
    const bottomRow = Array.from({ length: grid.cols }, (_, col) => gridCellRect(shifted, col, grid.rows - 1));
    drawChainDims(ctx, view, {
      axis: 'h', edge: last.y + last.h,
      spans: bottomRow.map(r => ({ from: r.x, to: r.x + r.w, text: `${r.w}` })),
      alpha,
    });
  }
  if (grid.rows > 1) {
    const rightCol = Array.from({ length: grid.rows }, (_, row) => gridCellRect(shifted, grid.cols - 1, row));
    drawChainDims(ctx, view, {
      axis: 'v', edge: last.x + last.w,
      spans: rightCol.map(r => ({ from: r.y, to: r.y + r.h, text: `${r.h}` })),
      alpha,
    });
  }
  const overall = { x: shifted.x, y: shifted.y, w: last.x + last.w - shifted.x, h: last.y + last.h - shifted.y };
  drawRectDims(ctx, view, overall, {
    quiet: opts.quiet, dx: opts.dx, dy: opts.dy, dw: opts.dw, dh: opts.dh,
    wLevel: grid.cols > 1 ? 1 : 0, hLevel: grid.rows > 1 ? 1 : 0,
  });
}

function drawTileToolGhost(ctx, view) {
  if (state.mode !== 'tiles') return;
  const sheet = activeSheet();
  if (!sheet) return;

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
    if (drag.from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === drag.from.gridId);
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      for (const t of ownedTiles(sheet, grid.id))
        strokeGhostRect(ctx, view, { x: t.x + dx, y: t.y + dy, w: t.w, h: t.h });
    } else {
      const target = tileAt(sheet, drag.to.x, drag.to.y);
      const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
      if (swapCandidate) {
        ctx.strokeStyle = drag.shift ? TILE_GHOST_MOVE : TILE_GHOST;
        strokeGhostRect(ctx, view, target);
      } else {
        const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
        strokeGhostRect(ctx, view, { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h });
      }
    }
  } else if (drag.kind === 'gridresize') {
    strokeGhostRect(ctx, view, gridBounds(ghostGridFor(drag)));
  }
  ctx.restore();

  if (drag.kind === 'create' && drag.rect) {
    drawRectDims(ctx, view, drag.rect);
  } else if (drag.kind === 'resize' && drag.rect) {
    drawRectDims(ctx, view, drag.rect, { dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h });
  } else if (drag.kind === 'gridmove') {
    drawGridDims(ctx, view, drag.grid, { dx: drag.dx, dy: drag.dy });
  } else if (drag.kind === 'tiledrag' && drag.to) {
    if (drag.from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === drag.from.gridId);
      const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
      drawGridDims(ctx, view, grid, { dx, dy });
    } else {
      const target = tileAt(sheet, drag.to.x, drag.to.y);
      const swapCandidate = target && target !== drag.from && target.w === drag.from.w && target.h === drag.from.h;
      if (swapCandidate) {
        // no label for a swap — matches today's behavior
      } else {
        const dx = drag.to.x - drag.anchor.x, dy = drag.to.y - drag.anchor.y;
        const r = { x: drag.from.x + dx, y: drag.from.y + dy, w: drag.from.w, h: drag.from.h };
        drawRectDims(ctx, view, r, { dx, dy });
      }
    }
  } else if (drag.kind === 'gridresize') {
    drawGridDims(ctx, view, ghostGridFor(drag), {
      dw: drag.axis === 'cols' ? (drag.count - drag.count0) * drag.step : 0,
      dh: drag.axis === 'rows' ? (drag.count - drag.count0) * drag.step : 0,
    });
  }
}

// Idle selection chrome — the quiet dims shown for the selected tile when
// not dragging. Mirrors frames.js's drawStripChrome: a grid-owned tile shows
// the WHOLE GRID's dims (grid ~ strip), a standalone tile shows its own rect
// dims plus resize grips (grid-owned tiles never get grips — their size is
// fixed by the grid, matching the "no resize handles on intact-strip
// members" rule in frames.js). Must render above the tile label overlays,
// so main.js chains this as the final overlay layer, same as drawStripChrome.
export function drawTileChrome(ctx, view) {
  if (state.mode !== 'tiles' || state.tool !== 'tiletool' || drag) return;
  const sheet = activeSheet();
  if (!sheet) return;
  const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
  if (!tile) return;
  if (tile.gridId != null) {
    const grid = sheet.tileGrids.find(g => g.id === tile.gridId);
    if (grid) {
      const bounds = gridBounds(grid);
      // Outline the selected CELL, not the whole grid -- the grid's overall
      // dims/grips (below) already show the aggregate bounds; without this,
      // there'd be no way to see which cell within the grid is selected.
      drawTileSelectionOutline(ctx, view, tile);
      drawGridDims(ctx, view, grid, { quiet: true });
      drawTileGrips(ctx, tileGripGeometry(view, bounds));
    }
  } else {
    drawTileSelectionOutline(ctx, view, tile);
    drawRectDims(ctx, view, tile, { quiet: true });
    drawTileHandles(ctx, view, tile);
    drawTileGrips(ctx, tileGripGeometry(view, { x: tile.x, y: tile.y, w: tile.w, h: tile.h }));
  }
}

// ------------------------------------------------------------- public API

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

  bindDragCancelGuard(on, {
    isToolActive: () => state.tool === 'tiletool',
    hasDrag: () => !!drag,
    cancel: () => { drag = null; lastClick = null; },
    requestRender: () => view.requestRender(),
  });
}
