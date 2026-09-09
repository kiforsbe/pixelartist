// js/modes/sprites/contributions.js
import { registerFrameTool, bindFrameTool, drawStripChrome } from './presentation/frame-tool-presenter.js';
import { mountFramesPanel } from './presentation/frames-panel.js';
import { mountAnimationsPanel } from './presentation/animations-panel.js';
import { mountFrameEditor } from './presentation/frame-editor-presenter.js';
import { mountTimeline } from './presentation/timeline-presenter.js';
import { renderSpritePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  createFrame, deleteFrame, resizeFrame, moveFrames, sliceSheetIntoFrames,
} from './application/commands/frame-commands.js';
import {
  insertStripFrame, splitStrip, resizeStripSegment, removeStripMember,
  mergeStripSegments, newStripFromFrame,
} from './application/commands/strip-commands.js';
import {
  setFrameField, moveStripTo, setStripFrameSize, setStripPivot,
} from './application/commands/frame-metadata-commands.js';
import { breakApartStrip, acceptAnimation } from './application/commands/animation-commands.js';
import {
  newAnimation, deleteAnimation, renameAnimation, toggleAnimationLoop, setAnimationBaseDuration,
} from './application/commands/animation-lifecycle-commands.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration, setAnimationFrameStep,
} from './application/commands/animation-frame-commands.js';
import {
  toggleLayerVisible, addLayer, addGroup, deleteNode, mergeLayerDownCmd,
  moveNode, dragMoveNode, renameNode, setLayerOpacity,
} from './application/commands/layer-commands.js';

function services() { const host = getEditorHost(); return { store: host.store, projects: host.projects, history: host.history, selections: host.selections }; }

// Registered by id so presentation/ (the Presenter, the slice dialog, the
// Frames panel) and shared UI (js/features/animations/commands.js's façade)
// can dispatch through getEditorHost().registries.commands.execute(id,
// context, args) instead of importing these Command Handlers directly. This
// file lives outside presentation/, so importing application/commands/ here
// is fine; tests/architecture.test.mjs only bans that import from
// presentation/**.
function registerSpriteCommands(api) {
  const whenSprites = keys => keys.modeId === 'sprites';
  const command = (id, execute) => api.commands.register({ id, when: whenSprites, execute });

  command('sprites.createFrame', (_context, { sheetId, rect }) => createFrame(services(), sheetId, rect));
  command('sprites.deleteFrame', (_context, { sheetId, frameId }) => deleteFrame(services(), sheetId, frameId));
  command('sprites.resizeFrame', (_context, { sheetId, frameId, before, after }) => resizeFrame(services(), sheetId, frameId, before, after));
  command('sprites.moveFrames', (_context, { sheetId, frameIds, dx, dy, animationId }) => moveFrames(services(), sheetId, frameIds, dx, dy, animationId));
  command('sprites.sliceGrid', (_context, { sheetId, options, replace }) => sliceSheetIntoFrames(services(), sheetId, options, replace));

  command('sprites.insertStripFrame', (_context, { sheetId, animationId, runIndex, k }) => insertStripFrame(services(), sheetId, animationId, runIndex, k));
  command('sprites.splitStrip', (_context, { sheetId, animationId, index }) => splitStrip(services(), sheetId, animationId, index));
  command('sprites.resizeStripSegment', (_context, { sheetId, animationId, runIndex, side, count }) => resizeStripSegment(services(), sheetId, animationId, runIndex, side, count));
  command('sprites.removeStripMember', (_context, { sheetId, animationId, frameId }) => removeStripMember(services(), sheetId, animationId, frameId));
  command('sprites.mergeStripSegments', (_context, { sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy }) =>
    mergeStripSegments(services(), sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy));
  command('sprites.newStripFromFrame', (_context, { sheetId, frameId, side, count }) => newStripFromFrame(services(), sheetId, frameId, side, count));

  command('sprites.setFrameField', (_context, { sheetId, frameId, key, value }) => setFrameField(services(), sheetId, frameId, key, value));
  command('sprites.moveStripTo', (_context, { sheetId, animationId, x, y }) => moveStripTo(services(), sheetId, animationId, x, y));
  command('sprites.setStripFrameSize', (_context, { sheetId, animationId, key, value }) => setStripFrameSize(services(), sheetId, animationId, key, value));
  command('sprites.setStripPivot', (_context, { sheetId, animationId, key, value }) => setStripPivot(services(), sheetId, animationId, key, value));

  command('sprites.breakApartStrip', (_context, { sheetId, animationId }) => breakApartStrip(services(), sheetId, animationId));
  command('sprites.acceptAnimation', (_context, { sheetId, animationId }) => acceptAnimation(services(), sheetId, animationId));

  command('sprites.newAnimation', (_context, { sheetId }) => newAnimation(services(), sheetId));
  command('sprites.deleteAnimation', (_context, { sheetId, animationId }) => deleteAnimation(services(), sheetId, animationId));
  command('sprites.renameAnimation', (_context, { sheetId, animationId, name }) => renameAnimation(services(), sheetId, animationId, name));
  command('sprites.toggleAnimationLoop', (_context, { sheetId, animationId, loop }) => toggleAnimationLoop(services(), sheetId, animationId, loop));
  command('sprites.setAnimationBaseDuration', (_context, { sheetId, animationId, before, after }) => setAnimationBaseDuration(services(), sheetId, animationId, before, after));

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
  command('sprites.renameNode', (_context, { sheetId, nodeId, name }) => renameNode(services(), sheetId, nodeId, name));
  command('sprites.setLayerOpacity', (_context, { sheetId, layerId, opacity }) => setLayerOpacity(services(), sheetId, layerId, opacity));
}

export function registerSpriteContributions(api) {
  registerSpriteCommands(api);

  api.previews.register({ id: 'sprites.preview', order: 10, when: keys => keys.modeId === 'sprites', render: renderSpritePreview });
  api.tools.register({
    id: 'sprites.frame-tools', label: 'Sprite frame tools', order: 10,
    createController({ canvasView }) {
      registerFrameTool();
      bindFrameTool(canvasView);
      return {
        decorateOverlay() {
          const prior = canvasView.onOverlay;
          canvasView.onOverlay = ctx => { prior(ctx); drawStripChrome(ctx, canvasView); };
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
