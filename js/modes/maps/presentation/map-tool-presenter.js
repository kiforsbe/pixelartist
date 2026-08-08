// js/modes/maps/presentation/map-tool-presenter.js
import { state, emit, activeMap, markDirty } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { registerTool } from '../../../ui/tools.js';
import {
  mapXY, snap, selectedTile, selectedTerrain, selectedSprite, itemSize,
  hitMapItem, brushSpacing, strokeSamples, claimStrokeCell,
} from '../application/map-geometry.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';

let drag = null, brushStroke = null;

function mapDocument(map) { return { kind: 'map', id: map.id }; }
function currentSelection(map) { return getEditorHost().selections.get(mapDocument(map)) ?? {}; }
function setLayer(map, layerId) { getEditorHost().selections.set({ ...currentSelection(map), layerId }, mapDocument(map)); }
function setItem(map, mapItemId) { getEditorHost().selections.set({ ...currentSelection(map), mapItemId }, mapDocument(map)); }

function drawingLayer(map, type) {
  const activeId = currentSelection(map).layerId;
  const active = map?.layers.find(l => l.id === activeId) ?? null;
  if (active?.type === type && !active.locked) return active;
  const compatible = map?.layers.find(layer => layer.type === type && !layer.locked) ?? null;
  if (compatible && activeId !== compatible.id) setLayer(map, compatible.id);
  return compatible;
}

export function registerMapTool() {
  const onlyMaps = () => state.mode === 'maps';
  registerTool({ id: 'maptile', label: 'Tile brush', icon: '🧱', key: 't', isAvailable: onlyMaps });
  registerTool({ id: 'mapsprite', label: 'Sprite brush', icon: '👾', key: 'p', isAvailable: onlyMaps });
}

// Dispatches a Task 3/4 Command Handler by id (registered in contributions.js,
// Task 8) rather than importing it directly — this Presenter lives under
// presentation/, and tests/architecture.test.mjs bans presentation-layer code
// from importing anything under application/commands/.
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }

function applyMapBrush(map, project, p, button, stroke) {
  const erase = button === 2;
  if (state.tool === 'maptile') {
    const layer = drawingLayer(map, 'tile'); if (!layer) return;
    if (asset.tileKind === 'terrain') {
      const { sheet, terrain } = selectedTerrain(project, asset); if (!sheet || !terrain) return;
      const at = snap(map, p, terrain), key = `terrain:${erase ? 'erase' : terrain.id}:${at.x}:${at.y}`;
      if (!claimStrokeCell(stroke, key)) return;
      if (erase) dispatch('maps.eraseTerrain', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, terrainSetId: terrain.id, at });
      else dispatch('maps.paintTerrain', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, terrainSetId: terrain.id, at });
      return;
    }
    const { sheet, tile } = selectedTile(project, asset); if (!sheet || !tile) return;
    const at = snap(map, p, tile), key = `tile:${erase ? 'erase' : tile.id}:${at.x}:${at.y}`;
    if (!claimStrokeCell(stroke, key)) return;
    if (erase) dispatch('maps.eraseTile', { mapId: map.id, layerId: layer.id, at });
    else dispatch('maps.paintTile', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, tileId: tile.id, at });
    return;
  }
  if (state.tool === 'mapsprite') {
    const layer = drawingLayer(map, 'sprite'); if (!layer) return;
    if (erase) {
      const hit = hitMapItem(project, layer, p), key = hit ? `sprite:erase:${hit.id}` : `sprite:empty:${Math.floor(p.x)}:${Math.floor(p.y)}`;
      if (!claimStrokeCell(stroke, key)) return;
      if (hit) dispatch('maps.eraseSprite', { mapId: map.id, layerId: layer.id, itemId: hit.id });
      return;
    }
    const { sheet, item, size } = selectedSprite(project, asset); if (!sheet || !item) return;
    const at = snap(map, p, size), key = `sprite:${item.id}:${at.x}:${at.y}`;
    if (!claimStrokeCell(stroke, key)) return;
    dispatch('maps.paintSprite', { mapId: map.id, layerId: layer.id, sheetId: sheet.id, kind: asset.spriteKind, assetId: item.id, at });
  }
}

export function bindMapMode(view) {
  const priorPointer = view.onPointer;
  view.onPointer = ev => {
    if (state.mode !== 'maps') return priorPointer(ev);
    const map = activeMap(), project = state.project; if (!map) return;
    const selection = currentSelection(map);
    const activeLayer = map.layers.find(l => l.id === selection.layerId) ?? null;
    const p = mapXY(ev);
    const brushTool = state.tool === 'maptile' || state.tool === 'mapsprite';
    if (ev.type === 'down') {
      if (brushTool) {
        const button = ev.buttons & 2 ? 2 : ev.buttons & 1 ? 1 : 0; if (!button) return;
        brushStroke = { tool: state.tool, button, visited: new Set(), lastPoint: p };
        applyMapBrush(map, project, p, button, brushStroke); view.requestRender(); return;
      }
      if (!activeLayer) return;
      if (state.tool === 'select') { setItem(map, hitMapItem(project, activeLayer, p)?.id ?? null); emit('selection'); return; }
      if (state.tool === 'move') {
        const item = hitMapItem(project, activeLayer, p);
        setItem(map, item?.id ?? null);
        drag = item && !activeLayer.locked ? { item, before: { x: item.x, y: item.y }, size: itemSize(project, item) } : null;
        emit('selection'); return;
      }
    }
    if (ev.type === 'move' && brushTool) {
      if (brushStroke && brushStroke.tool === state.tool && (ev.buttons & brushStroke.button)) {
        const spacing = brushSpacing(map, state.tool, asset, project);
        for (const sample of strokeSamples(map, brushStroke.lastPoint, p, spacing)) applyMapBrush(map, project, sample, brushStroke.button, brushStroke);
        brushStroke.lastPoint = p;
      } else if (brushStroke) brushStroke = null;
      view.requestRender(); return;
    }
    if (ev.type === 'up' && brushTool) { brushStroke = null; view.requestRender(); return; }
    if (!activeLayer) return;
    if (ev.type === 'move' && drag) { const at = snap(map, p, drag.size); drag.item.x = at.x; drag.item.y = at.y; emit('view'); }
    if (ev.type === 'move' && !drag) { view.requestRender(); }
    if (ev.type === 'up' && drag) {
      const { item, before } = drag, after = { x: item.x, y: item.y }; drag = null;
      if (before.x !== after.x || before.y !== after.y) dispatch('maps.moveItem', { mapId: map.id, layerId: activeLayer.id, itemId: item.id, before, after });
    }
  };
  document.addEventListener('keydown', e => {
    if (state.mode !== 'maps' || e.key !== 'Delete') return;
    const map = activeMap(); if (!map) return;
    const selection = currentSelection(map);
    if (!selection.mapItemId) return;
    const layer = map.layers.find(l => [...(l.tiles ?? []), ...(l.terrain ?? []), ...(l.sprites ?? [])].some(x => x.id === selection.mapItemId));
    if (!layer) return;
    dispatch('maps.deleteItem', { mapId: map.id, layerId: layer.id, itemId: selection.mapItemId });
    setItem(map, null);
    emit('selection');
  });
}
