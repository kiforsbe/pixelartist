// js/modes/tiles/application/geometry/autotile-geometry.js
import { NEIGHBOR_BITS, blobIndexToMask, BLOB47_PAINT_CELLS } from '../../../../core/blob47.js';

export function describeMask(mask) {
  const names = {
    [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE',
    [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE',
    [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW',
    [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW',
  };
  const parts = Object.keys(names).filter(bit => mask & Number(bit)).map(bit => names[bit]);
  return parts.length ? parts.join(' + ') : 'isolated';
}

export function terrainPaintGrid(sheet, terrainSet) {
  if (!terrainSet || sheet.width % terrainSet.tileW || sheet.height % terrainSet.tileH) return null;
  return { cols: sheet.width / terrainSet.tileW, rows: sheet.height / terrainSet.tileH };
}

export function paintTileAt(sheet, terrainSet, x, y) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid || x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return null;
  const col = Math.floor(x / terrainSet.tileW), row = Math.floor(y / terrainSet.tileH);
  const tx = col * terrainSet.tileW, ty = row * terrainSet.tileH;
  return sheet.tiles.find(t => t.x === tx && t.y === ty && t.w === terrainSet.tileW && t.h === terrainSet.tileH) ?? null;
}

export function paintCellAt(tile, x, y) {
  const col = Math.min(2, Math.floor(((x - tile.x) * 3) / tile.w));
  const row = Math.min(2, Math.floor(((y - tile.y) * 3) / tile.h));
  return BLOB47_PAINT_CELLS.find(c => c.col === col && c.row === row) ?? null;
}

export function persistedPaintMask(tile, terrainSet) {
  return tile?.terrainSetId === terrainSet.id && tile.blobIndex != null ? blobIndexToMask[tile.blobIndex] : 0;
}

export function strokePaintMask(tile, terrainSet, stroke) {
  return stroke?.masks.get(tile.id) ?? persistedPaintMask(tile, terrainSet);
}

// Pure validation + diff for laying a neat full-sheet lattice over a terrain
// set's tile size, without ever creating a Tile Grid. A pre-existing tile is
// safe to reuse only when it exactly matches one cell; anything spanning
// cells would make a direct paint target ambiguous. Returns either
// `{ error }` or `{ grid, missing }` -- `missing` is the list of cell rects
// (`{x,y,w,h}`) that still need a standalone tile created by the caller.
export function planTerrainPaintCells(sheet, terrainSet) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid) return { error: `Sheet size must be divisible by ${terrainSet.tileW}×${terrainSet.tileH}.` };
  const expected = new Map();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const x = col * terrainSet.tileW, y = row * terrainSet.tileH;
    expected.set(`${x},${y}`, { x, y, w: terrainSet.tileW, h: terrainSet.tileH });
  }
  for (const tile of sheet.tiles) {
    const e = expected.get(`${tile.x},${tile.y}`);
    if (!e || tile.gridId != null || tile.w !== e.w || tile.h !== e.h) {
      return { error: 'Existing tiles must align exactly to the terrain size before terrain painting can start.' };
    }
    if (sheet.tiles.filter(t => t.x === tile.x && t.y === tile.y && t.w === tile.w && t.h === tile.h).length > 1) {
      return { error: 'Multiple tile records occupy the same terrain cell. Remove the duplicate before terrain painting.' };
    }
  }
  const missing = [];
  for (const e of expected.values()) {
    if (!sheet.tiles.some(t => t.x === e.x && t.y === e.y && t.w === e.w && t.h === e.h)) missing.push(e);
  }
  return { grid, missing };
}
