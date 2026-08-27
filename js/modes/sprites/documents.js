import { createSheet, removeSheet, sheetLayers } from '../../core/model.js';

export const spriteDocumentProvider = {
  kind: 'sprite-sheet',
  list: project => project.sheets.filter(sheet => sheet.kind === 'sprite'),
  get: (project, id) => project.sheets.find(sheet => sheet.kind === 'sprite' && sheet.id === id) ?? null,
  initialSelection: sheet => ({ layerId: sheetLayers(sheet)[0]?.id ?? null, frameId: null, animationId: null }),
  create: (project, input = {}) => createSheet(project, {
    name: input.name ?? 'Sprites', width: input.width ?? project.settings.spriteSheetW,
    height: input.height ?? project.settings.spriteSheetH, kind: 'sprite',
  }),
  rename: (document, name) => { document.name = name; },
  remove: (project, id) => removeSheet(project, id),
};
