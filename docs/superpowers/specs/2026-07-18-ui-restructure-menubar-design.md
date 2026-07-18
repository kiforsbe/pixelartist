# UI Restructure: Menu Bar, Action Registry, Icons, Button Sizing

**Goal:** Add a traditional Windows-style menu bar, restructure the top bar
around mode selection + sheet navigation, convert remaining text buttons to
icons, unify button sizing via CSS classes, and introduce a small action
registry so menu items, buttons, and keyboard shortcuts for the same feature
can never drift out of sync.

## Background

The app currently has a single-row header (`#top-bar`) mixing project-level
buttons (New/Open/Save/Save As/Export), mode tabs, sheet management, overlay
toggles, and undo/redo. Most panel buttons (layers, tiles, palette) already
use icon glyphs; a handful of multi-word text buttons remain. There is no
menu bar, no Cut/Copy/Paste UI (only keyboard shortcuts), no zoom controls
beyond the mouse wheel, and no Help/About/shortcuts reference anywhere.

Every "feature" reachable from more than one place today is wired by hand in
2-3 separate locations (e.g. undo: a keydown handler in `main.js`, a button
click handler, and a manual `btnUndo.disabled = !state.commands.canUndo()`
call triggered off `state.commands.onChange`). Adding a menu bar without
addressing this would triple that duplication.

## 1. Action registry (`js/app/actions.js`)

A minimal Command-pattern registry — the standard fix for this class of
problem (same idea as VSCode commands / Eclipse `IAction` / Swing `Action`).
Each triggerable feature is defined once, wherever its logic already lives;
buttons and menu items become thin views over it.

```js
// js/app/actions.js
const registry = new Map();

export function defineAction(id, def) {
  registry.set(id, {
    label: '', shortcut: null,
    isEnabled: () => true, isChecked: null, isAvailable: () => true,
    ...def,
  });
}
export function getAction(id) { return registry.get(id); }
export function runAction(id) {
  const a = registry.get(id);
  if (!a || !a.isAvailable() || !a.isEnabled()) return;
  a.run();
}
```

- `isEnabled()` — greys out a bound button / disables a menu item (e.g. Undo
  when `!state.commands.canUndo()`).
- `isChecked()` — for toggle-style actions (overlay toggles); omitted (`null`)
  for non-toggle actions.
- `isAvailable()` — mode-gating, mirroring the existing `isAvailable()`
  convention in `tools.js` that hides (not disables) the frame/tile-tool
  palette buttons outside their mode. Defaults to always-available. Actions
  scoped to a specific `state.mode` set this; a future third mode (e.g. a map
  editor) only requires adding another branch here, not touching the
  registry or menu-bar renderer.

**Where actions get defined:** each feature module registers its own actions
next to the code that already implements them — `panels.js` defines
`layer.add`/`layer.delete`/`layer.mergeDown`, `floatsession.js` defines
`edit.cut`/`edit.copy`/`edit.paste`, `main.js` defines `file.save`/`edit.undo`/
etc. No central file needs to know how every feature works; `menubar.js` only
ever references action ids.

**Binding existing buttons — event-driven refresh:** a `bindAction(el, id)`
helper (same file) wires a real DOM button: click → `runAction(id)`, and
registers it so its `disabled`/`hidden`/checked-state gets re-derived
automatically. Rather than each caller remembering to refresh the right
buttons after a mutation (which is exactly the drift bug this registry
exists to kill), `actions.js` subscribes once to the app's existing pub/sub
wildcard listener, `on('*', …)` (`state.js` already supports this — `emit()`
fans out to both the named event and `'*'`), and re-derives *every* bound
element's state on *every* app event:

