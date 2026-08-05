import * as legacyIo from '../../app/io.js';

// Compatibility adapter while file workflows move out of app/main.js.
export class BrowserFileSystem {
  supportsNativeFileSystem() { return legacyIo.supportsFS(); }
  openPacked() { return legacyIo.openPacked(); }
  openUnpacked() { return legacyIo.openUnpacked(); }
  savePacked(project, handle) { return legacyIo.savePacked(project, handle); }
  saveUnpacked(project, handle) { return legacyIo.saveUnpacked(project, handle); }
  pickImage() { return legacyIo.pickImageFile(); }
  download(blob, filename) { return legacyIo.downloadBlob(blob, filename); }
}
