import { ContributionRegistry } from './registry.js';

export class PreviewRegistry extends ContributionRegistry {
  constructor() {
    super('preview', definition => {
      if (typeof definition.render !== 'function') {
        throw new TypeError(`Preview "${definition.id}" requires render()`);
      }
    });
  }
}
