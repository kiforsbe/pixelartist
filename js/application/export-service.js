export class ExportService {
  #providers = new Map();

  register(id, provider) {
    if (typeof id !== 'string' || !id || typeof provider !== 'function') throw new TypeError('Export provider requires id and function');
    if (this.#providers.has(id)) throw new Error(`Duplicate export provider "${id}"`);
    this.#providers.set(id, provider);
    return { dispose: () => this.#providers.delete(id) };
  }

  list() { return [...this.#providers.keys()]; }
  run(id, context, options) {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown export provider "${id}"`);
    return provider(context, options);
  }
}
