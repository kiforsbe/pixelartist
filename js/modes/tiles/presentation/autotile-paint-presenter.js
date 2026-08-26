// js/modes/tiles/presentation/autotile-paint-presenter.js
// Blob-47 terrain paint tool: pointer/stroke routing + overlay/preview
// rendering (Humble Object) -- geometry math lives in
// application/geometry/autotile-geometry.js; all project mutations go
// through CommandRegistry by id, never a direct import.

import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { registerTool } from '../../../components/tool-palette.js';
import { blobIndexToMask, blobIndexFromPaintMask, BLOB47_PAINT_CELLS } from '../../../core/blob47.js';
import { BLOB47_8X6_RAW, terrainNeighborPreviewCells } from '../../../core/blob47templates.js';
import { getTileSheetCanvas as getFlatCanvas } from './tile-raster-cache.js';
import { refreshBlob47CoverageIfOpen } from './blob47-coverage-dialog.js';
import {
  describeMask, terrainPaintGrid, paintTileAt, paintCellAt, strokePaintMask,
} from '../application/geometry/autotile-geometry.js';

function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}
function currentModeId() { return getEditorHost().store.getState().session.activeModeId; }
function currentToolId() { return getEditorHost().store.getState().session.activeToolId; }

// A Tiled-style terrain editor paints the meaningful Wang positions directly
// over tileset art. Blob-47 is the binary, reduced version of that model, so
// this keeps only one paint color (terrain) plus erase, then derives the
// canonical slot at the end of each pointer stroke.
let autotilePaint = null; // { terrainSetId, brush: 'paint'|'erase', stroke, conflicts:Map<tileId,blobIndex>, hover }

function beginTerrainPaintStroke(ev, view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  if (!sheet || !terrainSet) return;
  // Secondary-button drags always erase, independent of the selected brush.
  autotilePaint.stroke = { masks: new Map(), seen: new Set(), brush: (ev.buttons & 2) ? 'erase' : autotilePaint.brush };
  applyTerrainPaintPoint(ev, view);
}

function applyTerrainPaintPoint(ev, view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke) return;
  const tile = paintTileAt(sheet, terrainSet, ev.x, ev.y);
  const cell = tile && paintCellAt(tile, ev.x, ev.y);
  autotilePaint.hover = tile && cell ? { tileId: tile.id, bit: cell.bit } : null;
  if (tile && cell) autotilePaint.previewTileId = tile.id;
  if (!tile || !cell) return;
  const key = `${tile.id}:${cell.bit}`;
  if (stroke.seen.has(key)) return;
  stroke.seen.add(key);
  const mask = strokePaintMask(tile, terrainSet, stroke);
  stroke.masks.set(tile.id, stroke.brush === 'erase' ? (mask & ~cell.bit) : (mask | cell.bit));
  view.requestRender();
}

function commitTerrainPaintStroke(view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke?.masks.size) { if (autotilePaint) autotilePaint.stroke = null; return; }
  const result = dispatch('tiles.paintTerrainStroke', { sheetId: sheet.id, terrainSetId: terrainSet.id, strokeMasks: stroke.masks });
  autotilePaint.conflicts = result?.conflicts ?? new Map();
  autotilePaint.stroke = null;
  refreshBlob47CoverageIfOpen();
  view.requestRender();
}

