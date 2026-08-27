import { createSheet, removeSheet, sheetLayers } from '../../core/model.js';

export const tileDocumentProvider = {
  kind: 'tile-sheet',
  list: project => project.sheets.filter(sheet => sheet.kind === 'tile'),
  get: (project, id) => project.sheets.find(sheet => sheet.kind === 'tile' && sheet.id === id) ?? null,
  initialSelection: sheet => ({ layerId: sheetLayers(sheet)[0]?.id ?? null, tileId: null, terrainSetId: null }),
  create: (project, input = {}) => createSheet(project, {
    name: input.name ?? 'Tiles', width: input.width ?? project.settings.tileSheetW,
    height: input.height ?? project.settings.tileSheetH, kind: 'tile',
  }),
  rename: (document, name) => { document.name = name; },
  remove: (project, id) => removeSheet(project, id),
};
