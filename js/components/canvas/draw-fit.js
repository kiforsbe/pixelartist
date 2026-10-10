// js/components/canvas/draw-fit.js
import { getEditorHost } from '../../host/runtime.js';

// Module-level scratch canvas and context, reused across all drawFit() calls
// to avoid allocating a new canvas on every rAF tick during playback.
let scratchCanvas = null;
let scratchCtx = null;

function getScratchCanvas(width, height) {
  if (!scratchCanvas) {
    scratchCanvas = document.createElement('canvas');
    scratchCtx = scratchCanvas.getContext('2d');
  }
  // Only resize if dimensions differ (resize resets context state)
  if (scratchCanvas.width !== width || scratchCanvas.height !== height) {
    scratchCanvas.width = width;
    scratchCanvas.height = height;
    // Restore imageSmoothingEnabled after resize (canvas resize resets context)
    scratchCtx.imageSmoothingEnabled = false;
  }
  return scratchCanvas;
}

// Draws `bmp` into `canvas`, scaled to fit (contain) and centered. Used for
// both 64px strip thumbnails and the 96px preview. Shrinking a large sprite
// down to a tiny thumbnail with nearest-neighbor drops most of its pixels
// and aliases badly; smoothing (project setting, on by default) only kicks
// in for that shrink case -- an upscaled thumbnail stays crisp
// nearest-neighbor or the pixel art would turn to mush.
export function drawFit(canvas, bmp) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bmp || bmp.width === 0 || bmp.height === 0) return;
  const tmp = getScratchCanvas(bmp.width, bmp.height);
  tmp.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  const scale = Math.min(canvas.width / bmp.width, canvas.height / bmp.height);
  const dw = Math.max(1, Math.round(bmp.width * scale));
  const dh = Math.max(1, Math.round(bmp.height * scale));
  const dx = Math.floor((canvas.width - dw) / 2);
  const dy = Math.floor((canvas.height - dh) / 2);
  const smooth = scale < 1 && getEditorHost().projects.project?.settings?.smoothThumbnails !== false;
  ctx.imageSmoothingEnabled = smooth;
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, bmp.width, bmp.height, dx, dy, dw, dh);
}
