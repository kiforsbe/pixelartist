# Animations Workbench Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Animations workbench: a fourth mode with a single-frame canvas, an Animations panel, the Preview, and a minimal timeline (one row of frame columns under animation tags).

**Architecture:** A new `js/modes/animations/` mode owns no documents. It works on the active sprite sheet; sprites mode keeps the document provider and every command, and its `when` predicates admit `'animations'`. The Frame Editor's canvas, onion skin, clipping and float handling move to a shared `js/components/canvas/frame-canvas.js`, used by both the Frame Editor and the new `animations.canvas` view. Pure helpers that both modes need move out of `modes/sprites`: onion skin and playback go to `js/domain/sprites/`, `dispatchLayout` and `drawFit` to `js/components/`. Modes never import sibling modes.

**Tech Stack:** Vanilla ES modules, no build step; `node --test tests/*.mjs`; fake DOM helpers in `tests/helpers/`.

**Spec:** `docs/superpowers/specs/2026-10-09-animations-workbench-design.md` (§3, §7 item 2). Phase 1 plan: `docs/superpowers/plans/2026-10-09-animations-model-engine.md`.

## Global Constraints

- Mode: `id: 'animations'`, label **Animations**, order 15, `documentKinds: ['sprite-sheet']`, default view `animations.canvas`, no document provider.
- Active sheet, animation, frame and layer selection stay per document, so switching between Sprite Sheets and Animations keeps them.
- Canvas shows the selected column's frame at its own size (an auto animation's `cell`), composited from visible layers, with onion skin. Every paint tool works; writes clip to the frame rect. Selection, cut/paste and floats work as in the Frame Editor.
- The pivot is shown as a crosshair and can be dragged. On an auto animation it sets the shared pivot (`animations.setPivot`).
- Timeline columns: every animation's entries, animation after animation in `sheet.animations` order; tags in one lane; frames in no animation do not appear. Clicking a tag selects that animation.
- Animations panel: New (name + canvas size, defaulting to the project frame size), Duplicate, Delete, drag to reorder, name/loop/base duration, Auto-layout / Make manual, Canvas size… (anchor grid).
- Visual style is the app's own (existing panel tokens, controls and icons).
- `tests/architecture.test.mjs`: presentation never imports `application/commands`; domain never imports components/host/modes; modes never import sibling modes.
- No commits (the owner has not authorized them). Each task's "Commit" step is replaced by a ledger line.
- Browser check without drag simulation, loaded with `?autotest`, served by `serve.ps1`.

## Review Focus

1. **Mode switch with a live float.** A paste is floating on the Animations canvas and the user clicks the Sprite Sheets tab. The float commits where it was, inside the frame it was pasted into. *(Task 4 test: "switching to Sprite Sheets settles a float made on the animations canvas")*
2. **Empty states.** No sprite sheet, a sheet with no animations, an animation with no frames. The canvas shows a hint, the timeline is empty, playback is disabled, and nothing throws. *(Tasks 4 and 6 tests)*
3. **The shared `canvas` view kind.** Maps uses `maps.canvas`, and its last segment is the Animations canvas's float view kind. Copy, paste and Delete in maps mode must stay inert. *(Task 4 test: "maps mode paste does not reach the animations canvas")*
4. **A stale `entryIndex` after undo.** The selected column must follow `frameId` when the remembered entry no longer holds that frame. *(Task 6 test: "selectedColumn falls back to frameId when entryIndex is stale")*
5. **New Sheet while in Animations.** It creates a sprite sheet, not a tile sheet, and the sheet selector lists sprite sheets. *(Task 3 tests)*

---

### Task 1: Shared helpers leave `modes/sprites`

Moves code the Animations mode needs and may not import from a sibling mode. Behavior does not change, apart from one addition: `dispatchLayout` stays quiet on a `needsSize` refusal, because callers ask for a size instead.

**Files:**
- Move: `js/modes/sprites/application/onion-skin.js` → `js/domain/sprites/onion-skin.js`
- Move: `js/modes/sprites/application/timeline-playback.js` → `js/domain/sprites/playback.js` (import `effectiveDuration` from `../../core/model.js`)
- Move: `js/modes/sprites/presentation/layout-dispatch.js` → `js/components/layout-dispatch.js`
- Create: `js/components/canvas/draw-fit.js` (the `drawFit` + scratch canvas from `timeline-presenter.js`)
- Modify importers: `frame-editor-presenter.js`, `frame-tool-presenter.js`, `frames-panel.js`, `timeline-presenter.js`
- Test: `tests/onion-skin.test.mjs`, `tests/timeline-playback.test.mjs` (import paths), new `tests/layout-dispatch.test.mjs`

**Interfaces:**
- Produces: `computeOnionGhosts, resolveStepColor, traceOutline` from `js/domain/sprites/onion-skin.js`; `advancePlayback(anim, position, acc, elapsedMs, loop)` from `js/domain/sprites/playback.js`; `dispatchLayout(id, args)` from `js/components/layout-dispatch.js`; `drawFit(canvas, bmp)` from `js/components/canvas/draw-fit.js`.

- [ ] **Step 1: Write the failing test** — `tests/layout-dispatch.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { dispatchLayout } from '../js/components/layout-dispatch.js';

installSpriteContextDom();
const alerts = [];
globalThis.alert = message => alerts.push(message);
const host = new EditorHost(); setEditorHost(host);
const results = { refused: { ok: false, reason: 'No room' }, sized: { ok: false, reason: 'Pick a size', needsSize: true } };
host.registries.commands.register({ id: 'test.layout', execute: (_c, { kind }) => results[kind] });

test('a refusal alerts its reason', () => {
  alerts.length = 0;
  assert.equal(dispatchLayout('test.layout', { kind: 'refused' }).ok, false);
  assert.deepEqual(alerts, ['No room']);
});

test('a needsSize refusal is returned without an alert', () => {
  alerts.length = 0;
  assert.equal(dispatchLayout('test.layout', { kind: 'sized' }).needsSize, true);
  assert.deepEqual(alerts, []);
});
```

