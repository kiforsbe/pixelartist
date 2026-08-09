// js/modes/tiles/application/commands/tile-sheet-commands.js
import { state, emit, markDirty } from '../../../../app/state.js';
import { copyRegion, blitRegion, fillRegion } from '../../../../core/pixels.js';
import { sheetLayers, scrubTileReferences } from '../../../../core/model.js';
import {
  ownedTiles, relayoutGrid, removeTileGrid, createTileGrid,
  detachTile as coreDetachTile, resizeGridAxis as coreResizeGridAxis,
  growTileIntoGrid as coreGrowTileIntoGrid, collapseGridToTile,
} from '../../../../core/tilegrids.js';
import { newId } from '../../../../core/palettes.js';
import { pruneEmptyTerrainSets, detachFromTerrainSetIfMismatched } from '../../../../core/terrainsets.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
function findTile(sheet, tileId) { return sheet.tiles.find(t => t.id === tileId) ?? null; }
function findGrid(sheet, gridId) { return sheet.tileGrids.find(g => g.id === gridId) ?? null; }

export function runCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSheet(project, sheetId), apply, revert);
  markDirty();
}

const cloneNb = v => v === undefined ? undefined : structuredClone(v);

export function swapTiles(services, sheetId, aId, bId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const a = findTile(sheet, aId), b = findTile(sheet, bId);
  const patches = sheetLayers(sheet).map(layer => ({
    layerId: layer.id,
    beforeA: copyRegion(layer.bitmap, a.x, a.y, a.w, a.h),
    beforeB: copyRegion(layer.bitmap, b.x, b.y, b.w, b.h),
  }));
  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };

  runCommand(services, sheetId, 'swap tiles',
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeB, a.x, a.y);
        blitRegion(layer.bitmap, p.beforeA, b.x, b.y);
      }
      a.name = namesBefore.b; b.name = namesBefore.a;
      a.neighbors = cloneNb(neighborsBefore.b); b.neighbors = cloneNb(neighborsBefore.a);
    },
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    });
}

export function moveTile(services, sheetId, aId, bId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const a = findTile(sheet, aId), b = findTile(sheet, bId);
  const patches = sheetLayers(sheet).map(layer => ({
    layerId: layer.id,
    beforeA: copyRegion(layer.bitmap, a.x, a.y, a.w, a.h),
    beforeB: copyRegion(layer.bitmap, b.x, b.y, b.w, b.h),
  }));
  const namesBefore = { a: a.name, b: b.name };
  const neighborsBefore = { a: cloneNb(a.neighbors), b: cloneNb(b.neighbors) };

  runCommand(services, sheetId, 'move tile',
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeA, b.x, b.y);
        fillRegion(layer.bitmap, a.x, a.y, a.w, a.h, [0, 0, 0, 0]);
      }
      b.name = namesBefore.a; a.name = undefined;
      b.neighbors = cloneNb(neighborsBefore.a); a.neighbors = undefined;
    },
    sheet => {
      const a = findTile(sheet, aId), b = findTile(sheet, bId);
      for (const layer of sheetLayers(sheet)) {
        const p = patches.find(entry => entry.layerId === layer.id);
        blitRegion(layer.bitmap, p.beforeA, a.x, a.y);
        blitRegion(layer.bitmap, p.beforeB, b.x, b.y);
      }
      a.name = namesBefore.a; b.name = namesBefore.b;
      a.neighbors = cloneNb(neighborsBefore.a); b.neighbors = cloneNb(neighborsBefore.b);
    });
}

export function moveStandaloneTile(services, sheetId, tileId, dx, dy) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const before = { x: tile.x, y: tile.y };
  runCommand(services, sheetId, 'move tile',
    sheet => { const t = findTile(sheet, tileId); t.x = before.x + dx; t.y = before.y + dy; },
    sheet => { const t = findTile(sheet, tileId); t.x = before.x; t.y = before.y; });
}