function drawAutotilePaintOverlay(ctx, view) {
  if (!autotilePaint || currentToolId() !== 'autotilepaint' || currentModeId() !== 'tiles') return;
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
  const grid = sheet && terrainSet && terrainPaintGrid(sheet, terrainSet);
  if (!sheet || !terrainSet || !grid) return;
  ctx.save();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const tile = paintTileAt(sheet, terrainSet, col * terrainSet.tileW, row * terrainSet.tileH);
    if (!tile) continue;
    const mask = strokePaintMask(tile, terrainSet, autotilePaint.stroke);
    const p0 = view.imageToScreen(tile.x, tile.y), p1 = view.imageToScreen(tile.x + tile.w, tile.y + tile.h);
    const cw = (p1.x - p0.x) / 3, ch = (p1.y - p0.y) / 3;
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
    ctx.strokeRect(p0.x + .5, p0.y + .5, p1.x - p0.x - 1, p1.y - p0.y - 1);
    for (const cell of BLOB47_PAINT_CELLS) if (mask & cell.bit) {
      ctx.fillStyle = 'rgba(74, 201, 122, .45)';
      ctx.fillRect(p0.x + cell.col * cw + 1, p0.y + cell.row * ch + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
    }
    if (autotilePaint.conflicts?.has(tile.id)) {
      ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 2;
      ctx.strokeRect(p0.x + 1, p0.y + 1, p1.x - p0.x - 2, p1.y - p0.y - 2);
    }
    if (autotilePaint.hover?.tileId === tile.id) {
      const hover = BLOB47_PAINT_CELLS.find(c => c.bit === autotilePaint.hover.bit);
      if (hover) {
        ctx.strokeStyle = (autotilePaint.stroke?.brush ?? autotilePaint.brush) === 'erase' ? '#ef5350' : '#72d995'; ctx.lineWidth = 2;
        ctx.strokeRect(p0.x + hover.col * cw + 1, p0.y + hover.row * ch + 1, Math.max(0, cw - 2), Math.max(0, ch - 2));
      }
    }
  }
  drawAutotilePaintPreview(ctx, view, sheet, terrainSet);
  ctx.restore();
}

// A concrete 3x3 result preview is much easier to reason about than eight
// green metadata cells. It renders the hovered tile at the center and the
// actual resolved neighbor artwork around it, using the tentative stroke mask
// when a drag is currently in progress.
function drawAutotilePaintPreview(ctx, view, sheet, terrainSet) {
  const hoverId = autotilePaint?.hover?.tileId ?? autotilePaint?.previewTileId;
  const tile = hoverId ? sheet.tiles.find(t => t.id === hoverId) : null;
  if (!tile) return;
  const mask = strokePaintMask(tile, terrainSet, autotilePaint?.stroke);
  const blobIndex = blobIndexFromPaintMask(mask);
  // This is the comparison view the painter relies on, so give the artwork
  // room to be read rather than treating it like a small tooltip.  On small
  // canvases it still scales down enough to leave the sheet usable.
  const cellSize = Math.max(28, Math.min(108, Math.floor(Math.min(view.cssWidth, view.cssHeight) / 4.5)));
  const size = cellSize * 3;
  const x = Math.max(8, view.cssWidth - size - 10), y = 10;
  const flat = getFlatCanvas(sheet);
  const draw = (source, dx, dy, { flipH = false, flipV = false, rotate = 0 } = {}) => {
    if (!source) return;
    ctx.save();
    ctx.translate(x + dx * cellSize, y + dy * cellSize);
    ctx.translate(flipH ? cellSize : 0, flipV ? cellSize : 0);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    if (rotate) {
      ctx.translate(cellSize / 2, cellSize / 2);
      ctx.rotate((rotate * Math.PI) / 180);
      ctx.translate(-cellSize / 2, -cellSize / 2);
    }
    ctx.drawImage(flat, source.x, source.y, source.w, source.h, 0, 0, cellSize, cellSize);
    ctx.restore();
  };
  const candidate = { ...tile, blobIndex };
  const neighbors = terrainNeighborPreviewCells(candidate, terrainSet);
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,18,.9)';
  ctx.fillRect(x - 3, y - 20, size + 6, size + 24);
  ctx.strokeStyle = '#8bd6ff'; ctx.lineWidth = 1;
  ctx.strokeRect(x - .5, y - .5, size + 1, size + 1);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.fillText(`Preview · ${describeMask(blobIndexToMask[blobIndex])}`, x, y - 17);
  for (const cell of neighbors) {
    const source = cell.tileId ? sheet.tiles.find(t => t.id === cell.tileId) : null;
    draw(source, cell.dx + 1, cell.dy + 1, cell);
  }
  draw(tile, 1, 1);
  ctx.strokeStyle = 'rgba(255,255,255,.25)';
  for (let i = 1; i < 3; i++) {
    ctx.beginPath(); ctx.moveTo(x + i * cellSize, y); ctx.lineTo(x + i * cellSize, y + size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + i * cellSize); ctx.lineTo(x + size, y + i * cellSize); ctx.stroke();
  }
  ctx.strokeStyle = '#8bd6ff'; ctx.lineWidth = 2;
  ctx.strokeRect(x + cellSize + 1, y + cellSize + 1, cellSize - 2, cellSize - 2);
  drawBlob47Reference(ctx, view, sheet, terrainSet, blobIndex);
  ctx.restore();
}

