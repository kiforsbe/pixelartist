import { EditorHost } from '../../js/host/editor-host.js';
import { setEditorHost } from '../../js/host/runtime.js';
import { createProject, createSheet, addFrame, sheetLayers } from '../../js/core/model.js';
import { createTile } from '../../js/modes/tiles/application/commands/tile-sheet-commands.js';
import { bindDrawing } from '../../js/components/canvas/drawing-engine.js';
import { discardFloatingForSheet } from '../../js/components/canvas/float-session.js';

const host = new EditorHost();
setEditorHost(host);

// Only the browser event/render boundary is replaced. Drawing, selection,
// pixel data, clipboard/float commands, store notifications and undo are real.
export function drawingFixture(t, viewKind = 'frame') {
  const saved = new Map(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const eventWindow = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: eventWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null, activeElement: null } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  const project = createProject('selection');
  const kind = viewKind === 'tile' ? 'tile' : 'sprite';
  const modeId = kind === 'tile' ? 'tiles' : 'sprites';
  const sheets = ['A', 'B'].map(name => createSheet(project, { name, kind, width: 20, height: 8 }));
  const docFor = sheet => ({ kind: kind === 'tile' ? 'tile-sheet' : 'sprite-sheet', id: sheet.id });
  const field = viewKind === 'tile' ? 'editingTileId' : 'editingFrameId';
  host.setProject(project);
  for (const sheet of sheets) {
    const rects = [{ name: 'A', x: 0, y: 0, w: 6, h: 6 }, { name: 'B', x: 10, y: 0, w: 6, h: 6 }];
    for (const rect of rects) {
      if (kind === 'sprite') addFrame(sheet, rect);
      else createTile(host.services, sheet.id, rect);
    }
    const region = kind === 'sprite' ? sheet.frames[0] : sheet.tiles[0];
    host.selections.set({ layerId: sheetLayers(sheet)[0].id, [field]: region.id }, docFor(sheet));
  }
  host.store.updateSession({ activeDocument: docFor(sheets[0]), activeViewId: `${modeId}.${viewKind}`, activeModeId: modeId, activeToolId: 'select' });
  host.history.clear();
  host.projects.markSaved();
  function currentSheet() { return sheets.find(sheet => sheet.id === host.store.getState().session.activeDocument?.id); }
  function regions(sheet = currentSheet()) { return kind === 'sprite' ? sheet.frames : sheet.tiles; }
  function targetRect() {
    const sheet = currentSheet();
    if (!sheet) return { x: 0, y: 0, w: 0, h: 0 };
    if (viewKind === 'sheet') return { x: 0, y: 0, w: sheet.width, h: sheet.height };
    const region = regions(sheet).find(region => region.id === host.selections.get(docFor(sheet))?.[field]);
    return region ? { x: region.x, y: region.y, w: region.w, h: region.h } : { x: 0, y: 0, w: 0, h: 0 };
  }
  const view = { canvas: new EventTarget(), requestRender() {}, imageToScreen: (x, y) => ({ x: x * 20, y: y * 20 }) };
  bindDrawing(view, targetRect, undefined, viewKind);
  function pointer(type, x, y, extra = {}) {
    view.onPointer({ type, x, y, sx: x * 20, sy: y * 20, buttons: 1, ...extra });
  }
  function select(x0 = 1, y0 = 1, x1 = 2, y1 = 2) {
    host.store.updateSession({ activeToolId: 'select' });
    pointer('down', x0, y0);
    pointer('up', x1, y1);
  }
  function key(key) {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value: key });
    eventWindow.dispatchEvent(event);
    return event;
  }
  t.after(() => {
    for (const sheet of sheets) discardFloatingForSheet(sheet.id);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return {
    host, project, sheets, view, pointer, select, key, regions,
    bitmap: (sheet = currentSheet()) => sheetLayers(sheet)[0].bitmap,
    switchRegion: index => host.selections.patch({ [field]: regions()[index].id }),
    switchSheet: index => host.store.updateSession({ activeDocument: docFor(sheets[index]) }),
  };
}
