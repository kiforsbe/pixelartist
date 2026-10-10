// js/modes/sprites/application/commands/animation-lifecycle-commands.js
import {
  addAnimation, renameAnimation as renameAnimationOnSheet, ANIMATION_DIRECTIONS, animationColor,
} from '../../../../core/model.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function isActiveSheet(services, sheet) {
  const doc = services.store?.getState().session.activeDocument;
  return doc?.id === sheet.id && (doc.kind === 'sprite-sheet' || doc.kind === 'tile-sheet');
}

// A new animation is manual with zero frames. Only touch selection while
// this command's own sheet is on screen (history is one global stack shared
// by every sheet); remember the index at undo time so a redo reinserts at
// the same spot.
export function newAnimation(services, sheetId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const doc = sheetDocument(sheet);
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  runSheetCommand(services, sheetId, 'new animation',
    target => {
      if (!anim) { anim = addAnimation(target, name, services.projects.project?.settings); idx = target.animations.indexOf(anim); }
      else if (!target.animations.includes(anim)) target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (isActiveSheet(services, target)) services.selections.set({ ...services.selections.get(doc), animationId: anim.id }, doc);
    },
    target => {
      idx = target.animations.indexOf(anim);
      target.animations = target.animations.filter(a => a !== anim);
      if (services.selections.get(doc)?.animationId === anim.id) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    });
}

// Deleting a manual animation keeps its frames: they are viewports onto the
// sheet that other animations or maps may still use. (Auto animations go
// through animation-layout-commands.js's deleteAutoAnimation instead.)
export function deleteAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = services.selections.get(doc)?.animationId === animationId;
  runSheetCommand(services, sheetId, 'delete animation',
    target => {
      target.animations = target.animations.filter(a => a.id !== animationId);
      if (services.selections.get(doc)?.animationId === animationId) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    },
    target => {
      target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
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

// Direction (core/model.js's ANIMATION_DIRECTIONS) and tag colour
// ('#rrggbb' or null) work the same on both layouts: one history step each,
// a repeated value records nothing, an unknown value is refused.
export function setAnimationDirection(services, sheetId, animationId, direction) {
  const anim = findSpriteSheet(services.projects.project, sheetId)?.animations.find(a => a.id === animationId);
  if (!anim) return { ok: false, reason: 'No such animation' };
  if (!ANIMATION_DIRECTIONS.includes(direction)) return { ok: false, reason: `Unknown direction "${direction}"` };
  const before = anim.direction;
  if (before === direction) return { ok: true };
  runSheetCommand(services, sheetId, 'set animation direction',
    () => { anim.direction = direction; },
    () => { anim.direction = before; });
  return { ok: true };
}

export function setAnimationColor(services, sheetId, animationId, color) {
  const anim = findSpriteSheet(services.projects.project, sheetId)?.animations.find(a => a.id === animationId);
  if (!anim) return { ok: false, reason: 'No such animation' };
  const after = color === null ? null : animationColor(color);
  if (color !== null && after === null) return { ok: false, reason: 'A colour must be #rrggbb or none' };
  const before = anim.color ?? null;
  if (before === after) return { ok: true };
  runSheetCommand(services, sheetId, 'set animation colour',
    () => { anim.color = after; },
    () => { anim.color = before; });
  return { ok: true };
}

// No before/after equality guard here -- matches animations-panel.js's
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