let blob47ReferenceImage = null;
let boundView = null;
export function getBlob47ReferenceImage() {
  if (blob47ReferenceImage) return blob47ReferenceImage;
  const image = new Image();
  image.onload = () => boundView?.requestRender();
  image.src = 'assets/blob47-templates/blob47-8x6-reference.png';
  blob47ReferenceImage = image;
  return image;
}

// This is the real, bundled Blob-47 reference art rather than another
// symbolic mask diagram. It stays large enough to compare an artwork tile
// directly against the exact target shape it is being assigned to.
function drawBlob47Reference(ctx, view, sheet, terrainSet, selectedBlobIndex) {
  // Keep the complete reference visible on-canvas, but make each source tile
  // genuinely inspectable. The previous 32px cap made the 47-tile board read
  // more like an icon than a visual comparison aid.
  const cellSize = Math.max(20, Math.min(48,
    Math.floor((view.cssWidth - 20) / 8), Math.floor((view.cssHeight - 42) / 6)));
  const width = cellSize * 8, height = cellSize * 6;
  const x = 10, y = Math.max(26, view.cssHeight - height - 10);
  const image = getBlob47ReferenceImage();
  const flat = getFlatCanvas(sheet);
  ctx.save();
  ctx.fillStyle = 'rgba(12,14,18,.9)';
  ctx.fillRect(x - 3, y - 18, width + 6, height + 22);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.fillText('Blob-47 artwork reference · blue = this tile', x, y - 15);
  if (image.complete && image.naturalWidth) ctx.drawImage(image, x, y, width, height);
  for (let row = 0; row < BLOB47_8X6_RAW.length; row++) {
    for (let col = 0; col < BLOB47_8X6_RAW[row].length; col++) {
      const rawMask = BLOB47_8X6_RAW[row][col];
      const blobIndex = blobIndexFromPaintMask(rawMask);
      const px = x + col * cellSize, py = y + row * cellSize;
      // Read the current, painted tilesheet records first. This is the live
      // artwork being edited; `slots` is only retained as a compatibility
      // fallback for older terrain sets.
      const paintedTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id && t.blobIndex === blobIndex && !t.duplicateOf);
      drawBlob47AssignedTileOverlay(ctx, flat, sheet, paintedTile?.id ?? terrainSet.slots?.[blobIndex], px, py, cellSize);
      drawBlob47PaintMarks(ctx, px, py, cellSize, blobIndexToMask[blobIndex]);
      ctx.strokeStyle = blobIndex === selectedBlobIndex ? '#28b9ff' : 'rgba(255,255,255,.22)';
      ctx.lineWidth = blobIndex === selectedBlobIndex ? 3 : 1;
      ctx.strokeRect(px + .5, py + .5, cellSize - 1, cellSize - 1);
    }
  }
  ctx.restore();
}

// Only show explicitly assigned slots here. Derived symmetry variants remain
// absent, which lets the board distinguish artwork the user has selected from
// shapes the editor can infer automatically.
function drawBlob47AssignedTileOverlay(ctx, flat, sheet, tileId, x, y, size) {
  const tile = tileId ? sheet.tiles.find(t => t.id === tileId) : null;
  if (!tile) return;
  ctx.save();
  ctx.globalAlpha = .67;
  ctx.translate(x, y);
  ctx.drawImage(flat, tile.x, tile.y, tile.w, tile.h, 0, 0, size, size);
  ctx.restore();
}

