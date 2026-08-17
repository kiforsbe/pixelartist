// Layers panel.

import { state, on, emit, activeSheet, activeLayer, activeMap, markDirty, confirmOrAuto } from '../../app/state.js';
import { commitDeleteAnimation } from '../../features/animations/commands.js';
import { cloneBitmap, blitRegion } from '../../core/pixels.js';
import { addLayer, addGroup, removeLayer, removeGroup, moveLayer, mergeDown, findNode, findParent, sheetLayers, flattenLayers, findGroup, findLayer, createLayerNode, createGroupNode, createMapLayer, refreshMapBounds, moveNode, animationGroup, layerAnimationContext } from '../../core/model.js';
import { compositeFloatOnLayer } from '../../core/floating.js';
import { defineAction, bindAction } from '../../app/actions.js';
import { getEditorHost } from '../../host/runtime.js';

function resetBody(el, headingText) {
  const h3 = el.querySelector('h3') ?? Object.assign(document.createElement('h3'), { textContent: headingText });
  el.innerHTML = '';
  el.appendChild(h3);
  return h3;
}

// ------------------------------------------------------ shared thumb drawing
//
// Mirrors js/ui/timeline.js's getScratchCanvas/drawFit pattern: one
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
  const smooth = scale < 1 && state.project?.settings?.smoothThumbnails !== false;
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
    if (state.mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const host = getEditorHost();
      const layerId = host.registries.commands.execute('maps.addLayer', { modeId: state.mode }, { mapId: map.id, type: 'tile' });
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
      emit('view'); return;
    }
    const sheet = activeSheet();
    const group = targetGroupForInsert();
    if (!sheet || !group) return;
    const beforeChildren = group.children.slice();
    const beforeActive = currentLayerId();
    let newLayer = null;
    const cmd = {
      label: 'add layer',
      do() {
        if (!newLayer) newLayer = createLayerNode(`Layer ${countNodes(sheet, 'layer') + 1}`, sheet.width, sheet.height);
        if (!group.children.includes(newLayer)) group.children.push(newLayer);
        setSheetSelection(sheet, { layerId: newLayer.id });
        selectedNodeId = newLayer.id;
      },
      undo() {
        group.children = beforeChildren.slice();
        setSheetSelection(sheet, { layerId: beforeActive });
        selectedNodeId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doAddGroup() {
    if (state.mode === 'maps') {
      const map = activeMap(); if (!map) return;
      const host = getEditorHost();
      const layerId = host.registries.commands.execute('maps.addLayer', { modeId: state.mode }, { mapId: map.id, type: 'sprite' });
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId }, { kind: 'map', id: map.id });
      emit('view'); return;
    }
    const sheet = activeSheet();
    const group = targetGroupForInsert();
    if (!sheet || !group) return;
    const beforeChildren = group.children.slice();
    const beforeActive = currentLayerId();
    let newGroup = null;
    const cmd = {
      label: 'add group',
      do() {
        if (!newGroup) newGroup = createGroupNode(`Group ${countNodes(sheet, 'group') + 1}`);
        if (!group.children.includes(newGroup)) group.children.push(newGroup);
        selectedNodeId = newGroup.id;
        setSheetSelection(sheet, { layerId: null });
      },
      undo() {
        group.children = beforeChildren.slice();
        selectedNodeId = beforeChildren[beforeChildren.length - 1]?.id ?? null;
        setSheetSelection(sheet, { layerId: beforeActive });
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doDelete() {
    if (state.mode === 'maps') {
      const host = getEditorHost();
      const map = activeMap(), layerId = (host.selections.get({ kind: 'map', id: map?.id }) ?? {}).layerId;
      const layer = map?.layers.find(l => l.id === layerId);
      if (!map || !layer || map.layers.length <= 1) return;
      if (!confirmOrAuto(`Delete ${layer.type} layer "${layer.name}"?`)) return;
      const remainingIndex = Math.min(map.layers.indexOf(layer), map.layers.length - 2);
      host.registries.commands.execute('maps.deleteLayer', { modeId: state.mode }, { mapId: map.id, layerId: layer.id });
      host.selections.set({ ...host.selections.get({ kind: 'map', id: map.id }), layerId: map.layers[Math.max(0, remainingIndex)]?.id ?? null }, { kind: 'map', id: map.id });
      emit('view'); return;
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
      const beforeChildren = parent.children.slice();
      const beforeActive = currentLayerId();
      const idx = loc.index;
      const cmd = {
        label: 'delete layer',
        do() {
          parent.children = parent.children.filter(c => c.id !== layer.id);
          const all = sheetLayers(sheet);
          const fallback = all[Math.min(idx, all.length - 1)];
          const fallbackId = fallback ? fallback.id : null;
          setSheetSelection(sheet, { layerId: fallbackId });
          selectedNodeId = fallbackId;
        },
        undo() {
          parent.children = beforeChildren.slice();
          setSheetSelection(sheet, { layerId: beforeActive });
          selectedNodeId = beforeActive;
        },
      };
      state.commands.push(cmd);
      markDirty();
      return;
    }
    if (selectedNodeId) {
      const g = findGroup(sheet.layerTree, selectedNodeId);
      if (g) {
        if (g.animationId) {
          const anim = sheet.animations.find(a => a.id === g.animationId);
          if (!confirmOrAuto(`Delete animation "${anim?.name ?? g.name}" and its frames?`)) return;
          commitDeleteAnimation(sheet, g.animationId);
          // commitDeleteAnimation lives in js/features/animations/commands.js and has no knowledge
          // of this panel's own local selectedNodeId -- clear it so a stale
          // id (pointing at the now-deleted group) doesn't linger, matching
          // the layer-delete branch above which resets it after its own
          // deletion too. No explicit renderList() call needed here: like
          // every other branch in this function, commitDeleteAnimation's own
          // markDirty() already triggers this panel's on('project', renderList).
          selectedNodeId = null;
          return;
        }
        if (!confirmOrAuto(`Delete group "${g.name}" and its contents?`)) return;
        const loc = findParent(sheet.layerTree, g.id);
        if (!loc) return;
        const parent = loc.parent;
        const beforeChildren = parent.children.slice();
        const beforeActive = currentLayerId();
        const cmd = {
          label: 'delete group',
          do() {
            parent.children = parent.children.filter(c => c.id !== g.id);
            selectedNodeId = beforeActive;
          },
          undo() {
            parent.children = beforeChildren.slice();
            selectedNodeId = g.id;
            setSheetSelection(sheet, { layerId: beforeActive });
          },
        };
        state.commands.push(cmd);
        markDirty();
      }
    }
  }

  function doMergeDown() {
    const sheet = activeSheet();
    const layer = activeLayer();
    if (!sheet || !layer) return;
    const loc = findParent(sheet.layerTree, layer.id);
    if (!loc || loc.index <= 0) { alert('Cannot merge the bottom layer down.'); return; }
    const dest = loc.parent.children[loc.index - 1];
    if (dest.type !== 'layer') { alert('Cannot merge into a group.'); return; }
    const parent = loc.parent;
    const beforeChildren = parent.children.slice();
    const beforeActive = currentLayerId();
    const destBefore = cloneBitmap(dest.bitmap);
    mergeDown(sheet, layer.id);
    const destAfter = cloneBitmap(dest.bitmap);
    const afterChildren = parent.children.slice();
    const afterActive = dest.id;
    setSheetSelection(sheet, { layerId: afterActive });
    const cmd = {
      label: 'merge down',
      do() {
        blitRegion(dest.bitmap, destAfter, 0, 0);
        parent.children = afterChildren.slice();
        setSheetSelection(sheet, { layerId: afterActive });
        selectedNodeId = afterActive;
      },
      undo() {
        parent.children = beforeChildren.slice();
        blitRegion(dest.bitmap, destBefore, 0, 0);
        setSheetSelection(sheet, { layerId: beforeActive });
        selectedNodeId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doMove(node, delta) {
    const sheet = activeSheet();
    if (!sheet || !node) return;
    const loc = findParent(sheet.layerTree, node.id);
    if (!loc) return;
    const parent = loc.parent;
    const beforeChildren = parent.children.slice();
    const newIndex = Math.max(0, Math.min(parent.children.length - 1, loc.index + delta));
    moveNode(sheet, node.id, parent.id, newIndex);
    const afterChildren = parent.children.slice();
    const cmd = {
      label: 'reorder layers',
      do() { parent.children = afterChildren.slice(); },
      undo() { parent.children = beforeChildren.slice(); },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doToggleVisible(layer) {
    const before = layer.visible;
    const after = !before;
    state.commands.push({
      label: 'toggle layer visibility',
      do() { layer.visible = after; },
      undo() { layer.visible = before; },
    });
    markDirty();
  }

  function animationForGroup(group) {
    if (!group?.animationId) return null;
    const sheet = activeSheet();
    return sheet?.animations.find(a => a.id === group.animationId) ?? null;
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
        const oldName = node.name;
        const anim = node.type === 'group' ? animationForGroup(node) : null;
        const oldAnimName = anim?.name;
        state.commands.push({
          label: node.type === 'group' ? 'rename group' : 'rename layer',
          do() {
            node.name = v;
            if (anim) anim.name = v;
          },
          undo() {
            node.name = oldName;
            if (anim) anim.name = oldAnimName;
          },
        });
        markDirty();
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
    const srcLoc = findParent(sheet.layerTree, nodeId);
    const destParent = findGroup(sheet.layerTree, destParentId) ?? sheet.layerTree;
    if (!srcLoc || !destParent) return;

    const srcParent = srcLoc.parent;
    const beforeSrc = srcParent.children.slice();
    const beforeDest = destParent.children.slice();

    moveNode(sheet, nodeId, destParentId, destIndex);

    const afterSrc = srcParent.children.slice();
    const afterDest = destParent.children.slice();

    // Skip if nothing changed.
    if (beforeSrc.length === afterSrc.length && beforeDest.length === afterDest.length &&
        beforeSrc.every((c, i) => c === afterSrc[i]) && beforeDest.every((c, i) => c === afterDest[i])) {
      return;
    }

    state.commands.push({
      label: 'move layer',
      do() {
        srcParent.children = afterSrc.slice();
        destParent.children = afterDest.slice();
      },
      undo() {
        srcParent.children = beforeSrc.slice();
        destParent.children = beforeDest.slice();
      },
    });
    markDirty();
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
    const changed = currentAnimationId() !== animId;
    if (sheet) setSheetSelection(sheet, { layerId: null, animationId: animId });
    if (changed) emit('selection');
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
    const changed = currentAnimationId() !== animId;
    if (sheet) setSheetSelection(sheet, { layerId: layer.id, animationId: animId });
    if (changed) emit('selection');
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
    const fl = state.floating?.sheetId === sheet.id ? state.floating : null;
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
      layer.opacity = Number(opacityInput.value) / 100;
      emit('pixels');
    });
    opacityInput.addEventListener('change', () => {
      if (opacityBefore == null) return;
      const before = opacityBefore, after = layer.opacity;
      opacityBefore = null;
      if (before === after) return;
      state.commands.push({ label: 'layer opacity', do() { layer.opacity = after; }, undo() { layer.opacity = before; } });
      markDirty();
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
      emit('view');
    });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const map = activeMap(), i = map?.layers.indexOf(layer); if (i == null) return;
      const target = e.key === 'ArrowUp' ? i + 1 : i - 1;
      if (target < 0 || target >= map.layers.length) return;
      e.preventDefault(); map.layers.splice(i, 1); map.layers.splice(target, 0, layer); markDirty(); emit('view');
    });
    const spacer = document.createElement('span'); spacer.className = 'tree-spacer leaf-spacer';
    const thumb = document.createElement('canvas'); thumb.className = 'layer-thumb'; thumb.width = LAYER_THUMB_SIZE; thumb.height = LAYER_THUMB_SIZE;
    const tctx = thumb.getContext('2d'); tctx.fillStyle = layer.type === 'tile' ? '#466b9c' : '#8a5b98'; tctx.fillRect(0, 0, thumb.width, thumb.height); tctx.fillStyle = '#fff'; tctx.font = '14px sans-serif'; tctx.textAlign = 'center'; tctx.textBaseline = 'middle'; tctx.fillText(layer.type === 'tile' ? '▦' : '♟', thumb.width / 2, thumb.height / 2);
    const visBtn = document.createElement('button'); visBtn.type = 'button'; visBtn.textContent = layer.visible ? '👁' : '🚫'; visBtn.title = 'Toggle visibility'; visBtn.addEventListener('click', e => { e.stopPropagation(); layer.visible = !layer.visible; markDirty(); emit('view'); });
    const nameEl = document.createElement('span'); nameEl.className = 'layer-name'; nameEl.textContent = layer.name; nameEl.addEventListener('dblclick', e => { e.stopPropagation(); startRename(layer, nameEl); });
    const opacityInput = document.createElement('input'); opacityInput.type = 'range'; opacityInput.min = '0'; opacityInput.max = '100'; opacityInput.value = String(Math.round(layer.opacity * 100)); opacityInput.addEventListener('click', e => e.stopPropagation());
    let before = null; opacityInput.addEventListener('pointerdown', e => { e.stopPropagation(); before = layer.opacity; }); opacityInput.addEventListener('input', () => { layer.opacity = Number(opacityInput.value) / 100; emit('view'); }); opacityInput.addEventListener('change', () => { if (before != null && before !== layer.opacity) state.commands.push({ label:'map layer opacity', do(){layer.opacity=Number(opacityInput.value)/100;markDirty();}, undo(){layer.opacity=before;markDirty();} }); before = null; });
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
    if (state.mode === 'maps') {
      const map = activeMap();
      btnAddLayer.title = 'Add tile layer'; btnAddGroup.title = 'Add sprite layer'; btnMerge.disabled = true;
      if (map) for (let i = map.layers.length - 1; i >= 0; i--) renderMapLayer(map.layers[i]);
      return;
    }
    btnAddLayer.title = 'Add layer'; btnAddGroup.title = 'Add group'; btnMerge.disabled = false;
    const sheet = activeSheet();
    if (!sheet) return;
    syncFromAnimationSelection(sheet);
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
      const fl = state.floating?.sheetId === sheet.id ? state.floating : null;
      if (canvas) drawFit(canvas, (fl && compositeFloatOnLayer(layer.bitmap, fl, layer.id)) || layer.bitmap);
    }
  }
  function scheduleThumbRedraw() {
    if (thumbRedrawQueued) return;
    thumbRedrawQueued = true;
    queueMicrotask(() => { thumbRedrawQueued = false; redrawThumbs(); });
  }

  // sheet.layerTree (bitmap layers: visibility, opacity, groups) is shared
  // by sprite and tile sheets alike -- see activeLayer()/flattenSheet() in
  // state.js/model.js, which never branch on sheet.kind. It's unrelated to
  // sheet.layers (tilemode.js's flat named-tag array for categorizing
  // tiles, mounted separately as the "Tile Layers" panel). Groups only ever
  // gain an animationId via frames.js's commitAcceptAnimation, which is
  // gated to sprite mode, so these actions can never create or touch an
  // animation-owned group on a tile sheet -- no isAvailable gating needed.
  defineAction('layer.add', { label: 'Add Layer', run: doAddLayer, isEnabled: () => !!activeSheet() || (state.mode === 'maps' && !!activeMap()) });
  bindAction(btnAddLayer, 'layer.add');
  defineAction('layer.addGroup', { label: 'Add Group', run: doAddGroup, isEnabled: () => !!activeSheet() || (state.mode === 'maps' && !!activeMap()) });
  bindAction(btnAddGroup, 'layer.addGroup');
  defineAction('layer.delete', { label: 'Delete Layer', run: doDelete, isEnabled: () => !!activeSheet() || (state.mode === 'maps' && !!activeMap()) });
  bindAction(btnDelete, 'layer.delete');
  defineAction('layer.mergeDown', { label: 'Merge Down', run: doMergeDown, isEnabled: () => !!activeSheet() });
  bindAction(btnMerge, 'layer.mergeDown');

  on('project', renderList);
  on('history', renderList);
  on('view', renderList);
  on('selection', renderList);
  on('pixels', scheduleThumbRedraw);
  renderList();
}
