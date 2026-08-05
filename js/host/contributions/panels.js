import { ContributionRegistry } from './registry.js';

const REGIONS = new Set(['left', 'right', 'bottom']);

export class PanelRegistry extends ContributionRegistry {
  constructor() {
    super('panel', definition => {
      if (!REGIONS.has(definition.region)) throw new TypeError(`Panel "${definition.id}" has an invalid region`);
      if (typeof definition.create !== 'function') throw new TypeError(`Panel "${definition.id}" requires create()`);
    });
  }
}
