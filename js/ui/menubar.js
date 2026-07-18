// Declarative traditional-menu-bar renderer. Knows nothing about business
// logic -- reads/writes only through js/app/actions.js's getAction/runAction,
// so it never needs updating when an action's implementation changes, and
// silently skips any item whose action id isn't defined yet (lets menus grow
// incrementally across tasks without ever rendering a broken entry).
import { getAction, runAction } from '../app/actions.js';

export function mountMenuBar(el, menus) {
  el.innerHTML = '';
  let openMenu = null; // currently open .menubar-menu element, or null

  function closeOpen() {
    if (!openMenu) return;
    openMenu.querySelector('.menubar-item').classList.remove('open');
    openMenu.querySelector('.menubar-dropdown').hidden = true;
    openMenu = null;
  }

  function renderDropdown(menuEl) {
    const dropdown = menuEl.querySelector('.menubar-dropdown');
    dropdown.innerHTML = '';
    for (const item of menuEl._items) {
      if (item.separator) {
        dropdown.appendChild(Object.assign(document.createElement('div'), { className: 'menubar-separator' }));
        continue;
      }
      const a = getAction(item.action);
      if (!a || !a.isAvailable()) continue;
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
      btn.addEventListener('click', () => { closeOpen(); runAction(item.action); });
      dropdown.appendChild(btn);
    }
  }

  function openDropdown(menuEl) {
    if (openMenu === menuEl) return;
    closeOpen();
    renderDropdown(menuEl);
    menuEl.querySelector('.menubar-item').classList.add('open');
    menuEl.querySelector('.menubar-dropdown').hidden = false;
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
