import { EditorStore } from './editor-store.js';
import { DocumentService } from './document-service.js';
import { HistoryService } from './history-service.js';
import { ProjectService } from './project-service.js';
import { SelectionService } from './selection-service.js';
import { ExportService } from './export-service.js';
import { ContextKeys } from './context-keys.js';
import { DisposableStore, toDisposable } from './disposable.js';
import { ModeRegistry } from './mode-registry.js';
import { CommandRegistry } from './contributions/commands.js';
import { PanelRegistry } from './contributions/panels.js';
import { ToolRegistry } from './contributions/tools.js';
import { ViewRegistry } from './contributions/views.js';
import { MenuRegistry } from './contributions/menus.js';
import { PreviewRegistry } from './contributions/previews.js';
import { FocusService } from './workbench/focus-service.js';

export class EditorHost {
  #modeRegistrations = new Map();
  #active = null;
  #modeListeners = new Set();
  #disposed = false;

  constructor({ store = new EditorStore(), historyStack = undefined, preferences = null, platform = {} } = {}) {
    this.store = store;
    this.contextKeys = new ContextKeys();
    this.preferences = preferences;
    this.platform = Object.freeze({ ...platform });

    this.registries = Object.freeze({
      modes: new ModeRegistry(),
      commands: new CommandRegistry(),
      panels: new PanelRegistry(),
      tools: new ToolRegistry(),
      views: new ViewRegistry(),
      menus: new MenuRegistry(),
      previews: new PreviewRegistry(),
    });

    this.documents = new DocumentService(store);
    this.history = new HistoryService({ store, stack: historyStack });
    this.projects = new ProjectService(store, this.documents);
    this.selections = new SelectionService(store);
    this.exports = new ExportService();
    this.focus = new FocusService();
    this.services = Object.freeze({
      store: this.store,
      documents: this.documents,
      history: this.history,
      projects: this.projects,
      selections: this.selections,
      exports: this.exports,
      focus: this.focus,
      preferences: this.preferences,
      platform: this.platform,
    });

    this.focus.subscribe(surfaceId => {
      this.store.updateSession({}, 'focus');
      this.store.transaction('focus', state => { state.workspace.focusedSurfaceId = surfaceId; });
      this.contextKeys.set('focusedSurfaceId', surfaceId);
    });
  }

  get activeModeId() { return this.#active?.mode.id ?? null; }
  get activeMode() { return this.#active?.mode ?? null; }

  registerMode(definition) {
    this.#assertAlive();
    const resources = new DisposableStore();
    const modeRegistration = resources.add(this.registries.modes.register(definition));
    try {
      definition.register?.(this.#registrationApi(definition.id, resources));
    } catch (error) {
      resources.dispose();
      this.#removeOwner(definition.id);
      throw error;
    }
    this.#modeRegistrations.set(definition.id, resources);
    return {
      dispose: () => {
        if (this.activeModeId === definition.id) throw new Error(`Cannot unregister active mode "${definition.id}"`);
        if (this.#modeRegistrations.get(definition.id) !== resources) return;
        this.#modeRegistrations.delete(definition.id);
        resources.dispose();
        modeRegistration.dispose();
        this.#removeOwner(definition.id);
      },
    };
  }

  start(initialModeId) {
    this.#assertAlive();
    const modeId = initialModeId ?? this.registries.modes.list()[0]?.id;
    if (!modeId) throw new Error('EditorHost cannot start without a registered mode');
    return this.activateMode(modeId);
  }

  activateMode(modeId) {
    this.#assertAlive();
    if (this.activeModeId === modeId) return this.#active?.value;
    const mode = this.registries.modes.get(modeId);
    if (!mode) throw new Error(`Unknown editor mode "${modeId}"`);

    const state = this.store.getState();
    const previousSession = {
      activeModeId: state.session.activeModeId,
      activeDocument: state.session.activeDocument,
      activeViewId: state.session.activeViewId,
    };
    const previousKeys = this.contextKeys.snapshot();
    const controller = new AbortController();
    let value;
    try {
      this.store.transaction('mode', next => {
        next.session.activeModeId = mode.id;
        next.session.activeViewId = mode.defaultViewId;
      });
      const document = this.documents.activateMode(mode);
      this.contextKeys.update({
        modeId: mode.id,
        documentKind: document?.kind,
        viewId: mode.defaultViewId,
      });
      const context = this.#modeContext(mode, controller.signal);
      value = mode.activate?.(context);
      // Async activation would make rollback and DOM reconciliation ambiguous;
      // modes perform async work after activation through their own services.
      if (value && typeof value.then === 'function') throw new TypeError(`Mode "${mode.id}" activation must be synchronous`);
    } catch (error) {
      controller.abort();
      this.store.transaction('mode-rollback', next => Object.assign(next.session, previousSession));
      this.contextKeys.update({
        modeId: previousKeys.modeId,
        documentKind: previousKeys.documentKind,
        viewId: previousKeys.viewId,
      });
      throw error;
    }

    const previous = this.#active;
    this.#active = { mode, controller, value, disposable: toDisposable(value) };
    if (previous) {
      previous.controller.abort();
      previous.disposable.dispose();
    }
    const event = Object.freeze({ modeId: mode.id, mode, previousModeId: previous?.mode.id ?? null });
    for (const listener of [...this.#modeListeners]) listener(event);
    return value;
  }

  setProject(project, { dirty = false } = {}) {
    this.projects.replace(project, { dirty });
    if (this.activeMode) {
      const document = this.documents.activateMode(this.activeMode);
      this.contextKeys.set('documentKind', document?.kind);
    }
  }

  onDidChangeMode(listener, { signal } = {}) {
    this.#modeListeners.add(listener);
    const dispose = () => this.#modeListeners.delete(listener);
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    return dispose;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#active) {
      this.#active.controller.abort();
      this.#active.disposable.dispose();
      this.#active = null;
    }
    for (const resources of this.#modeRegistrations.values()) resources.dispose();
    this.#modeRegistrations.clear();
    this.#modeListeners.clear();
  }

  #registrationApi(owner, resources) {
    const scoped = registry => ({ register: definition => resources.add(registry.register(definition, { owner })) });
    return Object.freeze({
      commands: scoped(this.registries.commands),
      panels: scoped(this.registries.panels),
      tools: scoped(this.registries.tools),
      views: scoped(this.registries.views),
      menus: scoped(this.registries.menus),
      previews: scoped(this.registries.previews),
      documents: { register: provider => resources.add(this.documents.registerProvider(provider, { owner })) },
      services: this.services,
    });
  }

  #modeContext(mode, signal) {
    return Object.freeze({
      host: this,
      mode,
      signal,
      services: this.services,
      contextKeys: this.contextKeys,
      commands: this.registries.commands,
      panels: this.registries.panels,
      tools: this.registries.tools,
      views: this.registries.views,
      menus: this.registries.menus,
      previews: this.registries.previews,
    });
  }

  #removeOwner(owner) {
    this.documents.removeOwner(owner);
    for (const registry of [this.registries.commands, this.registries.panels, this.registries.tools, this.registries.views, this.registries.menus, this.registries.previews]) {
      registry.removeOwner(owner);
    }
  }

  #assertAlive() { if (this.#disposed) throw new Error('EditorHost is disposed'); }
}
