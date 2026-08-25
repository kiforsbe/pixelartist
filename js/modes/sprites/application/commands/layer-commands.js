// js/modes/sprites/application/commands/layer-commands.js
//
// Ports layers-panel.js's doAddLayer/doAddGroup/doDelete/doMergeDown/doMove/
// doToggleVisible/startRename-commit/performMove/renderLayer's opacity
// handler into standalone Command Handlers, minus the selectedNodeId/
// setSheetSelection calls (Task 3 moves those into the panel's caller code).
// sheet.layerTree is shared by sprite and tile sheets alike (see the
// repo-wide comment at layers-panel.js:810-817), so this file and the
// tiles-mode equivalent layer-commands.js are intentionally near-identical.
// Unlike tiles' version (which reuses tile-sheet-commands.js's
// runCommand, itself still carrying a legacy markDirty() call), this file
// defines its own bare runCommand: new code should never call the legacy
// markDirty() -- runEntityCommand's services.projects.mutate() already marks
// the host store dirty, and the legacy shadow call is being retired (Task 8).
import {
  createLayerNode, createGroupNode, findNode, findParent, findGroup, flattenLayers,
  mergeDown as mergeLayerDown, moveNode as moveTreeNode,
} from '../../../../core/model.js';
import { cloneBitmap, blitRegion } from '../../../../core/pixels.js';
import { runEntityCommand } from '../../../../host/command-helpers.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

export function runCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSheet(project, sheetId), apply, revert);
}

function countNodes(sheet, type) {
  let n = 0;
  (function walk(node) { if (node.type === type) n++; if (node.children) for (const c of node.children) walk(c); })(sheet.layerTree);
  return n;
}

// Mirrors layers-panel.js's targetGroupForInsert(), except it takes an
// already-resolved group id (computed by the panel from its own
// selectedNodeId) rather than reading any selection state itself.
function resolveGroup(sheet, groupId) {
  if (!groupId) return sheet.layerTree;
  return findGroup(sheet.layerTree, groupId) ?? sheet.layerTree;
}

export function toggleLayerVisible(services, sheetId, layerId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const layer = findNode(sheet.layerTree, layerId);
  const before = layer.visible;
  const after = !before;
  runCommand(services, sheetId, 'toggle layer visibility',
    sheet => { findNode(sheet.layerTree, layerId).visible = after; },
    sheet => { findNode(sheet.layerTree, layerId).visible = before; });
}

// Idempotent do(): the layer object is created once and reused across
// redo, so a redo after undo restores the SAME node identity/id rather than
// minting a new one (matches createTile/addMapLayer's existing pattern).
export function addLayer(services, sheetId, targetGroupId) {
  let newLayerId = null;
  let newLayerSnapshot = null;
  runCommand(services, sheetId, 'add layer',
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      if (!newLayerId) {
        const layer = createLayerNode(`Layer ${countNodes(sheet, 'layer') + 1}`, sheet.width, sheet.height);
        newLayerId = layer.id;
        newLayerSnapshot = layer;
        group.children.push(layer);
      } else if (!findNode(sheet.layerTree, newLayerId)) {
        group.children.push(newLayerSnapshot);
      }
    },
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      group.children = group.children.filter(c => c.id !== newLayerId);
    });
  return newLayerId;
}

export function addGroup(services, sheetId, targetGroupId) {
  let newGroupId = null;
  let newGroupSnapshot = null;
  runCommand(services, sheetId, 'add group',
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      if (!newGroupId) {
        const created = createGroupNode(`Group ${countNodes(sheet, 'group') + 1}`);
        newGroupId = created.id;
        newGroupSnapshot = created;
        group.children.push(created);
      } else if (!findNode(sheet.layerTree, newGroupId)) {
        group.children.push(newGroupSnapshot);
      }
    },
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      group.children = group.children.filter(c => c.id !== newGroupId);
    });
  return newGroupId;
}

// Ports doDelete's layer AND (non-animation) group branches -- both reduce,
// once selection bookkeeping is stripped, to the identical
// filter-on-do/snapshot-restore-on-undo shape below; only the label differs.
// Animation-owned groups are explicitly out of scope (see brief Step 1):
// those go through commitDeleteAnimation -> the already-migrated
// sprites.deleteAnimation command, which also cleans up sheet.animations --
// this function no-ops on them so a caller that dispatches here by mistake
// doesn't silently corrupt sheet.animations.
export function deleteNode(services, sheetId, nodeId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const node = findNode(sheet.layerTree, nodeId);
  if (!node) return;
  if (node.type === 'group' && node.animationId) return;
  const loc = findParent(sheet.layerTree, nodeId);
  if (!loc) return;
  const parent = loc.parent;
  // Mirrors doDelete's layer branch: never leave a group with zero layers.
  if (node.type === 'layer' && flattenLayers(parent).length <= 1) return;
  const parentId = parent.id;
  const beforeChildren = parent.children.slice();
  runCommand(services, sheetId, node.type === 'group' ? 'delete group' : 'delete layer',
    sheet => {
      const p = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree;
      p.children = p.children.filter(c => c.id !== nodeId);
    },
    sheet => {
      const p = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree;
      p.children = beforeChildren.slice();
    });
}

