// js/modes/tiles/application/commands/terrain-set-commands.js
import { runCommand } from './tile-sheet-commands.js';
import { captureTerrainSlotState, restoreTerrainSlotState } from './terrain-slot-snapshot.js';
import {
  createTerrainSet as createTerrainSetEntity, removeTerrainSet, assignSlot, clearSlot, applyLayoutPreset,
} from '../../../../core/terrainsets.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
function findTerrainSet(sheet, terrainSetId) { return sheet.terrainSets.find(ts => ts.id === terrainSetId) ?? null; }

export function createTerrainSet(services, sheetId, opts) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.terrainSets.slice();
  const created = createTerrainSetEntity(sheet, opts);
  const after = sheet.terrainSets.slice();
  runCommand(services, sheetId, 'add terrain set',
    sheet => { sheet.terrainSets = after.slice(); },
    sheet => { sheet.terrainSets = before.slice(); });
  return { terrainSetId: created.id };
}

export function deleteTerrainSet(services, sheetId, terrainSetId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const beforeSets = sheet.terrainSets.slice();
  const beforeTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  removeTerrainSet(sheet, terrainSetId);
  const afterSets = sheet.terrainSets.slice();
  const afterTiles = sheet.tiles.map(t => ({ id: t.id, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex }));
  runCommand(services, sheetId, 'delete terrain set',
    sheet => {
      sheet.terrainSets = afterSets.slice();
      for (const s of afterTiles) { const t = sheet.tiles.find(x => x.id === s.id); if (t) Object.assign(t, { terrainSetId: s.terrainSetId, blobIndex: s.blobIndex }); }
    },
    sheet => {
      sheet.terrainSets = beforeSets.slice();
      for (const s of beforeTiles) { const t = sheet.tiles.find(x => x.id === s.id); if (t) Object.assign(t, { terrainSetId: s.terrainSetId, blobIndex: s.blobIndex }); }
    });
}

export function renameTerrainSet(services, sheetId, terrainSetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  const before = terrainSet.name;
  const after = name.trim() || before;
  if (before === after) return;
  runCommand(services, sheetId, 'rename terrain set',
    sheet => { findTerrainSet(sheet, terrainSetId).name = after; },
    sheet => { findTerrainSet(sheet, terrainSetId).name = before; });
}

export function assignTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!terrainSet || !tile) return;

  const before = captureTerrainSlotState(sheet);
  assignSlot(sheet, terrainSet, blobIndex, tile);
  const after = captureTerrainSlotState(sheet);

  runCommand(services, sheetId, 'assign terrain slot',
    sheet => restoreTerrainSlotState(sheet, after),
    sheet => restoreTerrainSlotState(sheet, before));
}

export function clearTerrainSlot(services, sheetId, terrainSetId, blobIndex, tileId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  const tile = tileId != null ? sheet.tiles.find(t => t.id === tileId) : null;

  const beforeSlots = { ...terrainSet.slots };
  const beforeTile = tile ? { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex } : null;
  clearSlot(terrainSet, blobIndex, tile);
  const afterSlots = { ...terrainSet.slots };
  const afterTile = tile ? { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex } : null;

  runCommand(services, sheetId, 'clear terrain slot',
    sheet => {
      const terrainSet = findTerrainSet(sheet, terrainSetId);
      terrainSet.slots = { ...afterSlots };
      if (tileId != null && afterTile) { const t = sheet.tiles.find(x => x.id === tileId); if (t) Object.assign(t, afterTile); }
    },
    sheet => {
      const terrainSet = findTerrainSet(sheet, terrainSetId);
      terrainSet.slots = { ...beforeSlots };
      if (tileId != null && beforeTile) { const t = sheet.tiles.find(x => x.id === tileId); if (t) Object.assign(t, beforeTile); }
    });
}

export function setTerrainSymmetry(services, sheetId, terrainSetId, key, value) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  if (terrainSet.symmetry[key] === value) return;
  const before = terrainSet.symmetry[key];
  runCommand(services, sheetId, `set terrain symmetry ${key}`,
    sheet => { findTerrainSet(sheet, terrainSetId).symmetry[key] = value; },
    sheet => { findTerrainSet(sheet, terrainSetId).symmetry[key] = before; });
}

export function applyTerrainLayoutPreset(services, sheetId, terrainSetId, preset, sourceTileIds, cols) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  const sourceTiles = sourceTileIds.map(id => sheet.tiles.find(t => t.id === id));

  const before = captureTerrainSlotState(sheet);
  applyLayoutPreset(sheet, terrainSet, preset, sourceTiles, cols);
  const after = captureTerrainSlotState(sheet);

  runCommand(services, sheetId, 'import terrain layout',
    sheet => restoreTerrainSlotState(sheet, after),
    sheet => restoreTerrainSlotState(sheet, before));
}

export function setTerrainSetLayer(services, sheetId, terrainSetId, layer) {
  const sheet = findSheet(services.projects.project, sheetId);
  const terrainSet = findTerrainSet(sheet, terrainSetId);
  if (!terrainSet) return;
  const after = layer || null;
  if (terrainSet.layer === after) return;
  const before = terrainSet.layer;
  runCommand(services, sheetId, 'set terrain set layer',
    sheet => { findTerrainSet(sheet, terrainSetId).layer = after; },
    sheet => { findTerrainSet(sheet, terrainSetId).layer = before; });
}
