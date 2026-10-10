// js/domain/sprites/unify-sprite-size.js
// The load migration to one sprite size per sprite sheet (docs/superpowers/
// specs/2026-10-10-sprite-size-per-sheet-design.md). core/bundle.js runs it
// on every loaded project; it is a no-op for sheets already uniform.
//
// A sheet whose frames differ is re-framed to the smallest size that holds
// every frame with the pivots aligned (so nothing is cropped), manual
// animations become auto where no other auto animation already lays out
// their frames, and everything -- loose frames as one extra band -- is
// packed fresh by the auto layout. A plan that cannot fit leaves the sheet
// as it was.
import { sheetLayers, MAX_DIM } from '../../core/model.js';
import { applyLayout, reframedContent } from '../../core/sheet-layout.js';
import { planLayout, autoAnimationOf, layoutMaxWidth } from './auto-layout.js';

export function unifySpriteSizes(project) {
  for (const sheet of project.sheets) if (sheet.kind === 'sprite') unifySheet(sheet, project.settings);
}

function setSize(sheet, w, h) {
  sheet.spriteSize = { w, h };
  for (const anim of sheet.animations) if (anim.layout === 'auto') anim.cell = { w, h };
}

function unifySheet(sheet, settings) {
  const frames = sheet.frames;
  if (!frames.length) return;
  const [first] = frames;
  if (frames.every(f => f.w === first.w && f.h === first.h)) { setSize(sheet, first.w, first.h); return; }

  const px = Math.max(...frames.map(f => f.pivotX ?? 0)), py = Math.max(...frames.map(f => f.pivotY ?? 0));
  const W = Math.max(...frames.map(f => px - (f.pivotX ?? 0) + f.w));
  const H = Math.max(...frames.map(f => py - (f.pivotY ?? 0) + f.h));
  const snapshot = {
    frames: frames.map(f => [f, { w: f.w, h: f.h, pivotX: f.pivotX, pivotY: f.pivotY }]),
    animations: sheet.animations.map(a => [a, { layout: a.layout, cell: a.cell }]),
  };
  const content = new Map(), clears = [];
  for (const f of frames) {
    clears.push({ x: f.x, y: f.y, w: f.w, h: f.h });
    content.set(f.id, reframedContent(sheet, f, W, H, Math.round(px - (f.pivotX ?? 0)), Math.round(py - (f.pivotY ?? 0))));
  }
  for (const f of frames) Object.assign(f, { w: W, h: H, pivotX: px, pivotY: py });
  for (const anim of sheet.animations) {
    if (anim.layout === 'auto' || !anim.frames.length) continue;
    if (anim.frames.some(e => autoAnimationOf(sheet, e.frameId))) continue;
    anim.layout = 'auto';
  }
  for (const anim of sheet.animations) if (anim.layout === 'auto') anim.cell = { w: W, h: H };

  // Loose frames ride along as a temporary auto band after the animations.
  const loose = frames.filter(f => !autoAnimationOf(sheet, f.id));
  const band = { layout: 'auto', cell: { w: W, h: H }, frames: loose.map(f => ({ frameId: f.id })) };
  sheet.animations.push(band);
  const plan = planLayout(sheet, {
    maxWidth: Math.max(layoutMaxWidth(settings), W), maxHeight: MAX_DIM,
    fresh: new Set(frames.map(f => f.id)), ignoreRects: clears,
  });
  sheet.animations.pop();

  const locked = sheetLayers(sheet).filter(l => l.locked);
  for (const l of locked) l.locked = false;
  const applied = plan.ok ? applyLayout(sheet, plan, { content, clears }) : plan;
  for (const l of locked) l.locked = true;
  if (!applied.ok) {
    for (const [f, v] of snapshot.frames) Object.assign(f, v);
    for (const [a, v] of snapshot.animations) Object.assign(a, v);
    return;
  }
  sheet.spriteSize = { w: W, h: H };
}
