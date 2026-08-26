import { acceptAnimation as acceptAnimationOnSheet } from '../../../../core/model.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function findAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  return { sheet, animation: sheet?.animations.find(a => a.id === animationId) ?? null };
}

function isActiveSheet(services, sheet) {
  const doc = services.store?.getState().session.activeDocument;
  return doc?.id === sheet.id && (doc.kind === 'sprite-sheet' || doc.kind === 'tile-sheet');
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
  const doc = sheetDocument(sheet);
  const beforeActiveLayerId = services.selections.get(doc)?.layerId ?? null;
  const group = acceptAnimationOnSheet(sheet, animation);
  const animationLayerId = group.children[0].id;
  const groupIndex = sheet.layerTree.children.indexOf(group);

  runSheetCommand(services, sheetId, 'accept animation',
    target => {
      animation.layerGroupId = group.id;
      if (!target.layerTree.children.includes(group)) {
        target.layerTree.children.splice(Math.min(groupIndex, target.layerTree.children.length), 0, group);
      }
      if (isActiveSheet(services, target)) services.selections.set({ ...services.selections.get(doc), layerId: animationLayerId }, doc);
    },
    target => {
      animation.layerGroupId = null;
      target.layerTree.children = target.layerTree.children.filter(child => child !== group);
      if (services.selections.get(doc)?.layerId === animationLayerId) services.selections.set({ ...services.selections.get(doc), layerId: beforeActiveLayerId }, doc);
    });
}
