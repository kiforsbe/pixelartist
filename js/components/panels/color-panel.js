// Color/palette panel.

import { state, on, emit, activeSheet, markDirty, confirmOrAuto } from '../../app/state.js';
import { cloneBitmap, blitRegion } from '../../core/pixels.js';
import { sheetLayers } from '../../core/model.js';
import { createPalette, addSwatch, setEntry, remapColor, INDEXED_SIZE_PRESETS } from '../../core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../../core/systempalettes.js';
import { markDefaultAction } from '../dialogs.js';
import { rgbaToHex, hexToRgb } from '../color-utils.js';

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
    <div class="row dlg-actions"><button id="np-create">Create</button><button id="np-cancel">Cancel</button></div>
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
  markDefaultAction(dlgNew, dlgNew.querySelector('#np-create'));
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
  const sysCloseRow = document.createElement('div'); sysCloseRow.className = 'row dlg-actions';
  const sysCloseBtn = document.createElement('button'); sysCloseBtn.textContent = 'Close';
  sysCloseBtn.addEventListener('click', () => dlgSys.close());
  markDefaultAction(dlgSys, sysCloseBtn);
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
