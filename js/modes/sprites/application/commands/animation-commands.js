import { acceptAnimation as acceptAnimationOnSheet } from '../../../../core/model.js';
import { state, emit, activeSheet } from '../../../../app/state.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function findAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  return { sheet, animation: sheet?.animations.find(a => a.id === animationId) ?? null };
}

// Break apart = the animation keeps its frame entries but stops owning frame
// geometry: members move individually and become resizable again.
export function breakApartStrip(services, sheetId, animationId) {
  const { animation } = findAnimation(services, sheetId, animationId);
  if (!animation) return;
  const beforeBreaks = (animation.breaks ?? []).slice();
  runSheetCommand(services, sheetId, 'break apart strip',
    () => { animation.strip = false; animation.breaks = []; },
    () => { animation.strip = true; animation.breaks = beforeBreaks.slice(); });
}

// Promotes a floating animation into a committed one by freezing whatever is
// currently visible under its own frames into a brand-new layer group.
// core/model.js's acceptAnimation runs eagerly here; the pushed command's
// do() re-applies it idempotently.
export function acceptAnimation(services, sheetId, animationId) {
  const { sheet, animation } = findAnimation(services, sheetId, animationId);
  if (!sheet || !animation) return;
  if (animation.layerGroupId) return;
  const beforeActiveLayerId = state.activeLayerId;
  const group = acceptAnimationOnSheet(sheet, animation);
  const animationLayerId = group.children[0].id;
  const groupIndex = sheet.layerTree.children.indexOf(group);

  runSheetCommand(services, sheetId, 'accept animation',
    target => {
      animation.layerGroupId = group.id;
      if (!target.layerTree.children.includes(group)) {
        target.layerTree.children.splice(Math.min(groupIndex, target.layerTree.children.length), 0, group);
      }
      if (target === activeSheet()) state.activeLayerId = animationLayerId;
    },
    target => {
      animation.layerGroupId = null;
      target.layerTree.children = target.layerTree.children.filter(child => child !== group);
      if (state.activeLayerId === animationLayerId) state.activeLayerId = beforeActiveLayerId;
    });
  emit('selection');
}
