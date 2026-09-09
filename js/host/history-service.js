import { documentKey } from './editor-store.js';

// Undo/redo is scoped per document, not global. Every entry carries the scope
// it belongs to -- a document key ("sprite-sheet:abc", "map:xyz") or
// PROJECT_SCOPE -- and undo()/redo() only ever consider entries VISIBLE from
// the document the user is currently looking at: that document's own entries,
// plus project-wide ones.
//
// Why: with one global stack, Ctrl+Z after switching sheets silently reverted
// an edit on the sheet you had left, while the canvas in front of you showed
// nothing happening. Per-document scoping is what every other pixel editor
// does, and it makes "undo" mean "undo what I can see".
//
// Entries are kept in ONE ordered log rather than a stack per scope, because
// project-wide commands (palette edits, sheet create/delete, project
// settings) have to stay reachable from whichever document is active. Undo
// therefore removes the newest visible entry from the middle of the log; the
// entries it steps over belong to other documents and are independent of it.
//
// Scope defaults to the active document at execute() time, so the ordinary
// call site (a stroke, a filter, a layer command) needs no changes. A command
// opts into PROJECT_SCOPE explicitly. The rule for choosing: scope a command
// to the NARROWEST thing it mutates -- if it writes a document's pixels it
// belongs to that document, even when it also touches the project (e.g. a
// palette remap, which rewrites the active sheet's bitmaps).
export const PROJECT_SCOPE = 'project';

const DEFAULT_LIMIT = 200;

function validateCommand(command) {
  if (!command || typeof command !== 'object' || typeof command.do !== 'function' || typeof command.undo !== 'function') {
    throw new TypeError('History command requires do() and undo()');
  }
}

export class HistoryService {
  #done = [];    // oldest -> newest: { command, scope }
  #undone = [];  // oldest -> newest: { command, scope }
  #limit;
  #store;
  #listeners = new Set();
  #suppressDirty = false;
  #revision = 0;

  constructor({ store = null, limit = DEFAULT_LIMIT } = {}) {
    this.#store = store;
    this.#limit = limit;
  }

  // The document the user is looking at. With no active document (or no
  // store) everything collapses onto the project scope, which keeps
  // headless/unit use of HistoryService behaving like a plain stack.
  #activeScope() {
    if (!this.#store) return PROJECT_SCOPE;
    return documentKey(this.#store.getState().session.activeDocument) ?? PROJECT_SCOPE;
  }

  #isVisible(scope, activeScope = this.#activeScope()) {
    return scope === PROJECT_SCOPE || scope === activeScope;
  }

  #lastVisibleIndex(entries) {
    const active = this.#activeScope();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (this.#isVisible(entries[i].scope, active)) return i;
    }
    return -1;
  }

  #changed() {
    this.#revision++;
    if (this.#store && !this.#suppressDirty) this.#store.markDirty(true);
    for (const listener of [...this.#listeners]) listener(this.snapshot());
  }

  execute(command, { scope } = {}) {
    validateCommand(command);
    // Resolved BEFORE do() runs: a command may activate a different document
    // as part of its own effect (creating a sheet selects it), and it still
    // belongs to the scope it was issued from.
    const entry = { command, scope: scope ?? this.#activeScope() };
    command.do();
    this.#done.push(entry);
    if (this.#done.length > this.#limit) this.#done.shift();
    // A new command branches the timeline the user can currently see: drop
    // the redo entries visible from here, keep other documents' intact.
    this.#undone = this.#undone.filter(e => !this.#isVisible(e.scope));
    this.#changed();
  }

  undo() {
    const i = this.#lastVisibleIndex(this.#done);
    if (i === -1) return;
    const [entry] = this.#done.splice(i, 1);
    entry.command.undo();
    this.#undone.push(entry);
    this.#changed();
  }

  redo() {
    const i = this.#lastVisibleIndex(this.#undone);
    if (i === -1) return;
    const [entry] = this.#undone.splice(i, 1);
    entry.command.do();
    this.#done.push(entry);
    this.#changed();
  }

  clear({ markDirty = false } = {}) {
    this.#suppressDirty = !markDirty;
    try {
      this.#done.length = 0;
      this.#undone.length = 0;
      this.#changed();
    } finally {
      this.#suppressDirty = false;
    }
  }

  canUndo() { return this.#lastVisibleIndex(this.#done) !== -1; }
  canRedo() { return this.#lastVisibleIndex(this.#undone) !== -1; }
  snapshot() { return { canUndo: this.canUndo(), canRedo: this.canRedo(), revision: this.#revision }; }

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
