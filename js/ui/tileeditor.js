// Tile editor: a focused, zoomed-in view of a single tile with a live
// neighbor preview driven by a per-tile "neighbor preset" (js/core/neighbors.js).
// Task 18 — the signature tile feature.
//
// Architecturally this is frameeditor.js's sibling: a SECOND CanvasView,
// mounted once at boot into its own absolutely-positioned child of
// #canvas-host, shown/hidden rather than created/destroyed (CanvasView has
// no teardown and installs window-level key listeners).
//
// Coordinate mapping mirrors frameeditor.js's, with the editor's content
// space being a (2*radius+1) x (2*radius+1) grid of tiles (in tile-sized
// units) rather than a single frame:
//   - Content size = (2*radius+1)*tileW x (2*radius+1)*tileH. The CENTER
//     tile (the one actually being edited) occupies editor-local
//     [radius*tw, radius*tw+tw) x [radius*th, radius*th+th).
//   - mapPoint(x, y) shifts editor-local pointer coords into sheet-global
//     layer-bitmap coords: sheetX = x + r.x - radius*tw (r = centerRect(),
//     the center tile's own rect). getTargetRect() returns r itself, so
//     tools.js's target clipping (Task 13) guarantees strokes can only ever
//     affect the center tile's pixels no matter how far a drag strays into
//     neighbor cells.
//   - view.imageToScreen is overridden the same way frameeditor.js does it:
//     tools.js's marquee selection is stored in sheet-global coords (because
//     of mapPoint), so overlays need to map sheet-global -> screen by
//     inverting the same offset used by mapPoint.
//
// Neighbor cells are NOT separately-edited bitmaps — they are the CURRENT
// pixels of whichever tile resolveNeighborGrid() resolves each cell to,
// redrawn from a flattened-sheet scratch cache every paint (same cache
// pattern as frameeditor.js's getFlatCanvas, invalidated on pixels/project/
// history), which is what makes the preview live while drawing.
//
// Slot clicks (configuring what a neighbor cell shows) vs. drawing strokes
// are routed by geometry alone: a pointerdown INSIDE the center rect starts
// a normal tool stroke (delegated to bindDrawing's onPointer, wrapped);
// a pointerdown OUTSIDE the center rect (anywhere else in the content) is a
// candidate slot click, resolved on pointerup only if the up event lands on
// the same sign-direction cell as the down event (i.e. no drag) — see
// wrapPointer() below.

import { state, on, emit, activeSheet, markDirty } from '../app/state.js';
import { CanvasView } from './canvasview.js';
import { bindDrawing } from './tools.js';
import { flattenSheet } from '../core/model.js';
import { getPreset, setSlot, resolveNeighborGrid } from '../core/neighbors.js';
import { terrainNeighborPreviewCells } from '../core/blob47templates.js';
import { markDefaultAction } from './dialogs.js';

function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!(el.closest && el.closest('dialog[open]'));
}

// Mirrors neighbors.js's private DIR_BY_DELTA table (not exported there) —
// used here only to figure out which slot a clicked cell belongs to.
const DIR_BY_SIGN = {
  '-1,-1': 'nw', '0,-1': 'n', '1,-1': 'ne',
  '-1,0': 'w', '1,0': 'e',
  '-1,1': 'sw', '0,1': 's', '1,1': 'se',
};
function dirForCell(dx, dy) {
  return DIR_BY_SIGN[`${Math.sign(dx)},${Math.sign(dy)}`];
}