export function resizeTile(services, sheetId, tileId, before, after) {
  runCommand(services, sheetId, 'resize tile',
    sheet => { const t = findTile(sheet, tileId); t.x = after.x; t.y = after.y; t.w = after.w; t.h = after.h; },
    sheet => { const t = findTile(sheet, tileId); t.x = before.x; t.y = before.y; t.w = before.w; t.h = before.h; });
}

export function createTile(services, sheetId, rect) {
  const id = newId('ti');
  runCommand(services, sheetId, 'add tile',
    sheet => {
      if (!findTile(sheet, id)) {
        sheet.tiles.push({
          id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, name: undefined, gridId: null,
          gridCol: undefined, gridRow: undefined, neighbors: undefined, terrainSetId: undefined,
          blobIndex: undefined, layer: undefined, tags: undefined,
        });
      }
      state.selectedTileId = id;
    },
    sheet => {
      sheet.tiles = sheet.tiles.filter(t => t.id !== id);
      if (state.selectedTileId === id) state.selectedTileId = null;
    });
  emit('selection');
}

// Grid-owned tiles aren't deleted individually (shrink the grid, or detach
// first). Mutates eagerly, then snapshots before/after arrays for do/undo --
// see Global Constraints re: complex multi-entity operations.
export function deleteTile(services, sheetId, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (!tile || tile.gridId != null) return;
  const wasSelected = state.selectedTileId === tileId;
  const candidateTerrainSetId = tile.terrainSetId ?? null;
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  sheet.tiles = sheet.tiles.filter(t => t !== tile);
  scrubTileReferences(sheet, tile.id);
  const prunedIds = candidateTerrainSetId != null ? pruneEmptyTerrainSets(sheet, [candidateTerrainSetId]) : [];
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  if (state.selectedTileId === tileId) state.selectedTileId = null;
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  runCommand(services, sheetId, 'delete tile',
    sheet => {
      sheet.tiles = afterTiles.slice();
      sheet.terrainSets = afterSets.slice();
      if (state.selectedTileId === tileId) state.selectedTileId = null;
    },
    sheet => {
      sheet.tiles = beforeTiles.slice();
      sheet.terrainSets = beforeSets.slice();
      if (wasSelected) state.selectedTileId = tileId;
    });
  emit('selection');
}

export function moveGrid(services, sheetId, gridId, dx, dy) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const before = { x: grid.x, y: grid.y };
  runCommand(services, sheetId, 'move grid',
    sheet => { const g = findGrid(sheet, gridId); g.x = before.x + dx; g.y = before.y + dy; relayoutGrid(sheet, g); },
    sheet => { const g = findGrid(sheet, gridId); g.x = before.x; g.y = before.y; relayoutGrid(sheet, g); });
}

export function growTileIntoGrid(services, sheetId, tileId, axis, side, count) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  coreGrowTileIntoGrid(sheet, tile, axis, side, count);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  runCommand(services, sheetId, 'grow tile into grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); state.selectedTileId = tileId; },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); state.selectedTileId = tileId; });
  emit('selection');
}

export function resizeGridAxis(services, sheetId, gridId, axis, side, count) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  coreResizeGridAxis(sheet, grid, axis, side, count);
  let survivorId = null;
  if (grid.cols === 1 && grid.rows === 1) survivorId = collapseGridToTile(sheet, grid).id;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  runCommand(services, sheetId, 'resize grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); if (survivorId) state.selectedTileId = survivorId; },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); });
  if (survivorId) emit('selection');
}

