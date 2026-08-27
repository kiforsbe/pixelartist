// js/modes/tiles/presentation/terrain-set-editor.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { markDefaultAction } from '../../../components/dialogs.js';
import { groupCellsByBlobIndex } from '../../../core/terrainsets.js';
import { blobIndexToMask, resolveTerrainSlot, classifySlots, DIRECTION_OFFSETS } from '../../../core/blob47.js';
import { BUILTIN_LAYOUT_PRESETS } from '../../../core/blob47templates.js';
import { tileThumbnailUrl as tileThumbnailURL } from './tile-raster-cache.js';
import { describeMask } from '../application/geometry/autotile-geometry.js';
import { slotGroupsForViewMode } from '../application/geometry/terrain-set-geometry.js';
import { importPresetArtOntoLayer } from '../terrain-preset-art.js';
import {
  getAutotilePaintSession, setAutotilePaintBrush,
  startAutotilePaint, stopAutotilePaint, useAutotilePaintConflict,
} from './autotile-paint-presenter.js';
import { openBlob47Coverage } from './blob47-coverage-dialog.js';

function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}
function sheetDocument(sheet) { return { kind: 'tile-sheet', id: sheet.id }; }
function sheetSelection(sheet) { return getEditorHost().selections.get(sheetDocument(sheet)) ?? {}; }
function setSheetSelection(sheet, patch) {
  getEditorHost().selections.set({ ...sheetSelection(sheet), ...patch }, sheetDocument(sheet));
}
function currentToolId() { return getEditorHost().store.getState().session.activeToolId; }

// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid8x6' | 'grid7x7' | 'sixteen'. Keyed per terrain set
// (not a single shared variable) so switching between two terrain sets
// doesn't leak one's view-mode choice into the other; transient, not
// persisted/exported -- purely a UI nicety, seeded at creation time by
// buildAddTerrainSetDialog's create handler to match whichever built-in
// preset was used.
const terrainSetViewModes = new Map();
function viewModeFor(terrainSetId) {
  return terrainSetViewModes.get(terrainSetId) ?? 'staircase';
}

// previewGeneration guards against a stale image load finishing after a
// newer preset was already selected (switching the <select> quickly starts
// a fresh Image() before the previous one's onload has fired) -- without
// it, the old image can paint over the new one, or at the wrong size.
let previewGeneration = 0;
function drawLayoutPreview(canvas, preset) {
  const myGeneration = ++previewGeneration;
  const cellSize = preset.sourceCellSize ?? 32;
  canvas.width = preset.cols * cellSize;
  canvas.height = preset.rows * cellSize;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const duplicateCells = [];
  for (const cells of groupCellsByBlobIndex(preset.cells).values()) {
    for (let i = 1; i < cells.length; i++) duplicateCells.push(cells[i]);
  }

  const img = new Image();
  img.onload = () => {
    if (myGeneration !== previewGeneration) return; // superseded by a later preset selection
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (!duplicateCells.length) return;
    ctx.save();
    ctx.strokeStyle = '#e0a030';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    for (const cell of duplicateCells) {
      const x = cell.col * cellSize, y = cell.row * cellSize;
      ctx.strokeRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
      const label = 'dup';
      const w = Math.ceil(ctx.measureText(label).width) + 4;
      ctx.fillStyle = 'rgba(90,58,0,.85)';
      ctx.fillRect(x, y, w, 11);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 2, y + 1);
    }
    ctx.restore();
  };
  img.src = preset.sourceImage;
}

