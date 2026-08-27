// Cancels an in-progress pointer drag/stroke when the project changes out
// from under it (undo/redo, a remote command, ...) or the owning tool is
// switched away from. `subscribe` is a narrow adapter supplied by each mode
// over EditorStore selectors and HistoryService notifications.
export function bindDragCancelGuard(subscribe, { isToolActive, hasDrag, cancel, requestRender }) {
  const subscriptions = [
    subscribe('project', () => { if (hasDrag()) { cancel(); requestRender(); } }),
    subscribe('tool', () => { if (!isToolActive() && hasDrag()) { cancel(); requestRender(); } }),
  ];
  return { dispose() { subscriptions.forEach(dispose => dispose()); } };
}
