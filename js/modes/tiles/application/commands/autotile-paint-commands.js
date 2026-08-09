// js/modes/tiles/application/commands/autotile-paint-commands.js
import { runCommand } from './tile-sheet-commands.js';
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
  const afterSlots = { ...beforeSlots };
  const beforeTiles = new Map();
  const afterTiles = new Map();
  const candidates = [];
  const conflicts = new Map();
  for (const [tileId, mask] of strokeMasks) {
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile || (tile.terrainSetId != null && tile.terrainSetId !== terrainSet.id)) continue;
    beforeTiles.set(tileId, { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex, duplicateOf: tile.duplicateOf });
    for (const idx of Object.keys(afterSlots)) if (afterSlots[idx] === tileId) delete afterSlots[idx];
    candidates.push({ tileId, blobIndex: blobIndexFromPaintMask(mask) });
  }
  for (const candidate of candidates) {
    const owner = afterSlots[candidate.blobIndex];
    if (owner != null && owner !== candidate.tileId) { conflicts.set(candidate.tileId, candidate.blobIndex); continue; }
    afterSlots[candidate.blobIndex] = candidate.tileId;
    afterTiles.set(candidate.tileId, { terrainSetId: terrainSet.id, blobIndex: candidate.blobIndex, duplicateOf: undefined });
  }
  // A conflicted tile was removed from the working slots above only if it had
  // moved. Restore it exactly, and do not create a history command if every
  // changed cell was blocked by a duplicate/other terrain set.
  for (const candidate of candidates) if (conflicts.has(candidate.tileId)) {
    const before = beforeTiles.get(candidate.tileId);
    if (before?.terrainSetId === terrainSet.id && before.blobIndex != null) afterSlots[before.blobIndex] = candidate.tileId;
  }
  if (afterTiles.size) {
    runCommand(services, sheetId, 'paint autotile terrain',
      sheet => {
        const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
        terrainSet.slots = { ...afterSlots };
        for (const [id, next] of afterTiles) Object.assign(sheet.tiles.find(t => t.id === id), next);
      },
      sheet => {
        const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
        terrainSet.slots = { ...beforeSlots };
        for (const [id, prev] of beforeTiles) Object.assign(sheet.tiles.find(t => t.id === id), prev);
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

  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));

  assignSlot(sheet, terrainSet, blobIndex, tile);
  tile.duplicateOf = undefined;

  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));

  runCommand(services, sheetId, 'replace autotile terrain art',
    sheet => {
      const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
      terrainSet.slots = { ...afterSlots };
      for (const entry of afterTiles) {
        const t = sheet.tiles.find(x => x.id === entry.id);
        if (t) Object.assign(t, { terrainSetId: entry.terrainSetId, blobIndex: entry.blobIndex, duplicateOf: entry.duplicateOf });
      }
    },
    sheet => {
      const terrainSet = sheet.terrainSets.find(ts => ts.id === terrainSetId);
      terrainSet.slots = { ...beforeSlots };
      for (const entry of beforeTiles) {
        const t = sheet.tiles.find(x => x.id === entry.id);
        if (t) Object.assign(t, { terrainSetId: entry.terrainSetId, blobIndex: entry.blobIndex, duplicateOf: entry.duplicateOf });
      }
    });
}
