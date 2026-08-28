# Phase 4 Groups 3+5: Per-Mode Cleanup + Final Legacy Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete `js/app/state.js` and `js/app` entirely, by migrating every remaining importer (42 files, not the original 29 — see scope note below) off it, including fully encapsulating the undo `CommandStack` inside `HistoryService` and converting the ~14 direct-push undo commands that currently bypass Command Handlers into proper, re-resolve-by-id Command Handlers.

**Architecture:** `EditorStore` + host services (`HistoryService`, `ProjectService`, `DocumentService`, `SelectionService`) become the sole source of truth. Every mode file and shared component reads state via `getEditorHost()`/`store.subscribe()` instead of the legacy mutable `state` object and `on()`/`emit()` bus. Undo-tracked edits go exclusively through registered Command Handlers (`registries.commands.execute(id, context, args)`), which internally call `services.history.execute({do, undo})` — never a raw `state.commands.push()`.

**Tech Stack:** Vanilla JS ES modules, no build step, `node:test`/`node:assert/strict` for tests, Playwright MCP for manual browser verification.

**Spec:** [2026-08-17-phase-4-group-3-5-mode-cleanup-design.md](../specs/2026-08-17-phase-4-group-3-5-mode-cleanup-design.md) (parent spec for the original 29-file scope: [2026-08-10-phase-4-shell-legacy-retirement-design.md](../specs/2026-08-10-phase-4-shell-legacy-retirement-design.md))

## Scope correction vs. the design spec (found during planning, 2026-08-18)

The design spec scoped this to 29 `js/modes/**` files. A full-repo grep found **42 files** still import `js/app/state.js`: the 29 mode files, 7 shared `js/components/` files (`layers-panel.js`, `color-panel.js`, `drawing-engine.js`, `float-session.js`, `sheet-overlays.js`, `tool-palette.js`, `preview-panel.js`), 5 already-"migrated" Group-4 shell files with small residual imports (`editor-workbench.js`, `filter-controller.js`, `project-controller.js`, `file-controller.js`, `document-controller.js`), and `bootstrap.js` itself. All 42 are covered by this plan (Tasks 6-9).

Separately, three of those files (`drawing-engine.js`, `layers-panel.js`, `color-panel.js`) push raw `{do,undo}` command objects directly onto the shared `CommandStack` instance (`state.commands`), bypassing Command Handlers entirely — ~14 sites in total (2 + 11 + 2, respectively; a 15th, `terrain-preset-art.js:56`, is explicitly excluded, see Task 8). The user explicitly chose (after being shown the size/risk) to fully encapsulate `HistoryService`'s `CommandStack` and convert all ~14 sites to proper Command Handlers as part of this plan, rather than deferring that conversion to a separate future phase (Tasks 1, 2, 3, 4, 5 cover this).

### Execution amendment (approved 2026-08-26)

The first Task 3-6 implementation pass exposed a gap between this plan and the parent spec's state-field mapping. `color-panel.js`, `drawing-engine.js`, `layers-panel.js`, `float-session.js`, and several preview/shell consumers still depend on `state.primary`, `state.secondary`, `state.brushSize`, `state.floating`, and the legacy `pixels`/`colors` notifications. Task 10 cannot delete `app/state.js` until those dependencies have an explicit home.

The approved correction is:

- Store shared drawing settings (`primary`, `secondary`, `brushSize`) and a monotonic live-pixel revision in `EditorStore.workspace`. Mutations use store transactions so panels, canvases, and shell shortcuts remain reactive without recreating the generic legacy event bus.
- Make `float-session.js` the sole owner of the floating-selection value and expose narrow read/clear accessors to renderers, previews, autosave, and document lifecycle code.
- Replace legacy `emit('pixels')`/`on('pixels')` wiring with workspace pixel-revision transactions/subscriptions. Replace `colors` and `brushSize` notifications with selectors over the drawing-settings workspace fields.
- Treat the two stale `sprite-frame-commands` assertions and the remaining maps palette `activeSheet` import as completion fixes for the already-landed Task 1/6 work before starting Task 7.

Tasks 7-10 retain their original behavior and verification goals; this amendment supplies the missing state ownership needed for their zero-import and final-deletion gates.

## Global Constraints

