// The sheet layer tree shared by the Layers panel and the Animations
// timeline: rows, row actions, drag-and-drop, and the one selected tree
// node. Both trees build their rows here, so a folder selected in one is
// where the other adds a layer. Map layers are the Layers panel's own.

import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeLayer, activeMap } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { activeFloating, commitFloatIfAny } from '../canvas/float-session.js';
import { findNode, findParent, flattenLayers, findGroup } from '../../core/model.js';
import { compositeFloatOnLayer } from '../../core/floating.js';
import { drawFit } from '../canvas/draw-fit.js';

// Dispatches a Command Handler by id (registered in each mode's
// contributions.js) rather than importing it directly.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: getEditorHost().store.getState().session.activeModeId }, args);
}

export function currentModeId() {
  return getEditorHost().store.getState().session.activeModeId;
}

// The prefix of the layer commands this workbench dispatches: the Animations
// workbench edits sprite sheets through the sprites.* layer commands.
export function commandPrefix() {
  const mode = currentModeId();
  return mode === 'animations' ? 'sprites' : mode;
}

// ------------------------------------------------------ shared thumb drawing

export const LAYER_THUMB_SIZE = 40;

// A layer's thumbnail, with a float over it composited in.
export function drawLayerThumb(canvas, sheet, layer) {
  const currentFloat = activeFloating();
  const fl = currentFloat?.sheetId === sheet.id ? currentFloat : null;
  drawFit(canvas, (fl && compositeFloatOnLayer(layer.bitmap, fl, layer.id)) || layer.bitmap);
}

// ------------------------------------------------------- selection and rows

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
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

// A selected folder. A selected layer is the sheet selection's layerId,
// which is authoritative for drawing; the folder yields to it as soon as any
// path makes a layer active.
let selectedGroupId = null;

// The selected tree node: the active layer, else the selected folder.
export function selectedNodeId() {
  const layerId = currentLayerId();
  if (layerId) return layerId;
  const sheet = activeSheet();
  if (!sheet || !selectedGroupId || !findGroup(sheet.layerTree, selectedGroupId)) return null;
  return selectedGroupId;
}

export function selectTreeNode(sheet, node) {
  if (node.type === 'group') {
    selectedGroupId = node.id;
    setSheetSelection(sheet, { layerId: null });
  } else {
    selectedGroupId = null;
    setSheetSelection(sheet, { layerId: node.id });
  }
}

// The rows a tree shows, top node first; a folder's children follow it
// unless it is collapsed.
export function layerTreeRows(tree) {
  const rows = [];
  (function walk(group, depth) {
    for (let i = group.children.length - 1; i >= 0; i--) {
      const node = group.children[i];
      rows.push({ node, depth });
      if (node.type === 'group' && node.open !== false) walk(node, depth + 1);
    }
  })(tree, 0);
  return rows;
}

