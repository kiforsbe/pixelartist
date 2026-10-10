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
  #done = [];    // oldest -> newest: { command, scope, seq }
  #undone = [];  // oldest -> newest: { command, scope, seq }
  #seq = 0;      // execute() numbers its entries; mark() records the count
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
    const entry = { command, scope: scope ?? this.#activeScope(), seq: ++this.#seq };
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

  // Captures the history position before a multi-command gesture, so the
  // gesture does not have to know how many entries its steps pushed. The
  // position is execute()'s sequence number, not an index or an entry: the
  // history limit trims the oldest entries and an undo removes the newest,
  // and neither may move it. Holds the redo log and dirty flag too:
  // executing the gesture's first command drops visible redo entries and
  // marks the project dirty, and rollbackTo() has to be able to undo both.
  mark() {
    return Object.freeze({
      seq: this.#seq,
      undone: [...this.#undone],
      dirty: this.#store ? !!this.#store.getState().project.dirty : false,
    });
  }

  // Where the entries executed since `token` start: the trailing run of
  // #done newer than the mark (a redone older entry ends the run).
  #sinceIndex(token) {
    let start = this.#done.length;
    while (start > 0 && this.#done[start - 1].seq > token.seq) start--;
    return start;
  }

  // Folds every entry executed since `mark` into one, so the gesture undoes in
  // a single step (undo newest->oldest, redo oldest->newest). False (nothing
  // changes) when nothing ran since the mark or the entries span scopes; true
  // when there is one entry (nothing to fold) or after folding. Deliberately
  // silent: no listener notification and no dirty change, since the fold only
  // alters undo granularity, which nothing observable depends on.
  combineSince(token) {
    const start = this.#sinceIndex(token);
    const entries = this.#done.slice(start);
    if (entries.length === 0) return false;
    if (entries.some(e => e.scope !== entries[0].scope)) return false;
    if (entries.length === 1) return true;
    const commands = entries.map(e => e.command);
    this.#done.splice(start, entries.length, {
      scope: entries[0].scope,
      seq: entries.at(-1).seq,
      command: {
        label: commands.at(-1).label,
        do: () => commands.forEach(c => c.do()),
        undo: () => [...commands].reverse().forEach(c => c.undo()),
      },
    });
    return true;
  }

  // Undoes every entry executed since `mark` (newest first) and forgets them:
  // for a gesture whose later step was refused. Also restores what the
  // gesture's first execute() clobbered -- the redo entries it dropped and the
  // dirty flag it set -- so the refused gesture leaves no trace. Listeners are
  // told once; no-op (silent) when nothing ran since the mark.
  rollbackTo(token) {
    const start = this.#sinceIndex(token);
    if (start >= this.#done.length) return;
    const entries = this.#done.splice(start);
    for (let i = entries.length - 1; i >= 0; i--) entries[i].command.undo();
    this.#undone = [...token.undone];
    this.#suppressDirty = true;
    try {
      this.#changed();
    } finally {
      this.#suppressDirty = false;
    }
    this.#store?.markDirty(token.dirty);
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
