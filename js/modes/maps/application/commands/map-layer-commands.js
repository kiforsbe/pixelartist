import { createMapLayer, refreshMapBounds } from '../../../../core/model.js';
import { markDirty } from '../../../../app/state.js';

function findMap(project, mapId) { return project.maps.find(m => m.id === mapId) ?? null; }

export function addMapLayer(services, mapId, type) {
  let createdId = null;
  services.projects.mutate('add map layer', project => {
    const map = findMap(project, mapId);
    const layer = createMapLayer(map, { type });
    createdId = layer.id;
  });
  markDirty();
  return createdId;
}

export function deleteMapLayer(services, mapId, layerId) {
  const map = findMap(services.projects.project, mapId);
  const layer = map?.layers.find(l => l.id === layerId);
  if (!layer) return;
  const index = map.layers.indexOf(layer);
  const command = {
    label: 'delete map layer',
    do: () => services.projects.mutate('delete map layer', project => {
      const map = findMap(project, mapId);
      map.layers = map.layers.filter(l => l.id !== layerId);
      refreshMapBounds(project, map);
    }),
    undo: () => services.projects.mutate('delete map layer', project => {
      const map = findMap(project, mapId);
      if (!map.layers.some(l => l.id === layerId)) map.layers.splice(index, 0, layer);
      refreshMapBounds(project, map);
    }),
  };
  services.history.execute(command);
  markDirty();
}
