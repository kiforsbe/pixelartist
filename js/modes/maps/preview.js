import { state, activeMap } from '../../app/state.js';
import { renderMapPreviewBitmap } from './map-editor.js';

export function renderMapPreview() {
  const bitmap = renderMapPreviewBitmap();
  const map = activeMap();
  const bounds = map?.bounds;
  return {
    bitmap,
    exactFit: true,
    resetKey: `map:${state.activeMapId ?? ''}:${bounds ? `${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}` : ''}`,
  };
}
