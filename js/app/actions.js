// Central registry for anything triggerable from more than one UI surface
// (menu item, toolbar button, keyboard shortcut). Each action is defined
// once, wherever its logic already lives; buttons/menu items become thin
// views over it, so they can never independently drift out of sync.
import { on } from './state.js';

const registry = new Map();

export function defineAction(id, def) {
  registry.set(id, {
    label: '', shortcut: null,
    isEnabled: () => true, isChecked: null, isAvailable: () => true,
    ...def,
  });
}

export function getAction(id) {
  return registry.get(id);
}

export function runAction(id) {
  const a = registry.get(id);
  if (!a || !a.isAvailable() || !a.isEnabled()) return;
  a.run();
}

const bound = new Map(); // action id -> Set<{ el, toggle }>

// Wires a real DOM button/checkbox to an action: click triggers it, and its
// disabled/hidden/checked state is kept correct automatically (see
// refreshAction below) -- callers never need to remember to refresh it by
// hand after a mutation.
export function bindAction(el, id, { toggle = false } = {}) {
  const a = registry.get(id);
  if (!a) throw new Error(`bindAction: unknown action "${id}"`);
  el.title = a.shortcut ? `${a.label} (${a.shortcut})` : a.label;
  el.addEventListener('click', () => runAction(id));
  if (!bound.has(id)) bound.set(id, new Set());
  bound.get(id).add({ el, toggle });
  refreshAction(id);
}

function refreshAction(id) {
  const a = registry.get(id);
  const els = bound.get(id);
  if (!a || !els) return;
  const available = a.isAvailable();
  const enabled = available && a.isEnabled();
  for (const { el, toggle } of els) {
    el.hidden = !available;
    el.disabled = !enabled;
    if (toggle && a.isChecked) {
      const checked = a.isChecked();
      if ('checked' in el) el.checked = checked;
      else el.classList.toggle('active', checked);
    }
  }
}

// Event-driven refresh: any app event can change some action's
// enabled/checked/available state (a layer got deleted, the mode switched,
// history changed, ...) so re-derive every bound element on every event
// rather than requiring each feature module to know which events matter to
// which actions.
on('*', () => { for (const id of bound.keys()) refreshAction(id); });
