// The palette manager dialog.
//
// Non-modal (.show(), not .showModal()) on purpose: picking a color off the
// canvas, drawing a test stroke and watching the palette update all require
// the canvas to stay live underneath. Undo works with a non-modal dialog
// open, so edits made here can be taken back without closing it.
import { getEditorHost } from '../../host/runtime.js';
import { defineAction } from '../shell/actions.js';
import { makeDialogMovable, centerDialog, closeOnEscape, markDefaultAction } from '../../components/dialogs.js';
import { INDEXED_SIZE_PRESETS, createPalette } from '../../core/palettes.js';
import { SYSTEM_PALETTES, clonePalette } from '../../core/systempalettes.js';
import { sheetLayers } from '../../core/model.js';
import { activeSheet } from '../../host/document-helpers.js';
import { exportPalette, importPalette, paletteFromArtwork } from './palette-files.js';
import { armColorSample } from '../../components/canvas/drawing-engine.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { rgbaToHex, hexToRgb } from '../../components/color-utils.js';
import {
  renamePalette, duplicatePalette, deletePalette, createNewPalette,
  addPaletteSwatch, setSwatchColor, remapSwatchColor, countSwatchPixels,
  clearSwatch, removePaletteSwatch, movePaletteSwatch, sortPalette,
  setPaletteLock, setPaletteEmptyColor, setPaletteIndexed,
  nameRamp, deleteRamp,
} from './palette-commands.js';

function host() { return getEditorHost(); }
function services() {
  const h = host();
  return { store: h.store, projects: h.projects, history: h.history };
}
function project() { return host().projects.project; }
function cssColor([r, g, b, a]) { return `rgba(${r},${g},${b},${a / 255})`; }

// Several system palettes already carry their count in the name ("EGA (64)",
// "Commodore Amiga (16)"), so appending one unconditionally produced
// "EGA (64) (64)" in all three dropdowns that list them.
function withCount(name, count) {
  return /\(\d+\)\s*$/.test(name) ? name : `${name} (${count})`;
}

// Module-scoped so the Colors panel's button and the Edit-menu action open
// the same dialog instance rather than each finding it themselves.
let openManager = () => {};
export function openPaletteManager() { openManager(); }

