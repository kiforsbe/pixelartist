// Tile mode: tile tool (select/swap/move on the atlas), and the tile
// context panel (tile size, tile count, selected-tile name + "Edit tile").
//
// Mirrors frames.js's split: registerTileTool() adds the palette button
// (isAvailable gates it to tile mode, like frametool gates to sprite mode),
// bindTileTool(view) wraps a CanvasView's onPointer/onOverlay the same way
// bindFrameTool does, and mountTilePanel(el) targets the SAME #panel-context
// element frames.js's mountFramesPanel does — see mountFramesPanel's wrap-div
// comment for how the two coexist without clobbering each other.

import { state, on, emit, activeSheet, activeLayer, markDirty, confirmOrAuto, currentContextLayers } from '../../app/state.js';
import { copyRegion, blitRegion, fillRegion, scaleBitmap } from '../../core/pixels.js';
import { makePixelPatch } from '../../core/commands.js';
import { decodePng } from '../../app/pngcodec.js';
import { registerTool } from '../../ui/tools.js';
import { markDefaultAction } from '../../ui/dialogs.js';
import {
  gridCellRect, ownedTiles, relayoutGrid,
  moveGrid, removeTileGrid, createTileGrid, detachTile,
  resizeGridAxis, growTileIntoGrid, collapseGridToTile,
} from '../../core/tilegrids.js';
import { newId } from '../../core/palettes.js';
import { scrubTileReferences } from '../../core/model.js';
import { HANDLES_CORNER, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../core/resizeAnchor.js';
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset, groupCellsByBlobIndex,
  pruneEmptyTerrainSets,
} from '../../core/terrainsets.js';
import {
  NEIGHBOR_BITS, blobIndexToMask, maskToBlobIndex, SIXTEEN_TILE_INDICES, resolveTerrainSlot, classifySlots,
  DIRECTION_OFFSETS, BLOB47_PAINT_CELLS, blobIndexFromPaintMask,
} from '../../core/blob47.js';
import { BLOB47_8X6_RAW, BLOB47_7X7_RAW, BUILTIN_LAYOUT_PRESETS, terrainNeighborPreviewCells } from '../../core/blob47templates.js';
import { drawRectDims, drawChainDims } from '../../ui/dimlabels.js';
import {
  invalidateTileRaster as invalidateFlat,
  getTileSheetCanvas as getFlatCanvas,
  tileThumbnailUrl as tileThumbnailURL,
} from './tile-raster-service.js';

// ------------------------------------------------------------- geometry

// Groups the 47 canonical blob indices by how many of the 8 bits are set
// in their representative mask (the "staircase" layout: isolated alone,
// then single-edge variants, etc, up to the full 8-neighbor surround).
function blobStaircaseGroups() {
  const groups = new Map();
  blobIndexToMask.forEach((mask, blobIndex) => {
    let count = 0;
    for (let b = 1; b <= 128; b <<= 1) if (mask & b) count++;
    if (!groups.has(count)) groups.set(count, []);
    groups.get(count).push(blobIndex);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, indices]) => indices);
}

// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid8x6' | 'grid7x7' | 'sixteen'. Keyed per terrain set
// (not a single shared variable) so switching between two terrain sets
// doesn't leak one's view-mode choice into the other; transient, not
// persisted/exported -- purely a UI nicety, seeded at creation time by
// commitAddTerrainSet's caller (see buildAddTerrainSetDialog) to match
// whichever built-in preset was used.
const terrainSetViewModes = new Map();
function viewModeFor(terrainSetId) {
  return terrainSetViewModes.get(terrainSetId) ?? 'staircase';
}

// Mirrors the real reference template's row/col arrangement (not an
// arbitrary ascending-index chunking) so this cosmetic view is a 1:1
// visual match for the actual tilemap when that built-in preset was used
// to fill the slots -- including duplicate cells (e.g. the 7x7 template's
// three "isolated" corners), which render as separate cells for the same
// underlying slot, exactly as they appear in the source tilemap.
function gridFromRawTemplate(rawGrid) {
  return rawGrid.map(rowVals => rowVals.map(raw => maskToBlobIndex[raw]));
}

function slotGroupsForViewMode(mode) {
  if (mode === 'grid8x6') return gridFromRawTemplate(BLOB47_8X6_RAW);
  if (mode === 'grid7x7') return gridFromRawTemplate(BLOB47_7X7_RAW);
  if (mode === 'sixteen') return [[...SIXTEEN_TILE_INDICES].sort((a, b) => a - b)];
  return blobStaircaseGroups();
}

function describeMask(mask) {
  const names = { [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE', [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE', [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW', [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW' };
  const parts = Object.keys(names).filter(b => mask & Number(b)).map(b => names[b]);
  return parts.length ? parts.join(' + ') : 'isolated';
}

// See js/core/blob47templates.js for the raw grids, the built-in preset
// list, and how they're pixel-verified against the bundled reference
// images at assets/blob47-templates/.

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
        created = { id: newId('ti'), x: rect.x, y: rect.y, w: rect.w, h: rect.h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined };
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
// — shrink the grid, or detach first). A standalone tile CAN belong to a
// terrain set (assigned via the slot editor's tile picker), so this mirrors
// commitDeleteGrid's pruning: if this was the last tile referencing its
// terrain set, that set is deleted too.
function deleteTile(sheet, tileId) {
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!tile || tile.gridId != null) return;
  const idx = sheet.tiles.indexOf(tile);
  const wasSelected = state.selectedTileId === tileId;
  const candidateTerrainSetId = tile.terrainSetId ?? null;
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  sheet.tiles = sheet.tiles.filter(t => t !== tile);
  scrubTileReferences(sheet, tile.id);
  const prunedIds = candidateTerrainSetId != null ? pruneEmptyTerrainSets(sheet, [candidateTerrainSetId]) : [];
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  if (state.selectedTileId === tile.id) state.selectedTileId = null;
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  state.commands.push({
    label: 'delete tile',
    do() {
      sheet.tiles = afterTiles.slice();
      sheet.terrainSets = afterSets.slice();
      if (state.selectedTileId === tile.id) state.selectedTileId = null;
    },
    undo() {
      sheet.tiles = beforeTiles.slice();
      sheet.terrainSets = beforeSets.slice();
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

function commitGrowTileIntoGrid(sheet, tile, axis, side, count) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const { grid } = growTileIntoGrid(sheet, tile, axis, side, count);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const tileId = tile.id;
  state.commands.push({
    label: 'grow tile into grid',
    do() {
      sheet.tileGrids = afterGrids.slice();
      sheet.tiles = afterTiles.slice();
      state.selectedTileId = tileId;
    },
    undo() {
      sheet.tileGrids = beforeGrids.slice();
      sheet.tiles = beforeTiles.slice();
      state.selectedTileId = tileId;
    },
  });
  markDirty();
  emit('selection');
}

function commitResizeGridAxis(sheet, grid, axis, side, count) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  resizeGridAxis(sheet, grid, axis, side, count);
  let survivorId = null;
  if (grid.cols === 1 && grid.rows === 1) {
    survivorId = collapseGridToTile(sheet, grid).id;
  }
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'resize grid',
    do() {
      sheet.tileGrids = afterGrids.slice();
      sheet.tiles = afterTiles.slice();
      if (survivorId) state.selectedTileId = survivorId;
    },
    undo() {
      sheet.tileGrids = beforeGrids.slice();
      sheet.tiles = beforeTiles.slice();
    },
  });
  markDirty();
  if (survivorId) emit('selection');
}

function openTileEditor(tileId) {
  state.editingTileId = tileId;
  state.view = 'tile';
  emit('view');
}

function commitAddGrid(sheet, opts) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const created = createTileGrid(sheet, opts);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'add grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
  return created;
}

function commitDeleteGrid(sheet, grid) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  const candidateTerrainSetIds = [...new Set(ownedTiles(sheet, grid.id).map(t => t.terrainSetId).filter((id) => id != null))];
  removeTileGrid(sheet, grid.id);
  const prunedIds = pruneEmptyTerrainSets(sheet, candidateTerrainSetIds);
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  if (state.selectedTileId != null && !sheet.tiles.some(t => t.id === state.selectedTileId)) state.selectedTileId = null;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  state.commands.push({
    label: 'delete grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); sheet.terrainSets = afterSets.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); sheet.terrainSets = beforeSets.slice(); },
  });
  markDirty();
}

// Cell size/spacing edits re-layout every owned tile in place; only their
// geometry needs snapshotting (name/neighbors/gridCol/gridRow are untouched).
function commitGridCellField(sheet, grid, key, value) {
  if (grid[key] === value) return;
  const before = grid[key];
  const beforeRects = ownedTiles(sheet, grid.id).map(t => ({ t, x: t.x, y: t.y, w: t.w, h: t.h }));
  state.commands.push({
    label: `edit grid ${key}`,
    do() { grid[key] = value; relayoutGrid(sheet, grid); },
    undo() {
      grid[key] = before;
      for (const r of beforeRects) { r.t.x = r.x; r.t.y = r.y; r.t.w = r.w; r.t.h = r.h; }
    },
  });
  markDirty();
}

