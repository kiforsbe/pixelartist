function requireString(value, field, kind) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${kind} contribution requires a non-empty ${field}`);
  }
}

export function validateBaseContribution(definition, kind) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError(`${kind} contribution must be an object`);
  }
  requireString(definition.id, 'id', kind);
  if (definition.when != null && typeof definition.when !== 'function') {
    throw new TypeError(`${kind} contribution "${definition.id}" has a non-function when predicate`);
  }
}

export class ContributionRegistry {
  #kind;
  #validate;
  #entries = new Map();
  #listeners = new Set();

  constructor(kind, validate = () => {}) {
    this.#kind = kind;
    this.#validate = validate;
  }

  register(definition, { owner = 'core' } = {}) {
    validateBaseContribution(definition, this.#kind);
    this.#validate(definition);
    if (this.#entries.has(definition.id)) {
      throw new Error(`Duplicate ${this.#kind} contribution "${definition.id}"`);
    }
    const entry = Object.freeze({ definition: Object.freeze({ ...definition }), owner });
    this.#entries.set(definition.id, entry);
    this.#emit();
    let registered = true;
    return {
      dispose: () => {
        if (!registered || this.#entries.get(definition.id) !== entry) return;
        registered = false;
        this.#entries.delete(definition.id);
        this.#emit();
      },
    };
  }

  get(id) { return this.#entries.get(id)?.definition; }
  ownerOf(id) { return this.#entries.get(id)?.owner ?? null; }

  list(context = null) {
    return [...this.#entries.values()]
      .map(entry => entry.definition)
      .filter(definition => context == null || definition.when == null || definition.when(context))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  }

  removeOwner(owner) {
    let changed = false;
    for (const [id, entry] of this.#entries) {
      if (entry.owner !== owner) continue;
      this.#entries.delete(id);
      changed = true;
    }
    if (changed) this.#emit();
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

  #emit() {
    const entries = this.list();
    for (const listener of [...this.#listeners]) listener(entries);
  }
}