- No user-facing behavior change, with one explicit exception: the `markDirty()` bug fix (edits that mutate project data without going through the command stack currently fail to mark the project dirty — see parent spec's "Current-state findings"). Every `markDirty()` call site converts to `getEditorHost().projects.markDirty()`.
- `terrain-preset-art.js:56`'s direct command-stack push stays a raw `{do,undo}` push (not a full Command Handler) — only its target changes from `state.commands` to `getEditorHost().history`. Converting it to a registered Command Handler is explicitly out of scope (tracked by its own design doc).
- Selection side effects (`selectedNodeId`, `host.selections.set(...)`) for the new layer-tree/palette Command Handlers live in the **calling code** (`layers-panel.js`/`color-panel.js`), not inside the command's `do()`/`undo()` — this matches the existing, already-shipped `maps.addLayer`/`maps.deleteLayer` pattern in `layers-panel.js`'s maps branch (lines 137-138, 205-206 in the pre-migration file), and relies on `renderList()`'s existing dangling-selection fallback (`if (selectedNodeId && !findNode(...)) selectedNodeId = currentLayerId();`) to gracefully recover after undo/redo. This is a deliberate, small harmonization, not an oversight — call it out in each task's self-review.
- Full suite (`npm test`) stays green after every task.
- `tests/architecture.test.mjs`'s existing rules apply throughout: domain modules (none touched by this plan) can't import host/app/platform/ui/components/features/modes; `js/modes/**/presentation/**` files must dispatch commands by id only (never import `application/commands/` or `core/commands.js` directly); only `terrain-preset-art.js` may import `core/commands.js` from outside `application/`/`presentation/` under `js/modes/**`; modes never import sibling modes.
- No drag-simulation in Playwright verification (established policy) — the drag-and-drop layer reorder path (Task 3) gets hand-verification only.

---

## Task 1: Foundation — HistoryService owns its CommandStack, host-driven state helpers, mountStorePanel

**Files:**
- Modify: `js/host/history-service.js`
- Modify: `js/bootstrap.js`
- Create: `js/host/document-helpers.js`
- Create: `tests/document-helpers.test.mjs`
- Create: `js/platform/browser/autotest.js`
- Modify: `js/components/panel-mount.js`
- Create: `tests/panel-mount.test.mjs` (new coverage for `mountStorePanel`; `mountReactivePanel` currently has none — leave it alone)

**Interfaces:**
- Produces: `js/host/document-helpers.js` exports `activeSheet()`, `activeMap()`, `activeLayer()`, `currentContextLayers()`, `activeLayerScope()` — all host-driven, zero legacy fallback, for every later task to import instead of `app/state.js`'s versions.
- Produces: `js/platform/browser/autotest.js` exports `AUTOTEST` (boolean) and `confirmOrAuto(msg)` — verbatim relocation, zero logic change.
- Produces: `js/components/panel-mount.js` exports `mountStorePanel(store, selectors, render, { onDispose })` — same shape/contract as the existing `mountReactivePanel(on, events, render, { onDispose })`, but keyed on `EditorStore` selectors instead of legacy event names.
- Consumes: `EditorStore.subscribe(selector, listener, opts)` (`js/host/editor-store.js:78`, returns a dispose function), `getEditorHost()` (`js/host/runtime.js`).

- [x] **Step 1: `HistoryService` constructs its own `CommandStack`; `bootstrap.js` stops injecting the legacy one**

Read `js/host/history-service.js` first — its constructor is currently `constructor({ stack = new CommandStack(), store = null } = {})`. Change the signature to drop the `stack` option entirely: `constructor({ store = null } = {})`, with `this.#stack = new CommandStack();` hardcoded. This is safe now (and was not safe before Task 1) because after this task, nothing outside `HistoryService` pushes onto a `CommandStack` directly anymore except the two remaining tracked exceptions (`drawing-engine.js`/`terrain-preset-art.js` after Tasks 5/8 convert them to `getEditorHost().history.execute(command)`, which goes through `HistoryService`'s own stack correctly).

In `js/bootstrap.js`, remove the `historyStack: legacyState.commands` option and the `import { state as legacyState } from './app/state.js';` line — `new EditorHost({ preferences: ..., platform: ... })` no longer needs it.

- [x] **Step 2: Run the full suite to confirm nothing yet depends on the old injection**

Run: `npm test`
Expected: failures in every test that still calls `state.commands.push(...)` directly and expects it to affect the host (there will be several — this is expected until Tasks 2-5, 8 land; do not try to fix them in this task). Confirm specifically that `tests/historyservice.test.mjs` and `tests/host.test.mjs` still pass (they construct `HistoryService`/`EditorHost` directly, not through `state.commands`).

- [x] **Step 3: Create `js/host/document-helpers.js`**

Read `js/app/state.js` in full first (lines 58-93 define `activeSheet`/`activeMap`/`activeLayer`/`currentContextLayers`/`activeLayerScope` today) and `js/features/project/document-controller.js:95-114` (the established host-native pattern for resolving `session.activeDocument` into a real sheet/map object: `editorHost.projects.project?.sheets.find(s => s.id === activeDoc.id)` — NOT `host.documents.resolve()`, which only re-validates the `{kind,id}` reference, not the object). Write:

```js
// js/host/document-helpers.js
import { getEditorHost } from './runtime.js';
import { findLayer, layerAnimationContext, flattenLayers, sheetLayers, contextLayers as modelContextLayers } from '../core/model.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function activeSheet() {
  const host = getEditorHost();
  const doc = host?.store.getState().session.activeDocument;
  if (!doc || (doc.kind !== 'sprite-sheet' && doc.kind !== 'tile-sheet')) return null;
  return host.projects.project?.sheets.find(s => s.id === doc.id) ?? null;
}

export function activeMap() {
  const host = getEditorHost();
  const doc = host?.store.getState().session.activeDocument;
  if (!doc || doc.kind !== 'map') return null;
  return host.projects.project?.maps?.find(m => m.id === doc.id) ?? null;
}

export function activeLayer() {
  const sheet = activeSheet();
  if (!sheet) return null;
  const layerId = getEditorHost().selections.get(sheetDocument(sheet))?.layerId ?? null;
  return findLayer(sheet.layerTree, layerId);
}

export function currentContextLayers() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
  return modelContextLayers(sheet, animationId);
}

export function activeLayerScope() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const ctx = layerAnimationContext(sheet, activeLayer());
  return ctx ? flattenLayers(ctx.group) : sheetLayers(sheet);
}
```

This drops the legacy fallback branches entirely (no `host ? ... : state.activeLayerId` — every caller of these functions runs after a host exists, same as today's already-host-primary `activeLayer()`/`currentContextLayers()`).

- [x] **Step 4: Write `tests/document-helpers.test.mjs`**

Follow `tests/editorstore.test.mjs`'s style (construct a real `EditorStore`/`EditorHost`, no mocking framework). At minimum:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';
import { activeSheet, activeMap, activeLayer } from '../js/host/document-helpers.js';

test('activeSheet/activeMap/activeLayer resolve from the host store, not a stale reference', () => {
  const host = new EditorHost({});
  setEditorHost(host);
  assert.equal(activeSheet(), null);
  assert.equal(activeMap(), null);
  assert.equal(activeLayer(), null);
});
```

Read `tests/host.test.mjs` for how it constructs a project/registers a mode/activates a document, and extend the test above to cover the populated case (a sheet with layers, resolved via `host.documents.setActive(...)` then `activeSheet()` returns the matching object; `activeLayer()` returns the correct layer after `host.selections.set(...)`). Match that file's exact setup helpers rather than reinventing project/mode fixtures.

- [x] **Step 5: Relocate `AUTOTEST`/`confirmOrAuto` to `js/platform/browser/autotest.js`**

Verbatim move from `js/app/state.js:6-9`:

```js
// js/platform/browser/autotest.js
// Test mode (?autotest): automated browser sessions suppress modal dialogs
// (beforeunload guard, autosave-restore prompt, confirm() gates auto-accept).
export const AUTOTEST = typeof location !== 'undefined' ? new URLSearchParams(location.search).has('autotest') : false;
export const confirmOrAuto = (msg) => AUTOTEST || (typeof confirm !== 'undefined' ? confirm(msg) : false);
```

No test needed beyond what already exercises `?autotest` behavior end-to-end (memory: `?autotest` already relied on throughout the test suite/manual verification).

- [x] **Step 6: Add `mountStorePanel` to `js/components/panel-mount.js`**

Read the existing `mountReactivePanel` in that file first (already present, do not remove it — `js/components/tool-palette.js` and others may still use the legacy `on`-based version until their own task lands). Append:

```js
// Store-backed sibling of mountReactivePanel above: same debounced-render +
// subscribe/dispose contract, keyed on EditorStore selectors instead of
// legacy event names. `selectors` entries are either a selector function
// (wired straight to the debounced render) or a `[selector, handler]` pair,
// matching mountReactivePanel's `[event, handler]` shape.
export function mountStorePanel(store, selectors, render, { onDispose } = {}) {
  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }
  const subscriptions = selectors.map(spec => {
    const [selector, handler] = Array.isArray(spec) ? spec : [spec, null];
    return store.subscribe(selector, handler ? () => { handler(); scheduleRender(); } : scheduleRender);
  });
  render();
  return {
    scheduleRender,
    dispose() { onDispose?.(); subscriptions.forEach(dispose => dispose()); },
  };
}
```

- [x] **Step 7: Write `tests/panel-mount.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { mountStorePanel } from '../js/components/panel-mount.js';

test('mountStorePanel renders once immediately and again per selector change, debounced', async () => {
  const store = new EditorStore();
  let renders = 0;
  const panel = mountStorePanel(store, [state => state.session.activeModeId], () => { renders++; });
  assert.equal(renders, 1);
  store.transaction('mode', state => { state.session.activeModeId = 'sprites'; });
  await Promise.resolve();
  assert.equal(renders, 2);
  panel.dispose();
  store.transaction('mode', state => { state.session.activeModeId = 'tiles'; });
  await Promise.resolve();
  assert.equal(renders, 2);
});

test('mountStorePanel runs a paired handler synchronously before the debounced render', async () => {
  const store = new EditorStore();
  const seen = [];
  mountStorePanel(store, [[state => state.session.activeToolId, () => seen.push('handler')]], () => seen.push('render'));
  store.transaction('tool', state => { state.session.activeToolId = 'pencil'; });
  await Promise.resolve();
  assert.deepEqual(seen, ['render', 'handler', 'render']);
});
```

(The second assertion's exact ordering — `render()` fires once synchronously at mount before any transaction — mirrors `mountReactivePanel`'s own documented behavior; verify against the actual behavior when you run this and adjust the expected array if the synchronous initial `render()` call changes the count, but do not change `mountStorePanel`'s logic to match a wrong expectation — the implementation in Step 6 is correct, fix the test's expected array if needed.)

- [x] **Step 8: Run the full suite**

Run: `npm test`
Expected: `tests/document-helpers.test.mjs` and `tests/panel-mount.test.mjs` pass. The same pre-existing failures from Step 2 remain (still expected — later tasks fix them). No NEW failures beyond Step 2's baseline.

- [x] **Step 9: Commit**

```bash
git add js/host/history-service.js js/bootstrap.js js/host/document-helpers.js tests/document-helpers.test.mjs js/platform/browser/autotest.js js/components/panel-mount.js tests/panel-mount.test.mjs
git commit -m "feat: HistoryService owns its CommandStack; add host-driven document helpers, autotest module, mountStorePanel"
```

---

## Task 2: New Command Handlers — sprite/tile layer-tree ops, map layer opacity, palette ops

**Files:**
- Create: `js/modes/sprites/application/commands/layer-commands.js`
- Create: `tests/sprites-layer-commands.test.mjs`
- Create: `js/modes/tiles/application/commands/layer-commands.js`
- Create: `tests/tiles-layer-commands.test.mjs`
- Create: `js/modes/sprites/application/commands/palette-commands.js`
- Create: `tests/sprites-palette-commands.test.mjs`
- Create: `js/modes/tiles/application/commands/palette-commands.js`
- Create: `tests/tiles-palette-commands.test.mjs`
- Modify: `js/modes/maps/application/commands/map-layer-commands.js` (add `setMapLayerOpacity`)
- Modify: `js/modes/sprites/contributions.js`, `js/modes/tiles/contributions.js`, `js/modes/maps/contributions.js` (register the new handlers)

**Interfaces:**
- Consumes: `runEntityCommand(services, label, resolve, apply, revert, { after })` (`js/host/command-helpers.js:11`); `js/modes/tiles/application/commands/tile-sheet-commands.js`'s existing `runCommand(services, sheetId, label, apply, revert)` helper (reuse it directly for tiles rather than redefining — read that file first to confirm its exact current signature before importing it).
- Produces (registered command ids, all take `(context, args)`): `sprites.addLayer({sheetId, targetGroupId})`, `sprites.addGroup({sheetId, targetGroupId})`, `sprites.deleteNode({sheetId, nodeId})`, `sprites.mergeDown({sheetId, layerId})`, `sprites.moveNode({sheetId, nodeId, delta})`, `sprites.dragMoveNode({sheetId, nodeId, destParentId, destIndex})`, `sprites.toggleLayerVisible({sheetId, layerId})`, `sprites.renameNode({sheetId, nodeId, name})`, `sprites.setLayerOpacity({sheetId, layerId, opacity})` — and the identical set under `tiles.*` — plus `maps.setLayerOpacity({mapId, layerId, opacity})`, `sprites.editPaletteColor({index, color})`, `sprites.remapPaletteColor({index, color})`, `tiles.editPaletteColor({index, color})`, `tiles.remapPaletteColor({index, color})`. Task 3/4 consume all of these by id via `getEditorHost().registries.commands.execute(id, {modeId}, args)`.

This task does NOT touch `layers-panel.js`/`color-panel.js` — it only adds and unit-tests the handlers. Task 3/4 wire the panels to them.

- [x] **Step 1: Read the exact current undo semantics you're porting**

Read `js/components/panels/layers-panel.js` in full (834 lines) — every command this task creates must reproduce the exact `do()`/`undo()` data mutation of one of these existing closures verbatim, minus the `selectedNodeId`/`setSheetSelection` calls (per Global Constraints, those move to Task 3's caller code):

- `doAddLayer` (non-maps branch, lines 141-163): creates one `createLayerNode(...)`, pushes into `targetGroupForInsert()`'s children array.
- `doAddGroup` (non-maps branch, lines 173-195): creates one `createGroupNode(...)`, same insertion.
- `doDelete`, layer branch (lines 209-244): removes the active layer from its parent's `children` (filtered by id).
- `doDelete`, group branch (lines 246-284, the non-animation-owned path only — `commitDeleteAnimation` at line 252 is a separate, already-migrated command from `js/features/animations/commands.js`, out of scope here): removes the group from its parent's `children`.
- `doMergeDown` (lines 287-321): calls existing `mergeDown(sheet, layer.id)` from `js/core/model.js`, then blits the destination layer's before/after bitmap and swaps `parent.children` between the pre/post arrays it already computed.
- `doMove` (lines 323-340, arrow-key reorder): calls existing `moveNode(sheet, node.id, parent.id, newIndex)` from `js/core/model.js`, swaps `parent.children` before/after.
- `doToggleVisible` (lines 342-351): flips `layer.visible`.
- `startRename`'s `commit()` (lines 368-406): sets `node.name` (and, if the node is an animation-owned group, the matching `sheet.animations` entry's `.name` too).
- `performMove` (lines 451-483, drag-and-drop reorder): calls existing `moveNode(sheet, nodeId, destParentId, destIndex)`, swaps BOTH the source and destination parents' `children` arrays before/after (two-location diff, not one).
- `renderLayer`'s opacity `change` handler (lines 698-716): sets `layer.opacity`.
- `renderMapLayer`'s opacity `change` handler (line 746): sets `layer.opacity` on a **map** layer — this is the one that becomes `maps.setLayerOpacity`, not a sprites/tiles handler.

Read `js/components/panels/color-panel.js` around lines 155 and 175 (`editIndexedEntry`) for the two palette operations: `edit palette color` (single `setEntry(pal, index, to/old)` call, no bitmap remap) and `remap palette color` (same palette-entry mutation, plus `blitRegion` over every sheet layer's bitmap using a pre-collected `layerPatches` array — read the surrounding ~40 lines of `editIndexedEntry` to get the exact patch-collection logic before porting it).

- [x] **Step 2: `js/modes/tiles/application/commands/layer-commands.js` — worked example (`toggleLayerVisible`) plus the rest of the same file**

Read `js/modes/tiles/application/commands/tile-sheet-commands.js:1-22` first (its `findSheet`/`runCommand` helpers) — import and reuse `runCommand` from there rather than redefining sheet-resolution:

```js
// js/modes/tiles/application/commands/layer-commands.js
import { createLayerNode, createGroupNode, findNode, findParent, findGroup, sheetLayers, flattenLayers, mergeDown as mergeLayerDown, moveNode as moveTreeNode, animationGroup } from '../../../../core/model.js';
import { cloneBitmap, blitRegion } from '../../../../core/pixels.js';
import { runCommand } from './tile-sheet-commands.js';

function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }

function countNodes(sheet, type) {
  let n = 0;
  (function walk(node) { if (node.type === type) n++; if (node.children) for (const c of node.children) walk(c); })(sheet.layerTree);
  return n;
}

function resolveGroup(sheet, groupId) {
  if (!groupId) return sheet.layerTree;
  return findGroup(sheet.layerTree, groupId) ?? sheet.layerTree;
}

export function toggleLayerVisible(services, sheetId, layerId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const layer = findNode(sheet.layerTree, layerId);
  const before = layer.visible;
  const after = !before;
  runCommand(services, sheetId, 'toggle layer visibility',
    sheet => { findNode(sheet.layerTree, layerId).visible = after; },
    sheet => { findNode(sheet.layerTree, layerId).visible = before; });
}

export function addLayer(services, sheetId, targetGroupId) {
  let newLayerId = null;
  let newLayerSnapshot = null;
  runCommand(services, sheetId, 'add layer',
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      if (!newLayerId) {
        const layer = createLayerNode(`Layer ${countNodes(sheet, 'layer') + 1}`, sheet.width, sheet.height);
        newLayerId = layer.id;
        newLayerSnapshot = layer;
        group.children.push(layer);
      } else if (!findNode(sheet.layerTree, newLayerId)) {
        group.children.push(newLayerSnapshot);
      }
    },
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      group.children = group.children.filter(c => c.id !== newLayerId);
    });
  return newLayerId;
}

