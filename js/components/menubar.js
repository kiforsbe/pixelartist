// Declarative traditional-menu-bar renderer. Knows nothing about business
// logic -- reads/writes only through js/features/shell/actions.js's getAction/runAction,
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
// Item rendering is shared with the context menu: js/components/menu-items.js.
import { populateMenu } from './menu-items.js';

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
    populateMenu(dropdown, menuEl._items, closeOpen);
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
