import { state, on, emit, activeMap, markDirty } from '../../app/state.js';
import { flattenSheet, effectiveDuration, refreshMapBounds, DEFAULT_MAP_BOUNDS } from '../../core/model.js';
import { resolveTerrainSlot, maskToBlobIndex, DIRECTION_OFFSETS } from '../../core/blob47.js';
import { newId } from '../../core/palettes.js';
import { registerTool } from '../../ui/tools.js';

// CanvasView needs finite dimensions; this generous, centred work area keeps
// persisted map coordinates naturally signed while remaining effectively
// infinite for normal test scenes.
export const MAP_ORIGIN = 4096, MAP_SPAN = MAP_ORIGIN * 2;
let asset = { tileKind: 'tile', tileSheetId: '', tileId: '', terrainSheetId: '', terrainSetId: '', spriteSheetId: '', spriteKind: 'frame', spriteId: '' };
let playing = false, playStarted = 0, drag = null, hover = null, brushStroke = null;
let flatCache = new Map();
let mapPreviewCanvas = null;

export function registerMapTool() {
  const onlyMaps = () => state.mode === 'maps';
  registerTool({ id: 'maptile', label: 'Tile brush', icon: '🧱', key: 't', isAvailable: onlyMaps });
  registerTool({ id: 'mapsprite', label: 'Sprite brush', icon: '👾', key: 'p', isAvailable: onlyMaps });
}
export function activeMapDocument() { return activeMap(); }
export function focusMapCanvas(view) {
  view.setContent({ width: MAP_SPAN, height: MAP_SPAN });
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

function mapLayer(map) { return map?.layers.find(l => l.id === state.activeMapLayerId) ?? null; }
function drawingLayer(map, type) {
  const active = mapLayer(map);
  if (active?.type === type && !active.locked) return active;
  const compatible = map?.layers.find(layer => layer.type === type && !layer.locked) ?? null;
  if (compatible && state.activeMapLayerId !== compatible.id) {
    state.activeMapLayerId = compatible.id;
    emit('view');
  }
  return compatible;
}
function mapXY(ev) { return { x: ev.x - MAP_ORIGIN, y: ev.y - MAP_ORIGIN }; }
function sheet(id) { return state.project?.sheets.find(s => s.id === id) ?? null; }
function flatCanvas(s) {
  if (!s) return null;
  const cached = flatCache.get(s.id);
  if (cached?.width === s.width && cached?.height === s.height && cached.gen === state.project) return cached.canvas;
  const bmp = flattenSheet(s);
  const canvas = document.createElement('canvas'); canvas.width = bmp.width; canvas.height = bmp.height;
  canvas.getContext('2d').putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  flatCache.set(s.id, { canvas, width: s.width, height: s.height, gen: state.project });
  return canvas;
}
function snap(map, p, size) {
  const mode = map.snap?.mode ?? 'map';
  if (mode === 'off') return p;
  const w = mode === 'asset' ? Math.max(1, size.w) : Math.max(1, map.snap.gridW);
  const h = mode === 'asset' ? Math.max(1, size.h) : Math.max(1, map.snap.gridH);
  return { x: Math.floor(p.x / w) * w, y: Math.floor(p.y / h) * h };
}
function selectedTile() { const s = sheet(asset.tileSheetId); return { sheet: s, tile: s?.tiles?.find(t => t.id === asset.tileId) ?? null }; }
function selectedTerrain() { const s = sheet(asset.terrainSheetId); return { sheet: s, terrain: s?.terrainSets?.find(t => t.id === asset.terrainSetId) ?? null }; }
function selectedSprite() {
  const s = sheet(asset.spriteSheetId); if (!s) return { sheet: null, item: null, size: { w: 16, h: 16 } };
  const item = asset.spriteKind === 'animation' ? s.animations.find(a => a.id === asset.spriteId) : s.frames.find(f => f.id === asset.spriteId);
  const frame = asset.spriteKind === 'animation' ? s.frames.find(f => f.id === item?.frames?.[0]?.frameId) : item;
  return { sheet: s, item, size: { w: frame?.w ?? 16, h: frame?.h ?? 16 } };
}
function terrainAt(layer, s, terrain, x, y) { return layer.terrain.find(t => t.sheetId === s.id && t.terrainSetId === terrain.id && t.x === x && t.y === y); }
function terrainResolution(layer, s, terrain, x, y) {
  if (!layer || !s || !terrain) return null;
  let mask = 0;
  for (const { dx, dy, bit } of DIRECTION_OFFSETS) {
    if (terrainAt(layer, s, terrain, x + dx * terrain.tileW, y + dy * terrain.tileH)) mask |= bit;
  }
  const slot = resolveTerrainSlot(terrain, maskToBlobIndex[mask]);
  const tile = slot && s.tiles.find(candidate => candidate.id === slot.tileId);
  return tile ? { ...slot, tile } : null;
}
function refreshBounds(map) { return refreshMapBounds(state.project, map); }
function push(label, doIt, undoIt) {
  state.commands.push({
    label,
    do() { doIt(); refreshBounds(activeMap()); markDirty(); emit('map-content'); },
    undo() { undoIt(); refreshBounds(activeMap()); markDirty(); emit('map-content'); },
  });
}

function drawSource(ctx, s, rect, x, y, alpha = 1, transform = null, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  const canvas = flatCanvas(s); if (!canvas || !rect) return;
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
function drawTerrain(ctx, layer, entry, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  const s = sheet(entry.sheetId), terrain = s?.terrainSets?.find(t => t.id === entry.terrainSetId); if (!s || !terrain) return;
  const resolved = terrainResolution(layer, s, terrain, entry.x, entry.y);
  if (resolved) drawSource(ctx, s, resolved.tile, entry.x, entry.y, 1, resolved, offsetX, offsetY);
}
function animationFrame(s, anim) {
  if (!anim?.frames?.length) return null;
  const elapsed = playing ? performance.now() - playStarted : 0;
  let cursor = anim.frames[0]; let t = elapsed;
  const total = anim.frames.reduce((sum, f) => sum + effectiveDuration(anim, f), 0);
  if (anim.loop && total) t %= total;
  for (const f of anim.frames) { cursor = f; const d = effectiveDuration(anim, f); if (t < d) break; t -= d; }
  return s.frames.find(f => f.id === cursor.frameId) ?? null;
}
function drawSprite(ctx, entry, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  const s = sheet(entry.sheetId); if (!s) return;
  const source = entry.kind === 'animation' ? animationFrame(s, s.animations.find(a => a.id === entry.assetId)) : s.frames.find(f => f.id === entry.assetId);
  if (source) drawSource(ctx, s, source, entry.x, entry.y, 1, null, offsetX, offsetY);
}
function drawMapLayers(ctx, map, offsetX = MAP_ORIGIN, offsetY = MAP_ORIGIN) {
  for (const layer of map.layers) {
    if (!layer.visible) continue;
    ctx.save(); ctx.globalAlpha = layer.opacity ?? 1;
    if (layer.type === 'tile') {
      layer.tiles.forEach(entry => { const s = sheet(entry.sheetId); drawSource(ctx, s, s?.tiles?.find(tile => tile.id === entry.tileId), entry.x, entry.y, 1, null, offsetX, offsetY); });
      layer.terrain.forEach(entry => drawTerrain(ctx, layer, entry, offsetX, offsetY));
    } else layer.sprites.forEach(entry => drawSprite(ctx, entry, offsetX, offsetY));
    ctx.restore();
  }
}
export function paintMap(ctx) {
  const map = activeMap();
  // CanvasView content is the 0..MAP_SPAN workspace; map records themselves
  // remain centred around (0, 0), translated by MAP_ORIGIN at render time.
  ctx.fillStyle = '#202128'; ctx.fillRect(0, 0, MAP_SPAN, MAP_SPAN);
  if (!map) return;
  refreshBounds(map);
  drawMapLayers(ctx, map);
  if (playing) requestAnimationFrame(() => emit('view'));
}
export function renderMapPreviewBitmap() {
  const map = activeMap(); if (!map) return null;
  const bounds = refreshBounds(map) ?? DEFAULT_MAP_BOUNDS;
  // Keep pathological/imported maps from allocating an enormous preview
  // bitmap. The whole bounds still render; only the preview raster is scaled.
  const scale = Math.min(1, 2048 / Math.max(1, bounds.w), 2048 / Math.max(1, bounds.h));
  const width = Math.max(1, Math.ceil(bounds.w * scale)), height = Math.max(1, Math.ceil(bounds.h * scale));
  if (!mapPreviewCanvas) mapPreviewCanvas = document.createElement('canvas');
  mapPreviewCanvas.width = width; mapPreviewCanvas.height = height;
  const ctx = mapPreviewCanvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, width, height);
  ctx.scale(scale, scale);
  drawMapLayers(ctx, map, -bounds.x, -bounds.y);
  const image = ctx.getImageData(0, 0, width, height);
  return { width, height, data:new Uint8ClampedArray(image.data) };
}
export function drawMapOverlay(view, ctx) {
  const map = activeMap(); if (!map) return;
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
  if (hover && (state.tool === 'maptile' || state.tool === 'mapsprite')) {
    const preview = brushPreview(map, hover);
    if (preview) {
      const source = flatCanvas(preview.sheet), screen = view.imageToScreen(preview.x + MAP_ORIGIN, preview.y + MAP_ORIGIN);
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
  if (state.selectedMapItemId) { const layer = map.layers.find(l => [...(l.tiles ?? []), ...(l.terrain ?? []), ...(l.sprites ?? [])].some(item => item.id === state.selectedMapItemId)); const item = [...(layer?.tiles ?? []), ...(layer?.terrain ?? []), ...(layer?.sprites ?? [])].find(item => item.id === state.selectedMapItemId); if (item) { const p = view.imageToScreen(item.x + MAP_ORIGIN, item.y + MAP_ORIGIN), size = itemSize(item); ctx.strokeStyle = '#65c8ff'; ctx.lineWidth = 2; ctx.strokeRect(p.x, p.y, size.w * view.zoom, size.h * view.zoom); } }
}
function brushPreview(map, p) {
  if (state.tool === 'maptile') {
    if (asset.tileKind === 'terrain') {
      const { sheet:s, terrain } = selectedTerrain(); if (!s || !terrain) return null;
      const at = snap(map, p, terrain), active = mapLayer(map);
      const layer = active?.type === 'tile' && !active.locked ? active : map.layers.find(candidate => candidate.type === 'tile' && !candidate.locked);
      const resolved = terrainResolution(layer, s, terrain, at.x, at.y);
      return resolved
        ? { sheet:s, rect:resolved.tile, transform:resolved, x:at.x, y:at.y }
        : { sheet:s, rect:null, missing:true, w:terrain.tileW, h:terrain.tileH, x:at.x, y:at.y };
    }
    const { sheet:s, tile } = selectedTile(); if (!s || !tile) return null; const at = snap(map, p, tile); return { sheet:s, rect:tile, x:at.x, y:at.y };
  }
  if (state.tool === 'mapsprite') { const { sheet:s, item } = selectedSprite(); if (!s || !item) return null; const rect = asset.spriteKind === 'animation' ? s.frames.find(f => f.id === item.frames?.[0]?.frameId) : item; if (!rect) return null; const at = snap(map, p, rect); return { sheet:s, rect, x:at.x, y:at.y }; }
  return null;
}
function hitSprite(layer, p) { for (let i = layer.sprites.length - 1; i >= 0; i--) { const e = layer.sprites[i], { size } = (() => { const s = sheet(e.sheetId), f = e.kind === 'animation' ? animationFrame(s, s?.animations.find(a => a.id === e.assetId)) : s?.frames.find(f => f.id === e.assetId); return { size: { w: f?.w ?? 16, h: f?.h ?? 16 } }; })(); if (p.x >= e.x && p.y >= e.y && p.x < e.x + size.w && p.y < e.y + size.h) return e; } return null; }
function hitMapItem(layer, p) {
  if (layer.type === 'sprite') return hitSprite(layer, p);
  for (let i = layer.tiles.length - 1; i >= 0; i--) {
    const item = layer.tiles[i], s = sheet(item.sheetId), tile = s?.tiles.find(t => t.id === item.tileId);
    if (tile && p.x >= item.x && p.y >= item.y && p.x < item.x + tile.w && p.y < item.y + tile.h) return item;
  }
  for (let i = layer.terrain.length - 1; i >= 0; i--) {
    const item = layer.terrain[i], s = sheet(item.sheetId), terrain = s?.terrainSets.find(t => t.id === item.terrainSetId);
    if (terrain && p.x >= item.x && p.y >= item.y && p.x < item.x + terrain.tileW && p.y < item.y + terrain.tileH) return item;
  }
  return null;
}
function itemSize(item) {
  if ('tileId' in item) { const tile = sheet(item.sheetId)?.tiles.find(t => t.id === item.tileId); return { w: tile?.w ?? 16, h: tile?.h ?? 16 }; }
  if ('terrainSetId' in item) { const terrain = sheet(item.sheetId)?.terrainSets.find(t => t.id === item.terrainSetId); return { w: terrain?.tileW ?? 16, h: terrain?.tileH ?? 16 }; }
  const s = sheet(item.sheetId), f = item.kind === 'animation' ? animationFrame(s, s?.animations.find(a => a.id === item.assetId)) : s?.frames.find(a => a.id === item.assetId);
  return { w: f?.w ?? 16, h: f?.h ?? 16 };
}
function brushSpacing(map) {
  if (map.snap?.mode === 'off') return null;
  if (map.snap?.mode !== 'asset') return { w: Math.max(1, map.snap.gridW), h: Math.max(1, map.snap.gridH) };
  if (state.tool === 'maptile' && asset.tileKind === 'terrain') { const { terrain } = selectedTerrain(); return terrain ? { w:terrain.tileW, h:terrain.tileH } : null; }
  if (state.tool === 'maptile') { const { tile } = selectedTile(); return tile ? { w:tile.w, h:tile.h } : null; }
  if (state.tool === 'mapsprite') return selectedSprite().size;
  return null;
}
function strokeSamples(map, from, to) {
  const spacing = brushSpacing(map);
  if (!from || !spacing) return [to];
  const steps = Math.max(1, Math.ceil(Math.abs(to.x - from.x) / spacing.w), Math.ceil(Math.abs(to.y - from.y) / spacing.h));
  return Array.from({ length:steps }, (_, index) => {
    const amount = (index + 1) / steps;
    return { x:from.x + (to.x - from.x) * amount, y:from.y + (to.y - from.y) * amount };
  });
}
function claimStrokeCell(stroke, key) {
  if (!stroke || stroke.visited.has(key)) return false;
  stroke.visited.add(key);
  return true;
}
function applyMapBrush(map, p, button, stroke) {
  const erase = button === 2;
  if (state.tool === 'maptile') {
    const layer = drawingLayer(map, 'tile'); if (!layer) return;
    if (asset.tileKind === 'terrain') {
      const { sheet:s, terrain } = selectedTerrain(); if (!s || !terrain) return;
      const at = snap(map, p, terrain), key = `terrain:${erase ? 'erase' : terrain.id}:${at.x}:${at.y}`;
      if (!claimStrokeCell(stroke, key)) return;
      const old = terrainAt(layer, s, terrain, at.x, at.y);
      if (erase) { if (old) push('erase map terrain', () => layer.terrain.splice(layer.terrain.indexOf(old), 1), () => layer.terrain.push(old)); }
      else if (!old) { const entry={id:newId('mt'),sheetId:s.id,terrainSetId:terrain.id,x:at.x,y:at.y}; push('paint map terrain',()=>layer.terrain.push(entry),()=>layer.terrain.splice(layer.terrain.indexOf(entry),1)); }
      return;
    }
    const { sheet:s, tile } = selectedTile(); if (!s || !tile) return;
    const at = snap(map, p, tile), key = `tile:${erase ? 'erase' : tile.id}:${at.x}:${at.y}`;
    if (!claimStrokeCell(stroke, key)) return;
    const old = layer.tiles.find(entry => entry.x === at.x && entry.y === at.y);
    if (erase) { if (old) push('erase map tile', () => layer.tiles.splice(layer.tiles.indexOf(old), 1), () => layer.tiles.push(old)); }
    else if (old?.sheetId !== s.id || old?.tileId !== tile.id) {
      const entry = { id:newId('mi'), sheetId:s.id, tileId:tile.id, x:at.x, y:at.y };
      push('place map tile', () => { if (old) layer.tiles.splice(layer.tiles.indexOf(old), 1); layer.tiles.push(entry); }, () => { layer.tiles.splice(layer.tiles.indexOf(entry), 1); if (old) layer.tiles.push(old); });
    }
    return;
  }
  if (state.tool === 'mapsprite') {
    const layer = drawingLayer(map, 'sprite'); if (!layer) return;
    if (erase) {
      const old = hitSprite(layer, p), key = old ? `sprite:erase:${old.id}` : `sprite:empty:${Math.floor(p.x)}:${Math.floor(p.y)}`;
      if (!claimStrokeCell(stroke, key)) return;
      if (old) push('erase map sprite', () => layer.sprites.splice(layer.sprites.indexOf(old), 1), () => layer.sprites.push(old));
      return;
    }
    const { sheet:s, item, size } = selectedSprite(); if (!s || !item) return;
    const at = snap(map, p, size), key = `sprite:${item.id}:${at.x}:${at.y}`;
    if (!claimStrokeCell(stroke, key)) return;
    const entry={id:newId('ms'),sheetId:s.id,kind:asset.spriteKind,assetId:item.id,x:at.x,y:at.y};
    push('place map sprite',()=>layer.sprites.push(entry),()=>layer.sprites.splice(layer.sprites.indexOf(entry),1));
  }
}
export function bindMapMode(view) {
  const priorPointer = view.onPointer;
  view.onPointer = ev => {
    if (state.mode !== 'maps') return priorPointer(ev);
    const map = activeMap(), activeLayer = mapLayer(map), p = mapXY(ev); if (!map) return;
    const brushTool = state.tool === 'maptile' || state.tool === 'mapsprite';
    if (ev.type === 'down') {
      if (brushTool) {
        const button = ev.buttons & 2 ? 2 : ev.buttons & 1 ? 1 : 0; if (!button) return;
        hover = p; brushStroke = { tool:state.tool, button, visited:new Set(), lastPoint:p };
        applyMapBrush(map, p, button, brushStroke); view.requestRender(); return;
      }
      if (!activeLayer) return;
      if (state.tool === 'select') { state.selectedMapItemId = hitMapItem(activeLayer, p)?.id ?? null; emit('selection'); return; }
      if (state.tool === 'move') { const item = hitMapItem(activeLayer, p); state.selectedMapItemId = item?.id ?? null; drag = item && !activeLayer.locked ? { item, before: { x:item.x, y:item.y }, size: itemSize(item) } : null; emit('selection'); return; }
    }
    if (ev.type === 'move' && brushTool) {
      hover = p;
      if (brushStroke && brushStroke.tool === state.tool && (ev.buttons & brushStroke.button)) {
        for (const sample of strokeSamples(map, brushStroke.lastPoint, p)) applyMapBrush(map, sample, brushStroke.button, brushStroke);
        brushStroke.lastPoint = p;
      } else if (brushStroke) brushStroke = null;
      view.requestRender(); return;
    }
    if (ev.type === 'up' && brushTool) { brushStroke = null; hover = p; view.requestRender(); return; }
    if (!activeLayer) return;
    if (ev.type === 'move' && drag) { const at=snap(map,p,drag.size); drag.item.x=at.x; drag.item.y=at.y; refreshBounds(map); emit('view'); }
    if (ev.type === 'move' && !drag) { hover = p; view.requestRender(); }
    if (ev.type === 'up' && drag) { const {item,before}=drag, after={x:item.x,y:item.y}; drag=null; if(before.x!==after.x||before.y!==after.y) state.commands.push({label:'move map item',do(){Object.assign(item,after);refreshBounds(map);markDirty();},undo(){Object.assign(item,before);refreshBounds(map);markDirty();}}); }
  };
  document.addEventListener('keydown', e => { if (state.mode !== 'maps' || e.key !== 'Delete' || !state.selectedMapItemId) return; const map=activeMap(), layer=map?.layers.find(l=>[...(l.tiles??[]),...(l.terrain??[]),...(l.sprites??[])].some(x=>x.id===state.selectedMapItemId)), item=[...(layer?.tiles??[]),...(layer?.terrain??[]),...(layer?.sprites??[])].find(x=>x.id===state.selectedMapItemId); if(item) { const collection='tileId' in item?layer.tiles:'terrainSetId' in item?layer.terrain:layer.sprites; push('delete map item',()=>collection.splice(collection.indexOf(item),1),()=>collection.push(item)); state.selectedMapItemId=null; emit('selection'); } });
}

export function mountMapPanel(container) {
  const render = () => {
    if (state.mode !== 'maps') { container.hidden = true; return; } container.hidden = false;
    const map = activeMap(); container.innerHTML = '<h3>Map</h3>';
    if (!map) { container.append('Create or select a map in the top bar.'); return; }
    const row=document.createElement('div');row.className='row';
    const play=document.createElement('button');play.className='btn-sm';play.textContent=playing?'Pause':'Play';play.onclick=()=>{playing=!playing;if(playing)playStarted=performance.now();emit('view');};row.append(play);container.append(row);
    const snapRow=document.createElement('div');snapRow.className='row';snapRow.innerHTML='Snap ';const select=document.createElement('select'); for(const v of ['off','map','asset']){const o=document.createElement('option');o.value=v;o.textContent=v==='off'?'Off':v==='map'?'Map grid':'Asset grid';select.append(o);}select.value=map.snap.mode;select.onchange=()=>{map.snap.mode=select.value;markDirty();};snapRow.append(select); for(const k of ['gridW','gridH']){const i=document.createElement('input');i.type='number';i.min='1';i.value=map.snap[k];i.onchange=()=>{map.snap[k]=Math.max(1,+i.value||1);markDirty();emit('view');};snapRow.append(i);}container.append(snapRow);
  }; on('view',render);on('project',()=>{flatCache.clear();render();});on('selection',render);render();
}

export function mountMapAssetsPanel(container) {
  const addSelect = (label, items, value, set, fmt = x => x.name) => {
    const r = document.createElement('label'); r.className = 'map-brush-source'; r.textContent = `${label} `;
    const q = document.createElement('select');
    for (const it of items) { const o = document.createElement('option'); o.value = it.id; o.textContent = fmt(it); q.append(o); }
    q.value = value; q.onchange = () => { set(q.value); render(); }; r.append(q); container.append(r);
  };
  const addSwatch = (grid, { selected, title, sourceSheet, rect, choose }) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = `map-brush-swatch${selected ? ' active' : ''}`; button.title = title; button.setAttribute('aria-label', title);
    const canvas = document.createElement('canvas'); const scale = Math.max(1, Math.floor(56 / Math.max(rect.w, rect.h))); canvas.width = Math.max(1, rect.w * scale); canvas.height = Math.max(1, rect.h * scale); canvas.className = 'map-brush-thumb';
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; const source = flatCanvas(sourceSheet); if (source) ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, canvas.width, canvas.height);
    const label = document.createElement('span'); label.textContent = title; button.append(canvas, label); button.onclick = () => { choose(); render(); }; grid.append(button);
  };
  const addBrushGrid = () => { const grid = document.createElement('div'); grid.className = 'map-brush-grid'; container.append(grid); return grid; };
  const render=()=>{if(state.mode!=='maps'){container.hidden=true;return;}container.hidden=false;container.innerHTML='<h3>Brushes</h3>';const map=activeMap(),layer=mapLayer(map);if(!map||!layer){container.append('Create a map first.');return;}
    const tiles=state.project.sheets.filter(s=>s.kind==='tile'), sprites=state.project.sheets.filter(s=>s.kind==='sprite');
    if(state.tool==='maptile') {
      const kindRow=document.createElement('div');kindRow.className='map-brush-kind';for(const [value,label] of [['tile','Tiles'],['terrain','Autotiles']]){const b=document.createElement('button');b.type='button';b.className=`btn-sm${asset.tileKind===value?' active':''}`;b.textContent=label;b.onclick=()=>{asset.tileKind=value;render();};kindRow.append(b);}container.append(kindRow);
      if(asset.tileKind==='tile'){ addSelect('Sheet',tiles,asset.tileSheetId,v=>asset.tileSheetId=v); const s=sheet(asset.tileSheetId)||tiles[0];if(s){asset.tileSheetId=s.id;if(!s.tiles.some(t=>t.id===asset.tileId))asset.tileId=s.tiles[0]?.id??'';const grid=addBrushGrid();for(const tile of s.tiles)addSwatch(grid,{selected:asset.tileId===tile.id,title:tile.name??`Tile ${s.tiles.indexOf(tile)+1}`,sourceSheet:s,rect:tile,choose:()=>asset.tileId=tile.id});} }
      else { addSelect('Sheet',tiles,asset.terrainSheetId,v=>asset.terrainSheetId=v); const s=sheet(asset.terrainSheetId)||tiles[0];if(s){asset.terrainSheetId=s.id;if(!s.terrainSets.some(t=>t.id===asset.terrainSetId))asset.terrainSetId=s.terrainSets[0]?.id??'';const grid=addBrushGrid();for(const terrain of s.terrainSets){const tileId=Object.values(terrain.slots??{}).find(Boolean), tile=tileId&&s.tiles.find(t=>t.id===tileId);if(tile)addSwatch(grid,{selected:asset.terrainSetId===terrain.id,title:terrain.name??'Autotile set',sourceSheet:s,rect:tile,choose:()=>asset.terrainSetId=terrain.id});}if(!grid.children.length)grid.textContent='This sheet has no painted autotile brushes yet.';} }
    } else if(state.tool==='mapsprite') {
      addSelect('Sheet',sprites,asset.spriteSheetId,v=>asset.spriteSheetId=v);const s=sheet(asset.spriteSheetId)||sprites[0];if(s){asset.spriteSheetId=s.id;const kindRow=document.createElement('div');kindRow.className='map-brush-kind';for(const [value,label] of [['frame','Frames'],['animation','Animations']]){const b=document.createElement('button');b.type='button';b.className=`btn-sm${asset.spriteKind===value?' active':''}`;b.textContent=label;b.onclick=()=>{asset.spriteKind=value;asset.spriteId='';render();};kindRow.append(b);}container.append(kindRow);const grid=addBrushGrid();const items=asset.spriteKind==='frame'?s.frames:s.animations;if(!items.some(item=>item.id===asset.spriteId))asset.spriteId=items[0]?.id??'';for(const item of items){const frame=asset.spriteKind==='animation'?s.frames.find(f=>f.id===item.frames?.[0]?.frameId):item;if(frame)addSwatch(grid,{selected:asset.spriteId===item.id,title:item.name??(asset.spriteKind==='frame'?`Frame ${s.frames.indexOf(item)+1}`:'Animation'),sourceSheet:s,rect:frame,choose:()=>asset.spriteId=item.id});}}
    } else container.append('Select or move placed items on the active layer.');
  };on('view',render);on('project',render);on('tool',render);render();
}
