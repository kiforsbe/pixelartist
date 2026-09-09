// Layers panel.

import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeLayer, activeMap } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { mountStorePanel } from '../panel-mount.js';
import { documentKey } from '../../host/editor-store.js';
import { activeFloating, commitFloatIfAny } from '../canvas/float-session.js';
import { commitDeleteAnimation } from '../../features/animations/commands.js';
import { findNode, findParent, sheetLayers, flattenLayers, findGroup, animationGroup, layerAnimationContext } from '../../core/model.js';
import { compositeFloatOnLayer } from '../../core/floating.js';
import { defineAction, bindAction } from '../../features/shell/actions.js';

// Dispatches a Command Handler by id (registered in each mode's
// contributions.js) rather than importing it directly -- matches the
// established pattern in frames-panel.js/tile-layers-panel.js and this
// file's own (former) maps branches.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: getEditorHost().store.getState().session.activeModeId }, args);
}

function currentModeId() {
  return getEditorHost().store.getState().session.activeModeId;
}

function resetBody(el, headingText) {
  const h3 = el.querySelector('h3') ?? Object.assign(document.createElement('h3'), { textContent: headingText });
  el.innerHTML = '';
  el.appendChild(h3);
  return h3;
}

// ------------------------------------------------------ shared thumb drawing
//
// Uses the timeline preview's scratch-canvas/draw-fit pattern: one
// module-level scratch canvas reused across every layer-row thumbnail draw,
// resized only when the source bitmap's dimensions change (a canvas resize
// resets context state, so imageSmoothingEnabled is reasserted after).

const LAYER_THUMB_SIZE = 40;

let scratchCanvas = null;
let scratchCtx = null;

function getScratchCanvas(width, height) {
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
    scratchCtx = scratchCanvas.getContext('2d');
  }
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
    scratchCtx.imageSmoothingEnabled = false;
  }
  return scratchCanvas;
}

// Draws `bmp` into `canvas`, scaled to fit (contain) and centered — same
// behavior as timeline.js's drawFit, applied here to per-layer thumbnails.
// Shrinking a large sprite down to a 40px thumbnail with nearest-neighbor
// drops most of its pixels and aliases badly; smoothing (project setting,
// on by default) only kicks in for that shrink case; an upscaled thumbnail
// stays crisp nearest-neighbor or the pixel art would turn to mush.
function drawFit(canvas, bmp) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bmp || bmp.width === 0 || bmp.height === 0) return;
  const tmp = getScratchCanvas(bmp.width, bmp.height);
  tmp.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * scale));
  const dh = Math.max(1, Math.round(bmp.height * scale));
  const dx = Math.floor((canvas.width - dw) / 2);
  const dy = Math.floor((canvas.height - dh) / 2);
  const smooth = scale < 1 && getEditorHost().projects.project?.settings?.smoothThumbnails !== false;
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh);
}

