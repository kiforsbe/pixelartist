import { getEditorHost } from './runtime.js';
import { findLayer, layerAnimationContext, flattenLayers, sheetLayers, contextLayers as modelContextLayers } from '../core/model.js';

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

export function currentContextLayers() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
  return modelContextLayers(sheet, animationId);
}

export function activeLayerScope() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const ctx = layerAnimationContext(sheet, activeLayer());
  return ctx ? flattenLayers(ctx.group) : sheetLayers(sheet);
}
