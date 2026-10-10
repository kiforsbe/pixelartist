// Auto layout: one band of rows per auto animation, stacked down the sheet
// in sheet.animations order, each band at x = 0 and the smallest free y.
// Pure: reads the sheet, never writes it. js/core/sheet-layout.js applies a
// plan. See docs/superpowers/specs/2026-10-09-animations-workbench-design.md §2.
import { sheetLayers } from '../../core/model.js';

export const NO_ROOM = 'Not enough room on the sheet: raise the maximum sheet width or trim the sheet';
export const PINNED_HINT = 'Auto-laid-out — edit in Animations, or Make manual';

export function distinctFrameIds(anim) {
  const seen = new Set();
  const out = [];
  for (const entry of anim.frames) {
    if (seen.has(entry.frameId)) continue;
    seen.add(entry.frameId);
    out.push(entry.frameId);
  }
  return out;
}

export function autoAnimationOf(sheet, frameId) {
  return sheet.animations.find(a => a.layout === 'auto' && a.frames.some(e => e.frameId === frameId)) ?? null;
}

export function isPinnedFrame(sheet, frameId) {
  return !!autoAnimationOf(sheet, frameId);
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// rowMinX[y]: smallest x of a non-empty pixel (any layer) in row y that lies
// in no frame rect (fresh frames excluded) and no ignore rect; Infinity if
// none. A band [0, W) x [y, y + H) is blocked iff some row in it has
// rowMinX < W -- exact, and cheap because each row scan stops at the
// current minimum.
function strayRowMinX(sheet, fresh, ignoreRects) {
  const W = sheet.width, H = sheet.height;
  const covered = new Uint8Array(W * H);
  const cover = r => {
    const x0 = Math.max(0, r.x), x1 = Math.min(W, r.x + r.w);
    if (x1 <= x0) return;
    for (let y = Math.max(0, r.y); y < Math.min(H, r.y + r.h); y++) covered.fill(1, y * W + x0, y * W + x1);
  };
  for (const f of sheet.frames) if (!fresh.has(f.id)) cover(f);
  for (const r of ignoreRects) cover(r);
  const rowMinX = new Array(H).fill(Infinity);
  for (const layer of sheetLayers(sheet)) {
    const d = layer.bitmap.data;
    for (let y = 0; y < H; y++) {
      const limit = Math.min(W, rowMinX[y]);
      for (let x = 0; x < limit; x++) {
        const i = y * W + x;
        if (d[i * 4 + 3] !== 0 && !covered[i]) { rowMinX[y] = x; break; }
      }
    }
  }
  return rowMinX;
}

// Smallest y >= 0 where `band` (x = 0) overlaps no rect and no stray row,
// or null when it would cross maxHeight. Each blocked probe jumps y past
// the blocker, so the loop always advances.
function findBandY(band, rects, rowMinX, maxHeight) {
  let y = 0;
  while (y + band.h <= maxHeight) {
    const probe = { ...band, y };
    let next = y;
    for (const r of rects) if (overlaps(probe, r)) next = Math.max(next, r.y + r.h);
    for (let row = Math.min(y + band.h, rowMinX.length) - 1; row >= y; row--) {
      if (rowMinX[row] < band.w) { next = Math.max(next, row + 1); break; }
    }
    if (next === y) return y;
    y = next;
  }
  return null;
}

export function planLayout(sheet, { maxWidth, maxHeight, fresh = new Set(), ignoreRects = [] }) {
  const framesById = new Map(sheet.frames.map(f => [f.id, f]));
  const autoAnims = sheet.animations.filter(a => a.layout === 'auto' && a.cell);
  const autoIds = new Set(autoAnims.flatMap(a => a.frames.map(e => e.frameId)));
  const obstacles = sheet.frames.filter(f => !autoIds.has(f.id)).map(({ x, y, w, h }) => ({ x, y, w, h }));
  const rowMinX = strayRowMinX(sheet, fresh, ignoreRects);
  const placed = [];
  const rects = new Map();
  let sizeW = sheet.width, sizeH = sheet.height;
  for (const anim of autoAnims) {
    const ids = distinctFrameIds(anim).filter(id => framesById.has(id));
    if (!ids.length) continue;
    const { w: cw, h: ch } = anim.cell;
    if (cw > maxWidth) return { ok: false, reason: NO_ROOM };
    const cols = Math.max(1, Math.floor(maxWidth / cw));
    const band = { x: 0, y: 0, w: Math.min(cols, ids.length) * cw, h: Math.ceil(ids.length / cols) * ch };
    const y = findBandY(band, [...obstacles, ...placed], rowMinX, maxHeight);
    if (y == null) return { ok: false, reason: NO_ROOM };
    band.y = y;
    placed.push(band);
    ids.forEach((id, i) => rects.set(id, { x: (i % cols) * cw, y: y + Math.floor(i / cols) * ch }));
    sizeW = Math.max(sizeW, band.w);
    sizeH = Math.max(sizeH, band.y + band.h);
  }
  const moves = [];
  for (const [frameId, to] of rects) {
    const f = framesById.get(frameId);
    if (f.x !== to.x || f.y !== to.y) moves.push({ frameId, from: { x: f.x, y: f.y }, to });
  }
  return { ok: true, rects, size: { w: sizeW, h: sizeH }, moves };
}
