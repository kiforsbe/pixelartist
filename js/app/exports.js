// Pure builders for the "Frames JSON" / "Tiles JSON" export shapes (see
// task-19 brief). Kept free of DOM/io concerns so they're node-testable;
// main.js wraps the result in a Blob and hands it to io.downloadBlob.
import { getPreset, NEIGHBOR_DIRS } from '../core/neighbors.js';

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
        duration: af.duration,
      })),
    })),
  };
}

// { sheet, count, tiles: [{ index, name: <or null>, x, y, w, h,
//   neighbors: { n: {mode,tileIndex,flipH,flipV}, ... } }] }
// Only tiles with a stored name or a stored neighbor preset are listed;
// neighbors are always exported as the full 8-dir preset (getPreset fills
// unset directions with the 'same' default). A neighbor slot's internal
// tileId is resolved to that tile's position in sheet.tiles for export
// (mirrors buildFramesJson resolving animation frameId -> frame name).
export function buildTilesJson(sheet) {
  const indexById = new Map(sheet.tiles.map((t, i) => [t.id, i]));
  const tiles = [];
  sheet.tiles.forEach((tile, index) => {
    if (!tile.name && !tile.neighbors) return;
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
    tiles.push({ index, name: tile.name ?? null, x: tile.x, y: tile.y, w: tile.w, h: tile.h, neighbors });
  });
  return { sheet: `${sheet.name}.png`, count: sheet.tiles.length, tiles };
}
