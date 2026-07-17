// CAD-style dimension lines for rectangular overlays: extension lines
// normal to the measured edge, an arrowed dimension line between them, and
// the value in a bordered pill centered ON the line. Dimension rows stack
// outward via `level` so sub-part chains (level 0) and overall dimensions
// (level 1) coexist. When a span is too small for its pill, the arrows flip
// outside and the pill sticks out past an end — classic CAD. Frame-overlay
// blue theme. Pure drawing/geometry — all inputs via arguments, no
// app-state imports (node tests import this file).

const DIM_STROKE = '#4f8cff';   // lines, arrows, extension lines, markers
const DIM_TEXT = '#a9c7ff';     // pill text
const PILL_BG = 'rgba(20,20,24,.85)';
const FONT = '11px monospace';
const TEXT_H = 11;
const BASE_OFFSET = 14;         // level-0 dimension-line distance from the shape
const LEVEL_STEP = 20;          // additional distance per level
const EXT_GAP = 2;              // extension-line gap from the shape edge
const EXT_OVER = 4;             // extension-line overshoot past the dimension line
const ARROW = 6;                // arrowhead length
const PILL_PAD_X = 5, PILL_PAD_Y = 2;
const PILL_H = TEXT_H + PILL_PAD_Y * 2;
const MARGIN = 2;               // viewport clamp margin

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function delta(d) { return d ? ` (${signed(d)})` : ''; }

// ---- pure layout (node-tested) ----
//
// a/b: screen-space span endpoints ON the shape edge (a before b along the
// measured axis). axis 'h' measures a horizontal span, 'v' a vertical one.
// side: which side of the shape the dimension line sits — 'end' (default) =
// below ('h') / right ('v'); 'start' = above / left. level stacks rows
// outward. pillW (full pill width) decides the too-small arrow flip; stick
// picks which end the pill sticks out past when it doesn't fit.
export function layoutDimension({ a, b, axis, side = 'end', level = 0, pillW = 0, stick = 'b' }) {
  const sign = side === 'start' ? -1 : 1;
  const off = (BASE_OFFSET + level * LEVEL_STEP) * sign;
  const gap = EXT_GAP * sign;
  const over = EXT_OVER * sign;
  const span = axis === 'h' ? b.x - a.x : b.y - a.y;
  const fits = span >= pillW + 2 * ARROW + 4;
  if (axis === 'h') {
    const lineY = a.y + off;
    return {
      dim: [{ x: a.x, y: lineY }, { x: b.x, y: lineY }],
      ext: [
        [{ x: a.x, y: a.y + gap }, { x: a.x, y: lineY + over }],
        [{ x: b.x, y: b.y + gap }, { x: b.x, y: lineY + over }],
      ],
      arrowsOutside: !fits,
      pill: fits
        ? { x: (a.x + b.x) / 2, y: lineY }
        : (stick === 'b'
          ? { x: b.x + ARROW + 4 + pillW / 2, y: lineY }
          : { x: a.x - ARROW - 4 - pillW / 2, y: lineY }),
    };
  }
  const lineX = a.x + off;
  return {
    dim: [{ x: lineX, y: a.y }, { x: lineX, y: b.y }],
    ext: [
      [{ x: a.x + gap, y: a.y }, { x: lineX + over, y: a.y }],
      [{ x: b.x + gap, y: b.y }, { x: lineX + over, y: b.y }],
    ],
    arrowsOutside: !fits,
    pill: fits
      ? { x: lineX, y: (a.y + b.y) / 2 }
      : (stick === 'b'
        ? { x: lineX, y: b.y + ARROW + 4 + PILL_H / 2 }
        : { x: lineX, y: a.y - ARROW - 4 - PILL_H / 2 }),
  };
}

// ---- draw helpers ----

// The overlay ctx is dpr-scaled (CSS px); canvas.width/height are DEVICE px
// — divide the transform's scale back out to get the CSS viewport.
function viewportCss(ctx) {
  const t = ctx.getTransform();
  return { w: ctx.canvas.width / (t.a || 1), h: ctx.canvas.height / (t.d || 1) };
}

function line(ctx, p, q) {
  ctx.beginPath();
  ctx.moveTo(p.x + 0.5, p.y + 0.5);
  ctx.lineTo(q.x + 0.5, q.y + 0.5);
  ctx.stroke();
}

// Filled triangular arrowhead: tip at `tip`, body extending along (ux, uy).
function arrow(ctx, tip, ux, uy) {
  const px = -uy, py = ux;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x + ux * ARROW + px * (ARROW / 3), tip.y + uy * ARROW + py * (ARROW / 3));
  ctx.lineTo(tip.x + ux * ARROW - px * (ARROW / 3), tip.y + uy * ARROW - py * (ARROW / 3));
  ctx.closePath();
  ctx.fill();
}

