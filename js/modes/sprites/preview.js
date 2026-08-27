import { activeSheet, currentContextLayers } from '../../host/document-helpers.js';
import { flattenSheetLayers } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeFloating } from '../../components/canvas/float-session.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function renderSpritePreview({ overrideLayers = null } = {}) {
  const sheet = activeSheet('sprite');
  if (!sheet) return { bitmap: null };
  const selection = getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
  if (selection.animationId) return { managed: true };
  const layers = overrideLayers ?? currentContextLayers();
  const flat = flattenSheetLayers(layers, sheet.width, sheet.height, activeFloating(), sheet.id);
  const frameId = selection.editingFrameId ?? selection.frameId ?? null;
  const frame = sheet.frames.find(candidate => candidate.id === frameId);
  return { bitmap: frame ? copyRegion(flat, frame.x, frame.y, frame.w, frame.h) : flat };
}
