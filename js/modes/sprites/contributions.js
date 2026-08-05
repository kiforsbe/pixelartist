import { registerFrameTool, bindFrameTool, drawStripChrome } from './sprite-sheet-controller.js';
import { mountFramesPanel } from './frame-panel.js';
import { mountAnimationsPanel } from '../../ui/animpanel.js';
import { mountTimeline } from '../../ui/timeline.js';
import { mountFrameEditor } from '../../ui/frameeditor.js';
import { renderSpritePreview } from './preview.js';

export function registerSpriteContributions(api) {
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