export function buildAddTerrainSetDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Add terrain set</h3>
    <div class="row"><label>Name <input type="text" id="ats-name" value="Terrain"></label></div>
    <div class="row"><label>Tile W <input type="number" id="ats-tilew" min="1" value="16"></label></div>
    <div class="row"><label>Tile H <input type="number" id="ats-tileh" min="1" value="16"></label></div>
    <div class="row"><label>Layout <select id="ats-layout"><option value="">(none -- add tiles manually)</option></select></label></div>
    <div class="row"><canvas id="ats-layout-preview" class="terrain-layout-preview" hidden></canvas></div>
    <div class="row dlg-actions"><button type="button" id="ats-create">Create</button><button type="button" id="ats-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let presets = [];
  const updatePreview = () => {
    const preset = presets[Number($('#ats-layout').value)];
    const canvas = $('#ats-layout-preview');
    if (preset?.sourceImage) { canvas.hidden = false; drawLayoutPreview(canvas, preset); }
    else { canvas.hidden = true; }
  };
  $('#ats-layout').addEventListener('change', updatePreview);
  markDefaultAction(dlg, $('#ats-create'));
  $('#ats-cancel').addEventListener('click', () => dlg.close());
  $('#ats-create').addEventListener('click', async () => {
    const sheet = activeSheet('tile');
    if (!sheet) { dlg.close(); return; }
    const intVal = (el) => Math.max(1, parseInt(el.value, 10) || 1);
    const tileW = intVal($('#ats-tilew'));
    const tileH = intVal($('#ats-tileh'));
    const { terrainSetId } = dispatch('tiles.createTerrainSet', {
      sheetId: sheet.id,
      opts: { name: $('#ats-name').value.trim() || 'Terrain', tileW, tileH },
    });
    // No terrain-set list to click any more -- auto-select the new set so
    // the Autotiles panel (and, once a tile exists, the Tiles panel) shows
    // it immediately instead of whatever was selected before.
    setSheetSelection(sheet, { terrainSetId });

    const presetValue = $('#ats-layout').value;
    if (presetValue !== '') {
      const preset = presets[Number(presetValue)];
      const { tiles } = dispatch('tiles.addGrid', {
        sheetId: sheet.id,
        opts: { x: 0, y: 0, cellW: tileW, cellH: tileH, cols: preset.cols, rows: preset.rows },
      });
      const sourceTiles = tiles.slice().sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
      dispatch('tiles.applyTerrainLayoutPreset', {
        sheetId: sheet.id, terrainSetId, preset, sourceTileIds: sourceTiles.map(t => t.id), cols: preset.cols,
      });
      const seededMode = preset.name.includes('8×6') ? 'grid8x6' : preset.name.includes('7×7') ? 'grid7x7' : null;
      if (seededMode) terrainSetViewModes.set(terrainSetId, seededMode);
      setSheetSelection(sheet, { tileId: sourceTiles[0]?.id ?? null });
      await importPresetArtOntoLayer(sheet, preset, sourceTiles, preset.cols);
    } else {
      // No preset -- seed with one standalone (non-grid) tile assigned to
      // the "isolated" slot (blobIndex 0, no neighbors) so the set has at
      // least one referencing tile. A terrain set with zero tiles is what
      // pruneEmptyTerrainSets treats as garbage once any tile/grid deletion
      // elsewhere names it as a candidate.
      dispatch('tiles.createTile', { sheetId: sheet.id, rect: { x: 0, y: 0, w: tileW, h: tileH } });
      const created = sheet.tiles.find(t => t.id === sheetSelection(sheet).tileId);
      if (created) dispatch('tiles.assignTerrainSlot', { sheetId: sheet.id, terrainSetId, blobIndex: 0, tileId: created.id });
    }

    dlg.close();
  });
  return {
    open() {
      const sheet = activeSheet('tile');
      const settings = getEditorHost().projects.project?.settings ?? {};
      $('#ats-tilew').value = String(settings.tileW ?? 16);
      $('#ats-tileh').value = String(settings.tileH ?? 16);

      presets = [...BUILTIN_LAYOUT_PRESETS, ...(sheet?.terrainLayoutPresets ?? [])];
      const layoutSelect = $('#ats-layout');
      layoutSelect.innerHTML = '<option value="">(none -- add tiles manually)</option>';
      presets.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `${p.name} (${p.cols}×${p.rows})`;
        layoutSelect.appendChild(opt);
      });
      updatePreview();

      dlg.showModal();
    },
  };
}

