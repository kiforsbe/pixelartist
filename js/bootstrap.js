import { EditorHost } from './host/editor-host.js';
import { setEditorHost } from './host/runtime.js';
import { state as legacyState } from './app/state.js';
import { BrowserPreferences } from './platform/browser/preferences.js';
import { BrowserFileSystem } from './platform/browser/file-system.js';
import { BrowserAutosave } from './platform/browser/autosave.js';
import { BrowserClipboard } from './platform/browser/clipboard.js';
import { BrowserImageCodec } from './platform/browser/image-codec.js';
import { spriteMode } from './modes/sprites/index.js';
import { tileMode } from './modes/tiles/index.js';
import { mapMode } from './modes/maps/index.js';
import { mountEditorWorkbench } from './features/workbench/editor-workbench.js';
import { mountFilterController } from './features/transforms/filter-controller.js';
import { mountProjectController } from './features/project/project-controller.js';
import { mountDocumentController } from './features/project/document-controller.js';
import { mountApplicationMenu } from './features/shell/menu-controller.js';
import { mountFileController } from './features/project/file-controller.js';

// historyStack: legacyState.commands makes HistoryService wrap the SAME
// CommandStack instance that legacy code (drawing-engine.js, layers-
// panel.js, color-panel.js, terrain-preset-art.js) still pushes onto
// directly, instead of defaulting to a private, disconnected stack --
// without this, undo/redo and the dirty flag only see host-issued commands,
// not pixel/layer/palette edits. Persists until Group 3 migrates those
// files onto services.history.execute(); same lifecycle as the mirror in
// file-controller.js's mountFileController().
export const editorHost = new EditorHost({
  historyStack: legacyState.commands,
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

const workbench = mountEditorWorkbench();
mountFilterController(workbench);
mountProjectController();
mountDocumentController({ editorHost, workbench });
mountApplicationMenu();
mountFileController();
