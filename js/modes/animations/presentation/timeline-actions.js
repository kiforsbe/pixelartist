// js/modes/animations/presentation/timeline-actions.js
// The Animations timeline's operations as actions (animations.timeline.*,
// js/features/shell/actions.js), so its context menus, keyboard shortcuts
// and any button act through one definition each -- spec
// docs/superpowers/specs/2026-10-10-timeline-dock-dragdrop-design.md §5.
//
// The presenter (animation-timeline-presenter.js) owns the state and the
// gestures; it hands defineTimelineActions a controller:
//   active()   -> the Animations workbench is the active mode
//   state()    -> { anim, range: { anim, from, to, column } | null, layer, linked, playing }
//                 (layer: the selected layer node, linked: the selected
//                 column's frame is used more than once)
//   and one method per operation (togglePlay, step, duplicate, ...).
// Frame-creating operations on a manual animation stay enabled: the
// presenter offers the auto layout first (its ensureAuto/settleOffer flow).
import { defineAction, runAction } from '../../../features/shell/actions.js';
import { isTypingTarget } from '../../../components/dom-utils.js';

const ID = name => `animations.timeline.${name}`;

export const TIMELINE_DIRECTIONS = [
  { name: 'forward', direction: 'forward', label: 'Forward' },
  { name: 'reverse', direction: 'reverse', label: 'Reverse' },
  { name: 'pingpong', direction: 'pingpong', label: 'Ping-pong' },
  { name: 'pingpongReverse', direction: 'pingpong-reverse', label: 'Ping-pong Reverse' },
];

// Alt+letter shortcuts by physical key (e.code), since Alt changes e.key on
// some layouts (macOS Option+N types '˜').
const ALT_CODES = {
  KeyN: ID('duplicate'),
  KeyB: ID('insertBlank'),
  KeyM: ID('insertLinked'),
  KeyC: ID('delete'),
  KeyI: ID('reverse'),
};

// The action a keydown asks for, or null. Gating (focus, mode, dialogs) is
// shortcutBlocked's job and the window handler's.
export function timelineShortcut(e) {
  if (e.ctrlKey || e.metaKey) return null;
  if (e.altKey) return e.shiftKey ? null : ALT_CODES[e.code] ?? null;
  if (e.shiftKey) return null;
  if (e.key === 'Enter') return ID('playStop');
  if (e.key === ',') return ID('prevFrame');
  if (e.key === '.') return ID('nextFrame');
  return null;
}

const BUTTON_LIKE = 'button,a,select,summary,[role="button"],[role="menuitem"]';
const buttonLike = el => !!el?.closest?.(BUTTON_LIKE);

// True when a shortcut must not fire: typing into a field (or a dialog has
// focus), a modal dialog or context menu is open (`overlayOpen`), or Enter
// would also press a focused button or link.
export function shortcutBlocked(e, { activeElement = null, overlayOpen = false } = {}) {
  if (overlayOpen) return true;
  if (isTypingTarget(e.target) || isTypingTarget(activeElement)) return true;
  return e.key === 'Enter' && (buttonLike(e.target) || buttonLike(activeElement));
}

