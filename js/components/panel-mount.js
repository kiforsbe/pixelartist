// Shared debounced-render + selector subscription/dispose wiring for panels.
// `selectors` entries are either a selector function or a `[selector,
// handler]` pair; handlers run synchronously before the deferred render.
export function mountStorePanel(store, selectors, render, { onDispose } = {}) {
  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  const subscriptions = selectors.map(spec => {
    const [selector, handler] = Array.isArray(spec) ? spec : [spec, null];
    return store.subscribe(selector, handler ? () => { handler(); scheduleRender(); } : scheduleRender);
  });
  render();
  return {
    scheduleRender,
    dispose() { onDispose?.(); subscriptions.forEach(dispose => dispose()); },
  };
}
