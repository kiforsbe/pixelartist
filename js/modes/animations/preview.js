// js/modes/animations/preview.js
// The Preview panel in the Animations workbench shows the selected column's
// frame: from the real layers, or from a filter dialog's override layers
// while one previews. A dialog's Cancel re-renders from here, so a cancelled
// filter never lingers. During playback the timeline pushes each frame on
// top of this.
import { flattenSheetLayers } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, currentContextLayers } from '../../host/document-helpers.js';
import { activeFloating } from '../../components/canvas/float-session.js';
import { timelineColumns, selectedColumn } from './application/timeline-model.js';

export function renderAnimationsPreview({ overrideLayers = null } = {}) {
  const sheet = activeSheet('sprite');
  if (!sheet) return { bitmap: null };
  const selection = getEditorHost().selections.get({ kind: 'sprite-sheet', id: sheet.id }) ?? {};
  const columns = timelineColumns(sheet);
  const frameId = columns[selectedColumn(columns, selection)]?.frameId;
  const frame = sheet.frames.find(f => f.id === frameId);
  if (!frame) return { bitmap: null };
  const flat = overrideLayers
    ? flattenSheetLayers(overrideLayers, sheet.width, sheet.height, null, sheet.id)
    : flattenSheetLayers(currentContextLayers(), sheet.width, sheet.height, activeFloating(), sheet.id);
  return { bitmap: copyRegion(flat, frame.x, frame.y, frame.w, frame.h) };
}
