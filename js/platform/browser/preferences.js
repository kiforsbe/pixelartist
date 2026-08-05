function resolveStorage(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class BrowserPreferences {
  #namespace;
  #storage;
  #memory = new Map();

  constructor({ namespace = 'pixelartist', storage = null } = {}) {
    this.#namespace = namespace;
    this.#storage = resolveStorage(storage);
  }

  #key(key) { return `${this.#namespace}.${key}`; }

  get(key, fallback = null) {
    const fullKey = this.#key(key);
    let raw;
    try { raw = this.#storage ? this.#storage.getItem(fullKey) : this.#memory.get(fullKey); }
    catch { raw = this.#memory.get(fullKey); }
    if (raw == null) return fallback;
    try { return JSON.parse(raw); }
    catch { return fallback; }
  }

  set(key, value) {
    const fullKey = this.#key(key);
    const raw = JSON.stringify(value);
    try {
      if (this.#storage) this.#storage.setItem(fullKey, raw);
      else this.#memory.set(fullKey, raw);
    } catch {
      this.#memory.set(fullKey, raw);
    }
  }

  remove(key) {
    const fullKey = this.#key(key);
    try { this.#storage?.removeItem(fullKey); } catch { /* fall back below */ }
    this.#memory.delete(fullKey);
  }
}
