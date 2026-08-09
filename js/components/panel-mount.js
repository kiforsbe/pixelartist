// Shared debounced-render + on(...) subscription/dispose wiring used by
// every sheet/tile/frame side panel. Batches bursts of events that fire
// together (e.g. a command's project + history emit) into a single
// microtask-deferred render instead of re-rendering once per event.
//
// `events` entries are either an event name (wired straight to the debounced
// render) or an `[event, handler]` pair, where `handler` runs synchronously
// first (e.g. to sync local selection state) and the debounced render still
// follows. `onDispose`, if given, runs before subscriptions are torn down
// (e.g. to stop an in-flight rAF loop).
export function mountReactivePanel(on, events, render, { onDispose } = {}) {
  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  const subscriptions = events.map(spec => {
    const [event, handler] = Array.isArray(spec) ? spec : [spec, null];
    return on(event, handler ? () => { handler(); scheduleRender(); } : scheduleRender);
  });
  render();
  return {
    scheduleRender,
    dispose() { onDispose?.(); subscriptions.forEach(dispose => dispose()); },
  };
}
