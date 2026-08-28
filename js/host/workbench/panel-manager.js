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
      if (mounted.definition.persistent) {
        mounted.frame.element.hidden = true;
        continue;
      }
      mounted.disposable.dispose();
      if (!mounted.frame.external) mounted.frame.element.remove();
      this.#mounted.delete(id);
    }
    for (const panel of this.#registry.list(keys)) {
      const existing = this.#mounted.get(panel.id);
      if (existing) {
        existing.frame.element.hidden = false;
        continue;
      }
      const region = this.#regions.get(panel.region);
      if (!region) continue;
      const prefKey = `workspace.panels.${panel.id}`;
      const preferences = this.#preferences?.get(prefKey, {}) ?? {};
      if (preferences.hidden) continue;
      const frame = this.#createFrame(panel, region, prefKey, preferences);
      const disposable = toDisposable(panel.create(frame.body, context));
      this.#mounted.set(panel.id, { definition: panel, frame, disposable });
    }
    // A hidden contribution must not leave its padded/bordered mount point empty.
    // Include not-yet-mounted panels (initial mode) and combine shared mount points:
    // hiding Tiles must not hide the Frames/Map panel using the same container.
    const visibleMounts = new Map();
    for (const panel of this.#registry.list()) {
      if (!panel.mountPoint) continue;
      const visible = wanted.has(panel.id) && this.#mounted.has(panel.id);
      visibleMounts.set(panel.mountPoint, visibleMounts.get(panel.mountPoint) || visible);
    }
    for (const [id, visible] of visibleMounts) {
      const mount = document.getElementById(id);
      if (mount) mount.hidden = !visible;
    }
  }

  dispose() {
    for (const mounted of this.#mounted.values()) {
      mounted.disposable.dispose();
      if (!mounted.frame.external) mounted.frame.element.remove();
    }
    this.#mounted.clear();
  }

  #createFrame(panel, region, prefKey, preferences) {
    if (panel.mountPoint) {
      const mount = document.getElementById(panel.mountPoint);
      if (!mount) throw new Error(`Panel "${panel.id}" mount point "${panel.mountPoint}" was not found`);
      if (panel.useMountPointDirect) return { element: mount, body: mount, external: true };
      const body = document.createElement('div');
      body.className = 'workbench-contribution';
      body.dataset.panelId = panel.id;
      mount.appendChild(body);
      return { element: body, body, external: false };
    }
    const frame = createPanelFrame({
      id: panel.id,
      title: panel.title ?? panel.id,
      collapsed: !!preferences.collapsed,
      onCollapsedChange: collapsed => this.#preferences?.set(prefKey, { ...preferences, collapsed }),
    });
    region.appendChild(frame.element);
    return { ...frame, external: false };
  }
}
