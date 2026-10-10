// js/modes/maps/presentation/map-renderer.js
import { flattenSheet, effectiveDuration, refreshMapBounds, DEFAULT_MAP_BOUNDS } from '../../../core/model.js';
import { findSheet, snap, selectedTile, selectedTerrain, selectedSprite, itemSize, terrainResolution, MAP_ORIGIN } from '../application/map-geometry.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';
import { createRasterCache } from '../../../components/canvas/raster-cache.js';
import { playOrder } from '../../../domain/sprites/playback.js';
import { getEditorHost } from '../../../host/runtime.js';

let playing = false, playStarted = 0;
let rasterCaches = new Map(); // sheet.id -> RasterCache
let cacheRevision = null;
let mapPreviewCanvas = null;

export function focusMapCanvas(view) {
  view.setContent({ width: MAP_ORIGIN * 2, height: MAP_ORIGIN * 2 });
  const center = () => {
    view.zoom = 2;
    view.panX = Math.round(view.cssWidth / 2 - MAP_ORIGIN * view.zoom);
    view.panY = Math.round(view.cssHeight / 2 - MAP_ORIGIN * view.zoom);
    view.requestRender();
  };
  center();
  // The dedicated map host is mounted hidden and gets its real dimensions
  // after Maps mode makes it visible.
  requestAnimationFrame(center);
}

// `project` is unused directly -- cache invalidation is driven by the
// explicit clearMapRasterCache() call on the 'project' event (see
// map-panel.js), not by comparing project identity here. Kept as a
// parameter so call sites read the same as before.
export function flatCanvas(sheet, project) {
  if (!sheet) return null;
  const host = getEditorHost();
  const revision = `${host.store.getState().workspace.pixelRevision}:${host.history.snapshot().revision}`;
  if (revision !== cacheRevision) { rasterCaches.clear(); cacheRevision = revision; }
  let cache = rasterCaches.get(sheet.id);
  if (!cache) { cache = createRasterCache(); rasterCaches.set(sheet.id, cache); }
  return cache.getCanvas(sheet, flattenSheet);
}

export function clearMapRasterCache() { rasterCaches.clear(); cacheRevision = null; }
export function isMapPlaying() { return playing; }
export function toggleMapPlayback(onChange) {
  playing = !playing;
  if (playing) playStarted = performance.now();
  onChange?.();
}

function animationFrame(sheet, anim) {
  if (!anim?.frames?.length) return null;
  const elapsed = playing ? performance.now() - playStarted : 0;
  // In the animation's play order (its direction), not timeline order.
  const entries = playOrder(anim, anim.loop).map(i => anim.frames[i]);
  let cursor = entries[0]; let t = elapsed;
  const total = entries.reduce((sum, f) => sum + effectiveDuration(anim, f), 0);
  if (anim.loop && total) t %= total;
  for (const f of entries) { cursor = f; const d = effectiveDuration(anim, f); if (t < d) break; t -= d; }
  return sheet.frames.find(f => f.id === cursor.frameId) ?? null;
}

function drawSource(ctx, project, sheetId, rect, x, y, alpha = 1, transform = null, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  const canvas = flatCanvas(findSheet(project, sheetId), project); if (!canvas || !rect) return;
  ctx.save(); ctx.globalAlpha *= alpha;
  if (transform && (transform.flipH || transform.flipV || transform.rotate)) {
    ctx.translate(x + offsetX + rect.w / 2, y + offsetY + rect.h / 2);
    // Blob descriptors are rotate-then-flip. Canvas transforms are applied
    // in reverse call order, so scale is intentionally installed first.
    ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
    ctx.rotate((transform.rotate || 0) * Math.PI / 180);
    ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, -rect.w / 2, -rect.h / 2, rect.w, rect.h);
  } else ctx.drawImage(canvas, rect.x, rect.y, rect.w, rect.h, x + offsetX, y + offsetY, rect.w, rect.h);
  ctx.restore();
}

function drawTerrain(ctx, project, layer, entry, offsetX, offsetY) {
  const sheet = findSheet(project, entry.sheetId), terrain = sheet?.terrainSets?.find(t => t.id === entry.terrainSetId); if (!sheet || !terrain) return;
  const resolved = terrainResolution(layer, sheet, terrain, entry.x, entry.y);
  if (resolved) drawSource(ctx, project, sheet.id, resolved.tile, entry.x, entry.y, 1, resolved, offsetX, offsetY);
}

