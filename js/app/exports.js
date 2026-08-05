// Pure builders for the "Frames JSON" / "Tiles JSON" export shapes (see
// task-19 brief). Kept free of DOM/io concerns so they're node-testable;
// main.js wraps the result in a Blob and hands it to io.downloadBlob.
import { getPreset, NEIGHBOR_DIRS } from '../core/neighbors.js';
import { blobIndexToMask, resolveTerrainSlot } from '../core/blob47.js';
import { effectiveDuration, mapContentBounds } from '../core/model.js';

// Portable reference form for the in-project test scene. Asset ids point at
// the accompanying PixelArtist sheets rather than duplicating sheet pixels.
export function buildMapJson(map, project = null) {
  return {
    name: map.name,
    infinite: true,
    bounds: project ? mapContentBounds(project, map) : (map.bounds ? { ...map.bounds } : null),
    snap: { ...map.snap },
    layers: map.layers.map(layer => ({
      name: layer.name, type: layer.type, visible: layer.visible, locked: layer.locked, opacity: layer.opacity,
      ...(layer.type === 'tile'
        ? { tiles: layer.tiles.map(t => ({ ...t })), terrain: layer.terrain.map(t => ({ ...t })) }
        : { sprites: layer.sprites.map(s => ({ ...s })) }),
    })),
  };
}

// { sheet, width, height,
//   frames: [{ name, index, x, y, w, h, pivotX, pivotY }],
//   animations: [{ name, loop, frames: [{ frame: <frame name>, duration }] }] }
export function buildFramesJson(sheet) {
  const nameById = new Map(sheet.frames.map(f => [f.id, f.name]));
  return {
    sheet: `${sheet.name}.png`,
    width: sheet.width,
    height: sheet.height,
    frames: sheet.frames.map((f, index) => ({
      name: f.name, index, x: f.x, y: f.y, w: f.w, h: f.h,
      pivotX: f.pivotX, pivotY: f.pivotY,
    })),
    animations: sheet.animations.map(a => ({
      name: a.name,
      loop: a.loop,
      frames: a.frames.map(af => ({
        frame: nameById.get(af.frameId) ?? null,
        duration: effectiveDuration(a, af),
      })),
    })),
  };
}

// { sheet, count,
//   terrainSets: [{ name, tileW, tileH, slots: { blobIndex: {tileIndex,flipH,flipV,rotate} } }], // omitted if empty
//   layers: [name, ...],                                                                          // omitted if empty
//   tiles: [{ index, name: <or null>, x, y, w, h,
//     neighbors: {...},        // omitted once the tile has a terrainSetId
//     layer: <or omitted>, tags: [<...>] <or omitted if empty> }] }
// A tile is listed if it has a name, manual neighbors, a terrainSetId, a
// layer, or non-empty tags. Neighbors are always exported as the full
// 8-dir preset (getPreset fills unset directions with the 'same' default)
// unless the tile belongs to a terrain set, in which case neighbors are
// derived from the terrain set instead and this per-tile block is dropped.
// A neighbor slot's internal tileId is resolved to that tile's position in
// sheet.tiles for export (mirrors buildFramesJson resolving animation
// frameId -> frame name).
export function buildTilesJson(sheet) {
  const indexById = new Map(sheet.tiles.map((t, i) => [t.id, i]));

  const result = { sheet: `${sheet.name}.png`, count: sheet.tiles.length, tiles: [] };

  if (sheet.terrainSets?.length) {
    result.terrainSets = sheet.terrainSets.map(ts => {
      const slots = {};
      for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
        const resolved = resolveTerrainSlot(ts, blobIndex);
        if (!resolved) continue;
        const tileIndex = indexById.get(resolved.tileId);
        if (tileIndex == null) continue;
        slots[blobIndex] = { tileIndex, flipH: resolved.flipH, flipV: resolved.flipV, rotate: resolved.rotate };
      }
      return { name: ts.name, tileW: ts.tileW, tileH: ts.tileH, slots,
        ...(ts.layer != null ? { layer: ts.layer } : {}) };
    });
  }

  if (sheet.layers?.length) result.layers = sheet.layers.slice();

  sheet.tiles.forEach((tile, index) => {
    if (!tile.name && !tile.neighbors && tile.terrainSetId == null && tile.layer == null && !tile.tags?.length) return;
    const entry = { index, name: tile.name ?? null, x: tile.x, y: tile.y, w: tile.w, h: tile.h };
    if (tile.terrainSetId == null) {
      const preset = getPreset(tile);
      const neighbors = {};
      for (const d of NEIGHBOR_DIRS) {
        const slot = preset[d];
        neighbors[d] = {
          mode: slot.mode,
          tileIndex: slot.tileId != null ? (indexById.get(slot.tileId) ?? null) : null,
          flipH: slot.flipH, flipV: slot.flipV,
        };
      }
      entry.neighbors = neighbors;
    }
    if (tile.layer != null) entry.layer = tile.layer;
    if (tile.tags?.length) entry.tags = tile.tags.slice();
    result.tiles.push(entry);
  });

  return result;
}
