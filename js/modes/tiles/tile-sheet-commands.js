import { state, emit, currentContextLayers, markDirty } from '../../app/state.js';
import { copyRegion, blitRegion, fillRegion } from '../../core/pixels.js';
import {
  ownedTiles, relayoutGrid, moveGrid, removeTileGrid, createTileGrid, detachTile,
  resizeGridAxis, growTileIntoGrid, collapseGridToTile,
} from '../../core/tilegrids.js';
import { newId } from '../../core/palettes.js';
import { scrubTileReferences } from '../../core/model.js';
import { pruneEmptyTerrainSets, detachFromTerrainSetIfMismatched } from '../../core/terrainsets.js';

// ------------------------------------------------------------- commands

// Deep-clone a neighbors preset value, guarded for undefined.
const cloneNb = v => v === undefined ? undefined : structuredClone(v);

// Pixel-carrying swap across all layers, plus name<->name and
// neighbors<->neighbors, as one undo/redo step. Same size required by the
// caller (handleUp) before this is invoked — a and b's rects are used
// as-is, whatever their current x/y/w/h (grid-owned or standalone).
export function commitSwapTile(sheet, a, b) {
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
export function commitMoveTile(sheet, a, b) {
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
export function commitMoveStandaloneTile(tile, dx, dy) {
  const before = { x: tile.x, y: tile.y };
  state.commands.push({
    label: 'move tile',
    do() { tile.x = before.x + dx; tile.y = before.y + dy; },
    undo() { tile.x = before.x; tile.y = before.y; },
  });
  markDirty();
}

export function commitResizeTile(tile, before, after) {
  state.commands.push({
    label: 'resize tile',
    do() { tile.x = after.x; tile.y = after.y; tile.w = after.w; tile.h = after.h; },
    undo() { tile.x = before.x; tile.y = before.y; tile.w = before.w; tile.h = before.h; },
  });
  markDirty();
}

export function commitCreateTile(sheet, rect) {
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
export function deleteTile(sheet, tileId) {
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

export function commitMoveGrid(sheet, grid, dx, dy) {
  const before = { x: grid.x, y: grid.y };
  state.commands.push({
    label: 'move grid',
    do() { grid.x = before.x + dx; grid.y = before.y + dy; relayoutGrid(sheet, grid); },
    undo() { grid.x = before.x; grid.y = before.y; relayoutGrid(sheet, grid); },
  });
  markDirty();
}

export function commitGrowTileIntoGrid(sheet, tile, axis, side, count) {
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

export function commitResizeGridAxis(sheet, grid, axis, side, count) {
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

export function openTileEditor(tileId) {
  state.editingTileId = tileId;
  state.view = 'tile';
  emit('view');
}

export function commitAddGrid(sheet, opts) {
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

export function commitDeleteGrid(sheet, grid) {
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
export function commitGridCellField(sheet, grid, key, value) {
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

export function commitDetachTile(tile) {
  const before = { gridId: tile.gridId, gridCol: tile.gridCol, gridRow: tile.gridRow };
  state.commands.push({
    label: 'detach tile from grid',
    do() { detachTile(tile); },
    undo() { tile.gridId = before.gridId; tile.gridCol = before.gridCol; tile.gridRow = before.gridRow; },
  });
  markDirty();
}

export function commitTileLayer(tile, layer) {
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

export function commitTileName(tile, name) {
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

export function commitTileTags(tile, tagsText) {
  const tags = tagsText.split(',').map(value => value.trim()).filter(Boolean);
  const before = tile.tags ? [...tile.tags] : undefined;
  const after = tags.length ? tags : undefined;
  state.commands.push({
    label: 'set tile tags',
    do() { tile.tags = after ? [...after] : undefined; },
    undo() { tile.tags = before ? [...before] : undefined; },
  });
  markDirty();
}

export function commitTileSize(sheet, tile, key, value) {
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
