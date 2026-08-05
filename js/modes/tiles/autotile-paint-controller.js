import { state, on, emit, activeSheet, markDirty } from '../../app/state.js';
import { newId } from '../../core/palettes.js';
import { assignSlot } from '../../core/terrainsets.js';
import {
  NEIGHBOR_BITS, blobIndexToMask, resolveTerrainSlot,
  BLOB47_PAINT_CELLS, blobIndexFromPaintMask,
} from '../../core/blob47.js';
import { BLOB47_8X6_RAW, terrainNeighborPreviewCells } from '../../core/blob47templates.js';
import { registerTool } from '../../ui/tools.js';
import { getTileSheetCanvas as getFlatCanvas } from './tile-raster-service.js';

function describeMask(mask) {
  const names = {
    [NEIGHBOR_BITS.N]: 'N', [NEIGHBOR_BITS.NE]: 'NE',
    [NEIGHBOR_BITS.E]: 'E', [NEIGHBOR_BITS.SE]: 'SE',
    [NEIGHBOR_BITS.S]: 'S', [NEIGHBOR_BITS.SW]: 'SW',
    [NEIGHBOR_BITS.W]: 'W', [NEIGHBOR_BITS.NW]: 'NW',
  };
  const parts = Object.keys(names).filter(bit => mask & Number(bit)).map(bit => names[bit]);
  return parts.length ? parts.join(' + ') : 'isolated';
}

// ------------------------------------------------------------- autotile paint
//
// A Tiled-style terrain editor paints the meaningful Wang positions directly
// over tileset art. Blob-47 is the binary, reduced version of that model, so
// this keeps only one paint color (terrain) plus erase, then derives the
// canonical slot at the end of each pointer stroke.
let autotilePaint = null; // { terrainSetId, brush: 'paint'|'erase', stroke, conflicts:Map<tileId,blobIndex>, hover }

function terrainPaintGrid(sheet, terrainSet) {
  if (!terrainSet || sheet.width % terrainSet.tileW || sheet.height % terrainSet.tileH) return null;
  return { cols: sheet.width / terrainSet.tileW, rows: sheet.height / terrainSet.tileH };
}

function standalonePaintTile(x, y, w, h) {
  return {
    id: newId('ti'), x, y, w, h, name: undefined, gridId: null, gridCol: undefined, gridRow: undefined,
    neighbors: undefined, terrainSetId: undefined, blobIndex: undefined, layer: undefined, tags: undefined,
    duplicateOf: undefined,
  };
}

// Prepare a neat full-sheet lattice without ever creating a Tile Grid. A
// pre-existing tile is safe to reuse only when it exactly matches one cell;
// anything spanning cells would make a direct paint target ambiguous.
function prepareTerrainPaint(sheet, terrainSet) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid) return { error: `Sheet size must be divisible by ${terrainSet.tileW}×${terrainSet.tileH}.` };
  const expected = new Map();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const x = col * terrainSet.tileW, y = row * terrainSet.tileH;
    expected.set(`${x},${y}`, { x, y, w: terrainSet.tileW, h: terrainSet.tileH });
  }
  for (const tile of sheet.tiles) {
    const e = expected.get(`${tile.x},${tile.y}`);
    if (!e || tile.gridId != null || tile.w !== e.w || tile.h !== e.h) {
      return { error: 'Existing tiles must align exactly to the terrain size before terrain painting can start.' };
    }
    if (sheet.tiles.filter(t => t.x === tile.x && t.y === tile.y && t.w === tile.w && t.h === tile.h).length > 1) {
      return { error: 'Multiple tile records occupy the same terrain cell. Remove the duplicate before terrain painting.' };
    }
  }
  const before = sheet.tiles.slice();
  const after = sheet.tiles.slice();
  for (const e of expected.values()) {
    if (!after.some(t => t.x === e.x && t.y === e.y && t.w === e.w && t.h === e.h)) after.push(standalonePaintTile(e.x, e.y, e.w, e.h));
  }
  if (after.length !== before.length) {
    state.commands.push({
      label: 'create terrain paint cells',
      do() { sheet.tiles = after.slice(); markDirty(); },
      undo() { sheet.tiles = before.slice(); markDirty(); },
    });
  }
  return { grid };
}

