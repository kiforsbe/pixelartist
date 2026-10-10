// js/features/workbench/view-switching.js
// One view is visible at a time. A controller with show()/hide() owns its own
// surface inside #canvas-host (the Frame Editor, the Tile Editor, the
// Animations canvas); the others ({ view }) draw on the shared sheet canvas,
// which hides while an owning controller is up.
export function applyViewControllers(viewId, controllers, sheetCanvas) {
  const owner = controllers.get(viewId);
  sheetCanvas.style.display = typeof owner?.show === 'function' ? 'none' : '';
  for (const [id, controller] of controllers) {
    if (typeof controller.show !== 'function') continue;
    if (id === viewId) controller.show(); else controller.hide();
  }
}
