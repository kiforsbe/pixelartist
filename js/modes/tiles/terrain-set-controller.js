import {
  state, emit, activeSheet, activeLayer, markDirty, confirmOrAuto,
} from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';
import { copyRegion, blitRegion, scaleBitmap } from '../../core/pixels.js';
import { makePixelPatch } from '../../core/commands.js';
import { decodePng } from '../../app/pngcodec.js';
import { markDefaultAction } from '../../ui/dialogs.js';
import { groupCellsByBlobIndex } from '../../core/terrainsets.js';
import {
  NEIGHBOR_BITS, blobIndexToMask, maskToBlobIndex, SIXTEEN_TILE_INDICES,
  resolveTerrainSlot, classifySlots, DIRECTION_OFFSETS,
} from '../../core/blob47.js';
import {
  BLOB47_8X6_RAW, BLOB47_7X7_RAW, BUILTIN_LAYOUT_PRESETS,
} from '../../core/blob47templates.js';
import {
  getTileSheetCanvas as getFlatCanvas,
  tileThumbnailUrl as tileThumbnailURL,
} from './presentation/tile-raster-cache.js';
import {
  getAutotilePaintSession, setAutotilePaintBrush,
  startAutotilePaint, stopAutotilePaint, useAutotilePaintConflict,
  openBlob47Coverage,
} from './autotile-paint-controller.js';
import { addGrid, createTile } from './application/commands/tile-sheet-commands.js';
import {
  commitAddTerrainSet, commitDeleteTerrainSet, commitRenameTerrainSet,
  commitAssignSlot, commitClearSlot, commitSetSymmetry,
  commitApplyLayoutPreset, commitSetTerrainSetLayer,
} from './terrain-set-commands.js';

function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }

// Groups the 47 canonical blob indices by how many of the 8 bits are set
// in their representative mask (the "staircase" layout: isolated alone,
// then single-edge variants, etc, up to the full 8-neighbor surround).
function blobStaircaseGroups() {
  const groups = new Map();
  blobIndexToMask.forEach((mask, blobIndex) => {
    let count = 0;
    for (let b = 1; b <= 128; b <<= 1) if (mask & b) count++;
    if (!groups.has(count)) groups.set(count, []);
    groups.get(count).push(blobIndex);
  });
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, indices]) => indices);
}

// Cosmetic-only arrangement of the same 47 slots in the terrain-set editor
// -- never touches terrainSet.slots or any saved/imported layout preset.
// 'staircase' | 'grid8x6' | 'grid7x7' | 'sixteen'. Keyed per terrain set
// (not a single shared variable) so switching between two terrain sets
// doesn't leak one's view-mode choice into the other; transient, not
// persisted/exported -- purely a UI nicety, seeded at creation time by
// commitAddTerrainSet's caller (see buildAddTerrainSetDialog) to match
// whichever built-in preset was used.
const terrainSetViewModes = new Map();
function viewModeFor(terrainSetId) {
  return terrainSetViewModes.get(terrainSetId) ?? 'staircase';
}

// Mirrors the real reference template's row/col arrangement (not an
// arbitrary ascending-index chunking) so this cosmetic view is a 1:1
// visual match for the actual tilemap when that built-in preset was used
// to fill the slots -- including duplicate cells (e.g. the 7x7 template's
// three "isolated" corners), which render as separate cells for the same
// underlying slot, exactly as they appear in the source tilemap.
function gridFromRawTemplate(rawGrid) {
  return rawGrid.map(rowVals => rowVals.map(raw => maskToBlobIndex[raw]));
}

function slotGroupsForViewMode(mode) {
  if (mode === 'grid8x6') return gridFromRawTemplate(BLOB47_8X6_RAW);
  if (mode === 'grid7x7') return gridFromRawTemplate(BLOB47_7X7_RAW);
  if (mode === 'sixteen') return [[...SIXTEEN_TILE_INDICES].sort((a, b) => a - b)];
  return blobStaircaseGroups();
}

