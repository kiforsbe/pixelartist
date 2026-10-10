import { getEditorHost } from './runtime.js';
import { findLayer, sheetLayers } from '../core/model.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function activeSheet(kind = null) {
  const host = getEditorHost();
  const doc = host?.store.getState().session.activeDocument;
  if (!doc || (doc.kind !== 'sprite-sheet' && doc.kind !== 'tile-sheet')) return null;
  const sheet = host.projects.project?.sheets.find(s => s.id === doc.id) ?? null;
  return sheet && (!kind || sheet.kind === kind) ? sheet : null;
}

export function activeMap() {
  const host = getEditorHost();
  const doc = host?.store.getState().session.activeDocument;
  if (!doc || doc.kind !== 'map') return null;
  return host.projects.project?.maps?.find(m => m.id === doc.id) ?? null;
}

export function activeLayer() {
  const sheet = activeSheet();
  if (!sheet) return null;
  const layerId = getEditorHost().selections.get(sheetDocument(sheet))?.layerId ?? null;
  return findLayer(sheet.layerTree, layerId);
}

// The layer an edit may write into: the active layer unless it is locked.
// Every pixel-writing path (paint, fill, select-delete, floats, paste,
// filters) resolves its target through this, never through activeLayer().
export function activeEditableLayer() {
  const layer = activeLayer();
  return layer && !layer.locked ? layer : null;
}

// Every layer of the active sheet, bottom first: what the sheet renders.
// (Animations used to scope this to their own layer group.)
export function currentContextLayers() {
  const sheet = activeSheet();
  return sheet ? sheetLayers(sheet) : [];
}

// The layers an "all layers" edit touches: every unlocked layer.
export function activeLayerScope() {
  const sheet = activeSheet();
  return sheet ? sheetLayers(sheet).filter(l => !l.locked) : [];
}
