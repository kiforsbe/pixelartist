// Right-click (context) menus built from actions. Items use the menu bar's
// format and its renderer (js/components/menu-items.js): { action: 'id',
// args? } or { separator: true }; submenus are actions defined with
// `submenu`. Never ad hoc { label, run } closures -- the same action backs
// the menu entry, any button and any shortcut, so they can't drift apart.
//
// At most one context menu is open at a time. It closes on Escape, Tab, a
// pointerdown outside it, any scroll or window resize/blur, or when an item
// runs. While open it owns the keyboard (keys never reach app shortcuts):
// Up/Down move over enabled items, Enter/Space run (or open a submenu),
// Right/Left open/close a submenu.
import { populateMenu, tidyMenuItems } from './menu-items.js';
import { isTextEntryTarget } from './dom-utils.js';

const MARGIN = 4; // px kept free between the menu and the viewport edge

let current = null; // close() of the open menu, or null

export function closeContextMenu() {
  current?.();
}

// Opens a menu at viewport point (x, y), clamped inside the viewport, and
// returns its close(). `anchor` is the element it mounts in (default
// document.body). Nothing opens when no item is visible.
export function openContextMenu({ x, y, items, anchor = document.body }) {
  closeContextMenu();
  if (!tidyMenuItems(items).length) return () => {};

  const root = document.createElement('div');
  root.className = 'menubar-dropdown context-menu';
  root.setAttribute('role', 'menu');
  root.tabIndex = -1;
  root.style.left = `${x}px`;
  root.style.top = `${y}px`;
  anchor.appendChild(root);

  const previousFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    const focusInside = !document.activeElement || root.contains(document.activeElement);
    root.remove();
    if (current === close) current = null;
    if (focusInside && previousFocus && previousFocus.isConnected !== false) previousFocus.focus?.();
  };

  const model = populateMenu(root, items, close, { tidy: true, onSubmenuOpen: keepOnScreen });

  const rect = root.getBoundingClientRect();
  root.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - MARGIN))}px`;
  root.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - MARGIN))}px`;

  // Keyboard state: one level per open submenu, each with its active entry.
  const levels = [{ model, active: null }];
  const top = () => levels[levels.length - 1];
  function setActive(level, entry) {
    level.active?.btn.classList.remove('active');
    level.active = entry;
    entry.btn.classList.add('active');
    entry.btn.focus?.();
  }
  function move(delta) {
    const level = top();
    const enabled = level.model.entries.filter(e => !e.btn.disabled);
    if (!enabled.length) return;
    level.model.closeOpenSubmenu();
    const at = enabled.indexOf(level.active);
    const next = at < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setActive(level, enabled[next]);
  }
  function enterSubmenu() {
    const entry = top().active;
    if (!entry?.open || entry.btn.disabled) return;
    entry.open();
    levels.push({ model: entry.child, active: null });
    move(1);
  }
  function leaveSubmenu() {
    if (levels.length < 2) return;
    const child = levels.pop();
    child.active?.btn.classList.remove('active');
    const parent = top();
    parent.model.closeOpenSubmenu();
    parent.active?.btn.focus?.();
  }

  function onKeyDown(e) {
    // The open menu owns the keyboard: swallow every key so app shortcuts
    // (tool keys, Delete, Enter = play...) never fire underneath it.
    e.preventDefault();
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'ArrowRight': enterSubmenu(); break;
      case 'ArrowLeft': leaveSubmenu(); break;
      case 'Enter': case ' ': {
        const entry = top().active;
        if (entry?.run) entry.run();
        else enterSubmenu();
        break;
      }
      case 'Escape': case 'Tab': close(); break;
    }
  }
  function onPointerDown(e) { if (!root.contains(e.target)) close(); }
  function onScroll(e) { if (!root.contains(e.target)) close(); }

  // Capture phase so a component that stops propagation can't keep it open.
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  root.addEventListener('contextmenu', e => e.preventDefault());
  // Mouse takes over from the keyboard highlight.
  root.addEventListener('pointermove', () => {
    for (const level of levels) level.active?.btn.classList.remove('active');
  });

  root.focus?.();
  current = close;
  return close;
}

// Flips a submenu to the left of its parent when it would leave the
// viewport on the right, and lifts it when it would leave at the bottom.
function keepOnScreen(childDropdown) {
  const rect = childDropdown.getBoundingClientRect();
  if (rect.right > window.innerWidth - MARGIN) childDropdown.classList.add('context-menu-flip-x');
  const overflow = rect.bottom - (window.innerHeight - MARGIN);
  if (overflow > 0) childDropdown.style.top = `${-5 - overflow}px`;
}

// Wires `el`'s contextmenu event to a menu. `build(event)` returns the items
// (it may first select what was hit, so the menu acts on the selection), or
// null/undefined to leave the event alone (native menu, or an outer
// attachContextMenu handles it). [] swallows the native menu without opening
// anything. An inner handler that opened a menu wins over outer ones, and
// text fields always keep the browser's own menu (copy/paste). Returns a
// function that detaches the handler.
export function attachContextMenu(el, build) {
  const onContextMenu = (event) => {
    if (event.defaultPrevented || isTextEntryTarget(event.target)) return;
    const items = build(event);
    if (items == null) return;
    event.preventDefault();
    let { clientX: x, clientY: y } = event;
    // Keyboard-invoked (Menu key / Shift+F10) menus may report (0, 0):
    // open under the target instead.
    if (!x && !y && event.target?.getBoundingClientRect) {
      const r = event.target.getBoundingClientRect();
      x = r.left; y = r.bottom;
    }
    openContextMenu({ x, y, items });
  };
  el.addEventListener('contextmenu', onContextMenu);
  return () => el.removeEventListener('contextmenu', onContextMenu);
}
