import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './presentation/tile-tool-presenter.js';
import { registerAutotilePaintTool, bindAutotilePaintTool } from './presentation/autotile-paint-presenter.js';
import { mountTilePanel } from './presentation/tile-panel.js';
import { mountAutotilesPanel } from './presentation/terrain-set-panel.js';
import { mountTileLayersPanel } from './presentation/tile-layers-panel.js';
import { mountTileEditor } from './presentation/tile-editor-presenter.js';
import { renderTilePreview } from './preview.js';
import { getEditorHost } from '../../host/runtime.js';
import {
  swapTiles, moveTile, moveStandaloneTile, resizeTile, createTile, deleteTile,
  moveGrid, growTileIntoGrid, resizeGridAxis, addGrid, deleteGrid, setGridCellField,
  detachTile, setTileLayer, renameTile, setTileTags, setTileSize,
} from './application/commands/tile-sheet-commands.js';
import { addTileLayer, removeTileLayer } from './application/commands/tile-layer-commands.js';
import {
  prepareTerrainPaint, paintTerrainStroke, resolveAutotilePaintConflict,
} from './application/commands/autotile-paint-commands.js';
import {
  createTerrainSet, deleteTerrainSet, renameTerrainSet, assignTerrainSlot,
  clearTerrainSlot, setTerrainSymmetry, applyTerrainLayoutPreset, setTerrainSetLayer,
} from './application/commands/terrain-set-commands.js';
import { setTileNeighborSlot } from './application/commands/tile-editor-commands.js';

function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }

function registerTileCommands(api) {
  const whenTiles = keys => keys.modeId === 'tiles';
  api.commands.register({ id: 'tiles.swapTile', when: whenTiles, execute: (_c, { sheetId, aId, bId }) => swapTiles(services(), sheetId, aId, bId) });
  api.commands.register({ id: 'tiles.moveTile', when: whenTiles, execute: (_c, { sheetId, aId, bId }) => moveTile(services(), sheetId, aId, bId) });
  api.commands.register({ id: 'tiles.moveStandaloneTile', when: whenTiles, execute: (_c, { sheetId, tileId, dx, dy }) => moveStandaloneTile(services(), sheetId, tileId, dx, dy) });
  api.commands.register({ id: 'tiles.resizeTile', when: whenTiles, execute: (_c, { sheetId, tileId, before, after }) => resizeTile(services(), sheetId, tileId, before, after) });
  api.commands.register({ id: 'tiles.createTile', when: whenTiles, execute: (_c, { sheetId, rect }) => createTile(services(), sheetId, rect) });
  api.commands.register({ id: 'tiles.deleteTile', when: whenTiles, execute: (_c, { sheetId, tileId }) => deleteTile(services(), sheetId, tileId) });
  api.commands.register({ id: 'tiles.moveGrid', when: whenTiles, execute: (_c, { sheetId, gridId, dx, dy }) => moveGrid(services(), sheetId, gridId, dx, dy) });
  api.commands.register({ id: 'tiles.growTileIntoGrid', when: whenTiles, execute: (_c, { sheetId, tileId, axis, side, count }) => growTileIntoGrid(services(), sheetId, tileId, axis, side, count) });
  api.commands.register({ id: 'tiles.resizeGridAxis', when: whenTiles, execute: (_c, { sheetId, gridId, axis, side, count }) => resizeGridAxis(services(), sheetId, gridId, axis, side, count) });
  api.commands.register({ id: 'tiles.addGrid', when: whenTiles, execute: (_c, { sheetId, opts }) => addGrid(services(), sheetId, opts) });
  api.commands.register({ id: 'tiles.deleteGrid', when: whenTiles, execute: (_c, { sheetId, gridId }) => deleteGrid(services(), sheetId, gridId) });
  api.commands.register({ id: 'tiles.setGridCellField', when: whenTiles, execute: (_c, { sheetId, gridId, key, value }) => setGridCellField(services(), sheetId, gridId, key, value) });
  api.commands.register({ id: 'tiles.detachTile', when: whenTiles, execute: (_c, { sheetId, tileId }) => detachTile(services(), sheetId, tileId) });
  api.commands.register({ id: 'tiles.setTileLayer', when: whenTiles, execute: (_c, { sheetId, tileId, layer }) => setTileLayer(services(), sheetId, tileId, layer) });
  api.commands.register({ id: 'tiles.renameTile', when: whenTiles, execute: (_c, { sheetId, tileId, name }) => renameTile(services(), sheetId, tileId, name) });
  api.commands.register({ id: 'tiles.setTileTags', when: whenTiles, execute: (_c, { sheetId, tileId, tagsText }) => setTileTags(services(), sheetId, tileId, tagsText) });
  api.commands.register({ id: 'tiles.setTileSize', when: whenTiles, execute: (_c, { sheetId, tileId, key, value }) => setTileSize(services(), sheetId, tileId, key, value) });
  api.commands.register({ id: 'tiles.addTileLayer', when: whenTiles, execute: (_c, { sheetId, name }) => addTileLayer(services(), sheetId, name) });
  api.commands.register({ id: 'tiles.removeTileLayer', when: whenTiles, execute: (_c, { sheetId, name }) => removeTileLayer(services(), sheetId, name) });
  api.commands.register({ id: 'tiles.prepareTerrainPaint', when: whenTiles, execute: (_c, { sheetId, terrainSetId }) => prepareTerrainPaint(services(), sheetId, terrainSetId) });
  api.commands.register({ id: 'tiles.paintTerrainStroke', when: whenTiles, execute: (_c, { sheetId, terrainSetId, strokeMasks }) => paintTerrainStroke(services(), sheetId, terrainSetId, strokeMasks) });
  api.commands.register({ id: 'tiles.resolveAutotilePaintConflict', when: whenTiles, execute: (_c, { sheetId, terrainSetId, tileId, blobIndex }) => resolveAutotilePaintConflict(services(), sheetId, terrainSetId, tileId, blobIndex) });
  api.commands.register({ id: 'tiles.createTerrainSet', when: whenTiles, execute: (_c, { sheetId, opts }) => createTerrainSet(services(), sheetId, opts) });
  api.commands.register({ id: 'tiles.deleteTerrainSet', when: whenTiles, execute: (_c, { sheetId, terrainSetId }) => deleteTerrainSet(services(), sheetId, terrainSetId) });
  api.commands.register({ id: 'tiles.renameTerrainSet', when: whenTiles, execute: (_c, { sheetId, terrainSetId, name }) => renameTerrainSet(services(), sheetId, terrainSetId, name) });
  api.commands.register({ id: 'tiles.assignTerrainSlot', when: whenTiles, execute: (_c, { sheetId, terrainSetId, blobIndex, tileId }) => assignTerrainSlot(services(), sheetId, terrainSetId, blobIndex, tileId) });
  api.commands.register({ id: 'tiles.clearTerrainSlot', when: whenTiles, execute: (_c, { sheetId, terrainSetId, blobIndex, tileId }) => clearTerrainSlot(services(), sheetId, terrainSetId, blobIndex, tileId) });
  api.commands.register({ id: 'tiles.setTerrainSymmetry', when: whenTiles, execute: (_c, { sheetId, terrainSetId, key, value }) => setTerrainSymmetry(services(), sheetId, terrainSetId, key, value) });
  api.commands.register({ id: 'tiles.applyTerrainLayoutPreset', when: whenTiles, execute: (_c, { sheetId, terrainSetId, preset, sourceTileIds, cols }) => applyTerrainLayoutPreset(services(), sheetId, terrainSetId, preset, sourceTileIds, cols) });
  api.commands.register({ id: 'tiles.setTerrainSetLayer', when: whenTiles, execute: (_c, { sheetId, terrainSetId, layer }) => setTerrainSetLayer(services(), sheetId, terrainSetId, layer) });
  api.commands.register({ id: 'tiles.setTileNeighborSlot', when: whenTiles, execute: (_c, { sheetId, tileId, dir, slot }) => setTileNeighborSlot(services(), sheetId, tileId, dir, slot) });
}

