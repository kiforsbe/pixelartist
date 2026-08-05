import { getEditorHost } from '../host/runtime.js';
import { mountEditorWorkbench } from '../features/workbench/editor-workbench.js';
import { mountFilterController } from '../features/transforms/filter-controller.js';
import { mountProjectController } from '../features/project/project-controller.js';
import { mountDocumentController } from '../features/project/document-controller.js';
import { mountApplicationMenu } from '../features/shell/menu-controller.js';
import { mountFileController } from '../features/project/file-controller.js';

const editorHost = getEditorHost();
const workbench = mountEditorWorkbench();

mountFilterController(workbench);
mountProjectController();
mountDocumentController({ editorHost, workbench });
mountApplicationMenu();
mountFileController();
