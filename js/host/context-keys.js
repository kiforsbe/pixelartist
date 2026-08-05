export class ContextKeys {
  #values = new Map();
  #listeners = new Set();

  constructor(initial = {}) {
    this.update(initial);
  }

  get(key) { return this.#values.get(key); }
  has(key) { return this.#values.has(key); }

  set(key, value) {
    if (Object.is(this.#values.get(key), value)) return false;
    if (value === undefined) this.#values.delete(key);
    else this.#values.set(key, value);
    this.#emit(new Set([key]));
    return true;
  }

  update(values) {
    const changed = new Set();
    for (const [key, value] of Object.entries(values)) {
      if (Object.is(this.#values.get(key), value)) continue;
      if (value === undefined) this.#values.delete(key);
      else this.#values.set(key, value);
      changed.add(key);
    }
    if (changed.size) this.#emit(changed);
    return changed;
  }

  snapshot() { return Object.freeze(Object.fromEntries(this.#values)); }

  matches(predicate) {
    return typeof predicate !== 'function' || !!predicate(this.snapshot());
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

  #emit(changed) {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) listener(snapshot, changed);
  }
}
