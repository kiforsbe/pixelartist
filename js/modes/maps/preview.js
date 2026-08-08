import { state, activeMap } from '../../app/state.js';
import { renderMapPreviewBitmap } from './presentation/map-renderer.js';

export function renderMapPreview() {
  const map = activeMap();
  const bitmap = renderMapPreviewBitmap(state.project, map);
  const bounds = map?.bounds;
  return {
    bitmap,
    exactFit: true,
    resetKey: `map:${state.activeMapId ?? ''}:${bounds ? `${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}` : ''}`,
  };
}