export function buildTilePickerDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'tile-picker-dialog';
  dlg.innerHTML = `
    <h3>Assign tile</h3>
    <div class="tile-picker-header">
      <div class="tile-picker-mask-grid" id="tp-mask"></div>
      <div>
        <div id="tp-desc"></div>
        <div id="tp-badge" class="badge"></div>
      </div>
    </div>
    <div class="tile-picker-grid" id="tp-grid"></div>
    <div class="row dlg-actions"><button type="button" id="tp-clear">Clear</button><button type="button" id="tp-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  let onPick = null, onClear = null;
  $('#tp-cancel').addEventListener('click', () => dlg.close());
  $('#tp-clear').addEventListener('click', () => { onClear?.(); dlg.close(); });

  function buildMaskDiagram(mask) {
    const grid = document.createElement('div');
    grid.className = 'tile-picker-mask-inner';
    for (let row = -1; row <= 1; row++) {
      for (let col = -1; col <= 1; col++) {
        const div = document.createElement('div');
        div.className = 'tile-picker-mask-cell';
        if (row === 0 && col === 0) {
          div.classList.add('center');
        } else {
          const dir = DIRECTION_OFFSETS.find(d => d.dx === col && d.dy === row);
          if (mask & dir.bit) div.classList.add('filled');
        }
        grid.appendChild(div);
      }
    }
    return grid;
  }

  return {
    open(sheet, terrainSet, blobIndex, currentTileId, pick, clear) {
      onPick = pick; onClear = clear;
      const mask = blobIndexToMask[blobIndex];
      const classInfo = classifySlots(terrainSet.symmetry).get(blobIndex);
      $('#tp-desc').textContent = describeMask(mask);
      $('#tp-badge').textContent = classInfo.mandatory ? 'Mandatory' : 'Optional (derivable via symmetry)';

      const maskHost = $('#tp-mask');
      maskHost.innerHTML = '';
      maskHost.appendChild(buildMaskDiagram(mask));

      const grid = $('#tp-grid');
      grid.innerHTML = '';
      sheet.tiles
        .filter(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH)
        .forEach((t, i) => {
          const cell = document.createElement('div');
          cell.className = 'tile-picker-cell';
          if (t.id === currentTileId) cell.classList.add('selected');
          const thumb = document.createElement('div');
          thumb.className = 'tile-picker-thumb';
          thumb.style.backgroundImage = `url(${tileThumbnailURL(sheet, t)})`;
          const label = document.createElement('span');
          label.textContent = t.name ? `${i}: ${t.name}` : `#${i}`;
          cell.append(thumb, label);
          cell.addEventListener('click', () => { onPick?.(t.id); dlg.close(); });
          grid.appendChild(cell);
        });

      dlg.showModal();
    },
  };
}

// Keeps state.selectedTerrainSetId following the selected tile -- there's
// no explicit terrain-set list to click any more (Autotiles panel just
// shows whichever set is "current"), so this is the only way that state
// tracks selection. Any tile selection updates it, INCLUDING clearing it
// back to null (selecting an unrelated standalone/grid tile shouldn't
// leave a stale terrain set showing). Deselecting entirely (tile === null)
// is the one case left untouched: state.selectedTerrainSetId persists so a
// just-created, still-empty terrain set (nothing on the sheet to derive it
// from) stays reachable.
export function syncSelectedTerrainSetFromTile(sheet, tile) {
  if (!tile) return;
  const terrainSetId = tile.terrainSetId ?? null;
  if (sheetSelection(sheet).terrainSetId !== terrainSetId) setSheetSelection(sheet, { terrainSetId });
}

// Shared by the Tiles panel's per-tile detail (when the tile belongs to a
// terrain set) and its terrain-set-only fallback card (a just-created set
// with no tiles assigned yet) -- both need the same Name/Layer/Delete
// controls, just reached via a different selection path.
export function terrainSetNameField(terrainSet) {
  const field = document.createElement('label');
  field.className = 'frame-field';
  field.appendChild(document.createTextNode('Set name'));
  const input = document.createElement('input');
  input.type = 'text';
  input.value = terrainSet.name;
  input.title = 'Name of the whole terrain set (shared by every tile in it) — separate from this tile\'s own name above';
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v) {
      const sheet = activeSheet('tile');
      if (sheet) dispatch('tiles.renameTerrainSet', { sheetId: sheet.id, terrainSetId: terrainSet.id, name: v });
    } else input.value = terrainSet.name;
  });
  field.appendChild(input);
  return field;
}

export function terrainSetLayerField(sheet, terrainSet) {
  const field = document.createElement('label');
  field.className = 'frame-field';
  field.appendChild(document.createTextNode('Layer'));
  const select = document.createElement('select');
  const noneOpt = document.createElement('option'); noneOpt.value = ''; noneOpt.textContent = '(none)';
  select.appendChild(noneOpt);
  sheet.layers.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = terrainSet.layer ?? '';
  select.title = 'Tile Layer for this whole terrain set (shared by every tile in it)';
  select.addEventListener('change', () => dispatch('tiles.setTerrainSetLayer', { sheetId: sheet.id, terrainSetId: terrainSet.id, layer: select.value }));
  field.appendChild(select);
  return field;
}