export function addGroup(services, sheetId, targetGroupId) {
  let newGroupId = null;
  let newGroupSnapshot = null;
  runCommand(services, sheetId, 'add group',
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      if (!newGroupId) {
        const created = createGroupNode(`Group ${countNodes(sheet, 'group') + 1}`);
        newGroupId = created.id;
        newGroupSnapshot = created;
        group.children.push(created);
      } else if (!findNode(sheet.layerTree, newGroupId)) {
        group.children.push(newGroupSnapshot);
      }
    },
    sheet => {
      const group = resolveGroup(sheet, targetGroupId);
      group.children = group.children.filter(c => c.id !== newGroupId);
    });
  return newGroupId;
}

export function deleteNode(services, sheetId, nodeId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const loc = findParent(sheet.layerTree, nodeId);
  if (!loc) return;
  const parentId = loc.parent.id ?? null; // root layerTree has no id; handle below
  const isRoot = loc.parent === sheet.layerTree;
  runCommand(services, sheetId, 'delete layer',
    sheet => {
      const parent = isRoot ? sheet.layerTree : findGroup(sheet.layerTree, parentId);
      parent.children = parent.children.filter(c => c.id !== nodeId);
    },
    sheet => {
      const parent = isRoot ? sheet.layerTree : findGroup(sheet.layerTree, parentId);
      const idx = Math.min(loc.index, parent.children.length);
      if (!parent.children.some(c => c.id === nodeId)) parent.children.splice(idx, 0, loc.node);
    });
}

export function mergeLayerDownCmd(services, sheetId, layerId) {
  const sheet = findSheet(services.projects.project, sheetId);
  const loc = findParent(sheet.layerTree, layerId);
  if (!loc || loc.index <= 0) return null;
  const dest = loc.parent.children[loc.index - 1];
  if (dest.type !== 'layer') return null;
  const parent = loc.parent;
  const beforeChildren = parent.children.slice();
  const destBefore = cloneBitmap(dest.bitmap);
  mergeLayerDown(sheet, layerId);
  const destAfter = cloneBitmap(dest.bitmap);
  const afterChildren = parent.children.slice();
  runCommand(services, sheetId, 'merge down',
    sheet => {
      const p = findParent(sheet.layerTree, dest.id)?.parent ?? sheet.layerTree;
      blitRegion(dest.bitmap, destAfter, 0, 0);
      p.children = afterChildren.slice();
    },
    sheet => {
      const p = findParent(sheet.layerTree, dest.id)?.parent ?? sheet.layerTree;
      p.children = beforeChildren.slice();
      blitRegion(dest.bitmap, destBefore, 0, 0);
    });
  return dest.id;
}

export function moveNode(services, sheetId, nodeId, delta) {
  const sheet = findSheet(services.projects.project, sheetId);
  const loc = findParent(sheet.layerTree, nodeId);
  if (!loc) return;
  const parent = loc.parent;
  const parentId = parent === sheet.layerTree ? null : parent.id;
  const beforeChildren = parent.children.slice();
  const newIndex = Math.max(0, Math.min(parent.children.length - 1, loc.index + delta));
  moveTreeNode(sheet, nodeId, parent.id ?? sheet.layerTree.id, newIndex);
  const afterChildren = parent.children.slice();
  runCommand(services, sheetId, 'reorder layers',
    sheet => { const p = parentId ? findGroup(sheet.layerTree, parentId) : sheet.layerTree; p.children = afterChildren.slice(); },
    sheet => { const p = parentId ? findGroup(sheet.layerTree, parentId) : sheet.layerTree; p.children = beforeChildren.slice(); });
}

export function dragMoveNode(services, sheetId, nodeId, destParentId, destIndex) {
  const sheet = findSheet(services.projects.project, sheetId);
  const srcLoc = findParent(sheet.layerTree, nodeId);
  const destParent = destParentId ? (findGroup(sheet.layerTree, destParentId) ?? sheet.layerTree) : sheet.layerTree;
  if (!srcLoc) return;
  const srcParent = srcLoc.parent;
  const srcParentId = srcParent === sheet.layerTree ? null : srcParent.id;
  const beforeSrc = srcParent.children.slice();
  const beforeDest = destParent.children.slice();
  moveTreeNode(sheet, nodeId, destParentId ?? sheet.layerTree.id, destIndex);
  const afterSrc = srcParent.children.slice();
  const afterDest = destParent.children.slice();
  if (beforeSrc.length === afterSrc.length && beforeDest.length === afterDest.length &&
      beforeSrc.every((c, i) => c === afterSrc[i]) && beforeDest.every((c, i) => c === afterDest[i])) return;
  runCommand(services, sheetId, 'move layer',
    sheet => {
      const sp = srcParentId ? findGroup(sheet.layerTree, srcParentId) : sheet.layerTree;
      const dp = destParentId ? findGroup(sheet.layerTree, destParentId) : sheet.layerTree;
      sp.children = afterSrc.slice(); dp.children = afterDest.slice();
    },
    sheet => {
      const sp = srcParentId ? findGroup(sheet.layerTree, srcParentId) : sheet.layerTree;
      const dp = destParentId ? findGroup(sheet.layerTree, destParentId) : sheet.layerTree;
      sp.children = beforeSrc.slice(); dp.children = beforeDest.slice();
    });
}

export function renameNode(services, sheetId, nodeId, name) {
  const sheet = findSheet(services.projects.project, sheetId);
  const node = findNode(sheet.layerTree, nodeId);
  if (!node || node.name === name) return;
  const before = node.name;
  const anim = node.type === 'group' && node.animationId ? sheet.animations.find(a => a.id === node.animationId) : null;
  const oldAnimName = anim?.name;
  runCommand(services, sheetId, node.type === 'group' ? 'rename group' : 'rename layer',
    sheet => { const n = findNode(sheet.layerTree, nodeId); n.name = name; const a = anim ? sheet.animations.find(x => x.id === anim.id) : null; if (a) a.name = name; },
    sheet => { const n = findNode(sheet.layerTree, nodeId); n.name = before; const a = anim ? sheet.animations.find(x => x.id === anim.id) : null; if (a) a.name = oldAnimName; });
}

