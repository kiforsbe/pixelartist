import { toDisposable } from '../disposable.js';

export class ViewManager {
  #registry;
  #contextKeys;
  #host = null;
  #active = null;

  constructor({ registry, contextKeys }) {
    this.#registry = registry;
    this.#contextKeys = contextKeys;
  }

  setHost(element) { this.#host = element; }

  show(id, context) {
    if (this.#active?.id === id) return this.#active.controller;
    const definition = this.#registry.get(id);
    const keys = this.#contextKeys.snapshot();
    if (!definition || (definition.when && !definition.when(keys))) throw new Error(`View "${id}" is not available`);
    if (!this.#host) throw new Error('ViewManager has no host element');
    this.#active?.disposable.dispose();
    this.#host.replaceChildren();
    const controller = definition.create(this.#host, context);
    const disposable = toDisposable(controller);
    this.#active = { id, controller, disposable };
    return controller;
  }

  dispose() { this.#active?.disposable.dispose(); this.#active = null; }
}
