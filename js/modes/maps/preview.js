import { getEditorHost } from '../../host/runtime.js';
import { activeMap } from '../../host/document-helpers.js';
import { renderMapPreviewBitmap } from './presentation/map-renderer.js';

export function renderMapPreview() {
  const map = activeMap();
  const bitmap = renderMapPreviewBitmap(getEditorHost().projects.project, map);
  const bounds = map?.bounds;
  return {
    bitmap,
    exactFit: true,
    resetKey: `map:${map?.id ?? ''}:${bounds ? `${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}` : ''}`,
  };
}
