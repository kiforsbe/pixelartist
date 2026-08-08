import { ContributionRegistry } from './registry.js';

export class CommandRegistry extends ContributionRegistry {
  constructor() {
    super('command', definition => {
      if (typeof definition.execute !== 'function') {
        throw new TypeError(`Command "${definition.id}" requires execute()`);
      }
    });
  }

  execute(id, context, args) {
    const command = this.get(id);
    if (!command) {
      console.warn(`Unknown command "${id}"`);
      return undefined;
    }
    if ((command.when && !command.when(context)) || (command.isEnabled && !command.isEnabled(context))) return undefined;
    return command.execute(context, args);
  }
}
