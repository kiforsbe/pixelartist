// Declarative traditional-menu-bar renderer. Knows nothing about business
// logic -- reads/writes only through js/app/actions.js's getAction/runAction,
// so it never needs updating when an action's implementation changes, and
// silently skips any item whose action id isn't defined yet (lets menus grow
// incrementally across tasks without ever rendering a broken entry).
//
// Every MENUS item is either { action: 'id' } or { separator: true } --
// there is no ad hoc { label, run } escape hatch. Command pattern all the
// way down: submenu-ness lives on the action definition itself
// (defineAction(id, { label, submenu, isEnabled, isAvailable })), not on
// the menu item. `submenu` is `items | () => items`; as a function it's
// re-evaluated every time it opens, so its contents (e.g. one entry per
// current animation) can depend on live app state. An action with a
// `submenu` never runs on click -- clicking it opens the submenu instead;
// its own `isEnabled()` still governs whether that submenu can be opened.
import { getAction, runAction } from '../app/actions.js';

// Renders `items` into `dropdownEl` (clearing it first). `onLeafClick` is
// called before any leaf action's own `run` fires -- used to close the
// whole open menu chain, not just this one dropdown. Recurses for nested
// submenus.
function populate(dropdownEl, items, onLeafClick) {
  dropdownEl.innerHTML = '';
  let openSubmenu = null; // { btn, childDropdown } currently open among this dropdown's own children

  function closeOpenSubmenu() {
    if (!openSubmenu) return;
    openSubmenu.btn.classList.remove('open');
    openSubmenu.childDropdown.hidden = true;
    openSubmenu = null;
  }

  for (const item of items) {
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
      const label = document.createElement('span'); label.textContent = a.label;
      const arrow = document.createElement('span'); arrow.className = 'menubar-submenu-arrow'; arrow.textContent = '▸';
      btn.append(label, arrow);
      const childDropdown = document.createElement('div');
      childDropdown.className = 'menubar-dropdown menubar-submenu';
      childDropdown.hidden = true;
      wrap.append(btn, childDropdown);
      dropdownEl.appendChild(wrap);

      const open = () => {
        if (btn.disabled || openSubmenu?.childDropdown === childDropdown) return;
        closeOpenSubmenu();
        const resolved = typeof a.submenu === 'function' ? a.submenu() : a.submenu;
        populate(childDropdown, resolved, onLeafClick);
        btn.classList.add('open');
        childDropdown.hidden = false;
        openSubmenu = { btn, childDropdown };
      };
      btn.addEventListener('mouseenter', open);
      btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
      continue;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menubar-dropdown-item';
    btn.disabled = !a.isEnabled();
    const label = document.createElement('span');
    const check = a.isChecked ? (a.isChecked() ? '✓ ' : '  ') : '';
    label.textContent = check + a.label;
    const shortcut = document.createElement('span');
    shortcut.className = 'menubar-dropdown-shortcut';
    shortcut.textContent = a.shortcut ?? '';
    btn.append(label, shortcut);
    btn.addEventListener('mouseenter', closeOpenSubmenu);
    btn.addEventListener('click', () => { onLeafClick(); runAction(item.action); });
    dropdownEl.appendChild(btn);
  }
}

export function mountMenuBar(el, menus) {
  el.innerHTML = '';
  let openMenu = null; // currently open .menubar-menu element, or null

  function closeOpen() {
    if (!openMenu) return;
    openMenu.querySelector('.menubar-item').classList.remove('open');
    openMenu.querySelector('.menubar-dropdown').hidden = true;
    openMenu = null;
  }

  function openDropdown(menuEl) {
    if (openMenu === menuEl) return;
    closeOpen();
    const dropdown = menuEl.querySelector('.menubar-dropdown');
    populate(dropdown, menuEl._items, closeOpen);
    menuEl.querySelector('.menubar-item').classList.add('open');
    dropdown.hidden = false;
    openMenu = menuEl;
  }

  for (const menu of menus) {
    const menuEl = document.createElement('div');
    menuEl.className = 'menubar-menu';
    menuEl._items = menu.items;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menubar-item';
    btn.textContent = menu.label;
    const dropdown = document.createElement('div');
    dropdown.className = 'menubar-dropdown';
    dropdown.hidden = true;
    menuEl.append(btn, dropdown);
    el.appendChild(menuEl);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu === menuEl) closeOpen();
      else openDropdown(menuEl);
    });
    btn.addEventListener('mouseenter', () => {
      if (openMenu && openMenu !== menuEl) openDropdown(menuEl);
    });
  }

  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.contains(e.target)) closeOpen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) closeOpen();
  });
}
