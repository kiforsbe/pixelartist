import { DIRECTION_OFFSETS, resolveTerrainSlot, maskToBlobIndex } from '../../../core/blob47.js';

// CanvasView needs finite dimensions; this generous, centred work area keeps
// persisted map coordinates naturally signed while remaining effectively
// infinite for normal test scenes.
export const MAP_ORIGIN = 4096, MAP_SPAN = MAP_ORIGIN * 2;

export function mapXY(ev) { return { x: ev.x - MAP_ORIGIN, y: ev.y - MAP_ORIGIN }; }

export function findSheet(project, id) { return project?.sheets.find(s => s.id === id) ?? null; }

export function snap(map, p, size) {
  const mode = map.snap?.mode ?? 'map';
  if (mode === 'off') return p;
  const w = mode === 'asset' ? Math.max(1, size.w) : Math.max(1, map.snap.gridW);
  const h = mode === 'asset' ? Math.max(1, size.h) : Math.max(1, map.snap.gridH);
  return { x: Math.floor(p.x / w) * w, y: Math.floor(p.y / h) * h };
}

export function terrainAt(layer, sheet, terrain, x, y) {
  return layer.terrain.find(t => t.sheetId === sheet.id && t.terrainSetId === terrain.id && t.x === x && t.y === y);
}

export function terrainResolution(layer, sheet, terrain, x, y) {
  if (!layer || !sheet || !terrain) return null;
  let mask = 0;
  for (const { dx, dy, bit } of DIRECTION_OFFSETS) {
    if (terrainAt(layer, sheet, terrain, x + dx * terrain.tileW, y + dy * terrain.tileH)) mask |= bit;
  }
  const slot = resolveTerrainSlot(terrain, maskToBlobIndex[mask]);
  const tile = slot && sheet.tiles.find(candidate => candidate.id === slot.tileId);
  return tile ? { ...slot, tile } : null;
}

export function selectedTile(project, asset) {
  const sheet = findSheet(project, asset.tileSheetId);
  return { sheet, tile: sheet?.tiles?.find(t => t.id === asset.tileId) ?? null };
}

export function selectedTerrain(project, asset) {
  const sheet = findSheet(project, asset.terrainSheetId);
  return { sheet, terrain: sheet?.terrainSets?.find(t => t.id === asset.terrainSetId) ?? null };
}

export function selectedSprite(project, asset) {
  const sheet = findSheet(project, asset.spriteSheetId);
  if (!sheet) return { sheet: null, item: null, size: { w: 16, h: 16 } };
  const item = asset.spriteKind === 'animation'
    ? sheet.animations.find(a => a.id === asset.spriteId)
    : sheet.frames.find(f => f.id === asset.spriteId);
  const frame = asset.spriteKind === 'animation'
    ? sheet.frames.find(f => f.id === item?.frames?.[0]?.frameId)
    : item;
  return { sheet, item, size: { w: frame?.w ?? 16, h: frame?.h ?? 16 } };
}

// First-frame sizing (not the live-playing frame): sprite footprint is
// treated as constant across an animation's frames, matching selectedSprite.
function spriteFirstFrame(project, entry) {
  const sheet = findSheet(project, entry.sheetId);
  if (!sheet) return null;
  if (entry.kind === 'animation') {
    const anim = sheet.animations.find(a => a.id === entry.assetId);
    return sheet.frames.find(f => f.id === anim?.frames?.[0]?.frameId) ?? null;
  }
  return sheet.frames.find(f => f.id === entry.assetId) ?? null;
}

export function itemSize(project, item) {
  if ('tileId' in item) {
    const tile = findSheet(project, item.sheetId)?.tiles.find(t => t.id === item.tileId);
    return { w: tile?.w ?? 16, h: tile?.h ?? 16 };
  }
  if ('terrainSetId' in item) {
    const terrain = findSheet(project, item.sheetId)?.terrainSets.find(t => t.id === item.terrainSetId);
    return { w: terrain?.tileW ?? 16, h: terrain?.tileH ?? 16 };
  }
  const frame = spriteFirstFrame(project, item);
  return { w: frame?.w ?? 16, h: frame?.h ?? 16 };
}

export function hitSprite(project, layer, p) {
  for (let i = layer.sprites.length - 1; i >= 0; i--) {
    const entry = layer.sprites[i];
    const size = itemSize(project, entry);
    if (p.x >= entry.x && p.y >= entry.y && p.x < entry.x + size.w && p.y < entry.y + size.h) return entry;
  }
  return null;
}

export function hitMapItem(project, layer, p) {
  if (layer.type === 'sprite') return hitSprite(project, layer, p);
  for (let i = layer.tiles.length - 1; i >= 0; i--) {
    const item = layer.tiles[i], sheet = findSheet(project, item.sheetId), tile = sheet?.tiles.find(t => t.id === item.tileId);
    if (tile && p.x >= item.x && p.y >= item.y && p.x < item.x + tile.w && p.y < item.y + tile.h) return item;
  }
  for (let i = layer.terrain.length - 1; i >= 0; i--) {
    const item = layer.terrain[i], sheet = findSheet(project, item.sheetId), terrain = sheet?.terrainSets.find(t => t.id === item.terrainSetId);
    if (terrain && p.x >= item.x && p.y >= item.y && p.x < item.x + terrain.tileW && p.y < item.y + terrain.tileH) return item;
  }
  return null;
}

export function brushSpacing(map, tool, asset, project) {
  if (map.snap?.mode === 'off') return null;
  if (map.snap?.mode !== 'asset') return { w: Math.max(1, map.snap.gridW), h: Math.max(1, map.snap.gridH) };
  if (tool === 'maptile' && asset.tileKind === 'terrain') {
    const { terrain } = selectedTerrain(project, asset);
    return terrain ? { w: terrain.tileW, h: terrain.tileH } : null;
  }
  if (tool === 'maptile') {
    const { tile } = selectedTile(project, asset);
    return tile ? { w: tile.w, h: tile.h } : null;
  }
  if (tool === 'mapsprite') return selectedSprite(project, asset).size;
  return null;
}

export function strokeSamples(map, from, to, spacing) {
  if (!from || !spacing) return [to];
  const steps = Math.max(1, Math.ceil(Math.abs(to.x - from.x) / spacing.w), Math.ceil(Math.abs(to.y - from.y) / spacing.h));
  return Array.from({ length: steps }, (_, index) => {
    const amount = (index + 1) / steps;
    return { x: from.x + (to.x - from.x) * amount, y: from.y + (to.y - from.y) * amount };
  });
}

export function claimStrokeCell(stroke, key) {
  if (!stroke || stroke.visited.has(key)) return false;
  stroke.visited.add(key);
  return true;
}
