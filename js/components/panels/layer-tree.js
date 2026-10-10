// The sheet layer tree shared by the Layers panel and the Animations
// timeline: rows, row actions, drag-and-drop, eye/lock gestures, the row
// context menu, and the one selected tree node. Both trees build their rows
// here, so a folder selected in one is where the other adds a layer. Map
// layers are the Layers panel's own.

import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeLayer, activeMap } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { activeFloating, commitFloatIfAny } from '../canvas/float-session.js';
import { findNode, findParent, flattenLayers, findGroup } from '../../core/model.js';
import { compositeFloatOnLayer } from '../../core/floating.js';
import { drawFit } from '../canvas/draw-fit.js';
import { attachDragReorder, treeDropDestination } from '../drag-reorder.js';
import { attachContextMenu } from '../context-menu.js';

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

function toggleLocked(layer) {
  dispatch('sprites.toggleLayerLocked', { sheetId: activeSheet().id, layerId: layer.id });
}

// ----------------------------------------------- eye/lock solo and paint

const PAINT = {
  visible: { get: layer => !!layer.visible, toggle: toggleVisible },
  locked: { get: layer => !!layer.locked, toggle: toggleLocked },
};

// Runs `steps` as one history entry (each toggle is its own command).
function asOneStep(steps) {
  const history = getEditorHost().history;
  const token = history.mark();
  try { steps(); } finally { history.combineSince(token); }
}

// Alt-click an eye: show only that layer. Alt-click it again (while the
// solo still stands) restores the visibility saved at solo time; soloing
// another layer meanwhile keeps that saved state.
let solo = null; // { sheetId, layerId, saved: Map<layerId, visible> }

function soloLayer(layer) {
  const sheet = activeSheet();
  if (!sheet) return;
  const layers = flattenLayers(sheet.layerTree);
  const soloed = id => layers.every(l => !!l.visible === (l.id === id));
  let want;
  if (solo?.sheetId === sheet.id && soloed(solo.layerId)) {
    if (solo.layerId === layer.id) {
      const saved = solo.saved;
      want = l => saved.get(l.id) ?? !!l.visible;
      solo = null;
    } else {
      solo.layerId = layer.id;
      want = l => l.id === layer.id;
    }
  } else {
    solo = { sheetId: sheet.id, layerId: layer.id, saved: new Map(layers.map(l => [l.id, !!l.visible])) };
    want = l => l.id === layer.id;
  }
  asOneStep(() => { for (const l of layers) if (!!l.visible !== want(l)) toggleVisible(l); });
}

// Pressing an eye (or lock) toggles it; dragging on over other eyes (locks)
// paints that same state onto each, and the whole gesture is one history
// step. Module state, so it survives the re-render every toggle causes.
let paint = null; // { kind, sheetId, value, token }

function paintLayer(layer) {
  const sheet = activeSheet();
  if (!paint || sheet?.id !== paint.sheetId || !findNode(sheet.layerTree, layer.id)) return;
  if (PAINT[paint.kind].get(layer) !== paint.value) PAINT[paint.kind].toggle(layer);
}

function endPaint() {
  if (!paint) return;
  window.removeEventListener('pointerup', endPaint, true);
  window.removeEventListener('pointercancel', endPaint, true);
  getEditorHost().history.combineSince(paint.token);
  paint = null;
}

function onToggleButtonDown(e, kind, layer) {
  e.stopPropagation();
  if ((e.button ?? 0) !== 0) return;
  const sheet = activeSheet();
  if (!sheet) return;
  endPaint();
  if (kind === 'visible' && e.altKey) { soloLayer(layer); return; }
  // Touch captures the pointer on the pressed button; release it so the
  // buttons passed over still see the pointer enter.
  try { e.target?.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  paint = { kind, sheetId: sheet.id, value: !PAINT[kind].get(layer), token: getEditorHost().history.mark() };
  window.addEventListener('pointerup', endPaint, true);
  window.addEventListener('pointercancel', endPaint, true);
  paintLayer(layer);
}

// Wires an eye/lock button: the press does the work, so a pointer click
// (detail >= 1) is ignored; a keyboard click (detail 0) toggles.
function wireToggleButton(btn, kind, layer) {
  btn.addEventListener('pointerdown', (e) => onToggleButtonDown(e, kind, layer));
  btn.addEventListener('pointerenter', () => { if (paint?.kind === kind) paintLayer(layer); });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!e.detail) PAINT[kind].toggle(layer);
  });
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

