import { activeSheet, currentContextLayers } from '../../host/document-helpers.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeFloating } from '../../components/canvas/float-session.js';
import { flattenSheetLayers } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';

export function renderTilePreview({ overrideLayers = null } = {}) {
  const sheet = activeSheet();
  if (!sheet) return { bitmap: null };
  const selection = getEditorHost().selections.get({ kind: 'tile-sheet', id: sheet.id }) ?? {};
  const layers = overrideLayers ?? currentContextLayers();
  const flat = flattenSheetLayers(layers, sheet.width, sheet.height, activeFloating(), sheet.id);
  const tileId = selection.editingTileId ?? selection.tileId ?? null;
  const tile = sheet.tiles.find(candidate => candidate.id === tileId);
  return { bitmap: tile ? copyRegion(flat, tile.x, tile.y, tile.w, tile.h) : flat };
}
