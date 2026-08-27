import * as legacyIo from './project-io.js';

// Browser adapter used by the project file workflows.
export class BrowserFileSystem {
  supportsNativeFileSystem() { return legacyIo.supportsFS(); }
  openPacked() { return legacyIo.openPacked(); }
  openUnpacked() { return legacyIo.openUnpacked(); }
  savePacked(project, handle) { return legacyIo.savePacked(project, handle); }
  saveUnpacked(project, handle) { return legacyIo.saveUnpacked(project, handle); }
  pickImage() { return legacyIo.pickImageFile(); }
  download(blob, filename) { return legacyIo.downloadBlob(blob, filename); }
}
