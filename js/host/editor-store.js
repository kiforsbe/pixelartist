export function documentKey(document) {
  return document ? `${document.kind}:${document.id}` : null;
}

export function createEditorState(initial = {}) {
  return {
    project: { model: null, dirty: false, ...(initial.project ?? {}) },
    session: {
      activeModeId: null,
      activeDocument: null,
      activeDocumentByMode: {},
      activeViewId: null,
      activeToolId: null,
      selectionsByDocument: {},
      ...(initial.session ?? {}),
    },
    interaction: { ...(initial.interaction ?? {}) },
    workspace: { focusedSurfaceId: null, ...(initial.workspace ?? {}) },
  };
}

/**
 * Small selector-based store. Domain objects intentionally stay mutable during
 * the migration; transactions provide a single notification boundary.
 */
export class EditorStore {
  #state;
  #subscriptions = new Set();
  #depth = 0;
  #pendingReasons = new Set();

  constructor(initial) {
    this.#state = createEditorState(initial);
  }

  getState() { return this.#state; }

  transaction(reason, mutate) {
    if (typeof mutate !== 'function') throw new TypeError('EditorStore.transaction requires a mutation callback');
    this.#depth++;
    if (reason) this.#pendingReasons.add(reason);
    try {
      return mutate(this.#state);
    } finally {
      this.#depth--;
      if (this.#depth === 0) this.#flush();
    }
  }

  setProject(model, { dirty = false, reason = 'project' } = {}) {
    this.transaction(reason, state => {
      state.project.model = model;
      state.project.dirty = !!dirty;
    });
  }

  markDirty(dirty = true) {
    this.transaction('dirty', state => { state.project.dirty = !!dirty; });
  }

  updateSession(patch, reason = 'session') {
    this.transaction(reason, state => Object.assign(state.session, patch));
  }

  setSelection(document, selection) {
    const key = documentKey(document);
    if (!key) return;
    this.transaction('selection', state => {
      state.session.selectionsByDocument[key] = { ...(selection ?? {}) };
    });
  }

  getSelection(document) {
    const key = documentKey(document);
    return key ? this.#state.session.selectionsByDocument[key] ?? null : null;
  }

  subscribe(selector, listener, { equals = Object.is, signal, fireImmediately = false } = {}) {
    if (typeof selector !== 'function' || typeof listener !== 'function') {
      throw new TypeError('EditorStore.subscribe requires selector and listener functions');
    }
    const subscription = { selector, listener, equals, value: selector(this.#state) };
    this.#subscriptions.add(subscription);
    const dispose = () => this.#subscriptions.delete(subscription);
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    if (fireImmediately && !signal?.aborted) listener(subscription.value, undefined, new Set(['initial']));
    return dispose;
  }

  #flush() {
    const reasons = this.#pendingReasons;
    this.#pendingReasons = new Set();
    if (!reasons.size) return;
    for (const subscription of [...this.#subscriptions]) {
      const next = subscription.selector(this.#state);
      if (subscription.equals(next, subscription.value)) continue;
      const previous = subscription.value;
      subscription.value = next;
      subscription.listener(next, previous, reasons);
    }
  }
}
