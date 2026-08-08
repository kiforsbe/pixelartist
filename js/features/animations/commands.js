// js/features/animations/commands.js
// Legacy façade: js/ui/tools.js still calls commitAcceptAnimation by import,
// and js/ui/panels.js (the Layers panel) still calls commitDeleteAnimation by
// import. The handlers themselves live in js/modes/sprites/application/
// commands/{animation-commands,animation-lifecycle-commands}.js and are
// registered as host Commands by js/modes/sprites/contributions.js, so this
// file only dispatches by id — shared UI must never import a mode's command
// handlers directly. Delete this file once both remaining callers dispatch
// for themselves.
import { getEditorHost } from '../../host/runtime.js';

// Context is pinned to 'sprites' rather than the live state.mode: both of
// these are inherently sprite-sheet operations (the caller already resolved a
// sprite sheet), and the registered commands' `when` predicate requires it.
function dispatch(id, args) {
  return getEditorHost()?.registries.commands.execute(id, { modeId: 'sprites' }, args);
}

export function commitAcceptAnimation(sheet, animation) {
  if (!sheet || !animation) return;
  dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: animation.id });
}

export function commitDeleteAnimation(sheet, animId) {
  if (!sheet || !animId) return;
  dispatch('sprites.deleteAnimation', { sheetId: sheet.id, animationId: animId });
}