function drawSprite(ctx, project, entry, offsetX, offsetY) {
  const sheet = findSheet(project, entry.sheetId); if (!sheet) return;
  const source = entry.kind === 'animation' ? animationFrame(sheet, sheet.animations.find(a => a.id === entry.assetId)) : sheet.frames.find(f => f.id === entry.assetId);
  if (source) drawSource(ctx, project, sheet.id, source, entry.x, entry.y, 1, null, offsetX, offsetY);
}

function drawMapLayers(ctx, project, map, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  for (const layer of map.layers) {
    if (!layer.visible) continue;
    ctx.save(); ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.type === 'tile') {
      layer.tiles.forEach(entry => { const sheet = findSheet(project, entry.sheetId); drawSource(ctx, project, entry.sheetId, sheet?.tiles?.find(tile => tile.id === entry.tileId), entry.x, entry.y, 1, null, offsetX, offsetY); });
      layer.terrain.forEach(entry => drawTerrain(ctx, project, layer, entry, offsetX, offsetY));
    } else layer.sprites.forEach(entry => drawSprite(ctx, project, entry, offsetX, offsetY));
    ctx.restore();
  }
}

export function paintMap(ctx, project, map, onPlaybackFrame) {
  // CanvasView content is the 0..MAP_SPAN workspace; map records themselves
  // remain centred around (0, 0), translated by MAP_ORIGIN at render time.
  ctx.fillStyle = '#202128'; ctx.fillRect(0, 0, MAP_ORIGIN * 2, MAP_ORIGIN * 2);
  if (!map) return;
  refreshMapBounds(project, map);
  drawMapLayers(ctx, project, map);
  if (playing) requestAnimationFrame(() => onPlaybackFrame?.());
}

export function renderMapPreviewBitmap(project, map) {
  if (!map) return null;
  const bounds = refreshMapBounds(project, map) ?? DEFAULT_MAP_BOUNDS;
  // Keep pathological/imported maps from allocating an enormous preview
  // bitmap. The whole bounds still render; only the preview raster is scaled.
  const scale = Math.min(1, 2048 / Math.max(1, bounds.w), 2048 / Math.max(1, bounds.h));
  const width = Math.max(1, Math.ceil(bounds.w * scale)), height = Math.max(1, Math.ceil(bounds.h * scale));
  if (!mapPreviewCanvas) mapPreviewCanvas = document.createElement('canvas');
  mapPreviewCanvas.width = width; mapPreviewCanvas.height = height;
  const ctx = mapPreviewCanvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, width, height);
  ctx.scale(scale, scale);
  drawMapLayers(ctx, project, map, -bounds.x, -bounds.y);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data: new Uint8ClampedArray(image.data) };
}

function brushPreview(map, project, tool, p) {
  if (tool === 'maptile') {
    if (asset.tileKind === 'terrain') {
      const { sheet, terrain } = selectedTerrain(project, asset); if (!sheet || !terrain) return null;
      const at = snap(map, p, terrain), active = map.layers.find(l => l.id === asset.__activeLayerId);
      const layer = active?.type === 'tile' && !active.locked ? active : map.layers.find(candidate => candidate.type === 'tile' && !candidate.locked);
      const resolved = terrainResolution(layer, sheet, terrain, at.x, at.y);
      return resolved
        ? { sheet, rect: resolved.tile, transform: resolved, x: at.x, y: at.y }
        : { sheet, rect: null, missing: true, w: terrain.tileW, h: terrain.tileH, x: at.x, y: at.y };
    }
    const { sheet, tile } = selectedTile(project, asset); if (!sheet || !tile) return null; const at = snap(map, p, tile); return { sheet, rect: tile, x: at.x, y: at.y };
  }
  if (tool === 'mapsprite') { const { sheet, item } = selectedSprite(project, asset); if (!sheet || !item) return null; const rect = asset.spriteKind === 'animation' ? sheet.frames.find(f => f.id === item.frames?.[0]?.frameId) : item; if (!rect) return null; const at = snap(map, p, rect); return { sheet, rect, x: at.x, y: at.y }; }
  return null;
}

