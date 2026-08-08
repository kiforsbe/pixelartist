// Screen-space geometry + hit-testing for the frame tool's handles and
// in-strip chrome. These need a projection from sheet coordinates to screen
// coordinates, but must not know about CanvasView: callers pass a
// `toScreen(x, y) -> {x, y}` callback (presentation supplies
// `(x, y) => view.imageToScreen(x, y)`), keeping this module pure and
// unit-testable with an identity projector.
import { HANDLES_CORNER } from '../../../core/resizeAnchor.js';
import { segmentsOf, segmentOfFrame, segmentMembers } from '../../../core/strips.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';

export const HANDLE_SCREEN_PX = 6;
export const CALLOUT_R = 8;
export const CALLOUT_OFF = 16;
export const SNAP_SCREEN_PX = 10;

export function hitHandle(toScreen, frame, sx, sy) {
  if (!frame) return null;
  for (const h of HANDLES_CORNER) {
    const ix = h[1] === 'w' ? frame.x : frame.x + frame.w;
    const iy = h[0] === 'n' ? frame.y : frame.y + frame.h;
    const p = toScreen(ix, iy);
    if (Math.abs(sx - p.x) <= HANDLE_SCREEN_PX && Math.abs(sy - p.y) <= HANDLE_SCREEN_PX) return h;
  }
  return null;
}

// Word-style "+" insert call-outs above every frame boundary, "✂" split
// call-outs below interior boundaries, and resize grips on the ends. Any
// insert shifts/extends the segment RIGHT, so all inserts are suppressed
// together when one more frame width would not fit on the sheet.
export function chromeGeometry(toScreen, sheet, anim, run) {
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return null;
  const b = frameBounds(members);
  const fw = members[0].w;
  const n = members.length;
  const canInsert = b.x + b.w + fw <= sheet.width;
  const inserts = [];
  if (canInsert)
    for (let k = 0; k <= n; k++) {
      const p = toScreen(b.x + k * fw, b.y);
      inserts.push({ k, cx: p.x, cy: p.y - CALLOUT_OFF });
    }
  const splits = [];
  for (let k = 1; k < n; k++) {
    const p = toScreen(b.x + k * fw, b.y + b.h);
    splits.push({ k, cx: p.x, cy: p.y + CALLOUT_OFF });
  }
  const p0 = toScreen(b.x, b.y);
  const p1 = toScreen(b.x + b.w, b.y + b.h);
  const grips = [
    { side: 'left', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { side: 'right', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
  ];
  return { members, bbox: b, fw, inserts, splits, grips };
}

export function hitGrip(grips, sx, sy) {
  for (const gr of grips)
    if (sx >= gr.x - 2 && sx <= gr.x + gr.w + 2 && sy >= gr.y && sy <= gr.y + gr.h)
      return { type: 'grip', side: gr.side };
  return null;
}

export function hitChrome(geometry, sx, sy) {
  for (const c of geometry.inserts)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'insert', k: c.k };
  for (const c of geometry.splits)
    if (Math.hypot(sx - c.cx, sy - c.cy) <= CALLOUT_R + 2) return { type: 'split', k: c.k };
  return hitGrip(geometry.grips, sx, sy);
}

// Same edge-grip geometry as chromeGeometry's, but for a single standalone
// (non-strip) frame with no run/segment behind it -- lets a bare frame show
// and hit-test the exact same "drag out" grips an intact strip uses to grow
// itself (the presenter starts that drag with anim: null, promoting the frame
// into a brand-new strip -- see newStripFromFrame).
export function standaloneGripGeometry(toScreen, frame) {
  const b = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  const p0 = toScreen(b.x, b.y);
  const p1 = toScreen(b.x + b.w, b.y + b.h);
  const grips = [
    { side: 'left', x: p0.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
    { side: 'right', x: p1.x - 3, y: p0.y, w: 6, h: p1.y - p0.y },
  ];
  return { bbox: b, fw: b.w, fh: b.h, grips };
}

// Chrome only ever targets the segment containing the currently SELECTED
// frame — never whatever the pointer happens to be over — so a non-selected
// strip's call-outs/grips can't sit in front of and block the selected
// strip's commands when strips are close together or overlap. A sub-strip
// wins over its parent strip by construction: the selected frame's run IS
// the sub-strip.
export function selectedSegment(sheet, selectedFrameId) {
  const anim = stripForFrame(sheet, selectedFrameId);
  const run = anim ? segmentOfFrame(anim, selectedFrameId) : null;
  return run ? { anim, run } : null;
}

// While dragging a segment, find the best end-to-end join WITHIN THE SAME
// overall strip only -- merging across different strip animations is
// disabled for now (see docs/superpowers/specs/2026-07-18-strip-area-
// constraint-design.md): dragged RIGHT edge to a target's LEFT edge (side
// 'before' — dragged frames come first) or dragged LEFT edge to a target's
// RIGHT edge (side 'after'). Same frame w/h required; snapped position must
// stay on-sheet. Only called when drag.anim is truthy.
export function findSnap(sheet, drag, zoom) {
  const d = drag.bbox;
  const fw = drag.members[0].w, fh = drag.members[0].h;
  const tol = SNAP_SCREEN_PX / zoom;
  const gx = d.x + drag.delta.dx, gy = d.y + drag.delta.dy;
  let best = null;
  for (const run of segmentsOf(drag.anim)) {
    if (run.index === drag.run.index) continue;
    const members = segmentMembers(sheet, drag.anim, run);
    if (!members.length || members[0].w !== fw || members[0].h !== fh) continue;
    const t = frameBounds(members);
    const cands = [
      { side: 'before', dx: t.x - d.w - d.x, dy: t.y - d.y,
        err: Math.hypot(gx + d.w - t.x, gy - t.y) },
      { side: 'after', dx: t.x + t.w - d.x, dy: t.y - d.y,
        err: Math.hypot(gx - (t.x + t.w), gy - t.y) },
    ];
    for (const c of cands) {
      if (c.err > tol) continue;
      if (d.x + c.dx < 0 || d.x + c.dx + d.w > sheet.width) continue;
      if (d.y + c.dy < 0 || d.y + c.dy + d.h > sheet.height) continue;
      if (!best || c.err < best.err) best = { anim: drag.anim, run, side: c.side, dx: c.dx, dy: c.dy, err: c.err };
    }
  }
  return best;
}