- [ ] **Step 2: Run it** — `node --test tests/layout-dispatch.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Move the files** (`git mv` is not needed; uncommitted work — create the new file, delete the old one) and fix every import. `js/components/layout-dispatch.js`:

```js
// js/components/layout-dispatch.js
// Dispatches a layout-changing command for presentation code in either
// workbench. Settles a pending float first (the layout may move the pixels
// under it) and explains a refusal. A needsSize refusal is the caller's to
// handle: it asks the user for a canvas size instead.
import { getEditorHost } from '../host/runtime.js';
import { commitFloatIfAny } from './canvas/float-session.js';

export function dispatchLayout(id, args) {
  commitFloatIfAny();
  const host = getEditorHost();
  const result = host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
  if (result?.ok === false && result.reason && !result.needsSize && typeof alert !== 'undefined') alert(result.reason);
  return result;
}
```

`js/components/canvas/draw-fit.js` holds the scratch canvas and `drawFit` exactly as they are in `timeline-presenter.js` lines 57–100, exported. `timeline-presenter.js` imports it.

- [ ] **Step 4: Run** `node --test tests/layout-dispatch.test.mjs tests/onion-skin.test.mjs tests/timeline-playback.test.mjs tests/timeline-layout-dispatch.test.mjs tests/architecture.test.mjs`. Expected: PASS.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 2: `frame-canvas.js` extracted from the Frame Editor

**Files:**
- Create: `js/components/canvas/frame-canvas.js`
- Create: `js/components/canvas/onion-controls.js`: the onion widgets and their bindings, moved out of the Frame Editor strip unchanged
- Modify: `js/modes/sprites/presentation/frame-editor-presenter.js` (keeps the strip, navigation and Escape; delegates canvas work and the onion controls)
- Test: new `tests/frame-canvas.test.mjs`; existing `frame-editor-context`, `float-structural-transition`, `timeline-layout-dispatch` stay green

**Interfaces:**
- Produces:

```js
createFrameCanvas(hostEl, {
  viewKind,            // float/drawing view kind: 'frame' | 'canvas'
  getFrame,            // () => frame | null   (the frame being edited)
  getOnionAnimation,   // () => animation | null (whose neighbours ghost)
  onStateChange,       // () => void; called while visible on project/history/selection change
}) => {
  view,                // the CanvasView
  sync(),              // loads (recentres) when the frame's identity or size changed, then repaints; returns the frame or null
  shown(),             // call after the host became visible: remeasure, recentre if the host was resized while hidden, sync()
  hidden(),            // call when the host is hidden
  isVisible(),
}
```

```js
buildOnionControls({ onChange }) => { element, sync() }   // element: the .frame-editor-onion-group; sync() reloads values from project.settings.onion
```

Deviation from the spec's `{ frameRect, layers, onionSource }`: the canvas resolves the frame and the onion animation through getters, because both change under it (selection, undo). It renders every sheet layer, as the Frame Editor does today. Ledger this as a ruling.

- [ ] **Step 1: Write the failing tests** — `tests/frame-canvas.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { installSpriteContextDom } from './helpers/sprite-context-dom.mjs';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { spriteMode } from '../js/modes/sprites/index.js';
import { createProject, createSheet, addFrame } from '../js/core/model.js';
import { createFrameCanvas } from '../js/components/canvas/frame-canvas.js';

const { Element } = installSpriteContextDom();
const host = new EditorHost(); setEditorHost(host); host.registerMode(spriteMode); host.start('sprites');
let frame = null, changes = 0;
const canvas = createFrameCanvas(new Element(), { viewKind: 'frame', getFrame: () => frame, getOnionAnimation: () => null, onStateChange: () => { changes++; } });

function reset() {
  const project = createProject('Canvas'); project.settings.onion.enabled = false;
  const sheet = createSheet(project, { name: 'Sheet', width: 16, height: 8, kind: 'sprite' });
  const a = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 4, h: 4 });
  const b = addFrame(sheet, { name: 'B', x: 8, y: 0, w: 8, h: 8 });
  host.setProject(project);
  frame = a; changes = 0;
  return { sheet, a, b };
}

test('sync sizes the view to the frame and maps overlays from sheet space', () => {
  const { b } = reset();
  frame = b; canvas.shown();
  assert.equal(canvas.view.width, 8);
  const origin = canvas.view.imageToScreen(b.x, b.y);
  assert.deepEqual(origin, { x: canvas.view.panX, y: canvas.view.panY });
});

test('sync keeps pan and zoom while the frame stays the same', () => {
  const { a } = reset();
  frame = a; canvas.shown();
  canvas.view.panX += 13;
  canvas.sync();
  const pan = canvas.view.panX;
  canvas.sync();
  assert.equal(canvas.view.panX, pan);
});

test('history changes reach onStateChange only while visible', () => {
  reset(); canvas.shown();
  host.history.execute({ do() {}, undo() {} });
  assert.equal(changes, 1);
  canvas.hidden();
  host.history.execute({ do() {}, undo() {} });
  assert.equal(changes, 1);
});