function describeMask(mask) {
  const names = { [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE', [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE', [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW', [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW' };
  const parts = Object.keys(names).filter(b => mask & Number(b)).map(b => names[b]);
  return parts.length ? parts.join(' + ') : 'isolated';
}

// See js/core/blob47templates.js for the raw grids, the built-in preset
// list, and how they're pixel-verified against the bundled reference
// images at assets/blob47-templates/.


// Keeps state.selectedTerrainSetId following the selected tile -- there's
// no explicit terrain-set list to click any more (Autotiles panel just
// shows whichever set is "current"), so this is the only way that state
// tracks selection. Any tile selection updates it, INCLUDING clearing it
// back to null (selecting an unrelated standalone/grid tile shouldn't
// leave a stale terrain set showing). Deselecting entirely (tile === null)
// is the one case left untouched: state.selectedTerrainSetId persists so a
// just-created, still-empty terrain set (nothing on the sheet to derive it
// from) stays reachable.
export function syncSelectedTerrainSetFromTile(tile) {
  if (tile) state.selectedTerrainSetId = tile.terrainSetId ?? null;
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
    if (v) commitRenameTerrainSet(terrainSet, v);
    else input.value = terrainSet.name;
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
  select.addEventListener('change', () => commitSetTerrainSetLayer(terrainSet, select.value));
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
    commitDeleteTerrainSet(sheet, terrainSet.id);
    if (state.selectedTerrainSetId === terrainSet.id) state.selectedTerrainSetId = null;
  });
  return btn;
}


// Paints preset.sourceImage's reference art onto the active paint layer, one
// crop per cell, at the freshly-created sourceTiles' sheet coordinates --
// gives a terrain set real, recognizable slot art immediately instead of
// blank tiles the user has to hand-draw one by one. Only wired into the "Add
// terrain set" creation flow (fresh, definitely-blank tiles); never into
// "import layout" onto an existing grid, which could carry real user art.
async function importPresetArtOntoLayer(sheet, preset, sourceTiles, cols) {
  if (!preset.sourceImage || !sourceTiles.length) return;
  const layer = activeLayer();
  if (!layer) return;

  let refBitmap;
  try {
    const res = await fetch(preset.sourceImage);
    refBitmap = await decodePng(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    console.warn(`Could not import template art from ${preset.sourceImage}: ${e.message}`);
    return;
  }

  const cellSize = preset.sourceCellSize ?? 32;
  const minX = Math.min(...sourceTiles.map(t => t.x));
  const minY = Math.min(...sourceTiles.map(t => t.y));
  const maxX = Math.max(...sourceTiles.map(t => t.x + t.w));
  const maxY = Math.max(...sourceTiles.map(t => t.y + t.h));
  const rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const before = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);

  const alreadyPainted = before.data.some((v, i) => i % 4 === 3 && v !== 0);
  if (alreadyPainted && !confirmOrAuto(
    `"${layer.name}" already has pixels where this grid lands. Overwrite them with the "${preset.name}" reference art?`
  )) return;

  for (const cell of preset.cells) {
    const tile = sourceTiles[cell.row * cols + cell.col];
    if (!tile) continue;
    const cropped = copyRegion(refBitmap, cell.col * cellSize, cell.row * cellSize, cellSize, cellSize);
    const painted = (tile.w === cellSize && tile.h === cellSize) ? cropped : scaleBitmap(cropped, tile.w, tile.h);
    blitRegion(layer.bitmap, painted, tile.x, tile.y);
  }

  const after = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
  state.commands.push(makePixelPatch(layer.bitmap, rect, before, after, 'import terrain layout art'));
  markDirty();
  emit('pixels');
}


// ------------------------------------------------------------- terrain sets

