import { CommandStack } from '../core/commands.js';

function validateCommand(command) {
  if (!command || typeof command !== 'object' || typeof command.do !== 'function' || typeof command.undo !== 'function') {
    throw new TypeError('History command requires do() and undo()');
  }
}

export class HistoryService {
  #stack;
  #store;
  #listeners = new Set();
  #suppressDirty = false;

  constructor({ stack = new CommandStack(), store = null } = {}) {
    this.#stack = stack;
    this.#store = store;
    const previous = stack.onChange;
    stack.onChange = value => {
      if (previous) previous(value);
      if (this.#store && !this.#suppressDirty) this.#store.markDirty(true);
      for (const listener of [...this.#listeners]) listener(this.snapshot());
    };
  }

  execute(command) { validateCommand(command); this.#stack.push(command); }
  undo() { this.#stack.undo(); }
  redo() { this.#stack.redo(); }
  clear({ markDirty = false } = {}) {
    this.#suppressDirty = !markDirty;
    try { this.#stack.clear(); }
    finally { this.#suppressDirty = false; }
  }
  canUndo() { return this.#stack.canUndo(); }
  canRedo() { return this.#stack.canRedo(); }
  snapshot() { return { canUndo: this.canUndo(), canRedo: this.canRedo() }; }

  subscribe(listener, { signal, fireImmediately = false } = {}) {
    this.#listeners.add(listener);
    const dispose = () => this.#listeners.delete(listener);
    if (signal) {
      if (signal.aborted) dispose();
      else signal.addEventListener('abort', dispose, { once: true });
    }
    if (fireImmediately && !signal?.aborted) listener(this.snapshot());
    return dispose;
  }
}