test('sync with no frame returns null', () => {
  reset(); frame = null;
  assert.equal(canvas.sync(), null);
});
```

- [ ] **Step 2: Run it** — `node --test tests/frame-canvas.test.mjs`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `js/components/canvas/frame-canvas.js`. Move from `frame-editor-presenter.js` unchanged in behavior:
  - the `CanvasView` and its `imageToScreen` override (using `getFrame()`);
  - `getTargetRect`, `mapPoint`, `bindDrawing(view, getTargetRect, mapPoint, viewKind)`;
  - the flat cache (`createRasterCache`, `flattenSheetLayers(currentContextLayers(), …, activeFloating(), sheet.id)`);
  - the ghost cache, `drawGhost`, and `paintOnion`, which takes the animation from `getOnionAnimation()`;
  - `onPaint` (clip, current-alpha fade, onion);
  - `loadFrame`/`loadedFrameId`, the `lastCssW/lastCssH` recentre logic (now in `shown()`/`hidden()`);
  - the four store/history subscriptions. Project, history and selection invalidate the flat cache and call `onStateChange()` while visible. `pixelRevision` invalidates the cache and repaints while visible.

  The onion and flat helpers import `computeOnionGhosts, resolveStepColor, traceOutline` from `../../domain/sprites/onion-skin.js`.

  ```js
  function sync() {
    const f = getFrame();
    if (!f) return null;
    if (loadedFrameId !== f.id || view.width !== f.w || view.height !== f.h) loadFrame(f);
    view.requestRender();
    return f;
  }
  function shown() {
    const wasHidden = !visible;
    visible = true;
    if (wasHidden) {
      view._resize();
      if (loadedFrameId != null && (view.cssWidth !== lastCssW || view.cssHeight !== lastCssH)) view.centerFit();
    }
    return sync();
  }
  function hidden() { lastCssW = view.cssWidth; lastCssH = view.cssHeight; visible = false; }
  ```

  The Frame Editor keeps its own `show()`/`hide()`/`refresh()`. `show()` sets `container.style.display = 'flex'` and calls `fc.shown()`, then `updateStrip()`; if there is no frame it falls back as today. `hide()` calls `fc.hidden()` and hides the container. `refresh()` runs `fc.sync()` (null → the existing fallback to the sheet view) and then `updateStrip()`. `onStateChange: refresh`. `getOnionAnimation` reads `selection.animationId`.
- [ ] **Step 4: Run** `node --test tests/frame-canvas.test.mjs tests/frame-editor-context.test.mjs tests/float-structural-transition.test.mjs tests/timeline-layout-dispatch.test.mjs`. Expected: PASS.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 3: The `animations` mode, its tab, and document plumbing

**Files:**
- Create: `js/modes/animations/index.js`, `js/modes/animations/contributions.js` (registers nothing yet beyond the stub `register(api)`; later tasks add to it)
- Modify: `js/bootstrap.js` (register `animationsMode` between sprites and tiles)
- Modify: `index.html` (`<button id="tab-animations">Animations</button>` after Sprite Sheets)
- Modify: `js/features/project/document-controller.js`. Add the tab: toggle its `active` class and handle its click. Add `sheetKindForMode(mode)`, which returns `'sprite'` for `sprites`/`animations` and `'tile'` otherwise; it replaces the four `mode === 'sprites' ? 'sprite' : 'tile'`. Non-maps switches use the mode's `defaultViewId`.
- Modify: `js/host/document-service.js` `activateMode`: keep the current active document when its kind is in `mode.documentKinds`.
- Modify: `js/modes/sprites/contributions.js`: `whenSprites` for `sprites.*` commands admits `'animations'`. Panels, the preview and the frame tool stay sprites-only.
- Modify: `js/components/panels/layers-panel.js`: a `commandPrefix()` maps `animations` → `sprites` for every `${mode}.x` dispatch; the lock button shows in both sprite workbenches.
- Create: `js/features/workbench/view-switching.js` with `applyViewControllers(viewId, controllers, sheetCanvas)`. `editor-workbench.js` `applyView`/`activeCanvasView` use it and `viewControllers` generically. `updateStatusPlatform` also reads `animations.canvas` (`selection.frameId`).
- Modify: `tests/architecture.test.mjs` sibling list → `['sprites', 'animations', 'tiles', 'maps']`; `tests/helpers/document-controller-fixture.mjs` registers `animationsMode`.
- Test: `tests/document-controller.test.mjs`, `tests/builtinmodes.test.mjs`, new `tests/view-switching.test.mjs`

**Interfaces:**
- Produces: `animationsMode` from `js/modes/animations/index.js`; `registerAnimationsContributions(api)` from `js/modes/animations/contributions.js`; `applyViewControllers(viewId, controllers, sheetCanvas)`.

- [ ] **Step 1: Write the failing tests.**

`tests/document-controller.test.mjs` (append):

```js
test('the Animations tab keeps the active sprite sheet and opens the canvas view', () => {
  const project = reset();
  const second = project.sheets.filter(s => s.kind === 'sprite')[1];
  host.documents.setActive({ kind: 'sprite-sheet', id: second.id });
  elements.get('tab-animations').emit('click');
  const session = host.store.getState().session;
  assert.equal(session.activeModeId, 'animations');
  assert.equal(session.activeViewId, 'animations.canvas');
  assert.equal(session.activeDocument.id, second.id);
});

test('New Sheet in Animations creates a sprite sheet', () => {
  const project = reset();
  host.activateMode('animations');
  runAction('document.newSheet');
  elements.get('ns-name').value = 'Walk'; elements.get('ns-w').value = '8'; elements.get('ns-h').value = '8';
  elements.get('ns-create').emit('click');
  assert.equal(project.sheets.at(-1).kind, 'sprite');
  assert.equal(host.store.getState().session.activeDocument.kind, 'sprite-sheet');
});
```

`tests/builtinmodes.test.mjs` (append):

```js
test('sprites commands run in the animations workbench too', () => {
  const host = new EditorHost();
  host.registerMode(spriteMode); host.registerMode(animationsMode);
  const ids = host.registries.commands.list({ modeId: 'animations' }).map(c => c.id);
  for (const id of ['sprites.renameAnimation', 'sprites.toggleLayerLocked', 'animations.addFrame']) assert.ok(ids.includes(id), id);
  assert.deepEqual(host.registries.modes.list().map(m => m.id), ['sprites', 'animations']);
});
```

Check the command registry's list API (`registries.commands.list(keys)` or equivalent) when writing. If it has no keyed list, assert `execute(id, { modeId: 'animations' }, …)` does not return the `when`-false undefined for a harmless command such as `sprites.renameAnimation` with an unknown sheet.

`tests/view-switching.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyViewControllers } from '../js/features/workbench/view-switching.js';

function controller() { return { shown: false, show() { this.shown = true; }, hide() { this.shown = false; } }; }

test('only the active view controller is shown and the sheet canvas hides under it', () => {
  const frame = controller(), anim = controller(), sheetCanvas = { style: {} };
  const controllers = new Map([['sprites.sheet', { view: {} }], ['sprites.frame', frame], ['animations.canvas', anim]]);
  applyViewControllers('animations.canvas', controllers, sheetCanvas);
  assert.equal(anim.shown, true); assert.equal(frame.shown, false); assert.equal(sheetCanvas.style.display, 'none');
  applyViewControllers('sprites.sheet', controllers, sheetCanvas);
  assert.equal(anim.shown, false); assert.equal(sheetCanvas.style.display, '');
});
```

- [ ] **Step 2: Run** `node --test tests/document-controller.test.mjs tests/builtinmodes.test.mjs tests/view-switching.test.mjs`. Expected: FAIL (no animations mode / module).
- [ ] **Step 3: Implement.**

`js/modes/animations/index.js`:

```js
import { registerAnimationsContributions } from './contributions.js';

