// Applies an auto-layout plan (js/domain/sprites/auto-layout.js) to a sheet:
// grows it if needed, then moves every carried frame's pixels on every
// editable layer -- copy all, clear all, blit all, so swaps and overlapping
// shifts are safe -- and writes the frames' new x/y. Returns a record that
// undoLayout/redoLayout replay byte-exactly. Locked layers are never
// written; a plan that would move pixels out of one is refused up front.
import { findLayer, sheetLayers, resizeSheetCanvas } from './model.js';
import { copyRegion, blitRegion, fillRegion, createBitmap } from './pixels.js';

const CLEAR = [0, 0, 0, 0];

export function hasPixels(bitmap, r) {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(bitmap.width, r.x + r.w), y1 = Math.min(bitmap.height, r.y + r.h);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (bitmap.data[(y * bitmap.width + x) * 4 + 3] !== 0) return true;
  return false;
}

// Every layer's pixels of `frame`, re-framed onto a w x h canvas with the
// old content's top-left at (ox, oy) -- cropping or padding as needed.
export function reframedContent(sheet, frame, w, h, ox, oy) {
  return new Map(sheetLayers(sheet).map(l => {
    const bitmap = createBitmap(w, h);
    blitRegion(bitmap, copyRegion(l.bitmap, frame.x, frame.y, frame.w, frame.h), ox, oy);
    return [l.id, bitmap];
  }));
}

export function applyLayout(sheet, plan, { content = new Map(), clears = [] } = {}) {
  const frames = new Map(sheet.frames.map(f => [f.id, f]));
  const carried = plan.moves
    .filter(m => !content.has(m.frameId))
    .map(m => ({ frame: frames.get(m.frameId), from: m.from, to: m.to }));
  const sources = [...carried.map(m => ({ x: m.from.x, y: m.from.y, w: m.frame.w, h: m.frame.h })), ...clears];
  const written = [...content.keys()].map(id => {
    const f = frames.get(id);
    const to = plan.rects.get(id) ?? f;
    return { id, x: to.x, y: to.y, w: f.w, h: f.h };
  });

  const layers = sheetLayers(sheet);
  for (const layer of layers) {
    if (layer.locked && [...sources, ...written].some(r => hasPixels(layer.bitmap, r)))
      return { ok: false, reason: `Layer "${layer.name}" is locked and has pixels that would move` };
  }

  const sizeBefore = { w: sheet.width, h: sheet.height };
  const sizeAfter = { w: Math.max(sheet.width, plan.size.w), h: Math.max(sheet.height, plan.size.h) };
  resizeSheetCanvas(sheet, sizeAfter.w, sizeAfter.h);

  const editable = layers.filter(l => !l.locked);
  const touched = [...sources, ...carried.map(m => ({ x: m.to.x, y: m.to.y, w: m.frame.w, h: m.frame.h })), ...written];
  const patches = editable.flatMap(layer =>
    touched.map(rect => ({ layerId: layer.id, rect, before: copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h), after: null })));

  for (const layer of editable) {
    const copies = carried.map(m => copyRegion(layer.bitmap, m.from.x, m.from.y, m.frame.w, m.frame.h));
    for (const r of sources) fillRegion(layer.bitmap, r.x, r.y, r.w, r.h, CLEAR);
    carried.forEach((m, i) => blitRegion(layer.bitmap, copies[i], m.to.x, m.to.y));
    for (const r of written) {
      fillRegion(layer.bitmap, r.x, r.y, r.w, r.h, CLEAR);
      const bitmap = content.get(r.id)?.get(layer.id);
      if (bitmap) blitRegion(layer.bitmap, bitmap, r.x, r.y);
    }
  }
  for (const p of patches) {
    const bitmap = findLayer(sheet.layerTree, p.layerId).bitmap;
    p.after = copyRegion(bitmap, p.rect.x, p.rect.y, p.rect.w, p.rect.h);
  }

  const coords = [];
  for (const [id, to] of plan.rects) {
    const f = frames.get(id);
    coords.push({ frameId: id, before: { x: f.x, y: f.y }, after: { x: to.x, y: to.y } });
    f.x = to.x; f.y = to.y;
  }
  return { ok: true, record: { sizeBefore, sizeAfter, coords, patches } };
}

function writeCoords(sheet, record, key) {
  for (const c of record.coords) {
    const f = sheet.frames.find(fr => fr.id === c.frameId);
    if (f) { f.x = c[key].x; f.y = c[key].y; }
  }
}

function blitPatches(sheet, record, key) {
  for (const p of record.patches) {
    const layer = findLayer(sheet.layerTree, p.layerId);
    if (layer) blitRegion(layer.bitmap, p[key], p.rect.x, p.rect.y);
  }
}

export function undoLayout(sheet, record) {
  blitPatches(sheet, record, 'before');
  resizeSheetCanvas(sheet, record.sizeBefore.w, record.sizeBefore.h);
  writeCoords(sheet, record, 'before');
}

export function redoLayout(sheet, record) {
  resizeSheetCanvas(sheet, record.sizeAfter.w, record.sizeAfter.h);
  blitPatches(sheet, record, 'after');
  writeCoords(sheet, record, 'after');
}