function commitDetachTile(tile) {
  const before = { gridId: tile.gridId, gridCol: tile.gridCol, gridRow: tile.gridRow };
  state.commands.push({
    label: 'detach tile from grid',
    do() { detachTile(tile); },
    undo() { tile.gridId = before.gridId; tile.gridCol = before.gridCol; tile.gridRow = before.gridRow; },
  });
  markDirty();
}

function commitAddTerrainSet(sheet, opts) {
  const before = sheet.terrainSets.slice();
  const created = createTerrainSet(sheet, opts);
  const after = sheet.terrainSets.slice();
  state.commands.push({
    label: 'add terrain set',
    do() { sheet.terrainSets = after.slice(); },
    undo() { sheet.terrainSets = before.slice(); },
  });
  markDirty();
  return created;
}

function commitDeleteTerrainSet(sheet, terrainSetId) {
  const beforeSets = sheet.terrainSets.slice();
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  removeTerrainSet(sheet, terrainSetId);
  const afterSets = sheet.terrainSets.slice();
  state.commands.push({
    label: 'delete terrain set',
    do() {
      sheet.terrainSets = afterSets.slice();
      for (const b of beforeTiles) if (b.terrainSetId === terrainSetId) { b.t.terrainSetId = undefined; b.t.blobIndex = undefined; }
    },
    undo() {
      sheet.terrainSets = beforeSets.slice();
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

function commitRenameTerrainSet(terrainSet, name) {
  const before = terrainSet.name;
  const after = name || before;
  if (before === after) return;
  state.commands.push({
    label: 'rename terrain set',
    do() { terrainSet.name = after; },
    undo() { terrainSet.name = before; },
  });
  markDirty();
}

// Keeps state.selectedTerrainSetId following the selected tile -- there's
// no explicit terrain-set list to click any more (Autotiles panel just
// shows whichever set is "current"), so this is the only way that state
// tracks selection. Any tile selection updates it, INCLUDING clearing it
// back to null (selecting an unrelated standalone/grid tile shouldn't
// leave a stale terrain set showing). Deselecting entirely (tile === null)
// is the one case left untouched: state.selectedTerrainSetId persists so a
// just-created, still-empty terrain set (nothing on the sheet to derive it
// from) stays reachable.
function syncSelectedTerrainSetFromTile(tile) {
  if (tile) state.selectedTerrainSetId = tile.terrainSetId ?? null;
}

// Shared by the Tiles panel's per-tile detail (when the tile belongs to a
// terrain set) and its terrain-set-only fallback card (a just-created set
// with no tiles assigned yet) -- both need the same Name/Layer/Delete
// controls, just reached via a different selection path.
function terrainSetNameField(terrainSet) {
  const field = document.createElement('label');
  field.className = 'frame-field';
  field.appendChild(document.createTextNode('Set name'));
  const input = document.createElement('input');
  input.type = 'text';
  input.value = terrainSet.name;
  input.title = 'Name of the whole terrain set (shared by every tile in it) — separate from this tile\'s own name above';
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v) commitRenameTerrainSet(terrainSet, v);
    else input.value = terrainSet.name;
  });
  field.appendChild(input);
  return field;
}

function terrainSetLayerField(sheet, terrainSet) {
  const field = document.createElement('label');
  field.className = 'frame-field';
  field.appendChild(document.createTextNode('Layer'));
  const select = document.createElement('select');
  const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
  select.appendChild(noneOpt);
  sheet.layers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = terrainSet.layer ?? '';
  select.title = 'Tile Layer for this whole terrain set (shared by every tile in it)';
  select.addEventListener('change', () => commitSetTerrainSetLayer(terrainSet, select.value));
  field.appendChild(select);
  return field;
}

function btnDeleteTerrainSet(sheet, terrainSet) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-icon-md';
  btn.textContent = '✕';
  btn.title = 'Delete terrain set';
  btn.addEventListener('click', () => {
    commitDeleteTerrainSet(sheet, terrainSet.id);
    if (state.selectedTerrainSetId === terrainSet.id) state.selectedTerrainSetId = null;
  });
  return btn;
}

