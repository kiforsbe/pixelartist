import { createMap } from '../../core/model.js';

export const mapDocumentProvider = {
  kind: 'map',
  list: project => project.maps ?? [],
  get: (project, id) => project.maps?.find(map => map.id === id) ?? null,
  create: (project, input = {}) => createMap(project, {
    name: input.name ?? 'Map', gridW: input.gridW ?? project.settings.tileW,
    gridH: input.gridH ?? project.settings.tileH,
  }),
  rename: (document, name) => { document.name = name; },
  remove: (project, id) => {
    const index = project.maps?.findIndex(map => map.id === id) ?? -1;
    return index < 0 ? null : project.maps.splice(index, 1)[0];
  },
};