export function mountPaletteManager() {
  const dlg = document.getElementById('dlg-palettes');
  if (!dlg) return;

  const el = id => dlg.querySelector(`#${id}`);
  const list = el('pm-list');
  const name = el('pm-name');
  const lockBadge = el('pm-lock-badge');
  const grid = el('pm-grid');
  const btnClose = el('pm-close');
  const indexed = el('pm-indexed');
  const emptyColor = el('pm-empty-color');
  const lockSize = el('pm-lock-size');
  const lockCustom = el('pm-lock-custom');
  const lockReason = el('pm-lock-reason');
  const fill = el('pm-fill');
  const chip = el('pm-chip');
  const selectionLabel = el('pm-selection-label');
  const emptyState = el('pm-empty-state');
  const btnAdd = el('pm-add');
  const sortSelect = el('pm-sort');
  const rampName = el('pm-ramp-name');
  const rampAdd = el('pm-ramp-add');
  const rampHint = el('pm-ramp-hint');
  const rampList = el('pm-ramp-list');
  const rampEmpty = el('pm-ramp-empty');
  // The six ops that act on the selected swatch, as opposed to Add and Sort,
  // which act on the palette as a whole and live outside the selection bar.
  const selectionOps = ['pm-set', 'pm-pick', 'pm-clear', 'pm-remove', 'pm-left', 'pm-right'].map(el);

  // Selected swatch index within the current palette; -1 for none. Reset
  // whenever the palette changes, since an index means nothing across two
  // different palettes.
  let selected = -1;

  // The pending ramp run as [firstIndex, lastIndex], or null. Shift-clicking
  // a second swatch sets it; any plain click clears it. Reset alongside
  // `selected` whenever the palette changes, for the same reason: a pair of
  // indices means nothing across two different palettes.
  let rampRange = null;

  function current() {
    const proj = project();
    return proj?.palettes.find(p => p.id === proj.activePaletteId) ?? null;
  }

  function refreshList() {
    list.innerHTML = '';
    for (const p of project()?.palettes ?? []) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.lock ? withCount(p.name, p.colors.length) : p.name;
      list.appendChild(o);
    }
    list.value = project()?.activePaletteId ?? '';
  }

  function refreshHeader() {
    const pal = current();
    name.value = pal?.name ?? '';
    name.disabled = !pal;
    indexed.checked = !!pal?.indexed;
    indexed.disabled = !pal;
    emptyColor.value = pal ? rgbaToHex(pal.emptyColor) : '#000000';
    // Only a palette that HAS unset slots can show an unset color, so the
    // control greys out rather than accepting a pick nothing renders.
    emptyColor.disabled = !pal?.empty.includes(true);
    emptyColor.closest('label').title = emptyColor.disabled
      ? 'No unset slots — lock the palette to a size to get some'
      : 'The color an unset slot shows until someone picks one';
    lockSize.disabled = !pal;
    for (const id of ['pm-duplicate', 'pm-delete', 'pm-export']) el(id).disabled = !pal;
    sortSelect.disabled = !pal || pal.colors.length < 2;

    const locked = pal?.lock ?? null;

    // How full the palette is -- the one thing neither the list label nor the
    // Size dropdown says, and the reason this readout earns its place next to
    // the lock badge rather than repeating it.
    if (!pal) fill.textContent = '';
    else if (locked) {
      const used = pal.empty.filter(e => !e).length;
      fill.textContent = `${used} of ${locked.size} set`;
    } else {
      fill.textContent = pal.colors.length === 1 ? '1 color' : `${pal.colors.length} colors`;
    }

    lockBadge.hidden = !locked;
    // A system template's reason IS its name, and the name is already on the
    // list above and in the Name field below -- printing it a third time was
    // the repetition this readout was meant to remove.
    if (locked) lockBadge.textContent = locked.reason && locked.reason !== pal.name ? locked.reason : 'Locked';
    lockReason.value = locked?.reason ?? '';
    // Nothing to give a reason FOR while the palette is free to grow.
    lockReason.disabled = !locked;

    // Reflect the palette's actual size back into the dropdown: prefer a
    // system option whose name matches the recorded reason, then a plain
    // preset, else Custom.
    if (!locked) lockSize.value = '';
    else if (SYSTEM_PALETTES.some(s => s.name === locked.reason && s.colors.length === locked.size)) lockSize.value = `sys:${locked.reason}`;
    else if (INDEXED_SIZE_PRESETS.includes(locked.size)) lockSize.value = String(locked.size);
    else { lockSize.value = 'custom'; lockCustom.value = String(locked.size); }
    // The custom field is a lie whenever the size came from a preset or a
    // system template, so it only exists while it is the thing in control.
    lockCustom.hidden = lockSize.value !== 'custom';
  }

  // Everything the selection bar shows and everything it enables. Split out
  // of refreshGrid so clicking a swatch repaints only this, not 256 cells.
  function refreshSelection() {
    const pal = current();
    const has = !!pal && selected >= 0 && selected < pal.colors.length;
    chip.hidden = !has;
    for (const op of selectionOps) op.disabled = !has;

    if (has) {
      chip.style.background = cssColor(pal.colors[selected]);
      const unset = pal.empty[selected] ? ' · unset' : '';
      selectionLabel.textContent = `${rgbaToHex(pal.colors[selected])} · index ${selected}${unset}`;
      el('pm-left').disabled = selected === 0;
      el('pm-right').disabled = selected === pal.colors.length - 1;
      // Clearing an already-unset slot, or removing one from a locked palette
      // (where Remove IS a clear), would both be no-ops.
      el('pm-clear').disabled = pal.empty[selected];
      el('pm-remove').disabled = !!pal.lock && pal.empty[selected];
    } else {
      selectionLabel.textContent = pal?.colors.length ? 'Select a swatch to edit it' : '';
    }

    btnAdd.disabled = !pal || (!!pal.lock && !pal.empty.includes(true));
    btnAdd.title = btnAdd.disabled && pal?.lock
      ? `Locked to ${pal.lock.size} entries, all of them set — clear one first`
      : 'Append the current primary color';
  }

  function refreshGrid() {
    grid.innerHTML = '';
    const pal = current();
    if (selected >= (pal?.colors.length ?? 0)) selected = -1;
    // A pending run that no longer fits the palette (it shrank, or a lock
    // truncated it) is dropped rather than clamped: half of a shading run is
    // not the run the user marked, and naming it would store a ramp they
    // never chose.
    if (rampRange && rampRange[1] >= (pal?.colors.length ?? 0)) rampRange = null;

    // An empty well with no explanation reads as broken, and the two ways to
    // get one need different answers.
    emptyState.hidden = !!pal?.colors.length;
    if (!pal) emptyState.textContent = 'No palette yet — New… builds one from scratch, a system template, or this sheet’s artwork.';
    else if (!pal.colors.length) emptyState.textContent = 'No swatches yet — add the current color, or lock the palette to a size to get empty slots.';

    pal?.colors.forEach((c, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'pm-swatch';
      if (pal.empty[i]) sw.classList.add('is-empty');
      if (i === selected) sw.classList.add('is-selected');
      sw.style.background = cssColor(c);
      sw.title = `index ${i}${pal.empty[i] ? ' — unset' : ` — ${rgbaToHex(c)}`}`;
      if (rampRange && i >= rampRange[0] && i <= rampRange[1]) sw.classList.add('is-in-ramp');
      sw.addEventListener('click', (ev) => {
        // Shift extends the current selection into a RUN, which is what a
        // ramp is: nameRamp stores an ordered index list, and every ramp
        // detectRamps produces is contiguous. Restricting the UI to a
        // contiguous run keeps it one shift-click instead of a multi-select
        // mode, at the cost of not being able to hand-pick a scattered ramp.
        if (ev.shiftKey && selected >= 0 && selected !== i) {
          rampRange = [Math.min(selected, i), Math.max(selected, i)];
          refreshGrid();
          return;
        }
        // Clicking the selected swatch again deselects, so the ops bar can be
        // put back to "nothing selected" without closing the dialog.
        selected = selected === i ? -1 : i;
        // A plain click starts a new run; leaving the old highlight up while
        // the anchor moved would misreport what "Name ramp" would store.
        rampRange = null;
        for (const cell of grid.children) cell.classList.remove('is-selected', 'is-in-ramp');
        if (selected === i) sw.classList.add('is-selected');
        refreshSelection();
        refreshRamps();
      });
      grid.appendChild(sw);
    });
    refreshSelection();
    refreshRamps();
  }

  // The named-ramp panel: the pending run (from a shift-click) and the list
  // of ramps already stored on this palette.
  //
  // Named ramps are what `ramp-shade` brushes walk when their Ramp control
  // names one; with none named, ramp-shade falls back to detectRamps, which
  // is deliberately conservative and finds nothing at all on some palettes.
  // Naming a run is how you make shading work on those.
  function refreshRamps() {
    const pal = current();
    const ramps = pal?.ramps ?? [];
    const count = rampRange ? rampRange[1] - rampRange[0] + 1 : 0;
    // nameRamp itself refuses a run shorter than two entries; the button
    // must not offer what the command would silently drop.
    const canName = !!pal && count >= 2;
    rampName.disabled = !canName;
    rampAdd.disabled = !canName || !rampName.value.trim();
    rampHint.textContent = canName
      ? `Indices ${rampRange[0]}–${rampRange[1]} · ${count} swatches`
      : 'Shift-click a second swatch to mark a shading run';

    rampList.innerHTML = '';
    rampEmpty.hidden = ramps.length > 0;
    for (const ramp of ramps) {
      const row = document.createElement('div');
      row.className = 'pm-ramp-row';
      const strip = document.createElement('span');
      strip.className = 'pm-ramp-strip';
      // Draws the ramp's ACTUAL colours in its stored order, so a ramp whose
      // palette has since been reordered or shrunk reads as wrong at a glance
      // rather than only failing later at paint time.
      for (const i of ramp.indices) {
        const cell = document.createElement('span');
        cell.className = 'pm-ramp-cell';
        const c = pal.colors[i];
        if (c) cell.style.background = cssColor(c);
        else cell.classList.add('is-missing');
        strip.appendChild(cell);
      }
      const label = document.createElement('span');
      label.className = 'pm-ramp-name';
      label.textContent = ramp.name;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-sm';
      del.textContent = 'Delete';
      del.title = `Delete the ramp “${ramp.name}”`;
      del.addEventListener('click', () => {
        deleteRamp(services(), pal.id, ramp.name);
        refreshRamps();
      });
      row.append(strip, label, del);
      rampList.appendChild(row);
    }
  }

  function refreshAll() {
    refreshList();
    refreshHeader();
    refreshGrid();
  }

  // Populate the lock-size dropdown once: the generic presets, then every
  // system palette's own count, so "lock this to what a NES can show" is a
  // pick rather than a number the user has to look up.
  const noneOpt = document.createElement('option');
  noneOpt.value = ''; noneOpt.textContent = 'Unlocked';
  lockSize.appendChild(noneOpt);
  for (const size of INDEXED_SIZE_PRESETS) {
    const o = document.createElement('option');
    o.value = String(size); o.textContent = String(size);
    lockSize.appendChild(o);
  }
  for (const sys of SYSTEM_PALETTES) {
    const o = document.createElement('option');
    o.value = `sys:${sys.name}`;
    o.textContent = withCount(sys.name, sys.colors.length);
    lockSize.appendChild(o);
  }
  const customOpt = document.createElement('option');
  customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
  lockSize.appendChild(customOpt);

  list.addEventListener('change', () => {
    const proj = project();
    if (!proj) return;
    // Selection is not content: it stays off the undo stack, matching the
    // Colors panel's own palette dropdown.
    proj.activePaletteId = list.value || null;
    host().projects.markDirty();
    selected = -1;
    rampRange = null;
    refreshAll();
  });

  name.addEventListener('change', () => {
    const pal = current();
    if (pal) renamePalette(services(), pal.id, name.value.trim() || pal.name);
  });

  el('pm-duplicate').addEventListener('click', () => {
    const pal = current();
    if (pal) duplicatePalette(services(), pal.id);
  });

  el('pm-delete').addEventListener('click', () => {
    const pal = current();
    if (pal) deletePalette(services(), pal.id);
  });

  // ---- swatch operations ----
  // All of these act on the selected slot, so they no-op without one rather
  // than guessing which swatch the user meant.
  function withSelection(fn) {
    const pal = current();
    if (pal && selected >= 0 && selected < pal.colors.length) fn(pal, selected);
  }

  // The one place that decides between a plain entry edit and a remap that
  // also rewrites pixels. Same rule as the Colors panel's double-click: if
  // the old color is on the active sheet, offer to carry the artwork along.
  function applyColorToSelection(pal, index, to) {
    const old = pal.colors[index];
    const count = pal.empty[index] ? 0 : countSwatchPixels(services(), old);
    if (count === 0) {
      setSwatchColor(services(), pal.id, index, to);
      return;
    }
    if (!confirmOrAuto(`Remap ${count} pixels of old color on active sheet?`)) return;
    remapSwatchColor(services(), pal.id, index, to);
  }

  el('pm-add').addEventListener('click', () => {
    const pal = current();
    if (pal) addPaletteSwatch(services(), pal.id, [...host().store.getState().workspace.drawing.primary]);
  });

  // `input`, not `change`: the Name ramp button's enabled state tracks
  // whether the field is non-empty, and waiting for blur would leave it
  // disabled while a perfectly good name sits typed in front of the user.
  rampName.addEventListener('input', () => refreshRamps());
  rampAdd.addEventListener('click', () => {
    const pal = current();
    const label = rampName.value.trim();
    if (!pal || !rampRange || !label) return;
    const indices = [];
    for (let i = rampRange[0]; i <= rampRange[1]; i++) indices.push(i);
    nameRamp(services(), pal.id, label, indices);
    // Clear the pending run on success so the next shift-click starts fresh,
    // and empty the field so the button does not sit enabled offering to
    // re-name the same run under the same name (which nameRamp would refuse
    // as a no-op anyway).
    rampRange = null;
    rampName.value = '';
    refreshGrid();
  });

  el('pm-set').addEventListener('click', () => withSelection((pal, index) => {
    const input = document.createElement('input');
    input.type = 'color';
    input.style.position = 'absolute';
    input.style.width = '0'; input.style.height = '0';
    input.style.opacity = '0'; input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    input.value = rgbaToHex(pal.colors[index]);
    input.addEventListener('change', () => {
      const [r, g, b] = hexToRgb(input.value);
      document.body.removeChild(input);
      applyColorToSelection(pal, index, [r, g, b, 255]);
    });
    input.click();
  }));

  // One-shot canvas sampler, the same mechanism the chroma-key dialog uses.
  // This is the reason the manager is non-modal: a modal dialog would put
  // the canvas out of reach.
  el('pm-pick').addEventListener('click', () => withSelection((pal, index) => {
    armColorSample(rgba => applyColorToSelection(pal, index, [rgba[0], rgba[1], rgba[2], 255]), () => {});
  }));

  el('pm-clear').addEventListener('click', () => withSelection((pal, index) => clearSwatch(services(), pal.id, index)));

  el('pm-remove').addEventListener('click', () => withSelection((pal, index) => removePaletteSwatch(services(), pal.id, index)));

  // Each command redraws the grid from inside history.execute, so `selected`
  // has to be repainted AFTER the command rather than merely reassigned --
  // otherwise the highlight stays on the index the swatch just left.
  el('pm-left').addEventListener('click', () => withSelection((pal, index) => {
    if (index === 0) return;
    movePaletteSwatch(services(), pal.id, index, index - 1);
    selected = index - 1;
    refreshGrid();
  }));

  el('pm-right').addEventListener('click', () => withSelection((pal, index) => {
    if (index >= pal.colors.length - 1) return;
    movePaletteSwatch(services(), pal.id, index, index + 1);
    selected = index + 1;
    refreshGrid();
  }));

  sortSelect.addEventListener('change', () => {
    const pal = current();
    if (pal && sortSelect.value) sortPalette(services(), pal.id, sortSelect.value);
    sortSelect.value = '';          // it is an action, not a stored setting
    selected = -1;
    // Sorting permutes every index, so a run marked against the old order
    // points at unrelated colours now. The STORED ramps have the same hazard
    // and are a follow-up; this at least does not add a wrong one.
    rampRange = null;
    refreshGrid();
  });

  // ---- palette-level settings ----
  indexed.addEventListener('change', () => {
    const pal = current();
    if (pal) setPaletteIndexed(services(), pal.id, indexed.checked);
  });

  emptyColor.addEventListener('change', () => {
    const pal = current();
    if (!pal) return;
    const [r, g, b] = hexToRgb(emptyColor.value);
    setPaletteEmptyColor(services(), pal.id, [r, g, b, 255]);
  });

  // Reads the size dropdown into { size, reason }. A `sys:` option carries
  // its own reason (the system's name), which is the whole point of picking
  // a size from that list rather than typing the number.
  function chosenLock() {
    const value = lockSize.value;
    if (value === '') return { size: null, reason: '' };
    if (value === 'custom') return { size: Math.max(1, parseInt(lockCustom.value, 10) || 1), reason: lockReason.value.trim() };
    if (value.startsWith('sys:')) {
      const sysName = value.slice(4);
      const sys = SYSTEM_PALETTES.find(s => s.name === sysName);
      return { size: sys?.colors.length ?? 0, reason: sysName };
    }
    return { size: parseInt(value, 10), reason: lockReason.value.trim() };
  }

  function applyLockChoice() {
    const pal = current();
    if (!pal) return;
    const { size, reason } = chosenLock();
    if (size !== null && size < pal.colors.length) {
      const dropped = pal.colors.length - size;
      if (!confirmOrAuto(`Locking to ${size} entries drops the last ${dropped}. Continue?`)) {
        refreshHeader();               // put the dropdown back where it was
        return;
      }
    }
    setPaletteLock(services(), pal.id, size, reason);
    selected = -1;
    rampRange = null;
    refreshGrid();
  }

  lockSize.addEventListener('change', () => {
    // "Custom…" is a request to type a number, not a request to lock to
    // whatever the box happened to be left at -- reveal it and wait.
    if (lockSize.value === 'custom') {
      lockCustom.hidden = false;
      lockReason.disabled = false;
      lockCustom.focus();
      lockCustom.select();
      return;
    }
    // A `sys:` pick supplies its own reason; show it before applying so the
    // user sees what the export will say.
    const { reason } = chosenLock();
    if (reason) lockReason.value = reason;
    applyLockChoice();
  });
  lockCustom.addEventListener('change', () => { if (lockSize.value === 'custom') applyLockChoice(); });
  lockReason.addEventListener('change', () => {
    const pal = current();
    if (pal?.lock) setPaletteLock(services(), pal.id, pal.lock.size, lockReason.value.trim());
  });

  // ---- new palette ----
  const dlgNew = document.getElementById('dlg-palette-new');
  const pnSource = dlgNew.querySelector('#pn-source');
  const pnName = dlgNew.querySelector('#pn-name');
  const pnSystem = dlgNew.querySelector('#pn-system');
  const pnCount = dlgNew.querySelector('#pn-artwork-count');
  for (const sys of SYSTEM_PALETTES) {
    const o = document.createElement('option');
    o.value = sys.name;
    o.textContent = withCount(sys.name, sys.colors.length);
    pnSystem.appendChild(o);
  }
  function refreshNewDialog() {
    dlgNew.querySelector('#pn-system-row').hidden = pnSource.value !== 'system';
    dlgNew.querySelector('#pn-artwork-row').hidden = pnSource.value !== 'artwork';
    dlgNew.querySelector('#pn-name-row').hidden = pnSource.value === 'system';
  }
  pnSource.addEventListener('change', refreshNewDialog);
  markDefaultAction(dlgNew, dlgNew.querySelector('#pn-create'));
  dlgNew.querySelector('#pn-cancel').addEventListener('click', () => dlgNew.close());
  dlgNew.querySelector('#pn-create').addEventListener('click', () => {
    if (!project()) { dlgNew.close(); return; }
    let palette = null;
    if (pnSource.value === 'system') {
      const sys = SYSTEM_PALETTES.find(s => s.name === pnSystem.value);
      // A template-derived palette is locked to its template's count by
      // default, with the system's name as the reason -- that provenance is
      // what makes an export self-evidently a palette for that machine.
      if (sys) palette = clonePalette(sys);
    } else if (pnSource.value === 'artwork') {
      const sheet = activeSheet();
      const bitmaps = sheet ? sheetLayers(sheet).map(l => l.bitmap) : [];
      if (bitmaps.length) {
        palette = paletteFromArtwork(bitmaps, Math.max(0, parseInt(pnCount.value, 10) || 0));
        palette.name = pnName.value.trim() || palette.name;
      }
    } else {
      palette = createPalette({ name: pnName.value.trim() || 'Palette' });
    }
    dlgNew.close();
    if (palette) createNewPalette(services(), palette);
  });
  el('pm-new').addEventListener('click', () => { refreshNewDialog(); dlgNew.showModal(); });

  // ---- import / export ----
  el('pm-import').addEventListener('click', async () => {
    const palette = await importPalette();
    if (palette) createNewPalette(services(), palette);
  });

  el('pm-export').addEventListener('click', async () => {
    const pal = current();
    if (pal) await exportPalette(pal, el('pm-export-format').value);
  });

  makeDialogMovable(dlg, dlg.querySelector('h3'));
  closeOnEscape(dlg, () => dlg.close());
  btnClose.addEventListener('click', () => dlg.close());

  openManager = () => {
    if (dlg.open) return;
    refreshAll();
    dlg.show();
    if (!dlg.style.left) centerDialog(dlg);
  };

  defineAction('edit.palettes', {
    label: 'Palettes…',
    run: openPaletteManager,
    isEnabled: () => !!project(),
  });

  // Redraw on undo/redo and on any project change made elsewhere, the same
  // way color-panel.js does -- the dialog stays open across both.
  host().history.subscribe(() => { if (dlg.open) refreshAll(); });
  host().store.subscribe(s => s.project.model, () => { if (dlg.open) refreshAll(); });

  return { refreshAll };
}