```js
import { on } from './state.js';

const bound = new Map(); // id -> Set<{ el, toggle }>

export function bindAction(el, id, { toggle = false } = {}) {
  const a = registry.get(id);
  el.title = a.shortcut ? `${a.label} (${a.shortcut})` : a.label;
  el.addEventListener('click', () => runAction(id));
  if (!bound.has(id)) bound.set(id, new Set());
  bound.get(id).add({ el, toggle });
  refreshAction(id);
}

function refreshAction(id) {
  const a = registry.get(id);
  for (const { el, toggle } of bound.get(id) ?? []) {
    const available = a.isAvailable();
    el.hidden = !available;
    el.disabled = !available || !a.isEnabled();
    if (toggle && a.isChecked) {
      const checked = a.isChecked();
      'checked' in el ? el.checked = checked : el.classList.toggle('active', checked);
    }
  }
}

on('*', () => { for (const id of bound.keys()) refreshAction(id); });
```

This replaces today's scattered one-off refresh functions (e.g.
`updateHistoryButtons()`, called manually from `state.commands.onChange`)
with a single sweep that runs whenever *anything* changes app state. At this
app's scale (a few dozen bound elements) that sweep is free; the payoff is
that no feature module ever has to know which other events might affect its
action's enabled state — bind once, correctness is automatic from then on.

**Keyboard shortcuts:** existing keydown handlers call `runAction(id)`
instead of invoking the raw function directly, so keyboard, button, and menu
entry points can never independently drift for the same feature. This is
additive — the handlers stay where they are, only the body changes from "do
the thing" to "run the action that does the thing".

**Menu bar rendering:** `js/ui/menubar.js` takes a declarative tree —
`[{ label: 'File', items: [{ action: 'file.save' }, { separator: true }, …] }]`
— and is the only new code that has to know the *shape* of the menu. It never
imports business logic directly, only `getAction`/`runAction`. Because
dropdowns are opened on demand, item state (`label`/`shortcut`/enabled/
checked/available) is simply read fresh at open-time — no live-refresh
plumbing needed for menu items, only for the small number of persistent
toolbar buttons.

## 2. Header layout

Two rows, replacing the current single `#top-bar`:

**Row 1 — menu bar** (new `#menu-bar`): `File | Edit | Document | Layer |
View | Help`. Traditional click-to-open dropdowns: clicking a top-level item
opens its menu; while one is open, hovering an adjacent top-level item
switches to it; Escape or an outside click closes. Each item shows its
keyboard shortcut text where one exists (e.g. "Undo  Ctrl+Z"). No
quick-access icon cluster on this row — deliberately deferred (see Deferred
Ideas below); undo/redo and the overlay toggles live only in their menus for
now.

**Row 2 — main top bar** (`#top-bar`, restructured): mode selector (Sprite
Sheets / Tile Sheets) pinned at the far left, then sheet
navigation/import-export only: sheet picker, New Sheet, Import Sheet, Rename
Sheet, Delete Sheet. Nothing else lives in this row.

New/Open/Save/Save As/Export move out of the top bar into the File menu
entirely (not duplicated — `Ctrl+S` keeps working via the action registry).

## 3. Menu contents

Only wiring up what already exists as a button or keyboard shortcut, plus the
explicitly-requested new Help menu and View-menu zoom controls — no other new
features invented.

- **File** — New, Open, Save, Save As, Export…
- **Edit** — Undo, Redo, Cut, Copy, Paste. Cut/Copy/Paste currently only
  exist as keyboard shortcuts (`floatsession.js`, exported functions
  `cutSelection`/`copySelection`/`pasteClipboard` already) with no button
  anywhere — this menu is their first UI surface.
- **Document** — New Sheet, Rename Sheet, Delete Sheet, Import Sheet from
  Image. (Sheet-level, not project-level — see Open Question below on the
  File/Document boundary.)