function commitAssignSlot(sheet, terrainSet, blobIndex, tile) {
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  const beforeSlots = { ...terrainSet.slots };
  assignSlot(sheet, terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  const afterTileState = { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  state.commands.push({
    label: 'assign terrain slot',
    do() {
      terrainSet.slots = { ...afterSlots };
      tile.terrainSetId = afterTileState.terrainSetId;
      tile.blobIndex = afterTileState.blobIndex;
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

function commitClearSlot(terrainSet, blobIndex, tile) {
  const beforeSlots = { ...terrainSet.slots };
  const before = { terrainSetId: tile?.terrainSetId, blobIndex: tile?.blobIndex };
  clearSlot(terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  state.commands.push({
    label: 'clear terrain slot',
    do() {
      terrainSet.slots = { ...afterSlots };
      if (tile) { tile.terrainSetId = undefined; tile.blobIndex = undefined; }
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      if (tile) { tile.terrainSetId = before.terrainSetId; tile.blobIndex = before.blobIndex; }
    },
  });
  markDirty();
}

function commitSetSymmetry(terrainSet, key, value) {
  if (terrainSet.symmetry[key] === value) return;
  const before = terrainSet.symmetry[key];
  state.commands.push({
    label: `set terrain symmetry ${key}`,
    do() { terrainSet.symmetry[key] = value; },
    undo() { terrainSet.symmetry[key] = before; },
  });
  markDirty();
}

function commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols) {
  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols);
  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  state.commands.push({
    label: 'import terrain layout',
    do() {
      terrainSet.slots = { ...afterSlots };
      sheet.tiles.forEach((t, i) => { t.terrainSetId = afterTiles[i].terrainSetId; t.blobIndex = afterTiles[i].blobIndex; });
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) { b.t.terrainSetId = b.terrainSetId; b.t.blobIndex = b.blobIndex; }
    },
  });
  markDirty();
}

// Paints preset.sourceImage's reference art onto the active paint layer, one
// crop per cell, at the freshly-created sourceTiles' sheet coordinates --
// gives a terrain set real, recognizable slot art immediately instead of
// blank tiles the user has to hand-draw one by one. Only wired into the "Add
// terrain set" creation flow (fresh, definitely-blank tiles); never into
// "import layout" onto an existing grid, which could carry real user art.
async function importPresetArtOntoLayer(sheet, preset, sourceTiles, cols) {
  if (!preset.sourceImage || !sourceTiles.length) return;
  const layer = activeLayer();
  if (!layer) return;

  let refBitmap;
  try {
    const res = await fetch(preset.sourceImage);
    refBitmap = await decodePng(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    console.warn(`Could not import template art from ${preset.sourceImage}: ${e.message}`);
    return;
  }

  const cellSize = preset.sourceCellSize ?? 32;
  const minX = Math.min(...sourceTiles.map(t => t.x));
  const minY = Math.min(...sourceTiles.map(t => t.y));
  const maxX = Math.max(...sourceTiles.map(t => t.x + t.w));
  const maxY = Math.max(...sourceTiles.map(t => t.y + t.h));
  const rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const before = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);

  const alreadyPainted = before.data.some((v, i) => i % 4 === 3 && v !== 0);
  if (alreadyPainted && !confirmOrAuto(
    `"${layer.name}" already has pixels where this grid lands. Overwrite them with the "${preset.name}" reference art?`
  )) return;

  for (const cell of preset.cells) {
    const tile = sourceTiles[cell.row * cols + cell.col];
    if (!tile) continue;
    const cropped = copyRegion(refBitmap, cell.col * cellSize, cell.row * cellSize, cellSize, cellSize);
    const painted = (tile.w === cellSize && tile.h === cellSize) ? cropped : scaleBitmap(cropped, tile.w, tile.h);
    blitRegion(layer.bitmap, painted, tile.x, tile.y);
  }

  const after = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
  state.commands.push(makePixelPatch(layer.bitmap, rect, before, after, 'import terrain layout art'));
  markDirty();
  emit('pixels');
}

function commitAddLayerName(sheet, name) {
  const before = sheet.layers.slice();
  sheet.layers.push(name);
  const after = sheet.layers.slice();
  state.commands.push({
    label: 'add layer name',
    do() { sheet.layers = after.slice(); },
    undo() { sheet.layers = before.slice(); },
  });
  markDirty();
}

function commitRemoveLayerName(sheet, name) {
  const before = sheet.layers.slice();
  const beforeTileLayers = sheet.tiles.map(t => ({ t, layer: t.layer }));
  sheet.layers = sheet.layers.filter(l => l !== name);
  for (const t of sheet.tiles) if (t.layer === name) t.layer = undefined;
  const after = sheet.layers.slice();
  state.commands.push({
    label: 'remove layer name',
    do() {
      sheet.layers = after.slice();
      for (const t of sheet.tiles) if (t.layer === name) t.layer = undefined;
    },
    undo() {
      sheet.layers = before.slice();
      for (const b of beforeTileLayers) b.t.layer = b.layer;
    },
  });
  markDirty();
}

function commitTileLayer(tile, layer) {
  const after = layer || undefined;
  if (tile.layer === after) return;
  const before = tile.layer;
  state.commands.push({
    label: 'set tile layer',
    do() { tile.layer = after; },
    undo() { tile.layer = before; },
  });
  markDirty();
}

function commitSetTerrainSetLayer(terrainSet, layer) {
  const after = layer || null;
  if (terrainSet.layer === after) return;
  const before = terrainSet.layer;
  state.commands.push({
    label: 'set terrain set layer',
    do() { terrainSet.layer = after; },
    undo() { terrainSet.layer = before; },
  });
  markDirty();
}

function commitTileTags(tile, tagsText) {
  const after = tagsText.split(',').map(s => s.trim()).filter(Boolean);
  const before = tile.tags ? [...tile.tags] : undefined;
  const afterVal = after.length ? after : undefined;
  state.commands.push({
    label: 'set tile tags',
    do() { tile.tags = afterVal ? [...afterVal] : undefined; },
    undo() { tile.tags = before ? [...before] : undefined; },
  });
  markDirty();
}

// Singleton-panel UI state (mirrors terrainSetViewModes above): tracks
// whether the tags pill editor's live entry field should reclaim focus
// after the next render. Committing a tag rebuilds the whole Tiles panel
// DOM (same debounced schedule() as every other field here), which would
// otherwise steal focus out of the entry mid-edit.
let tagsFocusPending = false;

// Renders tile.tags as removable pills plus a live entry field that commits
// a new pill on Space/Comma/Enter, on blur (so trailing text isn't lost if
// the user just clicks away), or via Backspace-on-empty (removes the last
// pill). Pasting a comma/space-separated string splits it into multiple
// pills at once. Meant to be appended as its own full-width row (a sibling
// of the W/H/Layer fields grid, not a cell inside it) so pills have room to
// wrap onto multiple lines.
function buildTagsField(tile) {
  const wrap = document.createElement('div');
  wrap.className = 'tag-field';
  const label = document.createElement('span');
  label.className = 'tag-field-label';
  label.textContent = 'Tags';
  const box = document.createElement('div');
  box.className = 'tag-input';

  const tags = (tile.tags ?? []).slice();
  const commit = (next) => { tagsFocusPending = true; commitTileTags(tile, next.join(',')); };

  const entry = document.createElement('input');
  entry.type = 'text';
  entry.className = 'tag-entry';
  entry.placeholder = tags.length ? '' : 'add tag…';

  tags.forEach((tag, i) => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.appendChild(document.createTextNode(tag));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = `Remove "${tag}"`;
    remove.addEventListener('click', (e) => { e.stopPropagation(); commit(tags.filter((_, j) => j !== i)); });
    pill.appendChild(remove);
    box.appendChild(pill);
  });

  function addFromEntry() {
    const parts = entry.value.split(/[, ]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    // Cleared BEFORE commit: render() rebuilds this whole panel (wiping
    // this now-stale entry out of the DOM), which fires a native blur on
    // it since it's still focused -- the blur handler below re-reads
    // entry.value, so a leftover value here would resubmit itself as a
    // duplicate commit.
    entry.value = '';
    commit([...tags, ...parts]);
  }

  entry.addEventListener('keydown', (e) => {
    if (e.key === ',' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); addFromEntry(); }
    else if (e.key === 'Backspace' && entry.value === '' && tags.length) commit(tags.slice(0, -1));
  });
  entry.addEventListener('blur', () => { if (entry.value.trim()) addFromEntry(); });
  entry.addEventListener('paste', (e) => {
    e.preventDefault();
    entry.value += (e.clipboardData ?? window.clipboardData).getData('text');
    addFromEntry();
  });
  box.addEventListener('click', (e) => { if (e.target === box) entry.focus(); });

  box.appendChild(entry);
  wrap.append(label, box);
  if (tagsFocusPending) { tagsFocusPending = false; queueMicrotask(() => entry.focus()); }
  return wrap;
}

function commitTileName(tile, name) {
  const before = tile.name;
  const after = name || undefined;
  if (before === after) return;
  state.commands.push({
    label: 'rename tile',
    do() { tile.name = after; },
    undo() { tile.name = before; },
  });
  markDirty();
}

function commitTileSize(sheet, tile, key, value) {
  if (tile[key] === value) return;
  const before = { size: tile[key], terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  state.commands.push({
    label: `edit tile ${key}`,
    do() {
      tile[key] = value;
      detachFromTerrainSetIfMismatched(sheet, tile);
    },
    undo() {
      tile[key] = before.size;
      tile.terrainSetId = before.terrainSetId;
      tile.blobIndex = before.blobIndex;
    },
  });
  markDirty();
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

  on('project', () => { if (drag) { drag = null; lastClick = null; view.requestRender(); } });
  on('tool', () => { if (state.tool !== 'tiletool' && drag) { drag = null; view.requestRender(); } });
}

// ------------------------------------------------------------- autotile paint
//
// A Tiled-style terrain editor paints the meaningful Wang positions directly
// over tileset art. Blob-47 is the binary, reduced version of that model, so
// this keeps only one paint color (terrain) plus erase, then derives the
// canonical slot at the end of each pointer stroke.
let autotilePaint = null; // { terrainSetId, brush: 'paint'|'erase', stroke, conflicts:Map<tileId,blobIndex>, hover }

function terrainPaintGrid(sheet, terrainSet) {
  if (!terrainSet || sheet.width % terrainSet.tileW || sheet.height % terrainSet.tileH) return null;
  return { cols: sheet.width / terrainSet.tileW, rows: sheet.height / terrainSet.tileH };
}

function standalonePaintTile(x, y, w, h) {
  return {
    id: newId('ti'), x, y, w, h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined,
    neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined,
    duplicateOf: undefined,
  };
}

// Prepare a neat full-sheet lattice without ever creating a Tile Grid. A
// pre-existing tile is safe to reuse only when it exactly matches one cell;
// anything spanning cells would make a direct paint target ambiguous.
function prepareTerrainPaint(sheet, terrainSet) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid) return { error: `Sheet size must be divisible by ${terrainSet.tileW}×${terrainSet.tileH}.` };
  const expected = new Map();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const x = col * terrainSet.tileW, y = row * terrainSet.tileH;
    expected.set(`${x},${y}`, { x, y, w: terrainSet.tileW, h: terrainSet.tileH });
  }
  for (const tile of sheet.tiles) {
    const e = expected.get(`${tile.x},${tile.y}`);
    if (!e || tile.gridId != null || tile.w !== e.w || tile.h !== e.h) {
      return { error: 'Existing tiles must align exactly to the terrain size before terrain painting can start.' };
    }
    if (sheet.tiles.filter(t => t.x === tile.x && t.y === tile.y && t.w === tile.w && t.h === tile.h).length > 1) {
      return { error: 'Multiple tile records occupy the same terrain cell. Remove the duplicate before terrain painting.' };
    }
  }
  const before = sheet.tiles.slice();
  const after = sheet.tiles.slice();
  for (const e of expected.values()) {
    if (!after.some(t => t.x === e.x && t.y === e.y && t.w === e.w && t.h === e.h)) after.push(standalonePaintTile(e.x, e.y, e.w, e.h));
  }
  if (after.length !== before.length) {
    state.commands.push({
      label: 'create terrain paint cells',
      do() { sheet.tiles = after.slice(); markDirty(); },
      undo() { sheet.tiles = before.slice(); markDirty(); },
    });
  }
  return { grid };
}

function paintTileAt(sheet, terrainSet, x, y) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid || x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return null;
  const col = Math.floor(x / terrainSet.tileW), row = Math.floor(y / terrainSet.tileH);
  const tx = col * terrainSet.tileW, ty = row * terrainSet.tileH;
  return sheet.tiles.find(t => t.x === tx && t.y === ty && t.w === terrainSet.tileW && t.h === terrainSet.tileH) ?? null;
}

function paintCellAt(tile, x, y) {
  const col = Math.min(2, Math.floor(((x - tile.x) * 3) / tile.w));
  const row = Math.min(2, Math.floor(((y - tile.y) * 3) / tile.h));
  return BLOB47_PAINT_CELLS.find(c => c.col === col && c.row === row) ?? null;
}

function persistedPaintMask(tile, terrainSet) {
  return tile?.terrainSetId === terrainSet.id && tile.blobIndex != null ? blobIndexToMask[tile.blobIndex] : 0;
}

function strokePaintMask(tile, terrainSet) {
  return autotilePaint?.stroke?.masks.get(tile.id) ?? persistedPaintMask(tile, terrainSet);
}

function beginTerrainPaintStroke(ev, view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  if (!sheet || !terrainSet) return;
  // Secondary-button drags always erase, independent of the selected brush.
  autotilePaint.stroke = { masks: new Map(), seen: new Set(), brush: (ev.buttons & 2) ? 'erase' : autotilePaint.brush };
  applyTerrainPaintPoint(ev, view);
}

function applyTerrainPaintPoint(ev, view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke) return;
  const tile = paintTileAt(sheet, terrainSet, ev.x, ev.y);
  const cell = tile && paintCellAt(tile, ev.x, ev.y);
  autotilePaint.hover = tile && cell ? { tileId: tile.id, bit: cell.bit } : null;
  if (tile && cell) autotilePaint.previewTileId = tile.id;
  if (!tile || !cell) return;
  const key = `${tile.id}:${cell.bit}`;
  if (stroke.seen.has(key)) return;
  stroke.seen.add(key);
  const mask = strokePaintMask(tile, terrainSet);
  stroke.masks.set(tile.id, stroke.brush === 'erase' ? (mask & ~cell.bit) : (mask | cell.bit));
  view.requestRender();
}

