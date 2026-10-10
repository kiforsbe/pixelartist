// Layers panel. The sheet layer tree (rows, actions, drag-and-drop, the
// selected node) is shared with the Animations timeline in layer-tree.js;
// map layers are this panel's own. Hidden in the Animations workbench,
// whose timeline shows the tree.

import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeMap } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { mountStorePanel } from '../panel-mount.js';
import { documentKey } from '../../host/editor-store.js';
import { findNode, sheetLayers } from '../../core/model.js';
import { defineAction, bindAction } from '../../features/shell/actions.js';
import {
  LAYER_THUMB_SIZE, currentModeId, layerTreeRows, buildLayerRow, attachLayerTreeDrop, drawLayerThumb,
  addSheetLayer, addSheetGroup, deleteSheetNode, mergeSheetLayerDown,
  startRename, scheduleNameSelect, nameClickPending, cancelNameClick,
} from './layer-tree.js';

// Dispatches a Command Handler by id (registered in each mode's
// contributions.js) rather than importing it directly.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: getEditorHost().store.getState().session.activeModeId }, args);
}

function resetBody(el, headingText) {
  const h3 = el.querySelector('h3') ?? Object.assign(document.createElement('h3'), { textContent: headingText });
  el.innerHTML = '';
  el.appendChild(h3);
  return h3;
}

function setMapLayer(map, layerId) {
  const host = getEditorHost();
  host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
}