export function setLayerOpacity(services, sheetId, layerId, opacity) {
  const sheet = findSheet(services.projects.project, sheetId);
  const layer = findNode(sheet.layerTree, layerId);
  const before = layer.opacity;
  if (before === opacity) return;
  runCommand(services, sheetId, 'layer opacity',
    sheet => { findNode(sheet.layerTree, layerId).opacity = opacity; },
    sheet => { findNode(sheet.layerTree, layerId).opacity = before; });
}
```

Note: `findParent`/`findGroup`/`findNode` signatures — confirm their exact return shapes against `js/core/model.js` before finalizing (the sketch above assumes `findParent(tree, id)` returns `{parent, index, node}` and `findGroup(tree, groupId)` returns the group node or `null`, matching how `layers-panel.js` already calls them — verify against the actual `js/core/model.js` source, which this task's implementer has full read access to, and adjust the property names above if they differ).

- [x] **Step 3: Write `tests/tiles-layer-commands.test.mjs`**

Follow the style of an existing per-command test file for tiles (check `tests/` for one covering `tile-sheet-commands.js`'s existing exports, or `map-paint-commands.test.mjs` for the general shape: construct a real project via existing test fixtures, call the command function, assert the mutation, call `services.history.undo()`, assert it reverted). At minimum, cover: `addLayer` (do + undo removes it), `deleteNode` (do + undo restores at the same index), `toggleLayerVisible` (do + undo), `setLayerOpacity` (do + undo, and a no-op when `opacity` is unchanged), `renameNode` (including the animation-name-sync case), `mergeLayerDownCmd` (bitmap content correctly restored on undo), `moveNode` and `dragMoveNode` (children array order correct after do, restored after undo; `dragMoveNode` specifically covering the cross-parent case where `destParentId !== srcParentId`).

- [x] **Step 4: `js/modes/sprites/application/commands/layer-commands.js`**

Same operations, same logic (sprite sheets use the identical `sheet.layerTree` shape — per the existing repo-wide comment in `layers-panel.js:810-817`: "sheet.layerTree ... is shared by sprite and tile sheets alike"). Check whether `js/modes/sprites/application/commands/*.js` already defines a `runCommand(services, sheetId, label, apply, revert)`-shaped helper (grep for `runEntityCommand` under `js/modes/sprites/application/commands/`); if one exists, import and reuse it. If not, define a local one matching `tile-sheet-commands.js:19-22`'s exact pattern:

```js
function findSheet(project, sheetId) { return project.sheets.find(s => s.id === sheetId) ?? null; }
export function runCommand(services, sheetId, label, apply, revert) {
  runEntityCommand(services, label, project => findSheet(project, sheetId), apply, revert);
}
```

(Note: do NOT port the legacy `markDirty()` call that `tile-sheet-commands.js`'s own `runCommand` currently makes — that call is the redundant legacy shadow this whole plan is retiring; Task 8 removes it from `tile-sheet-commands.js` too. New code should never call the legacy `markDirty()` at all — `runEntityCommand`'s `services.projects.mutate()` already marks the host dirty.)

- [x] **Step 5: Write `tests/sprites-layer-commands.test.mjs`**

Same coverage as Step 3, adapted for a sprite sheet fixture.

- [x] **Step 6: `js/modes/maps/application/commands/map-layer-commands.js` — add `setMapLayerOpacity`**

Read the file (already shown above in the design investigation) and add, matching `deleteMapLayer`'s exact style:

```js
export function setMapLayerOpacity(services, mapId, layerId, opacity) {
  const map = findMap(services.projects.project, mapId);
  const layer = map?.layers.find(l => l.id === layerId);
  if (!layer || layer.opacity === opacity) return;
  const before = layer.opacity;
  runCommand(services, mapId, 'map layer opacity',
    map => { map.layers.find(l => l.id === layerId).opacity = opacity; },
    map => { map.layers.find(l => l.id === layerId).opacity = before; });
}
```

- [x] **Step 7: `js/modes/sprites/application/commands/palette-commands.js` and the `tiles/` equivalent**

Read `js/components/panels/color-panel.js`'s `editIndexedEntry` (around lines 140-190) in full before writing this — the exact `layerPatches` collection logic for the remap case must be ported faithfully, not approximated. Both files are structurally identical (palettes are project-level, not sheet-scoped, so `resolve = project => project`):

```js
// js/modes/sprites/application/commands/palette-commands.js
import { runEntityCommand } from '../../../../host/command-helpers.js';
import { blitRegion } from '../../../../core/pixels.js';
// import setEntry / currentPalette from wherever color-panel.js currently imports them from js/core/*.

export function editPaletteColor(services, index, color) {
  const project = services.projects.project;
  const pal = currentPalette(project); // match color-panel.js's existing palette lookup
  const before = pal.entries[index];
  runEntityCommand(services, 'edit palette color', p => p,
    p => { setEntry(currentPalette(p), index, color); },
    p => { setEntry(currentPalette(p), index, before); });
}

export function remapPaletteColor(services, index, color) {
  // Port editIndexedEntry's exact layerPatches collection (every sheet layer's
  // before/after bitmap region where the old color appears) verbatim from
  // color-panel.js, then apply/revert both the palette entry AND every
  // collected bitmap patch inside this command's do()/undo().
}
```

The `editPaletteColor`/`remapPaletteColor` sketch above is intentionally incomplete for the remap case — port `editIndexedEntry`'s exact current logic (read it first, per this step's instruction) rather than guessing at `setEntry`'s import path or the patch shape.

- [x] **Step 8: Write `tests/sprites-palette-commands.test.mjs` and `tests/tiles-palette-commands.test.mjs`**

Cover: `editPaletteColor` do/undo restores the exact prior palette entry; `remapPaletteColor` do/undo restores both the palette entry and every affected layer's bitmap region byte-for-byte.

- [x] **Step 9: Register every new handler**

In each mode's `contributions.js`, follow the exact existing registration style (`api.commands.register({ id, when, execute })`, matching `js/modes/maps/contributions.js`'s `maps.addLayer`/`maps.deleteLayer` lines shown above). Register `sprites.addLayer`, `sprites.addGroup`, `sprites.deleteNode`, `sprites.mergeDown`, `sprites.moveNode`, `sprites.dragMoveNode`, `sprites.toggleLayerVisible`, `sprites.renameNode`, `sprites.setLayerOpacity`, `sprites.editPaletteColor`, `sprites.remapPaletteColor` in `sprites/contributions.js`; the identical set (minus `mergeDown`, which is sprite/tile-specific per Step 2 — keep it in both since both modes have `layerTree`) under `tiles.*` in `tiles/contributions.js`; `maps.setLayerOpacity` in `maps/contributions.js`.

- [x] **Step 10: Run the full suite**

Run: `npm test`
Expected: all new test files pass; the pre-existing Task-1-introduced failures (still-unconverted `state.commands.push` sites) remain unchanged — this task adds handlers but doesn't wire consumers yet.

- [x] **Step 11: Commit**

```bash
git add js/modes/sprites/application/commands/layer-commands.js tests/sprites-layer-commands.test.mjs js/modes/tiles/application/commands/layer-commands.js tests/tiles-layer-commands.test.mjs js/modes/sprites/application/commands/palette-commands.js tests/sprites-palette-commands.test.mjs js/modes/tiles/application/commands/palette-commands.js tests/tiles-palette-commands.test.mjs js/modes/maps/application/commands/map-layer-commands.js js/modes/sprites/contributions.js js/modes/tiles/contributions.js js/modes/maps/contributions.js
git commit -m "feat: add layer-tree, map-opacity, and palette Command Handlers for the CommandStack encapsulation"
```

---

## Task 3: `layers-panel.js` — consume the new Command Handlers, drop all `state.js` imports

**Files:**
- Modify: `js/components/panels/layers-panel.js`

**Interfaces:**
- Consumes: Task 2's registered command ids; `js/host/document-helpers.js`'s `activeSheet`/`activeMap`/`activeLayer` (Task 1); `js/platform/browser/autotest.js`'s `confirmOrAuto` (Task 1); `js/components/panel-mount.js`'s `mountStorePanel` (Task 1).

- [x] **Step 1: Replace the import line and every direct-mutation function**

Replace line 3's `import { state, on, emit, activeSheet, activeLayer, activeMap, markDirty, confirmOrAuto } from '../../app/state.js';` with:

```js
import { getEditorHost } from '../../host/runtime.js';
import { activeSheet, activeLayer, activeMap } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { mountStorePanel } from '../panel-mount.js';
```

(`getEditorHost` is already imported at line 9 — keep only one import.)

Add a `dispatch` helper matching the established pattern used elsewhere in this file already for the maps branch and in every already-migrated panel (`frames-panel.js`, `tile-layers-panel.js`):

```js
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: getEditorHost().store.getState().session.activeModeId }, args);
}
```

Rewrite each function per this table (mode-branch dispatch: `dispatch(mode === 'maps' ? 'maps.X' : `${mode}.X`, args)` — compute `mode` once via `getEditorHost().store.getState().session.activeModeId` at the top of each function, replacing every `state.mode` read):

| Current function (lines) | Replacement |
|---|---|
| `doAddLayer` (133-163) | maps branch: `dispatch('maps.addLayer', {mapId, type:'tile'})`, then `host.selections.set(...)` exactly as today (lines 138-139), then `getEditorHost().store... ` no `emit('view')` call needed — Task 9 will confirm map-panel repaint wiring separately, leave the `emit('view')` call in for now since `document-controller.js`'s legacy mirror still re-emits it (do not remove `emit` calls that target the mirror's re-emitted events until Task 10 deletes the mirror). Non-maps branch: `const newLayerId = dispatch(`${mode}.addLayer`, {sheetId: sheet.id, targetGroupId: group === sheet.layerTree ? null : group.id}); getEditorHost().selections.set({...getEditorHost().selections.get(sheetDocument(sheet)), layerId: newLayerId}, sheetDocument(sheet)); selectedNodeId = newLayerId;` |
| `doAddGroup` (165-195) | Same shape as `doAddLayer`, using `addGroup`/`sprites.addGroup`/`tiles.addGroup`, and for the non-maps branch set `selectedNodeId` to the returned id with `layerId: null` in the selection patch (matching current lines 184-185). |
| `doDelete` (197-285) | Keep every `confirmOrAuto(...)` gate and the maps branch exactly as-is except swapping the import source. Non-maps layer branch: replace the `state.commands.push(cmd); markDirty();` at line 242-243 with `dispatch(`${mode}.deleteNode`, {sheetId: sheet.id, nodeId: layer.id}); selectedNodeId = <the same fallback id logic the old cmd.do() computed synchronously, since it's no longer inside the command> — compute it BEFORE calling dispatch, from the current tree state (mirrors lines 230-232's `all`/`fallback` logic).` Non-maps group branch: same treatment for lines 269-282, `dispatch(`${mode}.deleteNode`, {sheetId: sheet.id, nodeId: g.id})`. |
| `doMergeDown` (287-321) | Replace the manual `mergeDown(sheet, layer.id)` + `state.commands.push` + `markDirty()` with a single `const destId = dispatch(`${mode}.mergeDown`, {sheetId: sheet.id, layerId: layer.id}); if (destId) { setSheetSelection(sheet, { layerId: destId }); selectedNodeId = destId; }` — Task 2's `mergeLayerDownCmd` already performs the merge and returns the destination id, so this function no longer computes `destBefore`/`destAfter` itself. |
| `doMove` (323-340) | `dispatch(`${mode}.moveNode`, {sheetId: sheet.id, nodeId: node.id, delta})` |
| `doToggleVisible` (342-351) | `dispatch(`${mode}.toggleLayerVisible`, {sheetId: activeSheet().id, layerId: layer.id})` |
| `startRename`'s `commit()` (368-406) | `dispatch(`${mode}.renameNode`, {sheetId: activeSheet().id, nodeId: node.id, name: v})` |
| `performMove` (451-483) | `dispatch(`${mode}.dragMoveNode`, {sheetId: sheet.id, nodeId, destParentId: destParent === sheet.layerTree ? null : destParent.id, destIndex})` |
| `renderLayer`'s opacity `change` handler (698-716) | `dispatch(`${mode}.setLayerOpacity`, {sheetId: activeSheet().id, layerId: layer.id, opacity: after})` |
| `renderMapLayer`'s opacity `change` handler (line 746) | `dispatch('maps.setLayerOpacity', {mapId: activeMap().id, layerId: layer.id, opacity: Number(opacityInput.value)/100})` |

- [x] **Step 2: Replace the `on`/`emit`-based reactivity with `mountStorePanel`**

Replace the closing lines (827-832: `on('project', renderList); on('history', renderList); on('view', renderList); on('selection', renderList); on('pixels', scheduleThumbRedraw); renderList();`) with:

```js
const store = getEditorHost().store;
mountStorePanel(store, [
  s => s.project.model,
  s => s.session.activeModeId,
  s => s.session.activeDocument,
  [s => s.session.selectionsByDocument, () => {}],
  [s => [], () => {}], // placeholder removed below -- see note
], renderList, {});
getEditorHost().history.subscribe(() => renderList());
```

That sketch has a real bug intentionally left in it as a worked check: `s => s.session.selectionsByDocument` is the exact in-place-mutation trap the Group 4 final review already found once (Minor 1 in that review, and the parent spec's own "Sharp edge" callout for `setSelection`) — `selectionsByDocument[key] = {...}` mutates a property of the SAME outer object, so `Object.is` on the outer object never re-fires. Do not use that selector as written. Instead, select the specific active document's selection entry, which IS replaced wholesale on every `setSelection`/`SelectionService.set()` call (confirmed in the parent spec's Foundation section): `s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; }` (match `documentKey()`'s exact format from `js/host/editor-store.js` rather than hand-building the string — import and use `documentKey` from there if it's exported, otherwise inline the identical format it produces). For `pixels`-driven thumbnail redraws (`scheduleThumbRedraw`, currently triggered by legacy `emit('pixels')`), this event has NO store equivalent yet (drawing engine emits it directly, mid-stroke, for live preview) — keep a legacy `on('pixels', scheduleThumbRedraw)` subscription alongside the `mountStorePanel`/`history.subscribe` wiring for this one signal only, disposing it together with the store subscriptions. Import `on` from `../../app/state.js'` ONLY for this one purpose, with a comment explaining why (matches the `architecture.test.mjs` shell-file precedent of deliberately NOT banning `on`/`emit` for pixel-level signals — see that test's own comment). Combine all disposal into one `dispose()` via `mountStorePanel`'s `onDispose` option, wrapping the extra `on('pixels', ...)` and `history.subscribe(...)` teardown.

- [x] **Step 3: Run the full test suite**

Run: `npm test`
Expected: `tests/panels.test.mjs` (existing coverage for this file, if it covers `layers-panel.js` specifically — check its contents first) passes. No regressions in `tests/sprites-layer-commands.test.mjs`/`tests/tiles-layer-commands.test.mjs` from Task 2.

- [x] **Step 4: Manual verification (Playwright, `?autotest`, no drag simulation)**

Load the app, exercise in sprites mode then tiles mode: add layer, add group, rename a layer, toggle visibility, change opacity, delete a layer, merge down, undo each one and confirm the exact prior state returns (bitmap content for merge-down, tree structure for add/delete). For drag-and-drop reorder specifically (`performMove`/`dragMoveNode`), this cannot be simulated — verify by hand in the same live browser session per established policy, confirming a drag-reorder followed by Ctrl+Z restores the original order.

- [x] **Step 5: Commit**

```bash
git add js/components/panels/layers-panel.js
git commit -m "refactor: layers-panel.js dispatches through Command Handlers, drops all state.js imports"
```

---

## Task 4: `color-panel.js` — consume the new palette Command Handlers, drop all `state.js` imports

**Files:**
- Modify: `js/components/panels/color-panel.js`

**Interfaces:**
- Consumes: Task 2's `sprites.editPaletteColor`/`sprites.remapPaletteColor`/`tiles.editPaletteColor`/`tiles.remapPaletteColor`; Task 1's `document-helpers.js`/`autotest.js`/`mountStorePanel`.

- [x] **Step 1: Read the current file in full**, then replace `import { state, on, emit, activeSheet, markDirty, confirmOrAuto } from '../../app/state.js';` with the same `getEditorHost`/`document-helpers`/`autotest`/`panel-mount` imports as Task 3, plus the same `dispatch(id, args)` helper.

- [x] **Step 2: Convert `editIndexedEntry`'s two `state.commands.push(...)` sites (lines ~155, ~175)**

Replace with `dispatch(`${mode}.editPaletteColor`, {index, color})` and `dispatch(`${mode}.remapPaletteColor`, {index, color})` respectively, removing the now-dead local `do()`/`undo()` closures and the trailing `markDirty()` calls (the Command Handler's `runEntityCommand` already marks the host dirty).

- [x] **Step 3: Replace `on`/`emit`-based reactivity with `mountStorePanel`**, following Task 3 Step 2's exact pattern (selectors for `project.model`/`activeModeId`/`activeDocument`; keep a legacy `on('pixels', ...)` subscription only if this file redraws swatches on live pixel changes — check the current file for a `pixels`-driven handler before assuming one exists).

- [x] **Step 4: Run the full suite**

Run: `npm test`
Expected: green, including `tests/sprites-palette-commands.test.mjs`/`tests/tiles-palette-commands.test.mjs`.

- [x] **Step 5: Manual verification (Playwright, `?autotest`)**

Edit a palette color, undo, confirm the swatch and every affected pixel on canvas revert. Trigger a remap (color used across multiple layers), undo, confirm every layer's bitmap reverted correctly, not just the palette entry.

- [x] **Step 6: Commit**

```bash
git add js/components/panels/color-panel.js
git commit -m "refactor: color-panel.js dispatches through Command Handlers, drops all state.js imports"
```

---

## Task 5: `drawing-engine.js` + `terrain-preset-art.js` — route direct pushes through `history.execute()`

**Files:**
- Modify: `js/components/canvas/drawing-engine.js`
- Modify: `js/modes/tiles/terrain-preset-art.js`

**Interfaces:**
- Consumes: `getEditorHost().history.execute(command)` (`js/host/history-service.js`, the thin validating pass-through to the now-self-owned `CommandStack` — confirmed in Task 1).

Per the CommandStack-encapsulation investigation: these two files' commands close over live `bitmap`/`layer` references built by `makePixelPatch` (`js/core/commands.js`), not entity ids — unlike Task 2/3/4's tree operations, there is no natural "re-resolve by id" Command Handler shape here (the drawing engine already knows exactly which live bitmap it just painted; re-deriving a `sheetId`/`layerId` lookup would only reintroduce a lookup that's already redundant at the moment `finalize()` runs). Route both directly through `services.history.execute(command)` (equivalently `getEditorHost().history.execute(command)`), bypassing the `registries.commands` id/context layer entirely — this is architecturally sound because `HistoryService.execute()` (`js/host/history-service.js`) is a thin validating pass-through to `CommandStack.push()`, the exact same mechanism `registries.commands.execute()` uses internally once a handler is found; no id/`when`/`isEnabled` gating is needed here since both call sites are already correctly mode/context-scoped by the caller.

- [x] **Step 1: `drawing-engine.js` — convert both `state.commands.push(...)` sites**

Read the file's current import line (`import { state, on, emit, activeSheet, activeLayer, markDirty } from '../../../app/state.js';`) and both push sites (line ~170 in `finalize()`, line ~687 in the delete-selection keydown handler). Replace each `state.commands.push(makePixelPatch(...))` with `getEditorHost().history.execute(makePixelPatch(...))`, and each accompanying legacy `markDirty()` call (if present at either site — check; `runEntityCommand`-equivalent dirty-marking doesn't apply here since this bypasses `services.projects.mutate()`, so confirm whether `HistoryService`'s `stack.onChange` wrapper — read `js/host/history-service.js` again, lines ~18-23 — already calls `store.markDirty(true)` on every push; if it does, as the investigation found, no explicit `markDirty()` call is needed at all here) with nothing (rely on `HistoryService`'s own `onChange` → `store.markDirty(true)` wiring, confirmed in Task 1's investigation).

Replace remaining `state.mode`/`state.tool`/`activeSheet`/`activeLayer` reads with `getEditorHost().store.getState().session.activeModeId`/`.activeToolId` and `js/host/document-helpers.js`'s `activeSheet`/`activeLayer`. For `on`/`emit` usage: read what events this file listens for (mode/tool changes to know when to (re)bind) and emits (`'pixels'` for live paint preview, already established as staying on the legacy bus per `architecture.test.mjs`'s own comment) — convert the LISTENING side to `getEditorHost().store.subscribe(...)`, keep the `emit('pixels')` calls as-is (still legitimate, per that test's explicit carve-out).

- [x] **Step 2: `terrain-preset-art.js` — minimal fix only, NOT a full Command Handler conversion**

Read the file (56 lines). Replace `state.commands.push(makePixelPatch(layer.bitmap, rect, before, after, 'import terrain layout art'))` at line 56 with `getEditorHost().history.execute(makePixelPatch(layer.bitmap, rect, before, after, 'import terrain layout art'))`. Keep the `import { makePixelPatch } from '.../core/commands.js'` import (Do NOT change or remove it — `tests/architecture.test.mjs`'s `'only the tracked terrain-preset-art.js exception imports core/commands.js from outside application/presentation'` test asserts this file is the ONLY one under `js/modes/**` outside `application/`/`presentation/` allowed to do so; removing this import would silently make that test vacuous rather than failing, so keep it and re-run that specific test explicitly in Step 4 to confirm it still exercises the exception). Replace the remaining `state`/`activeLayer`/`markDirty`/`confirmOrAuto` imports per the same pattern as Task 6-8's other files (see the substitution table there) — remove the redundant `markDirty()` call entirely (same reasoning as Step 1).

- [x] **Step 3: Run the full suite**

Run: `npm test`

- [x] **Step 4: Confirm the architecture-test exception still holds**

Run: `node --test tests/architecture.test.mjs`
Expected: all pass, specifically `'only the tracked terrain-preset-art.js exception imports core/commands.js from outside application/presentation'`.

- [x] **Step 5: Manual verification (Playwright, `?autotest`, no drag simulation)**

Paint a stroke with the pencil tool, undo, confirm the bitmap reverts exactly. Select a region, delete it, undo, confirm restoration. Import terrain preset art (tiles mode), undo, confirm reversion. This task's two `drawing-engine.js` sites are the single highest-risk change in this whole plan (per the CommandStack investigation's risk assessment: no automated drag coverage) — do this verification personally, not delegated, per established policy.

- [x] **Step 6: Commit**

```bash
git add js/components/canvas/drawing-engine.js js/modes/tiles/terrain-preset-art.js
git commit -m "refactor: route drawing-engine.js and terrain-preset-art.js undo pushes through HistoryService.execute()"
```

---

## Task 6: Maps mode cleanup (6 files)

**Files:**
- Modify: `js/modes/maps/contributions.js`, `js/modes/maps/application/commands/map-paint-commands.js`, `js/modes/maps/presentation/map-assets-panel.js`, `js/modes/maps/presentation/map-panel.js`, `js/modes/maps/presentation/map-tool-presenter.js`, `js/modes/maps/preview.js`

**Interfaces:**
- Consumes: `js/host/document-helpers.js`'s `activeMap`; `js/platform/browser/autotest.js` (where used); `js/components/panel-mount.js`'s `mountStorePanel`.

Apply the substitution table below to every listed file. Full worked example first (`map-panel.js`, already fully read — reproduced here as the reference every other file in this task follows):

**Before** (`js/modes/maps/presentation/map-panel.js`, current):
```js
import { state, on, emit, activeMap, markDirty } from '../../../app/state.js';
import { clearMapRasterCache, isMapPlaying, toggleMapPlayback } from './map-renderer.js';
import { mountReactivePanel } from '../../../components/panel-mount.js';

export function mountMapPanel(container) {
  const render = () => {
    if (state.mode !== 'maps') { container.hidden = true; return; }
    container.hidden = false;
    const map = activeMap();
    // ... (unchanged UI-building logic) ...
    select.onchange = () => { map.snap.mode = select.value; markDirty(); };
    // ...
    input.onchange = () => { map.snap[key] = Math.max(1, +input.value || 1); markDirty(); emit('view'); };
    // ...
  };
  return mountReactivePanel(on, ['view', ['project', clearMapRasterCache], 'selection'], render);
}
```

**After:**
```js
import { getEditorHost } from '../../../host/runtime.js';
import { activeMap } from '../../../host/document-helpers.js';
import { clearMapRasterCache, isMapPlaying, toggleMapPlayback } from './map-renderer.js';
import { mountStorePanel } from '../../../components/panel-mount.js';

export function mountMapPanel(container) {
  const render = () => {
    const host = getEditorHost();
    if (host.store.getState().session.activeModeId !== 'maps') { container.hidden = true; return; }
    container.hidden = false;
    const map = activeMap();
    // ... (unchanged UI-building logic) ...
    select.onchange = () => { map.snap.mode = select.value; getEditorHost().projects.markDirty(); };
    // ...
    input.onchange = () => { map.snap[key] = Math.max(1, +input.value || 1); getEditorHost().projects.markDirty(); };
    // ...
  };
  const store = getEditorHost().store;
  return mountStorePanel(store, [
    s => s.session.activeViewId,
    [s => s.project.model, clearMapRasterCache],
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render);
}
```

Note the direct `map.snap[key]`/`map.snap.mode` mutations here are the exact `markDirty()`-bug case the parent spec's scoping survey flagged (`map-panel.js:27`) — this is not undo-tracked today (no `state.commands.push`) and stays that way (out of scope to add undo tracking here); only the dirty-marking gets fixed. Drop the trailing `emit('view')` at the `gridW`/`gridH` input handler — it existed only to notify the legacy bus; `store.markDirty()`'s own notification plus this panel's own re-render on the next `session.activeViewId`/selection change already covers it. If manual verification (Step 4 below) shows the snap-grid overlay doesn't visually refresh immediately after a grid-size edit, restore an explicit `canvasView.requestRender()`-equivalent call here — check how `map-tool-presenter.js`'s own repaint triggers work (this file is in the same task) before inventing a new mechanism.

**General substitution table for this task's other 5 files** (apply per the parent design spec's table, repeated here for convenience):

| Legacy usage | Replacement |
|---|---|
| `state.mode` / `state.tool` reads | `getEditorHost().store.getState().session.activeModeId` / `.activeToolId` |
| `activeMap()` calls | Import from `js/host/document-helpers.js` instead of `app/state.js` — call sites unchanged |
| `on(event, handler)` / `emit(event)` | `getEditorHost().store.subscribe(selector, listener, opts)` (or `getEditorHost().history.subscribe(...)` for `'history'`) |
| `markDirty()` | `getEditorHost().projects.markDirty()` |
| `state.commands.push(...)` (`map-paint-commands.js`'s `runCommand` helper only) | Already routes through `runEntityCommand`/`services.history.execute` — this file's ONLY change is removing the redundant legacy `markDirty()` call at the end of its own `runCommand` wrapper (see `js/modes/maps/application/commands/map-paint-commands.js:11-16`, shown in Task 2's investigation) and its `import { markDirty } from '.../app/state.js'` line. |

`map-tool-presenter.js` and `map-assets-panel.js` both read `state.mode`/`state.tool` at ~10 call sites each (grep-verified) — apply the table above at every site; `contributions.js` and `preview.js` each have a single `import { state, activeMap } from '.../app/state.js'` line and light usage — verify with `grep -n "state\." <file>` after editing that zero references remain before moving on.

- [x] **Step 1: Apply the substitutions to all 6 files** (worked example above for `map-panel.js`, table-driven for the rest — read each file fully before editing, do not pattern-match blindly).
- [x] **Step 2: Run the full suite.** Run: `npm test`. Expected: green.
- [x] **Step 3: `grep -rl "app/state.js" js/modes/maps/`** — expected: zero results.
- [x] **Step 4: Manual verification (Playwright, `?autotest`)** — switch to maps mode, create/select a map, change snap settings (confirm dirty indicator now activates — this is the bug-fix repro case), paint tiles/sprites, undo/redo, add/delete map layers via the layers panel (exercises Task 2's `maps.setLayerOpacity` too — set an opacity, undo).
- [x] **Step 5: Commit**

```bash
git add js/modes/maps/
git commit -m "refactor: migrate maps mode's remaining 6 files off app/state.js"
```

---

## Task 7: Sprites mode cleanup (11 files)

**Files:**
- Modify: `js/modes/sprites/application/commands/{animation-commands,animation-lifecycle-commands,frame-commands,strip-commands}.js`, `js/modes/sprites/presentation/{animations-panel,frame-editor-presenter,frame-tool-presenter,frames-panel,slice-grid-dialog,timeline-presenter}.js`, `js/modes/sprites/preview.js`

**Interfaces:**
- Consumes: `js/host/document-helpers.js`'s `activeSheet`/`currentContextLayers`; `js/platform/browser/autotest.js`'s `confirmOrAuto`; `js/components/panel-mount.js`'s `mountStorePanel`.

Full worked example (`frames-panel.js`, already fully read in planning — reproduced as reference):

**Before:**
```js
import { state, on, emit, activeSheet } from '../../../app/state.js';
// ...
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }
// ...
editButton.addEventListener('click', () => {
  state.editingFrameId = frame.id;
  state.view = 'frame';
  emit('view');
});
// ...
function render() {
  if (state.mode !== 'sprites') { panel.hidden = true; return; }
  // ...
}
return mountReactivePanel(on, ['project', 'history', 'view', 'selection'], render);
```

**After:**
```js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
// ...
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: getEditorHost().store.getState().session.activeModeId }, args); }
// ...
editButton.addEventListener('click', () => {
  getEditorHost().selections.patch({ editingFrameId: frame.id }, sheetDocument(activeSheet()));
  getEditorHost().store.transaction('view', s => { s.session.activeViewId = 'sprites.frame'; });
});
// ...
function render() {
  if (getEditorHost().store.getState().session.activeModeId !== 'sprites') { panel.hidden = true; return; }
  // ...
}
const store = getEditorHost().store;
return mountStorePanel(store, [
  s => s.project.model,
  s => s.session.activeViewId,
  s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
], render, { onDispose: () => getEditorHost().history.subscribe(render)() /* placeholder -- see note */ });
```

Two things in that sketch need care, not copy-paste:

1. **`state.editingFrameId`**: per the parent spec's state-field mapping table, `editingFrameId`/`editingTileId`/`selectedTileId`/`selectedTerrainSetId` move into `EditorStore.session.selectionsByDocument` via `SelectionService`, extending the mechanism that already covers `layerId`/`frameId`/`animationId`. Use `getEditorHost().selections.patch({editingFrameId: frame.id}, sheetDocument(sheet))` — confirm `SelectionService.patch()` exists and merges rather than replaces (per the parent spec's Foundation item 4/`setSelection` sharp-edge callout: use `patch()`, never raw `set()`, for a single-field update, or you'll clobber `layerId`/`animationId` already stored there).
2. **`state.view = 'frame'`**: the target view id format is `'<mode>.<view>'` per already-migrated code (`js/host/editor-store.js`'s `createEditorState()` sample and `document-controller.js`'s existing subscriptions use dotted view ids like `'sprites.sheet'`) — confirm the exact string `'sprites.frame'` (not bare `'frame'`) is what `editor-workbench.js`'s view-switching logic already expects, by grepping for `activeViewId` string literals elsewhere in already-migrated sprites/tiles code (`tile-tool-presenter.js:26` sets `state.view = 'tile'` today — that file is in Task 8, migrating in parallel; cross-check both against whatever `editor-workbench.js` already reads for `activeViewId` to land on a consistent format across both modes, since Task 5's investigation earlier in this same conversation found `session.activeViewId` never actually transitions today — this task and Task 8 are what FIXES that latent gap, so get the string format right by reading `editor-workbench.js`'s current `applyView()`-equivalent logic first, not by guessing).

The `history.subscribe` line in the sketch above is deliberately marked as a placeholder — `HistoryService.subscribe(listener)`'s return value and exact signature must be confirmed by reading `js/host/history-service.js` (already read in full during Task 1) before wiring it into `mountStorePanel`'s `onDispose`; compose it correctly (call `subscribe` once, keep its returned dispose function, call that dispose function inside `onDispose`) rather than the malformed one-liner shown.

Apply the same substitution table as Task 6 to the remaining 10 files, reading each in full first. Particular call-outs from the grep evidence gathered during planning:
- `frame-editor-presenter.js`, `frame-tool-presenter.js`, `timeline-presenter.js`, `frames-panel.js`, `tile-editor-presenter.js`-equivalent sprites files: all set `state.view = 'frame'`/read `state.view === 'frame'` — same `activeViewId` format resolution as above applies everywhere, not just `frames-panel.js`.
- `frame-editor-presenter.js` has the plan's OTHER documented `markDirty()`-bug repro case (onion-settings commit, not pushed through any command stack) — convert to `getEditorHost().projects.markDirty()`, and manually verify (Step 4) that editing onion-skin settings now correctly triggers the dirty indicator/autosave, which it silently didn't before this plan.
- `animation-lifecycle-commands.js` only imports `activeSheet` — trivial swap.
- `strip-commands.js` imports `emit, activeSheet, currentContextLayers` — no `state`/`on`/`markDirty`, so this file only needs the import-source swap for `activeSheet`/`currentContextLayers` plus confirming its `emit(...)` calls target a signal that's staying on the legacy bus (`'pixels'`/`'selection'` are fine per established carve-outs; anything else needs a store-based replacement — check before leaving `emit` in place).

- [x] **Step 1: Apply substitutions to all 11 files.**
- [x] **Step 2: Run the full suite.** Run: `npm test`.
- [x] **Step 3: `grep -rl "app/state.js" js/modes/sprites/`** — expected: zero results.
- [x] **Step 4: Manual verification (Playwright, `?autotest`)** — sprites mode: open the frame editor (confirms the `activeViewId` fix), edit onion-skin settings (confirms the markDirty fix), create/edit/delete animation strips, break apart a strip, undo/redo across all of the above.
- [x] **Step 5: Commit**

```bash
git add js/modes/sprites/
git commit -m "refactor: migrate sprites mode's remaining 11 files off app/state.js"
```

---

## Task 8: Tiles mode cleanup (11 files — `terrain-preset-art.js` already done in Task 5)

**Files:**
- Modify: `js/modes/tiles/application/commands/tile-sheet-commands.js`, `js/modes/tiles/presentation/{autotile-paint-presenter,terrain-set-editor,terrain-set-panel,tile-editor-presenter,tile-layers-panel,tile-panel,tile-raster-cache,tile-tags-field,tile-tool-presenter}.js`, `js/modes/tiles/preview.js`

**Interfaces:**
- Consumes: same as Tasks 6-7.

Full worked example (`tile-layers-panel.js`, already fully read — reproduced as reference):

**Before:**
```js
import { state, on, activeSheet } from '../../../app/state.js';
// ...
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args); }
// ...
function render() {
  if (state.mode !== 'tiles') { element.hidden = true; return; }
  // ...
}
return mountReactivePanel(on, ['project', 'history', 'view', 'selection'], render);
```

**After:**
```js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
// ...
function dispatch(id, args) { return getEditorHost().registries.commands.execute(id, { modeId: getEditorHost().store.getState().session.activeModeId }, args); }
// ...
function render() {
  if (getEditorHost().store.getState().session.activeModeId !== 'tiles') { element.hidden = true; return; }
  // ...
}
const store = getEditorHost().store;
const panel = mountStorePanel(store, [
  s => s.project.model,
  s => s.session.activeViewId,
  s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
], render);
const disposeHistory = getEditorHost().history.subscribe(() => panel.scheduleRender());
return { ...panel, dispose() { disposeHistory(); panel.dispose(); } };
```

(This is the corrected, non-placeholder version of the `history.subscribe` composition Task 7 flagged as needing care — use this exact pattern in both tasks, replacing Task 7's marked-incomplete sketch too if you reach Task 8 second.)

`tile-sheet-commands.js` needs particular care (already read in full during Task 2's planning): remove its own `runCommand` helper's redundant `markDirty()` call (line 21, `markDirty();` right after `runEntityCommand(...)`) and its `import { state, emit, markDirty } from '.../app/state.js';` line — but this file's OTHER `state.selectedTileId`/`state.selectedTerrainSetId` direct writes (lines 122, 126, 138-139, 148-149, 158-159, 165-166, 189-190, 200, 211, 216, 247-249, 258-259, 265-266) must move to `getEditorHost().selections.patch({selectedTileId: ...}, <sheet document>)` per the parent spec's Foundation item 4 (extending `selectionsByDocument` to cover tile/terrain-set selection) — this is the single largest concentration of that particular substitution in the whole plan; go through each site individually rather than a blanket find-replace, since several are inside `undo()` closures reverting to a captured `before` value and must keep that exact revert semantics (e.g. line 165-166's `if (wasSelected) state.selectedTileId = tileId;` becomes `if (wasSelected) getEditorHost().selections.patch({selectedTileId: tileId}, sheetDocument(sheet));`).

Apply the Task 6/7 substitution table to the remaining files. Call-outs from grep evidence:
- `tile-tool-presenter.js`, `tile-editor-presenter.js` set/read `state.view`/`'tile'` — same `activeViewId` format resolution as Task 7.
- `autotile-paint-presenter.js` both reads AND writes `state.tool` (lines 273, 282: `state.tool = 'autotilepaint'` / `state.tool = 'tiletool'`) — writes go through `getEditorHost().store.transaction('tool', s => { s.session.activeToolId = 'autotilepaint'; })`, not a direct property assignment (`EditorStore` has no raw settable `activeToolId` outside a transaction).
- `tile-tags-field.js`, `tile-raster-cache.js` only import `{ state }` (no `on`/`emit`/helpers) — check their actual `state.*` usage before assuming they're purely `state.mode`-gated; read in full.

- [x] **Step 1: Apply substitutions to all 11 files** (10 presentation/preview files + `tile-sheet-commands.js`).
- [x] **Step 2: Run the full suite.** Run: `npm test`.
- [x] **Step 3: `grep -rl "app/state.js" js/modes/tiles/`** — expected: zero results (including `terrain-preset-art.js`, already clean from Task 5).
- [x] **Step 4: Manual verification (Playwright, `?autotest`)** — tiles mode: open the tile editor (confirms `activeViewId`), autotile paint a stroke and undo, edit terrain sets, select/deselect tiles and terrain sets via the panel (confirms the `selections.patch` conversion didn't break selection persistence across the many converted sites in `tile-sheet-commands.js`), add/rename/delete tile layers.
- [x] **Step 5: Commit**

```bash
git add js/modes/tiles/
git commit -m "refactor: migrate tiles mode's remaining 11 files off app/state.js"
```

---

## Task 9: Remaining shell + shared-component residuals (9 files)

**Files:**
- Modify: `js/features/workbench/editor-workbench.js`, `js/features/transforms/filter-controller.js`, `js/features/project/project-controller.js`, `js/features/project/file-controller.js`, `js/features/project/document-controller.js`, `js/components/tool-palette.js`, `js/components/panels/preview-panel.js`, `js/components/canvas/sheet-overlays.js`, `js/components/canvas/float-session.js`

**Interfaces:**
- Consumes: same as Tasks 6-8.

These 9 files (5 already-migrated Group-4 shell controllers + 4 shared components) have small residual imports only — none push to `state.commands`, none have the volume of call sites Tasks 6-8 dealt with. Per-file exact current import line (grep-verified during planning):

| File | Current import | Fix |
|---|---|---|
| `editor-workbench.js` | `import { state, on, emit, activeSheet, activeLayer } from '../../app/state.js';` | Swap `activeSheet`/`activeLayer` to `document-helpers.js`; check remaining `state.*`/`on`/`emit` usage (this file already uses `editorHost.store.subscribe` extensively per Group 4 — confirm these are the only stragglers). |
| `filter-controller.js` | `import { state, on, emit, activeSheet, activeLayer, activeLayerScope, currentContextLayers } from '../../app/state.js';` | Swap all 4 helper imports to `document-helpers.js`; convert remaining `state`/`on`/`emit` per the established table. |
| `project-controller.js` | `import { state, newDefaultProject, confirmOrAuto } from '../../app/state.js';` | `confirmOrAuto` → `platform/browser/autotest.js`. `newDefaultProject` and remaining `state` usage: read the file — `newDefaultProject` has no host equivalent yet; check whether Group 4 already routed project creation through `getEditorHost().setProject(...)`/`host.projects.replace(...)` and this is a stale leftover import, or whether it's still load-bearing (if load-bearing, relocate `newDefaultProject` itself — it's a pure function per its definition in `state.js:142-147`, taking `settings` and returning a plain project object with zero state coupling — move it to `js/core/model.js` alongside `createProject`/`createSheet`, which it already calls). |
| `file-controller.js` | `import { state, on, emit, activeSheet, activeMap, newDefaultProject, AUTOTEST, confirmOrAuto } from '../../app/state.js';` | `AUTOTEST`/`confirmOrAuto` → `platform/browser/autotest.js`; `activeSheet`/`activeMap` → `document-helpers.js`; `newDefaultProject` → wherever Step above relocates it. This file owns the host→legacy mirror block (per Group 4) — do NOT touch the mirror itself in this task, only this file's OWN direct usages outside the mirror; Task 10 deletes the whole mirror once every consumer (this plan) is done. |
| `document-controller.js` | `import { state, activeSheet, activeMap, confirmOrAuto, maybeSnapPixels } from '../../app/state.js';` | `activeSheet`/`activeMap`/`confirmOrAuto` per the table above. `maybeSnapPixels`: per the parent spec's state-field mapping, becomes a plain function taking `(project, bitmap)` instead of reading `state.project` internally — read `js/app/state.js:102-121`'s current body, relocate to `js/core/pixelSnapper.js` (already exists, already imported by `maybeSnapPixels` today) as `snapProjectPixels(project, bitmap)` or similar, updating its ~4 call sites across this file and `float-session.js` (below) to pass `project` explicitly (`getEditorHost().projects.project`). |
| `tool-palette.js` | `import { state, on, emit } from '../app/state.js';` | Standard table substitution. |
| `preview-panel.js` | `import { state, on } from '../../app/state.js';` | Standard table substitution — this file already dispatches via `registries.previews.list` per `architecture.test.mjs`'s existing test at line 93-97; do not break that. |
| `sheet-overlays.js` | `import { state, activeSheet } from '../../app/state.js';` | `activeSheet` → `document-helpers.js`; check remaining `state.*` reads (likely `state.overlays.labels`/`.sequences`, already noted as legacy-mirror-fed in Group 4's work — leave those exactly as they are, this file's relationship to the overlays mirror is unaffected by this plan; only the `activeSheet` import changes). |
| `float-session.js` | `import { state, emit, activeSheet, activeLayer, activeLayerScope, maybeSnapPixels } from '../../app/state.js';` | `activeSheet`/`activeLayer`/`activeLayerScope` → `document-helpers.js`; `maybeSnapPixels` → wherever `document-controller.js`'s step above relocates it (same call, updated signature). |

- [x] **Step 1: Apply the table above to all 9 files, reading each in full first** (several have subtleties flagged in the table — `newDefaultProject`/`maybeSnapPixels` relocation is shared groundwork used by 2 files each, do it once and update both call sites).
- [x] **Step 2: Run the full suite.** Run: `npm test`.
- [x] **Step 3: Re-run `tests/architecture.test.mjs`'s shell-file test specifically**

Run: `node --test tests/architecture.test.mjs`
Expected: `'nothing in the shell controllers imports the retired legacy setProject/markDirty writers'` still passes (it already did after Group 4 — confirm this task didn't regress it) — this test also documents that `on`/`emit` staying imported in these files is fine, so don't over-remove.

- [x] **Step 4: `grep -rl "app/state.js" js/features/ js/components/`** — expected: zero results.
- [x] **Step 5: Manual verification (Playwright, `?autotest`)** — new-project flow (exercises `newDefaultProject`'s relocation), paste/import an image that goes through the pixel snapper (exercises `maybeSnapPixels`'s relocation) in both a mode with pixel-snapping enabled and disabled, toggle label/sequence overlays, exercise the tool palette and preview panel across all 3 modes.
- [x] **Step 6: Commit**

```bash
git add js/features/ js/components/
git commit -m "refactor: migrate remaining shell/component residuals off app/state.js"
```

---

## Task 10: Final deletion — mirror, `state.js`, `js/app` relocation + deletion

**Files:**
- Modify: `js/features/project/file-controller.js` (delete the mirror block)
- Delete: `js/app/state.js`
- Create: `js/platform/browser/project-io.js` (moved from `js/app/io.js`)
- Create: `js/core/export/{exports,animationExport,c99Export,platformExport,projectExport,tiledExport}.js` (moved from `js/app/*.js`)
- Create: `js/core/pngcodec.js` (moved from `js/app/pngcodec.js`)
- Delete: `js/app/` (entire directory, once empty)
- Modify: `tests/architecture.test.mjs` (new guard)
- Modify: every file that imports the 8 relocated files (found via grep in Step 4)

**Interfaces:**
- Produces: the 8 relocated files' public exports are unchanged — only their import path changes for every consumer.

- [x] **Step 1: Confirm zero remaining `state.js` importers**

Run: `grep -rl "app/state.js" js/` (or PowerShell: `Get-ChildItem -Recurse js -Filter *.js | Select-String "app/state.js" -List`)
Expected: zero results. If any remain, STOP — do not proceed with this task until Tasks 6-9 are fully verified complete; deleting `state.js` with a live importer breaks the app.

- [x] **Step 2: Delete `file-controller.js`'s host→legacy mirror block**

Read the file's current mirror section (the `getEditorHost().store.subscribe(...)` calls that write `state.project`/`state.activeSheetId`/`state.activeMapId`/`state.onion`/`state.mode`, the `getEditorHost().history.subscribe(() => emit('history'))` bridge, the overlays mirror, and the bidirectional `state.view` ↔ `activeViewId` sync — all added across Group 4). Delete the entire block; it existed solely to keep the now-fully-migrated 42 files working. Remove the now-unused `import { state, ... } from '../../app/state.js';` line's remaining named imports that were only used by the mirror (some names in that import may still be needed for this file's OWN non-mirror logic — check before deleting the whole import statement; if this file has zero remaining `state.js` usage after removing the mirror, delete the import line entirely).

- [x] **Step 3: Delete `js/app/state.js`**

- [x] **Step 4: Relocate the 8 state-free files**

For each, `git mv` (preserves history) to its target, then grep-and-fix every importer:

```bash
git mv js/app/io.js js/platform/browser/project-io.js
git mv js/app/pngcodec.js js/core/pngcodec.js
mkdir -p js/core/export
git mv js/app/exports.js js/core/export/exports.js
git mv js/app/animationExport.js js/core/export/animationExport.js
git mv js/app/c99Export.js js/core/export/c99Export.js
git mv js/app/platformExport.js js/core/export/platformExport.js
git mv js/app/projectExport.js js/core/export/projectExport.js
git mv js/app/tiledExport.js js/core/export/tiledExport.js
```

Then: `grep -rn "app/io\.js\|app/pngcodec\.js\|app/exports\.js\|app/animationExport\.js\|app/c99Export\.js\|app/platformExport\.js\|app/projectExport\.js\|app/tiledExport\.js" js/` and fix every matched import path to the new location. Each moved file's own internal relative imports (e.g. `pngcodec.js` importing from `../core/...`) also need adjusting for its new location — check each file's own imports after moving, not just its importers.

- [x] **Step 5: Delete `js/app/`**

Confirm it's empty first (`ls js/app` — should show nothing after Steps 2-4), then remove the directory.

- [x] **Step 6: Add the architecture-test guard**

In `tests/architecture.test.mjs`, add a new test banning any future `js/app` import, mirroring the existing style (e.g. the `'nothing imports the retired js/ui directory'` test at line 99):

```js
test('nothing imports the retired js/app directory', async () => {
  for (const file of await jsFiles(join(root, 'js'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*[\\/]app[\\/]/, file);
  }
});
```

Run it against the pre-this-task baseline first (`git stash`, run just this new test, confirm it FAILS against the old tree with `app/state.js` still present, then `git stash pop`) to confirm it's non-vacuous, per this codebase's established testing discipline (Task 5 of the Group 4 plan did the same check for its own guard test).

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: all green, no failures.

- [x] **Step 8: Manual verification (Playwright, `?autotest`)**

Full smoke pass: load the app fresh (zero console errors), switch through all 3 modes, create/save/load a project (exercises the relocated `io.js`), export in at least 2 formats (exercises relocated export files — pick 2 different ones, e.g. PNG spritesheet and Tiled JSON), undo/redo a few operations in each mode.

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: delete file-controller.js's legacy mirror and js/app/state.js; relocate js/app's 8 state-free files; delete js/app; add architecture-test guard"
```

---

## Final Review

Once all 10 tasks are complete: dispatch the plan's final whole-branch review on the most capable available model, per `superpowers:subagent-driven-development`'s process — this plan touches undo-history correctness (Tasks 1, 2, 5) and 42 files' worth of state-access migration, comparable in risk to the Group 4 shell rewrite's own final review (which caught 5 Critical + 3 Important regressions in already-task-reviewed work). Pay particular attention, per that prior review's lesson ("who else reads what this stopped writing?"): does anything besides the files this plan touched still expect `state.js`'s events/fields to exist? Does every `markDirty()` bug-fix site actually fire on the right user action? Does the drag-and-drop layer reorder path (Task 3) actually preserve tree structure correctly across an undo, verified live, not just read from the diff?

### Review checkpoint — 2026-08-28

- [x] Independent whole-plan review of `7a5f1d0..c41355e` completed, covering all ten tasks.
- [x] One focused fix wave addressed six regressions: palette undo target identity, dangling layer selection, Maps layer rename, stale Maps source rasters, terrain-paint toolbar refresh, and stale tile gestures.
- [x] Independent scoped re-review found all six addressed, with no new Critical/Important breakage.
- [x] Fresh verification: `npm test` **716/716 passing**, all **164** production JavaScript files parse, and `git diff --check` passes. Regression fixtures live in `tests/`, without dependencies on ignored review artifacts.
- [x] Browser checks passed for layer undo/delete and drawing afterward; Maps rename/undo/redo/cancel; terrain Start/Done/restart; and source edits plus Maps-only undo/redo repainting both brush thumbnails and preview. Palette selection changes plus keyboard undo/redo were checked with command-based edit setup, not native-picker interaction. No page/console errors occurred in these checks.
- [x] Owner-only layer reorder/Undo gate accepted as completed by explicit user instruction on 2026-08-28 ("treat the manual check as completed"). This records user acceptance, not a new observed manual test or automated browser-drag result.
- [x] Commit the reviewed fix wave with this acceptance checkpoint. The prior approved `docs/ARCHITECTURE.md` edit remains unchanged and separate from this fix wave.

Two plan-sketch corrections were necessary: palette history resolves the originally edited palette ID, and caller-owned layer selection recovery repairs the authoritative selection rather than only row highlighting. Map rename also reuses the sheet rows' narrow click deferral so its repaired commit path is reachable.

Phase 5's optional `sheet.layers` → `sheet.tileLayerNames` polish is separate and has not started. A pre-existing blank-startup-canvas sizing issue (already present at `7a5f1d0`, resolved visually by a mode roundtrip) remains a separate follow-up; it is not one of the six migration regressions fixed here. Phase 4's review and acceptance gates are closed, with the owner-only reorder gate accepted by user instruction as recorded above; no additional manual execution is claimed.

### Migration closeout — 2026-08-28 (supersedes the follow-up status above)

- [x] Phase 5 is complete: runtime tile metadata uses `sheet.tileLayerNames`;
  project/export JSON retains `layers`, version 3, and legacy v2/flat-layer loading.
- [x] The separate startup blank-canvas issue is fixed. Canvas refresh observes
  active-document changes, including switches between differently sized sheets.
- [x] Inactive Tile Layers/Autotiles containers now hide completely. Shared
  panel mount points remain visible while another active panel uses them.
- [x] Independent reviews of Phase 5 and the workbench fixes reported no issues.
  Latest full verification: **723/723 tests passing**; focused browser checks
  cover startup, sheet switching, mode visibility, and drawing undo/redo at
  1600×900 and 1280×800. Native pickers and pointer drags were not simulated.
- [x] Plan implementation and the identified follow-up fixes are closed. The
  accepted owner-only reorder gate remains closed as recorded above; this does
  not replace release-time manual smoke checks.

`docs/ARCHITECTURE.md` is the current-state reference. This plan retains its
dated implementation instructions and checkpoints as historical context.
