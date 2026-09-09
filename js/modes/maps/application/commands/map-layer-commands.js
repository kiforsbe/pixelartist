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

// Reordering a map's layers changes what covers what, so it belongs on the
// undo stack like every other layer edit -- the sprite/tile layer tree has
// gone through a moveNode command all along; only maps still spliced the
// array in place from the panel. `delta` matches that handler's convention:
// +1 moves the layer up the list (later = drawn on top), -1 moves it down.
export function moveMapLayer(services, mapId, layerId, delta) {
  const map = findMap(services.projects.project, mapId);
  const from = map?.layers.findIndex(l => l.id === layerId) ?? -1;
  if (from === -1) return;
  const to = from + delta;
  if (to < 0 || to >= map.layers.length) return;
  const move = (target, at, next) => {
    const [layer] = target.layers.splice(at, 1);
    target.layers.splice(next, 0, layer);
  };
  runCommand(services, mapId, 'reorder map layer',
    target => move(target, from, to),
    target => move(target, to, from));
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
