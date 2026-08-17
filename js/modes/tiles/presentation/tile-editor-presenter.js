// js/modes/tiles/presentation/tile-editor-presenter.js
//
// Tile editor: a focused, zoomed-in view of a single tile with a live
// neighbor preview driven by a per-tile "neighbor preset" (core/neighbors.js).
//
// Architecturally this is frameeditor.js's sibling (see sprites mode's
// frame-editor-presenter.js): a SECOND CanvasView, mounted once at boot into
// its own absolutely-positioned child of #canvas-host, shown/hidden rather
// than created/destroyed (CanvasView has no teardown and installs
// window-level key listeners).
//
// Coordinate mapping mirrors frame-editor-presenter.js's, with the editor's
// content space being a (2*radius+1) x (2*radius+1) grid of tiles (in
// tile-sized units) rather than a single frame:
//   - Content size = (2*radius+1)*tileW x (2*radius+1)*tileH. The CENTER
//     tile (the one actually being edited) occupies editor-local
//     [radius*tw, radius*tw+tw) x [radius*th, radius*th+th).
//   - mapPoint(x, y) shifts editor-local pointer coords into sheet-global
//     layer-bitmap coords via application/geometry/tile-editor-geometry.js's
//     pure offset math. getTargetRect() returns the center tile's own rect,
//     so drawing-engine.js's target clipping guarantees strokes can only ever affect
//     the center tile's pixels no matter how far a drag strays into
//     neighbor cells.
//   - view.imageToScreen is overridden the same way frame-editor-presenter.js
//     does it: drawing-engine.js's marquee selection is stored in sheet-global coords
//     (because of mapPoint), so overlays need to map sheet-global -> screen
//     by inverting the same offset used by mapPoint.
//
// Neighbor cells are NOT separately-edited bitmaps -- they are the CURRENT
// pixels of whichever tile resolveNeighborGrid() resolves each cell to,
// redrawn from a flattened-sheet scratch cache every paint (same cache
// pattern as tile-raster-cache.js), which is what makes the preview live
// while drawing.
//
// Slot clicks (configuring what a neighbor cell shows) vs. drawing strokes
// are routed by geometry alone: a pointerdown INSIDE the center rect starts
// a normal tool stroke (delegated to bindDrawing's onPointer, wrapped); a
// pointerdown OUTSIDE the center rect (anywhere else in the content) is a
// candidate slot click, resolved on pointerup only if the up event lands on
// the same sign-direction cell as the down event (i.e. no drag) -- see
// wrapped view.onPointer below.

import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { CanvasView } from '../../../components/canvas/canvas-view.js';
import { bindDrawing } from '../../../components/canvas/drawing-engine.js';
import { flattenSheet } from '../../../core/model.js';
import { getPreset, resolveNeighborGrid } from '../../../core/neighbors.js';
import { terrainNeighborPreviewCells } from '../../../core/blob47templates.js';
import { markDefaultAction } from '../../../components/dialogs.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import {
  dirForCell, DIR_LABELS, computeOffset, mapEditorPoint, cellAt, insideCenter,
} from '../application/geometry/tile-editor-geometry.js';

function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