// Rounded pill with border + centered text at (cx, cy), clamped fully into
// the viewport. ctx.font must NOT be assumed — set here.
function drawPill(ctx, text, cx, cy, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  const w = Math.ceil(ctx.measureText(text).width) + PILL_PAD_X * 2;
  const v = viewportCss(ctx);
  const x = Math.max(MARGIN, Math.min(v.w - MARGIN - w, cx - w / 2));
  const y = Math.max(MARGIN, Math.min(v.h - MARGIN - PILL_H, cy - PILL_H / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, PILL_H, PILL_H / 2);
  ctx.fillStyle = PILL_BG;
  ctx.fill();
  ctx.strokeStyle = DIM_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = DIM_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + PILL_H / 2 + 0.5);
  ctx.restore();
}

export function drawDimension(ctx, view, a, b, { axis, side = 'end', level = 0, text = '', alpha = 1, stick = 'b' } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  const pillW = Math.ceil(ctx.measureText(text).width) + PILL_PAD_X * 2;
  const L = layoutDimension({ a, b, axis, side, level, pillW, stick });
  ctx.strokeStyle = DIM_STROKE;
  ctx.fillStyle = DIM_STROKE;
  ctx.lineWidth = 1;
  line(ctx, L.ext[0][0], L.ext[0][1]);
  line(ctx, L.ext[1][0], L.ext[1][1]);
  line(ctx, L.dim[0], L.dim[1]);
  // Arrow tips always touch the extension lines (the dim endpoints); bodies
  // point inward when the pill fits, outward when the arrows flipped.
  const ux = axis === 'h' ? 1 : 0, uy = axis === 'h' ? 0 : 1;
  const s = L.arrowsOutside ? -1 : 1;
  arrow(ctx, L.dim[0], ux * s, uy * s);
  arrow(ctx, L.dim[1], -ux * s, -uy * s);
  ctx.restore();
  drawPill(ctx, text, L.pill.x, L.pill.y, alpha);
}

// Small blue right-angle marker just outside the rect's top-left corner,
// with the origin pill to its right.
function drawOriginMarker(ctx, p, text, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = DIM_STROKE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(p.x + 8, p.y - 3.5);
  ctx.lineTo(p.x - 3.5, p.y - 3.5);
  ctx.lineTo(p.x - 3.5, p.y + 8);
  ctx.stroke();
  ctx.restore();
  drawPill(ctx, text, p.x + 12, p.y - 3 - PILL_H / 2, alpha);
}

// rect: image-space {x,y,w,h}. opts: {dw, dh, dx, dy, quiet, wOverride,
// hOverride, level, wLevel, hLevel}. quiet renders at 70% alpha; callers
// simply omit deltas when idle. wLevel/hLevel let strip callers stack the
// width dimension outside a chain while the height stays at level 0.
export function drawRectDims(ctx, view, rect, opts = {}) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  const alpha = opts.quiet ? 0.7 : 1;
  const w = opts.wOverride ?? rect.w;
  const h = opts.hOverride ?? rect.h;
  drawDimension(ctx, view, { x: p0.x, y: p1.y }, { x: p1.x, y: p1.y }, {
    axis: 'h', level: opts.wLevel ?? opts.level ?? 0, text: `${w}${delta(opts.dw)}`, alpha,
  });
  drawDimension(ctx, view, { x: p1.x, y: p0.y }, { x: p1.x, y: p1.y }, {
    axis: 'v', level: opts.hLevel ?? opts.level ?? 0, text: `${h}${delta(opts.dh)}`, alpha,
  });
  const originText = `${rect.x}, ${rect.y}`
    + ((opts.dx || opts.dy) ? ` (${signed(opts.dx || 0)}, ${signed(opts.dy || 0)})` : '');
  drawOriginMarker(ctx, p0, originText, alpha);
}

// One dimension per span along a shared edge. spans: [{from, to, text}] in
// IMAGE coords along `axis`; edge: the fixed image coordinate of the shape
// edge the chain hangs off (bottom y / right x for side 'end', top y /
// left x for side 'start').
export function drawChainDims(ctx, view, { axis, side = 'end', edge, spans, level = 0, alpha = 1 }) {
  for (const s of spans) {
    const a = axis === 'h' ? view.imageToScreen(s.from, edge) : view.imageToScreen(edge, s.from);
    const b = axis === 'h' ? view.imageToScreen(s.to, edge) : view.imageToScreen(edge, s.to);
    drawDimension(ctx, view, a, b, { axis, side, level, text: s.text, alpha });
  }
}

// Angle readout for rotation gestures, pill anchored right of (x, y).
export function drawAngleLabel(ctx, x, y, radians) {
  let deg = (radians * 180 / Math.PI) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  ctx.save();
  ctx.font = FONT;
  const w = Math.ceil(ctx.measureText(`${deg.toFixed(1)}°`).width) + PILL_PAD_X * 2;
  ctx.restore();
  drawPill(ctx, `${deg.toFixed(1)}°`, x + w / 2, y);
}
