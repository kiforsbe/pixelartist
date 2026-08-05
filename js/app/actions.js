// Central registry for anything triggerable from more than one UI surface
// (menu item, toolbar button, keyboard shortcut). Each action is defined
// once, wherever its logic already lives; buttons/menu items become thin
// views over it, so they can never independently drift out of sync.
import { on } from './state.js';
import { CommandRegistry } from '../host/contributions/commands.js';
import { getEditorHost } from '../host/runtime.js';

// Compatibility facade for UI modules that still use the original action
// vocabulary. In the browser the EditorHost registry is the sole source of
// truth; the fallback keeps this small module independently testable.
const fallbackRegistry = new CommandRegistry();
const registrations = new Map();

function registry() {
  return getEditorHost()?.registries.commands ?? fallbackRegistry;
}

function commandContext() {
  const host = getEditorHost();
  return host ? Object.freeze({
    host,
    services: host.services,
    contextKeys: host.contextKeys.snapshot(),
  }) : Object.freeze({});
}

export function defineAction(id, def) {
  registrations.get(id)?.dispose();
  const action = {
    id,
    label: '', shortcut: null,
    isEnabled: () => true, isChecked: null, isAvailable: () => true,
    ...def,
  };
  if (typeof action.run !== 'function') {
    if (!action.submenu) throw new TypeError(`Action "${id}" requires run()`);
    action.run = () => undefined;
  }
  const registration = registry().register({
    ...action,
    when: context => action.isAvailable(context),
    execute: (context, args) => action.run(context, args),
  }, { owner: 'legacy-action-facade' });
  registrations.set(id, registration);
  return registration;
}

export function getAction(id) {
  return registry().get(id);
}

export function runAction(id, args) {
  return registry().execute(id, commandContext(), args);
}

const bound = new Map(); // action id -> Set<{ el, toggle }>

// Wires a real DOM button/checkbox to an action: click triggers it, and its
// disabled/hidden/checked state is kept correct automatically (see
// refreshAction below) -- callers never need to remember to refresh it by
// hand after a mutation.
export function bindAction(el, id, { toggle = false } = {}) {
  const a = getAction(id);
  if (!a) throw new Error(`bindAction: unknown action "${id}"`);
  el.title = a.shortcut ? `${a.label} (${a.shortcut})` : a.label;
  el.addEventListener('click', () => runAction(id));
  if (!bound.has(id)) bound.set(id, new Set());
  bound.get(id).add({ el, toggle });
  refreshAction(id);
}

function refreshAction(id) {
  const a = getAction(id);
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
