// js/modes/tiles/presentation/terrain-set-panel.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { invalidateTileRaster } from './tile-raster-cache.js';
import {
  buildTilePickerDialog, renderTerrainSetEditor, syncSelectedTerrainSetFromTile,
} from './terrain-set-editor.js';
import { mountStorePanel } from '../../../components/panel-mount.js';

function sheetSelection(sheet) { return getEditorHost().selections.get({ kind: 'tile-sheet', id: sheet.id }) ?? {}; }

export function mountAutotilesPanel(element) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Autotiles';
  panel.appendChild(heading);

  const tilePickerDialog = buildTilePickerDialog();
  const editor = document.createElement('div');
  editor.className = 'terrain-set-editor';
  panel.appendChild(editor);

  function render() {
    if (getEditorHost().store.getState().session.activeModeId !== 'tiles') {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const sheet = activeSheet('tile');
    editor.innerHTML = '';
    if (!sheet) return;

    const terrainSet = sheet.terrainSets.find(candidate => candidate.id === sheetSelection(sheet).terrainSetId);
    if (terrainSet) {
      renderTerrainSetEditor(editor, sheet, terrainSet, tilePickerDialog);
      return;
    }
    const hint = document.createElement('div');
    hint.className = 'frame-field';
    hint.textContent = 'No terrain set selected — select a tile that belongs to one, or add a new set in the Tiles panel.';
    editor.appendChild(hint);
  }

  function syncSelection() {
    const sheet = activeSheet('tile');
    if (sheet) syncSelectedTerrainSetFromTile(sheet, sheet.tiles.find(tile => tile.id === sheetSelection(sheet).tileId));
  }

  syncSelection();
  const host = getEditorHost();
  const panelMount = mountStorePanel(host.store, [
    [s => s.project.model, invalidateTileRaster],
    [s => s.workspace.pixelRevision, invalidateTileRaster],
    s => s.session.activeModeId,
    s => s.session.activeViewId,
    s => s.session.activeDocument,
    [s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; }, syncSelection],
  ], render);
  const disposeHistory = host.history.subscribe(() => { invalidateTileRaster(); panelMount.scheduleRender(); });
  return { ...panelMount, dispose() { disposeHistory(); panelMount.dispose(); } };
}
