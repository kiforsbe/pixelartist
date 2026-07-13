// Pure builders for the "Frames JSON" / "Tiles JSON" export shapes (see
// task-19 brief). Kept free of DOM/io concerns so they're node-testable;
// main.js wraps the result in a Blob and hands it to io.downloadBlob.
import { tileCount } from '../core/model.js';
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

// { sheet, tileWidth, tileHeight, columns, count,
//   tiles: [{ index, name: <or null>, neighbors: { n: {mode,tileIndex,flipH,flipV}, ... } }] }
// Only tiles with a stored name or a stored neighbor preset are listed;
// neighbors are always exported as the full 8-dir preset (getPreset fills
// unset directions with the 'same' default).
export function buildTilesJson(sheet) {
  const count = tileCount(sheet);
  const columns = Math.floor(sheet.width / sheet.tile.tileWidth);
  const tiles = [];
  for (let index = 0; index < count; index++) {
    const name = sheet.tile.names[index] ?? null;
    const hasPreset = !!sheet.tile.neighbors[index];
    if (!name && !hasPreset) continue;
    const preset = getPreset(sheet, index);
    const neighbors = {};
    for (const d of NEIGHBOR_DIRS) neighbors[d] = { ...preset[d] };
    tiles.push({ index, name, neighbors });
  }
  return {
    sheet: `${sheet.name}.png`,
    tileWidth: sheet.tile.tileWidth,
    tileHeight: sheet.tile.tileHeight,
    columns,
    count,
    tiles,
  };
}