function targetGroupForInsert() {
  const sheet = activeSheet();
  if (!sheet) return null;
  const nodeId = selectedNodeId();
  if (!nodeId) return sheet.layerTree;
  const node = findNode(sheet.layerTree, nodeId);
  if (!node) return sheet.layerTree;
  if (node.type === 'group') return node;
  const loc = findParent(sheet.layerTree, nodeId);
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

// --------------------------------------------------------------- actions

export function addSheetLayer() {
  const sheet = activeSheet();
  const group = targetGroupForInsert();
  if (!sheet || !group) return;
  const newLayerId = dispatch(`${commandPrefix()}.addLayer`, { sheetId: sheet.id, targetGroupId: group === sheet.layerTree ? null : group.id });
  selectedGroupId = null;
  setSheetSelection(sheet, { layerId: newLayerId });
}

export function addSheetGroup() {
  const sheet = activeSheet();
  const group = targetGroupForInsert();
  if (!sheet || !group) return;
  const newGroupId = dispatch(`${commandPrefix()}.addGroup`, { sheetId: sheet.id, targetGroupId: group === sheet.layerTree ? null : group.id });
  selectedGroupId = newGroupId;
  setSheetSelection(sheet, { layerId: null });
}

export function deleteSheetNode() {
  const mode = commandPrefix();
  const sheet = activeSheet();
  if (!sheet) return;
  const layer = activeLayer();
  if (layer) {
    const loc = findParent(sheet.layerTree, layer.id);
    if (!loc) return;
    const parent = loc.parent;
    // Scoped to this layer's own group, matching deleteNode's own guard:
    // a group is removed as a whole (group delete), never emptied layer by
    // layer.
    if (flattenLayers(parent).length <= 1) { alert('Cannot delete the last layer in this group.'); return; }
    if (!confirmOrAuto(`Delete layer "${layer.name}"?`)) return;
    // deleteNode's Command Handler owns the actual mutation + undo
    // snapshot; the fallback-selection id it can no longer compute for us
    // (selection side effects live in the caller, never in a command) is
    // computed here first, from the pre-delete tree.
    const survivors = flattenLayers(parent).filter(candidate => candidate.id !== layer.id);
    const fallback = survivors[Math.min(loc.index, survivors.length - 1)];
    const fallbackId = fallback ? fallback.id : null;
    // Settle while the source layers still exist, before the command takes
    // its undo snapshot; the later selection notification is too late.
    commitFloatIfAny();
    dispatch(`${mode}.deleteNode`, { sheetId: sheet.id, nodeId: layer.id });
    selectedGroupId = null;
    setSheetSelection(sheet, { layerId: fallbackId });
    return;
  }
  const nodeId = selectedNodeId();
  if (nodeId) {
    const g = findGroup(sheet.layerTree, nodeId);
    if (g) {
      if (!confirmOrAuto(`Delete group "${g.name}" and its contents?`)) return;
      commitFloatIfAny();
      dispatch(`${mode}.deleteNode`, { sheetId: sheet.id, nodeId: g.id });
      selectedGroupId = null;
    }
  }
}

export function mergeSheetLayerDown() {
  const sheet = activeSheet();
  const layer = activeLayer();
  if (!sheet || !layer) return;
  const loc = findParent(sheet.layerTree, layer.id);
  if (!loc || loc.index <= 0) { alert('Cannot merge the bottom layer down.'); return; }
  const dest = loc.parent.children[loc.index - 1];
  if (dest.type !== 'layer') { alert('Cannot merge into a group.'); return; }
  if (dest.locked) { alert(`Cannot merge into locked layer "${dest.name}".`); return; }
  // The merge must composite settled pixels and snapshot that same source.
  commitFloatIfAny();
  const destId = dispatch(`${commandPrefix()}.mergeDown`, { sheetId: sheet.id, layerId: layer.id });
  if (destId) { selectedGroupId = null; setSheetSelection(sheet, { layerId: destId }); }
}

function moveNode(node, delta) {
  const sheet = activeSheet();
  if (!sheet || !node) return;
  dispatch(`${commandPrefix()}.moveNode`, { sheetId: sheet.id, nodeId: node.id, delta });
}

function toggleVisible(layer) {
  dispatch(`${commandPrefix()}.toggleLayerVisible`, { sheetId: activeSheet().id, layerId: layer.id });
}

function autoName(node) {
  const sheet = activeSheet();
  if (!sheet) return node.name;
  const type = node.type === 'group' ? 'group' : 'layer';
  const prefix = type === 'group' ? 'Group' : 'Layer';
  const base = countNodes(sheet, type) + 1;
  return `${prefix} ${base}`;
}

// Double-click rename, shared by sheet and map rows.
export function startRename(node, nameEl, onChange) {
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
        if (sheet) dispatch(`${commandPrefix()}.renameNode`, { sheetId: sheet.id, nodeId: node.id, name: v });
      }
    }
    onChange();
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    else if (e.key === 'Escape') { done = true; onChange(); }
  });
}

// A single click on a name selects at once but re-renders only after a
// short grace window, so a following dblclick still reaches its row.
let pendingNameClickTimer = null;

export function nameClickPending() { return !!pendingNameClickTimer; }

export function cancelNameClick() {
  if (pendingNameClickTimer) { clearTimeout(pendingNameClickTimer); pendingNameClickTimer = null; }
}

export function scheduleNameSelect(selectFn, onChange) {
  cancelNameClick();
  selectFn();
  pendingNameClickTimer = setTimeout(() => {
    pendingNameClickTimer = null;
    onChange();
  }, 200);
}

// ---------------------------------------------------------- drag and drop

let draggedId = null;
const dropLists = new Set();

function isDescendant(parent, childId) {
  if (parent.id === childId) return true;
  if (!parent.children) return false;
  return parent.children.some(c => c.type === 'group' && isDescendant(c, childId));
}

function clearDropIndicators() {
  for (const list of dropLists) {
    for (const row of list.querySelectorAll('.layer-row')) {
      row.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into');
    }
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
  dispatch(`${commandPrefix()}.dragMoveNode`, { sheetId: sheet.id, nodeId, destParentId: destParent === sheet.layerTree ? null : destParent.id, destIndex });
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

// List-level drop handling for a container of layer rows. A drop outside
// any row moves the node to the root's top when emptyDropsToRoot is set
// (the Layers panel's empty space); elsewhere it is not a drop target.
export function attachLayerTreeDrop(list, { emptyDropsToRoot = true } = {}) {
  dropLists.add(list);

  list.addEventListener('dragover', (e) => {
    const row = e.target.closest('.layer-row');
    if (!row) {
      clearDropIndicators();
      if (!emptyDropsToRoot) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      return;
    }
    e.preventDefault();
    if (row.dataset.nodeId === draggedId) {
      clearDropIndicators();
      return;
    }
    const pos = getDropPosition(row, e.clientY);
    applyDropIndicator(row, pos);
    e.dataTransfer.dropEffect = 'move';
  });

  list.addEventListener('dragleave', (e) => {
    if (!list.contains(e.relatedTarget)) clearDropIndicators();
  });

  list.addEventListener('drop', (e) => {
    const row = e.target.closest('.layer-row');
    if (!row && !emptyDropsToRoot) return;
    e.preventDefault();
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
    if (srcNode.type === 'group' && isDescendant(srcNode, destParent.id)) return;

    performMove(sheet, sourceId, destParent.id, destIndex);
  });
}

// ------------------------------------------------------------------- rows

function nameSpan(node, onChange, select) {
  const nameEl = document.createElement('span');
  nameEl.className = 'layer-name';
  nameEl.textContent = node.name;
  nameEl.addEventListener('selectstart', (e) => e.preventDefault());
  nameEl.addEventListener('dragstart', (e) => e.stopPropagation());
  nameEl.addEventListener('click', (e) => {
    e.stopPropagation();
    scheduleNameSelect(select, onChange);
  });
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    cancelNameClick();
    startRename(node, nameEl, onChange);
  });
  return nameEl;
}

