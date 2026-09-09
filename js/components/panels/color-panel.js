// Color/palette panel.

import { getEditorHost } from '../../host/runtime.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { mountStorePanel } from '../panel-mount.js';
import { addPaletteSwatch, setSwatchColor, remapSwatchColor, countSwatchPixels }
  from '../../features/palettes/palette-commands.js';
import { openPaletteManager } from '../../features/palettes/palette-manager.js';
import { rgbaToHex, hexToRgb } from '../color-utils.js';

// The palette command family takes the host's services directly -- palettes
// are project-level, so there is no mode registry to route through.
function services() {
  const host = getEditorHost();
  return { store: host.store, projects: host.projects, history: host.history };
}

function drawingSettings() { return getEditorHost().store.getState().workspace.drawing; }
function updateDrawingSettings(patch) { getEditorHost().store.updateDrawingSettings(patch); }

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

    function getColor() { return drawingSettings()[slot]; }
    function setColor(c) { updateDrawingSettings({ [slot]: c }); }
    function sync() { const c = getColor(); swatchColor.style.background = cssColor(c); alpha.value = String(c[3]); }

    swatch.addEventListener('click', () => { colorInput.value = rgbaToHex(getColor()); colorInput.click(); });
    colorInput.addEventListener('input', () => {
      const [r, g, b] = hexToRgb(colorInput.value);
      setColor([r, g, b, getColor()[3]]);
      sync();
    });
    alpha.addEventListener('input', () => {
      const c = getColor();
      setColor([c[0], c[1], c[2], Number(alpha.value)]);
      sync();
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
  const btnManage = document.createElement('button');
  btnManage.type = 'button';
  btnManage.textContent = 'Manage…';
  btnManage.title = 'Open the palette manager';
  const btnAddSwatch = document.createElement('button');
  btnAddSwatch.textContent = '+';
  btnAddSwatch.title = 'Add current color';
  paletteActions.append(btnManage, btnAddSwatch);
  palettePanel.appendChild(paletteActions);

  const swatchStrip = document.createElement('div');
  swatchStrip.className = 'palette-strip';
  palettePanel.appendChild(swatchStrip);

  function currentPalette() {
    const proj = getEditorHost().projects.project;
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
    const proj = getEditorHost().projects.project;
    for (const p of proj?.palettes ?? []) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.indexed ? `${p.name} (${p.colors.length})` : p.name;
      paletteSelect.appendChild(o);
    }
    paletteSelect.value = proj?.activePaletteId ?? '';
  }

  // Decides WHICH command to run (a plain edit vs. a remap that also rewrites
  // pixels) and how many pixels a remap would touch. The commands themselves
  // are in js/features/palettes/palette-commands.js, shared by every mode --
  // this used to dispatch mode-scoped ids, which is why editing a swatch in
  // maps mode did nothing at all.
  function editSwatch(pal, index) {
    const old = pal.colors[index];
    const paletteId = pal.id;
    const input = hiddenColorInput();
    document.body.appendChild(input);
    input.value = rgbaToHex(old);
    input.addEventListener('change', () => {
      const [r, g, b] = hexToRgb(input.value);
      const to = [r, g, b, 255];
      document.body.removeChild(input);
      if (r === old[0] && g === old[1] && b === old[2]) return;

      const count = countSwatchPixels(services(), old);
      if (count === 0) {
        setSwatchColor(services(), paletteId, index, to);
        return;
      }
      if (!confirmOrAuto(`Remap ${count} pixels of old color on active sheet?`)) return;
      remapSwatchColor(services(), paletteId, index, to);
    });
    input.click();
  }

  function refreshSwatchStrip() {
    swatchStrip.innerHTML = '';
    const pal = currentPalette();
    // A locked palette can still take a swatch while it has an empty slot;
    // only a full one has nowhere to put it.
    btnAddSwatch.style.display = (pal && (!pal.lock || pal.empty.includes(true))) ? '' : 'none';
    if (!pal) return;
    pal.colors.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = pal.empty[i] ? 'palette-swatch is-empty' : 'palette-swatch';
      sw.style.background = cssColor(c);
      sw.title = pal.lock ? `index ${i}` : '';
      sw.addEventListener('click', () => { updateDrawingSettings({ primary: [...c] }); primaryEditor.sync(); });
      sw.addEventListener('contextmenu', (e) => { e.preventDefault(); updateDrawingSettings({ secondary: [...c] }); secondaryEditor.sync(); });
      // Every palette is editable now, not just indexed ones.
      sw.addEventListener('dblclick', () => editSwatch(pal, i));
      swatchStrip.appendChild(sw);
    });
  }

  paletteSelect.addEventListener('change', () => {
    const proj = getEditorHost().projects.project;
    if (!proj) return;
    proj.activePaletteId = paletteSelect.value || null;
    getEditorHost().projects.markDirty();
    refreshSwatchStrip();
  });

  // No markDirty()/refresh calls around the palette commands below:
  // HistoryService marks the project dirty on every do()/undo()/redo(), and
  // this panel already redraws from that same notification (see
  // disposeHistory at the bottom of the file).
  btnAddSwatch.addEventListener('click', () => {
    const pal = currentPalette();
    if (!pal) return;
    addPaletteSwatch(services(), pal.id, [...drawingSettings().primary]);
  });

  btnManage.addEventListener('click', () => openPaletteManager());

  function refreshAll() {
    refreshPaletteSelect();
    refreshSwatchStrip();
    primaryEditor.sync();
    secondaryEditor.sync();
  }

  // History-driven redraws (the palette commands above, undo/redo of any of
  // them) reach refreshAll through
  // HistoryService's own onChange, which fires on every do()/undo()/redo()
  // regardless of which store selector (if any) the underlying project
  // mutation happens to touch -- same reasoning as layers-panel.js's own
  // disposeHistory.
  const disposeHistory = getEditorHost().history.subscribe(() => refreshAll());
  mountStorePanel(getEditorHost().store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeDocument,
    s => s.workspace.drawing,
  ], refreshAll, {
    onDispose() {
      disposeHistory();
    },
  });
}
