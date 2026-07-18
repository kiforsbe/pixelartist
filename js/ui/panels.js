// Color/palette panel and layers panel.

import { state, on, emit, activeSheet, activeLayer, markDirty, confirmOrAuto } from '../app/state.js';
import { commitDeleteAnimation } from './timeline.js';
import { cloneBitmap, blitRegion } from '../core/pixels.js';
import { addLayer, addGroup, removeLayer, removeGroup, moveLayer, mergeDown, findNode, findParent, sheetLayers, flattenLayers, findGroup, findLayer, createLayerNode, createGroupNode, moveNode } from '../core/model.js';
import { compositeFloatOnLayer } from '../core/floating.js';
import { createPalette, addSwatch, setEntry, remapColor, INDEXED_SIZE_PRESETS } from '../core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../core/systempalettes.js';
import { defineAction, bindAction } from '../app/actions.js';

function rgbaToHex([r, g, b]) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function cssColor([r, g, b, a]) {
  return `rgba(${r},${g},${b},${a / 255})`;
}
function hiddenColorInput() {
  const input = document.createElement('input');
  input.type = 'color';
  input.style.position = 'absolute';
  input.style.width = '0'; input.style.height = '0';
  input.style.opacity = '0'; input.style.pointerEvents = 'none';
  return input;
}
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

// Draws `bmp` into `canvas` nearest-neighbor, scaled to fit (contain) and
// centered — same behavior as timeline.js's drawFit, applied here to
// per-layer thumbnails.
function drawFit(canvas, bmp) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bmp || bmp.width === 0 || bmp.height === 0) return;
  const tmp = getScratchCanvas(bmp.width, bmp.height);
  tmp.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * scale));
  const dh = Math.max(1, Math.round(bmp.height * scale));
  const dx = Math.floor((canvas.width - dw) / 2);
  const dy = Math.floor((canvas.height - dh) / 2);
  ctx.drawImage(tmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh);
}

// ------------------------------------------------------------- color panel

