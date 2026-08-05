import { state } from '../../app/state.js';
import { flattenSheet } from '../../core/model.js';

let sheetReference = null;
let bitmap = null;
let dirty = true;
let canvas = null;
let canvasBitmap = null;
let generation = 0;
const thumbnails = new Map();

export function invalidateTileRaster() { dirty = true; }

function getBitmap(sheet) {
  if (dirty || sheetReference !== sheet || !bitmap) {
    bitmap = flattenSheet(sheet, state.floating);
    sheetReference = sheet;
    dirty = false;
  }
  return bitmap;
}

export function getTileSheetCanvas(sheet) {
  const nextBitmap = getBitmap(sheet);
  if (canvasBitmap !== nextBitmap) {
    if (!canvas || canvas.width !== nextBitmap.width || canvas.height !== nextBitmap.height) {
      canvas = document.createElement('canvas');
      canvas.width = nextBitmap.width;
      canvas.height = nextBitmap.height;
    }
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    context.putImageData(new ImageData(nextBitmap.data, nextBitmap.width, nextBitmap.height), 0, 0);
    canvasBitmap = nextBitmap;
    generation++;
  }
  return canvas;
}

export function tileThumbnailUrl(sheet, tile, { flipH = false, flipV = false, rotate = 0 } = {}) {
  const source = getTileSheetCanvas(sheet);
  const key = `${tile.id}|${flipH}|${flipV}|${rotate}`;
  const cached = thumbnails.get(key);
  if (cached?.generation === generation) return cached.url;

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
  thumbnails.set(key, { url, generation });
  return url;
}
