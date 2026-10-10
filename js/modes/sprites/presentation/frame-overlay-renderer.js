// js/modes/sprites/presentation/frame-overlay-renderer.js
// All Canvas drawing for the frame tool: create/move/resize ghosts, CAD
// dimension labels, corner handles, the pinned-frame hint, and the live
// Slice-grid preview. Every piece of state it needs arrives as a parameter
// -- this module owns no state.
import { sliceGrid } from '../../../core/slicing.js';
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';
import { isPinnedFrame, PINNED_HINT } from '../../../domain/sprites/auto-layout.js';
import { drawRectDims, drawChainDims } from '../../../components/canvas/dim-labels.js';

const FRAME_HANDLE = '#4f8cff';

function strokeGhostRect(ctx, view, rect) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  ctx.strokeRect(p0.x + 0.5, p0.y + 0.5, p1.x - p0.x - 1, p1.y - p0.y - 1);
}

function drawHandles(ctx, view, f) {
  ctx.fillStyle = FRAME_HANDLE;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? f.x : f.x + f.w;
    const iy = h[0] === 'n' ? f.y : f.y + f.h;
    const p = view.imageToScreen(ix, iy);
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
  }
}

// Above a selected pinned frame: why it has no handles, and where to go.
function drawPinnedHint(ctx, view, frame) {
  const p = view.imageToScreen(frame.x, frame.y);
  ctx.save();
  ctx.font = '11px sans-serif';
  const w = Math.ceil(ctx.measureText(PINNED_HINT).width) + 8;
  const h = 16;
  const x = Math.max(0, Math.min(view.cssWidth - w, p.x));
  const y = Math.max(0, p.y - h - 4);
  ctx.fillStyle = 'rgba(20,20,24,.85)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#d8ccff';
  ctx.textBaseline = 'middle';
  ctx.fillText(PINNED_HINT, x + 4, y + h / 2);
  ctx.restore();
}

// Ghost grid + CAD chains for the open Slice-grid dialog: cell outlines in
// the standard dashed ghost style; level-0 chains along the TOP edge (one
// dimension per column width) and LEFT edge (one per row height); level-1
// overall region dimensions. Uses core sliceGrid so the preview always
// matches exactly what Create would produce. Degenerate inputs draw nothing.
function drawSlicePreview(ctx, view, sheet, o) {
  if (o.cellW < 1 || o.cellH < 1) return;
  let cells;
  try {
    cells = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...o });
  } catch {
    return;
  }
  if (!cells.length) return;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const c of cells) strokeGhostRect(ctx, view, c);
  ctx.restore();
  const firstRow = cells.filter(c => c.y === cells[0].y);
  const firstCol = cells.filter(c => c.x === cells[0].x);
  drawChainDims(ctx, view, {
    axis: 'h', side: 'start', edge: cells[0].y,
    spans: firstRow.map(c => ({ from: c.x, to: c.x + c.w, text: `${c.w}` })),
  });
  drawChainDims(ctx, view, {
    axis: 'v', side: 'start', edge: cells[0].x,
    spans: firstCol.map(c => ({ from: c.y, to: c.y + c.h, text: `${c.h}` })),
  });
  const lastX = Math.max(...firstRow.map(c => c.x + c.w));
  const lastY = Math.max(...firstCol.map(c => c.y + c.h));
  drawChainDims(ctx, view, {
    axis: 'h', side: 'start', edge: cells[0].y, level: 1,
    spans: [{ from: cells[0].x, to: lastX, text: `${lastX - cells[0].x}` }],
  });
  drawChainDims(ctx, view, {
    axis: 'v', side: 'start', edge: cells[0].x, level: 1,
    spans: [{ from: cells[0].y, to: lastY, text: `${lastY - cells[0].y}` }],
  });
}

export function paintFrameToolGhost(ctx, view, sheet, { drag, slicePreview }) {
  if (!sheet) return;
  if (slicePreview) drawSlicePreview(ctx, view, sheet, slicePreview);
  if (!drag) return;

  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  if ((drag.kind === 'create' || drag.kind === 'stamp') && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'move') strokeGhostRect(ctx, view, { ...drag.bbox, x: drag.bbox.x + drag.delta.dx, y: drag.bbox.y + drag.delta.dy });
  else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  ctx.restore();

  if ((drag.kind === 'create' || drag.kind === 'stamp') && drag.rect) {
    drawRectDims(ctx, view, drag.rect);
  } else if (drag.kind === 'move') {
    const { dx, dy } = drag.delta;
    drawRectDims(ctx, view, { ...drag.bbox, x: drag.bbox.x + dx, y: drag.bbox.y + dy }, { dx, dy });
  } else if (drag.kind === 'resize' && drag.rect) {
    drawRectDims(ctx, view, drag.rect, { dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h });
  }
}

// Selection chrome -- idle dims, resize handles or the pinned hint -- must
// render above EVERYTHING on the sheet overlay (including the frame/tile
// label overlays chained after the frame tool), so contributions.js chains
// this as the final overlay layer instead of drawing it inside
// paintFrameToolGhost.
export function paintFrameChrome(ctx, view, sheet, { tool, drag, selectedFrameId }) {
  if (tool !== 'frametool' || !sheet) return;
  const selected = sheet.frames.find(f => f.id === selectedFrameId);
  if (!selected) return;
  const pinned = isPinnedFrame(sheet, selected.id);
  if (!drag) drawRectDims(ctx, view, selected, { quiet: true });
  if (pinned) { if (!drag) drawPinnedHint(ctx, view, selected); }
  else if (!sheet.spriteSize) drawHandles(ctx, view, selected); // one sprite size: no resizing here

}
