import { HANDLES_CORNER } from '../../../../core/resizeAnchor.js';

export function tileAt(sheet, x, y) {
  for (let i = sheet.tiles.length - 1; i >= 0; i--) {
    const t = sheet.tiles[i];
    if (x >= t.x && y >= t.y && x < t.x + t.w && y < t.y + t.h) return t;
  }
  return null;
}

export const HANDLE_SCREEN_PX = 6;
export const GRID_HANDLE_SCREEN_PX = 6;

// Resize handles only ever apply to a STANDALONE (gridId == null) selected
// tile -- a grid-owned tile's size is controlled by its grid's cellW/cellH.
export function hitHandle(view, tile, sx, sy) {
  if (!tile || tile.gridId != null) return null;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? tile.x : tile.x + tile.w;
    const iy = h[0] === 'n' ? tile.y : tile.y + tile.h;
    const p = view.imageToScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}

// A grid's own drag handle sits at its origin corner -- dragging an owned
// TILE is reserved for the swap/move interaction, so moving the whole grid
// needs a separate, always-visible affordance.
export function hitGridHandle(view, sheet, sx, sy) {
  for (const g of sheet.tileGrids) {
    const p = view.imageToScreen(g.x, g.y);
    if (Math.abs(sx - p.x) <= GRID_HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= GRID_HANDLE_SCREEN_PX) return g;
  }
  return null;
}

// Outer bounding box of everything a grid owns, in sheet-space.
export function gridBounds(grid) {
  return {
    x: grid.x, y: grid.y,
    w: grid.cols * (grid.cellW + grid.spacingX) - grid.spacingX,
    h: grid.rows * (grid.cellH + grid.spacingY) - grid.spacingY,
  };
}

// 4 edge-strip hit zones (screen space) around `bounds` (sheet-space
// {x,y,w,h}) -- either a standalone tile's own rect, or a grid's outer
// bounding box. Each strip is inset by a fixed number of screen pixels at
// both ends (matching HANDLE_SCREEN_PX/GRID_HANDLE_SCREEN_PX's 6px corner-
// handle size) rather than spanning the full edge.
const GRIP_INSET_PX = 12;

export function tileGripGeometry(view, bounds) {
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

export function hitTileGrip(grips, sx, sy) {
  for (const g of grips)
    if (sx >= g.x - 2 && sx <= g.x + g.w + 2 && sy >= g.y - 2 && sy <= g.y + g.h + 2)
      return { axis: g.axis, side: g.side };
  return null;
}

// A synthetic grid-shaped object representing the LIVE state of an
// in-progress gridresize drag, for rendering only -- never touches real
// sheet data.
export function ghostGridFor(d) {
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
