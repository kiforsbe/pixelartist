// js/modes/tiles/presentation/tile-tool-presenter.js
// Tile-sheet pointer routing and overlay rendering (Humble Object) --
// geometry math lives in application/geometry/tile-geometry.js; all project
// mutations go through CommandRegistry by id, never a direct import.

import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { registerTool } from '../../../ui/tools.js';
import { gridCellRect, ownedTiles } from '../../../core/tilegrids.js';
import { rectBetween } from '../../../core/rect.js';
import { HANDLES_CORNER, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../../core/resizeAnchor.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { bindDragCancelGuard } from '../../../components/canvas/drag-cancel-guard.js';
import { drawRectDims, drawChainDims } from '../../../ui/dimlabels.js';
import {
  tileAt, hitHandle, hitGridHandle, gridBounds, tileGripGeometry, hitTileGrip, ghostGridFor,
} from '../application/geometry/tile-geometry.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

// Not a project-mutating command (no undo entry) -- pure UI navigation state
// on the legacy `state` object. Shared by this file's double-click handler
// and the Tiles properties panel's Edit button.
export function openTileEditor(tileId) {
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
    if (moved && d.rect && d.rect.w >= 1 && d.rect.h >= 1) dispatch('tiles.createTile', { sheetId: sheet.id, rect: d.rect });
    return;
  }
  if (d.kind === 'gridmove') {
    if (d.dx !== 0 || d.dy !== 0) dispatch('tiles.moveGrid', { sheetId: sheet.id, gridId: d.grid.id, dx: d.dx, dy: d.dy });
    return;
  }
  if (d.kind === 'resize') {
    const r = d.rect;
    if (r && (r.x !== d.before.x || r.y !== d.before.y || r.w !== d.before.w || r.h !== d.before.h))
      dispatch('tiles.resizeTile', { sheetId: sheet.id, tileId: d.tile.id, before: d.before, after: r });
    return;
  }
  if (d.kind === 'tiledrag') {
    const from = d.from;
    if (from.gridId != null) {
      const grid = sheet.tileGrids.find(g => g.id === from.gridId);
      const bounds = gridBounds(grid);
      const dx = Math.max(-bounds.x, Math.min(sheet.width - (bounds.x + bounds.w), ev.x - d.anchor.x));
      const dy = Math.max(-bounds.y, Math.min(sheet.height - (bounds.y + bounds.h), ev.y - d.anchor.y));
      if (dx !== 0 || dy !== 0) dispatch('tiles.moveGrid', { sheetId: sheet.id, gridId: grid.id, dx, dy });
      return;
    }
    const target = tileAt(sheet, ev.x, ev.y);
    if (target && target !== from && target.w === from.w && target.h === from.h) {
      if (d.shift) dispatch('tiles.moveTile', { sheetId: sheet.id, aId: from.id, bId: target.id });
      else dispatch('tiles.swapTile', { sheetId: sheet.id, aId: from.id, bId: target.id });
      state.selectedTileId = target.id;
      emit('selection');
      return;
    }
    const dx = Math.max(-from.x, Math.min(sheet.width - (from.x + from.w), ev.x - d.anchor.x));
    const dy = Math.max(-from.y, Math.min(sheet.height - (from.y + from.h), ev.y - d.anchor.y));
    if (dx !== 0 || dy !== 0) dispatch('tiles.moveStandaloneTile', { sheetId: sheet.id, tileId: from.id, dx, dy });
    return;
  }
  if (d.kind === 'gridresize') {
    if (d.count === d.count0) return;
    if (d.grid) dispatch('tiles.resizeGridAxis', { sheetId: sheet.id, gridId: d.grid.id, axis: d.axis, side: d.side, count: d.count });
    else dispatch('tiles.growTileIntoGrid', { sheetId: sheet.id, tileId: d.tile.id, axis: d.axis, side: d.side, count: d.count });
    return;
  }
}

// ------------------------------------------------------------- overlay

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

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

function drawTileGrips(ctx, grips) {
  ctx.save();
  ctx.fillStyle = TILE_HANDLE;
  ctx.globalAlpha = 0.7;
  for (const g of grips) ctx.fillRect(g.x, g.y, g.w, g.h);
  ctx.restore();
}

function drawGridDims(ctx, view, grid, opts = {}) {
  const dx = opts.dx ?? 0, dy = opts.dy ?? 0;
  const shifted = (dx || dy) ? { ...grid, x: grid.x + dx, y: grid.y + dy } : grid;
  const alpha = opts.quiet ? 0.7 : 1;
  const last = gridCellRect(shifted, grid.cols - 1, grid.rows - 1);
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
      if (!swapCandidate) {
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
    dispatch('tiles.deleteTile', { sheetId: sheet.id, tileId: state.selectedTileId });
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
