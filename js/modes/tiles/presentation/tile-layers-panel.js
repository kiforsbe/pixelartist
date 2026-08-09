import { state, on, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { mountReactivePanel } from '../../../components/panel-mount.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

export function mountTileLayersPanel(element, { showVisibility = false, showOpacity = false } = {}) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Tile Layers';
  panel.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'layer-list';
  panel.appendChild(list);

  let selectedName = null;

  const actions = document.createElement('div');
  actions.className = 'row layer-actions';

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn-icon-md';
  addButton.textContent = '➕';
  addButton.title = 'Add layer';
  addButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const name = prompt('Layer name?');
    if (!name) return;
    dispatch('tiles.addTileLayer', { sheetId: sheet.id, name });
    selectedName = name;
  });

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn-icon-md';
  deleteButton.textContent = '🗑';
  deleteButton.title = 'Delete layer';
  deleteButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || selectedName == null) return;
    dispatch('tiles.removeTileLayer', { sheetId: sheet.id, name: selectedName });
    selectedName = null;
  });

  actions.append(addButton, deleteButton);
  panel.appendChild(actions);

  function render() {
    if (state.mode !== 'tiles') {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    const sheet = activeSheet();
    list.innerHTML = '';
    if (!sheet) return;
    if (selectedName != null && !sheet.layers.includes(selectedName)) selectedName = null;

    for (const name of sheet.layers) {
      const row = document.createElement('div');
      row.className = `layer-row${name === selectedName ? ' active' : ''}`;
      row.tabIndex = 0;
      row.addEventListener('click', () => {
        selectedName = name;
        render();
      });

      const nameElement = document.createElement('span');
      nameElement.className = 'layer-name';
      nameElement.textContent = name;
      row.appendChild(nameElement);

      void showVisibility;
      void showOpacity;
      list.appendChild(row);
    }
  }

  return mountReactivePanel(on, ['project', 'history', 'view', 'selection'], render);
}