// Use exactly the painter's eight regions to annotate every example in the
// reference board. This makes the reference artwork a visual answer to
// "which parts should I paint for this tile?" rather than a second diagram
// the user has to translate mentally.
function drawBlob47PaintMarks(ctx, x, y, size, mask) {
  const unit = size / 3;
  for (const cell of BLOB47_PAINT_CELLS) {
    if (!(mask & cell.bit)) continue;
    const px = x + cell.col * unit, py = y + cell.row * unit;
    ctx.fillStyle = 'rgba(238, 82, 82, .5)';
    ctx.fillRect(px + 1, py + 1, Math.max(1, unit - 2), Math.max(1, unit - 2));
    ctx.strokeStyle = 'rgba(255, 222, 222, .5)'; ctx.lineWidth = 1;
    ctx.strokeRect(px + .5, py + .5, Math.max(0, unit - 1), Math.max(0, unit - 1));
  }
}

export function registerAutotilePaintTool() {
  registerTool({ id: 'autotilepaint', icon: '🧩', label: 'Autotile paint', key: 'a', isAvailable: () => currentModeId() === 'tiles' && !!autotilePaint });
}

export function bindAutotilePaintTool(view) {
  boundView = view;
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (currentModeId() === 'tiles' && currentToolId() === 'autotilepaint' && autotilePaint) {
      if (ev.type === 'down') beginTerrainPaintStroke(ev, view);
      else if (ev.type === 'move') {
        if (autotilePaint.stroke) applyTerrainPaintPoint(ev, view);
        else {
          const sheet = activeSheet();
          const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
          const tile = sheet && terrainSet && paintTileAt(sheet, terrainSet, ev.x, ev.y);
          const cell = tile && paintCellAt(tile, ev.x, ev.y);
          autotilePaint.hover = tile && cell ? { tileId: tile.id, bit: cell.bit } : null;
          if (tile && cell) autotilePaint.previewTileId = tile.id;
          view.requestRender();
        }
      }
      else if (ev.type === 'up') commitTerrainPaintStroke(view);
      return;
    }
    prevPointer(ev);
  };
  const prevOverlay = view.onOverlay;
  view.onOverlay = (ctx) => { prevOverlay(ctx); drawAutotilePaintOverlay(ctx, view); };
  getEditorHost().store.subscribe(s => s.session.activeToolId, toolId => {
    if (toolId !== 'autotilepaint' && autotilePaint?.stroke) autotilePaint.stroke = null;
  });
}

export function startAutotilePaint(sheet, terrainSet) {
  const prepared = dispatch('tiles.prepareTerrainPaint', { sheetId: sheet.id, terrainSetId: terrainSet.id });
  if (prepared?.error) { alert(prepared.error); return; }
  const initialPreviewTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id)
    ?? sheet.tiles.find(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH);
  autotilePaint = {
    terrainSetId: terrainSet.id, brush: 'paint', stroke: null, conflicts: new Map(), hover: null,
    previewTileId: initialPreviewTile?.id ?? null,
  };
  getEditorHost().store.updateSession({ activeToolId: 'autotilepaint' }, 'tool');
  boundView?.requestRender();
}

export function stopAutotilePaint() {
  if (!autotilePaint) return;
  autotilePaint = null;
  if (currentToolId() === 'autotilepaint') getEditorHost().store.updateSession({ activeToolId: 'tiletool' }, 'tool');
  boundView?.requestRender();
}

// Conflicts are deliberately non-destructive during a paint stroke. This is
// the explicit escape hatch: replace the old artwork for that Blob-47 shape
// only when the user asks to use the newly painted tile.
export function useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex) {
  dispatch('tiles.resolveAutotilePaintConflict', { sheetId: sheet.id, terrainSetId: terrainSet.id, tileId, blobIndex });
  autotilePaint?.conflicts.delete(tileId);
  refreshBlob47CoverageIfOpen();
}

export function getAutotilePaintSession() {
  return autotilePaint;
}

export function setAutotilePaintBrush(brush) {
  if (!autotilePaint || (brush !== 'paint' && brush !== 'erase')) return;
  autotilePaint.brush = brush;
}