// Same "first cell in raster order wins" rule as applyLayoutPreset (shared
// via groupCellsByBlobIndex) -- draws the preset's reference art, then
// flags every non-primary duplicate cell with the same dashed-orange
// treatment js/ui/overlays.js uses on the tile sheet itself, so the user
// can see which cells will become dead-end duplicates BEFORE creating the
// grid, not just after.
//
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
    const sheet = activeSheet();
    if (!sheet) { dlg.close(); return; }
    const intVal = (el) => Math.max(1, parseInt(el.value, 10) || 1);
    const tileW = intVal($('#ats-tilew'));
    const tileH = intVal($('#ats-tileh'));
    const terrainSet = commitAddTerrainSet(sheet, {
      name: $('#ats-name').value.trim() || 'Terrain',
      tileW, tileH,
    });
    // No terrain-set list to click any more -- auto-select the new set so
    // the Autotiles panel (and, once a tile exists, the Tiles panel) shows
    // it immediately instead of whatever was selected before.
    state.selectedTerrainSetId = terrainSet.id;

    const presetValue = $('#ats-layout').value;
    if (presetValue !== '') {
      const preset = presets[Number(presetValue)];
      const { tiles } = addGrid(services(), sheet.id, { x: 0, y: 0, cellW: tileW, cellH: tileH, cols: preset.cols, rows: preset.rows });
      const sourceTiles = tiles.slice().sort((a, b) => (a.gridRow - b.gridRow) || (a.gridCol - b.gridCol));
      commitApplyLayoutPreset(sheet, terrainSet, preset, sourceTiles, preset.cols);
      const seededMode = preset.name.includes('8×6') ? 'grid8x6' : preset.name.includes('7×7') ? 'grid7x7' : null;
      if (seededMode) terrainSetViewModes.set(terrainSet.id, seededMode);
      state.selectedTileId = sourceTiles[0]?.id ?? null;
      await importPresetArtOntoLayer(sheet, preset, sourceTiles, preset.cols);
    } else {
      // No preset -- seed with one standalone (non-grid) tile assigned to
      // the "isolated" slot (blobIndex 0, no neighbors) so the set has at
      // least one referencing tile. A terrain set with zero tiles is what
      // pruneEmptyTerrainSets treats as garbage once any tile/grid deletion
      // elsewhere names it as a candidate.
      createTile(services(), sheet.id, { x: 0, y: 0, w: tileW, h: tileH });
      const created = sheet.tiles.find(t => t.id === state.selectedTileId);
      if (created) commitAssignSlot(sheet, terrainSet, 0, created);
    }

    emit('selection');
    dlg.close();
  });
  return {
    open() {
      const sheet = activeSheet();
      const settings = state.project?.settings ?? {};
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


export function renderTerrainSetEditor(container, sheet, terrainSet, tilePickerDialog) {
  container.innerHTML = '';

  const painterRow = document.createElement('div');
  painterRow.className = 'row layer-actions';
  const paintSession = getAutotilePaintSession();
  const paintingThisSet = paintSession?.terrainSetId === terrainSet.id && state.tool === 'autotilepaint';
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
  btnFlip.addEventListener('click', () => commitSetSymmetry(terrainSet, 'flip', !terrainSet.symmetry.flip));
  const btnRotate = document.createElement('button');
  btnRotate.type = 'button';
  btnRotate.className = 'btn-icon-sm';
  btnRotate.textContent = '↻';
  btnRotate.title = 'Allow rotation (derive rotated slots instead of requiring explicit art)';
  btnRotate.setAttribute('aria-pressed', String(terrainSet.symmetry.rotate));
  btnRotate.classList.toggle('active', terrainSet.symmetry.rotate);
  btnRotate.addEventListener('click', () => commitSetSymmetry(terrainSet, 'rotate', !terrainSet.symmetry.rotate));

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
          (tileId) => {
            const tile = sheet.tiles.find(t => t.id === tileId);
            if (tile) commitAssignSlot(sheet, terrainSet, blobIndex, tile);
          },
          () => {
            const owner = sheet.tiles.find(t => t.id === terrainSet.slots[blobIndex]);
            commitClearSlot(terrainSet, blobIndex, owner);
          });
      });
      groupRow.appendChild(cell);
    }
    container.appendChild(groupRow);
  }
}
