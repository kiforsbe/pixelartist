// js/modes/tiles/application/commands/tile-editor-commands.js
import { setSlot } from '../../../../core/neighbors.js';
import { runCommand } from './tile-sheet-commands.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
function findTile(sheet, tileId) { return sheet.tiles.find(t => t.id === tileId) ?? null; }

export function setTileNeighborSlot(services, sheetId, tileId, dir, slot) {
  const sheet = findSheet(services.projects.project, sheetId);
  const tile = findTile(sheet, tileId);
  if (!tile) return;
  const before = tile.neighbors ? structuredClone(tile.neighbors) : null;
  runCommand(services, sheetId, 'edit tile neighbor slot',
    sheet => { const t = findTile(sheet, tileId); if (t) setSlot(t, dir, slot); },
    sheet => { const t = findTile(sheet, tileId); if (t) t.neighbors = before ? structuredClone(before) : undefined; });
}
