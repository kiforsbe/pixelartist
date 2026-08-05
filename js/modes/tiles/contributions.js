import {
  registerTileTool, bindTileTool, drawTileChrome,
} from './tile-editor-controller.js';
import { registerAutotilePaintTool, bindAutotilePaintTool } from './autotile-paint-controller.js';
import { mountTilePanel } from './tile-panel.js';
import { mountAutotilesPanel } from './autotiles-panel.js';
import { mountTileLayersPanel } from './tile-layers-panel.js';
import { mountTileEditor } from '../../ui/tileeditor.js';
import { renderTilePreview } from './preview.js';

export function registerTileContributions(api) {
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
