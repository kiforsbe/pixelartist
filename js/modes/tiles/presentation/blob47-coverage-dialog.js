// js/modes/tiles/presentation/blob47-coverage-dialog.js
// The standalone Blob-47 coverage-review dialog: an inspectable board of
// all 47 canonical shapes, each card comparing the expected reference
// artwork against the terrain set's actual assigned tile.
import { blobIndexToMask, blobIndexFromPaintMask, resolveTerrainSlot } from '../../../core/blob47.js';
import { BLOB47_8X6_RAW } from '../../../core/blob47templates.js';
import { getTileSheetCanvas as getFlatCanvas } from './tile-raster-cache.js';
import { describeMask } from '../application/geometry/autotile-geometry.js';
import { getBlob47ReferenceImage } from './autotile-paint-presenter.js';

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

export function refreshBlob47CoverageIfOpen() {
  refreshBlob47Coverage?.();
}
