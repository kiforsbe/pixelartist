import { ContributionRegistry } from './registry.js';

export class ViewRegistry extends ContributionRegistry {
  constructor() {
    super('view', definition => {
      if (typeof definition.create !== 'function') throw new TypeError(`View "${definition.id}" requires create()`);
    });
  }
}