function buildGroupRow(group, depth, { onChange }) {
  const row = document.createElement('div');
  row.className = 'layer-row group-row' + (group.id === selectedNodeId() ? ' active' : '');
  row.style.paddingLeft = (4 + depth * 14) + 'px';
  row.draggable = true;
  row.dataset.nodeId = group.id;
  row.tabIndex = 0;
  row.addEventListener('dragstart', (e) => onRowDragStart(e, group));
  row.addEventListener('dragend', onRowDragEnd);
  row.addEventListener('keydown', (e) => {
    if (group.id !== selectedNodeId()) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveNode(group, 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveNode(group, -1); }
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tree-toggle';
  toggle.textContent = group.open !== false ? '▼' : '▶';
  toggle.addEventListener('click', (e) => { e.stopPropagation(); group.open = !group.open; onChange(); });

  const icon = document.createElement('span');
  icon.className = 'group-icon';
  icon.textContent = '📁';

  const select = () => { const sheet = activeSheet(); if (sheet) selectTreeNode(sheet, group); };
  row.append(toggle, icon, nameSpan(group, onChange, select));
  row.addEventListener('click', () => { select(); onChange(); });
  return row;
}

function buildLeafRow(layer, depth, { thumbs, onChange }) {
  const sheet = activeSheet();
  const row = document.createElement('div');
  row.className = 'layer-row layer-leaf' + (layer.id === currentLayerId() ? ' active' : '');
  row.style.paddingLeft = (4 + depth * 14) + 'px';
  row.draggable = true;
  row.dataset.nodeId = layer.id;
  row.tabIndex = 0;
  const select = () => { if (sheet) selectTreeNode(sheet, layer); };
  row.addEventListener('dragstart', (e) => onRowDragStart(e, layer));
  row.addEventListener('dragend', onRowDragEnd);
  row.addEventListener('click', () => { select(); onChange(); });
  row.addEventListener('keydown', (e) => {
    if (layer.id !== currentLayerId()) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveNode(layer, 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveNode(layer, -1); }
  });

  // A thin spacer for layer rows keeps a consistent visual rhythm with
  // group rows while not pushing the thumbnail far to the right.
  const spacer = document.createElement('span');
  spacer.className = 'tree-spacer leaf-spacer';
  row.append(spacer);

  if (thumbs) {
    const thumb = document.createElement('canvas');
    thumb.className = 'layer-thumb';
    thumb.width = LAYER_THUMB_SIZE; thumb.height = LAYER_THUMB_SIZE;
    drawLayerThumb(thumb, sheet, layer);
    thumbs.set(layer.id, thumb);
    row.append(thumb);
  }

  const visBtn = document.createElement('button');
  visBtn.type = 'button';
  visBtn.textContent = layer.visible ? '👁' : '🚫';
  visBtn.title = 'Toggle visibility';
  visBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleVisible(layer); });
  visBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  // Locking is a sprite-sheet feature (tile sheets share this tree but
  // register no toggleLayerLocked command).
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.textContent = layer.locked ? '🔒' : '🔓';
  lockBtn.title = layer.locked ? 'Unlock layer' : 'Lock layer';
  lockBtn.hidden = commandPrefix() !== 'sprites';
  lockBtn.addEventListener('click', (e) => { e.stopPropagation(); dispatch('sprites.toggleLayerLocked', { sheetId: activeSheet().id, layerId: layer.id }); });
  lockBtn.addEventListener('pointerdown', (e) => e.stopPropagation());

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
    dispatch(`${commandPrefix()}.setLayerOpacity`, { sheetId: activeSheet().id, layerId: layer.id, opacity: after });
  });

  row.append(visBtn, lockBtn, nameSpan(layer, onChange, select), opacityInput);
  return row;
}

// One `.layer-row` for a sheet layer-tree node. `thumbs` is a Map the caller
// redraws thumbnails from (null: no thumbnail); onChange() re-renders the
// caller's tree.
export function buildLayerRow(node, depth, { thumbs = null, onChange }) {
  return node.type === 'group'
    ? buildGroupRow(node, depth, { onChange })
    : buildLeafRow(node, depth, { thumbs, onChange });
}
