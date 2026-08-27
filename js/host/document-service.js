import { documentKey } from './editor-store.js';

function validateProvider(provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.kind !== 'string' || !provider.kind) {
    throw new TypeError('Document provider requires a non-empty kind');
  }
  for (const method of ['list', 'get', 'create', 'rename', 'remove']) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`Document provider "${provider.kind}" requires ${method}()`);
    }
  }
}

export class DocumentService {
  #store;
  #providers = new Map();

  constructor(store) { this.#store = store; }

  registerProvider(provider, { owner = 'core' } = {}) {
    validateProvider(provider);
    if (this.#providers.has(provider.kind)) throw new Error(`Duplicate document provider "${provider.kind}"`);
    const entry = { provider, owner };
    this.#providers.set(provider.kind, entry);
    return { dispose: () => { if (this.#providers.get(provider.kind) === entry) this.#providers.delete(provider.kind); } };
  }

  removeOwner(owner) {
    for (const [kind, entry] of this.#providers) if (entry.owner === owner) this.#providers.delete(kind);
  }

  provider(kind) { return this.#providers.get(kind)?.provider ?? null; }

  list(kinds, project = this.#store.getState().project.model) {
    if (!project) return [];
    return kinds.flatMap(kind => (this.provider(kind)?.list(project) ?? []).map(document => ({ kind, document })));
  }

  resolve(reference, project = this.#store.getState().project.model) {
    if (!reference || !project) return null;
    const document = this.provider(reference.kind)?.get(project, reference.id) ?? null;
    return document ? { kind: reference.kind, id: document.id } : null;
  }

  activateMode(mode) {
    const state = this.#store.getState();
    const remembered = state.session.activeDocumentByMode[mode.id];
    let reference = this.resolve(remembered);
    if (!reference) {
      const first = this.list(mode.documentKinds)[0];
      reference = first ? { kind: first.kind, id: first.document.id } : null;
    }
    this.#store.transaction('document', next => {
      next.session.activeDocument = reference;
      next.session.activeDocumentByMode[mode.id] = reference;
      this.#seedInitialSelection(next, reference);
    });
    return reference;
  }

  setActive(reference, { modeId = this.#store.getState().session.activeModeId, allowMissing = false } = {}) {
    const resolved = this.resolve(reference);
    if (!resolved && reference && !allowMissing) throw new Error(`Unknown document "${documentKey(reference)}"`);
    const value = resolved ?? (allowMissing ? reference : null);
    this.#store.transaction('document', state => {
      state.session.activeDocument = value;
      if (modeId) state.session.activeDocumentByMode[modeId] = value;
      this.#seedInitialSelection(state, value);
    });
    return value;
  }

  create(kind, input) {
    const state = this.#store.getState();
    const provider = this.provider(kind);
    if (!provider || !state.project.model) throw new Error(`Cannot create document of kind "${kind}"`);
    let document;
    this.#store.transaction('project', next => {
      document = provider.create(next.project.model, input);
      next.project.dirty = true;
    });
    this.setActive({ kind, id: document.id });
    return document;
  }

  rename(reference, name) {
    const state = this.#store.getState();
    const provider = this.provider(reference.kind);
    const document = provider?.get(state.project.model, reference.id);
    if (!document) throw new Error(`Unknown document "${documentKey(reference)}"`);
    this.#store.transaction('project', next => {
      provider.rename(document, name);
      next.project.dirty = true;
    });
  }

  remove(reference) {
    const state = this.#store.getState();
    const provider = this.provider(reference.kind);
    if (!provider || !provider.get(state.project.model, reference.id)) return false;
    this.#store.transaction('project', next => {
      provider.remove(next.project.model, reference.id);
      next.project.dirty = true;
      delete next.session.selectionsByDocument[documentKey(reference)];
    });
    const modeId = this.#store.getState().session.activeModeId;
    return modeId ? (this.activateMode({ id: modeId, documentKinds: [reference.kind] }), true) : true;
  }

  #seedInitialSelection(state, reference) {
    const key = documentKey(reference);
    if (!key || !state.project.model || Object.hasOwn(state.session.selectionsByDocument, key)) return;
    const provider = this.provider(reference.kind);
    const document = provider?.get(state.project.model, reference.id) ?? null;
    const selection = document ? provider?.initialSelection?.(document, state.project.model) : null;
    if (selection != null) state.session.selectionsByDocument[key] = { ...selection };
  }
}