export function drawMapOverlay(view, ctx, project, map, { tool, hover, selectedItemId, activeLayerId }) {
  if (!map) return;
  const bounds = map.bounds ?? DEFAULT_MAP_BOUNDS;
  const bp = view.imageToScreen(bounds.x + MAP_ORIGIN, bounds.y + MAP_ORIGIN);
  ctx.save(); ctx.strokeStyle = '#7583a8'; ctx.lineWidth = 2; ctx.strokeRect(bp.x, bp.y, bounds.w * view.zoom, bounds.h * view.zoom); ctx.restore();
  if (map.snap.mode !== 'off' && view.zoom >= 2) {
    const w = map.snap.gridW, h = map.snap.gridH; ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 1;
    const left = Math.floor((-view.panX / view.zoom - MAP_ORIGIN) / w) * w, top = Math.floor((-view.panY / view.zoom - MAP_ORIGIN) / h) * h;
    const right = Math.ceil(((view.cssWidth - view.panX) / view.zoom - MAP_ORIGIN) / w) * w, bottom = Math.ceil(((view.cssHeight - view.panY) / view.zoom - MAP_ORIGIN) / h) * h;
    const startX = Math.ceil(Math.max(left, bounds.x) / w) * w, endX = Math.min(right, bounds.x + bounds.w);
    const startY = Math.ceil(Math.max(top, bounds.y) / h) * h, endY = Math.min(bottom, bounds.y + bounds.h);
    for (let x = startX; x <= endX; x += w) { const p = view.imageToScreen(x + MAP_ORIGIN, bounds.y + MAP_ORIGIN), q = view.imageToScreen(x + MAP_ORIGIN, bounds.y + bounds.h + MAP_ORIGIN); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    for (let y = startY; y <= endY; y += h) { const p = view.imageToScreen(bounds.x + MAP_ORIGIN, y + MAP_ORIGIN), q = view.imageToScreen(bounds.x + bounds.w + MAP_ORIGIN, y + MAP_ORIGIN); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    ctx.restore();
  }
  if (hover && (tool === 'maptile' || tool === 'mapsprite')) {
    asset.__activeLayerId = activeLayerId;
    const preview = brushPreview(map, project, tool, hover);
    if (preview) {
      const source = flatCanvas(preview.sheet, project), screen = view.imageToScreen(preview.x + MAP_ORIGIN, preview.y + MAP_ORIGIN);
      const width = preview.rect?.w ?? preview.w, height = preview.rect?.h ?? preview.h;
      ctx.save(); ctx.imageSmoothingEnabled = false;
      if (source && preview.rect) {
        ctx.globalAlpha = .55;
        if (preview.transform && (preview.transform.flipH || preview.transform.flipV || preview.transform.rotate)) {
          ctx.save();
          ctx.translate(screen.x + width * view.zoom / 2, screen.y + height * view.zoom / 2);
          ctx.scale(preview.transform.flipH ? -1 : 1, preview.transform.flipV ? -1 : 1);
          ctx.rotate((preview.transform.rotate || 0) * Math.PI / 180);
          ctx.drawImage(source, preview.rect.x, preview.rect.y, width, height, -width * view.zoom / 2, -height * view.zoom / 2, width * view.zoom, height * view.zoom);
          ctx.restore();
        } else ctx.drawImage(source, preview.rect.x, preview.rect.y, width, height, screen.x, screen.y, width * view.zoom, height * view.zoom);
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = preview.missing ? '#ff6b6b' : '#65c8ff'; ctx.lineWidth = 2;
      if (preview.missing) ctx.setLineDash([5, 4]);
      ctx.strokeRect(screen.x, screen.y, width * view.zoom, height * view.zoom);
      if (preview.missing) { ctx.setLineDash([]); ctx.fillStyle = '#ffb0b0'; ctx.font = '12px sans-serif'; ctx.fillText('Missing autotile', screen.x + 4, screen.y + 14); }
      ctx.restore();
    }
  }
  if (selectedItemId) {
    const layer = map.layers.find(l => [...(l.tiles ?? []), ...(l.terrain ?? []), ...(l.sprites ?? [])].some(item => item.id === selectedItemId));
    const item = [...(layer?.tiles ?? []), ...(layer?.terrain ?? []), ...(layer?.sprites ?? [])].find(item => item.id === selectedItemId);
    if (item) {
      const p = view.imageToScreen(item.x + MAP_ORIGIN, item.y + MAP_ORIGIN), size = itemSize(project, item);
      ctx.strokeStyle = '#65c8ff'; ctx.lineWidth = 2; ctx.strokeRect(p.x, p.y, size.w * view.zoom, size.h * view.zoom);
    }
  }
}