// The Animations workbench edits the active sprite sheet (sprites mode owns
// the sprite-sheet document provider and the commands this mode dispatches).
export const animationsMode = Object.freeze({
  id: 'animations', label: 'Animations', order: 15,
  documentKinds: ['sprite-sheet'], defaultViewId: 'animations.canvas',
  register(api) { registerAnimationsContributions(api); },
  activate() {},
});
```

`DocumentService.activateMode`:

```js
const active = state.session.activeDocument;
let reference = active && mode.documentKinds.includes(active.kind) ? this.resolve(active) : null;
reference ??= this.resolve(state.session.activeDocumentByMode[mode.id]);
```

`view-switching.js`:

```js
// One view is visible at a time. A controller with show()/hide() owns its own
// surface inside #canvas-host; the others ({ view }) draw on the shared sheet
// canvas, which hides while an owning controller is up.
export function applyViewControllers(viewId, controllers, sheetCanvas) {
  const owner = controllers.get(viewId);
  sheetCanvas.style.display = typeof owner?.show === 'function' ? 'none' : '';
  for (const [id, controller] of controllers) {
    if (typeof controller.show !== 'function') continue;
    if (id === viewId) controller.show(); else controller.hide();
  }
}
```

`activeCanvasView()`: `s.activeModeId === 'maps' ? mapEditor.view : (viewControllers.get(s.activeViewId)?.view ?? canvasView)`.
- [ ] **Step 4: Run** the three files plus `tests/architecture.test.mjs tests/host.test.mjs tests/layers-panel-opacity.test.mjs tests/sprites-layer-commands.test.mjs`. Expected: PASS. Fix the `builtinmodes` registry lists only if they include the new mode's ids. Task 3 registers no panels or views, so they should not.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 4: The `animations.canvas` view

**Files:**
- Create: `js/modes/animations/application/pivot.js`, `js/modes/animations/presentation/animation-canvas-presenter.js`
- Modify: `js/modes/animations/contributions.js` (register view `animations.canvas`, order 30)
- Modify: `js/components/canvas/drawing-engine.js` (`selectionContext`: `viewKind === 'canvas' ? selected?.frameId`)
- Modify: `js/components/canvas/float-session.js` (watcher tuple adds `view === 'animations.canvas' ? selection?.frameId : null`)
- Modify: `js/modes/sprites/application/commands/frame-metadata-commands.js` (+ `setFramePivot`), `js/modes/sprites/contributions.js` (`sprites.setFramePivot`), `tests/builtinmodes.test.mjs` (exact id list)
- Modify: `css/app.css` (`.anim-canvas-empty`, `.anim-pivot-layer`)
- Test: new `tests/animation-pivot.test.mjs`, new `tests/animation-canvas.test.mjs`

**Interfaces:**
- Consumes: `createFrameCanvas`, `buildOnionControls` (Task 2), `autoAnimationOf` (domain).
- Produces: `mountAnimationCanvas(hostEl) => { show, hide, view }`. Also `pivotFromPoint(frame, x, y) => { pivotX, pivotY }`, which rounds to 0.5 and clamps to `[0,w]×[0,h]`, and `pivotCommand(sheet, frame, pivot) => { id, args }`. Command `sprites.setFramePivot {sheetId, frameId, pivotX, pivotY}` makes one history step and refuses pinned frames with `PINNED_HINT`.

The strip holds the name (`<animation> · <frame>`), **Show on sheet**, a **Pivot** toggle, and the shared onion controls (`buildOnionControls`, Task 2). An empty-state hint shows when there is no frame. In pivot mode an overlay div covers the canvas. Pointer down/move preview the crosshair; pointer up dispatches `pivotCommand`. The crosshair is always drawn (in the accent colour while pivot mode is on).

- [ ] **Step 1: Write the failing tests.**

`tests/animation-pivot.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createSheet, addFrame, addAnimation } from '../js/core/model.js';
import { pivotFromPoint, pivotCommand } from '../js/modes/animations/application/pivot.js';

function sheetWith(layout) {
  const sheet = createSheet(createProject('P'), { name: 'S', width: 16, height: 8, kind: 'sprite' });
  const f = addFrame(sheet, { name: 'A', x: 0, y: 0, w: 8, h: 8 });
  const anim = addAnimation(sheet, 'Run');
  Object.assign(anim, { layout, cell: layout === 'auto' ? { w: 8, h: 8 } : null, frames: [{ frameId: f.id, duration: null }] });
  return { sheet, f, anim };
}

test('pivotFromPoint rounds to half pixels and clamps to the frame', () => {
  const frame = { w: 8, h: 8 };
  assert.deepEqual(pivotFromPoint(frame, 3.3, 4.8), { pivotX: 3.5, pivotY: 5 });
  assert.deepEqual(pivotFromPoint(frame, -2, 11), { pivotX: 0, pivotY: 8 });
});

test('an auto frame sets its animation pivot; a manual frame sets its own', () => {
  const auto = sheetWith('auto');
  assert.deepEqual(pivotCommand(auto.sheet, auto.f, { pivotX: 2, pivotY: 3 }),
    { id: 'animations.setPivot', args: { sheetId: auto.sheet.id, animationId: auto.anim.id, pivotX: 2, pivotY: 3 } });
  const manual = sheetWith('manual');
  assert.deepEqual(pivotCommand(manual.sheet, manual.f, { pivotX: 2, pivotY: 3 }),
    { id: 'sprites.setFramePivot', args: { sheetId: manual.sheet.id, frameId: manual.f.id, pivotX: 2, pivotY: 3 } });
});
```

`tests/animation-canvas.test.mjs` uses the `sprite-context-dom` helper and registers `spriteMode`, `animationsMode` and `mapMode` on one host. It mounts `mountAnimationCanvas(new Element())` and calls `initFloatSession()`. Its `reset()` builds a 16×8 sheet with an auto animation of two 8×8 frames A (0,0) and B (8,0), a blue pixel at (9,1), selection `{animationId, frameId: a.id, layerId}`, `activateMode('animations')`, and `canvas.show()`. Tests:

```js
test('the canvas shows the selected frame at its own size', async () => {
  const { b } = await reset();
  assert.equal(canvas.view.width, 8);
  host.selections.patch({ frameId: b.id });
  assert.equal(surface.querySelector('.frame-editor-name').textContent, 'Run · B');
});

