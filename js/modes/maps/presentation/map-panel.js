import { state, on, emit, activeMap, markDirty } from '../../../app/state.js';
import {
  clearMapRasterCache, isMapPlaying, toggleMapPlayback,
} from './map-renderer.js';

export function mountMapPanel(container) {
  const render = () => {
    if (state.mode !== 'maps') { container.hidden = true; return; }
    container.hidden = false;
    const map = activeMap();
    container.innerHTML = '<h3>Map</h3>';
    if (!map) { container.append('Create or select a map in the top bar.'); return; }
    const row = document.createElement('div'); row.className = 'row';
    const play = document.createElement('button'); play.className = 'btn-sm';
    play.textContent = isMapPlaying() ? 'Pause' : 'Play';
    play.onclick = () => toggleMapPlayback(() => emit('view'));
    row.append(play); container.append(row);
    const snapRow = document.createElement('div'); snapRow.className = 'row'; snapRow.innerHTML = 'Snap ';
    const select = document.createElement('select');
    for (const value of ['off', 'map', 'asset']) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'off' ? 'Off' : value === 'map' ? 'Map grid' : 'Asset grid';
      select.append(option);
    }
    select.value = map.snap.mode;
    select.onchange = () => { map.snap.mode = select.value; markDirty(); };
    snapRow.append(select);
    for (const key of ['gridW', 'gridH']) {
      const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.value = map.snap[key];
      input.onchange = () => { map.snap[key] = Math.max(1, +input.value || 1); markDirty(); emit('view'); };
      snapRow.append(input);
    }
    container.append(snapRow);
  };
  on('view', render);
  on('project', () => { clearMapRasterCache(); render(); });
  on('selection', render);
  render();
}
