// js/modes/tiles/application/commands/tile-layer-commands.js
import { runCommand } from './tile-sheet-commands.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

export function addTileLayer(services, sheetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.tileLayerNames.slice();
  sheet.tileLayerNames.push(name);
  const after = sheet.tileLayerNames.slice();
  runCommand(services, sheetId, 'add layer name',
    sheet => { sheet.tileLayerNames = after.slice(); },
    sheet => { sheet.tileLayerNames = before.slice(); });
}

export function removeTileLayer(services, sheetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.tileLayerNames.slice();
  const assignments = sheet.tiles.map(tile => ({ id: tile.id, layer: tile.layer }));
  const terrainAssignments = (sheet.terrainSets ?? []).map(terrain => ({ id: terrain.id, layer: terrain.layer }));
  const after = before.filter(layer => layer !== name);
  runCommand(services, sheetId, 'remove layer name',
    sheet => {
      sheet.tileLayerNames = after.slice();
      for (const tile of sheet.tiles) if (tile.layer === name) tile.layer = undefined;
      for (const terrain of sheet.terrainSets ?? []) if (terrain.layer === name) terrain.layer = undefined;
    },
    sheet => {
      sheet.tileLayerNames = before.slice();
      for (const entry of assignments) {
        const tile = sheet.tiles.find(t => t.id === entry.id);
        if (tile) tile.layer = entry.layer;
      }
      for (const entry of terrainAssignments) {
        const terrain = sheet.terrainSets.find(t => t.id === entry.id);
        if (terrain) terrain.layer = entry.layer;
      }
    });
}