// The drag key of the Layers panel's end target: the empty space below the
// rows, which stands for the bottom of the root.
export const LAYER_TREE_END = ':end';

// The end target the Layers panel appends after its rows (see
// attachLayerTreeDrop's emptyDropsToRoot).
export function buildLayerTreeEnd() {
  const end = document.createElement('div');
  end.className = 'layer-tree-item layer-tree-end';
  end.dataset.dragKey = LAYER_TREE_END;
  end.dataset.depth = '0';
  return end;
}

// Where a drop of `sourceId` on `target` (attachDragReorder's target) puts
// it: { destParentId, destIndex, noOp }, or null when it cannot go there.
function layerDropDestination(sheet, sourceId, { targetKey, index, place }, emptyDropsToRoot) {
  if (targetKey === LAYER_TREE_END) {
    const loc = emptyDropsToRoot ? findParent(sheet.layerTree, sourceId) : null;
    if (!loc) return null;
    return { destParentId: null, destIndex: 0, noOp: loc.parent === sheet.layerTree && loc.index === 0 };
  }
  const rows = layerTreeRows(sheet.layerTree);
  if (rows[index]?.node.id !== targetKey) return null; // rows changed under the drag
  return treeDropDestination(sheet.layerTree, rows, sourceId, { index, place });
}

// Lists that show layer rows (for the rename action to find its row).
const treeLists = new Set();

// Pointer drag-reorder for a container of layer rows (js/components/
// drag-reorder.js in tree mode). With emptyDropsToRoot (the Layers panel)
// the container's end target (buildLayerTreeEnd) takes a node to the bottom
// of the root; elsewhere nothing below the rows is a target. Returns
// dispose().
export function attachLayerTreeDrop(list, { emptyDropsToRoot = true } = {}) {
  treeLists.add(list);
  const destination = (sourceKey, target) => {
    const sheet = activeSheet();
    return sheet ? layerDropDestination(sheet, sourceKey, target, emptyDropsToRoot) : null;
  };
  const dispose = attachDragReorder(list, {
    itemSelector: '.layer-tree-item',
    handleSelector: '.layer-row', // the end target is never a drag source
    tree: { depth: el => Number(el.dataset.depth) || 0, isGroup: el => el.classList.contains('group-row') },
    canDrop: (sourceKey, target) => destination(sourceKey, target) !== null,
    onDrop: ({ sourceKey, targetKey, index, place }) => {
      const sheet = activeSheet();
      const dest = destination(sourceKey, { targetKey, index, place });
      if (!sheet || !dest || dest.noOp) return;
      dispatch(`${commandPrefix()}.dragMoveNode`, { sheetId: sheet.id, nodeId: sourceKey, destParentId: dest.destParentId, destIndex: dest.destIndex });
    },
  });
  return () => { treeLists.delete(list); dispose(); };
}

// ------------------------------------------------------------ context menu

// The row context menu: the layer actions (defined by the Layers panel).
export const LAYER_MENU_ITEMS = [
  { action: 'layer.rename' },
  { separator: true },
  { action: 'layer.add' },
  { action: 'layer.addGroup' },
  { separator: true },
  { action: 'layer.mergeDown' },
  { action: 'layer.delete' },
];

// Right-click selects the row (select(); onChange()) and opens the menu.
export function attachLayerRowMenu(row, select, onChange) {
  attachContextMenu(row, () => {
    select();
    onChange();
    return LAYER_MENU_ITEMS;
  });
}

// Each row's inline rename, for the layer.rename action.
const rowRenames = new WeakMap();

