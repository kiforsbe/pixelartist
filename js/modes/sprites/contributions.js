// js/modes/sprites/contributions.js
import { registerFrameTool, bindFrameTool, drawFrameChrome } from './presentation/frame-tool-presenter.js';
import { mountFramesPanel } from './presentation/frames-panel.js';
import { mountAnimationsPanel } from './presentation/animations-panel.js';
import { mountFrameEditor } from './presentation/frame-editor-presenter.js';
import { mountTimeline } from './presentation/timeline-presenter.js';
import { renderSpritePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  createFrame, deleteFrame, resizeFrame, moveFrames, sliceSheetIntoFrames, findSpriteSheet,
} from './application/commands/frame-commands.js';
import {
  newAutoAnimation, addAutoFrame, linkAutoFrame, deleteAutoFrame, moveAutoFrame, resizeSpriteSize,
  autoLayoutAnimation, makeManual, reorderAnimations, duplicateAnimation, deleteAutoAnimation, setAnimationPivot,
  deleteLaidOutFrame,
} from './application/commands/animation-layout-commands.js';
import {
  moveFrames as moveAnimationFrames, copyFrames, duplicateFrames, deleteFrames, reverseFrames, setFrameDurations,
  unlinkFrame, clearCel, splitFrames,
} from './application/commands/animation-range-commands.js';
import { isPinnedFrame } from '../../domain/sprites/auto-layout.js';
import { setFrameField, setFramePivot } from './application/commands/frame-metadata-commands.js';
import {
  newAnimation, deleteAnimation, renameAnimation, toggleAnimationLoop, setAnimationBaseDuration,
  setAnimationDirection, setAnimationColor,
} from './application/commands/animation-lifecycle-commands.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration, setAnimationFrameStep,
} from './application/commands/animation-frame-commands.js';
import {
  toggleLayerVisible, toggleLayerLocked, addLayer, addGroup, deleteNode, mergeLayerDownCmd,
  moveNode, dragMoveNode, renameNode, setLayerOpacity,
} from './application/commands/layer-commands.js';

function services() { const host = getEditorHost(); return { store: host.store, projects: host.projects, history: host.history, selections: host.selections }; }