// One window keydown handler for every timeline shortcut, active only while
// the Animations workbench is the active mode. Returns dispose().
export function attachTimelineShortcuts(timeline) {
  const onKeyDown = (e) => {
    if (e.defaultPrevented || !timeline.active()) return;
    const id = timelineShortcut(e);
    if (!id || (e.repeat && id === ID('playStop'))) return;
    const overlayOpen = !!document.querySelector?.('dialog[open], .context-menu');
    if (shortcutBlocked(e, { activeElement: document.activeElement, overlayOpen })) return;
    e.preventDefault();
    runAction(id);
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

// Context-menu item lists (action ids; js/components/context-menu.js).
export const FRAME_MENU = [
  { action: ID('duration') },
  { separator: true },
  { action: ID('insertBlank') },
  { action: ID('duplicate') },
  { action: ID('insertLinked') },
  { action: ID('unlink') },
  { separator: true },
  { action: ID('reverse') },
  { action: ID('delete') },
];
export const CEL_MENU = [{ action: ID('clearCel') }, { separator: true }, ...FRAME_MENU];
export const TAG_MENU = [
  { action: ID('renameTag') },
  { action: ID('direction') },
  { action: ID('color') },
  { action: ID('clearColor') },
  { action: ID('loop') },
  { separator: true },
  { action: ID('duplicateAnimation') },
  { action: ID('autoLayout') },
  { action: ID('makeManual') },
  { separator: true },
  { action: ID('deleteAnimation') },
];

// Registers every animations.timeline.* action against the presenter's
// controller `t` (re-mounting replaces them).
export function defineTimelineActions(t) {
  const anim = () => t.state().anim;
  const range = () => t.state().range;
  const hasFrames = () => !!anim()?.frames.length;
  const define = (name, def) => defineAction(ID(name), { isAvailable: () => t.active(), ...def });

  define('playStop', { label: 'Play / Stop', shortcut: 'Enter', isEnabled: hasFrames, run: () => t.togglePlay() });
  define('prevFrame', { label: 'Previous Frame', shortcut: ',', isEnabled: hasFrames, run: () => t.step(-1) });
  define('nextFrame', { label: 'Next Frame', shortcut: '.', isEnabled: hasFrames, run: () => t.step(1) });

  define('duration', { label: 'Frame Duration…', isEnabled: () => !!range(), run: () => t.focusDuration() });
  define('insertBlank', { label: 'Insert Blank Frame', shortcut: 'Alt+B', isEnabled: () => !!anim(), run: () => t.insertBlank() });
  define('duplicate', { label: 'Duplicate Frames', shortcut: 'Alt+N', isEnabled: () => !!range(), run: () => t.duplicate() });
  define('insertLinked', { label: 'Insert Linked Frame', shortcut: 'Alt+M', isEnabled: () => !!range(), run: () => t.insertLinked() });
  define('unlink', { label: 'Unlink Frame', isEnabled: () => !!range() && t.state().linked, run: () => t.unlink() });
  define('reverse', {
    label: 'Reverse Frames', shortcut: 'Alt+I',
    isEnabled: () => { const r = range(); return !!r && r.to > r.from; },
    run: () => t.reverse(),
  });
  define('delete', { label: 'Delete Frames', shortcut: 'Alt+C', isEnabled: () => !!range(), run: () => t.deleteFrames() });
  define('clearCel', {
    label: 'Clear Cel',
    isEnabled: () => { const { range: r, layer } = t.state(); return !!r && layer?.type === 'layer' && !layer.locked; },
    run: () => t.clearCel(),
  });

  define('renameTag', { label: 'Rename Animation…', isEnabled: hasFrames, run: () => t.renameTag() });
  define('setDirection', { label: 'Set Direction', isEnabled: () => !!anim(), run: (_ctx, direction) => t.setDirection(direction) });
  for (const { name, direction, label } of TIMELINE_DIRECTIONS) {
    define(`direction.${name}`, {
      label, isEnabled: () => !!anim(),
      isChecked: () => (anim()?.direction ?? 'forward') === direction,
      run: () => t.setDirection(direction),
    });
  }
  define('direction', {
    label: 'Direction', isEnabled: () => !!anim(),
    submenu: TIMELINE_DIRECTIONS.map(({ name }) => ({ action: ID(`direction.${name}`) })),
  });
  define('color', { label: 'Colour…', isEnabled: () => !!anim(), run: () => t.pickColor() });
  define('clearColor', { label: 'No Colour', isEnabled: () => !!anim()?.color, run: () => t.setColor(null) });
  define('loop', { label: 'Loop', isEnabled: () => !!anim(), isChecked: () => !!anim()?.loop, run: () => t.toggleLoop() });
  define('duplicateAnimation', { label: 'Duplicate Animation', isEnabled: () => !!anim(), run: () => t.duplicateAnimation() });
  defineAction(ID('autoLayout'), {
    label: 'Auto-layout', isAvailable: () => t.active() && anim()?.layout !== 'auto',
    isEnabled: () => !!anim(), run: () => t.autoLayout(),
  });
  defineAction(ID('makeManual'), {
    label: 'Make Manual', isAvailable: () => t.active() && anim()?.layout === 'auto',
    run: () => t.makeManual(),
  });
  define('deleteAnimation', { label: 'Delete Animation', isEnabled: () => !!anim(), run: () => t.deleteAnimation() });
}
