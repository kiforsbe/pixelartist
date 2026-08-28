import { getEditorHost } from '../../host/runtime.js';
import { activeMap } from '../../host/document-helpers.js';
import { registerMapTool, bindMapMode, mapHoverPoint } from './presentation/map-tool-presenter.js';
import { paintMap, drawMapOverlay, focusMapCanvas } from './presentation/map-renderer.js';
import { mountMapPanel } from './presentation/map-panel.js';
import { mountMapAssetsPanel } from './presentation/map-assets-panel.js';
import { renderMapPreview } from './preview.js';
import {
  paintMapTile, eraseMapTile, paintMapTerrain, eraseMapTerrain, paintMapSprite, eraseMapSprite,
  moveMapItem, deleteMapItem,
} from './application/commands/map-paint-commands.js';
import { addMapLayer, deleteMapLayer, renameMapLayer, setMapLayerOpacity } from './application/commands/map-layer-commands.js';
import { editPaletteColor, remapPaletteColor } from './application/commands/palette-commands.js';

function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }

// Registered by id so map-tool-presenter.js (presentation/) can dispatch
// through getEditorHost().registries.commands.execute(id, context, args)
// instead of importing these Command Handlers directly — this file lives
// outside presentation/, so importing application/commands/ here is fine;
// tests/architecture.test.mjs only bans that import from presentation/**.
function registerMapCommands(api) {
  const whenMaps = keys => keys.modeId === 'maps';
  api.commands.register({ id: 'maps.paintTile', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, tileId, at }) => paintMapTile(services(), mapId, layerId, sheetId, tileId, at) });
  api.commands.register({ id: 'maps.eraseTile', when: whenMaps, execute: (_context, { mapId, layerId, at }) => eraseMapTile(services(), mapId, layerId, at) });
  api.commands.register({ id: 'maps.paintTerrain', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, terrainSetId, at }) => paintMapTerrain(services(), mapId, layerId, sheetId, terrainSetId, at) });
  api.commands.register({ id: 'maps.eraseTerrain', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, terrainSetId, at }) => eraseMapTerrain(services(), mapId, layerId, sheetId, terrainSetId, at) });
  api.commands.register({ id: 'maps.paintSprite', when: whenMaps, execute: (_context, { mapId, layerId, sheetId, kind, assetId, at }) => paintMapSprite(services(), mapId, layerId, sheetId, kind, assetId, at) });
  api.commands.register({ id: 'maps.eraseSprite', when: whenMaps, execute: (_context, { mapId, layerId, itemId }) => eraseMapSprite(services(), mapId, layerId, itemId) });
  api.commands.register({ id: 'maps.moveItem', when: whenMaps, execute: (_context, { mapId, layerId, itemId, before, after }) => moveMapItem(services(), mapId, layerId, itemId, before, after) });
  api.commands.register({ id: 'maps.deleteItem', when: whenMaps, execute: (_context, { mapId, layerId, itemId }) => deleteMapItem(services(), mapId, layerId, itemId) });
  api.commands.register({ id: 'maps.addLayer', when: whenMaps, execute: (_context, { mapId, type }) => addMapLayer(services(), mapId, type) });
  api.commands.register({ id: 'maps.deleteLayer', when: whenMaps, execute: (_context, { mapId, layerId }) => deleteMapLayer(services(), mapId, layerId) });
  api.commands.register({ id: 'maps.renameLayer', when: whenMaps, execute: (_context, { mapId, layerId, name }) => renameMapLayer(services(), mapId, layerId, name) });
  api.commands.register({ id: 'maps.setLayerOpacity', when: whenMaps, execute: (_context, { mapId, layerId, opacity }) => setMapLayerOpacity(services(), mapId, layerId, opacity) });
  api.commands.register({ id: 'maps.editPaletteColor', when: whenMaps, execute: (_context, { index, color }) => editPaletteColor(services(), index, color) });
  api.commands.register({ id: 'maps.remapPaletteColor', when: whenMaps, execute: (_context, { index, color }) => remapPaletteColor(services(), index, color) });
}

export function registerMapContributions(api) {
  registerMapCommands(api);

  api.previews.register({ id: 'maps.preview', order: 30, when: keys => keys.modeId === 'maps', render: renderMapPreview });

  api.tools.register({
    id: 'maps.placement-tools', label: 'Map placement tools', order: 30,
    createController({ mapCanvasView }) {
      registerMapTool();
      bindMapMode(mapCanvasView);
      return {};
    },
  });

  const whenMaps = keys => keys.modeId === 'maps';
  api.panels.register({ id: 'maps.properties', title: 'Map', region: 'right', order: 60, mountPoint: 'panel-context', persistent: true, when: whenMaps, create: mountMapPanel });
  api.panels.register({ id: 'maps.assets', title: 'Map Assets', region: 'right', order: 70, mountPoint: 'panel-map-assets', persistent: true, when: whenMaps, create: mountMapAssetsPanel });

  api.views.register({
    id: 'maps.canvas', order: 50,
    create(_host, { mapCanvasView }) {
      mapCanvasView.onPaint = ctx => paintMap(ctx, getEditorHost().projects.project, activeMap(), () => mapCanvasView.requestRender());
      mapCanvasView.onOverlay = ctx => {
        const map = activeMap(); if (!map) return;
        const host = getEditorHost();
        const selection = host.selections.get({ kind: 'map', id: map.id }) ?? {};
        drawMapOverlay(mapCanvasView, ctx, host.projects.project, map, {
          tool: host.store.getState().session.activeToolId, hover: mapHoverPoint(), selectedItemId: selection.mapItemId, activeLayerId: selection.layerId,
        });
      };
      mapCanvasView.canvas.addEventListener('contextmenu', event => event.preventDefault());
      return { view: mapCanvasView, focus: () => focusMapCanvas(mapCanvasView) };
    },
  });
}