test('with no frame the canvas shows the empty hint', async () => {
  await reset(); host.selections.patch({ frameId: null });
  assert.equal(surface.querySelector('.anim-canvas-empty').hidden, false);
});

test('a float made on the animations canvas settles when the column changes', async () => {
  const { b, layer } = await reset();
  host.selections.patch({ frameId: b.id });
  assert.equal(createFloat({ region: { x: 8, y: 0, w: 8, h: 8 } }), true);
  activeFloating().transform.tx = 1;
  host.selections.patch({ frameId: (await currentIds()).a });
  assert.equal(activeFloating(), null);
  assert.deepEqual(getPixel(layer.bitmap, 10, 1), blue);
});

test('switching to Sprite Sheets settles a float made on the animations canvas', async () => {
  const { b, layer } = await reset();
  host.selections.patch({ frameId: b.id });
  createFloat({ region: { x: 8, y: 0, w: 8, h: 8 } }); activeFloating().transform.tx = 1;
  host.activateMode('sprites');
  assert.equal(activeFloating(), null);
  assert.deepEqual(getPixel(layer.bitmap, 10, 1), blue);
});

test('maps mode paste does not reach the animations canvas', async () => {
  await reset();
  host.activateMode('maps');
  assert.equal(createFloat({ region: { x: 0, y: 0, w: 1, h: 1 } }), false);
});

test('dropping the pivot on an auto frame sets the shared pivot in one step', async () => {
  const { anim, sheet } = await reset();
  surface.querySelector('.anim-pivot-toggle').fire('click');
  const layerEl = surface.querySelector('.anim-pivot-layer');
  const at = canvas.view.imageToScreen(sheet.frames[0].x + 2, sheet.frames[0].y + 6);
  layerEl.fire('pointerdown', { clientX: at.x, clientY: at.y, pointerId: 1, button: 0 });
  layerEl.fire('pointerup', { clientX: at.x, clientY: at.y, pointerId: 1, button: 0 });
  for (const id of new Set(anim.frames.map(e => e.frameId))) {
    const f = sheet.frames.find(fr => fr.id === id);
    assert.deepEqual([f.pivotX, f.pivotY], [2, 6]);
  }
  host.history.undo();
  assert.deepEqual([sheet.frames[0].pivotX, sheet.frames[0].pivotY], [0, 0]);
});

test('Show on sheet opens Sprite Sheets on the same frame', async () => {
  const { b } = await reset();
  host.selections.patch({ frameId: b.id });
  surface.querySelectorAll('button').find(btn => btn.textContent === 'Show on sheet').fire('click');
  assert.equal(host.store.getState().session.activeModeId, 'sprites');
  assert.equal(host.selections.get().frameId, b.id);
});
```

When writing the test, replace `(await currentIds()).a` with the `a` that `reset()` returns. Also check the default pivot `addFrame` gives a frame; the undo assertion must compare against that default. The fake `Element` needs `setPointerCapture() {}` and `hidden`; add `setPointerCapture`/`releasePointerCapture` no-ops to the helper.

- [ ] **Step 2: Run** `node --test tests/animation-pivot.test.mjs tests/animation-canvas.test.mjs`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement.**

`pivot.js`:

```js
import { autoAnimationOf } from '../../../domain/sprites/auto-layout.js';

const half = v => Math.round(v * 2) / 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Frame-local point -> pivot, on the half-pixel grid the Frames panel uses.
export function pivotFromPoint(frame, x, y) {
  return { pivotX: clamp(half(x), 0, frame.w), pivotY: clamp(half(y), 0, frame.h) };
}