export function mountTileEditor(hostEl) {
  const container = document.createElement('div');
  container.className = 'tile-editor';
  hostEl.appendChild(container);

  // ---- top strip ----
  const strip = document.createElement('div');
  strip.className = 'tile-editor-strip';
  container.appendChild(strip);

  const btnBack = document.createElement('button');
  btnBack.type = 'button'; btnBack.className = 'btn-icon-md'; btnBack.textContent = '⬅'; btnBack.title = 'Back to sheet';

  const nameLabel = document.createElement('span');
  nameLabel.className = 'tile-editor-name';

  const terrainLabel = document.createElement('span');
  terrainLabel.className = 'tile-editor-terrain-label';
  terrainLabel.hidden = true;

  const radiusLabel = document.createElement('label');
  radiusLabel.className = 'tile-editor-radius';
  const radiusSelect = document.createElement('select');
  const opt1 = document.createElement('option'); opt1.value = '0'; opt1.textContent = '1×1 (off)';
  const opt3 = document.createElement('option'); opt3.value = '1'; opt3.textContent = '3×3';
  const opt5 = document.createElement('option'); opt5.value = '2'; opt5.textContent = '5×5';
  radiusSelect.append(opt1, opt3, opt5);
  radiusLabel.append(document.createTextNode('Neighbors '), radiusSelect);

  strip.append(btnBack, nameLabel, terrainLabel, radiusLabel);

  // ---- canvas ----
  const canvasHostDiv = document.createElement('div');
  canvasHostDiv.className = 'tile-editor-canvas';
  container.appendChild(canvasHostDiv);

  const view = new CanvasView(canvasHostDiv);

  let radius = 1; // 0 = 1x1 (off), 1 = 3x3, 2 = 5x5

  function currentTile() {
    const sheet = activeSheet();
    if (!sheet) return null;
    const id = state.editingTileId;
    if (!id) return null;
    return sheet.tiles.find(t => t.id === id) ?? null;
  }

  // Sheet-global rect of the tile currently being edited, or null.
  function centerRect() {
    const t = currentTile();
    return t ? { x: t.x, y: t.y, w: t.w, h: t.h } : null;
  }

  function offset() {
    const t = currentTile();
    if (!t) return { x: 0, y: 0 };
    return computeOffset(t, radius);
  }

  // See module comment: overlays (marquee selection) are stored in
  // sheet-global coordinates by drawing-engine.js because of mapPoint below, so
  // imageToScreen needs to subtract the editor's offset before zoom/pan.
  view.imageToScreen = (x, y) => {
    const off = offset();
    return { x: (x - off.x) * view.zoom + view.panX, y: (y - off.y) * view.zoom + view.panY };
  };

  function getTargetRect() {
    const r = centerRect();
    return r ?? { x: 0, y: 0, w: 0, h: 0 };
  }

  function mapPoint(x, y) {
    return mapEditorPoint(offset(), x, y);
  }

  bindDrawing(view, getTargetRect, mapPoint, 'tile');

  // ---- flattened-sheet cache (scratch canvas), shared with
  // sprites mode's identical pattern via raster-cache.js. Invalidated on
  // 'pixels'/'project'/'history'; rebuilt lazily on next paint -- this is
  // what makes the neighbor preview live while drawing.
  const flatCache = createRasterCache();
  function invalidateFlat() { flatCache.invalidate(); }
  function getFlatCanvas(sheet) { return flatCache.getCanvas(sheet, s => flattenSheet(s, state.floating)); }

  // Draws `tile`'s current flattened pixels into the neighbor-grid cell at
  // (dx, dy) (tile units relative to center, 0,0 = center), applying flip
  // and (for terrain-set symmetry-derived slots) rotation around that
  // cell's own bounds -- same transform order as tilemode.js's
  // tileThumbnailURL, so a slot previews identically here and in the
  // Autotiles panel. tw/th are the CENTER tile's own size -- a
  // differently-sized neighbor's source rect is stretched into it (an
  // accepted, minor visual quirk for mixed-size neighbors; terrain sets are
  // the real fix, since a terrain set requires uniform tile size).
  function drawTileCell(ctx, flatCanvasEl, tile, dx, dy, flipH, flipV, tw, th, rotate = 0) {
    const destX = (dx + radius) * tw;
    const destY = (dy + radius) * th;
    ctx.save();
    ctx.translate(destX, destY);
    ctx.translate(flipH ? tw : 0, flipV ? th : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (rotate) {
      ctx.translate(tw / 2, th / 2);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(-tw / 2, -th / 2);
    }
    ctx.drawImage(flatCanvasEl, tile.x, tile.y, tile.w, tile.h, 0, 0, tw, th);
    ctx.restore();
  }

  view.onPaint = (ctx) => {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    const tw = t.w, th = t.h;
    const flat = getFlatCanvas(sheet);
    let cells;
    if (t.terrainSetId != null) {
      const ts = sheet.terrainSets.find(x => x.id === t.terrainSetId);
      cells = ts ? terrainNeighborPreviewCells(t, ts) : [];
    } else {
      cells = resolveNeighborGrid(getPreset(t), t.id, radius);
    }

    ctx.save();
    ctx.globalAlpha = 0.85;
    for (const cell of cells) {
      if (cell.tileId == null) continue;
      const nb = sheet.tiles.find(x => x.id === cell.tileId);
      if (!nb) continue;
      drawTileCell(ctx, flat, nb, cell.dx, cell.dy, cell.flipH, cell.flipV, tw, th, cell.rotate);
    }
    ctx.restore();

    // center tile, full alpha, never flipped
    drawTileCell(ctx, flat, t, 0, 0, false, false, tw, th);
  };

  view.onOverlay = (ctx) => {
    const sheet = activeSheet();
    const r = centerRect();
    if (!sheet || !r) return;
    const p0 = view.imageToScreen(r.x, r.y);
    const p1 = view.imageToScreen(r.x + r.w, r.y + r.h);
    ctx.save();
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 2;
    ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    ctx.restore();
  };

  // ---- slot config dialog ----

  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Neighbor slot: <span id="te-slot-dir"></span></h3>
    <div class="row"><label><input type="radio" name="te-mode" value="same"> Same tile (mirrors center)</label></div>
    <div class="row"><label><input type="radio" name="te-mode" value="tile"> Other tile</label></div>
    <div class="row"><label><input type="radio" name="te-mode" value="empty"> Empty</label></div>
    <div class="row"><label>Tile <select id="te-tile-select"></select></label></div>
    <div class="row"><label><input type="checkbox" id="te-fliph"> Flip H</label></div>
    <div class="row"><label><input type="checkbox" id="te-flipv"> Flip V</label></div>
    <div class="row dlg-actions"><button type="button" id="te-ok">OK</button><button type="button" id="te-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const teDirSpan = dlg.querySelector('#te-slot-dir');
  const teTileSelect = dlg.querySelector('#te-tile-select');
  const teFlipH = dlg.querySelector('#te-fliph');
  const teFlipV = dlg.querySelector('#te-flipv');
  const teOk = dlg.querySelector('#te-ok');
  const teCancel = dlg.querySelector('#te-cancel');
  const teModeRadios = [...dlg.querySelectorAll('input[name="te-mode"]')];

  function setMode(mode) {
    for (const r of teModeRadios) r.checked = r.value === mode;
    teTileSelect.disabled = mode !== 'tile';
  }
  for (const r of teModeRadios) r.addEventListener('change', () => setMode(r.value));

  let dialogDir = null;

  function openSlotDialog(dir) {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t || t.terrainSetId != null) return;
    dialogDir = dir;
    const slot = getPreset(t)[dir];
    teDirSpan.textContent = `${DIR_LABELS[dir]} (${dir})`;
    setMode(slot.mode);
    teTileSelect.innerHTML = '';
    sheet.tiles.forEach((other, i) => {
      const opt = document.createElement('option');
      opt.value = other.id;
      opt.textContent = other.name ? `${i}: ${other.name}` : `#${i}`;
      teTileSelect.appendChild(opt);
    });
    teTileSelect.value = (slot.mode === 'tile' && slot.tileId != null) ? slot.tileId : t.id;
    teFlipH.checked = slot.flipH;
    teFlipV.checked = slot.flipV;
    dlg.showModal();
  }

  markDefaultAction(dlg, teOk);
  teCancel.addEventListener('click', () => dlg.close());
  teOk.addEventListener('click', () => {
    const t = currentTile();
    const sheet = activeSheet();
    if (!t || !sheet || !dialogDir) { dlg.close(); return; }
    const mode = teModeRadios.find(r => r.checked)?.value ?? 'same';
    const tileId = mode === 'tile' ? teTileSelect.value : null;
    const slot = { mode, tileId, flipH: teFlipH.checked, flipV: teFlipV.checked };
    dispatch('tiles.setTileNeighborSlot', { sheetId: sheet.id, tileId: t.id, dir: dialogDir, slot });
    dlg.close();
  });

  // ---- pointer routing: drawing (inside center rect) vs. slot click ----

  function cellAtPoint(x, y) {
    const t = currentTile();
    return t ? cellAt(t, radius, view.width, view.height, x, y) : null;
  }

  function insideCenterPoint(x, y) {
    const t = currentTile();
    return t ? insideCenter(t, radius, x, y) : false;
  }

  const toolPointer = view.onPointer;
  let drawingActive = false;
  let pendingClickDir = null;

  view.onPointer = (ev) => {
    if (ev.type === 'down') {
      if (insideCenterPoint(ev.x, ev.y)) {
        drawingActive = true;
        pendingClickDir = null;
        toolPointer(ev);
      } else {
        drawingActive = false;
        const cell = cellAtPoint(ev.x, ev.y);
        pendingClickDir = cell ? dirForCell(cell.dx, cell.dy) : null;
      }
      return;
    }
    if (drawingActive) {
      toolPointer(ev);
      if (ev.type === 'up') drawingActive = false;
      return;
    }
    if (ev.type === 'up' && pendingClickDir) {
      const cell = cellAtPoint(ev.x, ev.y);
      const upDir = cell ? dirForCell(cell.dx, cell.dy) : null;
      if (upDir && upDir === pendingClickDir) openSlotDialog(pendingClickDir);
      pendingClickDir = null;
    }
    // move events outside the center rect: no drag preview needed for slot clicks.
  };

  // ---- top strip wiring ----

  function updateStrip() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) { nameLabel.textContent = ''; return; }
    const idx = sheet.tiles.indexOf(t);
    nameLabel.textContent = t.name ? `Tile ${idx} (${t.name})` : `Tile ${idx}`;
    radiusSelect.value = String(radius);
    if (t.terrainSetId != null) {
      const ts = sheet.terrainSets.find(x => x.id === t.terrainSetId);
      terrainLabel.textContent = ts ? `Terrain: ${ts.name} — neighbors follow the terrain set automatically` : '';
      terrainLabel.hidden = !ts;
    } else {
      terrainLabel.hidden = true;
    }
  }

  radiusSelect.addEventListener('change', () => {
    const v = parseInt(radiusSelect.value, 10);
    radius = (v === 0 || v === 2) ? v : 1;
    loadContent();
    view.requestRender();
  });

  function backToSheet() {
    state.view = 'sheet';
    emit('view');
  }
  btnBack.addEventListener('click', backToSheet);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.view !== 'tile') return;
    if (document.querySelector('dialog[open]')) return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    backToSheet();
  });

  // ---- content sizing / recentering ----

  let loadedTileId = null;
  let loadedRadius = null;

  function loadContent() {
    const sheet = activeSheet();
    const t = currentTile();
    if (!sheet || !t) return;
    view.setContent({ width: (2 * radius + 1) * t.w, height: (2 * radius + 1) * t.h });
    view.centerFit();
    loadedTileId = t.id;
    loadedRadius = radius;
  }

  // ---- visibility ----

  let visible = false;
  let lastCssW = 0, lastCssH = 0;

  function refresh() {
    const t = currentTile();
    if (!t) {
      hide();
      if (state.view === 'tile') { state.view = 'sheet'; state.editingTileId = null; emit('view'); }
      return;
    }
    if (loadedTileId !== t.id || loadedRadius !== radius) loadContent();
    updateStrip();
    view.requestRender();
  }

  function show() {
    const wasHidden = !visible;
    container.style.display = 'flex';
    visible = true;
    if (wasHidden) {
      view._resize();
      if (loadedTileId != null && (view.cssWidth !== lastCssW || view.cssHeight !== lastCssH)) {
        view.centerFit();
      }
    }
    refresh();
  }
  function hide() {
    lastCssW = view.cssWidth;
    lastCssH = view.cssHeight;
    container.style.display = 'none';
    visible = false;
  }

  on('project', () => { invalidateFlat(); if (visible) refresh(); });
  on('history', () => { invalidateFlat(); if (visible) refresh(); });
  on('pixels', () => { invalidateFlat(); if (visible) view.requestRender(); });
  on('selection', () => { if (visible) view.requestRender(); });

  return { show, hide, view };
}
