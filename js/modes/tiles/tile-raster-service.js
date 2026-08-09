import { state } from '../../app/state.js';
import { flattenSheet } from '../../core/model.js';
import { createRasterCache } from '../../components/canvas/raster-cache.js';

const cache = createRasterCache();
const thumbnails = new Map();

function flatten(sheet) { return flattenSheet(sheet, state.floating); }

export function invalidateTileRaster() { cache.invalidate(); }

export function getTileSheetCanvas(sheet) {
  return cache.getCanvas(sheet, flatten);
}

export function tileThumbnailUrl(sheet, tile, { flipH = false, flipV = false, rotate = 0 } = {}) {
  const source = cache.getCanvas(sheet, flatten);
  const bitmap = cache.getBitmap(sheet, flatten);
  const key = `${tile.id}|${flipH}|${flipV}|${rotate}`;
  const cached = thumbnails.get(key);
  if (cached?.bitmap === bitmap) return cached.url;

  const scratch = document.createElement('canvas');
  scratch.width = tile.w;
  scratch.height = tile.h;
  const context = scratch.getContext('2d');
  context.imageSmoothingEnabled = false;
  context.save();
  context.translate(flipH ? tile.w : 0, flipV ? tile.h : 0);
  context.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  if (rotate) {
    context.translate(tile.w / 2, tile.h / 2);
    context.rotate((rotate * Math.PI) / 180);
    context.translate(-tile.w / 2, -tile.h / 2);
  }
  context.drawImage(source, tile.x, tile.y, tile.w, tile.h, 0, 0, tile.w, tile.h);
  context.restore();
  const url = scratch.toDataURL();
  thumbnails.set(key, { url, bitmap });
  return url;
}