export function registerTileContributions(api) {
  registerTileCommands(api);
  api.previews.register({ id: 'tiles.preview', order: 20, when: keys => keys.modeId === 'tiles', render: renderTilePreview });
  api.tools.register({
    id: 'tiles.edit-tools', label: 'Tile editing tools', order: 20,
    createController({ canvasView }) {
      registerTileTool();
      registerAutotilePaintTool();
      bindTileTool(canvasView);
      bindAutotilePaintTool(canvasView);
      return {
        decorateOverlay() {
          const prior = canvasView.onOverlay;
          canvasView.onOverlay = ctx => { prior(ctx); drawTileChrome(ctx, canvasView); };
        },
      };
    },
  });

  const whenTiles = keys => keys.modeId === 'tiles';
  api.panels.register({ id: 'tiles.tiles', title: 'Tiles', region: 'right', order: 30, mountPoint: 'panel-context', persistent: true, when: whenTiles, create: mountTilePanel });
  api.panels.register({ id: 'tiles.autotiles', title: 'Autotiles', region: 'right', order: 40, mountPoint: 'panel-autotiles', persistent: true, when: whenTiles, create: mountAutotilesPanel });
  api.panels.register({ id: 'tiles.layers', title: 'Tile Layers', region: 'right', order: 50, mountPoint: 'panel-tilelayers', persistent: true, when: whenTiles, create: mountTileLayersPanel });

  api.views.register({ id: 'tiles.sheet', order: 30, create: (_host, { canvasView }) => ({ view: canvasView }) });
  api.views.register({ id: 'tiles.tile', order: 40, create: (_host, { canvasHost }) => mountTileEditor(canvasHost) });
}