export function setRowRename(row, rename) { rowRenames.set(row, rename); }

// Starts the inline rename of the active row in the visible layer list.
export function renameActiveRow() {
  for (const list of treeLists) {
    if (list.isConnected === false || list.closest?.('[hidden]')) continue;
    const row = list.querySelectorAll('.layer-row').find(r => r.classList.contains('active'));
    const rename = row && rowRenames.get(row);
    if (rename) { rename(); return true; }
  }
  return false;
}

// ------------------------------------------------------------------- rows

function nameSpan(node, onChange, select) {
  const nameEl = document.createElement('span');
  nameEl.className = 'layer-name';
  nameEl.textContent = node.name;
  nameEl.addEventListener('selectstart', (e) => e.preventDefault());
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

// The parts every tree row shares: drag key and depth (attachLayerTreeDrop),
// click to select, ArrowUp/Down to reorder, the context menu, and the inline
// rename the layer.rename action starts.
function treeRow(node, depth, className, { onChange, select, isSelected }) {
  const row = document.createElement('div');
  row.className = `layer-row ${className} layer-tree-item` + (isSelected() ? ' active' : '');
  row.style.paddingLeft = (4 + depth * 14) + 'px';
  row.dataset.nodeId = node.id;
  row.dataset.dragKey = node.id;
  row.dataset.depth = String(depth);
  row.tabIndex = 0;
  row.addEventListener('click', () => { select(); onChange(); });
  row.addEventListener('keydown', (e) => {
    if (!isSelected()) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); moveNode(node, 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveNode(node, -1); }
  });
  attachLayerRowMenu(row, select, onChange);
  const nameEl = nameSpan(node, onChange, select);
  setRowRename(row, () => { cancelNameClick(); startRename(node, nameEl, onChange); });
  return { row, nameEl };
}

function buildGroupRow(group, depth, { onChange }) {
  const select = () => { const sheet = activeSheet(); if (sheet) selectTreeNode(sheet, group); };
  const { row, nameEl } = treeRow(group, depth, 'group-row', { onChange, select, isSelected: () => group.id === selectedNodeId() });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tree-toggle';
  toggle.textContent = group.open !== false ? '▼' : '▶';
  toggle.addEventListener('click', (e) => { e.stopPropagation(); group.open = !group.open; onChange(); });

  const icon = document.createElement('span');
  icon.className = 'group-icon';
  icon.textContent = '📁';

  row.append(toggle, icon, nameEl);
  return row;
}

function buildLeafRow(layer, depth, { thumbs, onChange }) {
  const sheet = activeSheet();
  const select = () => { if (sheet) selectTreeNode(sheet, layer); };
  const { row, nameEl } = treeRow(layer, depth, 'layer-leaf', { onChange, select, isSelected: () => layer.id === currentLayerId() });

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

  // Press toggles, drag across paints, Alt-click solos (see wireToggleButton).
  const visBtn = document.createElement('button');
  visBtn.type = 'button';
  visBtn.className = 'layer-eye';
  visBtn.textContent = layer.visible ? '👁' : '🚫';
  visBtn.title = 'Toggle visibility';
  wireToggleButton(visBtn, 'visible', layer);
  // Locking is a sprite-sheet feature (tile sheets share this tree but
  // register no toggleLayerLocked command).
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'layer-lock';
  lockBtn.textContent = layer.locked ? '🔒' : '🔓';
  lockBtn.title = layer.locked ? 'Unlock layer' : 'Lock layer';
  lockBtn.hidden = commandPrefix() !== 'sprites';
  wireToggleButton(lockBtn, 'locked', layer);

  const opacityInput = document.createElement('input');
  opacityInput.type = 'range'; opacityInput.min = '0'; opacityInput.max = '100';
  opacityInput.value = String(Math.round(layer.opacity * 100));
  opacityInput.addEventListener('click', (e) => e.stopPropagation());
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

  row.append(visBtn, lockBtn, nameEl, opacityInput);
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
