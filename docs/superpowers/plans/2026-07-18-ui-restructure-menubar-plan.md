# UI Restructure: Menu Bar, Action Registry, Icons, Button Sizing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a traditional File/Edit/Document/Layer/View/Help menu bar, restructure the top bar around mode selection + sheet navigation, introduce a small event-driven action registry so menu items/buttons/shortcuts for the same feature can't drift apart, convert remaining text buttons to icons, and unify button sizing via CSS classes.

**Architecture:** A new `js/app/actions.js` registry (`defineAction`/`getAction`/`runAction`/`bindAction`) is the single source of truth for every triggerable feature; a new `js/ui/menubar.js` renders a declarative `{label, items}` tree purely by reading `getAction`/calling `runAction`, never touching business logic directly. Existing buttons get retrofitted onto the registry via `bindAction`, which self-refreshes off the app's existing `on('*', …)` event bus. New/changed logic lives where it already lives (`main.js`, `panels.js`, `floatsession.js`, `canvasview.js`).

**Tech Stack:** Vanilla ES modules, no build step, `node --test` for pure-logic unit tests (no DOM in this repo's test suite — UI wiring is verified manually in-browser, matching existing convention).

## Global Constraints

- Icons are Unicode/emoji glyphs only — no new asset pipeline (user-confirmed).
- No new automated DOM/UI-interaction tests; this repo's `node --test tests/*.mjs` suite only covers DOM-free pure logic. New pure logic (the action registry core) gets `node --test` coverage; DOM-touching/menu-rendering behavior gets manual browser verification.
- Keep `npm test` green throughout — 182 tests passing at the start of this plan, growing as tasks add `tests/actions.test.mjs` cases.
- Every existing button/shortcut keeps working exactly as before unless a task explicitly says it's being removed because its menu equivalent now supersedes it (only true for File's New/Open/Save/Save As/Export and the undo/redo + overlay-toggle buttons/checkboxes, per the approved spec's "top bar = mode selector + sheet nav only" constraint).
- Do not route floatsession.js's own Ctrl+X/C/V keydown handling through the action registry — it passes `e.altKey` (all-layers cut/copy), which the registry's fixed-arg `run()` can't parameterize. Keep that keydown handler exactly as-is; only its NEW menu-facing counterpart goes through `defineAction`.
- Reference spec: `docs/superpowers/specs/2026-07-18-ui-restructure-menubar-design.md`.

---

### Task 1: Action registry core

**Files:**
- Create: `js/app/actions.js`
- Create: `tests/actions.test.mjs`

**Interfaces:**
- Produces: `defineAction(id: string, def: { label?, shortcut?, run: Function, isEnabled?: () => boolean, isChecked?: () => boolean, isAvailable?: () => boolean }): void`, `getAction(id: string): ActionDef | undefined`, `runAction(id: string): void`.

- [ ] **Step 1: Write the registry core**

```js
// js/app/actions.js
// Central registry for anything triggerable from more than one UI surface
// (menu item, toolbar button, keyboard shortcut). Each action is defined
// once, wherever its logic already lives; buttons/menu items become thin
// views over it, so they can never independently drift out of sync.
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
```

- [ ] **Step 2: Write failing-then-passing tests**

```js
// tests/actions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineAction, getAction, runAction } from '../js/app/actions.js';

test('defineAction fills in defaults; getAction returns them', () => {
  defineAction('t1.plain', { label: 'Plain', run: () => {} });
  const a = getAction('t1.plain');
  assert.equal(a.label, 'Plain');
  assert.equal(a.shortcut, null);
  assert.equal(a.isEnabled(), true);
  assert.equal(a.isChecked, null);
  assert.equal(a.isAvailable(), true);
});

test('runAction calls run() when enabled and available', () => {
  let ran = 0;
  defineAction('t1.run', { label: 'Run', run: () => { ran++; } });
  runAction('t1.run');
  assert.equal(ran, 1);
});

test('runAction is a no-op when isEnabled() is false', () => {
  let ran = 0;
  defineAction('t1.disabled', { label: 'Disabled', run: () => { ran++; }, isEnabled: () => false });
  runAction('t1.disabled');
  assert.equal(ran, 0);
});

test('runAction is a no-op when isAvailable() is false', () => {
  let ran = 0;
  defineAction('t1.unavailable', { label: 'Unavailable', run: () => { ran++; }, isAvailable: () => false });
  runAction('t1.unavailable');
  assert.equal(ran, 0);
});

test('runAction on an unknown id is a silent no-op', () => {
  assert.doesNotThrow(() => runAction('t1.nope'));
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test tests/actions.test.mjs`
Expected: 5 tests pass.

- [ ] **Step 4: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all tests pass (183 total: 182 existing + 5 new, minus overlap — exact count isn't load-bearing, "0 failing" is).

- [ ] **Step 5: Commit**

```bash
git add js/app/actions.js tests/actions.test.mjs
git commit -m "feat: add action registry core (defineAction/getAction/runAction)"
```

---

### Task 2: DOM binding with event-driven refresh

**Files:**
- Modify: `js/app/actions.js`
- Modify: `tests/actions.test.mjs`

**Interfaces:**
- Consumes: `on` from `js/app/state.js` (signature: `on(event: string, fn: Function): () => void`; `'*'` is a wildcard that fires on every event — already supported by `state.js`'s `emit()`).
- Produces: `bindAction(el: {addEventListener, title, disabled, hidden, checked?, classList}, id: string, opts?: {toggle?: boolean}): void`.

- [ ] **Step 1: Add bindAction/refreshAction + the wildcard subscription**

```js
// js/app/actions.js — add this import at the top, above `const registry = new Map();`
import { on } from './state.js';
```

```js
// js/app/actions.js — append after runAction()
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
```

- [ ] **Step 2: Write failing-then-passing tests using a hand-rolled fake DOM element**

There is no jsdom in this repo (`node --test` runs with no DOM). `bindAction`/`refreshAction` only touch a small surface (`addEventListener`, `title`, `disabled`, `hidden`, `checked`, `classList.toggle`), so a plain-object stub covers it without adding a dependency.

```js
// tests/actions.test.mjs — add these imports to the existing import block
import { bindAction } from '../js/app/actions.js';
import { emit } from '../js/app/state.js';
```

```js
// tests/actions.test.mjs — append at the end of the file
function fakeElement() {
  const listeners = {};
  return {
    disabled: false, hidden: false, checked: false, title: '',
    classList: {
      _set: new Set(),
      toggle(cls, on) { on ? this._set.add(cls) : this._set.delete(cls); },
      contains(cls) { return this._set.has(cls); },
    },
    addEventListener(evt, fn) { (listeners[evt] ??= []).push(fn); },
    click() { for (const fn of listeners.click ?? []) fn(); },
  };
}

test('bindAction wires click to runAction and sets the title', () => {
  let ran = 0;
  defineAction('t2.run', { label: 'Run', shortcut: 'Ctrl+R', run: () => { ran++; } });
  const el = fakeElement();
  bindAction(el, 't2.run');
  assert.equal(el.title, 'Run (Ctrl+R)');
  el.click();
  assert.equal(ran, 1);
});

test('bound elements refresh disabled/hidden on any app event', () => {
  let enabled = false, available = true;
  defineAction('t2.state', { label: 'State', run: () => {}, isEnabled: () => enabled, isAvailable: () => available });
  const el = fakeElement();
  bindAction(el, 't2.state');
  assert.equal(el.disabled, true);
  assert.equal(el.hidden, false);
  enabled = true;
  emit('project');
  assert.equal(el.disabled, false);
  available = false;
  emit('selection');
  assert.equal(el.hidden, true);
});

test('toggle-bound checkbox mirrors isChecked and updates via events', () => {
  let checked = false;
  defineAction('t2.toggle', { label: 'Toggle', run: () => {}, isChecked: () => checked });
  const el = fakeElement();
  bindAction(el, 't2.toggle', { toggle: true });
  assert.equal(el.checked, false);
  checked = true;
  emit('view');
  assert.equal(el.checked, true);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test tests/actions.test.mjs`
Expected: 8 tests pass (5 from Task 1 + 3 new).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add js/app/actions.js tests/actions.test.mjs
git commit -m "feat: event-driven DOM binding for the action registry"
```

---

### Task 3: Header restructure — menu bar renderer, File menu, Undo/Redo, overlay toggles

This is the largest task: it's the one place old DOM has to come out and its
replacement has to go in atomically, so the app is never left with e.g. no
way to save at all. Everything else (Cut/Copy/Paste, Document, Layer, zoom,
Help) is purely additive and split into its own task.

**Files:**
- Modify: `index.html`
- Create: `js/ui/menubar.js`
- Modify: `js/app/main.js`
- Modify: `css/app.css`

**Interfaces:**
- Consumes: `defineAction`, `runAction`, `getAction` from `js/app/actions.js`.
- Produces: `mountMenuBar(el: HTMLElement, menus: Array<{label: string, items: Array<{action: string} | {separator: true}>}>): void` from `js/ui/menubar.js`. Later tasks (4–8) extend the `MENUS` array this task creates in `main.js` and add more `defineAction`/`bindAction` calls — unknown action ids in the config are simply skipped by the renderer (see Step 3), so partially-built menus never crash.

- [ ] **Step 1: Restructure the header markup**

In `index.html`, replace lines 12–37 (the whole `<header id="top-bar">...</header>` block) with:

```html
<header id="app-header">
  <nav id="menubar"></nav>
  <div id="top-bar">
    <nav id="mode-tabs">
      <button id="tab-sprites" class="active">Sprite Sheets</button>
      <button id="tab-tiles">Tile Sheets</button>
    </nav>
    <select id="sheet-select"></select>
    <button id="btn-new-sheet" title="New sheet">+</button>
    <button id="btn-import-sheet" title="Import sheet from image">📥</button>
    <button id="btn-rename-sheet" title="Rename sheet">✎</button>
    <button id="btn-delete-sheet" title="Delete sheet">🗑</button>
  </div>
</header>
```

Notes on what changed: the old `<div id="menu-bar">` (New/Open/Save/Save As/Export text buttons) is gone — those move into the new File menu. `#overlay-toggles` and `#history-buttons` are gone — Labels/Sequences and Undo/Redo become menu-only for now (per the approved spec's deferred quick-access-toolbar idea). `#btn-import-sheet`'s label changes from the text "Import…" to the icon "📥" — it sits directly next to the already-iconified rename (✎) and delete (🗑) sheet buttons, so leaving it as text would be inconsistent with the icon-conversion goal (this one button wasn't explicitly enumerated in the spec's icon list, but it's the same category of button as its neighbors).

- [ ] **Step 2: Update the header CSS for the new two-row structure**

In `css/app.css`, replace the existing `#top-bar { ... }` rule (line 12–13) with:

```css
#app-header { background: var(--bg2); }
#menubar { display: flex; align-items: center; gap: 2px; padding: 2px 8px;
  border-bottom: 1px solid var(--border); position: relative; }
#top-bar { display: flex; gap: 16px; align-items: center; padding: 4px 8px;
  border-bottom: 1px solid var(--border); }
```

Add the menu-bar dropdown styling (append near the end of `css/app.css`):

```css
/* menu bar */
.menubar-menu { position: relative; }
.menubar-item { background: transparent; border: 1px solid transparent; border-radius: 3px;
  padding: 3px 8px; }
.menubar-item:hover, .menubar-item.open { background: var(--bg3); border-color: var(--border); }
.menubar-dropdown { position: absolute; top: 100%; left: 0; z-index: 50; min-width: 220px;
  background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,.4); display: flex; flex-direction: column; gap: 1px; }
.menubar-dropdown[hidden] { display: none; }
.menubar-dropdown-item { display: flex; justify-content: space-between; align-items: center;
  gap: 16px; width: 100%; text-align: left; background: transparent; border: none;
  border-radius: 3px; padding: 5px 8px; }
.menubar-dropdown-item:hover:not(:disabled) { background: var(--accent); color: #fff; }
.menubar-dropdown-item:disabled { opacity: .4; cursor: default; }
.menubar-dropdown-shortcut { font-size: 11px; color: #9a9ca8; }
.menubar-dropdown-item:hover:not(:disabled) .menubar-dropdown-shortcut { color: #dbe6ff; }
.menubar-separator { height: 1px; background: var(--border); margin: 3px 2px; }
```

- [ ] **Step 3: Write the menu bar renderer**

```js
// js/ui/menubar.js
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
      const check = a.isChecked ? (a.isChecked() ? '✓ ' : '  ') : '';
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
```

- [ ] **Step 4: Remove the old File/Undo-Redo/overlay-toggle element refs in `main.js`**

Delete these lines (originally 33–41):

```js
const btnNew = document.getElementById('btn-new');
const btnOpen = document.getElementById('btn-open');
const btnSave = document.getElementById('btn-save');
const btnSaveAs = document.getElementById('btn-save-as');
const btnExport = document.getElementById('btn-export');
const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const ovlLabels = document.getElementById('ovl-labels');
const ovlSeq = document.getElementById('ovl-seq');
```

Add the new imports at the top of `main.js` (alongside the existing import block):

```js
import { defineAction, runAction } from './actions.js';
import { mountMenuBar } from '../ui/menubar.js';
```

- [ ] **Step 5: Replace the undo/redo wiring**

Replace (originally lines 332–339):

```js
// ---- undo/redo ----
function updateHistoryButtons() {
  btnUndo.disabled = !state.commands.canUndo();
  btnRedo.disabled = !state.commands.canRedo();
}
state.commands.onChange = () => { updateHistoryButtons(); emit('history'); };
btnUndo.addEventListener('click', () => state.commands.undo());
btnRedo.addEventListener('click', () => state.commands.redo());
```

with:

```js
// ---- undo/redo ----
state.commands.onChange = () => emit('history');
defineAction('edit.undo', {
  label: 'Undo', shortcut: 'Ctrl+Z',
  run: () => state.commands.undo(),
  isEnabled: () => state.commands.canUndo(),
});
defineAction('edit.redo', {
  label: 'Redo', shortcut: 'Ctrl+Y',
  run: () => state.commands.redo(),
  isEnabled: () => state.commands.canRedo(),
});
```

In the Ctrl+Z/Ctrl+Y keydown handler right below it (originally lines 340–353), route through the registry instead of calling `state.commands` directly:

```js
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) { e.preventDefault(); runAction('edit.undo'); }
  else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); runAction('edit.redo'); }
  else if (key === 's') {
    // Gated (unlike undo/redo above): Ctrl+S is a global browser shortcut
    // users may also press while a text field or dialog has focus, where we
    // want the browser/native field behavior, not a project save.
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    e.preventDefault();
    runAction('file.save');
  }
});
```

- [ ] **Step 6: Replace the overlay-toggle wiring**

Replace (originally lines 374–382):

```js
// ---- overlay toggles ----
ovlLabels.addEventListener('change', () => {
  state.overlays.labels = ovlLabels.checked;
  emit('view');
});
ovlSeq.addEventListener('change', () => {
  state.overlays.sequences = ovlSeq.checked;
  emit('view');
});
```

with:

```js
// ---- overlay toggles ----
defineAction('view.toggleLabels', {
  label: 'Show Labels',
  run: () => { state.overlays.labels = !state.overlays.labels; emit('view'); },
  isChecked: () => state.overlays.labels,
});
defineAction('view.toggleSequences', {
  label: 'Show Sequences',
  run: () => { state.overlays.sequences = !state.overlays.sequences; emit('view'); },
  isChecked: () => state.overlays.sequences,
});
```

- [ ] **Step 7: Convert the File button handlers to actions**

Replace the New handler (originally lines 546–550):

```js
// ---- file: New ----
btnNew.addEventListener('click', () => {
  if (state.dirty && !confirmOrAuto('Discard unsaved changes and start a new project?')) return;
  dlgNewProject.showModal();
});
```

with:

```js
// ---- file: New ----
defineAction('file.new', {
  label: 'New',
  run: () => {
    if (state.dirty && !confirmOrAuto('Discard unsaved changes and start a new project?')) return;
    dlgNewProject.showModal();
  },
});
```

Replace the Open handler (originally lines 584–600, keep the comment above it):

```js
// ---- file: Open ----
// Folder ("unpacked") projects are disabled for now (see io.saveUnpacked/
// openUnpacked, kept but unwired) -- Open always goes straight to the
// packed (.pixelproj) file picker, no format-choice dialog.
defineAction('file.open', {
  label: 'Open',
  run: async () => {
    if (state.dirty && !confirmOrAuto('Discard unsaved changes and open another project?')) return;
    try {
      const { project, handle } = await io.openPacked();
      state.fileHandle = handle;
      state.dirHandle = null;
      state.saveMode = handle ? 'packed' : null;
      setProject(project);
    } catch (e) {
      if (isCancel(e)) return;
      alert(e.message);
    }
  },
});
```

Replace the Save wiring (originally lines 602–615) — `doSave` stays a named function since Step 5's keydown handler needs `runAction('file.save')` to reach it:

```js
// ---- file: Save ----
async function doSave() {
  commitFloatIfAny();
  try {
    state.fileHandle = await io.savePacked(state.project, state.fileHandle);
    state.saveMode = 'packed';
    state.dirty = false;
    await io.clearAutosave().catch(() => {});
    emit('project');
  } catch (e) {
    if (!isCancel(e)) alert(`Save failed: ${e.message}`);
  }
}
defineAction('file.save', { label: 'Save', shortcut: 'Ctrl+S', run: doSave, isEnabled: () => !!state.project });
```

Replace the Save As handler (originally lines 617–630):

```js
// ---- file: Save As ----
async function doSaveAs() {
  commitFloatIfAny();
  try {
    state.fileHandle = await io.savePacked(state.project, null);
    state.dirHandle = null;
    state.saveMode = 'packed';
    state.dirty = false;
    await io.clearAutosave().catch(() => {});
    emit('project');
  } catch (e) {
    if (!isCancel(e)) alert(`Save failed: ${e.message}`);
  }
}
defineAction('file.saveAs', { label: 'Save As…', run: doSaveAs, isEnabled: () => !!state.project });
```

Replace the Export button wiring (originally line 642 only — `updateExportButtons`, `btnExportCancel`, `btnExportPng`, `btnExportFrames`, `btnExportTiles` all stay unchanged, they're dialog-internal):

```js
defineAction('file.export', {
  label: 'Export…',
  run: () => { updateExportButtons(); dlgExport.showModal(); },
  isEnabled: () => !!state.project,
});
```

- [ ] **Step 8: Remove the now-dead `updateHistoryButtons()` call in `boot()`**

In the `boot()` IIFE at the end of `main.js` (originally line 695), delete the line:

```js
  updateHistoryButtons();
```

(The action registry's menu items read fresh state every time a dropdown opens — no manual refresh call is needed.)

- [ ] **Step 9: Mount the menu bar**

Near the end of `main.js`, after `const tileEditor = mountTileEditor(canvasHost);` and before the `applyView()`/boot() section, add:

```js
// ---- menu bar ----
// Later tasks extend this array (more items per menu, more menus) and add
// the defineAction calls those items reference — menubar.js skips any item
// whose action id isn't registered yet, so this can be built up incrementally.
const MENUS = [
  { label: 'File', items: [
    { action: 'file.new' }, { action: 'file.open' }, { separator: true },
    { action: 'file.save' }, { action: 'file.saveAs' }, { separator: true },
    { action: 'file.export' },
  ] },
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' },
  ] },
  { label: 'View', items: [
    { action: 'view.toggleLabels' }, { action: 'view.toggleSequences' },
  ] },
];
mountMenuBar(document.getElementById('menubar'), MENUS);
```

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: all tests pass (this task touches no core logic, only `main.js`/`index.html`/CSS/the new `menubar.js`).

- [ ] **Step 11: Manual browser verification**

Start the dev server and open the app fresh (a stale cached bundle across reloads has bitten this project before — use a fresh port and navigate to `about:blank` first):

```powershell
./serve.ps1
```

In a browser (or via Playwright), navigate to `about:blank`, then to `http://localhost:<port>?autotest` (the `?autotest` suppresses the beforeunload/autosave-restore confirm dialogs). Verify:
- The header shows two rows: File/Edit/View menu bar on top, mode tabs + sheet controls below.
- Clicking "File" opens a dropdown with New/Open/Save/Save As/Export; clicking "Edit" while File is open switches directly to Edit's dropdown (hover-switch); Escape and an outside click both close it.
- File → Save works (triggers the native save picker — expected to disconnect a Playwright-controlled browser, per this project's established precedent; that confirms it fired correctly, don't attempt to interact with the native dialog).
- Edit → Undo/Redo are greyed out on a fresh project (nothing to undo), and Undo becomes enabled after making an edit (e.g. draw a pixel) — reopen the Edit menu to see the refreshed state.
- View → Show Labels/Show Sequences show a checkmark matching their default-on state, and toggling one updates the sheet's label overlay.
- 0 console errors.

- [ ] **Step 12: Commit**

```bash
git add index.html css/app.css js/ui/menubar.js js/app/main.js
git commit -m "feat: add traditional menu bar (File/Edit/View so far), restructure top bar"
```

---

### Task 4: Edit menu — Cut/Copy/Paste

**Files:**
- Modify: `js/ui/floatsession.js`
- Modify: `js/app/main.js`

**Interfaces:**
- Consumes: `defineAction` from `js/app/actions.js` (already imported in `main.js` by Task 3).
- Produces: `hasSelection(): boolean` and `paste(): void` exported from `js/ui/floatsession.js`, for use by Edit menu actions (and available to any future caller needing "is there a selection to act on").

- [ ] **Step 1: Export a selection-check helper and a unified paste from floatsession.js**

Add after `cutSelection`/`copySelection` (originally lines 310–311):

```js
export function hasSelection() { return !!activeView()?.getSelection(); }
```

Add after `pasteSystemImage` (originally ends at line 431, right before the `// ---- auto-commit hooks + keyboard ----` comment at line 433):

```js
// Menu-facing paste: mirrors what Ctrl+V already does (internal clipboard
// first, OS clipboard image as fallback) as a single callable, since the
// keydown handler below inlines that branch instead of calling a function.
export function paste() {
  if (clipboard) pasteClipboard(); else pasteSystemImage();
}
```

- [ ] **Step 2: Register the Edit actions in main.js**

Add the import (extend the existing `floatsession.js` import in `main.js`):

```js
import { initFloatSession, commitFloatIfAny, cutSelection, copySelection, paste, hasSelection } from '../ui/floatsession.js';
```

Add near the other `edit.*` action definitions from Task 3 (right after the `edit.redo` `defineAction` call):

```js
defineAction('edit.cut', { label: 'Cut', shortcut: 'Ctrl+X', run: () => cutSelection(false), isEnabled: hasSelection });
defineAction('edit.copy', { label: 'Copy', shortcut: 'Ctrl+C', run: () => copySelection(false), isEnabled: hasSelection });
defineAction('edit.paste', { label: 'Paste', shortcut: 'Ctrl+V', run: paste });
```

(`floatsession.js`'s own `onKeydown` cut/copy/paste branches are untouched — see the Global Constraints note on why they must stay independent of the registry.)

- [ ] **Step 3: Extend the Edit menu config**

In `main.js`'s `MENUS` array (added in Task 3, Step 9), replace:

```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' },
  ] },
```

with:

```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' },
  ] },
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Manual browser verification**

With the dev server running (fresh port, `about:blank` first, `?autotest`): draw a marquee selection on the sheet canvas, open Edit — Cut/Copy should now be enabled; click Copy, then Paste — a floating selection should appear. With no selection, Cut/Copy should be greyed out in the menu. 0 console errors.

- [ ] **Step 6: Commit**

```bash
git add js/ui/floatsession.js js/app/main.js
git commit -m "feat: add Cut/Copy/Paste to the Edit menu"
```

---

### Task 5: Document menu — sheet management

**Files:**
- Modify: `js/app/main.js`

**Interfaces:**
- Consumes: `defineAction`, `bindAction` from `js/app/actions.js`.
- Produces: actions `document.newSheet`, `document.importSheet`, `document.renameSheet`, `document.deleteSheet`, bound to the existing top-bar buttons AND referenced by the new Document menu.

- [ ] **Step 1: Import bindAction**

Change the Task 3 import line in `main.js`:

```js
import { defineAction, runAction } from './actions.js';
```

to:

```js
import { defineAction, runAction, bindAction } from './actions.js';
```

- [ ] **Step 2: Retrofit the New Sheet button**

Replace (originally lines 182–191):

```js
// ---- new sheet dialog ----
btnNewSheet.addEventListener('click', () => {
  if (!state.project) return;
  const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
  const settings = state.project.settings;
  const n = state.project.sheets.filter(s => s.kind === kind).length + 1;
  nsName.value = `sheet_${n}`;
  nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
  nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
  dlgNewSheet.showModal();
});
```

with:

```js
// ---- new sheet dialog ----
defineAction('document.newSheet', {
  label: 'New Sheet',
  run: () => {
    if (!state.project) return;
    const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
    const settings = state.project.settings;
    const n = state.project.sheets.filter(s => s.kind === kind).length + 1;
    nsName.value = `sheet_${n}`;
    nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
    nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
    dlgNewSheet.showModal();
  },
  isEnabled: () => !!state.project,
});
bindAction(btnNewSheet, 'document.newSheet');
```

- [ ] **Step 3: Retrofit the Import Sheet button**

Replace (originally lines 214–245, keep the `// ---- import sheet from image ----` comment):

```js
// ---- import sheet from image ----
defineAction('document.importSheet', {
  label: 'Import Sheet from Image',
  run: async () => {
    if (!state.project) return;
    let file;
    try {
      file = await io.pickImageFile();
    } catch (e) {
      if (isCancel(e)) return;
      alert(`Import failed: ${e.message}`);
      return;
    }
    let bitmap;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      bitmap = await decodePng(bytes);
    } catch (e) {
      alert(`Import failed: ${e.message}`);
      return;
    }
    if (bitmap.width > 4096 || bitmap.height > 4096) {
      alert('Image is too large (max 4096×4096).');
      return;
    }
    const project = state.project;
    const kind = state.mode === 'sprites' ? 'sprite' : 'tile';
    const name = file.name.replace(/\.[^.]+$/, '') || 'imported';
    const sheet = createSheet(project, {
      name, width: bitmap.width, height: bitmap.height, kind,
    });
    sheetLayers(sheet)[0].bitmap = bitmap;
    commitAddSheet(sheet);
  },
  isEnabled: () => !!state.project,
});
bindAction(btnImportSheet, 'document.importSheet');
```

- [ ] **Step 4: Retrofit the Rename Sheet button**

Replace (originally lines 253–258):

```js
btnRenameSheet.addEventListener('click', () => {
  const sheet = activeSheet();
  if (!sheet) return;
  rsName.value = sheet.name;
  dlgRenameSheet.showModal();
});
```

with:

```js
defineAction('document.renameSheet', {
  label: 'Rename Sheet',
  run: () => {
    const sheet = activeSheet();
    if (!sheet) return;
    rsName.value = sheet.name;
    dlgRenameSheet.showModal();
  },
  isEnabled: () => !!activeSheet(),
});
bindAction(btnRenameSheet, 'document.renameSheet');
```

- [ ] **Step 5: Retrofit the Delete Sheet button**

Replace (originally lines 325–330):

```js
btnDeleteSheet.addEventListener('click', () => {
  const sheet = activeSheet();
  if (!sheet) return;
  if (!confirmOrAuto(`Delete sheet "${sheet.name}" and everything in it (layers, frames, animations${sheet.kind === 'tile' ? ', tiles, terrain sets' : ''})?`)) return;
  commitDeleteSheet(sheet);
});
```

with:

```js
defineAction('document.deleteSheet', {
  label: 'Delete Sheet',
  run: () => {
    const sheet = activeSheet();
    if (!sheet) return;
    if (!confirmOrAuto(`Delete sheet "${sheet.name}" and everything in it (layers, frames, animations${sheet.kind === 'tile' ? ', tiles, terrain sets' : ''})?`)) return;
    commitDeleteSheet(sheet);
  },
  isEnabled: () => !!activeSheet(),
});
bindAction(btnDeleteSheet, 'document.deleteSheet');
```

- [ ] **Step 6: Insert the Document menu**

In `main.js`'s `MENUS` array, insert a new entry between `File` and `Edit`:

```js
  { label: 'Document', items: [
    { action: 'document.newSheet' }, { action: 'document.importSheet' }, { separator: true },
    { action: 'document.renameSheet' }, { action: 'document.deleteSheet' },
  ] },
```

so the array reads (File, Document, Edit, View in that order).

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Manual browser verification**

Dev server, fresh port, `about:blank` first, `?autotest`. Confirm: the top-bar New Sheet/Import/Rename/Delete buttons still work exactly as before; Document menu's four items do the same things; Rename/Delete are greyed out if somehow no sheet is active (harder to hit manually since a project always has sheets, but confirm the menu doesn't error). 0 console errors.

- [ ] **Step 9: Commit**

```bash
git add js/app/main.js
git commit -m "feat: add Document menu, retrofit sheet buttons onto the action registry"
```

---

### Task 6: Layer menu

**Files:**
- Modify: `js/ui/panels.js`
- Modify: `js/app/main.js`

**Interfaces:**
- Consumes: `defineAction`, `bindAction` from `js/app/actions.js`.
- Produces: actions `layer.add`, `layer.addGroup`, `layer.delete`, `layer.mergeDown`.

- [ ] **Step 1: Import the action registry in panels.js**

Add near the top of `js/ui/panels.js`, alongside its existing imports:

```js
import { defineAction, bindAction } from '../app/actions.js';
```

- [ ] **Step 2: Retrofit the four layer-panel buttons**

In `mountLayersPanel` (starts at line 376), replace the existing listener-wiring lines (originally lines 993–996):

```js
  btnAddLayer.addEventListener('click', doAddLayer);
  btnAddGroup.addEventListener('click', doAddGroup);
  btnDelete.addEventListener('click', doDelete);
  btnMerge.addEventListener('click', doMergeDown);
```

with:

```js
  defineAction('layer.add', { label: 'Add Layer', run: doAddLayer, isEnabled: () => !!activeSheet() });
  bindAction(btnAddLayer, 'layer.add');
  defineAction('layer.addGroup', { label: 'Add Group', run: doAddGroup, isEnabled: () => !!activeSheet() });
  bindAction(btnAddGroup, 'layer.addGroup');
  defineAction('layer.delete', { label: 'Delete Layer', run: doDelete, isEnabled: () => !!activeSheet() });
  bindAction(btnDelete, 'layer.delete');
  defineAction('layer.mergeDown', { label: 'Merge Down', run: doMergeDown, isEnabled: () => !!activeSheet() });
  bindAction(btnMerge, 'layer.mergeDown');
```

(`doAddLayer`/`doAddGroup`/`doDelete`/`doMergeDown` are `function` declarations earlier in the same `mountLayersPanel` scope, so they're already hoisted and safe to reference here — this is the same spot their old `addEventListener` calls lived, just past their definitions.)

- [ ] **Step 3: Insert the Layer menu in main.js**

In `main.js`'s `MENUS` array, insert a new entry between `Document` and `Edit`:

```js
  { label: 'Layer', items: [
    { action: 'layer.add' }, { action: 'layer.addGroup' }, { separator: true },
    { action: 'layer.delete' }, { action: 'layer.mergeDown' },
  ] },
```

so the array reads (File, Document, Layer, Edit, View in that order).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Manual browser verification**

Dev server, fresh port, `about:blank` first, `?autotest`. Confirm: the Layers panel's ➕/📁/🗑/⬇ buttons still work; Layer menu's four items do the same things (e.g. Layer → Add Layer adds a new layer visible in the panel). 0 console errors.

- [ ] **Step 6: Commit**

```bash
git add js/ui/panels.js js/app/main.js
git commit -m "feat: add Layer menu, retrofit layer-panel buttons onto the action registry"
```

---

### Task 7: View menu — zoom controls

**Files:**
- Modify: `js/ui/canvasview.js`
- Modify: `js/ui/frameeditor.js`
- Modify: `js/ui/tileeditor.js`
- Modify: `js/app/main.js`

**Interfaces:**
- Produces: `CanvasView.zoomIn()`, `CanvasView.zoomOut()`, `CanvasView.actualSize()`, `CanvasView.fitToView()` — all `(): void`, all repaint via the existing `requestRender()`. `mountFrameEditor`/`mountTileEditor` now also return `view` (the `CanvasView` instance) alongside `show`/`hide`.

- [ ] **Step 1: Refactor CanvasView's wheel-zoom into a reusable helper, add the four new methods**

In `js/ui/canvasview.js`, replace `_onWheel` (originally lines 222–233):

```js
  _onWheel(e) {
    e.preventDefault();
    const { sx, sy } = this._localPos(e);
    const imgX = (sx - this.panX) / this.zoom;
    const imgY = (sy - this.panY) / this.zoom;
    const newZoom = stepZoom(this.zoom, e.deltaY < 0 ? 1 : -1);
    this.zoom = newZoom;
    this.panX = sx - imgX * newZoom;
    this.panY = sy - imgY * newZoom;
    this._reportStatus(sx, sy);
    this.requestRender();
  }
```

with:

```js
  _onWheel(e) {
    e.preventDefault();
    const { sx, sy } = this._localPos(e);
    this._zoomAround(sx, sy, stepZoom(this.zoom, e.deltaY < 0 ? 1 : -1));
    this._reportStatus(sx, sy);
  }

  // Shared by wheel-zoom (anchored at the cursor) and the zoom actions below
  // (anchored at the viewport center, since there's no cursor position to
  // anchor a menu click to).
  _zoomAround(sx, sy, newZoom) {
    const imgX = (sx - this.panX) / this.zoom;
    const imgY = (sy - this.panY) / this.zoom;
    this.zoom = newZoom;
    this.panX = sx - imgX * newZoom;
    this.panY = sy - imgY * newZoom;
    this.requestRender();
  }

  zoomIn() { this._zoomAround(this.cssWidth / 2, this.cssHeight / 2, stepZoom(this.zoom, 1)); }
  zoomOut() { this._zoomAround(this.cssWidth / 2, this.cssHeight / 2, stepZoom(this.zoom, -1)); }
  actualSize() { this._zoomAround(this.cssWidth / 2, this.cssHeight / 2, 1); }
  fitToView() { this.centerFit(); this.requestRender(); }
```

- [ ] **Step 2: Expose each editor's CanvasView instance**

In `js/ui/frameeditor.js`, replace the final return (originally lines 426–427):

```js
  return { show, hide };
}
```

with:

```js
  return { show, hide, view };
}
```

In `js/ui/tileeditor.js`, replace the final return (originally lines 467–468):

```js
  return { show, hide };
}
```

with:

```js
  return { show, hide, view };
}
```

- [ ] **Step 3: Wire the zoom actions in main.js**

Add after `const tileEditor = mountTileEditor(canvasHost);` (originally line 521), before the Task 3 `MENUS`/`mountMenuBar` block:

```js
// ---- view: zoom ----
function activeCanvasView() {
  return state.view === 'frame' ? frameEditor.view : state.view === 'tile' ? tileEditor.view : canvasView;
}
defineAction('view.zoomIn', { label: 'Zoom In', run: () => activeCanvasView().zoomIn() });
defineAction('view.zoomOut', { label: 'Zoom Out', run: () => activeCanvasView().zoomOut() });
defineAction('view.actualSize', { label: 'Actual Size (100%)', run: () => activeCanvasView().actualSize() });
defineAction('view.zoomToFit', { label: 'Zoom to Fit', run: () => activeCanvasView().fitToView() });
```

- [ ] **Step 4: Extend the View menu config**

In `main.js`'s `MENUS` array, replace:

```js
  { label: 'View', items: [
    { action: 'view.toggleLabels' }, { action: 'view.toggleSequences' },
  ] },
```

with:

```js
  { label: 'View', items: [
    { action: 'view.toggleLabels' }, { action: 'view.toggleSequences' }, { separator: true },
    { action: 'view.zoomIn' }, { action: 'view.zoomOut' }, { action: 'view.actualSize' }, { action: 'view.zoomToFit' },
  ] },
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass (`core/zoom.js`'s existing `tests/zoom.test.mjs` is untouched — this task only adds thin wrapper methods around it).

- [ ] **Step 6: Manual browser verification**

Dev server, fresh port, `about:blank` first, `?autotest`. Confirm: mouse-wheel zoom still works identically (no regression from the `_onWheel` refactor); View → Zoom In/Out/Actual Size/Zoom to Fit all visibly change the sheet canvas's zoom; opening the frame editor (double-click a frame) and using View → Zoom In there zooms the frame editor's own canvas, not the sheet behind it. 0 console errors.

- [ ] **Step 7: Commit**

```bash
git add js/ui/canvasview.js js/ui/frameeditor.js js/ui/tileeditor.js js/app/main.js
git commit -m "feat: add zoom controls to the View menu"
```

---

### Task 8: Help menu

**Files:**
- Modify: `index.html`
- Modify: `js/app/main.js`
- Modify: `css/app.css`

**Interfaces:**
- Produces: actions `help.about`, `help.shortcuts`.

- [ ] **Step 1: Add the About and Keyboard Shortcuts dialogs**

In `index.html`, add before the closing `</body>` (after the existing `<dialog id="dlg-newstrip">` block):

```html
<dialog id="dlg-about">
  <h3>About PixelArtist</h3>
  <p id="about-version"></p>
  <div class="row"><button id="about-ok">OK</button></div>
</dialog>
<dialog id="dlg-shortcuts" class="sys-dialog">
  <h3>Keyboard Shortcuts</h3>
  <div class="sys-list" id="shortcuts-list"></div>
  <div class="row"><button id="shortcuts-ok">OK</button></div>
</dialog>
```

- [ ] **Step 2: Add the shortcut-row CSS**

Append to `css/app.css`:

```css
/* help dialogs */
.shortcut-row { display: flex; gap: 12px; padding: 3px 0; font-size: 12px; }
.shortcut-keys { min-width: 200px; flex: none; font-weight: 600; color: #b9bbc6; }
.shortcut-desc { color: #9a9ca8; }
```

- [ ] **Step 3: Wire the dialogs and register the actions in main.js**

Add near the end of `main.js`, after the Task 7 zoom-action block and before the `MENUS`/`mountMenuBar` block:

```js
// ---- help ----
const dlgAbout = document.getElementById('dlg-about');
document.getElementById('about-ok').addEventListener('click', () => dlgAbout.close());
defineAction('help.about', {
  label: 'About PixelArtist',
  run: () => {
    document.getElementById('about-version').textContent = 'PixelArtist v0.1.0';
    dlgAbout.showModal();
  },
});

const dlgShortcuts = document.getElementById('dlg-shortcuts');
const shortcutsList = document.getElementById('shortcuts-list');
document.getElementById('shortcuts-ok').addEventListener('click', () => dlgShortcuts.close());
const SHORTCUTS = [
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Y / Ctrl+Shift+Z', 'Redo'],
  ['Ctrl+S', 'Save'],
  ['[ / ]', 'Decrease / increase brush size'],
  ['X', 'Swap primary/secondary color'],
  ['B / E / G / L / U / O / I / M / V', 'Pencil / Eraser / Fill / Line / Rect / Ellipse / Eyedropper / Select / Move'],
  ['F', 'Frame tool (sprite sheets mode)'],
  ['T', 'Tile tool (tile sheets mode)'],
  ['Escape', 'Clear selection / cancel floating selection / back to sheet'],
  ['Space + drag', 'Pan'],
  ['Mouse wheel', 'Zoom'],
  ['Ctrl+X / Ctrl+C / Ctrl+V', 'Cut / copy / paste selection (hold Alt too = all layers)'],
  ['Enter (while floating)', 'Commit the floating selection'],
  ['Delete', 'Delete the selected frame or tile'],
  ['Arrow Up / Down', 'Reorder the selected layer in the Layers panel'],
];
defineAction('help.shortcuts', {
  label: 'Keyboard Shortcuts',
  run: () => {
    shortcutsList.innerHTML = '';
    for (const [keys, desc] of SHORTCUTS) {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const k = document.createElement('span'); k.className = 'shortcut-keys'; k.textContent = keys;
      const d = document.createElement('span'); d.className = 'shortcut-desc'; d.textContent = desc;
      row.append(k, d);
      shortcutsList.appendChild(row);
    }
    dlgShortcuts.showModal();
  },
});
```

- [ ] **Step 4: Add the Help menu to the config**

In `main.js`'s `MENUS` array, add a final entry after `View`:

```js
  { label: 'Help', items: [
    { action: 'help.shortcuts' }, { action: 'help.about' },
  ] },
```

so the array reads (File, Document, Layer, Edit, View, Help in that order).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Manual browser verification**

Dev server, fresh port, `about:blank` first, `?autotest`. Confirm: Help → Keyboard Shortcuts opens a dialog listing the shortcuts, OK closes it; Help → About PixelArtist shows the version string, OK closes it. 0 console errors.

- [ ] **Step 7: Commit**

```bash
git add index.html css/app.css js/app/main.js
git commit -m "feat: add Help menu (About, Keyboard Shortcuts)"
```

---

### Task 9: Icon conversion pass

Converts the remaining multi-word text buttons to icon + `title` tooltip,
matching the convention already used by e.g. `btn-delete-sheet`. Per the
approved spec, dialog Create/Cancel/OK buttons and per-frame-row Edit/Delete
stay as text (short, deliberate, clarity-over-compactness).

**Files:**
- Modify: `js/ui/timeline.js`
- Modify: `js/ui/tilemode.js`
- Modify: `js/ui/tileeditor.js`
- Modify: `js/ui/frameeditor.js`
- Modify: `js/ui/frames.js`

**Interfaces:** None — purely cosmetic `textContent`/`title` changes on existing button elements, no new exports or call-site changes anywhere.

- [ ] **Step 1: Timeline animation buttons**

In `js/ui/timeline.js`, replace (originally lines 198–200):

```js
  const btnNewAnim = document.createElement('button'); btnNewAnim.type = 'button'; btnNewAnim.textContent = 'New';
  const btnRenameAnim = document.createElement('button'); btnRenameAnim.type = 'button'; btnRenameAnim.textContent = 'Rename';
  const btnDeleteAnim = document.createElement('button'); btnDeleteAnim.type = 'button'; btnDeleteAnim.textContent = 'Delete';
```

with:

```js
  const btnNewAnim = document.createElement('button'); btnNewAnim.type = 'button'; btnNewAnim.textContent = '➕'; btnNewAnim.title = 'New animation';
  const btnRenameAnim = document.createElement('button'); btnRenameAnim.type = 'button'; btnRenameAnim.textContent = '✎'; btnRenameAnim.title = 'Rename animation';
  const btnDeleteAnim = document.createElement('button'); btnDeleteAnim.type = 'button'; btnDeleteAnim.textContent = '🗑'; btnDeleteAnim.title = 'Delete animation';
```

- [ ] **Step 2: Timeline break-apart button**

In `js/ui/timeline.js`, replace (originally line 206):

```js
  const btnBreakApart = document.createElement('button'); btnBreakApart.type = 'button'; btnBreakApart.textContent = 'Break apart';
```

with:

```js
  const btnBreakApart = document.createElement('button'); btnBreakApart.type = 'button'; btnBreakApart.textContent = '✂'; btnBreakApart.title = 'Break apart';
```

- [ ] **Step 3: Tile mode's Add Terrain Set button**

In `js/ui/tilemode.js`, replace (originally lines 1649–1652):

```js
  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = '➕ Autotile set';
  btnAddTerrainSet.title = 'Add terrain set';
```

with:

```js
  const addTerrainSetDialog = buildAddTerrainSetDialog();
  const btnAddTerrainSet = document.createElement('button');
  btnAddTerrainSet.type = 'button';
  btnAddTerrainSet.textContent = '➕';
  btnAddTerrainSet.title = 'Add terrain set';
```

(`btnAddGrid` right above it, lines 1642–1646, is already icon+title — no change needed.)

- [ ] **Step 4: Tile editor's back button**

In `js/ui/tileeditor.js`, replace (originally line 82):

```js
  btnBack.type = 'button'; btnBack.textContent = '← Back to sheet';
```

with:

```js
  btnBack.type = 'button'; btnBack.textContent = '⬅'; btnBack.title = 'Back to sheet';
```

- [ ] **Step 5: Frame editor's back button**

In `js/ui/frameeditor.js`, replace (originally line 59):

```js
  btnBack.type = 'button'; btnBack.textContent = '← Back to sheet';
```

with:

```js
  btnBack.type = 'button'; btnBack.textContent = '⬅'; btnBack.title = 'Back to sheet';
```

- [ ] **Step 6: Frame panel's Slice grid / New strip buttons**

In `js/ui/frames.js`, replace (originally lines 1578–1587):

```js
  const sliceDialog = buildSliceDialog();
  const btnSlice = document.createElement('button');
  btnSlice.type = 'button';
  btnSlice.textContent = 'Slice grid…';
  btnSlice.addEventListener('click', () => sliceDialog.open());

  const stripDialog = wireNewStripDialog();
  const btnNewStrip = document.createElement('button');
  btnNewStrip.type = 'button';
  btnNewStrip.textContent = 'New strip…';
```

with:

```js
  const sliceDialog = buildSliceDialog();
  const btnSlice = document.createElement('button');
  btnSlice.type = 'button';
  btnSlice.textContent = '▦';
  btnSlice.title = 'Slice grid…';
  btnSlice.addEventListener('click', () => sliceDialog.open());

  const stripDialog = wireNewStripDialog();
  const btnNewStrip = document.createElement('button');
  btnNewStrip.type = 'button';
  btnNewStrip.textContent = '🎞';
  btnNewStrip.title = 'New strip…';
```

- [ ] **Step 7: Frame panel's Break apart button**

In `js/ui/frames.js`, replace (originally lines 1603–1605):

```js
  const btnBreakApart = document.createElement('button');
  btnBreakApart.type = 'button';
  btnBreakApart.textContent = 'Break apart';
```

with:

```js
  const btnBreakApart = document.createElement('button');
  btnBreakApart.type = 'button';
  btnBreakApart.textContent = '✂';
  btnBreakApart.title = 'Break apart';
```

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all tests pass (purely cosmetic changes, no logic touched).

- [ ] **Step 9: Manual browser verification**

Dev server, fresh port, `about:blank` first, `?autotest`. Confirm every converted button still performs its original action (hover to check the tooltip text, click to confirm behavior): timeline New/Rename/Delete/Break apart, tile panel's Add Terrain Set, both editors' back buttons, frame panel's Slice grid/New strip/Break apart. 0 console errors.

- [ ] **Step 10: Commit**

```bash
git add js/ui/timeline.js js/ui/tilemode.js js/ui/tileeditor.js js/ui/frameeditor.js js/ui/frames.js
git commit -m "feat: convert remaining text buttons to icon + tooltip"
```

---

### Task 10: Button size classes

Defines the three icon-button size tiers and two text-button tiers from the
spec, and applies them to the buttons explicitly named there (tool palette,
top-bar sheet buttons, layer-panel actions, palette-panel actions, dialog
buttons). This task does not attempt to retrofit every button in the app
(e.g. per-row inline buttons deep in the tile/frame panels) — only the
buttons the approved spec named as size-class targets.

**Files:**
- Modify: `css/app.css`
- Modify: `js/ui/tools.js`
- Modify: `index.html`
- Modify: `js/ui/panels.js`

**Interfaces:** None — CSS classes plus `className` assignments on existing elements.

- [ ] **Step 1: Define the size-tier classes**

Append to `css/app.css`:

```css
/* button size tiers */
.btn-icon-sm { width: 22px; height: 22px; padding: 0; font-size: 12px; line-height: 1; }
.btn-icon-md { width: 28px; height: 28px; padding: 0; font-size: 15px; line-height: 1; }
.btn-icon-lg { width: 42px; height: 42px; padding: 0; font-size: 18px; line-height: 1; }
.btn-sm { padding: 2px 6px; font-size: 12px; }
.btn-md { padding: 4px 10px; }
```

- [ ] **Step 2: Apply `.btn-icon-lg` to the tool palette buttons**

In `js/ui/tools.js`, in `makeButton` (originally starting at line 91), replace:

```js
  function makeButton(t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tool = t.id;
```

with:

```js
  function makeButton(t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon-lg';
    btn.dataset.tool = t.id;
```

Since `.tool-buttons button { width: 42px; height: 42px; font-size: 18px; }` (in `css/app.css`, currently around line 22) now duplicates `.btn-icon-lg`, delete that rule — the button's own class carries its sizing now:

```css
.tool-buttons button { width: 42px; height: 42px; font-size: 18px; }
```

- [ ] **Step 3: Apply `.btn-icon-md` to the top-bar sheet-management buttons**

In `index.html`, update the four buttons added in Task 3's header restructure:

```html
    <button id="btn-new-sheet" class="btn-icon-md" title="New sheet">+</button>
    <button id="btn-import-sheet" class="btn-icon-md" title="Import sheet from image">📥</button>
    <button id="btn-rename-sheet" class="btn-icon-md" title="Rename sheet">✎</button>
    <button id="btn-delete-sheet" class="btn-icon-md" title="Delete sheet">🗑</button>
```

- [ ] **Step 4: Apply `.btn-icon-md` to the layer-panel and palette-panel action buttons**

In `js/ui/panels.js`, in `mountLayersPanel` (originally lines 384–387), replace:

```js
  const btnAddLayer = document.createElement('button'); btnAddLayer.textContent = '➕'; btnAddLayer.title = 'Add layer';
  const btnAddGroup = document.createElement('button'); btnAddGroup.textContent = '📁'; btnAddGroup.title = 'Add group';
```

with:

```js
  const btnAddLayer = document.createElement('button'); btnAddLayer.className = 'btn-icon-md'; btnAddLayer.textContent = '➕'; btnAddLayer.title = 'Add layer';
  const btnAddGroup = document.createElement('button'); btnAddGroup.className = 'btn-icon-md'; btnAddGroup.textContent = '📁'; btnAddGroup.title = 'Add group';
```

and immediately below it:

```js
  const btnDelete = document.createElement('button'); btnDelete.textContent = '🗑'; btnDelete.title = 'Delete';
  const btnMerge = document.createElement('button'); btnMerge.textContent = '⬇'; btnMerge.title = 'Merge down';
```

with:

```js
  const btnDelete = document.createElement('button'); btnDelete.className = 'btn-icon-md'; btnDelete.textContent = '🗑'; btnDelete.title = 'Delete';
  const btnMerge = document.createElement('button'); btnMerge.className = 'btn-icon-md'; btnMerge.textContent = '⬇'; btnMerge.title = 'Merge down';
```

Since `.layer-actions button { flex: 1; min-width: 0; padding: 5px 0; font-size: 14px; line-height: 1; text-align: center; }` (in `css/app.css`) would otherwise fight the new fixed-size class (`flex: 1` stretches the button, overriding the 28px width), narrow that rule to stop setting size and only keep layout-relevant properties — replace it with:

```css
.layer-actions { display: flex; gap: 4px; }
.layer-actions button { flex: none; }
```

(This drops the old `.row` styling assumption for this specific button row — `.layer-actions` already carries `class="row layer-actions"` on its container per `js/ui/panels.js` line 383, so `.row`'s own `display:flex; gap:6px` still applies too; the more specific `.layer-actions { display: flex; gap: 4px; }` rule here simply wins on `gap` for this row.)

- [ ] **Step 5: Apply `.btn-sm` to dialog action buttons**

In `index.html`, add `class="btn-sm"` to every dialog's Create/Cancel/OK-style button. Update each of the following (one attribute addition per button, textContent unchanged):

```html
    <button id="export-png" class="btn-sm">Sheet PNG (flattened)</button>
    <button id="export-frames" class="btn-sm" disabled>Frames JSON</button>
    <button id="export-tiles" class="btn-sm" disabled>Tiles JSON</button>
    <button id="export-cancel" class="btn-sm">Cancel</button>
```

```html
    <button id="np-create" class="btn-sm">Create</button><button id="np-cancel" class="btn-sm">Cancel</button>
```

```html
    <button id="ns-create" class="btn-sm">Create</button><button id="ns-cancel" class="btn-sm">Cancel</button>
```

```html
    <button id="rs-ok" class="btn-sm">OK</button><button id="rs-cancel" class="btn-sm">Cancel</button>
```

```html
    <button id="strip-create" class="btn-sm">Create</button><button id="strip-cancel" class="btn-sm">Cancel</button>
```

```html
    <button id="about-ok" class="btn-sm">OK</button>
```

```html
    <button id="shortcuts-ok" class="btn-sm">OK</button>
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all tests pass (CSS/class-only changes, no logic touched).

- [ ] **Step 7: Manual browser verification**

Dev server, fresh port, `about:blank` first, `?autotest`. Confirm: tool palette buttons are still 42×42 and functional; top-bar sheet buttons and layer-panel buttons are now visibly uniform small squares; every dialog's buttons still work and look reasonably sized (not stretched or clipped). 0 console errors.

- [ ] **Step 8: Commit**

```bash
git add css/app.css js/ui/tools.js index.html js/ui/panels.js
git commit -m "feat: unify button sizing via .btn-icon-sm/md/lg and .btn-sm/md classes"
```

---

## Self-Review

**Spec coverage:** Header two-row restructure (Task 3) ✓. Menu bar with all 6 menus (Tasks 3, 5, 6, 8 add menus; Tasks 3, 4, 7 fill them in) ✓. Icon conversion (Task 9, plus the `btn-import-sheet` fix folded into Task 3) ✓. Button size classes (Task 10) ✓. Action registry with event-driven refresh (Tasks 1–2) ✓. Mode-availability hook (`isAvailable`) exists in the registry from Task 1 though no action in this plan currently needs `isAvailable: () => state.mode === …` — every Layer/Document action already only appears when relevant because the containing panel (`panel-context`/`panel-tilelayers`) itself is mode-conditional, so no action in this pass actually needs to hide itself; the hook is there for the next mode (map editor) per the approved spec's explicit ask.

**Placeholder scan:** No TBD/TODO; every step shows complete code.

**Type consistency:** `defineAction`/`getAction`/`runAction`/`bindAction` signatures match from Task 1 through Task 10. `mountMenuBar(el, menus)` signature (Task 3) matches every later task's edits to the same `MENUS` array. `hasSelection`/`paste` (Task 4) match their `defineAction` call sites. `CanvasView.zoomIn/zoomOut/actualSize/fitToView` (Task 7) match `activeCanvasView()`'s call sites.
