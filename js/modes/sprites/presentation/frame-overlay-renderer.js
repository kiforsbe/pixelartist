// js/modes/sprites/presentation/frame-overlay-renderer.js
// All Canvas drawing for the frame tool: create/move/resize ghosts, CAD
// dimension labels, corner handles, in-strip call-outs/grips, break
// separators, and the live Slice-grid preview. Every piece of state it needs
// (active drag, hovered chrome part, current tool, selected frame, slice
// preview options) arrives as a parameter -- this module owns no state.
import { sliceGrid } from '../../../core/slicing.js';
import { segmentsOf, segmentOfFrame, segmentMembers } from '../../../core/strips.js';
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';
import { drawRectDims, drawChainDims } from '../../../ui/dimlabels.js';
import { resizeGhostRect } from '../application/frame-geometry.js';
import { chromeGeometry, standaloneGripGeometry, selectedSegment, CALLOUT_R } from '../application/frame-chrome-geometry.js';

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

// Strip dimensions: level-0 width chain (one dimension per member, in x
// order) below the bbox, level-1 overall width, single level-0 height
// (members share it), origin marker on the bbox. dx/dy shift everything to
// the drag-ghost position; opts carries quiet/dx/dy for drawRectDims.
function drawStripDims(ctx, view, members, dx, dy, opts = {}) {
  const bbox = frameBounds(members);
  const r = { x: bbox.x + dx, y: bbox.y + dy, w: bbox.w, h: bbox.h };
  const alpha = opts.quiet ? 0.7 : 1;
  const sorted = members.slice().sort((m, n) => m.x - n.x);
  drawChainDims(ctx, view, {
    axis: 'h', edge: r.y + r.h,
    spans: sorted.map(m => ({ from: m.x + dx, to: m.x + m.w + dx, text: `${m.w}` })),
    alpha,
  });
  drawRectDims(ctx, view, r, { ...opts, wLevel: 1, hLevel: 0 });
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

function drawCallout(ctx, c, glyph, active) {
  ctx.beginPath();
  ctx.arc(c.cx, c.cy, CALLOUT_R, 0, Math.PI * 2);
  ctx.fillStyle = active ? '#4f8cff' : 'rgba(20,20,24,.85)';
  ctx.fill();
  ctx.strokeStyle = '#4f8cff';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = active ? '#fff' : '#a9c7ff';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, c.cx, c.cy + 0.5);
}

function drawGrips(ctx, grips, hover) {
  for (const gr of grips) {
    const active = hover?.type === 'grip' && hover.side === gr.side;
    ctx.globalAlpha = active ? 1 : 0.7;
    ctx.fillStyle = '#4f8cff';
    ctx.fillRect(gr.x, gr.y, gr.w, gr.h);
    ctx.globalAlpha = 1;
  }
}

function drawChrome(ctx, view, sheet, drag, hover, selectedFrameId) {
  if (drag) return;
  const sel = selectedSegment(sheet, selectedFrameId);
  if (!sel) return;
  const g = chromeGeometry((x, y) => view.imageToScreen(x, y), sheet, sel.anim, sel.run);
  if (!g) return;
  ctx.save();
  for (const c of g.inserts)
    drawCallout(ctx, c, '+', hover?.type === 'insert' && hover.k === c.k);
  for (const c of g.splits)
    drawCallout(ctx, c, '✂', hover?.type === 'split' && hover.k === c.k);
  drawGrips(ctx, g.grips, hover);
  ctx.restore();
}

// "Drag out as a new strip" chrome for a selected standalone frame: reuses
// an intact strip's own edge-grip look and geometry so grabbing an edge and
// dragging away reads as exactly the same gesture as growing an existing
// strip -- because that's literally what the presenter does with it.
function drawStandaloneStripGrips(ctx, view, frame, drag, hover) {
  if (drag) return;
  const g = standaloneGripGeometry((x, y) => view.imageToScreen(x, y), frame);
  ctx.save();
  drawGrips(ctx, g.grips, hover);
  ctx.restore();
}

