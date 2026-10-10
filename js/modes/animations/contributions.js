// js/modes/animations/contributions.js
// The Animations workbench's views, panels and preview. Commands are not
// registered here: this mode dispatches the sprites.* and animations.* ids
// that sprites mode registers for both workbenches.
import { mountAnimationCanvas } from './presentation/animation-canvas-presenter.js';
import { mountAnimationListPanel } from './presentation/animation-list-panel.js';
import { mountAnimationInspectorPanel } from './presentation/animation-inspector-panel.js';
import { mountAnimationTimeline } from './presentation/animation-timeline-presenter.js';
import { renderAnimationsPreview } from './preview.js';

export function registerAnimationsContributions(api) {
  const whenAnimations = keys => keys.modeId === 'animations';
  api.panels.register({ id: 'animations.list', title: 'Animations', region: 'right', order: 20, mountPoint: 'panel-animation', persistent: true, when: whenAnimations, create: mountAnimationListPanel });
  api.panels.register({ id: 'animations.inspector', title: 'Animation', region: 'right', order: 21, mountPoint: 'panel-animation-inspector', persistent: true, when: whenAnimations, create: mountAnimationInspectorPanel });
  api.panels.register({ id: 'animations.timeline', title: 'Timeline', region: 'bottom', order: 10, mountPoint: 'anim-timeline-dock', useMountPointDirect: true, persistent: true, when: whenAnimations, create: mountAnimationTimeline });
  api.previews.register({ id: 'animations.preview', order: 15, when: whenAnimations, render: renderAnimationsPreview });
  api.views.register({ id: 'animations.canvas', order: 30, create: (_host, { canvasHost }) => mountAnimationCanvas(canvasHost) });
}