export function mountColorPanel(el) {
  resetBody(el, 'Colors');

  function buildSwatchEditor(slot) {
    const row = document.createElement('div');
    row.className = 'row swatch-edit-row';
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch checkerboard';
    const swatchColor = document.createElement('span');
    swatchColor.className = 'swatch-color';
    swatch.appendChild(swatchColor);
    const colorInput = hiddenColorInput();
    const alpha = document.createElement('input');
    alpha.type = 'range'; alpha.min = '0'; alpha.max = '255';

    function getColor() { return slot === 'primary' ? state.primary : state.secondary; }
    function setColor(c) { if (slot === 'primary') state.primary = c; else state.secondary = c; }
    function sync() { const c = getColor(); swatchColor.style.background = cssColor(c); alpha.value = String(c[3]); }

    swatch.addEventListener('click', () => { colorInput.value = rgbaToHex(getColor()); colorInput.click(); });
    colorInput.addEventListener('input', () => {
      const [r, g, b] = hexToRgb(colorInput.value);
      setColor([r, g, b, getColor()[3]]);
      sync(); emit('colors');
    });
    alpha.addEventListener('input', () => {
      const c = getColor();
      setColor([c[0], c[1], c[2], Number(alpha.value)]);
      sync(); emit('colors');
    });

    row.append(swatch, colorInput, alpha);
    sync();
    return { row, sync };
  }

  const primaryEditor = buildSwatchEditor('primary');
  const secondaryEditor = buildSwatchEditor('secondary');
  el.append(primaryEditor.row, secondaryEditor.row);

  // ---- Palette panel (separate section) ----
  const palettePanel = document.createElement('div');
  palettePanel.className = 'palette-section';
  el.appendChild(palettePanel);

  const paletteHeader = document.createElement('h3');
  paletteHeader.textContent = 'Palette';
  palettePanel.appendChild(paletteHeader);

  const paletteActions = document.createElement('div');
  paletteActions.className = 'row palette-actions';

  const paletteSelect = document.createElement('select');
  const btnNewPalette = document.createElement('button');
  btnNewPalette.type = 'button';
  btnNewPalette.textContent = '+';
  btnNewPalette.title = 'New palette';
  const btnSystemPalette = document.createElement('button');
  btnSystemPalette.type = 'button';
  btnSystemPalette.textContent = '⚙';
  btnSystemPalette.title = 'System palettes';
  const btnAddSwatch = document.createElement('button');
  btnAddSwatch.textContent = '+';
  btnAddSwatch.title = 'Add current color';
  paletteActions.append(btnNewPalette, btnSystemPalette, btnAddSwatch);
  palettePanel.appendChild(paletteActions);

  const swatchStrip = document.createElement('div');
  swatchStrip.className = 'palette-strip';
  palettePanel.appendChild(swatchStrip);

  function currentPalette() {
    const proj = state.project;
    return proj?.palettes.find(p => p.id === proj.activePaletteId) ?? null;
  }

  const selectRow = document.createElement('div');
  selectRow.className = 'row palette-select-row';
  selectRow.appendChild(paletteSelect);
  palettePanel.insertBefore(selectRow, swatchStrip);

  function refreshPaletteSelect() {
    paletteSelect.innerHTML = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = '(none)';
    paletteSelect.appendChild(none);
    for (const p of state.project?.palettes ?? []) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.indexed ? `${p.name} (${p.colors.length})` : p.name;
      paletteSelect.appendChild(o);
    }
    paletteSelect.value = state.project?.activePaletteId ?? '';
  }

  function countColor(bmp, c) {
    let n = 0;
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4)
      if (d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2] && d[i + 3] === c[3]) n++;
    return n;
  }

  function allSheetLayers() {
    const sheet = activeSheet();
    return sheet ? sheetLayers(sheet) : [];
  }

  function editIndexedEntry(pal, index) {
    const old = pal.colors[index];
    const input = hiddenColorInput();
    document.body.appendChild(input);
    input.value = rgbaToHex(old);
    input.addEventListener('change', () => {
      const [r, g, b] = hexToRgb(input.value);
      const to = [r, g, b, 255];
      document.body.removeChild(input);
      if (r === old[0] && g === old[1] && b === old[2]) return;

      const sheet = activeSheet();
      let count = 0;
      if (sheet) for (const layer of sheetLayers(sheet)) count += countColor(layer.bitmap, old);

      // `old` references the original entry array; setEntry() replaces the
      // slot with a fresh copy, so `old` stays valid for undo.
      if (count === 0) {
        state.commands.push({
          label: 'edit palette color',
          do() { setEntry(pal, index, to); },
          undo() { setEntry(pal, index, old); },
        });
        markDirty();
        refreshSwatchStrip();
        return;
      }
      if (!confirmOrAuto(`Remap ${count} pixels of old color on active sheet?`)) return;

      // The palette-entry mutation lives INSIDE the command so undo restores
      // both the pixels AND the palette color. commands.push() executes do(),
      // so nothing is pre-applied here.
      const layerPatches = sheetLayers(sheet).map(layer => {
        const before = cloneBitmap(layer.bitmap);
        const after = cloneBitmap(layer.bitmap);
        remapColor(after, old, to);
        return { bitmap: layer.bitmap, before, after };
      });
      state.commands.push({
        label: 'remap palette color',
        do() {
          setEntry(pal, index, to);
          for (const lp of layerPatches) blitRegion(lp.bitmap, lp.after, 0, 0);
        },
        undo() {
          setEntry(pal, index, old);
          for (const lp of layerPatches) blitRegion(lp.bitmap, lp.before, 0, 0);
        },
      });
      markDirty();
      refreshSwatchStrip();
    });
    input.click();
  }

  function refreshSwatchStrip() {
    swatchStrip.innerHTML = '';
    const pal = currentPalette();
    btnAddSwatch.style.display = (pal && !pal.indexed) ? '' : 'none';
    if (!pal) return;
    pal.colors.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'palette-swatch';
      sw.style.background = cssColor(c);
      sw.title = pal.indexed ? `index ${i}` : '';
      sw.addEventListener('click', () => { state.primary = [...c]; primaryEditor.sync(); emit('colors'); });
      sw.addEventListener('contextmenu', (e) => { e.preventDefault(); state.secondary = [...c]; secondaryEditor.sync(); emit('colors'); });
      if (pal.indexed) sw.addEventListener('dblclick', () => editIndexedEntry(pal, i));
      swatchStrip.appendChild(sw);
    });
  }

  paletteSelect.addEventListener('change', () => {
    if (!state.project) return;
    state.project.activePaletteId = paletteSelect.value || null;
    markDirty();
    refreshSwatchStrip();
  });

  btnAddSwatch.addEventListener('click', () => {
    const pal = currentPalette();
    if (!pal || pal.indexed) return;
    addSwatch(pal, state.primary);
    markDirty();
    refreshSwatchStrip();
  });

  // ---- New palette dialog ----
  const dlgNew = document.createElement('dialog');
  dlgNew.innerHTML = `
    <h3>New Palette</h3>
    <div class="row"><label>Name <input type="text" id="np-name" value="Palette"></label></div>
    <div class="row"><label><input type="checkbox" id="np-indexed"> Indexed</label></div>
    <div class="row"><label>Size preset <select id="np-preset"></select></label></div>
    <div class="row"><label>Custom size <input type="number" id="np-custom" min="1" max="256" value="16"></label></div>
    <div class="row"><button id="np-create">Create</button><button id="np-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlgNew);
  const npName = dlgNew.querySelector('#np-name');
  const npIndexed = dlgNew.querySelector('#np-indexed');
  const npPreset = dlgNew.querySelector('#np-preset');
  const npCustom = dlgNew.querySelector('#np-custom');
  for (const sz of INDEXED_SIZE_PRESETS) {
    const o = document.createElement('option'); o.value = String(sz); o.textContent = String(sz);
    npPreset.appendChild(o);
  }
  const customOpt = document.createElement('option'); customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
  npPreset.appendChild(customOpt);
  dlgNew.querySelector('#np-cancel').addEventListener('click', () => dlgNew.close());
  dlgNew.querySelector('#np-create').addEventListener('click', () => {
    if (!state.project) { dlgNew.close(); return; }
    const indexed = npIndexed.checked;
    let size = 0;
    if (indexed) size = npPreset.value === 'custom' ? Math.max(1, parseInt(npCustom.value, 10) || 1) : parseInt(npPreset.value, 10);
    const p = createPalette({ name: npName.value.trim() || 'Palette', indexed, size });
    state.project.palettes.push(p);
    state.project.activePaletteId = p.id;
    dlgNew.close();
    markDirty();
    refreshPaletteSelect();
    refreshSwatchStrip();
  });
  btnNewPalette.addEventListener('click', () => dlgNew.showModal());

  // ---- System palettes dialog ----
  const dlgSys = document.createElement('dialog');
  dlgSys.className = 'sys-dialog';
  dlgSys.appendChild(Object.assign(document.createElement('h3'), { textContent: 'System Palettes' }));
  const sysList = document.createElement('div'); sysList.className = 'sys-list';
  for (const sys of SYSTEM_PALETTES) {
    // The whole card is the click target (clone-on-click) -- a <button>
    // so it's focusable/keyboard-activatable for free, no nested controls.
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'sys-palette-card';
    card.title = `Click to add "${sys.name}" to your project`;

    const header = document.createElement('div'); header.className = 'sys-palette-header';
    header.textContent = `${sys.name} (${sys.colors.length})`;
    card.appendChild(header);

    const preview = document.createElement('div'); preview.className = 'sys-palette-preview';
    sys.colors.forEach((c) => {
      const sw = document.createElement('span');
      sw.className = 'sys-palette-swatch';
      sw.style.background = cssColor(c);
      preview.appendChild(sw);
    });
    card.appendChild(preview);

    card.addEventListener('click', () => {
      if (!state.project) return;
      const p = clonePalette(sys);
      state.project.palettes.push(p);
      state.project.activePaletteId = p.id;
      dlgSys.close();
      markDirty();
      refreshPaletteSelect();
      refreshSwatchStrip();
    });

    sysList.appendChild(card);
  }
  dlgSys.appendChild(sysList);
  const sysCloseRow = document.createElement('div'); sysCloseRow.className = 'row';
  const sysCloseBtn = document.createElement('button'); sysCloseBtn.textContent = 'Close';
  sysCloseBtn.addEventListener('click', () => dlgSys.close());
  sysCloseRow.appendChild(sysCloseBtn);
  dlgSys.appendChild(sysCloseRow);
  document.body.appendChild(dlgSys);
  btnSystemPalette.addEventListener('click', () => dlgSys.showModal());

  function refreshAll() {
    refreshPaletteSelect();
    refreshSwatchStrip();
    primaryEditor.sync();
    secondaryEditor.sync();
  }
  on('project', refreshAll);
  on('history', refreshAll);
  on('colors', () => { primaryEditor.sync(); secondaryEditor.sync(); });
  refreshAll();
}

// ------------------------------------------------------------- layers panel

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

  // Selected node can be a layer or a group. Active layer id is authoritative
  // for drawing; selected node id is authoritative for panel operations.
  let selectedNodeId = state.activeLayerId;

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
    const sheet = activeSheet();
    const group = targetGroupForInsert();
    if (!sheet || !group) return;
    const beforeChildren = group.children.slice();
    const beforeActive = state.activeLayerId;
    let newLayer = null;
    const cmd = {
      label: 'add layer',
      do() {
        if (!newLayer) newLayer = createLayerNode(`Layer ${countNodes(sheet, 'layer') + 1}`, sheet.width, sheet.height);
        if (!group.children.includes(newLayer)) group.children.push(newLayer);
        state.activeLayerId = newLayer.id;
        selectedNodeId = newLayer.id;
      },
      undo() {
        group.children = beforeChildren.slice();
        state.activeLayerId = beforeActive;
        selectedNodeId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doAddGroup() {
    const sheet = activeSheet();
    const group = targetGroupForInsert();
    if (!sheet || !group) return;
    const beforeChildren = group.children.slice();
    const beforeActive = state.activeLayerId;
    let newGroup = null;
    const cmd = {
      label: 'add group',
      do() {
        if (!newGroup) newGroup = createGroupNode(`Group ${countNodes(sheet, 'group') + 1}`);
        if (!group.children.includes(newGroup)) group.children.push(newGroup);
        selectedNodeId = newGroup.id;
        state.activeLayerId = null;
      },
      undo() {
        group.children = beforeChildren.slice();
        selectedNodeId = beforeChildren[beforeChildren.length - 1]?.id ?? null;
        state.activeLayerId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doDelete() {
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
      const beforeActive = state.activeLayerId;
      const idx = loc.index;
      const cmd = {
        label: 'delete layer',
        do() {
          parent.children = parent.children.filter(c => c.id !== layer.id);
          const all = sheetLayers(sheet);
          const fallback = all[Math.min(idx, all.length - 1)];
          state.activeLayerId = fallback ? fallback.id : null;
          selectedNodeId = state.activeLayerId;
        },
        undo() {
          parent.children = beforeChildren.slice();
          state.activeLayerId = beforeActive;
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
          // commitDeleteAnimation lives in timeline.js and has no knowledge
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
        const beforeActive = state.activeLayerId;
        const cmd = {
          label: 'delete group',
          do() {
            parent.children = parent.children.filter(c => c.id !== g.id);
            selectedNodeId = state.activeLayerId;
          },
          undo() {
            parent.children = beforeChildren.slice();
            selectedNodeId = g.id;
            state.activeLayerId = beforeActive;
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
    const beforeActive = state.activeLayerId;
    const destBefore = cloneBitmap(dest.bitmap);
    mergeDown(sheet, layer.id);
    const destAfter = cloneBitmap(dest.bitmap);
    const afterChildren = parent.children.slice();
    state.activeLayerId = dest.id;
    const afterActive = dest.id;
    const cmd = {
      label: 'merge down',
      do() {
        blitRegion(dest.bitmap, destAfter, 0, 0);
        parent.children = afterChildren.slice();
        state.activeLayerId = afterActive;
        selectedNodeId = afterActive;
      },
      undo() {
        parent.children = beforeChildren.slice();
        blitRegion(dest.bitmap, destBefore, 0, 0);
        state.activeLayerId = beforeActive;
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
  // timeline dock, so the two panels stay in sync.
  function selectGroupNode(group) {
    selectedNodeId = group.id;
    state.activeLayerId = null;
    if (group.animationId) { state.selectedAnimationId = group.animationId; emit('selection'); }
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
    row.className = 'layer-row layer-leaf' + (layer.id === state.activeLayerId ? ' active' : '');
    row.style.paddingLeft = (4 + depth * 14) + 'px';
    row.draggable = true;
    row.dataset.nodeId = layer.id;
    row.tabIndex = 0;
    row.addEventListener('dragstart', (e) => onRowDragStart(e, layer));
    row.addEventListener('dragend', onRowDragEnd);
    row.addEventListener('click', () => { state.activeLayerId = layer.id; selectedNodeId = layer.id; renderList(); });
    row.addEventListener('keydown', (e) => {
      if (layer.id !== state.activeLayerId) return;
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
      scheduleNameSelect(() => { state.activeLayerId = layer.id; selectedNodeId = layer.id; });
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

  function renderNode(node, depth) {
    if (node.type === 'group') renderGroup(node, depth);
    else renderLayer(node, depth);
  }

  function renderList() {
    list.innerHTML = '';
    thumbCanvases.clear();
    const sheet = activeSheet();
    if (!sheet) return;
    if (selectedNodeId && !findNode(sheet.layerTree, selectedNodeId)) {
      selectedNodeId = state.activeLayerId;
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

  defineAction('layer.add', { label: 'Add Layer', run: doAddLayer, isEnabled: () => !!activeSheet() });
  bindAction(btnAddLayer, 'layer.add');
  defineAction('layer.addGroup', { label: 'Add Group', run: doAddGroup, isEnabled: () => !!activeSheet() });
  bindAction(btnAddGroup, 'layer.addGroup');
  defineAction('layer.delete', { label: 'Delete Layer', run: doDelete, isEnabled: () => !!activeSheet() });
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
