// js/modes/tiles/application/commands/autotile-paint-commands.js
import { runCommand } from './tile-sheet-commands.js';
import { captureTerrainSlotState, restoreTerrainSlotState } from './terrain-slot-snapshot.js';
import { newId } from '../../../../core/palettes.js';
import { assignSlot } from '../../../../core/terrainsets.js';
import { blobIndexFromPaintMask } from '../../../../core/blob47.js';
import { planTerrainPaintCells } from '../geometry/autotile-geometry.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

function standalonePaintTile(x, y, w, h) {
  return {
    id: newId('ti'), x, y, w, h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined,
    neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined,
    duplicateOf: undefined,
  };
}

// Prepare a neat full-sheet lattice without ever creating a Tile Grid, then
// push one undo entry only if any standalone cells were actually created.
export function prepareTerrainPaint(services, sheetId, terrainSetId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  const planned = planTerrainPaintCells(sheet, terrainSet);
  if (planned.error) return { error: planned.error };
  if (!planned.missing.length) return { grid: planned.grid };

  const before = sheet.tiles.slice();
  const after = before.concat(planned.missing.map(cell => standalonePaintTile(cell.x, cell.y, cell.w, cell.h)));
  runCommand(services, sheetId, 'create terrain paint cells',
    sheet => { sheet.tiles = after.slice(); },
    sheet => { sheet.tiles = before.slice(); });
  return { grid: planned.grid };
}

// Assigns every painted tile's Blob-47 slot from its finished stroke mask.
// A tile whose canonical shape collides with an already-claimed slot is
// reported as a conflict instead of silently overwriting it; the caller
// resolves conflicts explicitly via resolveAutotilePaintConflict.
export function paintTerrainStroke(services, sheetId, terrainSetId, strokeMasks) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  if (!terrainSet || !strokeMasks.size) return { conflicts: new Map() };

  const beforeSlots = { ...terrainSet.slots };
  let afterSlots;
  const beforeTiles = new Map();
  const afterTiles = new Map();
  const candidates = [];
  const conflicts = new Map();
  for (const [tileId, mask] of strokeMasks) {
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile || (tile.terrainSetId != null && tile.terrainSetId !== terrainSet.id)) continue;
    beforeTiles.set(tileId, { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex, duplicateOf: tile.duplicateOf });
    candidates.push({ tileId, blobIndex: blobIndexFromPaintMask(mask) });
  }
  // Rejected owners retain their old slots, which can in turn block dependent
  // moves. Rebuild until all remaining candidates agree; swaps still work
  // because every surviving candidate releases its old slot simultaneously.
  let pending = candidates;
  while (true) {
    afterSlots = { ...beforeSlots };
    const moving = new Set(pending.map(candidate => candidate.tileId));
    for (const idx of Object.keys(afterSlots)) if (moving.has(afterSlots[idx])) delete afterSlots[idx];
    const accepted = [];
    for (const candidate of pending) {
      const owner = afterSlots[candidate.blobIndex];
      if (owner != null && owner !== candidate.tileId) {
        conflicts.set(candidate.tileId, candidate.blobIndex);
      } else {
        afterSlots[candidate.blobIndex] = candidate.tileId;
        accepted.push(candidate);
      }
    }
    if (accepted.length === pending.length) break;
    pending = accepted;
  }
  for (const { tileId, blobIndex } of pending) {
    afterTiles.set(tileId, { terrainSetId: terrainSet.id, blobIndex, duplicateOf: undefined });
  }
  if (afterTiles.size) {
    runCommand(services, sheetId, 'paint autotile terrain',
      sheet => {
        const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
        terrainSet.slots = { ...afterSlots };
        for (const [id, next] of afterTiles) { const t = sheet.tiles.find(x => x.id === id); if (t) Object.assign(t, next); }
      },
      sheet => {
        const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
        terrainSet.slots = { ...beforeSlots };
        for (const [id, prev] of beforeTiles) { const t = sheet.tiles.find(x => x.id === id); if (t) Object.assign(t, prev); }
      });
  }
  return { conflicts };
}

// Conflicts are deliberately non-destructive during a paint stroke. This is
// the explicit escape hatch: replace the old artwork for that Blob-47 shape
// only when the user asks to use the newly painted tile.
export function resolveAutotilePaintConflict(services, sheetId, terrainSetId, tileId, blobIndex) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!terrainSet || !tile) return;

  const before = captureTerrainSlotState(sheet);
  assignSlot(sheet, terrainSet, blobIndex, tile);
  tile.duplicateOf = undefined;
  const after = captureTerrainSlotState(sheet);

  runCommand(services, sheetId, 'replace autotile terrain art',
    sheet => restoreTerrainSlotState(sheet, after),
    sheet => restoreTerrainSlotState(sheet, before));
}