export function terrainSetDeleteButton(sheet, terrainSet) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-icon-md';
  btn.textContent = '✕';
  btn.title = 'Delete terrain set';
  btn.addEventListener('click', () => {
    dispatch('tiles.deleteTerrainSet', { sheetId: sheet.id, terrainSetId: terrainSet.id });
    if (sheetSelection(sheet).terrainSetId === terrainSet.id) setSheetSelection(sheet, { terrainSetId: null });
  });
  return btn;
}

export function renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog) {
  container.innerHTML = '';

  const painterRow = document.createElement('div');
  painterRow.className = 'row layer-actions';
  const paintSession = getAutotilePaintSession();
  const paintingThisSet = paintSession?.terrainSetId === terrainSet.id && currentToolId() === 'autotilepaint';
  if (!paintingThisSet) {
    const start = document.createElement('button');
    start.type = 'button'; start.className = 'btn-sm'; start.textContent = '🧩 Paint terrain';
    start.title = 'Paint Blob-47 terrain edges and corners directly over the whole tilesheet';
    start.addEventListener('click', () => startAutotilePaint(sheet, terrainSet));
    painterRow.appendChild(start);
  } else {
    const paint = document.createElement('button');
    paint.type = 'button'; paint.className = 'btn-sm'; paint.textContent = 'Paint';
    paint.classList.toggle('active', paintSession.brush === 'paint');
    paint.addEventListener('click', () => { setAutotilePaintBrush('paint'); renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog); });
    const erase = document.createElement('button');
    erase.type = 'button'; erase.className = 'btn-sm'; erase.textContent = 'Erase';
    erase.classList.toggle('active', paintSession.brush === 'erase');
    erase.addEventListener('click', () => { setAutotilePaintBrush('erase'); renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog); });
    const done = document.createElement('button');
    done.type = 'button'; done.className = 'btn-sm'; done.textContent = 'Done';
    done.addEventListener('click', stopAutotilePaint);
    painterRow.append(paint, erase, done);
    const hint = document.createElement('div');
    hint.className = 'frame-field';
    hint.textContent = 'Drag over tile edges and corners. Green = terrain; red = duplicate pattern conflict. Hover a tile for its resolved preview and the full Blob-47 reference map (blue marks the matching pattern).';
    container.appendChild(hint);
    if (paintSession.conflicts.size) {
      const conflicts = document.createElement('div');
      conflicts.className = 'row layer-actions';
      for (const [tileId, blobIndex] of paintSession.conflicts) {
        const tileIndex = sheet.tiles.findIndex(t => t.id === tileId);
        const use = document.createElement('button');
        use.type = 'button'; use.className = 'btn-sm'; use.textContent = `Use #${tileIndex}`;
        use.title = `Replace the existing ${describeMask(blobIndexToMask[blobIndex])} tile with this painted tile`;
        use.addEventListener('click', () => {
          useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex);
          renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
        });
        conflicts.appendChild(use);
      }
      container.appendChild(conflicts);
    }
  }
  container.appendChild(painterRow);
  const coverage = document.createElement('button');
  coverage.type = 'button'; coverage.className = 'btn-sm'; coverage.textContent = '🔎 Blob-47 coverage…';
  coverage.title = 'Open a large reference board showing expected artwork, assigned tiles, and missing shapes';
  coverage.addEventListener('click', () => openBlob47Coverage(sheet, terrainSet));
  container.appendChild(coverage);

  const symRow = document.createElement('div');
  symRow.className = 'row layer-actions';
  const btnFlip = document.createElement('button');
  btnFlip.type = 'button';
  btnFlip.className = 'btn-icon-sm';
  btnFlip.textContent = '↔';
  btnFlip.title = 'Allow flip (derive flipped slots from their mirror instead of requiring explicit art)';
  btnFlip.setAttribute('aria-pressed', String(terrainSet.symmetry.flip));
  btnFlip.classList.toggle('active', terrainSet.symmetry.flip);
  btnFlip.addEventListener('click', () => dispatch('tiles.setTerrainSymmetry', { sheetId: sheet.id, terrainSetId: terrainSet.id, key: 'flip', value: !terrainSet.symmetry.flip }));
  const btnRotate = document.createElement('button');
  btnRotate.type = 'button';
  btnRotate.className = 'btn-icon-sm';
  btnRotate.textContent = '↻';
  btnRotate.title = 'Allow rotation (derive rotated slots instead of requiring explicit art)';
  btnRotate.setAttribute('aria-pressed', String(terrainSet.symmetry.rotate));
  btnRotate.classList.toggle('active', terrainSet.symmetry.rotate);
  btnRotate.addEventListener('click', () => dispatch('tiles.setTerrainSymmetry', { sheetId: sheet.id, terrainSetId: terrainSet.id, key: 'rotate', value: !terrainSet.symmetry.rotate }));

  symRow.append(btnFlip, btnRotate);
  container.appendChild(symRow);

  const viewModeRow = document.createElement('div');
  viewModeRow.className = 'row';
  const viewModeSelect = document.createElement('select');
  [
    ['staircase', 'Staircase'],
    ['grid8x6', 'Grid 8×6'],
    ['grid7x7', 'Grid 7×7'],
    ['sixteen', '16-tile only'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = label;
    viewModeSelect.appendChild(opt);
  });
  viewModeSelect.value = viewModeFor(terrainSet.id);
  viewModeSelect.addEventListener('change', () => {
    terrainSetViewModes.set(terrainSet.id, viewModeSelect.value);
    renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog);
  });
  viewModeRow.appendChild(viewModeSelect);
  container.appendChild(viewModeRow);

  const classification = classifySlots(terrainSet.symmetry);
  for (const group of slotGroupsForViewMode(viewModeFor(terrainSet.id))) {
    const groupRow = document.createElement('div');
    groupRow.className = 'terrain-slot-group';
    for (const blobIndex of group) {
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const isExplicit = terrainSet.slots[blobIndex] != null;
      const classInfo = classification.get(blobIndex);
      const cell = document.createElement('div');
      cell.className = 'terrain-slot';
      cell.classList.add(classInfo.mandatory ? 'mandatory' : 'optional');

      const mask = blobIndexToMask[blobIndex];
      let title = `${describeMask(mask)} — ${classInfo.mandatory ? 'mandatory' : 'optional'}`;
      if (resolved && !isExplicit) title += ` (derived: flipH=${resolved.flipH}, rotate=${resolved.rotate})`;

      if (resolved) {
        const tile = sheet.tiles.find(t => t.id === resolved.tileId);
        if (tile) {
          cell.style.backgroundImage = `url(${tileThumbnailURL(sheet, tile, { flipH: resolved.flipH, flipV: resolved.flipV, rotate: resolved.rotate })})`;
          if (!isExplicit) {
            const icons = [];
            if (resolved.flipH) icons.push('↔');
            if (resolved.flipV) icons.push('↕');
            if (resolved.rotate) icons.push('↻');
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = icons.join(' ');
            cell.appendChild(badge);
          }
          // Some layout presets repeat a blobIndex across multiple physical
          // tiles (js/core/terrainsets.js's applyLayoutPreset picks one as
          // primary); those extras carry duplicateOf pointing back at this
          // cell's tile. Flag it here too, not just on the tile sheet, so
          // this thumbnail explains why identical-looking tiles elsewhere
          // don't do anything when painted on.
          const duplicateCount = sheet.tiles.filter(t => t.duplicateOf === tile.id).length;
          if (duplicateCount > 0) {
            cell.classList.add('has-duplicates');
            title += ` — ${duplicateCount} linked duplicate tile(s) elsewhere on the sheet (safe to ignore)`;
            const dupBadge = document.createElement('span');
            dupBadge.className = 'badge duplicate-badge';
            dupBadge.textContent = `⧉${duplicateCount}`;
            cell.appendChild(dupBadge);
          }
          if (classInfo.mandatory === false && isExplicit) {
            cell.classList.add('removable');
            title += ' — optional: derivable via flip/rotation, safe to clear';
            const optBadge = document.createElement('span');
            optBadge.className = 'badge removable-badge';
            optBadge.textContent = '✓opt';
            cell.appendChild(optBadge);
          }
        }
      }
      cell.title = title;

      cell.addEventListener('click', () => {
        tilePickerDialog.open(sheet, terrainSet, blobIndex, terrainSet.slots[blobIndex] ?? null,
          (tileId) => dispatch('tiles.assignTerrainSlot', { sheetId: sheet.id, terrainSetId: terrainSet.id, blobIndex, tileId }),
          () => dispatch('tiles.clearTerrainSlot', { sheetId: sheet.id, terrainSetId: terrainSet.id, blobIndex, tileId: terrainSet.slots[blobIndex] ?? null }));
      });
      groupRow.appendChild(cell);
    }
    container.appendChild(groupRow);
  }
}