export function mergeLayerDownCmd(services, sheetId, layerId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const loc = findParent(sheet.layerTree, layerId);
  if (!loc || loc.index <= 0) return null;
  const dest = loc.parent.children[loc.index - 1];
  if (dest.type !== 'layer') return null;
  const parent = loc.parent;
  const parentId = parent.id;
  const beforeChildren = parent.children.slice();
  const destBefore = cloneBitmap(dest.bitmap);
  mergeLayerDown(sheet, layerId);
  const destAfter = cloneBitmap(dest.bitmap);
  const afterChildren = parent.children.slice();
  runCommand(services, sheetId, 'merge down',
    sheet => {
      const p = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree;
      blitRegion(dest.bitmap, destAfter, 0, 0);
      p.children = afterChildren.slice();
    },
    sheet => {
      const p = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree;
      p.children = beforeChildren.slice();
      blitRegion(dest.bitmap, destBefore, 0, 0);
    });
  return dest.id;
}

export function moveNode(services, sheetId, nodeId, delta) {
  const sheet = findSheet(services.projects.project, sheetId);
  const loc = findParent(sheet.layerTree, nodeId);
  if (!loc) return;
  const parent = loc.parent;
  const parentId = parent.id;
  const beforeChildren = parent.children.slice();
  const newIndex = Math.max(0, Math.min(parent.children.length - 1, loc.index + delta));
  moveTreeNode(sheet, nodeId, parentId, newIndex);
  const afterChildren = parent.children.slice();
  runCommand(services, sheetId, 'reorder layers',
    sheet => { const p = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree; p.children = afterChildren.slice(); },
    sheet => { const p = findGroup(sheet.layerTree, parentId) ?? sheet.layerTree; p.children = beforeChildren.slice(); });
}

export function dragMoveNode(services, sheetId, nodeId, destParentId, destIndex) {
  const sheet = findSheet(services.projects.project, sheetId);
  const srcLoc = findParent(sheet.layerTree, nodeId);
  if (!srcLoc) return;
  const srcParent = srcLoc.parent;
  const srcParentId = srcParent.id;
  const destParent = destParentId ? (findGroup(sheet.layerTree, destParentId) ?? sheet.layerTree) : sheet.layerTree;
  const resolvedDestParentId = destParent.id;
  const beforeSrc = srcParent.children.slice();
  const beforeDest = destParent.children.slice();
  moveTreeNode(sheet, nodeId, resolvedDestParentId, destIndex);
  const afterSrc = srcParent.children.slice();
  const afterDest = destParent.children.slice();
  // Skip if nothing changed (mirrors performMove's own guard).
  if (beforeSrc.length === afterSrc.length && beforeDest.length === afterDest.length &&
      beforeSrc.every((c, i) => c === afterSrc[i]) && beforeDest.every((c, i) => c === afterDest[i])) return;
  runCommand(services, sheetId, 'move layer',
    sheet => {
      const sp = findGroup(sheet.layerTree, srcParentId) ?? sheet.layerTree;
      const dp = findGroup(sheet.layerTree, resolvedDestParentId) ?? sheet.layerTree;
      sp.children = afterSrc.slice(); dp.children = afterDest.slice();
    },
    sheet => {
      const sp = findGroup(sheet.layerTree, srcParentId) ?? sheet.layerTree;
      const dp = findGroup(sheet.layerTree, resolvedDestParentId) ?? sheet.layerTree;
      sp.children = beforeSrc.slice(); dp.children = beforeDest.slice();
    });
}

export function renameNode(services, sheetId, nodeId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const node = findNode(sheet.layerTree, nodeId);
  if (!node || node.name === name) return;
  const before = node.name;
  const anim = node.type === 'group' && node.animationId ? sheet.animations.find(a => a.id === node.animationId) : null;
  const oldAnimName = anim?.name;
  runCommand(services, sheetId, node.type === 'group' ? 'rename group' : 'rename layer',
    sheet => {
      const n = findNode(sheet.layerTree, nodeId);
      n.name = name;
      const a = anim ? sheet.animations.find(x => x.id === anim.id) : null;
      if (a) a.name = name;
    },
    sheet => {
      const n = findNode(sheet.layerTree, nodeId);
      n.name = before;
      const a = anim ? sheet.animations.find(x => x.id === anim.id) : null;
      if (a) a.name = oldAnimName;
    });
}

export function setLayerOpacity(services, sheetId, layerId, opacity) {
  const sheet = findSheet(services.projects.project, sheetId);
  const layer = findNode(sheet.layerTree, layerId);
  const before = layer.opacity;
  if (before === opacity) return;
  runCommand(services, sheetId, 'layer opacity',
    sheet => { findNode(sheet.layerTree, layerId).opacity = opacity; },
    sheet => { findNode(sheet.layerTree, layerId).opacity = before; });
}
