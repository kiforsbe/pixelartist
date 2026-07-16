// CAD-style dimension labels for rectangular overlays: width centered below
// the bottom edge, height right of the right edge, origin "(x, y)" above the
// top-left corner. Fixed screen-size text, white with a black outline so it
// reads over any pixel content; positions clamped into the canvas viewport
// so labels stay visible when the rect edge is off-screen. Pure drawing —
// all inputs via arguments, no app-state imports.

const FONT = '11px monospace';
const PAD = 4;      // gap between rect edge and label, screen px
const MARGIN = 2;   // viewport clamp margin
const TEXT_H = 11;  // nominal line height of FONT, for extent clamping

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function delta(d) { return d ? ` (${signed(d)})` : ''; }

function drawLabel(ctx, text, x, y, { align = 'center', baseline = 'top', alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  // Clamp into the viewport in the ctx's OWN coordinate space: the overlay
  // ctx is dpr-scaled (CSS px), so canvas.width/height are DEVICE px —
  // divide the transform's scale back out. Account for the text extent per
  // align/baseline so the whole label stays visible, not just its anchor.
  const t = ctx.getTransform();
  const vw = ctx.canvas.width / (t.a || 1);
  const vh = ctx.canvas.height / (t.d || 1);
  const tw = ctx.measureText(text).width;
  const left = align === 'center' ? tw / 2 : align === 'right' ? tw : 0;
  const right = align === 'center' ? tw / 2 : align === 'left' ? tw : 0;
  const above = baseline === 'bottom' ? TEXT_H : baseline === 'middle' ? TEXT_H / 2 : 0;
  const below = baseline === 'top' ? TEXT_H : baseline === 'middle' ? TEXT_H / 2 : 0;
  x = Math.max(MARGIN + left, Math.min(vw - MARGIN - right, x));
  y = Math.max(MARGIN + above, Math.min(vh - MARGIN - below, y));
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// rect: image-space {x,y,w,h}. opts: {dw, dh, dx, dy, quiet, wOverride, hOverride}.
// quiet renders at 70% alpha; callers simply omit deltas when idle.
export function drawRectDims(ctx, view, rect, opts = {}) {
  const p0 = view.imageToScreen(rect.x, rect.y);
  const p1 = view.imageToScreen(rect.x + rect.w, rect.y + rect.h);
  const alpha = opts.quiet ? 0.7 : 1;
  const w = opts.wOverride ?? rect.w;
  const h = opts.hOverride ?? rect.h;
  const originText = `(${rect.x}, ${rect.y})`
    + ((opts.dx || opts.dy) ? ` (${signed(opts.dx || 0)}, ${signed(opts.dy || 0)})` : '');
  drawLabel(ctx, originText, p0.x, p0.y - PAD, { align: 'left', baseline: 'bottom', alpha });
  drawLabel(ctx, `${w}${delta(opts.dw)}`, (p0.x + p1.x) / 2, p1.y + PAD,
    { align: 'center', baseline: 'top', alpha });
  drawLabel(ctx, `${h}${delta(opts.dh)}`, p1.x + PAD, (p0.y + p1.y) / 2,
    { align: 'left', baseline: 'middle', alpha });
}

// Angle readout for rotation gestures, at a screen position (near the knob).
export function drawAngleLabel(ctx, x, y, radians) {
  let deg = (radians * 180 / Math.PI) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  drawLabel(ctx, `${deg.toFixed(1)}°`, x, y, { align: 'left', baseline: 'middle' });
}