// Registered by id so presentation/ (the Presenter, the slice dialog, the
// Frames panel) and shared UI (the Layers panel) can dispatch through
// getEditorHost().registries.commands.execute(id, context, args) instead of
// importing these Command Handlers directly. This
// file lives outside presentation/, so importing application/commands/ here
// is fine; tests/architecture.test.mjs only bans that import from
// presentation/**.
function registerSpriteCommands(api) {
  // Both sprite workbenches edit sprite sheets with these commands.
  const whenSpriteSheets = keys => keys.modeId === 'sprites' || keys.modeId === 'animations';
  const command = (id, execute) => api.commands.register({ id, when: whenSpriteSheets, execute });

  command('sprites.createFrame', (_context, { sheetId, rect }) => createFrame(services(), sheetId, rect));
  command('sprites.resizeFrame', (_context, { sheetId, frameId, before, after }) => resizeFrame(services(), sheetId, frameId, before, after));
  // A pinned frame's delete goes through the layout: it leaves every
  // animation and its rect is cleared, so later layouts see no stray pixels.
  command('sprites.deleteFrame', (_context, { sheetId, frameId }) => {
    const sheet = findSpriteSheet(services().projects.project, sheetId);
    return sheet && isPinnedFrame(sheet, frameId)
      ? deleteLaidOutFrame(services(), sheetId, frameId)
      : deleteFrame(services(), sheetId, frameId);
  });
  command('sprites.moveFrames', (_context, { sheetId, frameIds, dx, dy }) => moveFrames(services(), sheetId, frameIds, dx, dy));
  command('sprites.sliceGrid', (_context, { sheetId, options, replace }) => sliceSheetIntoFrames(services(), sheetId, options, replace));

  command('sprites.setFrameField', (_context, { sheetId, frameId, key, value }) => setFrameField(services(), sheetId, frameId, key, value));
  command('sprites.setFramePivot', (_context, { sheetId, frameId, pivotX, pivotY }) => setFramePivot(services(), sheetId, frameId, pivotX, pivotY));

  command('sprites.newAnimation', (_context, { sheetId }) => newAnimation(services(), sheetId));
  command('sprites.deleteAnimation', (_context, { sheetId, animationId }) => deleteAnimation(services(), sheetId, animationId));
  command('sprites.renameAnimation', (_context, { sheetId, animationId, name }) => renameAnimation(services(), sheetId, animationId, name));
  command('sprites.toggleAnimationLoop', (_context, { sheetId, animationId, loop }) => toggleAnimationLoop(services(), sheetId, animationId, loop));
  command('sprites.setAnimationBaseDuration', (_context, { sheetId, animationId, before, after }) => setAnimationBaseDuration(services(), sheetId, animationId, before, after));
  command('sprites.setAnimationDirection', (_context, { sheetId, animationId, direction }) => setAnimationDirection(services(), sheetId, animationId, direction));
  command('sprites.setAnimationColor', (_context, { sheetId, animationId, color }) => setAnimationColor(services(), sheetId, animationId, color));

  command('sprites.addAnimationFrame', (_context, { sheetId, animationId, frameId }) => addAnimationFrame(services(), sheetId, animationId, frameId));
  command('sprites.removeAnimationFrame', (_context, { sheetId, animationId, index }) => removeAnimationFrame(services(), sheetId, animationId, index));
  command('sprites.reorderAnimationFrame', (_context, { sheetId, animationId, fromIndex, toIndex }) => reorderAnimationFrame(services(), sheetId, animationId, fromIndex, toIndex));
  command('sprites.setAnimationFrameDuration', (_context, { sheetId, animationId, index, duration }) => setAnimationFrameDuration(services(), sheetId, animationId, index, duration));
  command('sprites.setAnimationFrameStep', (_context, { sheetId, animationId, index, step }) => setAnimationFrameStep(services(), sheetId, animationId, index, step));

  command('sprites.addLayer', (_context, { sheetId, targetGroupId }) => addLayer(services(), sheetId, targetGroupId));
  command('sprites.addGroup', (_context, { sheetId, targetGroupId }) => addGroup(services(), sheetId, targetGroupId));
  command('sprites.deleteNode', (_context, { sheetId, nodeId }) => deleteNode(services(), sheetId, nodeId));
  command('sprites.mergeDown', (_context, { sheetId, layerId }) => mergeLayerDownCmd(services(), sheetId, layerId));
  command('sprites.moveNode', (_context, { sheetId, nodeId, delta }) => moveNode(services(), sheetId, nodeId, delta));
  command('sprites.dragMoveNode', (_context, { sheetId, nodeId, destParentId, destIndex }) => dragMoveNode(services(), sheetId, nodeId, destParentId, destIndex));
  command('sprites.toggleLayerVisible', (_context, { sheetId, layerId }) => toggleLayerVisible(services(), sheetId, layerId));
  command('sprites.toggleLayerLocked', (_context, { sheetId, layerId }) => toggleLayerLocked(services(), sheetId, layerId));
  command('sprites.renameNode', (_context, { sheetId, nodeId, name }) => renameNode(services(), sheetId, nodeId, name));
  command('sprites.setLayerOpacity', (_context, { sheetId, layerId, opacity }) => setLayerOpacity(services(), sheetId, layerId, opacity));
}

