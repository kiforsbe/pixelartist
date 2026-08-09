// js/modes/tiles/application/commands/tile-layer-commands.js
import { runCommand } from './tile-sheet-commands.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

export function addTileLayer(services, sheetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.layers.slice();
  sheet.layers.push(name);
  const after = sheet.layers.slice();
  runCommand(services, sheetId, 'add layer name',
    sheet => { sheet.layers = after.slice(); },
    sheet => { sheet.layers = before.slice(); });
}

export function removeTileLayer(services, sheetId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const before = sheet.layers.slice();
  const assignments = sheet.tiles.map(tile => ({ id: tile.id, layer: tile.layer }));
  sheet.layers = sheet.layers.filter(layer => layer !== name);
  for (const tile of sheet.tiles) if (tile.layer === name) tile.layer = undefined;
  const after = sheet.layers.slice();
  runCommand(services, sheetId, 'remove layer name',
    sheet => {
      sheet.layers = after.slice();
      for (const tile of sheet.tiles) if (tile.layer === name) tile.layer = undefined;
    },
    sheet => {
      sheet.layers = before.slice();
      for (const entry of assignments) {
        const tile = sheet.tiles.find(t => t.id === entry.id);
        if (tile) tile.layer = entry.layer;
      }
    });
}