// ------------------------------------------------------------- layers panel

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
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

  function sheetSelection(sheet) {
    return getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
  }
  function setSheetSelection(sheet, patch) {
    getEditorHost().selections.set({ ...sheetSelection(sheet), ...patch }, sheetDocument(sheet));
  }
  function currentLayerId() {
    const sheet = activeSheet();
    return sheet ? (sheetSelection(sheet).layerId ?? null) : null;
  }
  function currentAnimationId() {
    const sheet = activeSheet();
    return sheet ? (sheetSelection(sheet).animationId ?? null) : null;
  }

  // Selected node can be a layer or a group. Active layer id is authoritative
  // for drawing; selected node id is authoritative for panel operations.
  let selectedNodeId = currentLayerId();

  // Tracks the last selected animation (per SelectionService) this panel itself agreed with
  // (either because it set it, or because it already resynced to it), so
  // renderList can tell "the timeline/sprite sheet changed the animation
  // selection out from under us" (needs a resync) apart from "the user just
  // clicked a plain layer/group in THIS panel" (must NOT be overwritten).
  let lastSyncedAnimationId = currentAnimationId();

  function targetGroupForInsert() {
    const sheet = activeSheet();
    if (!sheet) return null;
    if (!selectedNodeId) return sheet.layerTree;
    const node = findNode(sheet.layerTree, selectedNodeId);
    if (!node) return sheet.layerTree;
    if (node.type === 'group') return node;
    const loc = findParent(sheet.layerTree, selectedNodeId);
    return loc ? loc.parent : sheet.layerTree;
  }

  function countNodes(sheet, type) {
    let n = 0;
    function walk(node) {
      if (node.type === type) n++;
      if (node.children) for (const c of node.children) walk(c);
    }
    walk(sheet.layerTree);
    return n;
  }

  function doAddLayer() {
    const mode = currentModeId();
    if (mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const host = getEditorHost();
      const layerId = dispatch('maps.addLayer', { mapId: map.id, type: 'tile' });
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
      return;
    }
    const sheet = activeSheet();
    const group = targetGroupForInsert();
    if (!sheet || !group) return;
    const newLayerId = dispatch(`${mode}.addLayer`, { sheetId: sheet.id, targetGroupId: group === sheet.layerTree ? null : group.id });
    setSheetSelection(sheet, { layerId: newLayerId });
    selectedNodeId = newLayerId;
  }

  function doAddGroup() {
    const mode = currentModeId();
    if (mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const host = getEditorHost();
      const layerId = dispatch('maps.addLayer', { mapId: map.id, type: 'sprite' });
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
      return;
    }
    const sheet = activeSheet();
    const group = targetGroupForInsert();
    if (!sheet || !group) return;
    const newGroupId = dispatch(`${mode}.addGroup`, { sheetId: sheet.id, targetGroupId: group === sheet.layerTree ? null : group.id });
    selectedNodeId = newGroupId;
    setSheetSelection(sheet, { layerId: null });
  }

  function doDelete() {
    const mode = currentModeId();
    if (mode === 'maps') {
      const host = getEditorHost();
      const map = activeMap(), layerId = (host.selections.get({ kind: 'map', id: map?.id }) ?? {}).layerId;
      const layer = map?.layers.find(l => l.id === layerId);
      if (!map || !layer || map.layers.length <= 1) return;
      if (!confirmOrAuto(`Delete ${layer.type} layer "${layer.name}"?`)) return;
      const remainingIndex = Math.min(map.layers.indexOf(layer), map.layers.length - 2);
      dispatch('maps.deleteLayer', { mapId: map.id, layerId: layer.id });
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId: map.layers[Math.max(0, remainingIndex)]?.id ?? null }, { kind: 'map', id: map.id });
      return;
    }
    const sheet = activeSheet();
    if (!sheet) return;
    const layer = activeLayer();
    if (layer) {
      const loc = findParent(sheet.layerTree, layer.id);
      if (!loc) return;
      const parent = loc.parent;
      // Scoped to this layer's own group (root, or an animation's private
      // group), not the whole sheet: a whole-sheet count lets you empty a
      // single animation's group down to zero layers as long as some OTHER
      // animation (or root) still has layers, leaving that animation with a
      // blank composite.
      if (flattenLayers(parent).length <= 1) { alert('Cannot delete the last layer in this group.'); return; }
      if (!confirmOrAuto(`Delete layer "${layer.name}"?`)) return;
      // deleteNode's Command Handler owns the actual mutation + undo
      // snapshot; the fallback-selection id it can no longer compute for us
      // (selection side effects live in the caller, never in a command) is
      // computed here first, from the pre-delete tree, mirroring the old
      // do()'s own all/fallback formula.
      const survivors = flattenLayers(parent).filter(candidate => candidate.id !== layer.id);
      const fallback = survivors[Math.min(loc.index, survivors.length - 1)];
      const fallbackId = fallback ? fallback.id : null;
      // Settle while the source layers still exist, before the command takes
      // its undo snapshot; the later selection notification is too late.
      commitFloatIfAny();
      dispatch(`${mode}.deleteNode`, { sheetId: sheet.id, nodeId: layer.id });
      setSheetSelection(sheet, { layerId: fallbackId });
      selectedNodeId = fallbackId;
      return;
    }
    if (selectedNodeId) {
      const g = findGroup(sheet.layerTree, selectedNodeId);
      if (g) {
        if (g.animationId) {
          const anim = sheet.animations.find(a => a.id === g.animationId);
          if (!confirmOrAuto(`Delete animation "${anim?.name ?? g.name}" and its frames?`)) return;
          commitFloatIfAny();
          commitDeleteAnimation(sheet, g.animationId);
          // commitDeleteAnimation lives in js/features/animations/commands.js and has no knowledge
          // of this panel's own local selectedNodeId -- clear it so a stale
          // id (pointing at the now-deleted group) doesn't linger, matching
          // the layer-delete branch above which resets it after its own
          // deletion too. No explicit renderList() call needed here: like
          // every other branch in this function, commitDeleteAnimation's own
          // history push already triggers this panel's history.subscribe.
          selectedNodeId = null;
          return;
        }
        if (!confirmOrAuto(`Delete group "${g.name}" and its contents?`)) return;
        const beforeActive = currentLayerId();
        commitFloatIfAny();
        dispatch(`${mode}.deleteNode`, { sheetId: sheet.id, nodeId: g.id });
        selectedNodeId = beforeActive;
      }
    }
  }

  function doMergeDown() {
    const mode = currentModeId();
    const sheet = activeSheet();
    const layer = activeLayer();
    if (!sheet || !layer) return;
    const loc = findParent(sheet.layerTree, layer.id);
    if (!loc || loc.index <= 0) { alert('Cannot merge the bottom layer down.'); return; }
    const dest = loc.parent.children[loc.index - 1];
    if (dest.type !== 'layer') { alert('Cannot merge into a group.'); return; }
    // The merge must composite settled pixels and snapshot that same source.
    commitFloatIfAny();
    const destId = dispatch(`${mode}.mergeDown`, { sheetId: sheet.id, layerId: layer.id });
    if (destId) { setSheetSelection(sheet, { layerId: destId }); selectedNodeId = destId; }
  }

  function doMove(node, delta) {
    const sheet = activeSheet();
    if (!sheet || !node) return;
    dispatch(`${currentModeId()}.moveNode`, { sheetId: sheet.id, nodeId: node.id, delta });
  }

  function doToggleVisible(layer) {
    dispatch(`${currentModeId()}.toggleLayerVisible`, { sheetId: activeSheet().id, layerId: layer.id });
  }

  function autoName(node) {
    const sheet = activeSheet();
    if (!sheet) return node.name;
    const type = node.type === 'group' ? 'group' : 'layer';
    const prefix = type === 'group' ? 'Group' : 'Layer';
    const base = countNodes(sheet, type) + 1;
    return `${prefix} ${base}`;
  }

  function startRename(node, nameEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = node.name;
    input.className = 'layer-rename-input';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function commit() {
      if (done) return;
      done = true;
      let v = input.value.trim();
      if (!v) v = autoName(node);
      if (v !== node.name) {
        if (currentModeId() === 'maps') {
          const map = activeMap();
          if (map) dispatch('maps.renameLayer', { mapId: map.id, layerId: node.id, name: v });
        } else {
          const sheet = activeSheet();
          if (sheet) dispatch(`${currentModeId()}.renameNode`, { sheetId: sheet.id, nodeId: node.id, name: v });
        }
      }
      renderList();
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      else if (e.key === 'Escape') { done = true; renderList(); }
    });
  }

  const thumbCanvases = new Map();
  let draggedId = null;
  let pendingNameClickTimer = null;

  function scheduleNameSelect(selectFn) {
    if (pendingNameClickTimer) {
      clearTimeout(pendingNameClickTimer);
      pendingNameClickTimer = null;
    }
    selectFn();
    pendingNameClickTimer = setTimeout(() => {
      pendingNameClickTimer = null;
      renderList();
    }, 200);
  }

  function isDescendant(parent, childId) {
    if (parent.id === childId) return true;
    if (!parent.children) return false;
    return parent.children.some(c => c.type === 'group' && isDescendant(c, childId));
  }

  function clearDropIndicators() {
    for (const row of list.querySelectorAll('.layer-row')) {
      row.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into');
    }
  }

  function getDropPosition(row, clientY) {
    const rect = row.getBoundingClientRect();
    const rel = clientY - rect.top;
    const pct = rel / rect.height;
    if (pct < 0.3) return 'before';
    if (pct > 0.7) return 'after';
    if (row.classList.contains('group-row')) return 'into';
    return rel < rect.height / 2 ? 'before' : 'after';
  }

  function applyDropIndicator(row, position) {
    clearDropIndicators();
    if (row && row.dataset.nodeId !== draggedId) row.classList.add('drop-' + position);
  }

  function performMove(sheet, nodeId, destParentId, destIndex) {
    const destParent = findGroup(sheet.layerTree, destParentId) ?? sheet.layerTree;
    dispatch(`${currentModeId()}.dragMoveNode`, { sheetId: sheet.id, nodeId, destParentId: destParent === sheet.layerTree ? null : destParent.id, destIndex });
  }

  function onRowDragStart(e, node) {
    draggedId = node.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.id);
    e.currentTarget.classList.add('dragging');
  }

  function onRowDragEnd() {
    draggedId = null;
    clearDropIndicators();
  }

  function onListDragOver(e) {
    e.preventDefault();
    const row = e.target.closest('.layer-row');
    // Dropping in empty space below rows silently targets the root.
    if (!row) {
      clearDropIndicators();
      e.dataTransfer.dropEffect = 'move';
      return;
    }
    if (row.dataset.nodeId === draggedId) {
      clearDropIndicators();
      return;
    }
    const pos = getDropPosition(row, e.clientY);
    applyDropIndicator(row, pos);
    e.dataTransfer.dropEffect = 'move';
  }

  function onListDragLeave(e) {
    if (!list.contains(e.relatedTarget)) clearDropIndicators();
  }

  function onListDrop(e) {
    e.preventDefault();
    const row = e.target.closest('.layer-row');
    const sourceId = draggedId ?? e.dataTransfer.getData('text/plain');
    clearDropIndicators();
    if (!sourceId) return;

    const sheet = activeSheet();
    if (!sheet) return;
    const srcNode = findNode(sheet.layerTree, sourceId);
    if (!srcNode) return;

    let destParent, destIndex;
    if (!row || row.dataset.nodeId === sourceId) {
      // Dropping in empty space or on the source row defaults to the root.
      destParent = sheet.layerTree;
      destIndex = sheet.layerTree.children.length;
    } else {
      const targetId = row.dataset.nodeId;
      if (targetId === sourceId) return;
      const targetNode = findNode(sheet.layerTree, targetId);
      if (!targetNode) return;

      const pos = getDropPosition(row, e.clientY);
      if (pos === 'into' && targetNode.type === 'group') {
        // Layers may be dropped into animation-owned groups; groups may not.
        destParent = targetNode;
        destIndex = targetNode.children.length;
      } else {
        const targetLoc = findParent(sheet.layerTree, targetId);
        if (!targetLoc) return;
        destParent = targetLoc.parent;
        destIndex = targetLoc.index + (pos === 'after' ? 1 : 0);
      }
    }

    // Guards against invalid drops.
    // Groups cannot be moved into animation-owned groups.
    if (srcNode.type === 'group' && destParent.animationId) return;
    if (srcNode.type === 'group' && isDescendant(srcNode, destParent.id)) return;

    performMove(sheet, sourceId, destParent.id, destIndex);
  }

  list.addEventListener('dragover', onListDragOver);
  list.addEventListener('dragleave', onListDragLeave);
  list.addEventListener('drop', onListDrop);

  // Selecting an animation's group node also selects that animation in the
  // timeline dock and on the sprite sheet (and selecting a plain group
  // clears it), so all three stay in sync -- see selectLayerNode below for
  // the layer-row equivalent.
  function selectGroupNode(group) {
    selectedNodeId = group.id;
    const sheet = activeSheet();
    const animId = group.animationId ?? null;
    if (sheet) setSheetSelection(sheet, { layerId: null, animationId: animId });
    lastSyncedAnimationId = animId;
  }

  // Selecting a layer also selects the animation that owns its group (or
  // clears the animation selection for a root/plain-group layer), mirroring
  // selectGroupNode above.
  function selectLayerNode(layer) {
    const sheet = activeSheet();
    selectedNodeId = layer.id;
    const ctx = sheet ? layerAnimationContext(sheet, layer) : null;
    const animId = ctx?.anim.id ?? null;
    if (sheet) setSheetSelection(sheet, { layerId: layer.id, animationId: animId });
    lastSyncedAnimationId = animId;
  }

  function renderGroup(group, depth) {
    const sheet = activeSheet();
    const row = document.createElement('div');
    row.className = 'layer-row group-row' + (group.id === selectedNodeId ? ' active' : '');
    row.style.paddingLeft = (4 + depth * 14) + 'px';
    row.draggable = true;
    row.dataset.nodeId = group.id;
    row.tabIndex = 0;
    row.addEventListener('dragstart', (e) => onRowDragStart(e, group));
    row.addEventListener('dragend', onRowDragEnd);
    row.addEventListener('keydown', (e) => {
      if (group.id !== selectedNodeId) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); doMove(group, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); doMove(group, -1); }
    });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tree-toggle';
    toggle.textContent = group.open !== false ? '▼' : '▶';
    toggle.addEventListener('click', (e) => { e.stopPropagation(); group.open = !group.open; renderList(); });

    const icon = document.createElement('span');
    icon.className = 'group-icon';
    icon.textContent = group.animationId ? '🎞' : '📁';

    const nameEl = document.createElement('span');
    nameEl.className = 'layer-name';
    nameEl.textContent = group.name;
    nameEl.addEventListener('selectstart', (e) => e.preventDefault());
    nameEl.addEventListener('dragstart', (e) => e.stopPropagation());
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      scheduleNameSelect(() => selectGroupNode(group));
    });
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (pendingNameClickTimer) { clearTimeout(pendingNameClickTimer); pendingNameClickTimer = null; }
      startRename(group, nameEl);
    });

    row.append(toggle, icon, nameEl);
    row.addEventListener('click', () => { selectGroupNode(group); renderList(); });
    list.appendChild(row);

    if (group.open !== false) {
      for (let i = group.children.length - 1; i >= 0; i--) {
        renderNode(group.children[i], depth + 1);
      }
    }
  }

  function renderLayer(layer, depth) {
    const sheet = activeSheet();
    const row = document.createElement('div');
    row.className = 'layer-row layer-leaf' + (layer.id === currentLayerId() ? ' active' : '');
    row.style.paddingLeft = (4 + depth * 14) + 'px';
    row.draggable = true;
    row.dataset.nodeId = layer.id;
    row.tabIndex = 0;
    row.addEventListener('dragstart', (e) => onRowDragStart(e, layer));
    row.addEventListener('dragend', onRowDragEnd);
    row.addEventListener('click', () => { selectLayerNode(layer); renderList(); });
    row.addEventListener('keydown', (e) => {
      if (layer.id !== currentLayerId()) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); doMove(layer, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); doMove(layer, -1); }
    });

    // A thin spacer for layer rows keeps a consistent visual rhythm with
    // group rows while not pushing the thumbnail far to the right.
    const spacer = document.createElement('span');
    spacer.className = 'tree-spacer leaf-spacer';

    const thumb = document.createElement('canvas');
    thumb.className = 'layer-thumb';
    thumb.width = LAYER_THUMB_SIZE; thumb.height = LAYER_THUMB_SIZE;
    const currentFloat = activeFloating();
    const fl = currentFloat?.sheetId === sheet.id ? currentFloat : null;
    drawFit(thumb, (fl && compositeFloatOnLayer(layer.bitmap, fl, layer.id)) || layer.bitmap);
    thumbCanvases.set(layer.id, thumb);

    const visBtn = document.createElement('button');
    visBtn.type = 'button';
    visBtn.textContent = layer.visible ? '👁' : '🚫';
    visBtn.title = 'Toggle visibility';
    visBtn.addEventListener('click', (e) => { e.stopPropagation(); doToggleVisible(layer); });
    visBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

    const nameEl = document.createElement('span');
    nameEl.className = 'layer-name';
    nameEl.textContent = layer.name;
    nameEl.addEventListener('selectstart', (e) => e.preventDefault());
    nameEl.addEventListener('dragstart', (e) => e.stopPropagation());
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      scheduleNameSelect(() => selectLayerNode(layer));
    });
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (pendingNameClickTimer) { clearTimeout(pendingNameClickTimer); pendingNameClickTimer = null; }
      startRename(layer, nameEl);
    });

    const opacityInput = document.createElement('input');
    opacityInput.type = 'range'; opacityInput.min = '0'; opacityInput.max = '100';
    opacityInput.value = String(Math.round(layer.opacity * 100));
    opacityInput.addEventListener('click', (e) => e.stopPropagation());
    opacityInput.addEventListener('dragstart', (e) => e.stopPropagation());
    let opacityBefore = null;
    opacityInput.addEventListener('pointerdown', (e) => { e.stopPropagation(); opacityBefore = layer.opacity; });
    opacityInput.addEventListener('input', () => {
      opacityBefore ??= layer.opacity;
      layer.opacity = Number(opacityInput.value) / 100;
      getEditorHost().store.notifyPixelsChanged();
    });
    opacityInput.addEventListener('change', () => {
      if (opacityBefore == null) return;
      const before = opacityBefore, after = layer.opacity;
      opacityBefore = null;
      if (before === after) return;
      // setLayerOpacity snapshots layer.opacity as "before" the instant it's
      // called; the input handler above already live-applied `after` for
      // drag preview, so reset it here first or the command would see
      // before === after and silently no-op (no undo entry at all).
      layer.opacity = before;
      dispatch(`${currentModeId()}.setLayerOpacity`, { sheetId: activeSheet().id, layerId: layer.id, opacity: after });
    });

    row.append(spacer, thumb, visBtn, nameEl, opacityInput);
    list.appendChild(row);
  }

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
    nameEl.addEventListener('click', e => { e.stopPropagation(); scheduleNameSelect(() => host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId: layer.id }, { kind: 'map', id: map.id })); });
    nameEl.addEventListener('dblclick', e => { e.stopPropagation(); if (pendingNameClickTimer) { clearTimeout(pendingNameClickTimer); pendingNameClickTimer = null; } startRename(layer, nameEl); });
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

  function renderNode(node, depth) {
    if (node.type === 'group') renderGroup(node, depth);
    else renderLayer(node, depth);
  }

  // If the selected animation (per SelectionService) changed since this panel last agreed with
  // it, the change came from elsewhere (timeline dropdown, sprite sheet
  // click) -- follow it by highlighting the matching group (or falling back
  // to the active layer when it's cleared to "(none)"). A change this panel
  // made itself is already reflected in selectedNodeId, so this is a no-op
  // in that case (lastSyncedAnimationId is kept current by selectGroupNode/
  // selectLayerNode).
  function syncFromAnimationSelection(sheet) {
    const animId = currentAnimationId();
    if (animId === lastSyncedAnimationId) return;
    lastSyncedAnimationId = animId;
    if (animId) {
      const group = animationGroup(sheet, animId);
      if (group) { selectedNodeId = group.id; setSheetSelection(sheet, { layerId: null }); return; }
    }
    selectedNodeId = currentLayerId();
  }

  function renderList() {
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
    syncFromAnimationSelection(sheet);
    const currentId = currentLayerId();
    if (currentId && !findNode(sheet.layerTree, currentId)) {
      const context = currentAnimationId() ? animationGroup(sheet, currentAnimationId()) : sheet.layerTree;
      const fallback = context ? flattenLayers(context)[0] : sheetLayers(sheet)[0];
      setSheetSelection(sheet, { layerId: fallback?.id ?? null });
    }
    if (selectedNodeId && !findNode(sheet.layerTree, selectedNodeId)) {
      selectedNodeId = currentLayerId();
    }
    for (let i = sheet.layerTree.children.length - 1; i >= 0; i--) {
      renderNode(sheet.layerTree.children[i], 0);
    }
  }

  let thumbRedrawQueued = false;
  function redrawThumbs() {
    const sheet = activeSheet();
    if (!sheet) return;
    for (const layer of sheetLayers(sheet)) {
      const canvas = thumbCanvases.get(layer.id);
      const currentFloat = activeFloating();
      const fl = currentFloat?.sheetId === sheet.id ? currentFloat : null;
      if (canvas) drawFit(canvas, (fl && compositeFloatOnLayer(layer.bitmap, fl, layer.id)) || layer.bitmap);
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
  // "Tile Layers" panel). Groups only ever gain an animationId via frames.js's
  // commitAcceptAnimation, which is gated to sprite mode, so these actions
  // can never create or touch an animation-owned group on a tile sheet -- no
  // isAvailable gating needed.
  defineAction('layer.add', { label: 'Add Layer', run: doAddLayer, isEnabled: () => !!activeSheet() || (currentModeId() === 'maps' && !!activeMap()) });
  bindAction(btnAddLayer, 'layer.add');
  defineAction('layer.addGroup', { label: 'Add Group', run: doAddGroup, isEnabled: () => !!activeSheet() || (currentModeId() === 'maps' && !!activeMap()) });
  bindAction(btnAddGroup, 'layer.addGroup');
  defineAction('layer.delete', { label: 'Delete Layer', run: doDelete, isEnabled: () => !!activeSheet() || (currentModeId() === 'maps' && !!activeMap()) });
  bindAction(btnDelete, 'layer.delete');
  defineAction('layer.mergeDown', { label: 'Merge Down', run: doMergeDown, isEnabled: () => !!activeSheet() });
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
    if (pendingNameClickTimer) return;
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
