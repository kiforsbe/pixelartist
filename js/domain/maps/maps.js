import { newId } from '../shared/ids.js';

export const DEFAULT_MAP_BOUNDS = Object.freeze({ x: 0, y: 0, w: 320, h: 240 });

// Maps reference source sheet assets by id, so they remain lightweight and
// always reflect edits to their sprite, animation, tile, and terrain sources.
export function createMap(project, { name = 'Map', gridW = 16, gridH = 16 } = {}) {
  const map = {
    id: newId('mp'), name,
    snap: { mode: 'map', gridW: Math.max(1, gridW), gridH: Math.max(1, gridH) },
    bounds: { ...DEFAULT_MAP_BOUNDS },
    layers: [{ id: newId('ml'), name: 'Tile Layer 1', type: 'tile', visible: true, locked: false, opacity: 1, tiles: [], terrain: [] }],
  };
  project.maps.push(map);
  return map;
}

export function createMapLayer(map, { name, type }) {
  const layer = {
    id: newId('ml'),
    name: name ?? (type === 'sprite' ? 'Sprite Layer' : 'Tile Layer'),
    type,
    visible: true,
    locked: false,
    opacity: 1,
    ...(type === 'sprite' ? { sprites: [] } : { tiles: [], terrain: [] }),
  };
  map.layers.push(layer);
  return layer;
}

function positiveSize(value, fallback = 16) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function placementSize(project, item) {
  const sheet = project?.sheets?.find(candidate => candidate.id === item.sheetId);
  if ('tileId' in item) {
    const tile = sheet?.tiles?.find(candidate => candidate.id === item.tileId);
    return { w: positiveSize(tile?.w), h: positiveSize(tile?.h) };
  }
  if ('terrainSetId' in item) {
    const terrain = sheet?.terrainSets?.find(candidate => candidate.id === item.terrainSetId);
    return { w: positiveSize(terrain?.tileW), h: positiveSize(terrain?.tileH) };
  }
  if (item.kind === 'animation') {
    const animation = sheet?.animations?.find(candidate => candidate.id === item.assetId);
    const frames = (animation?.frames ?? [])
      .map(entry => sheet?.frames?.find(frame => frame.id === entry.frameId))
      .filter(Boolean);
    if (frames.length) {
      return {
        w: Math.max(...frames.map(frame => positiveSize(frame.w))),
        h: Math.max(...frames.map(frame => positiveSize(frame.h))),
      };
    }
  }
  const frame = sheet?.frames?.find(candidate => candidate.id === item.assetId);
  return { w: positiveSize(frame?.w), h: positiveSize(frame?.h) };
}

export function mapContentBounds(project, map) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const layer of map?.layers ?? []) {
    const items = layer.type === 'sprite'
      ? (layer.sprites ?? [])
      : [...(layer.tiles ?? []), ...(layer.terrain ?? [])];
    for (const item of items) {
      const x = Number.isFinite(item.x) ? item.x : 0;
      const y = Number.isFinite(item.y) ? item.y : 0;
      const size = placementSize(project, item);
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + size.w);
      bottom = Math.max(bottom, y + size.h);
    }
  }
  if (left === Infinity) return { ...DEFAULT_MAP_BOUNDS };
  const gridW = positiveSize(map?.snap?.gridW, 1);
  const gridH = positiveSize(map?.snap?.gridH, 1);
  const x = Math.floor(left / gridW) * gridW;
  const y = Math.floor(top / gridH) * gridH;
  const alignedRight = Math.ceil(right / gridW) * gridW;
  const alignedBottom = Math.ceil(bottom / gridH) * gridH;
  return { x, y, w: alignedRight - x, h: alignedBottom - y };
}

export function refreshMapBounds(project, map) {
  if (!map) return null;
  const next = mapContentBounds(project, map);
  const prior = map.bounds;
  if (!prior || prior.x !== next.x || prior.y !== next.y || prior.w !== next.w || prior.h !== next.h) {
    map.bounds = next;
  }
  return map.bounds;
}