const DIR_LABELS = {
  nw: 'Northwest', n: 'North', ne: 'Northeast',
  w: 'West', e: 'East',
  sw: 'Southwest', s: 'South', se: 'Southeast',
};

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
  const opt3 = document.createElement('option'); opt3.value = '1'; opt3.textContent = '3×3';
  const opt5 = document.createElement('option'); opt5.value = '2'; opt5.textContent = '5×5';
  radiusSelect.append(opt3, opt5);
  radiusLabel.append(document.createTextNode('Neighbors '), radiusSelect);

  strip.append(btnBack, nameLabel, terrainLabel, radiusLabel);

  // ---- canvas ----
  const canvasHostDiv = document.createElement('div');
  canvasHostDiv.className = 'tile-editor-canvas';
  container.appendChild(canvasHostDiv);

  const view = new CanvasView(canvasHostDiv);

  let radius = 1; // 1 = 3x3, 2 = 5x5

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
    const r = centerRect();
    if (!t || !r) return { x: 0, y: 0 };
    return { x: r.x - radius * t.w, y: r.y - radius * t.h };
  }

  // See module comment: overlays (marquee selection) are stored in
  // sheet-global coordinates by tools.js because of mapPoint below, so
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
    const off = offset();
    return { x: x + off.x, y: y + off.y };
  }

  bindDrawing(view, getTargetRect, mapPoint, 'tile');

  // ---- flattened-sheet cache (scratch canvas), mirrors frameeditor.js's
  // pattern. Invalidated on 'pixels'/'project'/'history'; rebuilt lazily on
  // next paint — this is what makes the neighbor preview live while drawing.
  let flatSheetRef = null;
  let flatBitmap = null;
  let flatDirty = true;
  function invalidateFlat() { flatDirty = true; }
  function getFlatBitmap(sheet) {
    if (flatDirty || flatSheetRef !== sheet || !flatBitmap) {
      flatBitmap = flattenSheet(sheet, state.floating);
      flatSheetRef = sheet;
      flatDirty = false;
    }
    return flatBitmap;
  }
  let flatCanvas = null;
  let flatCanvasSrc = null;
  function getFlatCanvas(sheet) {
    const bmp = getFlatBitmap(sheet);
    if (flatCanvasSrc !== bmp) {
      if (!flatCanvas || flatCanvas.width !== bmp.width || flatCanvas.height !== bmp.height) {
        flatCanvas = document.createElement('canvas');
        flatCanvas.width = bmp.width;
        flatCanvas.height = bmp.height;
      }
      const c = flatCanvas.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
      flatCanvasSrc = bmp;
    }
    return flatCanvas;
  }

  // Draws `tile`'s current flattened pixels into the neighbor-grid cell at
  // (dx, dy) (tile units relative to center, 0,0 = center), applying flip
  // and (for terrain-set symmetry-derived slots) rotation around that
  // cell's own bounds -- same transform order as tilemode.js's
  // tileThumbnailURL, so a slot previews identically here and in the
  // Autotiles panel. tw/th are the CENTER tile's own size — a
  // differently-sized neighbor's source rect is stretched into it (an
  // accepted, minor visual quirk for mixed-size neighbors; Phase B's terrain
  // sets are the real fix, since a terrain set requires uniform tile size).
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

  function commitSlot(tile, dir, slot) {
    const before = tile.neighbors ? structuredClone(tile.neighbors) : null;
    state.commands.push({
      label: 'edit tile neighbor slot',
      do() { setSlot(tile, dir, slot); },
      undo() { tile.neighbors = before ? structuredClone(before) : undefined; },
    });
    markDirty();
  }

  markDefaultAction(dlg, teOk);
  teCancel.addEventListener('click', () => dlg.close());
  teOk.addEventListener('click', () => {
    const t = currentTile();
    if (!t || !dialogDir) { dlg.close(); return; }
    const mode = teModeRadios.find(r => r.checked)?.value ?? 'same';
    const tileId = mode === 'tile' ? teTileSelect.value : null;
    const slot = { mode, tileId, flipH: teFlipH.checked, flipV: teFlipV.checked };
    commitSlot(t, dialogDir, slot);
    dlg.close();
  });

  // ---- pointer routing: drawing (inside center rect) vs. slot click ----

  // Editor-local cell lookup: returns {dx, dy} (tile units, 0,0 excluded —
  // that's the center) or null when (x, y) is outside the content grid.
  function cellAt(x, y) {
    const t = currentTile();
    if (!t) return null;
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) return null;
    const dx = Math.floor(x / t.w) - radius;
    const dy = Math.floor(y / t.h) - radius;
    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }

  function insideCenter(x, y) {
    const t = currentTile();
    if (!t) return false;
    return x >= radius * t.w && x < radius * t.w + t.w && y >= radius * t.h && y < radius * t.h + t.h;
  }

  const toolPointer = view.onPointer;
  let drawingActive = false;
  let pendingClickDir = null;

  view.onPointer = (ev) => {
    if (ev.type === 'down') {
      if (insideCenter(ev.x, ev.y)) {
        drawingActive = true;
        pendingClickDir = null;
        toolPointer(ev);
      } else {
        drawingActive = false;
        const cell = cellAt(ev.x, ev.y);
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
      const cell = cellAt(ev.x, ev.y);
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
    radius = parseInt(radiusSelect.value, 10) === 2 ? 2 : 1;
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
