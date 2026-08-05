import { EditorHost } from './host/editor-host.js';
import { setEditorHost } from './host/runtime.js';
import { BrowserPreferences } from './platform/browser/preferences.js';
import { BrowserFileSystem } from './platform/browser/file-system.js';
import { BrowserAutosave } from './platform/browser/autosave.js';
import { BrowserClipboard } from './platform/browser/clipboard.js';
import { BrowserImageCodec } from './platform/browser/image-codec.js';
import { spriteMode } from './modes/sprites/index.js';
import { tileMode } from './modes/tiles/index.js';
import { mapMode } from './modes/maps/index.js';

export const editorHost = new EditorHost({
  preferences: new BrowserPreferences(),
  platform: {
    files: new BrowserFileSystem(),
    autosave: new BrowserAutosave(),
    clipboard: new BrowserClipboard(),
    imageCodec: new BrowserImageCodec(),
  },
});

editorHost.registerMode(spriteMode);
editorHost.registerMode(tileMode);
editorHost.registerMode(mapMode);
editorHost.start('sprites');
setEditorHost(editorHost);

// main.js remains the compatibility composition root while features migrate
// behind host contributions. Keeping this boundary explicit prevents new code
// from importing the legacy root.
import('./app/main.js').catch(error => {
  console.error('PixelArtist failed to start', error);
  throw error;
});
