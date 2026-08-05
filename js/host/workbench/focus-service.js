export class FocusService {
  #surfaceId = null;
  #listeners = new Set();

  get activeSurfaceId() { return this.#surfaceId; }

  focus(surfaceId) {
    if (this.#surfaceId === surfaceId) return;
    this.#surfaceId = surfaceId;
    for (const listener of [...this.#listeners]) listener(surfaceId);
  }

  subscribe(listener, { signal } = {}) {
    this.#listeners.add(listener);
    const dispose = () => this.#listeners.delete(listener);
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    return dispose;
  }
}