function commitTerrainPaintStroke(view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke?.masks.size) { if (autotilePaint) autotilePaint.stroke = null; return; }
  const beforeSlots = { ...terrainSet.slots };
  const afterSlots = { ...beforeSlots };
  const beforeTiles = new Map();
  const afterTiles = new Map();
  const candidates = [];
  const conflicts = new Map();
  for (const [tileId, mask] of stroke.masks) {
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile || (tile.terrainSetId != null && tile.terrainSetId !== terrainSet.id)) continue;
    beforeTiles.set(tileId, { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex, duplicateOf: tile.duplicateOf });
    for (const idx of Object.keys(afterSlots)) if (afterSlots[idx] === tileId) delete afterSlots[idx];
    candidates.push({ tile, blobIndex: blobIndexFromPaintMask(mask) });
  }
  for (const candidate of candidates) {
    const owner = afterSlots[candidate.blobIndex];
    if (owner != null && owner !== candidate.tile.id) { conflicts.set(candidate.tile.id, candidate.blobIndex); continue; }
    afterSlots[candidate.blobIndex] = candidate.tile.id;
    afterTiles.set(candidate.tile.id, { terrainSetId: terrainSet.id, blobIndex: candidate.blobIndex, duplicateOf: undefined });
  }
  // A conflicted tile was removed from the working slots above only if it had
  // moved. Restore it exactly, and do not create a history command if every
  // changed cell was blocked by a duplicate/other terrain set.
  for (const candidate of candidates) if (conflicts.has(candidate.tile.id)) {
    const before = beforeTiles.get(candidate.tile.id);
    if (before?.terrainSetId === terrainSet.id && before.blobIndex != null) afterSlots[before.blobIndex] = candidate.tile.id;
  }
  if (afterTiles.size) {
    state.commands.push({
      label: 'paint autotile terrain',
      do() {
        terrainSet.slots = { ...afterSlots };
        for (const [id, next] of afterTiles) Object.assign(sheet.tiles.find(t => t.id === id), next);
        markDirty();
      },
      undo() {
        terrainSet.slots = { ...beforeSlots };
        for (const [id, prev] of beforeTiles) Object.assign(sheet.tiles.find(t => t.id === id), prev);
        markDirty();
      },
    });
  }
  autotilePaint.conflicts = conflicts;
  autotilePaint.stroke = null;
  refreshBlob47Coverage?.();
  view.requestRender();
}

function drawAutotilePaintOverlay(ctx, view) {
  if (!autotilePaint || state.tool !== 'autotilepaint' || state.mode !== 'tiles') return;
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
  const grid = sheet && terrainSet && terrainPaintGrid(sheet, terrainSet);
  if (!sheet || !terrainSet || !grid) return;
  ctx.save();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const tile = paintTileAt(sheet, terrainSet, col * terrainSet.tileW, row * terrainSet.tileH);
    if (!tile) continue;
    const mask = strokePaintMask(tile, terrainSet);
    const p0 = view.imageToScreen(tile.x, tile.y), p1 = view.imageToScreen(tile.x + tile.w, tile.y + tile.h);
    const cw = (p1.x - p0.x) / 3, ch = (p1.y - p0.y) / 3;
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    ctx.strokeRect(p0.x + .5, p0.y + .5, p1.x - p0.x - 1, p1.y - p0.y - 1);
    for (const cell of BLOB47_PAINT_CELLS) if (mask & cell.bit) {
      ctx.fillStyle = 'rgba(74, 201, 122, .45)';
      ctx.fillRect(p0.x + cell.col * cw + 1, p0.y + cell.row * ch + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
    }
    if (autotilePaint.conflicts?.has(tile.id)) {
      ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 2;
      ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    }
    if (autotilePaint.hover?.tileId === tile.id) {
      const hover = BLOB47_PAINT_CELLS.find(c => c.bit === autotilePaint.hover.bit);
      if (hover) {
        ctx.strokeStyle = (autotilePaint.stroke?.brush ?? autotilePaint.brush) === 'erase' ? '#ef5350' : '#72d995'; ctx.lineWidth = 2;
        ctx.strokeRect(p0.x + hover.col * cw + 1, p0.y + hover.row * ch + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
      }
    }
  }
  drawAutotilePaintPreview(ctx, view, sheet, terrainSet);
  ctx.restore();
}

// A concrete 3x3 result preview is much easier to reason about than eight
// green metadata cells. It renders the hovered tile at the center and the
// actual resolved neighbor artwork around it, using the tentative stroke mask
// when a drag is currently in progress.
function drawAutotilePaintPreview(ctx, view, sheet, terrainSet) {
  const hoverId = autotilePaint?.hover?.tileId ?? autotilePaint?.previewTileId;
  const tile = hoverId ? sheet.tiles.find(t => t.id === hoverId) : null;
  if (!tile) return;
  const mask = strokePaintMask(tile, terrainSet);
  const blobIndex = blobIndexFromPaintMask(mask);
  // This is the comparison view the painter relies on, so give the artwork
  // room to be read rather than treating it like a small tooltip.  On small
  // canvases it still scales down enough to leave the sheet usable.
  const cellSize = Math.max(28, Math.min(108, Math.floor(Math.min(view.cssWidth, view.cssHeight) / 4.5)));
  const size = cellSize * 3;
  const x = Math.max(8, view.cssWidth - size - 10), y = 10;
  const flat = getFlatCanvas(sheet);
  const draw = (source, dx, dy, { flipH = false, flipV = false, rotate = 0 } = {}) => {
    if (!source) return;
    ctx.save();
    ctx.translate(x + dx * cellSize, y + dy * cellSize);
    ctx.translate(flipH ? cellSize : 0, flipV ? cellSize : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (rotate) {
      ctx.translate(cellSize / 2, cellSize / 2);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(-cellSize / 2, -cellSize / 2);
    }
    ctx.drawImage(flat, source.x, source.y, source.w, source.h, 0, 0, cellSize, cellSize);
    ctx.restore();
  };
  const candidate = { ...tile, blobIndex };
  const neighbors = terrainNeighborPreviewCells(candidate, terrainSet);
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,18,.9)';
  ctx.fillRect(x - 3, y - 20, size + 6, size + 24);
  ctx.strokeStyle = '#8bd6ff'; ctx.lineWidth = 1;
  ctx.strokeRect(x - .5, y - .5, size + 1, size + 1);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.fillText(`Preview · ${describeMask(blobIndexToMask[blobIndex])}`, x, y - 17);
  for (const cell of neighbors) {
    const source = cell.tileId ? sheet.tiles.find(t => t.id === cell.tileId) : null;
    draw(source, cell.dx + 1, cell.dy + 1, cell);
  }
  draw(tile, 1, 1);
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(x + i * cellSize, y); ctx.lineTo(x + i * cellSize, y + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + i * cellSize); ctx.lineTo(x + size, y + i * cellSize); ctx.stroke();
  }
  ctx.strokeStyle = '#8bd6ff'; ctx.lineWidth = 2;
  ctx.strokeRect(x + cellSize + 1, y + cellSize + 1, cellSize - 2, cellSize - 2);
  drawBlob47Reference(ctx, view, sheet, terrainSet, blobIndex);
  ctx.restore();
}

let blob47ReferenceImage = null;
function getBlob47ReferenceImage() {
  if (blob47ReferenceImage) return blob47ReferenceImage;
  const image = new Image();
  image.onload = () => emit('view'); // repaint the canvas once the artwork is ready
  image.src = 'assets/blob47-templates/blob47-8x6-reference.png';
  blob47ReferenceImage = image;
  return image;
}

