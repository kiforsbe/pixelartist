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
//     layer-bitmap coords: sheetX = x + r.x - radius*tw (r = tileRect of the
//     center tile). getTargetRect() returns r itself, so tools.js's target
//     clipping (Task 13) guarantees strokes can only ever affect the center
//     tile's pixels no matter how far a drag strays into neighbor cells.
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
import { flattenSheet, tileRect, tileCount } from '../core/model.js';
import { getPreset, setSlot, resolveNeighborGrid } from '../core/neighbors.js';

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
  btnBack.type = 'button'; btnBack.textContent = '← Back to sheet';

  const nameLabel = document.createElement('span');
  nameLabel.className = 'tile-editor-name';

  const radiusLabel = document.createElement('label');
  radiusLabel.className = 'tile-editor-radius';
  const radiusSelect = document.createElement('select');
  const opt3 = document.createElement('option'); opt3.value = '1'; opt3.textContent = '3×3';
  const opt5 = document.createElement('option'); opt5.value = '2'; opt5.textContent = '5×5';
  radiusSelect.append(opt3, opt5);
  radiusLabel.append(document.createTextNode('Neighbors '), radiusSelect);

  strip.append(btnBack, nameLabel, radiusLabel);

  // ---- canvas ----
  const canvasHostDiv = document.createElement('div');
  canvasHostDiv.className = 'tile-editor-canvas';
  container.appendChild(canvasHostDiv);

  const view = new CanvasView(canvasHostDiv);

  let radius = 1; // 1 = 3x3, 2 = 5x5

  function currentTileIndex() {
    const sheet = activeSheet();
    if (!sheet || !sheet.tile) return null;
    const t = state.editingTileIndex;
    if (t == null || t < 0 || t >= tileCount(sheet)) return null;
    return t;
  }

  // Sheet-global rect of the tile currently being edited, or null.
  function centerRect() {
    const sheet = activeSheet();
    const t = currentTileIndex();
    if (!sheet || t == null) return null;
    return tileRect(sheet, t);
  }

  function offset() {
    const sheet = activeSheet();
    const r = centerRect();
    if (!sheet || !r) return { x: 0, y: 0 };
    return { x: r.x - radius * sheet.tile.tileWidth, y: r.y - radius * sheet.tile.tileHeight };
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

  bindDrawing(view, getTargetRect, mapPoint);

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

  // Draws tileIndex's current flattened pixels into the neighbor-grid cell
  // at (dx, dy) (tile units relative to center, 0,0 = center), applying
  // flips around that cell's own bounds.
  function drawTileCell(ctx, flatCanvasEl, sheet, tileIndex, dx, dy, flipH, flipV, tw, th) {
    const src = tileRect(sheet, tileIndex);
    const destX = (dx + radius) * tw;
    const destY = (dy + radius) * th;
    ctx.save();
    ctx.translate(destX + (flipH ? tw : 0), destY + (flipV ? th : 0));
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(flatCanvasEl, src.x, src.y, src.w, src.h, 0, 0, tw, th);
    ctx.restore();
  }

  view.onPaint = (ctx) => {
    const sheet = activeSheet();
    const t = currentTileIndex();
    if (!sheet || t == null) return;
    const tw = sheet.tile.tileWidth, th = sheet.tile.tileHeight;
    const flat = getFlatCanvas(sheet);
    const count = tileCount(sheet);
    const preset = getPreset(sheet, t);
    const cells = resolveNeighborGrid(preset, t, radius);

    ctx.save();
    ctx.globalAlpha = 0.85;
    for (const cell of cells) {
      if (cell.tileIndex == null || cell.tileIndex < 0 || cell.tileIndex >= count) continue;
      drawTileCell(ctx, flat, sheet, cell.tileIndex, cell.dx, cell.dy, cell.flipH, cell.flipV, tw, th);
    }
    ctx.restore();

    // center tile, full alpha, never flipped
    drawTileCell(ctx, flat, sheet, t, 0, 0, false, false, tw, th);
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
    <div class="row"><label>Tile index <input type="number" id="te-tileindex" min="0" value="0"></label></div>
    <div class="row"><label><input type="checkbox" id="te-fliph"> Flip H</label></div>
    <div class="row"><label><input type="checkbox" id="te-flipv"> Flip V</label></div>
    <div class="row"><button type="button" id="te-ok">OK</button><button type="button" id="te-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const teDirSpan = dlg.querySelector('#te-slot-dir');
  const teTileIndex = dlg.querySelector('#te-tileindex');
  const teFlipH = dlg.querySelector('#te-fliph');
  const teFlipV = dlg.querySelector('#te-flipv');
  const teOk = dlg.querySelector('#te-ok');
  const teCancel = dlg.querySelector('#te-cancel');
  const teModeRadios = [...dlg.querySelectorAll('input[name="te-mode"]')];

  function setMode(mode) {
    for (const r of teModeRadios) r.checked = r.value === mode;
    teTileIndex.disabled = mode !== 'tile';
  }
  for (const r of teModeRadios) r.addEventListener('change', () => setMode(r.value));

  let dialogDir = null;

  function openSlotDialog(dir) {
    const sheet = activeSheet();
    const t = currentTileIndex();
    if (!sheet || t == null) return;
    dialogDir = dir;
    const slot = getPreset(sheet, t)[dir];
    teDirSpan.textContent = `${DIR_LABELS[dir]} (${dir})`;
    setMode(slot.mode);
    teTileIndex.value = String(slot.mode === 'tile' && slot.tileIndex != null ? slot.tileIndex : t);
    teTileIndex.max = String(Math.max(0, tileCount(sheet) - 1));
    teFlipH.checked = slot.flipH;
    teFlipV.checked = slot.flipV;
    dlg.showModal();
  }

  function commitSlot(sheet, tileIndex, dir, slot) {
    const wasStored = !!sheet.tile.neighbors[tileIndex];
    const prevSnapshot = wasStored ? structuredClone(sheet.tile.neighbors[tileIndex]) : null;
    const newSlot = { ...slot };
    state.commands.push({
      label: 'edit tile neighbor slot',
      do() { setSlot(sheet, tileIndex, dir, newSlot); },
      undo() {
        if (prevSnapshot) sheet.tile.neighbors[tileIndex] = structuredClone(prevSnapshot);
        else delete sheet.tile.neighbors[tileIndex];
      },
    });
    markDirty();
  }

  teCancel.addEventListener('click', () => dlg.close());
  teOk.addEventListener('click', () => {
    const sheet = activeSheet();
    const t = currentTileIndex();
    if (!sheet || t == null || !dialogDir) { dlg.close(); return; }
    const mode = teModeRadios.find(r => r.checked)?.value ?? 'same';
    let tileIndex = null;
    if (mode === 'tile') {
      const count = tileCount(sheet);
      let v = parseInt(teTileIndex.value, 10);
      if (!Number.isFinite(v)) v = 0;
      v = Math.max(0, Math.min(count - 1, v));
      tileIndex = v;
    }
    const slot = { mode, tileIndex, flipH: teFlipH.checked, flipV: teFlipV.checked };
    commitSlot(sheet, t, dialogDir, slot);
    dlg.close();
  });

  // ---- pointer routing: drawing (inside center rect) vs. slot click ----

  // Editor-local cell lookup: returns {dx, dy} (tile units, 0,0 excluded —
  // that's the center) or null when (x, y) is outside the content grid.
  function cellAt(x, y) {
    const sheet = activeSheet();
    if (!sheet) return null;
    const tw = sheet.tile.tileWidth, th = sheet.tile.tileHeight;
    if (x < 0 || y < 0 || x >= view.width || y >= view.height) return null;
    const dx = Math.floor(x / tw) - radius;
    const dy = Math.floor(y / th) - radius;
    if (dx === 0 && dy === 0) return null;
    return { dx, dy };
  }

  function insideCenter(x, y) {
    const sheet = activeSheet();
    if (!sheet) return false;
    const tw = sheet.tile.tileWidth, th = sheet.tile.tileHeight;
    return x >= radius * tw && x < radius * tw + tw && y >= radius * th && y < radius * th + th;
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
    const t = currentTileIndex();
    if (!sheet || t == null) { nameLabel.textContent = ''; return; }
    const name = sheet.tile.names[t];
    nameLabel.textContent = name ? `Tile ${t} (${name})` : `Tile ${t}`;
    radiusSelect.value = String(radius);
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

  let loadedTileIndex = null;
  let loadedRadius = null;

  function loadContent() {
    const sheet = activeSheet();
    if (!sheet || !sheet.tile) return;
    const tw = sheet.tile.tileWidth, th = sheet.tile.tileHeight;
    view.setContent({ width: (2 * radius + 1) * tw, height: (2 * radius + 1) * th });
    view.centerFit();
    loadedTileIndex = currentTileIndex();
    loadedRadius = radius;
  }

  // ---- visibility ----

  let visible = false;
  let lastCssW = 0, lastCssH = 0;

  function refresh() {
    const t = currentTileIndex();
    if (t == null) {
      hide();
      if (state.view === 'tile') { state.view = 'sheet'; state.editingTileIndex = null; emit('view'); }
      return;
    }
    if (loadedTileIndex !== t || loadedRadius !== radius) loadContent();
    updateStrip();
    view.requestRender();
  }

  function show() {
    const wasHidden = !visible;
    container.style.display = 'flex';
    visible = true;
    if (wasHidden) {
      view._resize();
      if (loadedTileIndex != null && (view.cssWidth !== lastCssW || view.cssHeight !== lastCssH)) {
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

  return { show, hide };
}