// A split whose halves haven't moved yet is invisible geometry — mark it.
function drawBreakSeparators(ctx, view, sheet) {
  ctx.save();
  ctx.strokeStyle = '#ffb454';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  for (const a of sheet.animations) {
    if (!a.strip) continue;
    const runs = segmentsOf(a);
    for (let i = 1; i < runs.length; i++) {
      const prev = segmentMembers(sheet, a, runs[i - 1]);
      const next = segmentMembers(sheet, a, runs[i]);
      if (!prev.length || !next.length) continue;
      const pl = prev[prev.length - 1], nf = next[0];
      if (nf.x !== pl.x + pl.w || nf.y !== pl.y) continue;
      const p0 = view.imageToScreen(nf.x, nf.y);
      const p1 = view.imageToScreen(nf.x, nf.y + nf.h);
      ctx.beginPath();
      ctx.moveTo(p0.x + 0.5, p0.y);
      ctx.lineTo(p1.x + 0.5, p1.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function paintFrameToolGhost(ctx, view, sheet, { tool, drag, slicePreview }) {
  if (!sheet) return;

  if (slicePreview) drawSlicePreview(ctx, view, sheet, slicePreview);
  if (tool === 'frametool') drawBreakSeparators(ctx, view, sheet);
  if (!drag) return;

  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  if (drag.kind === 'create' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'move' && drag.bbox) {
    const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
    const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
    if (drag.snap) ctx.strokeStyle = '#6adf7a';
    // Single frame or strip: the bbox already covers just the grabbed
    // frame in the non-strip case, so this one branch handles both.
    strokeGhostRect(ctx, view, { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h });
  }
  else if (drag.kind === 'resize' && drag.rect) strokeGhostRect(ctx, view, drag.rect);
  else if (drag.kind === 'stripresize') strokeGhostRect(ctx, view, resizeGhostRect(drag));
  ctx.restore();

  if (drag.kind === 'create' && drag.rect) {
    drawRectDims(ctx, view, drag.rect);
  } else if (drag.kind === 'move' && drag.bbox) {
    const dx = drag.snap ? drag.snap.dx : drag.delta.dx;
    const dy = drag.snap ? drag.snap.dy : drag.delta.dy;
    if (drag.members.length > 1) {
      drawStripDims(ctx, view, drag.members, dx, dy, { dx, dy });
    } else {
      const r = { x: drag.bbox.x + dx, y: drag.bbox.y + dy, w: drag.bbox.w, h: drag.bbox.h };
      drawRectDims(ctx, view, r, { dx, dy });
    }
  } else if (drag.kind === 'resize' && drag.rect) {
    drawRectDims(ctx, view, drag.rect, {
      dw: drag.rect.w - drag.before.w, dh: drag.rect.h - drag.before.h,
    });
  } else if (drag.kind === 'stripresize') {
    const r = resizeGhostRect(drag);
    drawChainDims(ctx, view, {
      axis: 'h', edge: r.y + r.h,
      spans: Array.from({ length: drag.count }, (_, i) =>
        ({ from: r.x + i * drag.fw, to: r.x + (i + 1) * drag.fw, text: `${drag.fw}` })),
    });
    const df = drag.count - drag.count0;
    drawRectDims(ctx, view, r, {
      wLevel: 1, hLevel: 0,
      wOverride: `${r.w}${df ? ` (${df > 0 ? '+' : ''}${df}f)` : ''}`,
    });
  }

  if (drag.kind === 'move' && drag.snap) {
    const jx = drag.snap.side === 'before'
      ? drag.bbox.x + drag.snap.dx + drag.bbox.w   // dragged right edge
      : drag.bbox.x + drag.snap.dx;                 // dragged left edge
    const jy = drag.bbox.y + drag.snap.dy;
    const p0 = view.imageToScreen(jx, jy);
    const p1 = view.imageToScreen(jx, jy + drag.bbox.h);
    ctx.save();
    ctx.strokeStyle = '#6adf7a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.restore();
  }
}

// Selection chrome — the idle dims, resize handles, and the strip call-outs/
// grips — must render above EVERYTHING on the sheet overlay (including the
// frame/tile label overlays chained after the frame tool), so contributions.js
// chains this as the final overlay layer instead of drawing it inside
// paintFrameToolGhost.
export function paintStripChrome(ctx, view, sheet, { tool, drag, hover, selectedFrameId }) {
  if (tool !== 'frametool' || !sheet) return;
  const selected = sheet.frames.find(f => f.id === selectedFrameId);
  const strip = selected ? stripForFrame(sheet, selected.id) : null;
  if (selected && !drag) {
    const run = strip ? segmentOfFrame(strip, selected.id) : null;
    const members = run ? segmentMembers(sheet, strip, run) : null;
    // A 1-member strip degenerates to the plain single-frame case (no
    // chain, no level-1 row) — matching the drag path's members.length gate.
    if (members && members.length > 1) drawStripDims(ctx, view, members, 0, 0, { quiet: true });
    else drawRectDims(ctx, view, selected, { quiet: true });
  }
  // No resize handles on intact-strip members.
  if (selected && !strip) {
    drawHandles(ctx, view, selected);
    drawStandaloneStripGrips(ctx, view, selected, drag, hover);
  }
  drawChrome(ctx, view, sheet, drag, hover, selectedFrameId);
}
