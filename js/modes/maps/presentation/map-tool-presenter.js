// js/modes/maps/presentation/map-tool-presenter.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeMap } from '../../../host/document-helpers.js';
import { registerTool } from '../../../components/tool-palette.js';
import { isTypingTarget } from '../../../components/dom-utils.js';
import { bindDragCancelGuard } from '../../../components/canvas/drag-cancel-guard.js';
import {
  mapXY, snap, selectedTile, selectedTerrain, selectedSprite, itemSize,
  hitMapItem, brushSpacing, strokeSamples, claimStrokeCell,
} from '../application/map-geometry.js';
import { mapBrushState as asset } from '../application/map-brush-state.js';

let drag = null, brushStroke = null;
let hover = null;
export function mapHoverPoint() { return hover; }

function currentModeId() { return getEditorHost().store.getState().session.activeModeId; }
function currentToolId() { return getEditorHost().store.getState().session.activeToolId; }

// bindDragCancelGuard (components/canvas/drag-cancel-guard.js) is shared,
// out-of-this-task's-scope code that expects a legacy `on(event, handler) =>
// dispose` subscribe function; it only ever asks for 'project'/'tool'. This
// adapts those two events to the host store so this file needs no import
// from the legacy state module to keep using it.
function storeOn(event, handler) {
  const store = getEditorHost().store;
  if (event === 'project') return store.subscribe(s => s.project.model, handler);
  if (event === 'tool') return store.subscribe(s => s.session.activeToolId, handler);
  throw new Error(`storeOn: unsupported event "${event}"`);
}

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
  const onlyMaps = () => currentModeId() === 'maps';
  registerTool({ id: 'maptile', label: 'Tile brush', icon: '🧱', key: 't', isAvailable: onlyMaps });
  registerTool({ id: 'mapsprite', label: 'Sprite brush', icon: '👾', key: 'p', isAvailable: onlyMaps });
}

// Dispatches a Task 3/4 Command Handler by id (registered in contributions.js,
// Task 8) rather than importing it directly — this Presenter lives under
// presentation/, and tests/architecture.test.mjs bans presentation-layer code
// from importing anything under application/commands/.
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: currentModeId() }, args); }

function applyMapBrush(map, project, p, button, stroke) {
  const erase = button === 2;
  if (currentToolId() === 'maptile') {
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
  if (currentToolId() === 'mapsprite') {
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
    if (currentModeId() !== 'maps') return priorPointer(ev);
    const map = activeMap(), project = getEditorHost().projects.project; if (!map) return;
    const selection = currentSelection(map);
    const activeLayer = map.layers.find(l => l.id === selection.layerId) ?? null;
    const p = mapXY(ev);
    const tool = currentToolId();
    const brushTool = tool === 'maptile' || tool === 'mapsprite';
    if (ev.type === 'down') {
      hover = p;
      if (brushTool) {
        const button = ev.buttons & 2 ? 2 : ev.buttons & 1 ? 1 : 0; if (!button) return;
        brushStroke = { tool, button, visited: new Set(), lastPoint: p };
        applyMapBrush(map, project, p, button, brushStroke); view.requestRender(); return;
      }
      if (!activeLayer) return;
      // setItem() already routes through getEditorHost().selections.set(),
      // which repaints any panel using mountStorePanel with a selection
      // selector; view.requestRender() (replacing the old emit('selection'))
      // is what makes THIS canvas's own selection-highlight overlay repaint
      // immediately instead of waiting for the next pointermove.
      if (tool === 'select') { setItem(map, hitMapItem(project, activeLayer, p)?.id ?? null); view.requestRender(); return; }
      if (tool === 'move') {
        const item = hitMapItem(project, activeLayer, p);
        setItem(map, item?.id ?? null);
        drag = item && !activeLayer.locked ? { item, before: { x: item.x, y: item.y }, size: itemSize(project, item) } : null;
        view.requestRender(); return;
      }
    }
    if (ev.type === 'move' && brushTool) {
      hover = p;
      if (brushStroke && brushStroke.tool === tool && (ev.buttons & brushStroke.button)) {
        const spacing = brushSpacing(map, tool, asset, project);
        for (const sample of strokeSamples(map, brushStroke.lastPoint, p, spacing)) applyMapBrush(map, project, sample, brushStroke.button, brushStroke);
        brushStroke.lastPoint = p;
      } else if (brushStroke) brushStroke = null;
      view.requestRender(); return;
    }
    if (ev.type === 'up' && brushTool) { brushStroke = null; hover = p; view.requestRender(); return; }
    if (!activeLayer) return;
    // view.requestRender() (replacing the old emit('view')) drives the live
    // drag preview directly -- nothing on the legacy bus ever repainted this
    // mapCanvasView from a bare 'view' emit (only project.model/activeViewId
    // changes do, via editor-workbench.js's refreshCanvasView).
    if (ev.type === 'move' && drag) { const at = snap(map, p, drag.size); drag.item.x = at.x; drag.item.y = at.y; view.requestRender(); }
    if (ev.type === 'move' && !drag) { hover = p; view.requestRender(); }
    if (ev.type === 'up' && drag) {
      const { item, before } = drag, after = { x: item.x, y: item.y }; drag = null;
      if (before.x !== after.x || before.y !== after.y) dispatch('maps.moveItem', { mapId: map.id, layerId: activeLayer.id, itemId: item.id, before, after });
    }
  };

  bindDragCancelGuard(storeOn, {
    isToolActive: () => currentToolId() === 'move',
    hasDrag: () => !!drag,
    cancel: () => { drag = null; },
    requestRender: () => view.requestRender(),
  });
  bindDragCancelGuard(storeOn, {
    isToolActive: () => { const tool = currentToolId(); return tool === 'maptile' || tool === 'mapsprite'; },
    hasDrag: () => !!brushStroke,
    cancel: () => { brushStroke = null; },
    requestRender: () => view.requestRender(),
  });

  document.addEventListener('keydown', e => {
    if (currentModeId() !== 'maps' || e.key !== 'Delete') return;
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    const map = activeMap(); if (!map) return;
    const selection = currentSelection(map);
    if (!selection.mapItemId) return;
    const layer = map.layers.find(l => [...(l.tiles ?? []), ...(l.terrain ?? []), ...(l.sprites ?? [])].some(x => x.id === selection.mapItemId));
    if (!layer) return;
    dispatch('maps.deleteItem', { mapId: map.id, layerId: layer.id, itemId: selection.mapItemId });
    setItem(map, null);
    view.requestRender();
  });
}