- **Layer** — Add Layer, Add Group, Delete, Merge Down. Mode-gated via
  `isAvailable` where the panel differs between sprite/tile mode (e.g. tile
  mode's separate tile-layer list in `panel-tilelayers`).
- **View** — Toggle Labels, Toggle Sequences, plus new zoom controls backed
  by `core/zoom.js`'s existing `stepZoom`/`snapFitZoom` table and
  `CanvasView.centerFit()` (today only reachable via mouse wheel): **Zoom
  In, Zoom Out, Actual Size (100%), Zoom to Fit**. These act on whichever
  `CanvasView` is currently focused (sheet / frame editor / tile editor, via
  `state.view`).
- **Help** — Keyboard Shortcuts (a static reference dialog listing the
  shortcut catalog below), About PixelArtist (name/version from
  `package.json`). Both new — nothing existed before, and a Help menu was
  explicitly requested.

### Shortcut catalog for the Help dialog

Global: `Ctrl+Z` Undo, `Ctrl+Y`/`Ctrl+Shift+Z` Redo, `Ctrl+S` Save, `[`/`]`
brush size, `X` swap colors, tool hotkeys `B/E/G/L/U/O/I/M/V` (+ `F` frame
tool in sprites mode, `T` tile tool in tiles mode), `Escape` clear selection,
`Space`-drag pan, wheel zoom. Selection: `Ctrl+X/C/V` cut/copy/paste (`+Alt`
= all layers), `Enter`/`Escape` while floating commit/cancel. Frame tool:
`Delete` delete frame, `Enter` accept float. Tile tool: `Delete` delete tile,
`Escape` deselect. Editors: `Escape` back to sheet. Layer panel:
`ArrowUp`/`ArrowDown` reorder.

## 4. Icon conversion

Most panel buttons already use glyphs (➕ 📁 🗑 ⬇ ✎ etc.) — this is largely
done. Remaining text buttons convert to icon + `title` tooltip, matching the
existing convention already used by e.g. `btn-delete-sheet`:

- Timeline dock: New/Rename/Delete animation
- Frame/tile context panels: "Slice grid…", "New strip…", "Break apart",
  "Add grid", "Add terrain set"
- Frame/tile editor toolbars: "← Back to sheet"

Dialog action buttons (Create/Cancel/OK) stay as text — short, deliberate,
infrequent actions where label clarity matters more than compactness.

## 5. Button size classes

New CSS classes in `css/app.css`, applied across static HTML and the
JS-generated panel buttons (`panels.js`, `frames.js`, `tilemode.js`,
`timeline.js`, `frameeditor.js`, `tileeditor.js`):

- `.btn-icon-sm` (22×22px) — dense inline row controls: tree toggles,
  tag-pill remove, timeline playback/remove buttons
- `.btn-icon-md` (28×28px) — standard toolbar icons: top bar, menu-bar
  items' icon slot (if any), panel header actions (add-layer/add-group/
  delete/merge-down, palette actions, tile panel actions)
- `.btn-icon-lg` (42×42px) — tool palette buttons (formalizes the existing
  ad hoc `.tool-buttons button` 42×42 rule into a named, reusable class)
- `.btn-sm` / `.btn-md` — text buttons: dialog buttons stay `.btn-md`
  (current default padding), denser inline text buttons (palette actions)
  get `.btn-sm`

## Deferred ideas (not in this pass)

- A quick-access icon toolbar (undo/redo/overlay toggles) docked somewhere
  in the header, if their menu-only placement turns out to be too many
  clicks away in practice.

## Open question

Whether "New Project" (`btn-new` → `dlg-newproject`) belongs in **File**
(current placement — File → New, the conventional desktop-app location) or
**Document**. This spec keeps it in File since "Document" in this app maps to
a sheet (sprite/tile sheet), not the whole project, and New creates a whole
new project. Flagging in case that reading is wrong.

## Testing

No new automated UI-interaction tests (native pickers and drag interactions
are already established as manual-verification-only in this codebase). Any
new pure logic — e.g. an `isEnabled`/`isAvailable` predicate worth unit
testing in isolation — gets a `node --test` case alongside the existing
182-test suite where it's cheap to do so. Menu open/close/hover-switch
behavior and icon/sizing visual changes get manual verification in-browser.