let blob47CoverageDialog = null;
let refreshBlob47Coverage = null;
// Large, inspectable reference board: each card places the expected Blob-47
// artwork above the terrain set's actual assigned tile. Missing patterns are
// intentionally loud instead of silently appearing as empty slots.
function openBlob47Coverage(sheet, terrainSet) {
  if (!blob47CoverageDialog) {
    blob47CoverageDialog = document.createElement('dialog');
    document.body.appendChild(blob47CoverageDialog);
  }
  const dialog = blob47CoverageDialog;
  const render = () => {
    dialog.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = `${terrainSet.name} · Blob-47 coverage`;
    const help = document.createElement('p');
    help.textContent = 'Top: expected Blob-47 reference artwork. Bottom: your assigned tile. Red cards are missing.';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,72px);gap:6px;max-height:72vh;overflow:auto;padding:4px;';
    const flat = getFlatCanvas(sheet);
    const reference = getBlob47ReferenceImage();
    for (let row = 0; row < BLOB47_8X6_RAW.length; row++) for (let col = 0; col < BLOB47_8X6_RAW[row].length; col++) {
      const rawMask = BLOB47_8X6_RAW[row][col];
      const blobIndex = blobIndexFromPaintMask(rawMask);
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const source = resolved ? sheet.tiles.find(t => t.id === resolved.tileId) : null;
      const card = document.createElement('div');
      card.style.cssText = `border:2px solid ${source ? '#4f8cff' : '#ef5350'};background:${source ? '#171a22' : '#3d1619'};padding:2px;`;
      card.title = `${describeMask(blobIndexToMask[blobIndex])}${source ? ` — tile #${sheet.tiles.indexOf(source)}${resolved.rotate || resolved.flipH ? ' (derived)' : ''}` : ' — missing'}`;
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 128;
      canvas.style.cssText = 'display:block;width:64px;height:128px;image-rendering:pixelated;';
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      if (reference.complete && reference.naturalWidth) ctx.drawImage(reference, col * 32, row * 32, 32, 32, 0, 0, 64, 64);
      else { ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 64, 64); }
      ctx.fillStyle = source ? '#0d1016' : '#5d1c21'; ctx.fillRect(0, 64, 64, 64);
      if (source) {
        ctx.save();
        ctx.translate(0, 64);
        ctx.translate(resolved.flipH ? 64 : 0, resolved.flipV ? 64 : 0);
        ctx.scale(resolved.flipH ? -1 : 1, resolved.flipV ? -1 : 1);
        if (resolved.rotate) {
          ctx.translate(32, 32); ctx.rotate((resolved.rotate * Math.PI) / 180); ctx.translate(-32, -32);
        }
        ctx.drawImage(flat, source.x, source.y, source.w, source.h, 0, 0, 64, 64);
        ctx.restore();
      } else {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('MISSING', 32, 96);
      }
      const label = document.createElement('div');
      label.style.cssText = `font-size:10px;text-align:center;color:${source ? '#d6d7dc' : '#ffb4b4'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      label.textContent = source ? `#${sheet.tiles.indexOf(source)}` : 'MISSING';
      card.append(canvas, label); grid.appendChild(card);
    }
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
    dialog.append(title, help, grid, close);
  };
  refreshBlob47Coverage = () => {
    if (dialog.open) render();
  };
  dialog.onclose = () => { refreshBlob47Coverage = null; };
  render();
  const reference = getBlob47ReferenceImage();
  if (!reference.complete) reference.addEventListener('load', render, { once: true });
  if (!dialog.open) dialog.showModal();
}

// This is the real, bundled Blob-47 reference art rather than another
// symbolic mask diagram. It stays large enough to compare an artwork tile
// directly against the exact target shape it is being assigned to.
function drawBlob47Reference(ctx, view, sheet, terrainSet, selectedBlobIndex) {
  // Keep the complete reference visible on-canvas, but make each source tile
  // genuinely inspectable. The previous 32px cap made the 47-tile board read
  // more like an icon than a visual comparison aid.
  const cellSize = Math.max(20, Math.min(48,
    Math.floor((view.cssWidth - 20) / 8), Math.floor((view.cssHeight - 42) / 6)));
  const width = cellSize * 8, height = cellSize * 6;
  const x = 10, y = Math.max(26, view.cssHeight - height - 10);
  const image = getBlob47ReferenceImage();
  const flat = getFlatCanvas(sheet);
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,18,.9)';
  ctx.fillRect(x - 3, y - 18, width + 6, height + 22);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.fillText('Blob-47 artwork reference · blue = this tile', x, y - 15);
  if (image.complete && image.naturalWidth) ctx.drawImage(image, x, y, width, height);
  for (let row = 0; row < BLOB47_8X6_RAW.length; row++) {
    for (let col = 0; col < BLOB47_8X6_RAW[row].length; col++) {
      const rawMask = BLOB47_8X6_RAW[row][col];
      const blobIndex = blobIndexFromPaintMask(rawMask);
      const px = x + col * cellSize, py = y + row * cellSize;
      // Read the current, painted tilesheet records first. This is the live
      // artwork being edited; `slots` is only retained as a compatibility
      // fallback for older terrain sets.
      const paintedTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id && t.blobIndex === blobIndex && !t.duplicateOf);
      drawBlob47AssignedTileOverlay(ctx, flat, sheet, paintedTile?.id ?? terrainSet.slots?.[blobIndex], px, py, cellSize);
      drawBlob47PaintMarks(ctx, px, py, cellSize, blobIndexToMask[blobIndex]);
      ctx.strokeStyle = blobIndex === selectedBlobIndex ? '#28b9ff' : 'rgba(255,255,255,.22)';
      ctx.lineWidth = blobIndex === selectedBlobIndex ? 3 : 1;
      ctx.strokeRect(px + .5, py + .5, cellSize - 1, cellSize - 1);
    }
  }
  ctx.restore();
}

// Only show explicitly assigned slots here. Derived symmetry variants remain
// absent, which lets the board distinguish artwork the user has selected from
// shapes the editor can infer automatically.
function drawBlob47AssignedTileOverlay(ctx, flat, sheet, tileId, x, y, size) {
  const tile = tileId ? sheet.tiles.find(t => t.id === tileId) : null;
  if (!tile) return;
  ctx.save();
  ctx.globalAlpha = .67;
  ctx.translate(x, y);
  ctx.drawImage(flat, tile.x, tile.y, tile.w, tile.h, 0, 0, size, size);
  ctx.restore();
}

// Use exactly the painter's eight regions to annotate every example in the
// reference board. This makes the reference artwork a visual answer to
// "which parts should I paint for this tile?" rather than a second diagram
// the user has to translate mentally.
function drawBlob47PaintMarks(ctx, x, y, size, mask) {
  const unit = size / 3;
  for (const cell of BLOB47_PAINT_CELLS) {
    if (!(mask & cell.bit)) continue;
    const px = x + cell.col * unit, py = y + cell.row * unit;
    ctx.fillStyle = 'rgba(238, 82, 82, .5)';
    ctx.fillRect(px + 1, py + 1, Math.max(1, unit - 2), Math.max(1, unit - 2));
    ctx.strokeStyle = 'rgba(255, 222, 222, .5)'; ctx.lineWidth = 1;
    ctx.strokeRect(px + .5, py + .5, Math.max(0, unit - 1), Math.max(0, unit - 1));
  }
}

export function registerAutotilePaintTool() {
  registerTool({ id: 'autotilepaint', icon: '🧩', label: 'Autotile paint', key: 'a', isAvailable: () => state.mode === 'tiles' && !!autotilePaint });
}

export function bindAutotilePaintTool(view) {
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'tiles' && state.tool === 'autotilepaint' && autotilePaint) {
      if (ev.type === 'down') beginTerrainPaintStroke(ev, view);
      else if (ev.type === 'move') {
        if (autotilePaint.stroke) applyTerrainPaintPoint(ev, view);
        else {
          const sheet = activeSheet();
          const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
          const tile = sheet && terrainSet && paintTileAt(sheet, terrainSet, ev.x, ev.y);
          const cell = tile && paintCellAt(tile, ev.x, ev.y);
          autotilePaint.hover = tile && cell ? { tileId: tile.id, bit: cell.bit } : null;
          if (tile && cell) autotilePaint.previewTileId = tile.id;
          view.requestRender();
        }
      }
      else if (ev.type === 'up') commitTerrainPaintStroke(view);
      return;
    }
    prevPointer(ev);
  };
  const prevOverlay = view.onOverlay;
  view.onOverlay = (ctx) => { prevOverlay(ctx); drawAutotilePaintOverlay(ctx, view); };
  on('tool', () => { if (state.tool !== 'autotilepaint' && autotilePaint?.stroke) autotilePaint.stroke = null; });
}

// ------------------------------------------------------------- terrain sets

// Same "first cell in raster order wins" rule as applyLayoutPreset (shared
// via groupCellsByBlobIndex) -- draws the preset's reference art, then
// flags every non-primary duplicate cell with the same dashed-orange
// treatment js/ui/overlays.js uses on the tile sheet itself, so the user
// can see which cells will become dead-end duplicates BEFORE creating the
// grid, not just after.
//
// previewGeneration guards against a stale image load finishing after a
// newer preset was already selected (switching the <select> quickly starts
// a fresh Image() before the previous one's onload has fired) -- without
// it, the old image can paint over the new one, or at the wrong size.
let previewGeneration = 0;
function drawLayoutPreview(canvas, preset) {
  const myGeneration = ++previewGeneration;
  const cellSize = preset.sourceCellSize ?? 32;
  canvas.width = preset.cols * cellSize;
  canvas.height = preset.rows * cellSize;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const duplicateCells = [];
  for (const cells of groupCellsByBlobIndex(preset.cells).values()) {
    for (let i = 1; i < cells.length; i++) duplicateCells.push(cells[i]);
  }

  const img = new Image();
  img.onload = () => {
    if (myGeneration !== previewGeneration) return; // superseded by a later preset selection
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (!duplicateCells.length) return;
    ctx.save();
    ctx.strokeStyle = '#e0a030';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    for (const cell of duplicateCells) {
      const x = cell.col * cellSize, y = cell.row * cellSize;
      ctx.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      const label = 'dup';
      const w = Math.ceil(ctx.measureText(label).width) + 4;
      ctx.fillStyle = 'rgba(90,58,0,.85)';
      ctx.fillRect(x, y, w, 11);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 2, y + 1);
    }
    ctx.restore();
  };
  img.src = preset.sourceImage;
}

function buildAddTerrainSetDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add terrain set</h3>
    <div class="row"><label>Name <input type="text" id="ats-name" value="Terrain"></label></div>
    <div class="row"><label>Tile W <input type="number" id="ats-tilew" min="1" value="16"></label></div>
    <div class="row"><label>Tile H <input type="number" id="ats-tileh" min="1" value="16"></label></div>
    <div class="row"><label>Layout <select id="ats-layout"><option value="">(none -- add tiles manually)</option></select></label></div>
    <div class="row"><canvas id="ats-layout-preview" class="terrain-layout-preview" hidden></canvas></div>
    <div class="row dlg-actions"><button type="button" id="ats-create">Create</button><button type="button" id="ats-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let presets = [];
  const updatePreview = () => {
    const preset = presets[Number($('#ats-layout').value)];
    const canvas = $('#ats-layout-preview');
    if (preset?.sourceImage) { canvas.hidden = false; drawLayoutPreview(canvas, preset); }
    else { canvas.hidden = true; }
  };
  $('#ats-layout').addEventListener('change', updatePreview);
  markDefaultAction(dlg, $('#ats-create'));
  $('#ats-cancel').addEventListener('click', () => dlg.close());
  $('#ats-create').addEventListener('click', async () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el) => Math.max(1, parseInt(el.value, 10) || 1);
    const tileW = intVal($('#ats-tilew'));
    const tileH = intVal($('#ats-tileh'));
    const terrainSet = commitAddTerrainSet(sheet, {
      name: $('#ats-name').value.trim() || 'Terrain',
      tileW, tileH,
    });
    // No terrain-set list to click any more -- auto-select the new set so
    // the Autotiles panel (and, once a tile exists, the Tiles panel) shows
    // it immediately instead of whatever was selected before.
    state.selectedTerrainSetId = terrainSet.id;

    const presetValue = $('#ats-layout').value;
    if (presetValue !== '') {
      const preset = presets[Number(presetValue)];
      const { tiles } = commitAddGrid(sheet, { x: 0, y: 0, cellW: tileW, cellH: tileH, cols: preset.cols, rows: preset.rows });
      const sourceTiles = tiles.slice().sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
      commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, preset.cols);
      const seededMode = preset.name.includes('8×6') ? 'grid8x6' : preset.name.includes('7×7') ? 'grid7x7' : null;
      if (seededMode) terrainSetViewModes.set(terrainSet.id, seededMode);
      state.selectedTileId = sourceTiles[0]?.id ?? null;
      await importPresetArtOntoLayer(sheet, preset, sourceTiles, preset.cols);
    } else {
      // No preset -- seed with one standalone (non-grid) tile assigned to
      // the "isolated" slot (blobIndex 0, no neighbors) so the set has at
      // least one referencing tile. A terrain set with zero tiles is what
      // pruneEmptyTerrainSets treats as garbage once any tile/grid deletion
      // elsewhere names it as a candidate.
      commitCreateTile(sheet, { x: 0, y: 0, w: tileW, h: tileH });
      const created = sheet.tiles.find(t => t.id === state.selectedTileId);
      if (created) commitAssignSlot(sheet, terrainSet, 0, created);
    }

    emit('selection');
    dlg.close();
  });
  return {
    open() {
      const sheet = activeSheet();
      const settings = state.project?.settings ?? {};
      $('#ats-tilew').value = String(settings.tileW ?? 16);
      $('#ats-tileh').value = String(settings.tileH ?? 16);

      presets = [...BUILTIN_LAYOUT_PRESETS, ...(sheet?.terrainLayoutPresets ?? [])];
      const layoutSelect = $('#ats-layout');
      layoutSelect.innerHTML = '<option value="">(none -- add tiles manually)</option>';
      presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${p.name} (${p.cols}×${p.rows})`;
        layoutSelect.appendChild(opt);
      });
      updatePreview();

      dlg.showModal();
    },
  };
}

function buildTilePickerDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'tile-picker-dialog';
  dlg.innerHTML = `
    <h3>Assign tile</h3>
    <div class="tile-picker-header">
      <div class="tile-picker-mask-grid" id="tp-mask"></div>
      <div>
        <div id="tp-desc"></div>
        <div id="tp-badge" class="badge"></div>
      </div>
    </div>
    <div class="tile-picker-grid" id="tp-grid"></div>
    <div class="row dlg-actions"><button type="button" id="tp-clear">Clear</button><button type="button" id="tp-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let onPick = null, onClear = null;
  $('#tp-cancel').addEventListener('click', () => dlg.close());
  $('#tp-clear').addEventListener('click', () => { onClear?.(); dlg.close(); });

  function buildMaskDiagram(mask) {
    const grid = document.createElement('div');
    grid.className = 'tile-picker-mask-inner';
    for (let row = -1; row <= 1; row++) {
      for (let col = -1; col <= 1; col++) {
        const div = document.createElement('div');
        div.className = 'tile-picker-mask-cell';
        if (row === 0 && col === 0) {
          div.classList.add('center');
        } else {
          const dir = DIRECTION_OFFSETS.find(d => d.dx === col && d.dy === row);
          if (mask & dir.bit) div.classList.add('filled');
        }
        grid.appendChild(div);
      }
    }
    return grid;
  }

  return {
    open(sheet, terrainSet, blobIndex, currentTileId, pick, clear) {
      onPick = pick; onClear = clear;
      const mask = blobIndexToMask[blobIndex];
      const classInfo = classifySlots(terrainSet.symmetry).get(blobIndex);
      $('#tp-desc').textContent = describeMask(mask);
      $('#tp-badge').textContent = classInfo.mandatory ? 'Mandatory' : 'Optional (derivable via symmetry)';

      const maskHost = $('#tp-mask');
      maskHost.innerHTML = '';
      maskHost.appendChild(buildMaskDiagram(mask));

      const grid = $('#tp-grid');
      grid.innerHTML = '';
      sheet.tiles
        .filter(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH)
        .forEach((t, i) => {
          const cell = document.createElement('div');
          cell.className = 'tile-picker-cell';
          if (t.id === currentTileId) cell.classList.add('selected');
          const thumb = document.createElement('div');
          thumb.className = 'tile-picker-thumb';
          thumb.style.backgroundImage = `url(${tileThumbnailURL(sheet, t)})`;
          const label = document.createElement('span');
          label.textContent = t.name ? `${i}: ${t.name}` : `#${i}`;
          cell.append(thumb, label);
          cell.addEventListener('click', () => { onPick?.(t.id); dlg.close(); });
          grid.appendChild(cell);
        });

      dlg.showModal();
    },
  };
}

function startAutotilePaint(sheet, terrainSet) {
  const prepared = prepareTerrainPaint(sheet, terrainSet);
  if (prepared.error) { alert(prepared.error); return; }
  const initialPreviewTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id)
    ?? sheet.tiles.find(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH);
  autotilePaint = {
    terrainSetId: terrainSet.id, brush: 'paint', stroke: null, conflicts: new Map(), hover: null,
    previewTileId: initialPreviewTile?.id ?? null,
  };
  state.tool = 'autotilepaint';
  emit('tool');
  emit('selection');
  emit('view');
}

function stopAutotilePaint() {
  if (!autotilePaint) return;
  autotilePaint = null;
  if (state.tool === 'autotilepaint') state.tool = 'tiletool';
  emit('tool');
  emit('view');
}

// Conflicts are deliberately non-destructive during a paint stroke. This is
// the explicit escape hatch: replace the old artwork for that Blob-47 shape
// only when the user asks to use the newly painted tile.
function useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex) {
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!tile) return;
  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));
  assignSlot(sheet, terrainSet, blobIndex, tile);
  tile.duplicateOf = undefined;
  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));
  state.commands.push({
    label: 'replace autotile terrain art',
    do() {
      terrainSet.slots = { ...afterSlots };
      sheet.tiles.forEach((t, i) => Object.assign(t, afterTiles[i]));
      markDirty();
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) Object.assign(b.t, {
        terrainSetId: b.terrainSetId, blobIndex: b.blobIndex, duplicateOf: b.duplicateOf,
      });
      markDirty();
    },
  });
  autotilePaint?.conflicts.delete(tileId);
  refreshBlob47Coverage?.();
}

function renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog) {
  container.innerHTML = '';

  const painterRow = document.createElement('div');
  painterRow.className = 'row layer-actions';
  const paintingThisSet = autotilePaint?.terrainSetId === terrainSet.id && state.tool === 'autotilepaint';
  if (!paintingThisSet) {
    const start = document.createElement('button');
    start.type = 'button'; start.className = 'btn-sm'; start.textContent = '🧩 Paint terrain';
    start.title = 'Paint Blob-47 terrain edges and corners directly over the whole tilesheet';
    start.addEventListener('click', () => startAutotilePaint(sheet, terrainSet));
    painterRow.appendChild(start);
  } else {
    const paint = document.createElement('button');
    paint.type = 'button'; paint.className = 'btn-sm'; paint.textContent = 'Paint';
    paint.classList.toggle('active', autotilePaint.brush === 'paint');
    paint.addEventListener('click', () => { autotilePaint.brush = 'paint'; renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog); });
    const erase = document.createElement('button');
    erase.type = 'button'; erase.className = 'btn-sm'; erase.textContent = 'Erase';
    erase.classList.toggle('active', autotilePaint.brush === 'erase');
    erase.addEventListener('click', () => { autotilePaint.brush = 'erase'; renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog); });
    const done = document.createElement('button');
    done.type = 'button'; done.className = 'btn-sm'; done.textContent = 'Done';
    done.addEventListener('click', stopAutotilePaint);
    painterRow.append(paint, erase, done);
    const hint = document.createElement('div');
    hint.className = 'frame-field';
    hint.textContent = 'Drag over tile edges and corners. Green = terrain; red = duplicate pattern conflict. Hover a tile for its resolved preview and the full Blob-47 reference map (blue marks the matching pattern).';
    container.appendChild(hint);
    if (autotilePaint.conflicts.size) {
      const conflicts = document.createElement('div');
      conflicts.className = 'row layer-actions';
      for (const [tileId, blobIndex] of autotilePaint.conflicts) {
        const tileIndex = sheet.tiles.findIndex(t => t.id === tileId);
        const use = document.createElement('button');
        use.type = 'button'; use.className = 'btn-sm'; use.textContent = `Use #${tileIndex}`;
        use.title = `Replace the existing ${describeMask(blobIndexToMask[blobIndex])} tile with this painted tile`;
        use.addEventListener('click', () => {
          useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex);
          renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
        });
        conflicts.appendChild(use);
      }
      container.appendChild(conflicts);
    }
  }
  container.appendChild(painterRow);
  const coverage = document.createElement('button');
  coverage.type = 'button'; coverage.className = 'btn-sm'; coverage.textContent = '🔎 Blob-47 coverage…';
  coverage.title = 'Open a large reference board showing expected artwork, assigned tiles, and missing shapes';
  coverage.addEventListener('click', () => openBlob47Coverage(sheet, terrainSet));
  container.appendChild(coverage);

  const symRow = document.createElement('div');
  symRow.className = 'row layer-actions';
  const btnFlip = document.createElement('button');
  btnFlip.type = 'button';
  btnFlip.className = 'btn-icon-sm';
  btnFlip.textContent = '↔';
  btnFlip.title = 'Allow flip (derive flipped slots from their mirror instead of requiring explicit art)';
  btnFlip.setAttribute('aria-pressed', String(terrainSet.symmetry.flip));
  btnFlip.classList.toggle('active', terrainSet.symmetry.flip);
  btnFlip.addEventListener('click', () => commitSetSymmetry(terrainSet, 'flip', !terrainSet.symmetry.flip));
  const btnRotate = document.createElement('button');
  btnRotate.type = 'button';
  btnRotate.className = 'btn-icon-sm';
  btnRotate.textContent = '↻';
  btnRotate.title = 'Allow rotation (derive rotated slots instead of requiring explicit art)';
  btnRotate.setAttribute('aria-pressed', String(terrainSet.symmetry.rotate));
  btnRotate.classList.toggle('active', terrainSet.symmetry.rotate);
  btnRotate.addEventListener('click', () => commitSetSymmetry(terrainSet, 'rotate', !terrainSet.symmetry.rotate));

  symRow.append(btnFlip, btnRotate);
  container.appendChild(symRow);

  const viewModeRow = document.createElement('div');
  viewModeRow.className = 'row';
  const viewModeSelect = document.createElement('select');
  [
    ['staircase', 'Staircase'],
    ['grid8x6', 'Grid 8×6'],
    ['grid7x7', 'Grid 7×7'],
    ['sixteen', '16-tile only'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    viewModeSelect.appendChild(opt);
  });
  viewModeSelect.value = viewModeFor(terrainSet.id);
  viewModeSelect.addEventListener('change', () => {
    terrainSetViewModes.set(terrainSet.id, viewModeSelect.value);
    renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
  });
  viewModeRow.appendChild(viewModeSelect);
  container.appendChild(viewModeRow);

  const classification = classifySlots(terrainSet.symmetry);
  for (const group of slotGroupsForViewMode(viewModeFor(terrainSet.id))) {
    const groupRow = document.createElement('div');
    groupRow.className = 'terrain-slot-group';
    for (const blobIndex of group) {
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const isExplicit = terrainSet.slots[blobIndex] != null;
      const classInfo = classification.get(blobIndex);
      const cell = document.createElement('div');
      cell.className = 'terrain-slot';
      cell.classList.add(classInfo.mandatory ? 'mandatory' : 'optional');

      const mask = blobIndexToMask[blobIndex];
      let title = `${describeMask(mask)} — ${classInfo.mandatory ? 'mandatory' : 'optional'}`;
      if (resolved && !isExplicit) title += ` (derived: flipH=${resolved.flipH}, rotate=${resolved.rotate})`;

      if (resolved) {
        const tile = sheet.tiles.find(t => t.id === resolved.tileId);
        if (tile) {
          cell.style.backgroundImage = `url(${tileThumbnailURL(sheet, tile, { flipH: resolved.flipH, flipV: resolved.flipV, rotate: resolved.rotate })})`;
          if (!isExplicit) {
            const icons = [];
            if (resolved.flipH) icons.push('↔');
            if (resolved.flipV) icons.push('↕');
            if (resolved.rotate) icons.push('↻');
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = icons.join(' ');
            cell.appendChild(badge);
          }
          // Some layout presets repeat a blobIndex across multiple physical
          // tiles (js/core/terrainsets.js's applyLayoutPreset picks one as
          // primary); those extras carry duplicateOf pointing back at this
          // cell's tile. Flag it here too, not just on the tile sheet, so
          // this thumbnail explains why identical-looking tiles elsewhere
          // don't do anything when painted on.
          const duplicateCount = sheet.tiles.filter(t => t.duplicateOf === tile.id).length;
          if (duplicateCount > 0) {
            cell.classList.add('has-duplicates');
            title += ` — ${duplicateCount} linked duplicate tile(s) elsewhere on the sheet (safe to ignore)`;
            const dupBadge = document.createElement('span');
            dupBadge.className = 'badge duplicate-badge';
            dupBadge.textContent = `⧉${duplicateCount}`;
            cell.appendChild(dupBadge);
          }
          if (classInfo.mandatory === false && isExplicit) {
            cell.classList.add('removable');
            title += ' — optional: derivable via flip/rotation, safe to clear';
            const optBadge = document.createElement('span');
            optBadge.className = 'badge removable-badge';
            optBadge.textContent = '✓opt';
            cell.appendChild(optBadge);
          }
        }
      }
      cell.title = title;

      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, blobIndex, terrainSet.slots[blobIndex] ?? null,
          (tileId) => {
            const tile = sheet.tiles.find(t => t.id === tileId);
            if (tile) commitAssignSlot(sheet, terrainSet, blobIndex, tile);
          },
          () => {
            const owner = sheet.tiles.find(t => t.id === terrainSet.slots[blobIndex]);
            commitClearSlot(terrainSet, blobIndex, owner);
          });
      });
      groupRow.appendChild(cell);
    }
    container.appendChild(groupRow);
  }
}

