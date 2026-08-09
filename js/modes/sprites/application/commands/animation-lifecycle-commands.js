// js/modes/sprites/application/commands/animation-lifecycle-commands.js
import { addAnimation, renameAnimation as renameAnimationOnSheet, findParent } from '../../../../core/model.js';
import { activeSheet } from '../../../../app/state.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

// A new animation starts FLOATING (see addAnimation/acceptAnimation in
// core/model.js) -- no layer group until accepted, and it has zero frames at
// creation. Mirrors strip-commands.js's newStripFromFrame: "only touch
// selection while this command's own sheet is the one on screen" (state.commands
// is a single global stack shared by every sheet), and the idx-remembered-at-
// undo-time bookkeeping so a later redo reinserts at the same spot.
export function newAnimation(services, sheetId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const doc = sheetDocument(sheet);
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  runSheetCommand(services, sheetId, 'new animation',
    target => {
      if (!anim) { anim = addAnimation(target, name, false, services.projects.project?.settings); idx = target.animations.indexOf(anim); }
      else if (!target.animations.includes(anim)) target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (target === activeSheet()) services.selections.set({ ...services.selections.get(doc), animationId: anim.id }, doc);
    },
    target => {
      idx = target.animations.indexOf(anim);
      target.animations = target.animations.filter(a => a !== anim);
      if (services.selections.get(doc)?.animationId === anim.id) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    });
}

// Deleting an animation also tears down its layer group (if it was accepted)
// -- captured once outside the command so undo can restore both the
// animation and the group at their original positions.
export function deleteAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = services.selections.get(doc)?.animationId === animationId;
  const groupLoc = anim.layerGroupId ? findParent(sheet.layerTree, anim.layerGroupId) : null;
  const group = groupLoc ? groupLoc.parent.children[groupLoc.index] : null;
  const groupParent = groupLoc ? groupLoc.parent : null;
  const groupIdx = groupLoc ? groupLoc.index : -1;
  runSheetCommand(services, sheetId, 'delete animation',
    target => {
      target.animations = target.animations.filter(a => a.id !== animationId);
      if (groupParent) groupParent.children = groupParent.children.filter(c => c.id !== anim.layerGroupId);
      anim.layerGroupId = null;
      if (services.selections.get(doc)?.animationId === animationId) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    },
    target => {
      target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (groupParent) groupParent.children.splice(Math.min(groupIdx, groupParent.children.length), 0, group);
      anim.layerGroupId = group.id;
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), animationId }, doc);
    });
}

export function renameAnimation(services, sheetId, animationId, name) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const before = anim.name;
  if (before === name) return;
  runSheetCommand(services, sheetId, 'rename animation',
    target => renameAnimationOnSheet(target, animationId, name),
    target => renameAnimationOnSheet(target, animationId, before));
}

export function toggleAnimationLoop(services, sheetId, animationId, loop) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const before = anim.loop;
  if (before === loop) return;
  runSheetCommand(services, sheetId, 'toggle animation loop',
    () => { anim.loop = loop; },
    () => { anim.loop = before; });
}

// No before/after equality guard here -- matches js/ui/animpanel.js's
// commitBaseDuration exactly, which always pushes a command even when
// nothing actually changed (buildBaseDurationControl only calls setValue on
// a real user commit, so this hasn't needed a guard in practice).
export function setAnimationBaseDuration(services, sheetId, animationId, before, after) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  runSheetCommand(services, sheetId, 'edit base duration',
    () => { anim.baseDuration = after.durationMs; anim.baseFps = after.baseFps; anim.baseStep = after.baseStep; },
    () => { anim.baseDuration = before.durationMs; anim.baseFps = before.baseFps; anim.baseStep = before.baseStep; });
}