// An auto frame's pivot is its animation's shared pivot.
export function pivotCommand(sheet, frame, { pivotX, pivotY }) {
  const auto = autoAnimationOf(sheet, frame.id);
  return auto
    ? { id: 'animations.setPivot', args: { sheetId: sheet.id, animationId: auto.id, pivotX, pivotY } }
    : { id: 'sprites.setFramePivot', args: { sheetId: sheet.id, frameId: frame.id, pivotX, pivotY } };
}
```

`setFramePivot` (frame-metadata-commands.js):

```js
export function setFramePivot(services, sheetId, frameId, pivotX, pivotY) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  if (isPinnedFrame(sheet, frameId)) return { ok: false, reason: PINNED_HINT };
  const before = { pivotX: frame.pivotX, pivotY: frame.pivotY };
  if (before.pivotX === pivotX && before.pivotY === pivotY) return { ok: true };
  runSheetCommand(services, sheetId, 'edit frame pivot',
    () => { frame.pivotX = pivotX; frame.pivotY = pivotY; },
    () => { Object.assign(frame, before); });
  return { ok: true };
}
```

`animation-canvas-presenter.js` (outline). The container is `div.frame-editor.anim-canvas`, display toggled by show/hide like the Frame Editor. It holds the strip (`span.frame-editor-name`, Show on sheet button, `button.anim-pivot-toggle`, onion checkbox), an `div.anim-canvas-empty` hint ("No frame selected — create an animation in the Animations panel"), and `div.frame-editor-canvas`. Inside the canvas div are the frame canvas and `div.anim-pivot-layer`, hidden unless pivot mode is on.

```js
const fc = createFrameCanvas(canvasDiv, { viewKind: 'canvas', getFrame: currentFrame, getOnionAnimation: currentAnim, onStateChange: refresh });
function refresh() { const f = fc.sync(); empty.hidden = !!f; nameLabel.textContent = f ? `${currentAnim()?.name ?? ''} · ${f.name}` : ''; }
// Pivot overlay: frame-local float coordinates from the view's pan/zoom.
function localPoint(e) {
  const rect = pivotLayer.getBoundingClientRect();
  return { x: (e.clientX - rect.left - fc.view.panX) / fc.view.zoom, y: (e.clientY - rect.top - fc.view.panY) / fc.view.zoom };
}
```

The crosshair is drawn in an `onOverlay` wrapper (call the prior overlay first). It uses `view.imageToScreen(f.x + pivot.pivotX, f.y + pivot.pivotY)`, because the overridden `imageToScreen` takes sheet coordinates. Show on sheet: `getEditorHost().activateMode('sprites')`.
- [ ] **Step 4: Run** both files plus `tests/frame-canvas.test.mjs tests/frame-editor-context.test.mjs tests/float-structural-transition.test.mjs tests/builtinmodes.test.mjs tests/architecture.test.mjs`. Expected: PASS.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 5: The Animations panel

**Files:**
- Create: `js/modes/animations/presentation/animation-list-panel.js`
- Modify: `js/modes/animations/contributions.js`. Register panel `animations.list`: title 'Animations', region right, order 20, `mountPoint: 'panel-animation'`, persistent, `when` = animations mode.
- Modify: `css/app.css` (`.anim-list`, `.anim-row`, `.anim-row.active`, `.anim-badge`, `.anim-form`, `.anchor-grid`)
- Test: new `tests/animation-list-panel.test.mjs`

**Interfaces:**
- Consumes: `dispatchLayout` (Task 1, quiet on `needsSize`), `drawFit` (Task 1), `buildBaseDurationControl`.
- Produces: `mountAnimationListPanel(el)`. Selecting a row patches `{ animationId, frameId: firstFrameId ?? null, entryIndex: 0 }`.

Layout:
- `h3` "Animations".
- Toolbar: `New…`, `Duplicate`, `Delete`.
- Inline new-form `div.anim-form.anim-new-form` (hidden): name, W, H (defaults `project.settings.frameW/frameH`, falling back to 16), Create, Cancel.
- List `div.anim-list` of `div.anim-row`: a 32px thumbnail canvas of the first frame, the name, and `span.anim-badge` `auto`/`manual`. Rows are draggable: `dragstart` sets `text/plain` to the index; `drop` dispatches `animations.reorderAnimations {from, to}`.
- Details for the selected animation:
  - name input → `sprites.renameAnimation`;
  - Loop checkbox → `sprites.toggleAnimationLoop`;
  - base duration control → `sprites.setAnimationBaseDuration`;
  - layout row: auto → `Make manual` + `Canvas size…`; manual → `Auto-layout`;
  - inline size form `div.anim-form.anim-size-form` (hidden): W, H, a 3×3 `div.anchor-grid` of buttons `nw…se` (default `c`, the selected one `.active`), Apply, Cancel. It serves both Canvas size… (`animations.resizeCanvas {w,h,anchor}`) and an Auto-layout that came back `needsSize` (prefilled with `suggested`; Apply → `animations.autoLayout {size:{w,h}}`; the anchor grid hidden in that use).
- Delete confirms with `confirmOrAuto`. The message for an auto animation mentions its frames.

Check the real project settings key for the default frame size (`frameW`/`frameH` or similar) in `js/core/model.js` `createProject` when writing.

- [ ] **Step 1: Write the failing tests** — `tests/animation-list-panel.test.mjs` (sprite-context-dom; `spriteMode` + `animationsMode`; `globalThis.alert` collects; `globalThis.location = { search: '?autotest' }` so `confirmOrAuto` passes). `reset()` builds a 32×16 sheet with auto "Run" (two 8×8 frames) and manual "Idle" (one 4×4 frame plus one 8×8 frame, different sizes), and activates `animations`.

```js
test('rows list every animation with its layout badge', async () => {
  await reset();
  assert.deepEqual(panel.querySelectorAll('.anim-row').map(r => r.querySelector('.anim-badge').textContent), ['auto', 'manual']);
});

test('clicking a row selects the animation and its first frame', async () => {
  const { idle } = await reset();
  panel.querySelectorAll('.anim-row')[1].fire('click');
  const sel = host.selections.get();
  assert.equal(sel.animationId, idle.id);
  assert.equal(sel.frameId, idle.frames[0].frameId);
  assert.equal(sel.entryIndex, 0);
});

test('New creates an auto animation of the entered size', async () => {
  const { sheet } = await reset();
  button('New…').fire('click');
  const form = panel.querySelector('.anim-new-form');
  const [name, w, h] = form.querySelectorAll('input');
  name.value = 'Jump'; w.value = '12'; h.value = '10';
  button('Create').fire('click');
  const jump = sheet.animations.at(-1);
  assert.equal(jump.name, 'Jump'); assert.deepEqual(jump.cell, { w: 12, h: 10 });
  assert.equal(host.selections.get().animationId, jump.id);
});

test('Auto-layout of mixed sizes asks for a canvas size instead of alerting', async () => {
  const { idle } = await reset();
  host.selections.patch({ animationId: idle.id });
  button('Auto-layout').fire('click');
  assert.deepEqual(alerts, []);
  const form = panel.querySelector('.anim-size-form');
  assert.equal(form.hidden, false);
  const [w, h] = form.querySelectorAll('input');
  assert.deepEqual([w.value, h.value], ['8', '8']);
  button('Apply').fire('click');
  assert.equal(idle.layout, 'auto'); assert.deepEqual(idle.cell, { w: 8, h: 8 });
});

test('Canvas size applies with the chosen anchor', async () => {
  const { run, sheet } = await reset();
  host.selections.patch({ animationId: run.id });
  button('Canvas size…').fire('click');
  const form = panel.querySelector('.anim-size-form');
  const [w, h] = form.querySelectorAll('input'); w.value = '10'; h.value = '8';
  form.querySelectorAll('.anchor-grid button').find(b => b.dataset.anchor === 'w').fire('click');
  button('Apply').fire('click');
  assert.deepEqual(run.cell, { w: 10, h: 8 });
  host.history.undo(); assert.deepEqual(run.cell, { w: 8, h: 8 });
});

test('Delete removes the selected animation', async () => {
  const { run, sheet } = await reset();
  host.selections.patch({ animationId: run.id });
  button('Delete').fire('click');
  assert.equal(sheet.animations.some(a => a.id === run.id), false);
});

