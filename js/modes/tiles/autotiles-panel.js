import { state, on, activeSheet } from '../../app/state.js';
import { invalidateTileRaster } from './tile-raster-service.js';
import {
  buildTilePickerDialog, renderTerrainSetEditor, syncSelectedTerrainSetFromTile,
} from './tile-editor-controller.js';

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
    if (state.mode !== 'tiles') {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const sheet = activeSheet();
    editor.innerHTML = '';
    if (!sheet) return;

    const terrainSet = sheet.terrainSets.find(candidate => candidate.id === state.selectedTerrainSetId);
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
    const sheet = activeSheet();
    if (sheet) syncSelectedTerrainSetFromTile(sheet.tiles.find(tile => tile.id === state.selectedTileId));
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  const subscriptions = [
    on('project', () => {
      invalidateTileRaster();
      scheduleRender();
    }),
    on('history', () => {
      invalidateTileRaster();
      scheduleRender();
    }),
    on('pixels', () => {
      invalidateTileRaster();
      scheduleRender();
    }),
    on('view', scheduleRender),
    on('selection', () => {
      syncSelection();
      scheduleRender();
    }),
  ];
  syncSelection();
  render();
  return { dispose() { subscriptions.forEach(dispose => dispose()); } };
}
