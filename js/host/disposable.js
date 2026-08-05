/** Normalize a teardown callback or disposable object. */
export function toDisposable(value) {
  if (value == null) return { dispose() {} };
  if (typeof value === 'function') return { dispose: value };
  if (typeof value.dispose === 'function') return value;
  throw new TypeError('Expected a dispose function or an object with dispose()');
}

/** Owns a group of resources and disposes them exactly once. */
export class DisposableStore {
  #items = new Set();
  #disposed = false;

  get disposed() { return this.#disposed; }

  add(value) {
    const disposable = toDisposable(value);
    if (this.#disposed) disposable.dispose();
    else this.#items.add(disposable);
    return disposable;
  }

  clear() {
    const items = [...this.#items].reverse();
    this.#items.clear();
    for (const item of items) item.dispose();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.clear();
  }
}

export function listen(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  return { dispose: () => target.removeEventListener(type, listener, options) };
}
