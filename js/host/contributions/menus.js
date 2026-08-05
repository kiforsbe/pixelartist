import { ContributionRegistry } from './registry.js';

export class MenuRegistry extends ContributionRegistry {
  constructor() {
    super('menu', definition => {
      if (!Array.isArray(definition.items)) throw new TypeError(`Menu "${definition.id}" requires an items array`);
    });
  }
}
