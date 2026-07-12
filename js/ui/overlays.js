// Sheet-view overlays: frame labels/selection (sprite mode), animation
// sequence badges, and tile grid/index chips (tile mode). Pure read-only
// rendering — drawn in SCREEN space (the CanvasView identity transform
// active during onOverlay), never baked into sheet bitmaps or exports.

import { state, activeSheet } from '../app/state.js';
import { tileCount, tileRect } from '../core/model.js';

const FRAME_STROKE = '#4f8cff';
const FRAME_FILL = 'rgba(79,140,255,.15)';
const CHIP_BG = 'rgba(20,20,24,.85)';
const CHIP_FG = '#fff';
const CHIP_FONT = '11px sans-serif';
const CHIP_PAD_X = 4, CHIP_PAD_Y = 2, CHIP_LINE_H = 12;

export function drawSheetOverlays(view, ctx) {
  const sheet = activeSheet();
  if (!sheet) return;
  if (state.mode === 'sprites') drawSpriteOverlays(view, ctx, sheet);
  else drawTileOverlays(view, ctx, sheet);
}

// Draws a small dark pill with `text` anchored so its top-left corner is at
// (x, y), clamped fully inside the viewport so labels near the sheet edge
// stay readable. Returns the chip's actual (clamped) screen rect so callers
// can stack further chips underneath it.
function drawChip(ctx, view, text, x, y) {
  ctx.font = CHIP_FONT;
  const w = Math.ceil(ctx.measureText(text).width) + CHIP_PAD_X * 2;
  const h = CHIP_LINE_H + CHIP_PAD_Y * 2;
  const cx = Math.max(0, Math.min(view.cssWidth - w, x));
  const cy = Math.max(0, Math.min(view.cssHeight - h, y));
  ctx.fillStyle = CHIP_BG;
  ctx.fillRect(cx, cy, w, h);
  ctx.fillStyle = CHIP_FG;
  ctx.textBaseline = 'top';
  ctx.fillText(text, cx + CHIP_PAD_X, cy + CHIP_PAD_Y);
  return { x: cx, y: cy, w, h };
}

function drawSpriteOverlays(view, ctx, sheet) {
  const frames = sheet.frames;
  if (!frames.length) return;

  if (state.overlays.labels) {
    ctx.save();
    frames.forEach((f) => {
      const selected = f.id === state.selectedFrameId;
      const p0 = view.imageToScreen(f.x, f.y);
      const p1 = view.imageToScreen(f.x + f.w, f.y + f.h);
      const w = p1.x - p0.x, h = p1.y - p0.y;
      if (selected) {
        ctx.fillStyle = FRAME_FILL;
        ctx.fillRect(p0.x, p0.y, w, h);
      }
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = FRAME_STROKE;
      ctx.strokeRect(p0.x, p0.y, w, h);
    });
    ctx.restore();
  }

  if (!state.overlays.labels && !state.overlays.sequences) return;

  frames.forEach((f, index) => {
    const p0 = view.imageToScreen(f.x, f.y);
    let labelRect = null;
    if (state.overlays.labels) labelRect = drawChip(ctx, view, `${index}:${f.name}`, p0.x, p0.y);
    if (state.overlays.sequences && sheet.animations.length) {
      let stackY = labelRect ? labelRect.y + labelRect.h + 2 : p0.y;
      for (const anim of sheet.animations) {
        const pos = anim.frames.findIndex(af => af.frameId === f.id);
        if (pos === -1) continue;
        const r = drawChip(ctx, view, `${anim.name} ${pos + 1}/${anim.frames.length}`, p0.x, stackY);
        stackY = r.y + r.h + 2;
      }
    }
  });
}

function drawTileOverlays(view, ctx, sheet) {
  if (!state.overlays.labels || !sheet.tile) return;
  const count = tileCount(sheet);
  if (count <= 0) return;

  ctx.save();
  ctx.strokeStyle = FRAME_STROKE;
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    const r = tileRect(sheet, i);
    const p0 = view.imageToScreen(r.x, r.y);
    const p1 = view.imageToScreen(r.x + r.w, r.y + r.h);
    ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
  }
  ctx.restore();

  for (let i = 0; i < count; i++) {
    const r = tileRect(sheet, i);
    const p0 = view.imageToScreen(r.x, r.y);
    const name = sheet.tile.names[i];
    drawChip(ctx, view, name ? `${i}:${name}` : `${i}`, p0.x, p0.y);
  }
}
