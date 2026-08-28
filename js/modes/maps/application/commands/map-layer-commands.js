import { createMapLayer } from '../../../../core/model.js';
import { runCommand } from './map-paint-commands.js';

function findMap(project, mapId) { return project.maps.find(m => m.id === mapId) ?? null; }

export function addMapLayer(services, mapId, type) {
  let created = null;
  runCommand(services, mapId, 'add map layer',
    map => {
      if (!created) created = createMapLayer(map, { type });
      else if (!map.layers.includes(created)) map.layers.push(created);
    },
    map => { map.layers = map.layers.filter(l => l !== created); });
  return created?.id ?? null;
}

export function deleteMapLayer(services, mapId, layerId) {
  const map = findMap(services.projects.project, mapId);
  const layer = map?.layers.find(l => l.id === layerId);
  if (!layer) return;
  const index = map.layers.indexOf(layer);
  runCommand(services, mapId, 'delete map layer',
    map => { map.layers = map.layers.filter(l => l.id !== layerId); },
    map => { if (!map.layers.some(l => l.id === layerId)) map.layers.splice(index, 0, layer); });
}

export function renameMapLayer(services, mapId, layerId, name) {
  const map = findMap(services.projects.project, mapId);
  const layer = map?.layers.find(candidate => candidate.id === layerId);
  if (!layer || layer.name === name) return;
  const before = layer.name;
  runCommand(services, mapId, 'rename map layer',
    target => { const candidate = target.layers.find(item => item.id === layerId); if (candidate) candidate.name = name; },
    target => { const candidate = target.layers.find(item => item.id === layerId); if (candidate) candidate.name = before; });
}

// Ports renderMapLayer's opacity change handler (layers-panel.js:746).
export function setMapLayerOpacity(services, mapId, layerId, opacity) {
  const map = findMap(services.projects.project, mapId);
  const layer = map?.layers.find(l => l.id === layerId);
  if (!layer || layer.opacity === opacity) return;
  const before = layer.opacity;
  runCommand(services, mapId, 'map layer opacity',
    map => { map.layers.find(l => l.id === layerId).opacity = opacity; },
    map => { map.layers.find(l => l.id === layerId).opacity = before; });
}
