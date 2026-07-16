// CAD-style dimension labels for rectangular overlays: width centered below
// the bottom edge, height right of the right edge, origin "(x, y)" above the
// top-left corner. Fixed screen-size text, white with a black outline so it
// reads over any pixel content; positions clamped into the canvas viewport
// so labels stay visible when the rect edge is off-screen. Pure drawing —
// all inputs via arguments, no app-state imports.

const FONT = '11px monospace';
const PAD = 4;      // gap between rect edge and label, screen px
const MARGIN = 2;   // viewport clamp margin

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }
function delta(d) { return d ? ` (${signed(d)})` : ''; }

function drawLabel(ctx, text, x, y, { align = 'center', baseline = 'top', alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = FONT;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function clampX(ctx, x) { return Math.max(MARGIN, Math.min(ctx.canvas.width - MARGIN, x)); }
function clampY(ctx, y) { return Math.max(12, Math.min(ctx.canvas.height - MARGIN, y)); }

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
  drawLabel(ctx, originText, clampX(ctx, p0.x), clampY(ctx, p0.y - PAD),
    { align: 'left', baseline: 'bottom', alpha });
  drawLabel(ctx, `${w}${delta(opts.dw)}`, clampX(ctx, (p0.x + p1.x) / 2), clampY(ctx, p1.y + PAD),
    { align: 'center', baseline: 'top', alpha });
  drawLabel(ctx, `${h}${delta(opts.dh)}`, clampX(ctx, p1.x + PAD), clampY(ctx, (p0.y + p1.y) / 2),
    { align: 'left', baseline: 'middle', alpha });
}

// Angle readout for rotation gestures, at a screen position (near the knob).
export function drawAngleLabel(ctx, x, y, radians) {
  let deg = (radians * 180 / Math.PI) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  drawLabel(ctx, `${deg.toFixed(1)}°`, clampX(ctx, x), clampY(ctx, y),
    { align: 'left', baseline: 'middle' });
}
