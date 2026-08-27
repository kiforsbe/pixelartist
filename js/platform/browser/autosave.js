import { autosave, loadAutosave, clearAutosave } from './project-io.js';

export class BrowserAutosave {
  save(project) { return autosave(project); }
  load() { return loadAutosave(); }
  clear() { return clearAutosave(); }
}
