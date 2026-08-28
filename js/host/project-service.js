export class ProjectService {
  #store;
  #documents;

  constructor(store, documents) {
    this.#store = store;
    this.#documents = documents;
  }

  get project() { return this.#store.getState().project.model; }
  get dirty() { return this.#store.getState().project.dirty; }

  replace(project, { dirty = false } = {}) {
    this.#store.setProject(project, { dirty, reason: 'project-replaced' });
    const modeId = this.#store.getState().session.activeModeId;
    return modeId;
  }

  markDirty() { this.#store.markDirty(true); }
  markSaved() { this.#store.markDirty(false); }

  mutate(reason, mutateFn) {
    if (typeof mutateFn !== 'function') throw new TypeError('ProjectService.mutate requires a mutation callback');
    if (!this.#store.getState().project.model) throw new Error('Cannot mutate: no project is loaded');
    let result;
    this.#store.transaction(reason, state => {
      result = mutateFn(state.project.model);
      this.#store.markDirty();
    });
    return result;
  }
}
