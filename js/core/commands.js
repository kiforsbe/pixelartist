import { blitRegion } from './pixels.js';

export class CommandStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.done = [];
    this.undone = [];
    this.onChange = null;
  }
  #notify() { if (this.onChange) this.onChange(this); }
  push(cmd) {
    cmd.do();
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.undone.length = 0;
    this.#notify();
  }
  undo() {
    const cmd = this.done.pop();
    if (!cmd) return;
    cmd.undo();
    this.undone.push(cmd);
    this.#notify();
  }
  redo() {
    const cmd = this.undone.pop();
    if (!cmd) return;
    cmd.do();
    this.done.push(cmd);
    this.#notify();
  }
  canUndo() { return this.done.length > 0; }
  canRedo() { return this.undone.length > 0; }
  clear() { this.done.length = 0; this.undone.length = 0; this.#notify(); }
}

export function makePixelPatch(bitmap, rect, before, after, label) {
  return {
    label,
    do() { blitRegion(bitmap, after, rect.x, rect.y); },
    undo() { blitRegion(bitmap, before, rect.x, rect.y); },
  };
}
