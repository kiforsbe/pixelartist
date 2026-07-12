// Color/palette panel and layers panel.

import { state, on, emit, activeSheet, activeLayer, markDirty } from '../app/state.js';
import { cloneBitmap, blitRegion } from '../core/pixels.js';
import { addLayer, removeLayer, moveLayer, mergeDown } from '../core/model.js';
import { createPalette, addSwatch, setEntry, remapColor, INDEXED_SIZE_PRESETS } from '../core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../core/systempalettes.js';

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

// ------------------------------------------------------------- color panel

export function mountColorPanel(el) {
  resetBody(el, 'Colors');

  function buildSwatchEditor(slot) {
    const row = document.createElement('div');
    row.className = 'row swatch-edit-row';
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    const colorInput = hiddenColorInput();
    const alpha = document.createElement('input');
    alpha.type = 'range'; alpha.min = '0'; alpha.max = '255';

    function getColor() { return slot === 'primary' ? state.primary : state.secondary; }
    function setColor(c) { if (slot === 'primary') state.primary = c; else state.secondary = c; }
    function sync() { const c = getColor(); swatch.style.background = cssColor(c); alpha.value = String(c[3]); }

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

  // palette selector + new/system dialogs
  const paletteRow = document.createElement('div');
  paletteRow.className = 'row';
  const paletteSelect = document.createElement('select');
  const btnNewPalette = document.createElement('button'); btnNewPalette.textContent = 'New palette…';
  const btnSystemPalette = document.createElement('button'); btnSystemPalette.textContent = 'System…';
  paletteRow.append(paletteSelect, btnNewPalette, btnSystemPalette);
  el.appendChild(paletteRow);

  const swatchStrip = document.createElement('div');
  swatchStrip.className = 'palette-strip';
  el.appendChild(swatchStrip);

  const addRow = document.createElement('div'); addRow.className = 'row';
  const btnAddSwatch = document.createElement('button'); btnAddSwatch.textContent = '+ Add current color';
  addRow.appendChild(btnAddSwatch);
  el.appendChild(addRow);

  function currentPalette() {
    const proj = state.project;
    return proj?.palettes.find(p => p.id === proj.activePaletteId) ?? null;
  }

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
      if (sheet) for (const layer of sheet.layers) count += countColor(layer.bitmap, old);

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
      if (!confirm(`Remap ${count} pixels of old color on active sheet?`)) return;

      // The palette-entry mutation lives INSIDE the command so undo restores
      // both the pixels AND the palette color. commands.push() executes do(),
      // so nothing is pre-applied here.
      const layerPatches = sheet.layers.map(layer => {
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
  dlgSys.appendChild(Object.assign(document.createElement('h3'), { textContent: 'System Palettes' }));
  const sysList = document.createElement('div'); sysList.className = 'sys-list';
  for (const sys of SYSTEM_PALETTES) {
    const row = document.createElement('div'); row.className = 'row';
    row.appendChild(Object.assign(document.createElement('span'), { textContent: `${sys.name} (${sys.colors.length})` }));
    const cloneBtn = document.createElement('button'); cloneBtn.textContent = 'Clone';
    cloneBtn.addEventListener('click', () => {
      if (!state.project) return;
      const p = clonePalette(sys);
      state.project.palettes.push(p);
      state.project.activePaletteId = p.id;
      dlgSys.close();
      markDirty();
      refreshPaletteSelect();
      refreshSwatchStrip();
    });
    row.appendChild(cloneBtn);
    sysList.appendChild(row);
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
  list.className = 'layer-list';
  el.appendChild(list);

  const btnRow = document.createElement('div'); btnRow.className = 'row';
  const btnAdd = document.createElement('button'); btnAdd.textContent = 'Add';
  const btnDelete = document.createElement('button'); btnDelete.textContent = 'Delete';
  const btnMerge = document.createElement('button'); btnMerge.textContent = 'Merge Down';
  btnRow.append(btnAdd, btnDelete, btnMerge);
  el.appendChild(btnRow);

  function doAddLayer() {
    const sheet = activeSheet();
    if (!sheet) return;
    const beforeLayers = sheet.layers.slice();
    const beforeActive = state.activeLayerId;
    let newLayer = null;
    const cmd = {
      label: 'add layer',
      do() {
        if (!newLayer) newLayer = addLayer(sheet, `Layer ${sheet.layers.length + 1}`);
        else if (!sheet.layers.includes(newLayer)) sheet.layers.push(newLayer);
        state.activeLayerId = newLayer.id;
      },
      undo() {
        sheet.layers = beforeLayers.slice();
        state.activeLayerId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doDeleteLayer() {
    const sheet = activeSheet();
    const layer = activeLayer();
    if (!sheet || !layer) return;
    if (sheet.layers.length <= 1) { alert('Cannot delete the last layer.'); return; }
    if (!confirm(`Delete layer "${layer.name}"?`)) return;
    const beforeLayers = sheet.layers.slice();
    const beforeActive = state.activeLayerId;
    const idx = sheet.layers.indexOf(layer);
    const cmd = {
      label: 'delete layer',
      do() {
        removeLayer(sheet, layer.id);
        const fallback = sheet.layers[Math.min(idx, sheet.layers.length - 1)];
        state.activeLayerId = fallback ? fallback.id : null;
      },
      undo() {
        sheet.layers = beforeLayers.slice();
        state.activeLayerId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doMergeDown() {
    const sheet = activeSheet();
    const layer = activeLayer();
    if (!sheet || !layer) return;
    const idx = sheet.layers.indexOf(layer);
    if (idx <= 0) { alert('Cannot merge the bottom layer down.'); return; }
    const dest = sheet.layers[idx - 1];
    const beforeLayers = sheet.layers.slice();
    const beforeActive = state.activeLayerId;
    const destBefore = cloneBitmap(dest.bitmap);
    mergeDown(sheet, layer.id);
    const destAfter = cloneBitmap(dest.bitmap);
    const afterLayers = sheet.layers.slice();
    state.activeLayerId = dest.id;
    const afterActive = dest.id;
    const cmd = {
      label: 'merge down',
      do() {
        blitRegion(dest.bitmap, destAfter, 0, 0);
        sheet.layers = afterLayers.slice();
        state.activeLayerId = afterActive;
      },
      undo() {
        sheet.layers = beforeLayers.slice();
        blitRegion(dest.bitmap, destBefore, 0, 0);
        state.activeLayerId = beforeActive;
      },
    };
    state.commands.push(cmd);
    markDirty();
  }

  function doMove(layer, toIndex) {
    const sheet = activeSheet();
    if (!sheet) return;
    const beforeLayers = sheet.layers.slice();
    moveLayer(sheet, layer.id, toIndex);
    const afterLayers = sheet.layers.slice();
    const cmd = {
      label: 'reorder layers',
      do() { sheet.layers = afterLayers.slice(); },
      undo() { sheet.layers = beforeLayers.slice(); },
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

  function startRename(layer, nameEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = layer.name;
    input.className = 'layer-rename-input';
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    function commit() {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (v && v !== layer.name) {
        const oldName = layer.name;
        state.commands.push({
          label: 'rename layer',
          do() { layer.name = v; },
          undo() { layer.name = oldName; },
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

  function renderList() {
    list.innerHTML = '';
    const sheet = activeSheet();
    if (!sheet) return;
    // topmost layer (last in array, composited last / on top) shown first
    for (let idx = sheet.layers.length - 1; idx >= 0; idx--) {
      const layer = sheet.layers[idx];
      const row = document.createElement('div');
      row.className = 'layer-row' + (layer.id === state.activeLayerId ? ' active' : '');
      row.addEventListener('click', () => { state.activeLayerId = layer.id; renderList(); });

      const visBtn = document.createElement('button');
      visBtn.type = 'button';
      visBtn.textContent = layer.visible ? '👁' : '🚫';
      visBtn.title = 'Toggle visibility';
      visBtn.addEventListener('click', (e) => { e.stopPropagation(); doToggleVisible(layer); });

      const nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      nameEl.textContent = layer.name;
      nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(layer, nameEl); });

      const opacityInput = document.createElement('input');
      opacityInput.type = 'range'; opacityInput.min = '0'; opacityInput.max = '100';
      opacityInput.value = String(Math.round(layer.opacity * 100));
      opacityInput.addEventListener('click', (e) => e.stopPropagation());
      let opacityBefore = null;
      opacityInput.addEventListener('pointerdown', () => { opacityBefore = layer.opacity; });
      opacityInput.addEventListener('input', () => {
        layer.opacity = Number(opacityInput.value) / 100;
        emit('pixels'); // live preview only, no undo step / panel rebuild yet
      });
      opacityInput.addEventListener('change', () => {
        if (opacityBefore == null) return;
        const before = opacityBefore, after = layer.opacity;
        opacityBefore = null;
        if (before === after) return;
        state.commands.push({ label: 'layer opacity', do() { layer.opacity = after; }, undo() { layer.opacity = before; } });
        markDirty();
      });

      const upBtn = document.createElement('button'); upBtn.type = 'button'; upBtn.textContent = '↑';
      upBtn.title = 'Move up'; upBtn.disabled = idx === sheet.layers.length - 1;
      upBtn.addEventListener('click', (e) => { e.stopPropagation(); doMove(layer, idx + 1); });

      const downBtn = document.createElement('button'); downBtn.type = 'button'; downBtn.textContent = '↓';
      downBtn.title = 'Move down'; downBtn.disabled = idx === 0;
      downBtn.addEventListener('click', (e) => { e.stopPropagation(); doMove(layer, idx - 1); });

      row.append(visBtn, nameEl, opacityInput, upBtn, downBtn);
      list.appendChild(row);
    }
  }

  btnAdd.addEventListener('click', doAddLayer);
  btnDelete.addEventListener('click', doDeleteLayer);
  btnMerge.addEventListener('click', doMergeDown);

  on('project', renderList);
  on('history', renderList);
  renderList();
}
