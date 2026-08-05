import {
  registerMapTool, bindMapMode, paintMap, drawMapOverlay,
  focusMapCanvas,
} from './map-editor.js';
import { mountMapPanel, mountMapAssetsPanel } from './map-panels.js';
import { renderMapPreview } from './preview.js';

export function registerMapContributions(api) {
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
      mapCanvasView.onPaint = paintMap;
      mapCanvasView.onOverlay = ctx => drawMapOverlay(mapCanvasView, ctx);
      mapCanvasView.canvas.addEventListener('contextmenu', event => event.preventDefault());
      return { view: mapCanvasView, focus: () => focusMapCanvas(mapCanvasView) };
    },
  });
}
