// Builds a Tiled .tsx tileset (TMX Map Format) for a tile sheet, with
// <wangsets> built from the sheet's terrainSets. Each terrain set in this
// app is single-material blob-47 autotiling, so it maps to exactly one
// <wangset> with exactly one <wangcolor> (wangid index 1 = "this terrain
// present", index 0 = unset) -- see the export-system design doc.
import { blobIndexToMask, resolveTerrainSlot } from '../core/blob47.js';

// wangid order per the TMX spec: top, topright, right, bottomright, bottom,
// bottomleft, left, topleft -- exactly blob47's N,NE,E,SE,S,SW,W,NW bit
// order, so each direction's presence bit maps 1:1 to a wangid slot.
const WANG_BITS = [1, 2, 4, 8, 16, 32, 64, 128];

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

export function buildTiledTsx(sheet) {
  // Tiled requires one uniform tile grid per .tsx file; a sheet with mixed
  // per-tile sizes (this app allows that -- see exports.js's buildTilesJson
  // comment) can't be fully represented. Falls back to the first terrain
  // set's tile size, else the first tile's, else the whole sheet.
  const gridW = sheet.terrainSets?.[0]?.tileW ?? sheet.tiles[0]?.w ?? sheet.width;
  const gridH = sheet.terrainSets?.[0]?.tileH ?? sheet.tiles[0]?.h ?? sheet.height;
  const cols = Math.floor(sheet.width / gridW);
  const rows = Math.floor(sheet.height / gridH);

  // Tiled infers each tileid purely from raster position (row*columns+col)
  // on the tileset image -- NOT from insertion order in sheet.tiles, which
  // can diverge from raster position: resizeGridAxis's 'start'-side growth
  // (js/core/tilegrids.js) always appends new cells to the END of
  // sheet.tiles regardless of where they land on the grid, and multiple
  // tileGrids/standalone tiles can coexist on one sheet in creation order.
  // Derive tileid from each tile's own (x,y) instead of its array index.
  const tileIdByTileId = new Map(sheet.tiles.map(t =>
    [t.id, Math.round(t.y / gridH) * cols + Math.round(t.x / gridW)]));

  const wangsets = (sheet.terrainSets ?? []).map(ts => {
    const wangtiles = [];
    for (let blobIndex = 0; blobIndex < blobIndexToMask.length; blobIndex++) {
      const resolved = resolveTerrainSlot(ts, blobIndex);
      if (!resolved) continue;
      const tileIndex = tileIdByTileId.get(resolved.tileId);
      if (tileIndex == null) continue;
      const mask = blobIndexToMask[blobIndex];
      const wangid = WANG_BITS.map(bit => (mask & bit) ? 1 : 0).join(',');
      wangtiles.push(`<wangtile tileid="${tileIndex}" wangid="${wangid}"/>`);
    }
    return `<wangset name="${escapeXml(ts.name)}" type="mixed" tile="-1">` +
      `<wangcolor name="${escapeXml(ts.name)}" color="#ff0000" tile="-1" probability="1"/>` +
      wangtiles.join('') + `</wangset>`;
  });

  const wangsetsXml = wangsets.length ? `<wangsets>${wangsets.join('')}</wangsets>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<tileset version="1.10" tiledversion="1.10.2" name="${escapeXml(sheet.name)}" ` +
    `tilewidth="${gridW}" tileheight="${gridH}" tilecount="${cols * rows}" columns="${cols}">` +
    `<image source="${escapeXml(sheet.name)}.png" width="${sheet.width}" height="${sheet.height}"/>` +
    wangsetsXml +
    `</tileset>\n`;
}
