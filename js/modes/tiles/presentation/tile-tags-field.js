import { getEditorHost } from '../../../host/runtime.js';

function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

let focusPending = false;

export function buildTagsField(sheet, tile) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tag-field';
  const label = document.createElement('span');
  label.className = 'tag-field-label';
  label.textContent = 'Tags';
  const box = document.createElement('div');
  box.className = 'tag-input';

  const tags = (tile.tags ?? []).slice();
  const commit = next => {
    focusPending = true;
    dispatch('tiles.setTileTags', { sheetId: sheet.id, tileId: tile.id, tagsText: next.join(',') });
  };

  const entry = document.createElement('input');
  entry.type = 'text';
  entry.className = 'tag-entry';
  entry.placeholder = tags.length ? '' : 'add tag…';

  tags.forEach((tag, index) => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.appendChild(document.createTextNode(tag));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = `Remove "${tag}"`;
    remove.addEventListener('click', event => {
      event.stopPropagation();
      commit(tags.filter((_, candidate) => candidate !== index));
    });
    pill.appendChild(remove);
    box.appendChild(pill);
  });

  function addFromEntry() {
    const additions = entry.value.split(/[, ]+/).map(value => value.trim()).filter(Boolean);
    if (!additions.length) return;
    entry.value = '';
    commit([...tags, ...additions]);
  }

  entry.addEventListener('keydown', event => {
    if (event.key === ',' || event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      addFromEntry();
    } else if (event.key === 'Backspace' && entry.value === '' && tags.length) {
      commit(tags.slice(0, -1));
    }
  });
  entry.addEventListener('blur', () => {
    if (entry.value.trim()) addFromEntry();
  });
  entry.addEventListener('paste', event => {
    event.preventDefault();
    entry.value += (event.clipboardData ?? window.clipboardData).getData('text');
    addFromEntry();
  });
  box.addEventListener('click', event => {
    if (event.target === box) entry.focus();
  });

  box.appendChild(entry);
  wrapper.append(label, box);
  if (focusPending) {
    focusPending = false;
    queueMicrotask(() => entry.focus());
  }
  return wrapper;
}
