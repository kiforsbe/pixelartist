// Shared action-menu item renderer, used by the menu bar's dropdowns and by
// the context menu (js/components/context-menu.js) so both draw labels,
// shortcuts, check marks, disabled state and submenus identically. Knows
// nothing about business logic -- reads/writes only through
// js/features/shell/actions.js's getAction/runAction, and silently skips any
// item whose action id isn't defined (or isn't available) right now.
//
// Items are { action: 'id', args? } or { separator: true } -- never ad hoc
// { label, run } closures. `args` is passed to runAction, so one action can
// back several entries (e.g. one per direction). Submenu-ness lives on the
// action definition (defineAction(id, { label, submenu })), where `submenu`
// is `items | () => items`; as a function it's re-evaluated every time it
// opens. An action with a `submenu` never runs on click -- clicking it opens
// the submenu instead; its own `isEnabled()` still governs whether it can open.
import { getAction, runAction } from '../features/shell/actions.js';

// The visible subset of `items`: unknown/unavailable actions dropped, and the
// separators that leaves at either end or doubled up removed.
export function tidyMenuItems(items) {
  const out = [];
  for (const item of items) {
    if (item.separator) {
      if (out.length && !out[out.length - 1].separator) out.push(item);
      continue;
    }
    const a = getAction(item.action);
    if (a && a.isAvailable()) out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

// Renders `items` into `dropdownEl` (clearing it first). `onLeafClick` is
// called before any leaf action's own `run` fires -- used to close the whole
// open menu chain, not just this one dropdown. Recurses for nested submenus.
//
// Options: `tidy` drops separators left dangling by hidden items (see
// tidyMenuItems); `onSubmenuOpen(childDropdown, btn)` runs after a submenu is
// shown (the context menu uses it to keep submenus on screen).
//
// Returns a live model of what was rendered, for keyboard navigation:
// { entries: [{ btn, run? | open/close + child }], closeOpenSubmenu }, where
// a submenu entry's `child` is the nested model while it is open.
export function populateMenu(dropdownEl, items, onLeafClick, options = {}) {
  dropdownEl.innerHTML = '';
  const model = { entries: [], openEntry: null, closeOpenSubmenu };

  function closeOpenSubmenu() {
    const entry = model.openEntry;
    if (!entry) return;
    entry.child?.closeOpenSubmenu();
    entry.btn.classList.remove('open');
    entry.childDropdown.hidden = true;
    entry.child = null;
    model.openEntry = null;
  }

  for (const item of options.tidy ? tidyMenuItems(items) : items) {
    if (item.separator) {
      dropdownEl.appendChild(Object.assign(document.createElement('div'), { className: 'menubar-separator' }));
      continue;
    }

    const a = getAction(item.action);
    if (!a || !a.isAvailable()) continue;

    if (a.submenu) {
      const wrap = document.createElement('div');
      wrap.className = 'menubar-submenu-wrap';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menubar-dropdown-item menubar-has-submenu';
      btn.disabled = !a.isEnabled();
      btn.setAttribute?.('role', 'menuitem');
      btn.setAttribute?.('aria-haspopup', 'menu');
      const label = document.createElement('span'); label.textContent = a.label;
      const arrow = document.createElement('span'); arrow.className = 'menubar-submenu-arrow'; arrow.textContent = '▸';
      btn.append(label, arrow);
      const childDropdown = document.createElement('div');
      childDropdown.className = 'menubar-dropdown menubar-submenu';
      childDropdown.hidden = true;
      wrap.append(btn, childDropdown);
      dropdownEl.appendChild(wrap);

      const entry = { btn, childDropdown, child: null, open: null, close: closeOpenSubmenu };
      entry.open = () => {
        if (btn.disabled || model.openEntry === entry) return;
        closeOpenSubmenu();
        const resolved = typeof a.submenu === 'function' ? a.submenu() : a.submenu;
        entry.child = populateMenu(childDropdown, resolved, onLeafClick, options);
        btn.classList.add('open');
        childDropdown.hidden = false;
        model.openEntry = entry;
        options.onSubmenuOpen?.(childDropdown, btn);
      };
      btn.addEventListener('mouseenter', entry.open);
      btn.addEventListener('click', (e) => { e.stopPropagation(); entry.open(); });
      model.entries.push(entry);
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menubar-dropdown-item';
    btn.disabled = !a.isEnabled();
    btn.setAttribute?.('role', 'menuitem');
    const label = document.createElement('span');
    const check = a.isChecked ? (a.isChecked() ? '✓ ' : '  ') : '';
    label.textContent = check + a.label;
    const shortcut = document.createElement('span');
    shortcut.className = 'menubar-dropdown-shortcut';
    shortcut.textContent = a.shortcut ?? '';
    btn.append(label, shortcut);
    const entry = { btn, run: () => { onLeafClick(); runAction(item.action, item.args); } };
    btn.addEventListener('mouseenter', closeOpenSubmenu);
    btn.addEventListener('click', entry.run);
    dropdownEl.appendChild(btn);
    model.entries.push(entry);
  }
  return model;
}
