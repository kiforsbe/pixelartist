import { ContributionRegistry } from './contributions/registry.js';

export class ModeRegistry extends ContributionRegistry {
  constructor() {
    super('mode', definition => {
      if (typeof definition.label !== 'string' || !definition.label.trim()) {
        throw new TypeError(`Mode "${definition.id}" requires a label`);
      }
      if (!Array.isArray(definition.documentKinds) || !definition.documentKinds.length ||
          definition.documentKinds.some(kind => typeof kind !== 'string' || !kind)) {
        throw new TypeError(`Mode "${definition.id}" requires documentKinds`);
      }
      if (typeof definition.defaultViewId !== 'string' || !definition.defaultViewId) {
        throw new TypeError(`Mode "${definition.id}" requires defaultViewId`);
      }
      if (definition.register != null && typeof definition.register !== 'function') {
        throw new TypeError(`Mode "${definition.id}" has a non-function register hook`);
      }
      if (definition.activate != null && typeof definition.activate !== 'function') {
        throw new TypeError(`Mode "${definition.id}" has a non-function activate hook`);
      }
    });
  }
}