export function mountLayersPanel(el) {
  resetBody(el, 'Layers');

  const list = document.createElement('div');
  list.className = 'layer-list layer-tree';
  el.appendChild(list);

  const btnRow = document.createElement('div'); btnRow.className = 'row layer-actions';
  const btnAddLayer = document.createElement('button'); btnAddLayer.className = 'btn-icon-md'; btnAddLayer.textContent = '➕'; btnAddLayer.title = 'Add layer';
  const btnAddGroup = document.createElement('button'); btnAddGroup.className = 'btn-icon-md'; btnAddGroup.textContent = '📁'; btnAddGroup.title = 'Add group';
  const btnDelete = document.createElement('button'); btnDelete.className = 'btn-icon-md'; btnDelete.textContent = '🗑'; btnDelete.title = 'Delete';
  const btnMerge = document.createElement('button'); btnMerge.className = 'btn-icon-md'; btnMerge.textContent = '⬇'; btnMerge.title = 'Merge down';
  btnRow.append(btnAddLayer, btnAddGroup, btnDelete, btnMerge);
  el.appendChild(btnRow);

  function doAddLayer() {
    if (currentModeId() !== 'maps') { addSheetLayer(); return; }
    const map = activeMap(); if (!map) return;
    setMapLayer(map, dispatch('maps.addLayer', { mapId: map.id, type: 'tile' }));
  }

  function doAddGroup() {
    if (currentModeId() !== 'maps') { addSheetGroup(); return; }
    const map = activeMap(); if (!map) return;
    setMapLayer(map, dispatch('maps.addLayer', { mapId: map.id, type: 'sprite' }));
  }

  function doDelete() {
    if (currentModeId() !== 'maps') { deleteSheetNode(); return; }
    const host = getEditorHost();
    const map = activeMap(), layerId = (host.selections.get({ kind: 'map', id: map?.id }) ?? {}).layerId;
    const layer = map?.layers.find(l => l.id === layerId);
    if (!map || !layer || map.layers.length <= 1) return;
    if (!confirmOrAuto(`Delete ${layer.type} layer "${layer.name}"?`)) return;
    const remainingIndex = Math.min(map.layers.indexOf(layer), map.layers.length - 2);
    dispatch('maps.deleteLayer', { mapId: map.id, layerId: layer.id });
    setMapLayer(map, map.layers[Math.max(0, remainingIndex)]?.id ?? null);
  }

  const thumbCanvases = new Map();
  attachLayerTreeDrop(list);

  function renderMapLayer(layer) {
    const host = getEditorHost();
    const map = activeMap();
    const activeLayerId = (host.selections.get({ kind: 'map', id: map?.id }) ?? {}).layerId;
    const row = document.createElement('div');
    row.className = 'layer-row layer-leaf' + (layer.id === activeLayerId ? ' active' : '');
    row.style.paddingLeft = '4px'; row.tabIndex = 0;
    row.addEventListener('click', () => {
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId: layer.id }, { kind: 'map', id: map.id });
    });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const map = activeMap(); if (!map) return;
      e.preventDefault();
      // Goes through the maps.moveLayer Command Handler (same shape as the
      // sprite/tile tree's moveNode) so the reorder is undoable; the command
      // clamps the target index itself. The command marks the project dirty,
      // but this panel no longer listens on the legacy 'view' bus for its own
      // repaint, so it still asks mountStorePanel's debounced render for one
      // or this row's new position would never show up.
      dispatch('maps.moveLayer', { mapId: map.id, layerId: layer.id, delta: e.key === 'ArrowUp' ? 1 : -1 });
      host.store.notifyPixelsChanged();
      storePanel.scheduleRender();
    });
    const spacer = document.createElement('span'); spacer.className = 'tree-spacer leaf-spacer';
    const thumb = document.createElement('canvas'); thumb.className = 'layer-thumb'; thumb.width = LAYER_THUMB_SIZE; thumb.height = LAYER_THUMB_SIZE;
    const tctx = thumb.getContext('2d'); tctx.fillStyle = layer.type === 'tile' ? '#466b9c' : '#8a5b98'; tctx.fillRect(0, 0, thumb.width, thumb.height); tctx.fillStyle = '#fff'; tctx.font = '14px sans-serif'; tctx.textAlign = 'center'; tctx.textBaseline = 'middle'; tctx.fillText(layer.type === 'tile' ? '▦' : '♟', thumb.width / 2, thumb.height / 2);
    // Same "no Command Handler, keep it undoable-never but still repaint"
    // reasoning as the keydown reorder handler above.
    const visBtn = document.createElement('button'); visBtn.type = 'button'; visBtn.textContent = layer.visible ? '👁' : '🚫'; visBtn.title = 'Toggle visibility'; visBtn.addEventListener('click', e => { e.stopPropagation(); layer.visible = !layer.visible; host.projects.markDirty(); host.store.notifyPixelsChanged(); storePanel.scheduleRender(); });
    const nameEl = document.createElement('span'); nameEl.className = 'layer-name'; nameEl.textContent = layer.name;
    nameEl.addEventListener('click', e => { e.stopPropagation(); scheduleNameSelect(() => setMapLayer(map, layer.id), renderList); });
    nameEl.addEventListener('dblclick', e => { e.stopPropagation(); cancelNameClick(); startRename(layer, nameEl, renderList); });
    const opacityInput = document.createElement('input'); opacityInput.type = 'range'; opacityInput.min = '0'; opacityInput.max = '100'; opacityInput.value = String(Math.round(layer.opacity * 100)); opacityInput.addEventListener('click', e => e.stopPropagation());
    let before = null;
    opacityInput.addEventListener('pointerdown', e => { e.stopPropagation(); before = layer.opacity; });
    opacityInput.addEventListener('input', () => { before ??= layer.opacity; layer.opacity = Number(opacityInput.value) / 100; host.store.notifyPixelsChanged(); });
    opacityInput.addEventListener('change', () => {
      if (before != null && before !== layer.opacity) {
        // Same before/after ordering fix as renderLayer's opacity handler.
        layer.opacity = before;
        dispatch('maps.setLayerOpacity', { mapId: activeMap().id, layerId: layer.id, opacity: Number(opacityInput.value) / 100 });
      }
      before = null;
    });
    row.append(spacer, thumb, visBtn, nameEl, opacityInput); list.appendChild(row);
  }

  function renderList() {
    el.hidden = currentModeId() === 'animations';
    list.innerHTML = '';
    thumbCanvases.clear();
    if (currentModeId() === 'maps') {
      const map = activeMap();
      btnAddLayer.title = 'Add tile layer'; btnAddGroup.title = 'Add sprite layer'; btnMerge.disabled = true;
      if (map) for (let i = map.layers.length - 1; i >= 0; i--) renderMapLayer(map.layers[i]);
      return;
    }
    btnAddLayer.title = 'Add layer'; btnAddGroup.title = 'Add group'; btnMerge.disabled = false;
    const sheet = activeSheet();
    if (!sheet) return;
    const host = getEditorHost();
    const doc = { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
    const currentId = (host.selections.get(doc) ?? {}).layerId;
    if (currentId && !findNode(sheet.layerTree, currentId)) {
      host.selections.set({ ...host.selections.get(doc), layerId: sheetLayers(sheet)[0]?.id ?? null }, doc);
    }
    for (const { node, depth } of layerTreeRows(sheet.layerTree)) {
      list.appendChild(buildLayerRow(node, depth, { thumbs: thumbCanvases, onChange: renderList }));
    }
  }

  let thumbRedrawQueued = false;
  function redrawThumbs() {
    if (el.hidden) return; // Animations: the timeline's rows replace this panel
    const sheet = activeSheet();
    if (!sheet) return;
    for (const layer of sheetLayers(sheet)) {
      const canvas = thumbCanvases.get(layer.id);
      if (canvas) drawLayerThumb(canvas, sheet, layer);
    }
  }
  function scheduleThumbRedraw() {
    if (thumbRedrawQueued) return;
    thumbRedrawQueued = true;
    queueMicrotask(() => { thumbRedrawQueued = false; redrawThumbs(); });
  }

  // sheet.layerTree (bitmap layers: visibility, opacity, groups) is shared
  // by sprite and tile sheets alike -- see activeLayer() in
  // host/document-helpers.js and flattenSheet() in core/model.js, which
  // never branch on sheet.kind. It's unrelated to sheet.tileLayerNames (the
  // flat named-tag array for categorizing tiles, mounted separately as the
  // "Tile Layers" panel). No group belongs to an animation (save format v4
  // dropped layer ownership), so these actions need no isAvailable gating
  // on tile sheets.
  defineAction('layer.add', { label: 'Add Layer', run: doAddLayer, isEnabled: () => !!activeSheet() || (currentModeId() === 'maps' && !!activeMap()) });
  bindAction(btnAddLayer, 'layer.add');
  defineAction('layer.addGroup', { label: 'Add Group', run: doAddGroup, isEnabled: () => !!activeSheet() || (currentModeId() === 'maps' && !!activeMap()) });
  bindAction(btnAddGroup, 'layer.addGroup');
  defineAction('layer.delete', { label: 'Delete Layer', run: doDelete, isEnabled: () => !!activeSheet() || (currentModeId() === 'maps' && !!activeMap()) });
  bindAction(btnDelete, 'layer.delete');
  defineAction('layer.mergeDown', { label: 'Merge Down', run: mergeSheetLayerDown, isEnabled: () => !!activeSheet() });
  bindAction(btnMerge, 'layer.mergeDown');

  // Selecting a layer/group via its name click always replaces the store's
  // selectionsByDocument entry wholesale (see the selector comment below),
  // even for a plain click that doesn't touch the animation selection --
  // unlike the old on('selection', renderList) wiring, which only fired for
  // an actual animation-selection change (selectGroupNode/selectLayerNode's
  // own `changed` guard). Left unguarded, that would fire a (microtask-
  // deferred, but still near-instant) render on every single name click,
  // tearing the row down before scheduleNameSelect's deliberate 200ms grace
  // window ever gets a chance to let a following dblclick reach startRename
  // instead. Route the store-driven render through this guard so it defers
  // to that grace window exactly like the local timer already does.
  function renderListUnlessNameClickPending() {
    if (nameClickPending()) return;
    renderList();
  }

  const store = getEditorHost().store;
  // Pixel revisions redraw live-stroke thumbnails. History-driven redraws (every add/delete/
  // rename/merge/move/opacity dispatch above) reach renderList through
  // host.history.subscribe below instead -- HistoryService's own onChange
  // fires on every do()/undo()/redo() regardless of which store selector (if
  // any) the underlying project mutation happens to touch.
  const disposePixelSignal = store.subscribe(s => s.workspace.pixelRevision, scheduleThumbRedraw);
  const disposeHistory = getEditorHost().history.subscribe(() => renderList());
  const storePanel = mountStorePanel(store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeDocument,
    // NOT `s => s.session.selectionsByDocument` -- setSelection() mutates
    // that outer object in place (`selectionsByDocument[key] = {...}`), so
    // its own identity never changes and Object.is-based change detection
    // would never fire. Select the ACTIVE document's own entry instead,
    // which setSelection()/SelectionService.set() always replace wholesale.
    s => {
      const doc = s.session.activeDocument;
      return doc ? s.session.selectionsByDocument[documentKey(doc)] : null;
    },
  ], renderListUnlessNameClickPending, {
    onDispose() {
      disposePixelSignal();
      disposeHistory();
    },
  });
}