test('dropping a row reorders animations', async () => {
  const { sheet, idle } = await reset();
  const rows = panel.querySelectorAll('.anim-row');
  const data = new Map();
  const dataTransfer = { setData: (k, v) => data.set(k, v), getData: k => data.get(k), effectAllowed: '', dropEffect: '' };
  rows[1].fire('dragstart', { dataTransfer });
  rows[0].fire('drop', { dataTransfer });
  assert.equal(sheet.animations[0].id, idle.id);
});
```

`button(text)` = `panel.querySelectorAll('button').find(b => b.textContent === text)`.

- [ ] **Step 2: Run** `node --test tests/animation-list-panel.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `animation-list-panel.js` as specified above, using `mountStorePanel` (project, mode, document, selection) plus a history subscription, like `animations-panel.js`. When the mode is not `animations`, `render()` hides `el`. A drop onto row *i* moves the dragged index to *i*.
- [ ] **Step 4: Run** `node --test tests/animation-list-panel.test.mjs tests/builtinmodes.test.mjs`. Expected: PASS. Update the `builtinmodes` panel list assertions only if the test registers `animationsMode`; it registers sprites/tiles/maps today.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 6: The minimal timeline and the Preview

**Files:**
- Create: `js/modes/animations/application/timeline-model.js`, `js/modes/animations/presentation/animation-timeline-presenter.js`, `js/modes/animations/preview.js`
- Modify: `index.html`: `<div id="anim-timeline-dock" data-workbench-region="bottom-animations" hidden></div>` after `#timeline-dock`.
- Modify: `css/app.css`: `#anim-timeline-dock` shares `#timeline-dock`'s grid cell and style; `.anim-tl-row`, `.anim-tag`, `.anim-tl-num`, `.anim-tl-cell`, `.anim-tl-cell.selected`, `.anim-tl-cell.playhead`, `.anim-tl-linked`.
- Modify: `js/modes/animations/contributions.js`:
  - panel `animations.timeline`: region bottom, `mountPoint: 'anim-timeline-dock'`, `useMountPointDirect`, persistent, `when` = animations mode;
  - preview `animations.preview`, `when` = animations mode.
- Modify: `js/components/panels/preview-panel.js`: `setPreviewBitmap` accepts `sprites` and `animations`.
- Test: new `tests/animation-timeline-model.test.mjs`, new `tests/animation-timeline.test.mjs`

**Interfaces:**
- Produces:
  - `timelineColumns(sheet) => [{ animationId, index, frameId, linked }]`: `linked` is true when the frame appeared at an earlier index of the same animation.
  - `tagSpans(sheet) => [{ animationId, name, start, length }]`: one per animation with entries.
  - `selectedColumn(columns, selection) => number`: -1 when nothing matches.
  - `mountAnimationTimeline(el)`.
  - `renderAnimationsPreview({ overrideLayers })`: `{ managed: true }` unless a filter preview passes override layers; then it renders the selected frame from them.

