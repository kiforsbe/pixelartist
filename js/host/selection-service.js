export class SelectionService {
  #store;
  constructor(store) { this.#store = store; }
  get(document = this.#store.getState().session.activeDocument) { return this.#store.getSelection(document); }
  set(selection, document = this.#store.getState().session.activeDocument) { this.#store.setSelection(document, selection); }
  clear(document = this.#store.getState().session.activeDocument) { this.#store.setSelection(document, {}); }
}
