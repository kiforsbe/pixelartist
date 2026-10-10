// js/components/layout-dispatch.js
// Dispatches a layout-changing command for presentation code in either
// workbench. Settles a pending float first (the layout may move the pixels
// under it) and explains a refusal. A needsSize refusal is the caller's to
// handle: it asks the user for a canvas size instead.
import { getEditorHost } from '../host/runtime.js';
import { commitFloatIfAny } from './canvas/float-session.js';

export function dispatchLayout(id, args) {
  commitFloatIfAny();
  const host = getEditorHost();
  const result = host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
  if (result?.ok === false && result.reason && !result.needsSize && typeof alert !== 'undefined') alert(result.reason);
  return result;
}
