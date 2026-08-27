// Central registry for anything triggerable from more than one UI surface
// (menu item, toolbar button, keyboard shortcut). Each action is defined
// once, wherever its logic already lives; buttons/menu items become thin
// views over it, so they can never independently drift out of sync.
import { CommandRegistry } from '../../host/contributions/commands.js';
import { getEditorHost } from '../../host/runtime.js';

// The EditorHost registry is the browser's sole source of truth; the fallback
// keeps this small module independently testable.
const fallbackRegistry = new CommandRegistry();
const registrations = new Map();
let reactiveHost = null;
let reactiveDisposables = [];

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
  ensureReactiveRefresh();
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
  }, { owner: 'shell-actions' });
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
  ensureReactiveRefresh();
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

export function refreshActions() {
  for (const id of bound.keys()) refreshAction(id);
}

// Store/history/context changes can all affect action predicates. Subscribe
// lazily because this module is imported before the browser composition root
// configures its EditorHost, and keep the fallback registry independently
// testable when no host exists.
function ensureReactiveRefresh() {
  const host = getEditorHost();
  if (!host || host === reactiveHost) return;
  reactiveDisposables.forEach(dispose => dispose());
  reactiveHost = host;
  reactiveDisposables = [
    host.store.subscribe(() => ({}), refreshActions),
    host.history.subscribe(refreshActions),
    host.contextKeys.subscribe(refreshActions),
  ];
}