Header controls, by title: First, Previous, Play/Stop, Next, Last, the Loop checkbox, and `+ Frame` / `Duplicate` / `✕` for the selected column. The add buttons are disabled with the title "Auto-layout this animation first" on a manual animation. `✕` dispatches `animations.deleteFrame` (auto) or `sprites.removeAnimationFrame` (manual). The grid has three rows: tags (width = length × column width; click selects the animation's first column), numbers (1-based, global), and cells (thumbnail; click selects; `.selected` on the selected column; `.playhead` while playing). Playback plays the selected animation's columns into the Preview and stops before any structural change, on mode leave, and on column click. Prev/Next walk all columns; First/Last stay within the selected animation.

- [ ] **Step 1: Write the failing tests.**

`tests/animation-timeline-model.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineColumns, tagSpans, selectedColumn } from '../js/modes/animations/application/timeline-model.js';

const sheet = {
  animations: [
    { id: 'run', name: 'Run', frames: [{ frameId: 'a' }, { frameId: 'b' }, { frameId: 'a' }] },
    { id: 'none', name: 'Empty', frames: [] },
    { id: 'idle', name: 'Idle', frames: [{ frameId: 'c' }] },
  ],
};

test('columns run animation after animation and mark repeated frames as linked', () => {
  assert.deepEqual(timelineColumns(sheet), [
    { animationId: 'run', index: 0, frameId: 'a', linked: false },
    { animationId: 'run', index: 1, frameId: 'b', linked: false },
    { animationId: 'run', index: 2, frameId: 'a', linked: true },
    { animationId: 'idle', index: 0, frameId: 'c', linked: false },
  ]);
});

test('tags span their animation and skip empty ones', () => {
  assert.deepEqual(tagSpans(sheet), [
    { animationId: 'run', name: 'Run', start: 0, length: 3 },
    { animationId: 'idle', name: 'Idle', start: 3, length: 1 },
  ]);
});

test('selectedColumn uses entryIndex when it still holds the selected frame', () => {
  assert.equal(selectedColumn(timelineColumns(sheet), { animationId: 'run', frameId: 'a', entryIndex: 2 }), 2);
});

test('selectedColumn falls back to frameId when entryIndex is stale', () => {
  assert.equal(selectedColumn(timelineColumns(sheet), { animationId: 'run', frameId: 'b', entryIndex: 2 }), 1);
  assert.equal(selectedColumn(timelineColumns(sheet), { animationId: 'idle', frameId: 'zzz' }), -1);
});
```

`tests/animation-timeline.test.mjs` uses sprite-context-dom with `spriteMode` and `animationsMode`, and mounts `mountAnimationTimeline(dock)`. `reset()` builds auto "Run" (two 8×8 frames, A and B) and auto "Jump" (one frame C), selects Run/A with `entryIndex: 0`, and activates `animations`.

```js
test('tags and cells render one column per entry', async () => {
  await reset();
  assert.deepEqual(dock.querySelectorAll('.anim-tag').map(t => t.textContent), ['Run', 'Jump']);
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 3);
  assert.equal(dock.querySelectorAll('.anim-tl-cell')[0].classList.contains('selected'), true);
});

test('clicking a cell of another animation selects that animation and frame', async () => {
  const { jump } = await reset();
  dock.querySelectorAll('.anim-tl-cell')[2].fire('click');
  const sel = host.selections.get();
  assert.equal(sel.animationId, jump.id); assert.equal(sel.frameId, jump.frames[0].frameId); assert.equal(sel.entryIndex, 0);
});

test('clicking a tag selects that animation at its first column', async () => {
  const { jump } = await reset();
  dock.querySelectorAll('.anim-tag')[1].fire('click');
  assert.equal(host.selections.get().animationId, jump.id);
});

test('+ Frame inserts after the selected column and selects the new frame', async () => {
  const { run } = await reset();
  byTitle('Add a blank frame after this one').fire('click');
  assert.equal(run.frames.length, 3);
  assert.equal(host.selections.get().frameId, run.frames[1].frameId);
  assert.equal(dock.querySelectorAll('.anim-tl-cell')[1].classList.contains('selected'), true);
});

test('the remove button deletes the selected column', async () => {
  const { run } = await reset();
  byTitle('Remove this frame').fire('click');
  assert.equal(run.frames.length, 1);
});

test('Next walks into the following animation', async () => {
  const { jump } = await reset();
  byTitle('Next frame').fire('click'); byTitle('Next frame').fire('click');
  assert.equal(host.selections.get().animationId, jump.id);
});

test('playback pushes frames to the preview and stops on a structural change', async () => {
  await reset();
  const play = byTitle('Play');
  play.fire('click');
  assert.equal(play.title, 'Stop');
  byTitle('Remove this frame').fire('click');
  assert.equal(byTitle('Play').textContent, '▶');
});

test('a sheet without animations shows an empty timeline with playback disabled', async () => {
  const { sheet } = await reset();
  sheet.animations.length = 0; host.history.execute({ do() {}, undo() {} });
  assert.equal(dock.querySelectorAll('.anim-tl-cell').length, 0);
  assert.equal(byTitle('Play').disabled, true);
});
```

`byTitle(t)` = `dock.querySelectorAll('button').find(b => b.title === t)`.

- [ ] **Step 2: Run** `node --test tests/animation-timeline-model.test.mjs tests/animation-timeline.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.**

`timeline-model.js`:

```js
// Pure column/tag math for the Animations timeline (spec §3 "Timeline").
export function timelineColumns(sheet) {
  const columns = [];
  for (const anim of sheet?.animations ?? []) {
    const seen = new Set();
    anim.frames.forEach((entry, index) => {
      columns.push({ animationId: anim.id, index, frameId: entry.frameId, linked: seen.has(entry.frameId) });
      seen.add(entry.frameId);
    });
  }
  return columns;
}

export function tagSpans(sheet) {
  const spans = [];
  let start = 0;
  for (const anim of sheet?.animations ?? []) {
    if (anim.frames.length) spans.push({ animationId: anim.id, name: anim.name, start, length: anim.frames.length });
    start += anim.frames.length;
  }
  return spans;
}

// The selected column: the remembered entry while it still holds the selected
// frame, else the animation's first use of that frame (undo/redo and layout
// commands patch frameId, not entryIndex).
export function selectedColumn(columns, { animationId, frameId, entryIndex } = {}) {
  const exact = columns.findIndex(c => c.animationId === animationId && c.index === entryIndex && c.frameId === frameId);
  if (exact !== -1) return exact;
  return columns.findIndex(c => c.animationId === animationId && c.frameId === frameId);
}
```

The presenter follows `timeline-presenter.js`'s structure: `mountStorePanel` over project, mode, view, document, `pixelRevision` and selection, plus history, with `onDispose: stopPlaying`. Playback uses `advancePlayback` from `domain/sprites/playback.js` and `setPreviewBitmap`. Thumbnails use `createRasterCache` + `flattenSheetLayers(currentContextLayers(), …)` + `copyRegion` + `drawFit`. Column width is 40px; thumbnails are 32px. When not playing, the preview shows the selected column's frame (`null` when none).
- [ ] **Step 4: Run** both files plus `tests/builtinmodes.test.mjs tests/architecture.test.mjs`. Expected: PASS.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 7: Edit in Animations

**Files:**
- Modify: `js/modes/sprites/presentation/timeline-presenter.js`: header button `Edit in Animations` (disabled without a selected animation).
- Test: `tests/timeline-layout-dispatch.test.mjs` (same host/fixture style; register `animationsMode`)

On click: if the selected frame is not one of the animation's entries, patch `{ frameId: <first entry's frameId>, entryIndex: 0 }`; otherwise patch `entryIndex` to that frame's first index. Then `getEditorHost().activateMode('animations')`. Presentation may call `activateMode`; it is a host API, not a command.

- [ ] **Step 1: Write the failing test** (append to `tests/timeline-layout-dispatch.test.mjs`; register `animationsMode` alongside `spriteMode` at the top):

```js
test('Edit in Animations opens the Animations workbench on the selected animation', async () => {
  const { anim, a } = await reset();
  host.selections.patch({ frameId: 'not-in-anim' });
  timeline.querySelectorAll('button').find(b => b.textContent === 'Edit in Animations').fire('click');
  assert.equal(host.store.getState().session.activeModeId, 'animations');
  const sel = host.selections.get();
  assert.equal(sel.animationId, anim.id); assert.equal(sel.frameId, a.id); assert.equal(sel.entryIndex, 0);
  host.activateMode('sprites');
});
```

- [ ] **Step 2: Run** `node --test tests/timeline-layout-dispatch.test.mjs`. Expected: FAIL (no button).
- [ ] **Step 3: Implement** the button.
- [ ] **Step 4: Run** `node --test tests/timeline-layout-dispatch.test.mjs tests/frame-editor-context.test.mjs`. Expected: PASS.
- [ ] **Step 5: Ledger** (`task-done`, full suite).

---

### Task 8: Docs and browser check

**Files:**
- Modify: `README.md`. Add an "Animations workbench" section: the tab; the canvas, pivot and Show on sheet; the Animations panel; the timeline (tags, columns, playback, + Frame / Duplicate / ✕); Edit in Animations.
- Modify: `docs/ARCHITECTURE.md`. Module counts; the animations mode (no provider; borrows sprites commands through `when`); `frame-canvas.js`; the moved shared helpers; generic view switching.
- Modify: the spec. Append `## Implementation notes (Phase 2)` with each ruling that changed the design: the frame-canvas signature, the separate timeline dock, `sprites.setFramePivot`, the Layers panel staying visible until Phase 3, `entryIndex`, and the + Frame / Duplicate / ✕ header buttons.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Browser check** (no drags). Start `serve.ps1` if it is not running, and load `/?autotest`.
  1. Click the Animations tab with the default project.
  2. Create an animation in the Animations panel.
  3. Click-paint one pixel on the canvas (pencil), then undo.
  4. Click + Frame, then click a timeline cell.
  5. Click Show on sheet.
  6. Check the console for errors.
- [ ] **Step 3: Ledger** (no test run: docs only; the browser check is recorded in the ledger).
