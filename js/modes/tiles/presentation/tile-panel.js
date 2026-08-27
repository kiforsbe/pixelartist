import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import {
  buildAddTerrainSetDialog,
  terrainSetNameField,
  terrainSetLayerField,
  terrainSetDeleteButton,
  syncSelectedTerrainSetFromTile,
} from './terrain-set-editor.js';
import { openTileEditor } from './tile-tool-presenter.js';
import { buildTagsField } from './tile-tags-field.js';
import { mountStorePanel } from '../../../components/panel-mount.js';

function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}
function sheetSelection(sheet) { return getEditorHost().selections.get({ kind: 'tile-sheet', id: sheet.id }) ?? {}; }

function sizeField(labelText, value, onCommit) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.value = String(value);
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => {
    let next = Number.parseInt(input.value, 10);
    if (!Number.isFinite(next) || next < 1) next = 1;
    input.value = String(next);
    onCommit(next);
  });
  label.appendChild(input);
  return label;
}

export function mountTilePanel(element) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Tiles';
  panel.appendChild(heading);

  const selectionRow = document.createElement('div');
  selectionRow.className = 'frame-row tile-selected';
  panel.appendChild(selectionRow);

  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const addTerrainSetButton = document.createElement('button');
  addTerrainSetButton.type = 'button';
  addTerrainSetButton.className = 'btn-sm';
  addTerrainSetButton.textContent = '➕ Autotiles';
  addTerrainSetButton.title = 'Add terrain set';
  addTerrainSetButton.addEventListener('click', () => {
    if (activeSheet('tile')) addTerrainSetDialog.open();
  });

  const buttonRow = document.createElement('div');
  buttonRow.className = 'row layer-actions';
  buttonRow.append(addTerrainSetButton);
  panel.appendChild(buttonRow);

  function render() {
    if (getEditorHost().store.getState().session.activeModeId !== 'tiles') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const sheet = activeSheet('tile');
    selectionRow.innerHTML = '';
    selectionRow.classList.remove('active');
    if (!sheet) return;

    const selection = sheetSelection(sheet);
    const tile = sheet.tiles.find(candidate => candidate.id === selection.tileId);
    if (!tile) {
      const terrainSet = sheet.terrainSets.find(candidate => candidate.id === selection.terrainSetId);
      if (terrainSet) {
        selectionRow.classList.add('active');
        const title = document.createElement('div');
        title.className = 'frame-field';
        title.textContent = `Terrain set · ${terrainSet.tileW}×${terrainSet.tileH}`;
        const fields = document.createElement('div');
        fields.className = 'frame-fields';
        fields.append(terrainSetNameField(terrainSet), terrainSetLayerField(sheet, terrainSet));
        const actions = document.createElement('div');
        actions.className = 'row layer-actions';
        actions.appendChild(terrainSetDeleteButton(sheet, terrainSet));
        selectionRow.append(title, fields, actions);
        return;
      }
      const hint = document.createElement('span');
      hint.textContent = 'No tile selected';
      selectionRow.appendChild(hint);
      return;
    }
    selectionRow.classList.add('active');

    const grid = tile.gridId != null ? sheet.tileGrids.find(candidate => candidate.id === tile.gridId) : null;
    const terrainSet = tile.terrainSetId != null
      ? sheet.terrainSets.find(candidate => candidate.id === tile.terrainSetId)
      : null;

    const nameField = document.createElement('label');
    nameField.className = 'frame-field tile-name-field';
    nameField.appendChild(document.createTextNode('Tile name'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = tile.name || '';
    nameInput.placeholder = `#${sheet.tiles.indexOf(tile)}`;
    nameInput.title = terrainSet
      ? 'Optional alias for this tile. This is separate from the terrain set name below.'
      : 'Optional alias for this tile; unnamed tiles use their sheet index.';
    nameInput.addEventListener('change', () => dispatch('tiles.renameTile', { sheetId: sheet.id, tileId: tile.id, name: nameInput.value.trim() }));
    nameField.appendChild(nameInput);

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    if (grid) {
      fields.append(
        sizeField('W', grid.cellW, value => dispatch('tiles.setGridCellField', { sheetId: sheet.id, gridId: grid.id, key: 'cellW', value })),
        sizeField('H', grid.cellH, value => dispatch('tiles.setGridCellField', { sheetId: sheet.id, gridId: grid.id, key: 'cellH', value })),
      );
    } else {
      fields.append(
        sizeField('W', tile.w, value => dispatch('tiles.setTileSize', { sheetId: sheet.id, tileId: tile.id, key: 'w', value })),
        sizeField('H', tile.h, value => dispatch('tiles.setTileSize', { sheetId: sheet.id, tileId: tile.id, key: 'h', value })),
      );
    }

    if (terrainSet) {
      fields.append(terrainSetNameField(terrainSet), terrainSetLayerField(sheet, terrainSet));
    } else {
      const layerField = document.createElement('label');
      layerField.className = 'frame-field';
      layerField.appendChild(document.createTextNode('Layer'));
      const layerSelect = document.createElement('select');
      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = '(none)';
      layerSelect.appendChild(noneOption);
      for (const name of sheet.layers) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        layerSelect.appendChild(option);
      }
      layerSelect.value = tile.layer ?? '';
      layerSelect.title = 'Tile Layer for this tile';
      layerSelect.addEventListener('change', () => dispatch('tiles.setTileLayer', { sheetId: sheet.id, tileId: tile.id, layer: layerSelect.value }));
      layerField.appendChild(layerSelect);
      fields.appendChild(layerField);
    }

    const actions = document.createElement('div');
    actions.className = 'row layer-actions';
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn-icon-md';
    editButton.textContent = '✎';
    editButton.title = 'Edit tile';
    editButton.addEventListener('click', () => openTileEditor(tile.id));
    actions.appendChild(editButton);
    if (grid) {
      const detachButton = document.createElement('button');
      detachButton.type = 'button';
      detachButton.className = 'btn-icon-md';
      detachButton.textContent = '⏏';
      detachButton.title = 'Detach from grid';
      detachButton.addEventListener('click', () => dispatch('tiles.detachTile', { sheetId: sheet.id, tileId: tile.id }));
      const deleteGridButton = document.createElement('button');
      deleteGridButton.type = 'button';
      deleteGridButton.className = 'btn-icon-md';
      deleteGridButton.textContent = '🗑';
      deleteGridButton.title = 'Delete grid';
      deleteGridButton.addEventListener('click', () => dispatch('tiles.deleteGrid', { sheetId: sheet.id, gridId: grid.id }));
      actions.append(detachButton, deleteGridButton);
    }
    if (terrainSet) actions.appendChild(terrainSetDeleteButton(sheet, terrainSet));

    selectionRow.append(nameField, fields, buildTagsField(sheet, tile), actions);
  }

  function syncSelection() {
    const sheet = activeSheet('tile');
    if (sheet) syncSelectedTerrainSetFromTile(sheet, sheet.tiles.find(tile => tile.id === sheetSelection(sheet).tileId));
  }

  syncSelection();
  const host = getEditorHost();
  const panelMount = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeViewId,
    s => s.session.activeDocument,
    [s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; }, syncSelection],
  ], render);
  const disposeHistory = host.history.subscribe(() => panelMount.scheduleRender());
  return { ...panelMount, dispose() { disposeHistory(); panelMount.dispose(); } };
}
