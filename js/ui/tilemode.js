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
import { scrubTileReferences } from '../core/model.js';
import {
  createTerrainSet, removeTerrainSet, assignSlot, clearSlot,
  detachFromTerrainSetIfMismatched, applyLayoutPreset, saveLayoutPreset,
} from '../core/terrainsets.js';
import {
  NEIGHBOR_BITS, blobIndexToMask, maskToBlobIndex, SIXTEEN_TILE_INDICES, resolveTerrainSlot, classifySlots,
} from '../core/blob47.js';

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
// 'staircase' | 'grid6x8' | 'grid7x7' | 'sixteen'.
let terrainViewMode = 'staircase';

function ascendingIndices() {
  return Array.from({ length: blobIndexToMask.length }, (_, i) => i);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function slotGroupsForViewMode(mode) {
  if (mode === 'grid6x8') return chunk(ascendingIndices(), 6);
  if (mode === 'grid7x7') return chunk(ascendingIndices(), 7);
  if (mode === 'sixteen') return [[...SIXTEEN_TILE_INDICES].sort((a, b) => a - b)];
  return blobStaircaseGroups();
}

function describeMask(mask) {
  const names = { [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE', [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE', [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW', [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW' };
  const parts = Object.keys(names).filter(b => mask & Number(b)).map(b => names[b]);
  return parts.length ? parts.join(' + ') : 'isolated';
}

// Real blob-47 reference templates (raw neighbor bitmasks, top-left to
// bottom-right, using this module's own NEIGHBOR_BITS weights: N=1, NE=2,
// E=4, SE=8, S=16, SW=32, W=64, NW=128). Each raw byte is resolved through
// maskToBlobIndex to its canonical blobIndex -- raw byte 255 (full 8-
// neighbor surround) intentionally repeats (both templates' known
// duplicate-cell convention); every other one of the 47 canonical indices
// appears exactly once per template.
const BLOB47_8X6_RAW = [
  [0, 4, 92, 112, 28, 124, 116, 64],
  [20, 84, 87, 221, 127, 255, 245, 80],
  [29, 117, 85, 95, 247, 215, 209, 1],
  [23, 213, 81, 31, 253, 125, 113, 16],
  [21, 69, 93, 119, 223, 255, 241, 17],
  [5, 68, 71, 193, 7, 199, 197, 65],
];
const BLOB47_7X7_RAW = [
  [0, 4, 84, 92, 124, 116, 80],
  [16, 28, 117, 95, 255, 253, 113],
  [21, 87, 221, 127, 255, 247, 209],
  [29, 125, 119, 199, 215, 213, 81],
  [31, 255, 241, 20, 65, 17, 1],
  [23, 223, 245, 85, 68, 93, 112],
  [5, 71, 197, 69, 64, 7, 193],
];
function cellsFromRawGrid(rawGrid) {
  const cells = [];
  rawGrid.forEach((rowVals, row) => rowVals.forEach((raw, col) => {
    cells.push({ col, row, blobIndex: maskToBlobIndex[raw] });
  }));
  return cells;
}

const BUILTIN_LAYOUT_PRESETS = [
  {
    name: 'Blob-47 (8×6)', cols: 8, rows: 6,
    cells: cellsFromRawGrid(BLOB47_8X6_RAW),
  },
  {
    name: 'Blob-47 (7×7)', cols: 7, rows: 7,
    cells: cellsFromRawGrid(BLOB47_7X7_RAW),
  },
  {
    name: '16-tile (4×4, ascending)', cols: 4, rows: 4,
    cells: Array.from({ length: 16 }, (_, i) => ({ col: i % 4, row: Math.floor(i / 4), blobIndex: [...SIXTEEN_TILE_INDICES][i] })),
  },
];

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
      scrubTileReferences(sheet, tile.id);
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

function commitAddGrid(sheet, opts) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  createTileGrid(sheet, opts);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'add grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

function commitDeleteGrid(sheet, grid) {
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  removeTileGrid(sheet, grid.id);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  state.commands.push({
    label: 'delete grid',
    do() { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    undo() { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

function commitResizeGridCols(sheet, grid, cols) {
  if (cols === grid.cols) return;
  const beforeTiles = sheet.tiles.slice();
  const beforeCols = grid.cols;
  resizeGridCols(sheet, grid, cols);
  const afterTiles = sheet.tiles.slice();
  const afterCols = grid.cols;
  state.commands.push({
    label: 'resize grid cols',
    do() { grid.cols = afterCols; sheet.tiles = afterTiles.slice(); },
    undo() { grid.cols = beforeCols; sheet.tiles = beforeTiles.slice(); },
  });
  markDirty();
}

function commitResizeGridRows(sheet, grid, rows) {
  if (rows === grid.rows) return;
  const beforeTiles = sheet.tiles.slice();
  const beforeRows = grid.rows;
  resizeGridRows(sheet, grid, rows);
  const afterTiles = sheet.tiles.slice();
  const afterRows = grid.rows;
  state.commands.push({
    label: 'resize grid rows',
    do() { grid.rows = afterRows; sheet.tiles = afterTiles.slice(); },
    undo() { grid.rows = beforeRows; sheet.tiles = beforeTiles.slice(); },
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
  createTerrainSet(sheet, opts);
  const after = sheet.terrainSets.slice();
  state.commands.push({
    label: 'add terrain set',
    do() { sheet.terrainSets = after.slice(); },
    undo() { sheet.terrainSets = before.slice(); },
  });
  markDirty();
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

// Save-as-preset is metadata-only bookkeeping (terrainLayoutPresets), not
// worth undo tracking on its own -- it doesn't touch tiles/terrainSets.
function commitSaveLayoutPreset(sheet, name, cols, rows, cells) {
  saveLayoutPreset(sheet, name, cols, rows, cells);
  markDirty();
  emit('project');
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

function commitMoveLayerName(sheet, index, delta) {
  const to = index + delta;
  if (to < 0 || to >= sheet.layers.length) return;
  const before = sheet.layers.slice();
  const arr = sheet.layers.slice();
  [arr[index], arr[to]] = [arr[to], arr[index]];
  const after = arr;
  state.commands.push({
    label: 'reorder layer names',
    do() { sheet.layers = after.slice(); },
    undo() { sheet.layers = before.slice(); },
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

// ------------------------------------------------------------- add-grid dialog

let addGridPreviewOpts = null; // dialog's current field values while open, else null

function drawAddGridPreview(ctx, view) {
  const { cellW, cellH, cols, rows, spacingX, spacingY } = addGridPreviewOpts;
  if (cellW < 1 || cellH < 1 || cols < 1 || rows < 1) return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  const previewGrid = { x: 0, y: 0, cellW, cellH, spacingX, spacingY };
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const r = gridCellRect(previewGrid, col, row);
      strokeGhostRect(ctx, view, r);
    }
  ctx.restore();
}

function buildAddGridDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add grid</h3>
    <div class="row"><label>Cell W <input type="number" id="ag-cellw" min="1" value="16"></label></div>
    <div class="row"><label>Cell H <input type="number" id="ag-cellh" min="1" value="16"></label></div>
    <div class="row"><label>Cols <input type="number" id="ag-cols" min="1" value="4"></label></div>
    <div class="row"><label>Rows <input type="number" id="ag-rows" min="1" value="4"></label></div>
    <div class="row"><label>Spacing X <input type="number" id="ag-spacingx" min="0" value="0"></label></div>
    <div class="row"><label>Spacing Y <input type="number" id="ag-spacingy" min="0" value="0"></label></div>
    <div class="row"><button type="button" id="ag-create">Create</button><button type="button" id="ag-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  const readPreview = () => {
    const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
    return {
      cellW: intVal($('#ag-cellw'), 1), cellH: intVal($('#ag-cellh'), 1),
      cols: intVal($('#ag-cols'), 1), rows: intVal($('#ag-rows'), 1),
      spacingX: intVal($('#ag-spacingx'), 0), spacingY: intVal($('#ag-spacingy'), 0),
    };
  };
  for (const id of ['#ag-cellw', '#ag-cellh', '#ag-cols', '#ag-rows', '#ag-spacingx', '#ag-spacingy'])
    $(id).addEventListener('input', () => {
      if (!addGridPreviewOpts) return;
      addGridPreviewOpts = readPreview();
      tileToolView?.requestRender();
    });
  dlg.addEventListener('close', () => {
    addGridPreviewOpts = null;
    tileToolView?.requestRender();
  });
  $('#ag-cancel').addEventListener('click', () => dlg.close());
  $('#ag-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    commitAddGrid(sheet, { x: 0, y: 0, ...readPreview() });
    dlg.close();
  });
  return {
    open() {
      const settings = state.project?.settings ?? {};
      $('#ag-cellw').value = String(settings.tileW ?? 16);
      $('#ag-cellh').value = String(settings.tileH ?? 16);
      addGridPreviewOpts = readPreview();
      dlg.showModal();
      tileToolView?.requestRender();
    },
  };
}

// ------------------------------------------------------------- terrain sets

function buildAddTerrainSetDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add terrain set</h3>
    <div class="row"><label>Name <input type="text" id="ats-name" value="Terrain"></label></div>
    <div class="row"><label>Tile W <input type="number" id="ats-tilew" min="1" value="16"></label></div>
    <div class="row"><label>Tile H <input type="number" id="ats-tileh" min="1" value="16"></label></div>
    <div class="row"><button type="button" id="ats-create">Create</button><button type="button" id="ats-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  $('#ats-cancel').addEventListener('click', () => dlg.close());
  $('#ats-create').addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el) => Math.max(1, parseInt(el.value, 10) || 1);
    commitAddTerrainSet(sheet, {
      name: $('#ats-name').value.trim() || 'Terrain',
      tileW: intVal($('#ats-tilew')), tileH: intVal($('#ats-tileh')),
    });
    dlg.close();
  });
  return {
    open() {
      const settings = state.project?.settings ?? {};
      $('#ats-tilew').value = String(settings.tileW ?? 16);
      $('#ats-tileh').value = String(settings.tileH ?? 16);
      dlg.showModal();
    },
  };
}

function buildTilePickerDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Assign tile</h3>
    <div class="row"><label>Tile <select id="tp-select"></select></label></div>
    <div class="row"><button type="button" id="tp-ok">OK</button><button type="button" id="tp-clear">Clear</button><button type="button" id="tp-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let onPick = null, onClear = null;
  $('#tp-cancel').addEventListener('click', () => dlg.close());
  $('#tp-ok').addEventListener('click', () => { onPick?.($('#tp-select').value); dlg.close(); });
  $('#tp-clear').addEventListener('click', () => { onClear?.(); dlg.close(); });
  return {
    open(sheet, terrainSet, currentTileId, pick, clear) {
      onPick = pick; onClear = clear;
      const select = $('#tp-select');
      select.innerHTML = '';
      sheet.tiles
        .filter(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH)
        .forEach((t, i) => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name ? `${i}: ${t.name}` : `#${i}`;
          select.appendChild(opt);
        });
      if (currentTileId) select.value = currentTileId;
      dlg.showModal();
    },
  };
}

function renderLayoutPresetRow(container, sheet, terrainSet) {
  const row = document.createElement('div');
  row.className = 'row';

  const presetSelect = document.createElement('select');
  const allPresets = [...BUILTIN_LAYOUT_PRESETS, ...sheet.terrainLayoutPresets];
  allPresets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${p.name} (${p.cols}×${p.rows})`;
    presetSelect.appendChild(opt);
  });

  const gridSelect = document.createElement('select');
  sheet.tileGrids.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = `Grid ${g.cols}×${g.rows} @ (${g.x},${g.y})`;
    gridSelect.appendChild(opt);
  });

  const btnImport = document.createElement('button');
  btnImport.type = 'button';
  btnImport.textContent = '⬇';
  btnImport.title = 'Import from layout';
  btnImport.addEventListener('click', () => {
    const preset = allPresets[Number(presetSelect.value)];
    const grid = sheet.tileGrids.find(g => g.id === gridSelect.value);
    if (!preset || !grid || grid.cols !== preset.cols || grid.rows !== preset.rows) {
      alert(`Selected grid must be exactly ${preset?.cols ?? '?'}×${preset?.rows ?? '?'} to use this layout.`);
      return;
    }
    const sourceTiles = ownedTiles(sheet, grid.id).sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
    commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, grid.cols);
  });

  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.textContent = '💾';
  btnSave.title = 'Save current as preset';
  btnSave.addEventListener('click', () => {
    const grid = sheet.tileGrids.find(g => g.id === gridSelect.value);
    if (!grid) { alert('Select a grid to save its current slot layout as a preset.'); return; }
    const name = prompt('Preset name?');
    if (!name) return;
    const sourceTiles = ownedTiles(sheet, grid.id).sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
    const cells = [];
    sourceTiles.forEach((t, i) => {
      if (t.terrainSetId === terrainSet.id && t.blobIndex != null) {
        cells.push({ col: i % grid.cols, row: Math.floor(i / grid.cols), blobIndex: t.blobIndex });
      }
    });
    commitSaveLayoutPreset(sheet, name, grid.cols, grid.rows, cells);
  });

  row.append(presetSelect, gridSelect, btnImport, btnSave);
  container.appendChild(row);
}

function renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog) {
  container.innerHTML = '';
  renderLayoutPresetRow(container, sheet, terrainSet);

  const symRow = document.createElement('div');
  symRow.className = 'row';
  const flipCb = document.createElement('input'); flipCb.type = 'checkbox'; flipCb.checked = terrainSet.symmetry.flip;
  flipCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'flip', flipCb.checked));
  const rotCb = document.createElement('input'); rotCb.type = 'checkbox'; rotCb.checked = terrainSet.symmetry.rotate;
  rotCb.addEventListener('change', () => commitSetSymmetry(terrainSet, 'rotate', rotCb.checked));
  const flipLabel = document.createElement('label'); flipLabel.append(flipCb, document.createTextNode(' Allow flip'));
  const rotLabel = document.createElement('label'); rotLabel.append(rotCb, document.createTextNode(' Allow rotation'));
  symRow.append(flipLabel, rotLabel);
  container.appendChild(symRow);

  const viewModeRow = document.createElement('div');
  viewModeRow.className = 'row';
  const viewModeLabel = document.createElement('label');
  viewModeLabel.appendChild(document.createTextNode('View '));
  const viewModeSelect = document.createElement('select');
  [
    ['staircase', 'Staircase'],
    ['grid6x8', 'Grid 6×8'],
    ['grid7x7', 'Grid 7×7'],
    ['sixteen', '16-tile only'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    viewModeSelect.appendChild(opt);
  });
  viewModeSelect.value = terrainViewMode;
  viewModeSelect.addEventListener('change', () => {
    terrainViewMode = viewModeSelect.value;
    renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
  });
  viewModeLabel.appendChild(viewModeSelect);
  viewModeRow.appendChild(viewModeLabel);
  container.appendChild(viewModeRow);

  const classification = classifySlots(terrainSet.symmetry);
  for (const group of slotGroupsForViewMode(terrainViewMode)) {
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
      cell.title = title;

      if (resolved) {
        const tile = sheet.tiles.find(t => t.id === resolved.tileId);
        if (tile) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = (resolved.flipH || resolved.flipV) ? 'F' : (resolved.rotate ? `${resolved.rotate}°` : '');
          cell.appendChild(badge);
        }
      }

      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, terrainSet.slots[blobIndex] ?? null,
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

  const gridList = document.createElement('div');
  gridList.className = 'tile-grid-list';
  wrap.appendChild(gridList);

  const addGridDialog = buildAddGridDialog();
  const btnAddGrid = document.createElement('button');
  btnAddGrid.type = 'button';
  btnAddGrid.textContent = '➕';
  btnAddGrid.title = 'Add grid';
  btnAddGrid.addEventListener('click', () => { if (activeSheet()) addGridDialog.open(); });
  wrap.appendChild(btnAddGrid);

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
    gridList.innerHTML = '';
    countRow.innerHTML = '';
    selRow.innerHTML = '';
    if (!sheet) return;

    for (const grid of sheet.tileGrids) {
      const row = document.createElement('div');
      row.className = 'row tile-grid-row';
      row.append(
        sizeField('Cols', grid.cols, (v) => commitResizeGridCols(sheet, grid, v)),
        sizeField('Rows', grid.rows, (v) => commitResizeGridRows(sheet, grid, v)),
        sizeField('W', grid.cellW, (v) => commitGridCellField(sheet, grid, 'cellW', v)),
        sizeField('H', grid.cellH, (v) => commitGridCellField(sheet, grid, 'cellH', v)),
      );
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.textContent = 'Delete grid';
      btnDel.addEventListener('click', () => commitDeleteGrid(sheet, grid));
      row.appendChild(btnDel);
      gridList.appendChild(row);
    }

    const count = sheet.tiles.length;
    countRow.textContent = `${count} tile${count === 1 ? '' : 's'}`;

    const tile = sheet.tiles.find(t => t.id === state.selectedTileId);
    if (!tile) {
      const hint = document.createElement('span');
      hint.textContent = 'No tile selected';
      selRow.appendChild(hint);
      return;
    }

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = tile.name || '';
    nameInput.placeholder = 'name';
    nameInput.addEventListener('change', () => commitTileName(tile, nameInput.value.trim()));
    const btnEdit = document.createElement('button');
    btnEdit.type = 'button';
    btnEdit.textContent = 'Edit tile';
    btnEdit.addEventListener('click', () => openTileEditor(tile.id));
    selRow.append(nameInput, btnEdit);

    if (tile.gridId != null) {
      const btnDetach = document.createElement('button');
      btnDetach.type = 'button';
      btnDetach.textContent = 'Detach from grid';
      btnDetach.addEventListener('click', () => commitDetachTile(tile));
      selRow.appendChild(btnDetach);
    } else {
      selRow.append(
        sizeField('W', tile.w, (v) => commitTileSize(sheet, tile, 'w', v)),
        sizeField('H', tile.h, (v) => commitTileSize(sheet, tile, 'h', v)),
      );
    }

    const layerSelect = document.createElement('select');
    const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
    layerSelect.appendChild(noneOpt);
    sheet.layers.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      layerSelect.appendChild(opt);
    });
    layerSelect.value = tile.layer ?? '';
    layerSelect.addEventListener('change', () => commitTileLayer(tile, layerSelect.value));

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.placeholder = 'tags, comma, separated';
    tagsInput.value = (tile.tags ?? []).join(', ');
    tagsInput.addEventListener('change', () => commitTileTags(tile, tagsInput.value));

    selRow.append(layerSelect, tagsInput);
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

  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const tilePickerDialog = buildTilePickerDialog();

  const terrainSetList = document.createElement('div');
  terrainSetList.className = 'terrain-set-list';
  wrap.appendChild(terrainSetList);

  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = '➕';
  btnAddTerrainSet.title = 'Add terrain set';
  btnAddTerrainSet.addEventListener('click', () => { if (activeSheet()) addTerrainSetDialog.open(); });
  wrap.appendChild(btnAddTerrainSet);

  const terrainSetEditor = document.createElement('div');
  terrainSetEditor.className = 'terrain-set-editor';
  wrap.appendChild(terrainSetEditor);

  const layerList = document.createElement('div');
  layerList.className = 'layer-list';
  wrap.appendChild(layerList);

  const btnAddLayerName = document.createElement('button');
  btnAddLayerName.type = 'button';
  btnAddLayerName.textContent = 'Add Layer Name…';
  btnAddLayerName.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    commitAddLayerName(sheet, name);
  });
  wrap.appendChild(btnAddLayerName);

  function render() {
    if (state.mode !== 'tiles') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const sheet = activeSheet();
    terrainSetList.innerHTML = '';
    terrainSetEditor.innerHTML = '';
    layerList.innerHTML = '';
    if (!sheet) return;

    for (const ts of sheet.terrainSets) {
      const row = document.createElement('div');
      row.className = 'row terrain-set-row';
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.textContent = `${ts.name} (${ts.tileW}×${ts.tileH})`;
      nameBtn.addEventListener('click', () => {
        state.selectedTerrainSetId = state.selectedTerrainSetId === ts.id ? null : ts.id;
        schedule();
      });
      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.textContent = '🗑';
      btnDel.title = 'Delete terrain set';
      btnDel.addEventListener('click', () => {
        commitDeleteTerrainSet(sheet, ts.id);
        if (state.selectedTerrainSetId === ts.id) state.selectedTerrainSetId = null;
      });
      row.append(nameBtn, btnDel);
      terrainSetList.appendChild(row);
    }

    const selectedTerrainSet = sheet.terrainSets.find(ts => ts.id === state.selectedTerrainSetId);
    if (selectedTerrainSet) {
      renderTerrainSetEditor(terrainSetEditor, sheet, selectedTerrainSet, tilePickerDialog);
    }

    sheet.layers.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = name;
      const btnUp = document.createElement('button'); btnUp.type = 'button'; btnUp.textContent = '↑';
      btnUp.addEventListener('click', () => commitMoveLayerName(sheet, i, -1));
      const btnDown = document.createElement('button'); btnDown.type = 'button'; btnDown.textContent = '↓';
      btnDown.addEventListener('click', () => commitMoveLayerName(sheet, i, 1));
      const btnDel = document.createElement('button'); btnDel.type = 'button'; btnDel.textContent = 'Delete';
      btnDel.addEventListener('click', () => commitRemoveLayerName(sheet, name));
      row.append(label, btnUp, btnDown, btnDel);
      layerList.appendChild(row);
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
