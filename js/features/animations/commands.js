// js/features/animations/commands.js
// Legacy façade: js/ui/timeline.js and js/ui/tools.js still call these two by
// import. The handlers themselves now live in js/modes/sprites/application/
// commands/animation-commands.js and are registered as host Commands by
// js/modes/sprites/contributions.js, so this file only dispatches by id —
// shared UI must never import a mode's command handlers directly. Delete this
// file once both callers dispatch for themselves (sub-phase 2b/2c).
import { activeSheet } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';

// Context is pinned to 'sprites' rather than the live state.mode: both of
// these are inherently sprite-sheet operations (the caller already resolved a
// sprite sheet), and the registered commands' `when` predicate requires it.
function dispatch(id, args) {
  return getEditorHost()?.registries.commands.execute(id, { modeId: 'sprites' }, args);
}

export function commitBreakApartStrip(animation) {
  const sheet = activeSheet();
  if (!sheet || !animation) return;
  dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: animation.id });
}

export function commitAcceptAnimation(sheet, animation) {
  if (!sheet || !animation) return;
  dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: animation.id });
}
