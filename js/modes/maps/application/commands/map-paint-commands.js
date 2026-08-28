// js/modes/maps/application/commands/map-paint-commands.js
import { findSheet, terrainAt, terrainResolution } from '../map-geometry.js';
import { refreshMapBounds } from '../../../../core/model.js';
import { newId } from '../../../../core/palettes.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';

function findMap(project, mapId) { return project.maps.find(m => m.id === mapId) ?? null; }
function findLayer(map, layerId) { return map?.layers.find(l => l.id === layerId) ?? null; }
function finitePoint(point) { return Number.isFinite(point?.x) && Number.isFinite(point?.y); }

export function runCommand(services, mapId, label, apply, revert) {
  runEntityCommand(services, label, project => findMap(project, mapId), apply, revert, {
    after: (project, map) => refreshMapBounds(project, map),
  });
}

export function paintMapTile(services, mapId, layerId, sheetId, tileId, at) {
  if (!finitePoint(at)) return;
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const old = layer?.tiles.find(t => t.x === at.x && t.y === at.y);
  const oldIndex = old ? layer.tiles.indexOf(old) : -1;
  if (old?.sheetId === sheetId && old?.tileId === tileId) return;
  const entry = { id: newId('mi'), sheetId, tileId, x: at.x, y: at.y };
  runCommand(services, mapId, 'place map tile',
    map => { const layer = findLayer(map, layerId); if (old) layer.tiles = layer.tiles.filter(t => t.id !== old.id); layer.tiles.push(entry); },
    map => { const layer = findLayer(map, layerId); layer.tiles = layer.tiles.filter(t => t.id !== entry.id); if (old) layer.tiles.splice(oldIndex, 0, old); });
}

export function eraseMapTile(services, mapId, layerId, at) {
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const found = layer?.tiles.find(t => t.x === at.x && t.y === at.y);
  if (!found) return;
  const index = layer.tiles.indexOf(found);
  runCommand(services, mapId, 'erase map tile',
    map => { const layer = findLayer(map, layerId); layer.tiles = layer.tiles.filter(t => t.id !== found.id); },
    map => { const layer = findLayer(map, layerId); if (!layer.tiles.some(t => t.id === found.id)) layer.tiles.splice(index, 0, found); });
}

export function paintMapTerrain(services, mapId, layerId, sheetId, terrainSetId, at) {
  if (!finitePoint(at)) return;
  const project = services.projects.project;
  const layer = findLayer(findMap(project, mapId), layerId);
  const sheet = findSheet(project, sheetId);
  const terrain = sheet?.terrainSets.find(t => t.id === terrainSetId);
  if (layer && sheet && terrain && terrainAt(layer, sheet, terrain, at.x, at.y)) return;
  const entry = { id: newId('mt'), sheetId, terrainSetId, x: at.x, y: at.y };
  runCommand(services, mapId, 'paint map terrain',
    map => { findLayer(map, layerId).terrain.push(entry); },
    map => { const layer = findLayer(map, layerId); layer.terrain = layer.terrain.filter(t => t.id !== entry.id); });
}

export function eraseMapTerrain(services, mapId, layerId, sheetId, terrainSetId, at) {
  const project = services.projects.project;
  const layer = findLayer(findMap(project, mapId), layerId);
  const sheet = findSheet(project, sheetId);
  const terrain = sheet?.terrainSets.find(t => t.id === terrainSetId);
  const found = layer && sheet && terrain ? terrainAt(layer, sheet, terrain, at.x, at.y) : null;
  if (!found) return;
  const index = layer.terrain.indexOf(found);
  runCommand(services, mapId, 'erase map terrain',
    map => { const layer = findLayer(map, layerId); layer.terrain = layer.terrain.filter(t => t.id !== found.id); },
    map => { const layer = findLayer(map, layerId); if (!layer.terrain.some(t => t.id === found.id)) layer.terrain.splice(index, 0, found); });
}

export function paintMapSprite(services, mapId, layerId, sheetId, kind, assetId, at) {
  if (!finitePoint(at)) return;
  const entry = { id: newId('ms'), sheetId, kind, assetId, x: at.x, y: at.y };
  runCommand(services, mapId, 'place map sprite',
    map => { findLayer(map, layerId).sprites.push(entry); },
    map => { const layer = findLayer(map, layerId); layer.sprites = layer.sprites.filter(s => s.id !== entry.id); });
}

export function eraseMapSprite(services, mapId, layerId, itemId) {
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const found = layer?.sprites.find(s => s.id === itemId);
  if (!found) return;
  const index = layer.sprites.indexOf(found);
  runCommand(services, mapId, 'erase map sprite',
    map => { const layer = findLayer(map, layerId); layer.sprites = layer.sprites.filter(s => s.id !== found.id); },
    map => { const layer = findLayer(map, layerId); if (!layer.sprites.some(s => s.id === found.id)) layer.sprites.splice(index, 0, found); });
}

function findItemCollectionKey(layer, itemId) {
  if (layer.tiles?.some(i => i.id === itemId)) return 'tiles';
  if (layer.terrain?.some(i => i.id === itemId)) return 'terrain';
  if (layer.sprites?.some(i => i.id === itemId)) return 'sprites';
  return null;
}

export function moveMapItem(services, mapId, layerId, itemId, before, after) {
  if (!finitePoint(before) || !finitePoint(after)) return;
  runCommand(services, mapId, 'move map item',
    map => {
      const layer = findLayer(map, layerId);
      const key = findItemCollectionKey(layer, itemId);
      const item = key && layer[key].find(i => i.id === itemId);
      if (item) Object.assign(item, after);
    },
    map => {
      const layer = findLayer(map, layerId);
      const key = findItemCollectionKey(layer, itemId);
      const item = key && layer[key].find(i => i.id === itemId);
      if (item) Object.assign(item, before);
    });
}

export function deleteMapItem(services, mapId, layerId, itemId) {
  const layer = findLayer(findMap(services.projects.project, mapId), layerId);
  const key = layer ? findItemCollectionKey(layer, itemId) : null;
  const found = key ? layer[key].find(i => i.id === itemId) : null;
  if (!found) return;
  const index = layer[key].indexOf(found);
  runCommand(services, mapId, 'delete map item',
    map => { const layer = findLayer(map, layerId); layer[key] = layer[key].filter(i => i.id !== itemId); },
    map => { const layer = findLayer(map, layerId); if (!layer[key].some(i => i.id === itemId)) layer[key].splice(index, 0, found); });
}
