import { autosave, loadAutosave, clearAutosave } from '../../app/io.js';

export class BrowserAutosave {
  save(project) { return autosave(project); }
  load() { return loadAutosave(); }
  clear() { return clearAutosave(); }
}