// ------------------------------------------------------------- tile/grid panel

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

  // Selection detail comes first (mirrors frames.js's mountFramesPanel:
  // list/detail before the creation buttons) — reuses the frame-row/
  // frame-fields/frame-field classes so the two selection-driven panels
  // look and behave the same way.
  const selRow = document.createElement('div');
  selRow.className = 'frame-row tile-selected';
  wrap.appendChild(selRow);

  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.className = 'btn-sm';
  btnAddTerrainSet.textContent = '➕ Autotiles';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });

  const btnRow = document.createElement('div');
  btnRow.className = 'row layer-actions';
  btnRow.append(btnAddTerrainSet);
  wrap.appendChild(btnRow);

  function render() {
    if (state.mode !== 'tiles') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const sheet = activeSheet();
    selRow.innerHTML = '';
    selRow.classList.remove('active');
    if (!sheet) return;

    const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
    if (!tile) {
      // No tile selected -- if a terrain set is still "current" (e.g. just
      // created via Add Terrain Set with no preset, so no tile belongs to
      // it yet to select), show its own compact card instead of the tile
      // detail. Without this, a freshly created empty terrain set would
      // have no reachable naming/delete UI at all.
      const terrainSet = sheet.terrainSets.find(ts => ts.id === state.selectedTerrainSetId);
      if (terrainSet) {
        selRow.classList.add('active');
        const title = document.createElement('div');
        title.className = 'frame-field';
        title.textContent = `Terrain set · ${terrainSet.tileW}×${terrainSet.tileH}`;
        const fields = document.createElement('div');
        fields.className = 'frame-fields';
        fields.append(terrainSetNameField(terrainSet), terrainSetLayerField(sheet, terrainSet));
        const actions = document.createElement('div');
        actions.className = 'row layer-actions';
        actions.appendChild(btnDeleteTerrainSet(sheet, terrainSet));
        selRow.append(title, fields, actions);
        return;
      }
      const hint = document.createElement('span');
      hint.textContent = 'No tile selected';
      selRow.appendChild(hint);
      return;
    }
    selRow.classList.add('active');

    const grid = tile.gridId != null ? sheet.tileGrids.find(g => g.id === tile.gridId) : null;
    const terrainSet = tile.terrainSetId != null ? sheet.terrainSets.find(ts => ts.id === tile.terrainSetId) : null;

    const nameField = document.createElement('label');
    nameField.className = 'frame-field tile-name-field';
    nameField.appendChild(document.createTextNode('Tile name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = tile.name || '';
    nameInput.placeholder = `#${sheet.tiles.indexOf(tile)}`;
    nameInput.title = terrainSet
      ? 'Optional alias for this one tile — tiles are identified by their index (#N) on the sheet when unnamed. Separate from the whole terrain set\'s own "Set name" below.'
      : 'Optional alias for this tile — tiles are identified by their index (#N) on the sheet when unnamed.';
    nameInput.addEventListener('change', () => commitTileName(tile, nameInput.value.trim()));
    nameField.appendChild(nameInput);

    const fields = document.createElement('div');
    fields.className = 'frame-fields';

    if (grid) {
      fields.append(
        sizeField('W', grid.cellW, (v) => commitGridCellField(sheet, grid, 'cellW', v)),
        sizeField('H', grid.cellH, (v) => commitGridCellField(sheet, grid, 'cellH', v)),
      );
    } else {
      fields.append(
        sizeField('W', tile.w, (v) => commitTileSize(sheet, tile, 'w', v)),
        sizeField('H', tile.h, (v) => commitTileSize(sheet, tile, 'h', v)),
      );
    }

    if (terrainSet) {
      fields.append(terrainSetNameField(terrainSet), terrainSetLayerField(sheet, terrainSet));
    } else {
      const layerField = document.createElement('label');
      layerField.className = 'frame-field';
      layerField.appendChild(document.createTextNode('Layer'));
      const layerSelect = document.createElement('select');
      const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
      layerSelect.appendChild(noneOpt);
      sheet.layers.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        layerSelect.appendChild(opt);
      });
      layerSelect.value = tile.layer ?? '';
      layerSelect.title = 'Tile Layer for this tile';
      layerSelect.addEventListener('change', () => commitTileLayer(tile, layerSelect.value));
      layerField.appendChild(layerSelect);
      fields.appendChild(layerField);
    }

    const tagsField = buildTagsField(tile);

    const actions = document.createElement('div');
    actions.className = 'row layer-actions';
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.className = 'btn-icon-md';
    btnEdit.textContent = '✎';
    btnEdit.title = 'Edit tile';
    btnEdit.addEventListener('click', () => openTileEditor(tile.id));
    actions.appendChild(btnEdit);
    if (grid) {
      const btnDetach = document.createElement('button');
      btnDetach.type = 'button';
      btnDetach.className = 'btn-icon-md';
      btnDetach.textContent = '⏏';
      btnDetach.title = 'Detach from grid';
      btnDetach.addEventListener('click', () => commitDetachTile(tile));
      const btnDeleteGrid = document.createElement('button');
      btnDeleteGrid.type = 'button';
      btnDeleteGrid.className = 'btn-icon-md';
      btnDeleteGrid.textContent = '🗑';
      btnDeleteGrid.title = 'Delete grid';
      btnDeleteGrid.addEventListener('click', () => commitDeleteGrid(sheet, grid));
      actions.append(btnDetach, btnDeleteGrid);
    }
    if (terrainSet) actions.appendChild(btnDeleteTerrainSet(sheet, terrainSet));

    selRow.append(nameField, fields, tagsField, actions);
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  // Only re-derive state.selectedTerrainSetId from the selected tile on an
  // actual 'selection' event -- see mountAutotilesPanel's syncSelection
  // comment for why doing this on every render (including 'project' events
  // from slot edits that mutate the selected tile's own terrainSetId) was
  // wrong.
  function syncSelection() {
    const sheet = activeSheet();
    if (sheet) syncSelectedTerrainSetFromTile(sheet.tiles.find(t => t.id === state.selectedTileId));
  }
  on('project', schedule);
  on('history', schedule);
  on('view', schedule);
  on('selection', () => { syncSelection(); schedule(); });
  syncSelection();
  render();
}

// Shares no DOM with mountTilePanel — mounts into its own #panel-autotiles
// sibling. Owns terrain sets, the terrain-set slot editor, and the Tile
// Layers manager (props/terrain/walls categorization) -- kept separate from
// mountTilePanel because it's the more complex consumer of sheet.layers,
// even though mountTilePanel's own tile-detail layer <select> reads the
// same array.
export function mountAutotilesPanel(el) {
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Autotiles';
  wrap.appendChild(h3);

  const tilePickerDialog = buildTilePickerDialog();

  const terrainSetEditor = document.createElement('div');
  terrainSetEditor.className = 'terrain-set-editor';
  wrap.appendChild(terrainSetEditor);

  function render() {
    // Hide the whole .panel container (not just wrap) in sprite mode --
    // otherwise its empty border+padding chrome still shows in the sidebar.
    if (state.mode !== 'tiles') { el.hidden = true; return; }
    el.hidden = false;
    const sheet = activeSheet();
    terrainSetEditor.innerHTML = '';
    if (!sheet) return;

    const selectedTerrainSet = sheet.terrainSets.find(ts => ts.id === state.selectedTerrainSetId);
    if (selectedTerrainSet) {
      renderTerrainSetEditor(terrainSetEditor, sheet, selectedTerrainSet, tilePickerDialog);
    } else {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = 'No terrain set selected — select a tile that belongs to one, or add a new set in the Tiles panel.';
      terrainSetEditor.appendChild(hint);
    }
  }

  // No explicit terrain-set list any more -- membership is already visible
  // via each tile's info (Tiles panel), so which set shows here just
  // follows the selected tile when it belongs to one. Only re-derived on
  // an actual 'selection' event, NOT on every render: slot edits (e.g.
  // clearing the currently-selected tile's own slot) also mutate that
  // tile's terrainSetId and fire 'project', and re-syncing from render()
  // used to misread that as "an unrelated tile got selected", wiping
  // state.selectedTerrainSetId and kicking the user out of the editor
  // they were just using.
  function syncSelection() {
    const sheet = activeSheet();
    if (sheet) syncSelectedTerrainSetFromTile(sheet.tiles.find(t => t.id === state.selectedTileId));
  }

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  on('project', () => { invalidateFlat(); schedule(); });
  on('history', () => { invalidateFlat(); schedule(); });
  on('pixels', () => { invalidateFlat(); schedule(); });
  on('view', schedule);
  on('selection', () => { syncSelection(); schedule(); });
  syncSelection();
  render();
}

// Third stacked section in the tile-mode sidebar, below Autotiles: manages
// sheet.layers (the named "Tile Layer" categories tiles/terrain sets can be
// tagged with -- unrelated to the real paint-layer stack in the Layers
// panel; see mountAutotilesPanel's header comment for that disambiguation).
// Deliberately built like a slimmed-down mountLayersPanel (panels.js) --
// reuses its .layer-list/.layer-row/.layer-name/.layer-actions classes
// rather than inventing new ones -- since this is meant to grow into a
// real tile-layer visibility/compositing panel once a map editor mode
// exists to preview terrain sets and sprites together. `showVisibility`/
// `showOpacity` are reserved for that: sheet.layers is currently just an
// array of name strings, so there's no per-layer visible/opacity data yet
// to bind those controls to -- they're plumbed through as options now so
// the map editor can turn them on later without a signature change.
export function mountTileLayersPanel(el, { showVisibility = false, showOpacity = false } = {}) {
  const wrap = document.createElement('div');
  el.appendChild(wrap);

  const h3 = document.createElement('h3');
  h3.textContent = 'Tile Layers';
  wrap.appendChild(h3);

  const list = document.createElement('div');
  list.className = 'layer-list';
  wrap.appendChild(list);

  let selectedName = null;

  const btnRow = document.createElement('div');
  btnRow.className = 'row layer-actions';
  const btnAdd = document.createElement('button');
  btnAdd.type = 'button';
  btnAdd.className = 'btn-icon-md';
  btnAdd.textContent = '➕';
  btnAdd.title = 'Add layer';
  btnAdd.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    commitAddLayerName(sheet, name);
    selectedName = name;
  });
  const btnDelete = document.createElement('button');
  btnDelete.type = 'button';
  btnDelete.className = 'btn-icon-md';
  btnDelete.textContent = '🗑';
  btnDelete.title = 'Delete layer';
  btnDelete.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || selectedName == null) return;
    commitRemoveLayerName(sheet, selectedName);
    selectedName = null;
  });
  btnRow.append(btnAdd, btnDelete);
  wrap.appendChild(btnRow);

  function render() {
    // Hide the whole .panel container (not just wrap) in sprite mode --
    // otherwise its empty border+padding chrome still shows in the sidebar.
    if (state.mode !== 'tiles') { el.hidden = true; return; }
    el.hidden = false;
    const sheet = activeSheet();
    list.innerHTML = '';
    if (!sheet) return;
    if (selectedName != null && !sheet.layers.includes(selectedName)) selectedName = null;

    sheet.layers.forEach((name) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (name === selectedName ? ' active' : '');
      row.tabIndex = 0;
      row.addEventListener('click', () => { selectedName = name; render(); });

      const nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      nameEl.textContent = name;
      row.appendChild(nameEl);

      // showVisibility / showOpacity controls would be appended here once
      // the map editor gives tile layers real visible/opacity data.

      list.appendChild(row);
    });
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