function paintTileAt(sheet, terrainSet, x, y) {
  const grid = terrainPaintGrid(sheet, terrainSet);
  if (!grid || x < 0 || y < 0 || x >= sheet.width || y >= sheet.height) return null;
  const col = Math.floor(x / terrainSet.tileW), row = Math.floor(y / terrainSet.tileH);
  const tx = col * terrainSet.tileW, ty = row * terrainSet.tileH;
  return sheet.tiles.find(t => t.x === tx && t.y === ty && t.w === terrainSet.tileW && t.h === terrainSet.tileH) ?? null;
}

function paintCellAt(tile, x, y) {
  const col = Math.min(2, Math.floor(((x - tile.x) * 3) / tile.w));
  const row = Math.min(2, Math.floor(((y - tile.y) * 3) / tile.h));
  return BLOB47_PAINT_CELLS.find(c => c.col === col && c.row === row) ?? null;
}

function persistedPaintMask(tile, terrainSet) {
  return tile?.terrainSetId === terrainSet.id && tile.blobIndex != null ? blobIndexToMask[tile.blobIndex] : 0;
}

function strokePaintMask(tile, terrainSet) {
  return autotilePaint?.stroke?.masks.get(tile.id) ?? persistedPaintMask(tile, terrainSet);
}

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
  const mask = strokePaintMask(tile, terrainSet);
  stroke.masks.set(tile.id, stroke.brush === 'erase' ? (mask & ~cell.bit) : (mask | cell.bit));
  view.requestRender();
}

function commitTerrainPaintStroke(view) {
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint?.terrainSetId);
  const stroke = autotilePaint?.stroke;
  if (!sheet || !terrainSet || !stroke?.masks.size) { if (autotilePaint) autotilePaint.stroke = null; return; }
  const beforeSlots = { ...terrainSet.slots };
  const afterSlots = { ...beforeSlots };
  const beforeTiles = new Map();
  const afterTiles = new Map();
  const candidates = [];
  const conflicts = new Map();
  for (const [tileId, mask] of stroke.masks) {
    const tile = sheet.tiles.find(t => t.id === tileId);
    if (!tile || (tile.terrainSetId != null && tile.terrainSetId !== terrainSet.id)) continue;
    beforeTiles.set(tileId, { terrainSetId: tile.terrainSetId, blobIndex: tile.blobIndex, duplicateOf: tile.duplicateOf });
    for (const idx of Object.keys(afterSlots)) if (afterSlots[idx] === tileId) delete afterSlots[idx];
    candidates.push({ tile, blobIndex: blobIndexFromPaintMask(mask) });
  }
  for (const candidate of candidates) {
    const owner = afterSlots[candidate.blobIndex];
    if (owner != null && owner !== candidate.tile.id) { conflicts.set(candidate.tile.id, candidate.blobIndex); continue; }
    afterSlots[candidate.blobIndex] = candidate.tile.id;
    afterTiles.set(candidate.tile.id, { terrainSetId: terrainSet.id, blobIndex: candidate.blobIndex, duplicateOf: undefined });
  }
  // A conflicted tile was removed from the working slots above only if it had
  // moved. Restore it exactly, and do not create a history command if every
  // changed cell was blocked by a duplicate/other terrain set.
  for (const candidate of candidates) if (conflicts.has(candidate.tile.id)) {
    const before = beforeTiles.get(candidate.tile.id);
    if (before?.terrainSetId === terrainSet.id && before.blobIndex != null) afterSlots[before.blobIndex] = candidate.tile.id;
  }
  if (afterTiles.size) {
    state.commands.push({
      label: 'paint autotile terrain',
      do() {
        terrainSet.slots = { ...afterSlots };
        for (const [id, next] of afterTiles) Object.assign(sheet.tiles.find(t => t.id === id), next);
        markDirty();
      },
      undo() {
        terrainSet.slots = { ...beforeSlots };
        for (const [id, prev] of beforeTiles) Object.assign(sheet.tiles.find(t => t.id === id), prev);
        markDirty();
      },
    });
  }
  autotilePaint.conflicts = conflicts;
  autotilePaint.stroke = null;
  refreshBlob47Coverage?.();
  view.requestRender();
}