export function addGrid(services, sheetId, opts) {
  const sheet = findSheet(services.projects.project, sheetId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const created = createTileGrid(sheet, opts);
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  runCommand(services, sheetId, 'add grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); });
  return created;
}

export function deleteGrid(services, sheetId, gridId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  const beforeGrids = sheet.tileGrids.slice();
  const beforeTiles = sheet.tiles.slice();
  const beforeSets = sheet.terrainSets.slice();
  const candidateTerrainSetIds = [...new Set(ownedTiles(sheet, grid.id).map(t => t.terrainSetId).filter(id => id != null))];
  removeTileGrid(sheet, grid.id);
  const prunedIds = pruneEmptyTerrainSets(sheet, candidateTerrainSetIds);
  if (prunedIds.includes(state.selectedTerrainSetId)) state.selectedTerrainSetId = null;
  if (state.selectedTileId != null && !sheet.tiles.some(t => t.id === state.selectedTileId)) state.selectedTileId = null;
  const afterGrids = sheet.tileGrids.slice();
  const afterTiles = sheet.tiles.slice();
  const afterSets = sheet.terrainSets.slice();
  runCommand(services, sheetId, 'delete grid',
    sheet => { sheet.tileGrids = afterGrids.slice(); sheet.tiles = afterTiles.slice(); sheet.terrainSets = afterSets.slice(); },
    sheet => { sheet.tileGrids = beforeGrids.slice(); sheet.tiles = beforeTiles.slice(); sheet.terrainSets = beforeSets.slice(); });
}

export function setGridCellField(services, sheetId, gridId, key, value) {
  const sheet = findSheet(services.projects.project, sheetId);
  const grid = findGrid(sheet, gridId);
  if (grid[key] === value) return;
  const before = grid[key];
  const beforeRects = ownedTiles(sheet, grid.id).map(t => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h }));
  runCommand(services, sheetId, `edit grid ${key}`,
    sheet => { const g = findGrid(sheet, gridId); g[key] = value; relayoutGrid(sheet, g); },
    sheet => {
      const g = findGrid(sheet, gridId);
      g[key] = before;
      for (const r of beforeRects) {
        const t = findTile(sheet, r.id);
        t.x = r.x; t.y = r.y; t.w = r.w; t.h = r.h;
      }
    });
}

export function detachTile(services, sheetId, tileId) {
  const before = (() => {
    const sheet = findSheet(services.projects.project, sheetId);
    const t = findTile(sheet, tileId);
    return { gridId: t.gridId, gridCol: t.gridCol, gridRow: t.gridRow };
  })();
  runCommand(services, sheetId, 'detach tile from grid',
    sheet => { coreDetachTile(findTile(sheet, tileId)); },
    sheet => { const t = findTile(sheet, tileId); t.gridId = before.gridId; t.gridCol = before.gridCol; t.gridRow = before.gridRow; });
}

export function setTileLayer(services, sheetId, tileId, layer) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const after = layer || undefined;
  if (tile.layer === after) return;
  const before = tile.layer;
  runCommand(services, sheetId, 'set tile layer',
    sheet => { findTile(sheet, tileId).layer = after; },
    sheet => { findTile(sheet, tileId).layer = before; });
}

export function renameTile(services, sheetId, tileId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const before = tile.name;
  const after = name || undefined;
  if (before === after) return;
  runCommand(services, sheetId, 'rename tile',
    sheet => { findTile(sheet, tileId).name = after; },
    sheet => { findTile(sheet, tileId).name = before; });
}

export function setTileTags(services, sheetId, tileId, tagsText) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  const tags = tagsText.split(',').map(value => value.trim()).filter(Boolean);
  const before = tile.tags ? [...tile.tags] : undefined;
  const after = tags.length ? tags : undefined;
  runCommand(services, sheetId, 'set tile tags',
    sheet => { findTile(sheet, tileId).tags = after ? [...after] : undefined; },
    sheet => { findTile(sheet, tileId).tags = before ? [...before] : undefined; });
}

export function setTileSize(services, sheetId, tileId, key, value) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (tile[key] === value) return;
  const before = { size: tile[key], terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex };
  runCommand(services, sheetId, `edit tile ${key}`,
    sheet => { const t = findTile(sheet, tileId); t[key] = value; detachFromTerrainSetIfMismatched(sheet, t); },
    sheet => { const t = findTile(sheet, tileId); t[key] = before.size; t.terrainSetId = before.terrainSetId; t.blobIndex = before.blobIndex; });
}
