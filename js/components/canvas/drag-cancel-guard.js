// Cancels an in-progress pointer drag/stroke when the project changes out
// from under it (undo/redo, a remote command, ...) or the owning tool is
// switched away from -- every mode's pointer-tool presenter needs this so a
// stale drag doesn't keep mutating an object that's no longer selected, or
// isn't there anymore. `isToolActive` identifies the tool(s) this drag state
// belongs to; on a 'tool' change away from that, the drag is cancelled the
// same as a 'project' change always cancels it.
export function bindDragCancelGuard(on, { isToolActive, hasDrag, cancel, requestRender }) {
  const subscriptions = [
    on('project', () => { if (hasDrag()) { cancel(); requestRender(); } }),
    on('tool', () => { if (!isToolActive() && hasDrag()) { cancel(); requestRender(); } }),
  ];
  return { dispose() { subscriptions.forEach(dispose => dispose()); } };
}