function drawAutotilePaintOverlay(ctx, view) {
  if (!autotilePaint || state.tool !== 'autotilepaint' || state.mode !== 'tiles') return;
  const sheet = activeSheet();
  const terrainSet = sheet?.terrainSets.find(ts => ts.id === autotilePaint.terrainSetId);
  const grid = sheet && terrainSet && terrainPaintGrid(sheet, terrainSet);
  if (!sheet || !terrainSet || !grid) return;
  ctx.save();
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) {
    const tile = paintTileAt(sheet, terrainSet, col * terrainSet.tileW, row * terrainSet.tileH);
    if (!tile) continue;
    const mask = strokePaintMask(tile, terrainSet);
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
  const mask = strokePaintMask(tile, terrainSet);
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
function getBlob47ReferenceImage() {
  if (blob47ReferenceImage) return blob47ReferenceImage;
  const image = new Image();
  image.onload = () => emit('view'); // repaint the canvas once the artwork is ready
  image.src = 'assets/blob47-templates/blob47-8x6-reference.png';
  blob47ReferenceImage = image;
  return image;
}

let blob47CoverageDialog = null;
let refreshBlob47Coverage = null;
// Large, inspectable reference board: each card places the expected Blob-47
// artwork above the terrain set's actual assigned tile. Missing patterns are
// intentionally loud instead of silently appearing as empty slots.
export function openBlob47Coverage(sheet, terrainSet) {
  if (!blob47CoverageDialog) {
    blob47CoverageDialog = document.createElement('dialog');
    document.body.appendChild(blob47CoverageDialog);
  }
  const dialog = blob47CoverageDialog;
  const render = () => {
    dialog.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = `${terrainSet.name} · Blob-47 coverage`;
    const help = document.createElement('p');
    help.textContent = 'Top: expected Blob-47 reference artwork. Bottom: your assigned tile. Red cards are missing.';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(8,72px);gap:6px;max-height:72vh;overflow:auto;padding:4px;';
    const flat = getFlatCanvas(sheet);
    const reference = getBlob47ReferenceImage();
    for (let row = 0; row < BLOB47_8X6_RAW.length; row++) for (let col = 0; col < BLOB47_8X6_RAW[row].length; col++) {
      const rawMask = BLOB47_8X6_RAW[row][col];
      const blobIndex = blobIndexFromPaintMask(rawMask);
      const resolved = resolveTerrainSlot(terrainSet, blobIndex);
      const source = resolved ? sheet.tiles.find(t => t.id === resolved.tileId) : null;
      const card = document.createElement('div');
      card.style.cssText = `border:2px solid ${source ? '#4f8cff' : '#ef5350'};background:${source ? '#171a22' : '#3d1619'};padding:2px;`;
      card.title = `${describeMask(blobIndexToMask[blobIndex])}${source ? ` — tile #${sheet.tiles.indexOf(source)}${resolved.rotate || resolved.flipH ? ' (derived)' : ''}` : ' — missing'}`;
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 128;
      canvas.style.cssText = 'display:block;width:64px;height:128px;image-rendering:pixelated;';
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      if (reference.complete && reference.naturalWidth) ctx.drawImage(reference, col * 32, row * 32, 32, 32, 0, 0, 64, 64);
      else { ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 64, 64); }
      ctx.fillStyle = source ? '#0d1016' : '#5d1c21'; ctx.fillRect(0, 64, 64, 64);
      if (source) {
        ctx.save();
        ctx.translate(0, 64);
        ctx.translate(resolved.flipH ? 64 : 0, resolved.flipV ? 64 : 0);
        ctx.scale(resolved.flipH ? -1 : 1, resolved.flipV ? -1 : 1);
        if (resolved.rotate) {
          ctx.translate(32, 32); ctx.rotate((resolved.rotate * Math.PI) / 180); ctx.translate(-32, -32);
        }
        ctx.drawImage(flat, source.x, source.y, source.w, source.h, 0, 0, 64, 64);
        ctx.restore();
      } else {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('MISSING', 32, 96);
      }
      const label = document.createElement('div');
      label.style.cssText = `font-size:10px;text-align:center;color:${source ? '#d6d7dc' : '#ffb4b4'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
      label.textContent = source ? `#${sheet.tiles.indexOf(source)}` : 'MISSING';
      card.append(canvas, label); grid.appendChild(card);
    }
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
    dialog.append(title, help, grid, close);
  };
  refreshBlob47Coverage = () => {
    if (dialog.open) render();
  };
  dialog.onclose = () => { refreshBlob47Coverage = null; };
  render();
  const reference = getBlob47ReferenceImage();
  if (!reference.complete) reference.addEventListener('load', render, { once: true });
  if (!dialog.open) dialog.showModal();
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
  registerTool({ id: 'autotilepaint', icon: '🧩', label: 'Autotile paint', key: 'a', isAvailable: () => state.mode === 'tiles' && !!autotilePaint });
}

