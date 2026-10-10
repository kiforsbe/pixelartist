import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { defineAction } from '../js/features/shell/actions.js';
import { openContextMenu, attachContextMenu, closeContextMenu } from '../js/components/context-menu.js';
import { mountMenuBar } from '../js/components/menubar.js';

// Small local fake DOM: real tree (parent links, contains, remove), capture +
// bubble dispatch through element -> document -> window, focus tracking and
// per-element sizes. The shared sprite-context-dom helper has no document
// listeners or bubbling, which this component is all about.
function installDom({ width = 800, height = 600 } = {}) {
  function listenerHost(obj) {
    obj.listeners = [];
    obj.addEventListener = (type, fn, opts) => {
      const capture = opts === true || !!opts?.capture;
      obj.listeners.push({ type, fn, capture });
    };
    obj.removeEventListener = (type, fn, opts) => {
      const capture = opts === true || !!opts?.capture;
      obj.listeners = obj.listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
    };
    return obj;
  }
  class Element {
    constructor(tag) {
      listenerHost(this);
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.className = '';
      this.style = {};
      this.dataset = {};
      this.attrs = {};
      this.hidden = false;
      this.disabled = false;
      this.width = 120; this.height = 24;
      this.left = 0; this.top = 0;
      this._text = '';
      const self = this;
      this.classList = {
        contains: c => self.className.split(' ').includes(c),
        add: (...cs) => { self.className = [...new Set([...self.className.split(' '), ...cs])].join(' ').trim(); },
        remove: (...cs) => { self.className = self.className.split(' ').filter(c => !cs.includes(c)).join(' '); },
        toggle: (c, force) => { const on = force ?? !self.classList.contains(c); on ? self.classList.add(c) : self.classList.remove(c); return on; },
      };
    }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children = []; this._text = String(v); }
    set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document.body; }
    append(...items) { for (const i of items) this.appendChild(i); }
    appendChild(item) { item.parentNode?.children.splice(item.parentNode.children.indexOf(item), 1); item.parentNode = this; this.children.push(item); return item; }
    remove() { if (!this.parentNode) return; this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    closest(sel) { for (let n = this; n && n.matches; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    matches(sel) {
      return sel.split(',').map(s => s.trim()).some(s => s.startsWith('.') ? this.classList.contains(s.slice(1)) : this.tagName.toLowerCase() === s);
    }
    querySelectorAll(sel) { return this.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() {
      const left = parseFloat(this.style.left ?? this.left) || 0, top = parseFloat(this.style.top ?? this.top) || 0;
      return { left, top, width: this.width, height: this.height, right: left + this.width, bottom: top + this.height };
    }
    get offsetWidth() { return this.width; }
    get offsetHeight() { return this.height; }
  }
  const document = listenerHost({ createElement: tag => new Element(tag), activeElement: null });
  document.body = new Element('body');
  document.documentElement = document.body;
  const window = listenerHost({ innerWidth: width, innerHeight: height });
  globalThis.document = document;
  globalThis.window = window;
  return { Element, document, window };
}

function dispatch(target, type, init = {}) {
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  if (target !== globalThis.window) path.push(globalThis.document, globalThis.window);
  let stopped = false;
  const event = {
    type, target, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { stopped = true; },
    stopImmediatePropagation() { stopped = true; },
    ...init,
  };
  const call = (node, capturePhase) => {
    for (const l of [...node.listeners]) {
      if (stopped) return;
      if (l.type !== type) continue;
      if (node !== target && l.capture !== capturePhase) continue;
      event.currentTarget = node;
      l.fn(event);
    }
  };
  for (const node of [...path].reverse()) { if (stopped) break; if (node !== target) call(node, true); }
  if (!stopped) call(target, null);
  for (const node of path) { if (stopped) break; if (node !== target) call(node, false); }
  return event;
}
const key = (k, init = {}) => dispatch(document.activeElement ?? document.body, 'keydown', { key: k, ...init });
const click = el => dispatch(el, 'click');

let ran;
let dom;
beforeEach(() => {
  dom = installDom();
  ran = [];
  defineAction('cm.one', { label: 'One', shortcut: 'Alt+1', run: (_ctx, args) => ran.push(['one', args]) });
  defineAction('cm.two', { label: 'Two', run: (_ctx, args) => ran.push(['two', args]) });
  defineAction('cm.off', { label: 'Off', isEnabled: () => false, run: () => ran.push(['off']) });
  defineAction('cm.gone', { label: 'Gone', isAvailable: () => false, run: () => ran.push(['gone']) });
  defineAction('cm.checked', { label: 'Loop', isChecked: () => true, run: () => ran.push(['checked']) });
  defineAction('cm.unchecked', { label: 'Pin', isChecked: () => false, run: () => {} });
  defineAction('cm.dir', {
    label: 'Direction',
    submenu: () => [
      { action: 'cm.pick', args: 'forward' },
      { action: 'cm.pick', args: 'reverse' },
    ],
  });
  defineAction('cm.pick', { label: 'Pick', run: (_ctx, args) => ran.push(['pick', args]) });
});
afterEach(() => closeContextMenu());

const menuEl = () => document.body.querySelector('.context-menu');
const items = root => root.children.filter(c => c.matches('.menubar-dropdown-item') || c.matches('.menubar-submenu-wrap'))
  .map(c => c.matches('.menubar-submenu-wrap') ? c.children[0] : c);
const active = () => document.activeElement;

test('renders action items with labels, shortcuts, disabled and checked state', () => {
  openContextMenu({ x: 10, y: 20, items: [
    { action: 'cm.one' }, { action: 'cm.off' }, { action: 'cm.checked' }, { action: 'cm.unchecked' },
  ] });
  const root = menuEl();
  assert.ok(root, 'menu mounted on the body');
  assert.ok(root.classList.contains('menubar-dropdown'), 'shares the menubar dropdown look');
  assert.equal(root.getAttribute('role'), 'menu');
  const [one, off, checked, unchecked] = items(root);
  assert.equal(one.children[0].textContent, 'One');
  assert.equal(one.querySelector('.menubar-dropdown-shortcut').textContent, 'Alt+1');
  assert.equal(one.disabled, false);
  assert.equal(off.disabled, true);
  assert.equal(checked.children[0].textContent, '✓ Loop');
  assert.equal(unchecked.children[0].textContent, '  Pin');
});

test('hides unavailable and unknown actions and tidies the separators they leave', () => {
  openContextMenu({ x: 0, y: 0, items: [
    { separator: true }, { action: 'cm.gone' }, { action: 'cm.one' }, { separator: true },
    { action: 'cm.nope' }, { separator: true }, { action: 'cm.two' }, { separator: true }, { action: 'cm.gone' },
  ] });
  const kinds = menuEl().children.map(c => c.matches('.menubar-separator') ? '-' : c.textContent.replace(/Alt\+1$/, ''));
  assert.deepEqual(kinds, ['One', '-', 'Two']);
});

test('opens nothing when no item is visible', () => {
  const close = openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.gone' }, { separator: true }] });
  assert.equal(menuEl(), null);
  assert.doesNotThrow(close);
});

test('clicking an item runs its action with args, then closes', () => {
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one', args: { frame: 3 } }, { action: 'cm.two' }] });
  click(items(menuEl())[0]);
  assert.deepEqual(ran, [['one', { frame: 3 }]]);
  assert.equal(menuEl(), null);
});

test('closes on Escape, outside pointerdown, scroll and resize; not on inside pointerdown', () => {
  const opened = () => openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one' }] });

  opened();
  key('Escape');
  assert.equal(menuEl(), null, 'Escape');

  opened();
  dispatch(items(menuEl())[0], 'pointerdown');
  assert.ok(menuEl(), 'inside pointerdown keeps it open');
  const outside = document.body.appendChild(document.createElement('div'));
  dispatch(outside, 'pointerdown');
  assert.equal(menuEl(), null, 'outside pointerdown');

  opened();
  dispatch(outside, 'scroll');
  assert.equal(menuEl(), null, 'scroll');

  opened();
  dispatch(window, 'resize');
  assert.equal(menuEl(), null, 'resize');
  assert.deepEqual(ran, []);
});

test('the returned close() removes the menu and its global listeners', () => {
  const docBefore = document.listeners.length, winBefore = window.listeners.length;
  const close = openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one' }] });
  close();
  assert.equal(menuEl(), null);
  assert.equal(document.listeners.length, docBefore);
  assert.equal(window.listeners.length, winBefore);
  assert.doesNotThrow(close, 'idempotent');
});

test('opening a second menu closes the first', () => {
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one' }] });
  openContextMenu({ x: 5, y: 5, items: [{ action: 'cm.two' }] });
  assert.equal(document.body.querySelectorAll('.context-menu').length, 1);
  assert.equal(items(menuEl())[0].children[0].textContent, 'Two');
});

test('Up/Down move over enabled items (wrapping), Enter runs, keys do not leak to app shortcuts', () => {
  let leaked = 0;
  window.addEventListener('keydown', () => leaked++);
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one' }, { action: 'cm.off' }, { separator: true }, { action: 'cm.two' }] });
  const [one, , two] = items(menuEl());
  key('ArrowDown');
  assert.equal(active(), one);
  key('ArrowDown');
  assert.equal(active(), two, 'skips the disabled item and the separator');
  key('ArrowDown');
  assert.equal(active(), one, 'wraps forward');
  key('ArrowUp');
  assert.equal(active(), two, 'wraps backward');
  key('Enter');
  assert.deepEqual(ran, [['two', undefined]]);
  assert.equal(menuEl(), null);
  assert.equal(leaked, 0);
});

test('Right opens a submenu and focuses its first item, Left closes it, Enter runs a submenu item with args', () => {
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one' }, { action: 'cm.dir' }] });
  const [, dir] = items(menuEl());
  key('ArrowDown'); key('ArrowDown');
  assert.equal(active(), dir);
  key('ArrowRight');
  const sub = dir.parentNode.querySelector('.menubar-submenu');
  assert.equal(sub.hidden, false);
  assert.equal(active(), items(sub)[0]);
  key('ArrowLeft');
  assert.equal(sub.hidden, true);
  assert.equal(active(), dir);
  key('ArrowRight'); key('ArrowDown');
  // The submenu re-renders on every open (dynamic submenus), so re-query.
  assert.equal(active(), items(sub)[1]);
  key('Enter');
  assert.deepEqual(ran, [['pick', 'reverse']]);
  assert.equal(menuEl(), null);
});

test('Enter on a submenu item opens it rather than running anything', () => {
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.dir' }] });
  key('ArrowDown'); key('Enter');
  assert.equal(items(menuEl())[0].parentNode.querySelector('.menubar-submenu').hidden, false);
  assert.deepEqual(ran, []);
});

test('mouse: clicking a submenu item opens it, clicking its child runs and closes', () => {
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.dir' }] });
  const dir = items(menuEl())[0];
  click(dir);
  const sub = dir.parentNode.querySelector('.menubar-submenu');
  click(items(sub)[0]);
  assert.deepEqual(ran, [['pick', 'forward']]);
  assert.equal(menuEl(), null);
});

test('positions at the pointer and clamps inside the viewport', () => {
  openContextMenu({ x: 30, y: 40, items: [{ action: 'cm.one' }] });
  assert.equal(menuEl().style.left, '30px');
  assert.equal(menuEl().style.top, '40px');
  closeContextMenu();

  // The fake menu measures 120x24 (Element default); viewport 800x600.
  openContextMenu({ x: 790, y: 595, items: [{ action: 'cm.one' }] });
  assert.equal(menuEl().style.left, `${800 - 120 - 4}px`);
  assert.equal(menuEl().style.top, `${600 - 24 - 4}px`);
});

test('restores focus to the previously focused element on close', () => {
  const canvas = document.body.appendChild(document.createElement('div'));
  canvas.focus();
  openContextMenu({ x: 0, y: 0, items: [{ action: 'cm.one' }] });
  assert.notEqual(active(), canvas);
  key('Escape');
  assert.equal(active(), canvas);
});

test('attachContextMenu: prevents the native menu, calls the builder with the event, opens at the pointer', () => {
  const row = document.body.appendChild(document.createElement('div'));
  const seen = [];
  const detach = attachContextMenu(row, event => { seen.push(event.target); return [{ action: 'cm.one' }]; });
  const ev = dispatch(row, 'contextmenu', { clientX: 12, clientY: 34 });
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(seen, [row]);
  assert.equal(menuEl().style.left, '12px');
  assert.equal(menuEl().style.top, '34px');
  closeContextMenu();
  detach();
  dispatch(row, 'contextmenu', { clientX: 1, clientY: 1 });
  assert.equal(menuEl(), null, 'detached');
});

test('attachContextMenu: a null result leaves the event alone; [] swallows it without a menu', () => {
  const row = document.body.appendChild(document.createElement('div'));
  let result = null;
  attachContextMenu(row, () => result);
  assert.equal(dispatch(row, 'contextmenu', { clientX: 0, clientY: 0 }).defaultPrevented, false);
  assert.equal(menuEl(), null);
  result = [];
  assert.equal(dispatch(row, 'contextmenu', { clientX: 0, clientY: 0 }).defaultPrevented, true);
  assert.equal(menuEl(), null);
});

test('attachContextMenu: an inner handler wins over an outer one; text fields keep the native menu', () => {
  const outer = document.body.appendChild(document.createElement('div'));
  const inner = outer.appendChild(document.createElement('div'));
  const input = outer.appendChild(document.createElement('input'));
  input.type = 'text';
  let outerCalls = 0;
  attachContextMenu(outer, () => { outerCalls++; return [{ action: 'cm.two' }]; });
  attachContextMenu(inner, () => [{ action: 'cm.one' }]);
  dispatch(inner, 'contextmenu', { clientX: 0, clientY: 0 });
  assert.equal(outerCalls, 0);
  assert.equal(items(menuEl())[0].children[0].textContent, 'One');
  closeContextMenu();
  const ev = dispatch(input, 'contextmenu', { clientX: 0, clientY: 0 });
  assert.equal(ev.defaultPrevented, false);
  assert.equal(outerCalls, 0);
  assert.equal(menuEl(), null);
});

test('menubar still renders and runs items through the shared renderer', () => {
  const bar = document.body.appendChild(document.createElement('div'));
  mountMenuBar(bar, [{ label: 'Edit', items: [{ action: 'cm.one' }, { separator: true }, { action: 'cm.gone' }, { action: 'cm.dir' }] }]);
  const btn = bar.querySelector('.menubar-item');
  click(btn);
  const dropdown = bar.querySelector('.menubar-dropdown');
  assert.equal(dropdown.hidden, false);
  // Menubar keeps its old behaviour: hidden items are skipped, separators are not tidied.
  assert.deepEqual(dropdown.children.map(c => c.className),
    ['menubar-dropdown-item', 'menubar-separator', 'menubar-submenu-wrap']);
  click(dropdown.children[0]);
  assert.deepEqual(ran, [['one', undefined]]);
  assert.equal(dropdown.hidden, true);
});