// Layout-aware animation commands. Registered once, for both workbenches:
// the Animations workbench (mode 'animations') is built on them, and Sprite
// Sheets needs Make manual, the shared pivot and auto-frame delete.
function registerAnimationLayoutCommands(api) {
  const when = keys => keys.modeId === 'sprites' || keys.modeId === 'animations';
  const command = (id, execute) => api.commands.register({ id, when, execute });
  command('animations.new', (_c, { sheetId, name }) => newAutoAnimation(services(), sheetId, { name }));
  command('animations.addFrame', (_c, { sheetId, animationId, at, copyOf, count }) => addAutoFrame(services(), sheetId, animationId, at, { copyOf, count }));
  command('animations.linkFrame', (_c, { sheetId, animationId, at, frameId }) => linkAutoFrame(services(), sheetId, animationId, at, frameId));
  command('animations.deleteFrame', (_c, { sheetId, animationId, index }) => deleteAutoFrame(services(), sheetId, animationId, index));
  command('animations.moveFrame', (_c, { sheetId, animationId, from, to }) => moveAutoFrame(services(), sheetId, animationId, from, to));
  command('animations.resizeCanvas', (_c, { sheetId, w, h, anchor }) => resizeSpriteSize(services(), sheetId, w, h, anchor));
  command('animations.autoLayout', (_c, { sheetId, animationId, size }) => autoLayoutAnimation(services(), sheetId, animationId, size));
  command('animations.makeManual', (_c, { sheetId, animationId }) => makeManual(services(), sheetId, animationId));
  command('animations.reorderAnimations', (_c, { sheetId, from, to }) => reorderAnimations(services(), sheetId, from, to));
  command('animations.duplicate', (_c, { sheetId, animationId }) => duplicateAnimation(services(), sheetId, animationId));
  // A manual animation keeps its frames, exactly like sprites.deleteAnimation.
  command('animations.delete', (_c, { sheetId, animationId }) => {
    const anim = findSpriteSheet(services().projects.project, sheetId)?.animations.find(a => a.id === animationId);
    if (anim?.layout === 'auto') return deleteAutoAnimation(services(), sheetId, animationId);
    deleteAnimation(services(), sheetId, animationId);
    return { ok: true };
  });
  command('animations.setPivot', (_c, { sheetId, animationId, pivotX, pivotY }) => setAnimationPivot(services(), sheetId, animationId, pivotX, pivotY));

  // Range commands (inclusive entry ranges; both layouts, one history step).
  command('animations.moveFrames', (_c, { sheetId, animationId, from, to, at }) => moveAnimationFrames(services(), sheetId, animationId, from, to, at));
  command('animations.copyFrames', (_c, { sheetId, animationId, from, to, at }) => copyFrames(services(), sheetId, animationId, from, to, at));
  command('animations.duplicateFrames', (_c, { sheetId, animationId, from, to }) => duplicateFrames(services(), sheetId, animationId, from, to));
  command('animations.deleteFrames', (_c, { sheetId, animationId, from, to }) => deleteFrames(services(), sheetId, animationId, from, to));
  command('animations.reverseFrames', (_c, { sheetId, animationId, from, to }) => reverseFrames(services(), sheetId, animationId, from, to));
  command('animations.setFrameDurations', (_c, { sheetId, animationId, from, to, duration, step }) => setFrameDurations(services(), sheetId, animationId, from, to, { duration, step }));
  command('animations.unlinkFrame', (_c, { sheetId, animationId, index }) => unlinkFrame(services(), sheetId, animationId, index));
  command('animations.splitFrames', (_c, { sheetId, animationId, from, to, name }) => splitFrames(services(), sheetId, animationId, from, to, { name }));
  command('animations.clearCel', (_c, { sheetId, frameId, layerId }) => clearCel(services(), sheetId, frameId, layerId));
}

export function registerSpriteContributions(api) {
  registerSpriteCommands(api);
  registerAnimationLayoutCommands(api);

  api.previews.register({ id: 'sprites.preview', order: 10, when: keys => keys.modeId === 'sprites', render: renderSpritePreview });
  api.tools.register({
    id: 'sprites.frame-tools', label: 'Sprite frame tools', order: 10,
    createController({ canvasView }) {
      registerFrameTool();
      bindFrameTool(canvasView);
      return {
        decorateOverlay() {
          const prior = canvasView.onOverlay;
          canvasView.onOverlay = ctx => { prior(ctx); drawFrameChrome(ctx, canvasView); };
        },
      };
    },
  });

  const whenSprites = keys => keys.modeId === 'sprites';
  api.panels.register({ id: 'sprites.frames', title: 'Frames', region: 'right', order: 10, mountPoint: 'panel-context', persistent: true, when: whenSprites, create: mountFramesPanel });
  api.panels.register({ id: 'sprites.animations', title: 'Animations', region: 'right', order: 20, mountPoint: 'panel-animation', persistent: true, when: whenSprites, create: mountAnimationsPanel });
  api.panels.register({ id: 'sprites.timeline', title: 'Timeline', region: 'bottom', order: 10, mountPoint: 'timeline-dock', useMountPointDirect: true, persistent: true, when: whenSprites, create: mountTimeline });

  api.views.register({ id: 'sprites.sheet', order: 10, create: (_host, { canvasView }) => ({ view: canvasView }) });
  api.views.register({ id: 'sprites.frame', order: 20, create: (_host, { canvasHost }) => mountFrameEditor(canvasHost) });
}