export function bindAutotilePaintTool(view) {
  const prevPointer = view.onPointer;
  view.onPointer = (ev) => {
    if (state.mode === 'tiles' && state.tool === 'autotilepaint' && autotilePaint) {
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
  on('tool', () => { if (state.tool !== 'autotilepaint' && autotilePaint?.stroke) autotilePaint.stroke = null; });
}

export function startAutotilePaint(sheet, terrainSet) {
  const prepared = prepareTerrainPaint(sheet, terrainSet);
  if (prepared.error) { alert(prepared.error); return; }
  const initialPreviewTile = sheet.tiles.find(t => t.terrainSetId === terrainSet.id)
    ?? sheet.tiles.find(t => t.w === terrainSet.tileW && t.h === terrainSet.tileH);
  autotilePaint = {
    terrainSetId: terrainSet.id, brush: 'paint', stroke: null, conflicts: new Map(), hover: null,
    previewTileId: initialPreviewTile?.id ?? null,
  };
  state.tool = 'autotilepaint';
  emit('tool');
  emit('selection');
  emit('view');
}

export function stopAutotilePaint() {
  if (!autotilePaint) return;
  autotilePaint = null;
  if (state.tool === 'autotilepaint') state.tool = 'tiletool';
  emit('tool');
  emit('view');
}

// Conflicts are deliberately non-destructive during a paint stroke. This is
// the explicit escape hatch: replace the old artwork for that Blob-47 shape
// only when the user asks to use the newly painted tile.
export function useAutotilePaintConflict(sheet, terrainSet, tileId, blobIndex) {
  const tile = sheet.tiles.find(t => t.id === tileId);
  if (!tile) return;
  const beforeSlots = { ...terrainSet.slots };
  const beforeTiles = sheet.tiles.map(t => ({ t, terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));
  assignSlot(sheet, terrainSet, blobIndex, tile);
  tile.duplicateOf = undefined;
  const afterSlots = { ...terrainSet.slots };
  const afterTiles = sheet.tiles.map(t => ({ terrainSetId: t.terrainSetId, blobIndex: t.blobIndex, duplicateOf: t.duplicateOf }));
  state.commands.push({
    label: 'replace autotile terrain art',
    do() {
      terrainSet.slots = { ...afterSlots };
      sheet.tiles.forEach((t, i) => Object.assign(t, afterTiles[i]));
      markDirty();
    },
    undo() {
      terrainSet.slots = { ...beforeSlots };
      for (const b of beforeTiles) Object.assign(b.t, {
        terrainSetId: b.terrainSetId, blobIndex: b.blobIndex, duplicateOf: b.duplicateOf,
      });
      markDirty();
    },
  });
  autotilePaint?.conflicts.delete(tileId);
  refreshBlob47Coverage?.();
}

export function getAutotilePaintSession() {
  return autotilePaint;
}

export function setAutotilePaintBrush(brush) {
  if (!autotilePaint || (brush !== 'paint' && brush !== 'erase')) return;
  autotilePaint.brush = brush;
}

