import { EditorHost } from './host/editor-host.js';
import { setEditorHost } from './host/runtime.js';
import { BrowserPreferences } from './platform/browser/preferences.js';
import { BrowserFileSystem } from './platform/browser/file-system.js';
import { BrowserAutosave } from './platform/browser/autosave.js';
import { BrowserClipboard } from './platform/browser/clipboard.js';
import { BrowserImageCodec } from './platform/browser/image-codec.js';
import { spriteMode } from './modes/sprites/index.js';
import { animationsMode } from './modes/animations/index.js';
import { tileMode } from './modes/tiles/index.js';
import { mapMode } from './modes/maps/index.js';
import { mountEditorWorkbench } from './features/workbench/editor-workbench.js';
import { mountFilterController } from './features/transforms/filter-controller.js';
import { mountProjectController } from './features/project/project-controller.js';
import { mountDocumentController } from './features/project/document-controller.js';
import { mountApplicationMenu } from './features/shell/menu-controller.js';
import { mountFileController } from './features/project/file-controller.js';
import { mountPaletteManager } from './features/palettes/palette-manager.js';
import { mountBrushManager } from './features/brushes/brush-manager.js';

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
editorHost.registerMode(animationsMode);
editorHost.registerMode(tileMode);
editorHost.registerMode(mapMode);
editorHost.start('sprites');
setEditorHost(editorHost);

const workbench = mountEditorWorkbench();
mountFilterController(workbench);
mountProjectController();
mountDocumentController({ editorHost, workbench });
mountApplicationMenu();
mountFileController();
mountPaletteManager();
mountBrushManager();
