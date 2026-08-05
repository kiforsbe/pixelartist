import { toDisposable } from '../disposable.js';
import { createPanelFrame } from '../../components/panels/panel-frame.js';

export class PanelManager {
  #registry;
  #contextKeys;
  #preferences;
  #regions = new Map();
  #mounted = new Map();

  constructor({ registry, contextKeys, preferences = null }) {
    this.#registry = registry;
    this.#contextKeys = contextKeys;
    this.#preferences = preferences;
  }

  setRegions(regions) {
    this.#regions = new Map(Object.entries(regions).filter(([, element]) => !!element));
  }

  reconcile(context) {
    const keys = this.#contextKeys.snapshot();
    const wanted = new Set(this.#registry.list(keys).map(panel => panel.id));
    for (const [id, mounted] of this.#mounted) {
      if (wanted.has(id)) continue;
      mounted.disposable.dispose();
      mounted.frame.element.remove();
      this.#mounted.delete(id);
    }
    for (const panel of this.#registry.list(keys)) {
      if (this.#mounted.has(panel.id)) continue;
      const region = this.#regions.get(panel.region);
      if (!region) continue;
      const prefKey = `workspace.panels.${panel.id}`;
      const preferences = this.#preferences?.get(prefKey, {}) ?? {};
      if (preferences.hidden) continue;
      const frame = createPanelFrame({
        id: panel.id,
        title: panel.title ?? panel.id,
        collapsed: !!preferences.collapsed,
        onCollapsedChange: collapsed => this.#preferences?.set(prefKey, { ...preferences, collapsed }),
      });
      region.appendChild(frame.element);
      const disposable = toDisposable(panel.create(frame.body, context));
      this.#mounted.set(panel.id, { frame, disposable });
    }
  }

  dispose() {
    for (const mounted of this.#mounted.values()) mounted.disposable.dispose();
    this.#mounted.clear();
  }
}
