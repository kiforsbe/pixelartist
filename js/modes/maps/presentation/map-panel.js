import { getEditorHost } from '../../../host/runtime.js';
import { activeMap } from '../../../host/document-helpers.js';
import {
  clearMapRasterCache, isMapPlaying, toggleMapPlayback,
} from './map-renderer.js';
import { mountStorePanel } from '../../../components/panel-mount.js';

// `mapCanvasView` comes from PanelManager's create(frame.body, context) call
// (js/host/workbench/panel-manager.js) -- the same contributionContext
// editor-workbench.js hands every panel/tool/view. Grabbed here (rather than
// relying on a legacy bus emit) so the snap-mode/grid-size handlers below can
// request a real repaint: host.projects.markDirty() only flips
// project.dirty (a no-op transaction under EditorStore's Object.is change
// detection if the project was already dirty) and never touches
// project.model's identity, so nothing else re-paints the snap-grid overlay
// on its own.
export function mountMapPanel(container, { mapCanvasView } = {}) {
  const render = () => {
    const host = getEditorHost();
    if (host.store.getState().session.activeModeId !== 'maps') { container.hidden = true; return; }
    container.hidden = false;
    const map = activeMap();
    container.innerHTML = '<h3>Map</h3>';
    if (!map) { container.append('Create or select a map in the top bar.'); return; }
    const row = document.createElement('div'); row.className = 'row';
    const play = document.createElement('button'); play.className = 'btn-sm';
    play.textContent = isMapPlaying() ? 'Pause' : 'Play';
    // toggleMapPlayback's onChange fires once, synchronously, right after
    // flipping the play/pause flag: panel.scheduleRender() swaps this
    // button's own label, mapCanvasView.requestRender() repaints the canvas
    // (paintMap's own requestAnimationFrame loop only keeps itself going
    // once already playing -- this kicks off/settles that first frame).
    play.onclick = () => toggleMapPlayback(() => { panel.scheduleRender(); mapCanvasView?.requestRender(); });
    row.append(play); container.append(row);
    const snapRow = document.createElement('div'); snapRow.className = 'row'; snapRow.innerHTML = 'Snap ';
    const select = document.createElement('select');
    for (const value of ['off', 'map', 'asset']) {
      const option = document.createElement('option'); option.value = value;
      option.textContent = value === 'off' ? 'Off' : value === 'map' ? 'Map grid' : 'Asset grid';
      select.append(option);
    }
    select.value = map.snap.mode;
    // Direct map.snap.mode/gridW/gridH mutations here are never undo-tracked
    // (no history.execute) -- out of scope to change. Only the dirty-marking
    // is fixed: the old legacy markDirty() only flipped the legacy state's
    // own dirty flag, which nothing (the beforeunload guard, autosave,
    // Save's enabled state) reads anymore -- see host/project-service.js's
    // `dirty` getter and features/project/file-controller.js's actual
    // reads, all of which go through host.projects.dirty (backed by the
    // EditorStore) instead.
    select.onchange = () => {
      map.snap.mode = select.value;
      getEditorHost().projects.markDirty();
      mapCanvasView?.requestRender();
    };
    snapRow.append(select);
    for (const key of ['gridW', 'gridH']) {
      const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.value = map.snap[key];
      input.onchange = () => {
        map.snap[key] = Math.max(1, +input.value || 1);
        getEditorHost().projects.markDirty();
        mapCanvasView?.requestRender();
      };
      snapRow.append(input);
    }
    container.append(snapRow);
  };
  const store = getEditorHost().store;
  const panel = mountStorePanel(store, [
    s => s.session.activeViewId,
    [s => s.project.model, clearMapRasterCache],
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render);
  return panel;
}
