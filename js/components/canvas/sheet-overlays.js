// Sheet-view overlays: frame labels/selection (sprite mode), animation
// sequence badges, and tile grid/index chips (tile mode). Pure read-only
// rendering — drawn in SCREEN space (the CanvasView identity transform
// active during onOverlay), never baked into sheet bitmaps or exports.

import { getEditorHost } from '../../host/runtime.js';
import { activeSheet } from '../../host/document-helpers.js';
import { classifySlots } from '../../core/blob47.js';
import { isPinnedFrame } from '../../domain/sprites/auto-layout.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

const FRAME_STROKE = '#4f8cff';
const FRAME_FILL = 'rgba(79,140,255,.15)';
const PINNED_STROKE = '#9d7cff';
const CHIP_BG = 'rgba(20,20,24,.85)';
const CHIP_FG = '#fff';
const CHIP_FONT = '11px sans-serif';
const CHIP_PAD_X = 4, CHIP_PAD_Y = 2, CHIP_LINE_H = 12;
// A layout preset can list the same blobIndex on more than one cell (the
// Blob-47 templates do); only the last such cell ends up bound to the
// terrain set (see applyLayoutPreset's comment in core/terrainsets.js) --
// the rest are dead-end duplicates, flagged distinctly so painting on them
// doesn't look like it should do anything.
const DUPLICATE_STROKE = '#e0a030';
const DUPLICATE_CHIP_BG = 'rgba(90,58,0,.85)';
// Distinct from DUPLICATE_STROKE/DUPLICATE_CHIP_BG's orange -- this is
// "works fine, just not required", not "does nothing at all".
const REMOVABLE_FILL = 'rgba(120,130,170,.35)';

export function drawSheetOverlays(view, ctx) {
  const sheet = activeSheet();
  if (!sheet) return;
  if (getEditorHost().store.getState().session.activeModeId === 'sprites') drawSpriteOverlays(view, ctx, sheet);
  else drawTileOverlays(view, ctx, sheet);
}

function overlays() { return getEditorHost().store.getState().workspace.overlays; }

// Draws a small dark pill with `text` anchored so its top-left corner is at
// (x, y), clamped fully inside the viewport so labels near the sheet edge
// stay readable. Returns the chip's actual (clamped) screen rect so callers
// can stack further chips underneath it.
function drawChip(ctx, view, text, x, y, bg = CHIP_BG) {
  ctx.font = CHIP_FONT;
  const w = Math.ceil(ctx.measureText(text).width) + CHIP_PAD_X * 2;
  const h = CHIP_LINE_H + CHIP_PAD_Y * 2;
  const cx = Math.max(0, Math.min(view.cssWidth - w, x));
  const cy = Math.max(0, Math.min(view.cssHeight - h, y));
  ctx.fillStyle = bg;
  ctx.fillRect(cx, cy, w, h);
  ctx.fillStyle = CHIP_FG;
  ctx.textBaseline = 'top';
  ctx.fillText(text, cx + CHIP_PAD_X, cy + CHIP_PAD_Y);
  return { x: cx, y: cy, w, h };
}

function drawSpriteOverlays(view, ctx, sheet) {
  const frames = sheet.frames;
  if (!frames.length) return;
  const selectedFrameId = getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null;

  if (overlays().labels) {
    ctx.save();
    frames.forEach((f) => {
      const selected = f.id === selectedFrameId;
      const pinned = isPinnedFrame(sheet, f.id);
      const p0 = view.imageToScreen(f.x, f.y);
      const p1 = view.imageToScreen(f.x + f.w, f.y + f.h);
      const w = p1.x - p0.x, h = p1.y - p0.y;
      if (selected) {
        ctx.fillStyle = FRAME_FILL;
        ctx.fillRect(p0.x, p0.y, w, h);
      }
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeStyle = pinned ? PINNED_STROKE : FRAME_STROKE;
      ctx.setLineDash([]);
      ctx.strokeRect(p0.x, p0.y, w, h);
    });
    ctx.restore();
  }

  if (!overlays().labels && !overlays().sequences) return;

  frames.forEach((f, index) => {
    const p0 = view.imageToScreen(f.x, f.y);
    let labelRect = null;
    if (overlays().labels) labelRect = drawChip(ctx, view, `${index}:${f.name}`, p0.x, p0.y);
    if (overlays().sequences && sheet.animations.length) {
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
  if (!sheet.tiles) return;
  const tiles = sheet.tiles;

  if (overlays().labels && tiles.length > 0) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const t of tiles) {
      const p0 = view.imageToScreen(t.x, t.y);
      const p1 = view.imageToScreen(t.x + t.w, t.y + t.h);
      const isDuplicate = t.duplicateOf != null;
      if (!isDuplicate && t.terrainSetId != null && t.blobIndex != null) {
        const ts = sheet.terrainSets?.find(s => s.id === t.terrainSetId);
        if (ts) {
          const classInfo = classifySlots(ts.symmetry).get(t.blobIndex);
          if (classInfo && !classInfo.mandatory) {
            ctx.fillStyle = REMOVABLE_FILL;
            ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
          }
        }
      }
      ctx.strokeStyle = isDuplicate ? DUPLICATE_STROKE : FRAME_STROKE;
      ctx.setLineDash(isDuplicate ? [3, 3] : []);
      ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
    }
    ctx.restore();

    tiles.forEach((t, i) => {
      const p0 = view.imageToScreen(t.x, t.y);
      if (t.duplicateOf != null) {
        const primaryIndex = tiles.findIndex(x => x.id === t.duplicateOf);
        drawChip(ctx, view, `${i} → #${primaryIndex}`, p0.x, p0.y, DUPLICATE_CHIP_BG);
      } else {
        drawChip(ctx, view, t.name ? `${i}:${t.name}` : `${i}`, p0.x, p0.y);
      }
    });
  }

  // Selected-tile highlight (tile tool) — independent of the labels toggle,
  // like sprite mode's selected-frame fill/stroke.
  const selectedTileId = getEditorHost().selections.get(sheetDocument(sheet))?.tileId ?? null;
  const sel = tiles.find(t => t.id === selectedTileId);
  if (sel) {
    const p0 = view.imageToScreen(sel.x, sel.y);
    const p1 = view.imageToScreen(sel.x + sel.w, sel.y + sel.h);
    ctx.save();
    ctx.strokeStyle = FRAME_STROKE;
    ctx.lineWidth = 2;
    ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    ctx.restore();
  }
}
