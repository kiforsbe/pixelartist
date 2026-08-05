import { ContributionRegistry } from './registry.js';

export class ToolRegistry extends ContributionRegistry {
  constructor() {
    super('tool', definition => {
      if (typeof definition.createController !== 'function') {
        throw new TypeError(`Tool "${definition.id}" requires createController()`);
      }
    });
  }
}
