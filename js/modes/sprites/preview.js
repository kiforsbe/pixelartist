import { state, activeSheet, currentContextLayers } from '../../app/state.js';
import { flattenSheetLayers } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';

export function renderSpritePreview({ overrideLayers = null } = {}) {
  if (state.selectedAnimationId) return { managed: true };
  const sheet = activeSheet();
  if (!sheet) return { bitmap: null };
  const layers = overrideLayers ?? currentContextLayers();
  const flat = flattenSheetLayers(layers, sheet.width, sheet.height, state.floating, sheet.id);
  const frameId = state.editingFrameId ?? state.selectedFrameId;
  const frame = sheet.frames.find(candidate => candidate.id === frameId);
  return { bitmap: frame ? copyRegion(flat, frame.x, frame.y, frame.w, frame.h) : flat };
}
