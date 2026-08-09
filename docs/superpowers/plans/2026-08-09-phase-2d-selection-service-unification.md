# Phase 2d: Unify Frame/Animation/Layer Selection onto SelectionService Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `getEditorHost().selections` (the existing `SelectionService`, already the source of truth for maps mode's layer/item selection) the single source of truth for sprite-sheet frame selection, sprite-sheet animation selection, and sprite-sheet/tile-sheet active-layer selection — replacing the legacy `state.selectedFrameId`, `state.selectedAnimationId`, and `state.activeLayerId` fields everywhere they are read or written, across both sprites-mode-owned files and the shared cross-mode files (`document-controller.js`, `file-controller.js`, `js/ui/panels.js`'s Layers panel, `js/ui/tools.js`, `js/ui/overlays.js`, `js/features/workbench/editor-workbench.js`) that also depend on them.

**Architecture:** Follows the pattern already established and battle-tested by maps mode: a document reference `{ kind, id }` (here `{ kind: 'sprite-sheet'|'tile-sheet', id: sheet.id }`, derived from `sheet.kind`) keys a per-document selection object in `EditorStore`'s `session.selectionsByDocument`, read/written via `getEditorHost().selections.get/set(document)`. Two of `js/app/state.js`'s existing accessor functions (`activeLayer()`, `currentContextLayers()`) already centralize the majority of *read* call sites — migrating only their internals means the 20+ external callers of `activeLayer()` need no changes at all. Every remaining direct read/write of the three legacy fields (writes inside Command Handler `do`/`undo` closures, writes inside legacy `state.commands.push({do,undo})` closures in `document-controller.js`/`js/ui/panels.js`, and plain UI-selection reads/writes with no undo tracking) is migrated individually, in place, preserving each site's exact current undo-tracking behavior (a write inside a `do`/`undo` closure stays inside that closure; a fire-and-forget UI write stays fire-and-forget).

**Tech Stack:** Vanilla JS (ES modules), Node's built-in `node:test`/`node:assert`, no build step, `npm test` runs the full suite.

## Global Constraints

- **Undo-tracking behavior must be preserved exactly, per site.** Where a legacy field write currently lives inside a `do()`/`undo()` closure (a Command Handler's `runSheetCommand` callback, or a legacy `state.commands.push({do, undo})` entry in `document-controller.js`/`js/ui/panels.js`), the replacement selection-service call goes in the exact same position inside that same closure — the selection change remains part of that undo entry. Where a legacy field write currently happens outside any undo entry (e.g. a plain frame click in `frame-tool-presenter.js`), the replacement stays a plain fire-and-forget call. This is a deliberate departure from copying maps mode's simpler always-fire-and-forget `SelectionService` usage — confirmed with the project owner, since sprites/tiles' active-layer selection is currently undo-tracked and maps' is not.
- **Two different access paths, chosen per layer (confirmed with the project owner after discovering the test-isolation conflict below):**
  - **Command Handler files** (`js/modes/sprites/application/commands/{frame,animation,animation-lifecycle,strip}-commands.js`) — these already receive a `services` object (`services.projects`, `services.history`) built fresh per call site (production: `contributions.js`'s local `services()` helper; tests: each file's local `makeServices(project)` helper, which builds an **isolated** `EditorStore` and never calls `setEditorHost()`). Reaching for the global `getEditorHost()` inside these files would crash every existing command test (`getEditorHost()` returns `null` there). Instead, these files receive selection access via **dependency injection**: `services.selections`, a `SelectionService` instance wired to the *same* `services.store` the test/production caller already constructed — exactly mirroring how `services.projects`/`services.history` are already injected. Production: `contributions.js`'s `services()` helper adds `selections: host.selections`. Tests: each of the 4 command test files' `makeServices(project)` helper adds `selections: new SelectionService(store)` (new import in each file). Do/undo closures call `services.selections.get(doc)` / `services.selections.set({...}, doc)` where `doc = sheetDocument(target)` (a local helper, per the convention below).
  - **Everything else** (presentation-layer files, `document-controller.js`, `js/ui/panels.js`, `js/ui/tools.js`, `js/ui/overlays.js`, `js/features/workbench/editor-workbench.js`, `js/features/project/file-controller.js`) — these already call `getEditorHost()` directly for other purposes (e.g. `dispatch()` helpers calling `getEditorHost().registries.commands.execute(...)`) and are never exercised by a test that omits host setup, so they call `getEditorHost().selections.get/set(...)` directly, unconditionally — exactly matching maps mode's existing pattern in `map-tool-presenter.js`.
  - **`js/app/state.js`'s `activeLayer()` and `currentContextLayers()` accessors are the one exception with a null-host fallback**: `tests/floatsession.test.mjs` sets `state.activeLayerId` as a bare field and exercises `activeLayer()` indirectly (via `js/ui/floatsession.js`) with no host configured at all — rewriting that test was explicitly ruled out as unnecessary churn. Both accessors read `getEditorHost()?.selections.get(sheetDocument(sheet))` **when a host is configured**, falling back to reading the legacy bare `state.activeLayerId`/`state.selectedAnimationId` field only when `getEditorHost()` returns `null`. In production a host is always configured (composition root wires it before any app code runs), so the fallback branch is dead code in production and exists purely so this one pre-existing test keeps working unmodified. This is the ONLY place in the plan where a legacy bare-field read survives as live (conditional) code — everywhere else, direct bare-field reads/writes are fully replaced, not fallback-guarded.
- **Document key derivation**: `{ kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id }`, matching the convention already hard-coded in `js/features/project/legacy-state-adapter.js:11`. Each file that needs this defines its own small local helper (e.g. `function sheetDocument(sheet) { return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id }; }`), matching the existing precedent of `js/modes/maps/presentation/map-tool-presenter.js:15`'s local (not shared/exported) `mapDocument(map)` helper — do not introduce a new shared cross-cutting module for this.
- **Selection shape per document kind**: sprite-sheet documents carry `{ layerId, frameId, animationId }`. Tile-sheet documents carry `{ layerId }` only in this phase — `selectedTileId`/`selectedTerrainSetId` (tiles-mode-only fields) are explicitly OUT OF SCOPE and stay as legacy `state.*` fields untouched, even though `js/ui/panels.js`'s Layers panel is shared code that also runs for tile-sheet documents (only its `layerId` handling is in scope; nothing tile-specific).
- **`js/app/state.js`'s `activeLayer()` and `currentContextLayers()` accessor functions are migrated internally only.** Their external signature (`activeLayer()` takes no args, returns a Layer node or null; `currentContextLayers()` takes no args, returns a Layer array) does not change, so their 20+ existing call sites across `js/ui/tools.js`, `js/ui/floatsession.js`, `js/ui/panels.js`, `js/features/workbench/editor-workbench.js`, `js/features/transforms/filter-controller.js`, `js/modes/tiles/terrain-set-controller.js` need NO changes and are explicitly OUT OF SCOPE for direct editing in this plan (verify via `npm test` and manual QA that they still work through the migrated accessors, but do not touch their source).
- **`js/app/state.js` gains a new dependency on `js/host/runtime.js`'s `getEditorHost()`.** This is a new import direction for this file but is consistent with the migration's stated end state (`document-controller.js`'s own comment: "the host is authoritative... Mirroring the remaining state into the new service store lets features migrate one at a time"). `js/app/state.js` is legacy glue, not `js/core/` or `js/domain/`, so `tests/architecture.test.mjs`'s pure-module import bans do not apply to it — confirm this file is not in the banned-import scan list before relying on this.
- **Persistence semantics are unchanged.** `state.selectedFrameId`/`state.selectedAnimationId`/`state.activeLayerId` are runtime-only fields on the bare `state` object (never under `state.project`), so they are never saved into the project JSON and are already lost on reload. `EditorStore`'s `session.selectionsByDocument` (`SelectionService`'s backing store) is equally runtime-only. Migrating between them is not a persistence behavior change.
- **`legacy-state-adapter.js`'s unconditional-overwrite branch for sprite-sheet/tile-sheet documents must be replaced with a seed-once pattern**, matching the maps branch immediately above it in the same function (`if (!state.session.selectionsByDocument[key]) { ...seed a default... }`), once `SelectionService` becomes the sole writer for `layerId`/`frameId`/`animationId`. Until every writer in this plan is migrated, do not make this change prematurely — it is the LAST step of the LAST task, after every other write site is confirmed migrated.
- Command Handler files (`js/modes/sprites/application/commands/*.js`) must continue satisfying `tests/architecture.test.mjs`'s "sprite command modules do not access browser UI globals" scan (no `document`/`window`/`alert`/`confirm`/`prompt`) — `getEditorHost()` itself is fine (it's not a banned global), already used by other Application-adjacent code via `js/host/runtime.js`.
- Presentation-layer files (`js/modes/sprites/presentation/*.js`) must continue dispatching Commands by id only — this plan does not change that; it only changes how selection state is read/written, which was never routed through Commands.
- No test file should still import or assert against a since-removed `state.selectedFrameId`/`state.selectedAnimationId`/`state.activeLayerId` initial value — `tests/builtinmodes.test.mjs` and the sprites command test files construct their own `services`/`state` objects and may need their `reset()` helpers updated if they seed these fields directly (verify during the relevant task).

- No test file should still import or assert against a since-removed `state.selectedFrameId`/`state.selectedAnimationId`/`state.activeLayerId` value in a way that no longer reflects how selection is stored. `tests/floatsession.test.mjs` needs NO changes (see the null-host fallback above). The 4 sprite command test files (`sprite-frame-commands.test.mjs`, `sprite-animation-commands.test.mjs`, `sprite-animation-lifecycle-commands.test.mjs`, `sprite-strip-commands.test.mjs`) DO need their `makeServices()` helper and every assertion against these 3 fields rewritten — exact rewrites are given in Task 1 below.
- **Task decomposition rationale (why only 2 tasks despite the size):** Every non-command file in scope (`state.js`, `document-controller.js`, `panels.js`, `tools.js`, `overlays.js`, `editor-workbench.js`, `file-controller.js`, every sprites `presentation/*.js` file, `sprites/preview.js`) both READS and WRITES the same conceptual selection; splitting these across multiple landed tasks would leave the app reading from one mechanism while some as-yet-unmigrated writer still writes the other, silently breaking selection-follow behavior in production between task commits (existing automated tests would NOT catch this, since none of them exercise the cross-file integration — they test command functions and presentation files in isolation). The 4 command-handler files have the identical problem relative to every reader of `state.selectedFrameId`/`state.activeLayerId`/`state.selectedAnimationId`. All of it is therefore ONE atomic task (Task 1). Task 2 (cleanup) is safe to land separately because by the time it runs, nothing reads the legacy fields it removes.

---

## Task 1: Unify all sprites/tiles selection reads and writes onto SelectionService

**Files:**
- Modify: `js/app/state.js`
- Modify: `js/features/project/document-controller.js`
- Modify: `js/features/project/legacy-state-adapter.js`
- Modify: `js/ui/panels.js`
- Modify: `js/ui/tools.js`
- Modify: `js/ui/overlays.js`
- Modify: `js/features/workbench/editor-workbench.js`
- Modify: `js/features/project/file-controller.js`
- Modify: `js/modes/sprites/presentation/frame-tool-presenter.js`
- Modify: `js/modes/sprites/presentation/frames-panel.js`
- Modify: `js/modes/sprites/presentation/timeline-presenter.js`
- Modify: `js/modes/sprites/presentation/animations-panel.js`
- Modify: `js/modes/sprites/presentation/frame-editor-presenter.js`
- Modify: `js/modes/sprites/preview.js`
- Modify: `js/modes/sprites/contributions.js`
- Modify: `js/modes/sprites/application/commands/frame-commands.js`
- Modify: `js/modes/sprites/application/commands/animation-commands.js`
- Modify: `js/modes/sprites/application/commands/animation-lifecycle-commands.js`
- Modify: `js/modes/sprites/application/commands/strip-commands.js`
- Modify: `tests/sprite-frame-commands.test.mjs`
- Modify: `tests/sprite-animation-commands.test.mjs`
- Modify: `tests/sprite-animation-lifecycle-commands.test.mjs`
- Modify: `tests/sprite-strip-commands.test.mjs`

**Interfaces:**
- Produces: a `sheetDocument(sheet)` local helper, redefined identically (not imported/shared) in every file below that needs one: `function sheetDocument(sheet) { return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id }; }` — mirrors `map-tool-presenter.js`'s local (non-exported) `mapDocument()` precedent.
- Produces: `services.selections` — a `SelectionService` instance, added to the object returned by `contributions.js`'s local `services()` helper and by each of the 4 command test files' `makeServices()` helper. Command-handler `do()`/`undo()` closures call `services.selections.get(doc)` / `services.selections.set({...}, doc)`.
- Produces: `js/app/state.js`'s `activeLayer()` and `currentContextLayers()` keep their existing external signatures (no-arg, same return types) — every one of their 20+ existing callers needs zero changes.
- Consumes: `js/host/selection-service.js`'s existing `SelectionService` class and `js/host/runtime.js`'s existing `getEditorHost()` — neither changes in this task.

### Step 1: `js/app/state.js` — accessors + `setProject()`

Add an import and a local helper, and change `activeLayer()`, `currentContextLayers()`, and `setProject()`:

```js
import { CommandStack } from '../core/commands.js';
import { createProject, createSheet, DEFAULT_SETTINGS, defaultOnionSettings, findLayer, findNode, sheetLayers, contextLayers as modelContextLayers, flattenLayers, layerAnimationContext, resolvePixelSnapperPalette } from '../core/model.js';
import { snapPixels } from '../core/pixelSnapper.js';
import { getEditorHost } from '../host/runtime.js';
```

Add right after the `AUTOTEST`/`confirmOrAuto` exports, before `export const state = {`:

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Replace `activeLayer()`:

```js
export function activeLayer() {
  const sheet = activeSheet();
  if (!sheet) return null;
  const host = getEditorHost();
  const layerId = host ? (host.selections.get(sheetDocument(sheet))?.layerId ?? null) : state.activeLayerId;
  return findLayer(sheet.layerTree, layerId);
}
```

Replace `currentContextLayers()`:

```js
export function currentContextLayers() {
  const sheet = activeSheet();
  if (!sheet) return [];
  const host = getEditorHost();
  const animationId = host ? (host.selections.get(sheetDocument(sheet))?.animationId ?? null) : state.selectedAnimationId;
  return modelContextLayers(sheet, animationId);
}
```

`activeLayerScope()` is unchanged (it calls `activeLayer()` internally, already covered).

In `setProject()`, replace this line:

```js
  state.activeLayerId = sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null;
```

with:

```js
  const host = getEditorHost();
  if (sheet && host) host.selections.set({ layerId: sheetLayers(sheet)[0]?.id ?? null }, sheetDocument(sheet));
```

(`state.activeLayerId` stays declared in the `state` object literal, unchanged — it is now read only by `activeLayer()`'s null-host fallback and written only by `tests/floatsession.test.mjs`'s own setup. `state.selectedFrameId`/`state.selectedAnimationId` stay declared too for now; Task 2 removes both once nothing references them.)

**Why the null-host fallback matters here:** `tests/floatsession.test.mjs` sets `state.activeLayerId` directly and exercises `activeLayer()` (via `js/ui/floatsession.js`) without ever configuring a host. In production a host is always configured before any of this code runs, so the fallback branch never executes there.

### Step 2: `js/features/project/document-controller.js` and `js/features/project/legacy-state-adapter.js`

**Critical ordering note:** `document-controller.js` wires `on('selection', syncEditorHost)` (among other events) to `syncLegacyStateToHost(editorHost, state)`. Every write this task makes to `services.selections`/`getEditorHost().selections` is followed, directly or via a re-render, by an `emit('selection')`. `legacy-state-adapter.js`'s sprites/tiles branch currently OVERWRITES `state.session.selectionsByDocument[key]` unconditionally, every single time, from the legacy bare fields (`legacyState.activeLayerId`/`selectedFrameId`/`selectedAnimationId`). Once every production write site in this task stops writing those bare fields, they go stale (frozen at whatever they last held — usually `null` after Step 1's `setProject` change), so this unconditional overwrite would immediately clobber every `SelectionService` write made in this same task back to stale/null values on the very next `'selection'` event. This file MUST be fixed together with the rest of this task, not deferred — the migration does not work without it. The maps branch two lines above already has the correct pattern (seed only when the document has no entry yet); apply the same guard to the sprites/tiles branch.

In `js/features/project/legacy-state-adapter.js`, replace:
```js
    } else if (reference) {
      state.session.selectionsByDocument[`${reference.kind}:${reference.id}`] = {
        layerId: legacyState.activeLayerId,
        frameId: legacyState.selectedFrameId,
        animationId: legacyState.selectedAnimationId,
        tileId: legacyState.selectedTileId,
        terrainSetId: legacyState.selectedTerrainSetId,
      };
    }
```
with:
```js
    } else if (reference) {
      // Sprites/tiles layer+frame+animation selection is host-authoritative
      // (SelectionService is the sole writer now, from command handlers and
      // presentation files). Only seed a default the first time this
      // document is seen this session -- mirrors the maps branch above.
      // legacyState.selectedTileId/selectedTerrainSetId stay legacy-owned
      // (out of scope for this migration) and are refreshed unconditionally,
      // same as before.
      const key = `${reference.kind}:${reference.id}`;
      const existing = state.session.selectionsByDocument[key];
      state.session.selectionsByDocument[key] = {
        ...(existing ?? { layerId: legacyState.activeLayerId, frameId: legacyState.selectedFrameId, animationId: legacyState.selectedAnimationId }),
        tileId: legacyState.selectedTileId,
        terrainSetId: legacyState.selectedTerrainSetId,
      };
    }
```

(A document not yet in `selectionsByDocument` still needs a first-time seed from somewhere -- every real sheet-activation path in this task now calls `seedSheetSelection`/`setSheetSelection`/`host.selections.set` itself before or as part of emitting `'selection'`, so in practice `existing` is populated before this code ever runs for a real sheet. The `legacyState.*` fallback in the spread only matters for `tests/floatsession.test.mjs` and any other path that emits `'selection'` before a host-side seed -- it reads the same already-established null-host-fallback fields from Step 1, so it stays harmless and correct.)

### Step 3: `js/features/project/document-controller.js` selection call sites

Add a `sheetDocument` helper and a `seedSheetSelection` helper inside `mountDocumentController` (near `isTypingTarget`, since both need the `editorHost` parameter already in scope — no new import needed, this file already receives `editorHost` directly):

```js
  function sheetDocument(sheet) {
    return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
  }
  function seedSheetSelection(sheet, layerId) {
    if (!sheet) return;
    editorHost.selections.set(sheet.kind === 'sprite' ? { layerId, frameId: null, animationId: null } : { layerId }, sheetDocument(sheet));
  }
```

In `switchMode`, replace:

```js
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheet = state.project?.sheets.find(s => s.kind === kind) ?? null;
    state.activeSheetId = sheet ? sheet.id : null;
    state.activeLayerId = sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null;
    // Selections (frame/animation/tile) are per-sheet; a stale id surviving an
    // active-sheet change lets e.g. timeline's "Add selected frame" insert one
    // sheet's frameId into another sheet's animation (blank timeline cell,
    // `"frame": null` on export). Clear on every path that reassigns activeSheetId.
    state.selectedFrameId = null;
    state.selectedAnimationId = null;
    state.selectedTileId = null;
    state.view = 'sheet';
```

with:

```js
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheet = state.project?.sheets.find(s => s.kind === kind) ?? null;
    state.activeSheetId = sheet ? sheet.id : null;
    // Selections (layer/frame/animation/tile) are per-sheet; a stale id
    // surviving an active-sheet change lets e.g. timeline's "Add selected
    // frame" insert one sheet's frameId into another sheet's animation
    // (blank timeline cell, `"frame": null` on export). Reseed on every path
    // that reassigns activeSheetId.
    seedSheetSelection(sheet, sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null);
    state.selectedTileId = null;
    state.view = 'sheet';
```

(The earlier `state.activeSheetId = null; state.activeLayerId = null;` line inside the `mode === 'maps'` branch is unchanged — out of scope.)

In the `sheetSelect` change handler, replace:

```js
    state.activeSheetId = sheet.id;
    state.activeLayerId = sheetLayers(sheet)[0]?.id ?? null;
    // See switchMode's comment above: selections are per-sheet, clear them here too.
    state.selectedFrameId = null;
    state.selectedAnimationId = null;
    state.selectedTileId = null;
    state.view = 'sheet';
    emit('view');
```

with:

```js
    state.activeSheetId = sheet.id;
    // See switchMode's comment above: selections are per-sheet, reseed here too.
    seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
    state.selectedTileId = null;
    state.view = 'sheet';
    emit('view');
```

Replace `commitAddSheet` in full:

```js
  function commitAddSheet(sheet) {
    const project = state.project;
    const prevActiveSheetId = state.activeSheetId;
    const prevSheet = activeSheet();
    const prevActiveLayerId = prevSheet ? (editorHost.selections.get(sheetDocument(prevSheet))?.layerId ?? null) : null;
    const insertIndex = project.sheets.indexOf(sheet);
    const cmd = {
      label: 'new sheet',
      do() {
        if (!project.sheets.includes(sheet)) project.sheets.splice(insertIndex, 0, sheet);
        state.activeSheetId = sheet.id;
        // See switchMode's comment above: selections are per-sheet, reseed them too.
        seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
        state.selectedTileId = null;
        state.view = 'sheet';
        emit('view');
      },
      undo() {
        const i = project.sheets.indexOf(sheet);
        if (i !== -1) project.sheets.splice(i, 1);
        state.activeSheetId = prevActiveSheetId;
        if (prevSheet) seedSheetSelection(prevSheet, prevActiveLayerId);
        state.selectedTileId = null;
        state.view = 'sheet';
        emit('view');
      },
    };
    state.commands.push(cmd);
    markDirty();
    emit('view');
  }
```

Replace `commitDeleteSheet` in full:

```js
  function commitDeleteSheet(sheet) {
    const project = state.project;
    const index = project.sheets.indexOf(sheet);
    if (index === -1) return;
    const wasActive = state.activeSheetId === sheet.id;
    const prev = {
      activeSheetId: state.activeSheetId,
      selectedTileId: state.selectedTileId, selectedTerrainSetId: state.selectedTerrainSetId,
      editingFrameId: state.editingFrameId, editingTileId: state.editingTileId,
      view: state.view, floating: state.floating,
    };
    const cmd = {
      label: 'delete sheet',
      do() {
        removeSheet(project, sheet.id);
        if (state.floating?.sheetId === sheet.id) state.floating = null;
        if (wasActive) {
          const siblings = project.sheets.filter(s => s.kind === sheet.kind);
          const next = siblings[Math.min(index, siblings.length - 1)] ?? null;
          state.activeSheetId = next ? next.id : null;
          seedSheetSelection(next, next ? (sheetLayers(next)[0]?.id ?? null) : null);
          state.selectedTileId = null;
          state.selectedTerrainSetId = null;
          state.editingFrameId = null;
          state.editingTileId = null;
          state.view = 'sheet';
        }
        markDirty();
        emit('view');
      },
      undo() {
        project.sheets.splice(index, 0, sheet);
        Object.assign(state, prev);
        markDirty();
        emit('view');
      },
    };
    state.commands.push(cmd);
  }
```

(`sheet`'s own selection document is never touched by `do()` unless `wasActive`, and even then only `next`'s document is reseeded — `sheet`'s own document entry in `selectionsByDocument` is left untouched throughout, so on undo, re-inserting `sheet` automatically finds its previous selection still there. This is equivalent to, and slightly more precise than, the original bare-field snapshot/restore, since `SelectionService` remembers every sheet's selection independently rather than one global field.)

### Step 4: `js/ui/panels.js` — Layers panel

`getEditorHost` is already imported. Add a module-level helper right before `export function mountLayersPanel(el) {`:

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Inside `mountLayersPanel(el)`, right after the `const btnMerge = ...` / `btnRow.append(...)` block and before `let selectedNodeId = state.activeLayerId;`, add:

```js
  function sheetSelection(sheet) {
    return getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
  }
  function setSheetSelection(sheet, patch) {
    getEditorHost().selections.set({ ...sheetSelection(sheet), ...patch }, sheetDocument(sheet));
  }
  function currentLayerId() {
    const sheet = activeSheet();
    return sheet ? (sheetSelection(sheet).layerId ?? null) : null;
  }
  function currentAnimationId() {
    const sheet = activeSheet();
    return sheet ? (sheetSelection(sheet).animationId ?? null) : null;
  }
```

Then replace these lines one by one (each `old` block below is unique in the file, so a plain string replace works for each):

`let selectedNodeId = state.activeLayerId;` → `let selectedNodeId = currentLayerId();`

`let lastSyncedAnimationId = state.selectedAnimationId;` → `let lastSyncedAnimationId = currentAnimationId();`

In `doAddLayer()`:
```js
    const beforeChildren = group.children.slice();
    const beforeActive = state.activeLayerId;
    let newLayer = null;
    const cmd = {
      label: 'add layer',
      do() {
        if (!newLayer) newLayer = createLayerNode(`Layer ${countNodes(sheet, 'layer') + 1}`, sheet.width, sheet.height);
        if (!group.children.includes(newLayer)) group.children.push(newLayer);
        state.activeLayerId = newLayer.id;
        selectedNodeId = newLayer.id;
      },
      undo() {
        group.children = beforeChildren.slice();
        state.activeLayerId = beforeActive;
        selectedNodeId = beforeActive;
      },
    };
```
becomes:
```js
    const beforeChildren = group.children.slice();
    const beforeActive = currentLayerId();
    let newLayer = null;
    const cmd = {
      label: 'add layer',
      do() {
        if (!newLayer) newLayer = createLayerNode(`Layer ${countNodes(sheet, 'layer') + 1}`, sheet.width, sheet.height);
        if (!group.children.includes(newLayer)) group.children.push(newLayer);
        setSheetSelection(sheet, { layerId: newLayer.id });
        selectedNodeId = newLayer.id;
      },
      undo() {
        group.children = beforeChildren.slice();
        setSheetSelection(sheet, { layerId: beforeActive });
        selectedNodeId = beforeActive;
      },
    };
```

In `doAddGroup()`:
```js
    const beforeChildren = group.children.slice();
    const beforeActive = state.activeLayerId;
    let newGroup = null;
    const cmd = {
      label: 'add group',
      do() {
        if (!newGroup) newGroup = createGroupNode(`Group ${countNodes(sheet, 'group') + 1}`);
        if (!group.children.includes(newGroup)) group.children.push(newGroup);
        selectedNodeId = newGroup.id;
        state.activeLayerId = null;
      },
      undo() {
        group.children = beforeChildren.slice();
        selectedNodeId = beforeChildren[beforeChildren.length - 1]?.id ?? null;
        state.activeLayerId = beforeActive;
      },
    };
```
becomes:
```js
    const beforeChildren = group.children.slice();
    const beforeActive = currentLayerId();
    let newGroup = null;
    const cmd = {
      label: 'add group',
      do() {
        if (!newGroup) newGroup = createGroupNode(`Group ${countNodes(sheet, 'group') + 1}`);
        if (!group.children.includes(newGroup)) group.children.push(newGroup);
        selectedNodeId = newGroup.id;
        setSheetSelection(sheet, { layerId: null });
      },
      undo() {
        group.children = beforeChildren.slice();
        selectedNodeId = beforeChildren[beforeChildren.length - 1]?.id ?? null;
        setSheetSelection(sheet, { layerId: beforeActive });
      },
    };
```

In `doDelete()`'s layer branch:
```js
      const beforeChildren = parent.children.slice();
      const beforeActive = state.activeLayerId;
      const idx = loc.index;
      const cmd = {
        label: 'delete layer',
        do() {
          parent.children = parent.children.filter(c => c.id !== layer.id);
          const all = sheetLayers(sheet);
          const fallback = all[Math.min(idx, all.length - 1)];
          state.activeLayerId = fallback ? fallback.id : null;
          selectedNodeId = state.activeLayerId;
        },
        undo() {
          parent.children = beforeChildren.slice();
          state.activeLayerId = beforeActive;
          selectedNodeId = beforeActive;
        },
      };
```
becomes:
```js
      const beforeChildren = parent.children.slice();
      const beforeActive = currentLayerId();
      const idx = loc.index;
      const cmd = {
        label: 'delete layer',
        do() {
          parent.children = parent.children.filter(c => c.id !== layer.id);
          const all = sheetLayers(sheet);
          const fallback = all[Math.min(idx, all.length - 1)];
          const fallbackId = fallback ? fallback.id : null;
          setSheetSelection(sheet, { layerId: fallbackId });
          selectedNodeId = fallbackId;
        },
        undo() {
          parent.children = beforeChildren.slice();
          setSheetSelection(sheet, { layerId: beforeActive });
          selectedNodeId = beforeActive;
        },
      };
```

In `doDelete()`'s group branch:
```js
        const beforeChildren = parent.children.slice();
        const beforeActive = state.activeLayerId;
        const cmd = {
          label: 'delete group',
          do() {
            parent.children = parent.children.filter(c => c.id !== g.id);
            selectedNodeId = state.activeLayerId;
          },
          undo() {
            parent.children = beforeChildren.slice();
            selectedNodeId = g.id;
            state.activeLayerId = beforeActive;
          },
        };
```
becomes:
```js
        const beforeChildren = parent.children.slice();
        const beforeActive = currentLayerId();
        const cmd = {
          label: 'delete group',
          do() {
            parent.children = parent.children.filter(c => c.id !== g.id);
            selectedNodeId = beforeActive;
          },
          undo() {
            parent.children = beforeChildren.slice();
            selectedNodeId = g.id;
            setSheetSelection(sheet, { layerId: beforeActive });
          },
        };
```

In `doMergeDown()`:
```js
    const parent = loc.parent;
    const beforeChildren = parent.children.slice();
    const beforeActive = state.activeLayerId;
    const destBefore = cloneBitmap(dest.bitmap);
    mergeDown(sheet, layer.id);
    const destAfter = cloneBitmap(dest.bitmap);
    const afterChildren = parent.children.slice();
    state.activeLayerId = dest.id;
    const afterActive = dest.id;
    const cmd = {
      label: 'merge down',
      do() {
        blitRegion(dest.bitmap, destAfter, 0, 0);
        parent.children = afterChildren.slice();
        state.activeLayerId = afterActive;
        selectedNodeId = afterActive;
      },
      undo() {
        parent.children = beforeChildren.slice();
        blitRegion(dest.bitmap, destBefore, 0, 0);
        state.activeLayerId = beforeActive;
        selectedNodeId = beforeActive;
      },
    };
```
becomes:
```js
    const parent = loc.parent;
    const beforeChildren = parent.children.slice();
    const beforeActive = currentLayerId();
    const destBefore = cloneBitmap(dest.bitmap);
    mergeDown(sheet, layer.id);
    const destAfter = cloneBitmap(dest.bitmap);
    const afterChildren = parent.children.slice();
    const afterActive = dest.id;
    setSheetSelection(sheet, { layerId: afterActive });
    const cmd = {
      label: 'merge down',
      do() {
        blitRegion(dest.bitmap, destAfter, 0, 0);
        parent.children = afterChildren.slice();
        setSheetSelection(sheet, { layerId: afterActive });
        selectedNodeId = afterActive;
      },
      undo() {
        parent.children = beforeChildren.slice();
        blitRegion(dest.bitmap, destBefore, 0, 0);
        setSheetSelection(sheet, { layerId: beforeActive });
        selectedNodeId = beforeActive;
      },
    };
```

Replace `selectGroupNode`:
```js
  function selectGroupNode(group) {
    selectedNodeId = group.id;
    state.activeLayerId = null;
    const animId = group.animationId ?? null;
    if (state.selectedAnimationId !== animId) { state.selectedAnimationId = animId; emit('selection'); }
    lastSyncedAnimationId = animId;
  }
```
with:
```js
  function selectGroupNode(group) {
    selectedNodeId = group.id;
    const sheet = activeSheet();
    const animId = group.animationId ?? null;
    const changed = currentAnimationId() !== animId;
    if (sheet) setSheetSelection(sheet, { layerId: null, animationId: animId });
    if (changed) emit('selection');
    lastSyncedAnimationId = animId;
  }
```

Replace `selectLayerNode`:
```js
  function selectLayerNode(layer) {
    const sheet = activeSheet();
    state.activeLayerId = layer.id;
    selectedNodeId = layer.id;
    const ctx = sheet ? layerAnimationContext(sheet, layer) : null;
    const animId = ctx?.anim.id ?? null;
    if (state.selectedAnimationId !== animId) { state.selectedAnimationId = animId; emit('selection'); }
    lastSyncedAnimationId = animId;
  }
```
with:
```js
  function selectLayerNode(layer) {
    const sheet = activeSheet();
    selectedNodeId = layer.id;
    const ctx = sheet ? layerAnimationContext(sheet, layer) : null;
    const animId = ctx?.anim.id ?? null;
    const changed = currentAnimationId() !== animId;
    if (sheet) setSheetSelection(sheet, { layerId: layer.id, animationId: animId });
    if (changed) emit('selection');
    lastSyncedAnimationId = animId;
  }
```

In `renderLayer(layer, depth)`, two lines:

`row.className = 'layer-row layer-leaf' + (layer.id === state.activeLayerId ? ' active' : '');` → `row.className = 'layer-row layer-leaf' + (layer.id === currentLayerId() ? ' active' : '');`

`if (layer.id !== state.activeLayerId) return;` → `if (layer.id !== currentLayerId()) return;`

Replace `syncFromAnimationSelection`:
```js
  function syncFromAnimationSelection(sheet) {
    if (state.selectedAnimationId === lastSyncedAnimationId) return;
    lastSyncedAnimationId = state.selectedAnimationId;
    if (state.selectedAnimationId) {
      const group = animationGroup(sheet, state.selectedAnimationId);
      if (group) { selectedNodeId = group.id; state.activeLayerId = null; return; }
    }
    selectedNodeId = state.activeLayerId;
  }
```
with:
```js
  function syncFromAnimationSelection(sheet) {
    const animId = currentAnimationId();
    if (animId === lastSyncedAnimationId) return;
    lastSyncedAnimationId = animId;
    if (animId) {
      const group = animationGroup(sheet, animId);
      if (group) { selectedNodeId = group.id; setSheetSelection(sheet, { layerId: null }); return; }
    }
    selectedNodeId = currentLayerId();
  }
```

In `renderList()`:
```js
    if (selectedNodeId && !findNode(sheet.layerTree, selectedNodeId)) {
      selectedNodeId = state.activeLayerId;
    }
```
becomes:
```js
    if (selectedNodeId && !findNode(sheet.layerTree, selectedNodeId)) {
      selectedNodeId = currentLayerId();
    }
```

(`renderMapLayer` and every other maps-branch in this file already use `host.selections`/`getEditorHost()` directly and are unchanged.)

### Step 5: `js/ui/tools.js`

Add an import and a module-level helper:

```js
import { state, on, emit, activeSheet, activeLayer, markDirty } from '../app/state.js';
import { getEditorHost } from '../host/runtime.js';
```

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Replace `acceptFloatingContextIfAny`:
```js
  function acceptFloatingContextIfAny() {
    const sheet = activeSheet();
    if (!sheet || !state.selectedAnimationId) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim && !anim.layerGroupId) commitAcceptAnimation(sheet, anim);
  }
```
with:
```js
  function acceptFloatingContextIfAny() {
    const sheet = activeSheet();
    if (!sheet) return;
    const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
    if (!animationId) return;
    const anim = sheet.animations.find(a => a.id === animationId);
    if (anim && !anim.layerGroupId) commitAcceptAnimation(sheet, anim);
  }
```

### Step 6: `js/ui/overlays.js`

Add an import and a module-level helper:

```js
import { state, activeSheet } from '../app/state.js';
import { getEditorHost } from '../host/runtime.js';
```

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

In `drawSpriteOverlays(view, ctx, sheet)`, replace:
```js
function drawSpriteOverlays(view, ctx, sheet) {
  const frames = sheet.frames;
  if (!frames.length) return;

  if (state.overlays.labels) {
    ctx.save();
    frames.forEach((f) => {
      const selected = f.id === state.selectedFrameId;
```
with:
```js
function drawSpriteOverlays(view, ctx, sheet) {
  const frames = sheet.frames;
  if (!frames.length) return;
  const selectedFrameId = getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null;

  if (state.overlays.labels) {
    ctx.save();
    frames.forEach((f) => {
      const selected = f.id === selectedFrameId;
```

### Step 7: `js/features/workbench/editor-workbench.js`

`getEditorHost` is already imported and `editorHost` is already a local variable in `mountEditorWorkbench()`, in scope where `sheetTargetRect` is defined. Add a module-level helper next to `isTypingTarget`:

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

In `sheetTargetRect(x, y)`, replace:
```js
    let run = (x != null && y != null) ? segmentOfPoint(sheet, anim, x, y)
      : state.selectedFrameId ? segmentOfFrame(anim, state.selectedFrameId) : null;
```
with:
```js
    const selectedFrameId = editorHost.selections.get(sheetDocument(sheet))?.frameId ?? null;
    let run = (x != null && y != null) ? segmentOfPoint(sheet, anim, x, y)
      : selectedFrameId ? segmentOfFrame(anim, selectedFrameId) : null;
```

### Step 8: `js/features/project/file-controller.js`

Add an import and a module-level helper:

```js
import { state, on, emit, activeSheet, activeMap, setProject, newDefaultProject, AUTOTEST, confirmOrAuto } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';
```

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Replace `runOnSelectedAnimation`:
```js
  function runOnSelectedAnimation(format) {
    const sheet = activeSheet();
    const anim = sheet?.animations.find(a => a.id === state.selectedAnimationId);
    if (sheet && anim) exportAnimationsAs(sheet, anim.id, format);
  }
```
with:
```js
  function runOnSelectedAnimation(format) {
    const sheet = activeSheet();
    const animationId = sheet ? (getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null) : null;
    const anim = sheet?.animations.find(a => a.id === animationId);
    if (sheet && anim) exportAnimationsAs(sheet, anim.id, format);
  }
```

Replace the `isEnabled` line of `document.exportAnimation`:
```js
    isEnabled: () => activeSheet()?.kind === 'sprite' && !!state.selectedAnimationId,
```
with:
```js
    isEnabled: () => {
      const sheet = activeSheet();
      return sheet?.kind === 'sprite' && !!getEditorHost().selections.get(sheetDocument(sheet))?.animationId;
    },
```

### Step 9: `js/modes/sprites/presentation/frame-tool-presenter.js`

`getEditorHost` is already imported. Add a module-level helper block right after the `dispatch()` helper:

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
function sheetSelection(sheet) {
  return getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
}
function setSheetSelection(sheet, patch) {
  getEditorHost().selections.set({ ...sheetSelection(sheet), ...patch }, sheetDocument(sheet));
}
```

In `handleDown(ev, view)`, replace:
```js
    const sel = selectedSegment(sheet, state.selectedFrameId);
```
with:
```js
    const sel = selectedSegment(sheet, sheetSelection(sheet).frameId ?? null);
```

Replace the double-click block:
```js
  if (clickHit && lastClick && lastClick.frameId === clickHit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    state.editingFrameId = clickHit.id;
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === clickHit.id)) ?? null;
    state.selectedAnimationId = owner ? owner.id : null;
    state.view = 'frame';
    emit('view');
    emit('selection');
    return;
  }
```
with:
```js
  if (clickHit && lastClick && lastClick.frameId === clickHit.id && now - lastClick.t < 350) {
    lastClick = null;
    drag = null;
    state.editingFrameId = clickHit.id;
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === clickHit.id)) ?? null;
    setSheetSelection(sheet, { animationId: owner ? owner.id : null });
    state.view = 'frame';
    emit('view');
    emit('selection');
    return;
  }
```

Replace:
```js
  const selected = sheet.frames.find(f => f.id === state.selectedFrameId) || null;
```
with:
```js
  const selected = sheet.frames.find(f => f.id === sheetSelection(sheet).frameId) || null;
```

Replace the frame-hit block:
```js
  const hit = frameAt(sheet, ev.x, ev.y);
  if (hit) {
    // Selecting a frame also selects its owning animation (or clears the
    // animation selection when the frame is standalone), so the timeline
    // and layers panel never keep a stale animation highlighted.
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === hit.id)) ?? null;
    const ownerId = owner ? owner.id : null;
    const frameChanged = state.selectedFrameId !== hit.id;
    const animChanged = state.selectedAnimationId !== ownerId;
    if (frameChanged) state.selectedFrameId = hit.id;
    if (animChanged) state.selectedAnimationId = ownerId;
    if (frameChanged || animChanged) emit('selection');
```
with:
```js
  const hit = frameAt(sheet, ev.x, ev.y);
  if (hit) {
    // Selecting a frame also selects its owning animation (or clears the
    // animation selection when the frame is standalone), so the timeline
    // and layers panel never keep a stale animation highlighted.
    const owner = sheet.animations.find(a => a.frames.some(af => af.frameId === hit.id)) ?? null;
    const ownerId = owner ? owner.id : null;
    const current = sheetSelection(sheet);
    const frameChanged = current.frameId !== hit.id;
    const animChanged = current.animationId !== ownerId;
    if (frameChanged || animChanged) setSheetSelection(sheet, { frameId: hit.id, animationId: ownerId });
    if (frameChanged || animChanged) emit('selection');
```

Replace the empty-click clear block:
```js
  if (state.selectedFrameId !== null || state.selectedAnimationId !== null) {
    state.selectedFrameId = null;
    state.selectedAnimationId = null;
    emit('selection');
  }
```
with:
```js
  const cleared = sheetSelection(sheet);
  if (cleared.frameId != null || cleared.animationId != null) {
    setSheetSelection(sheet, { frameId: null, animationId: null });
    emit('selection');
  }
```

In `updateHover(ev, view)`, replace both:
```js
      const sel = selectedSegment(sheet, state.selectedFrameId);
```
with:
```js
      const sel = selectedSegment(sheet, sheetSelection(sheet).frameId ?? null);
```
and:
```js
        const selectedFrame = sheet.frames.find(f => f.id === state.selectedFrameId);
```
with:
```js
        const selectedFrame = sheet.frames.find(f => f.id === sheetSelection(sheet).frameId);
```

Replace the Delete keydown handler's body:
```js
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripForFrame(sheet, state.selectedFrameId);
    if (strip) dispatch('sprites.removeStripMember', { sheetId: sheet.id, animationId: strip.id, frameId: state.selectedFrameId });
    else dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId: state.selectedFrameId });
```
with:
```js
    const sheet = activeSheet();
    if (!sheet) return;
    const frameId = sheetSelection(sheet).frameId ?? null;
    if (!frameId) return;
    const strip = stripForFrame(sheet, frameId);
    if (strip) dispatch('sprites.removeStripMember', { sheetId: sheet.id, animationId: strip.id, frameId });
    else dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId });
```

Replace the Enter keydown handler's body:
```js
    const sheet = activeSheet();
    if (!sheet || !state.selectedAnimationId) return;
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
    if (anim && !anim.layerGroupId) dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: anim.id });
```
with:
```js
    const sheet = activeSheet();
    if (!sheet) return;
    const animationId = sheetSelection(sheet).animationId ?? null;
    if (!animationId) return;
    const anim = sheet.animations.find(a => a.id === animationId);
    if (anim && !anim.layerGroupId) dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: anim.id });
```

Replace `drawStripChrome`:
```js
export function drawStripChrome(ctx, view) {
  if (state.mode !== 'sprites') return;
  paintStripChrome(ctx, view, activeSheet(), {
    tool: state.tool, drag, hover, selectedFrameId: state.selectedFrameId,
  });
}
```
with:
```js
export function drawStripChrome(ctx, view) {
  if (state.mode !== 'sprites') return;
  const sheet = activeSheet();
  paintStripChrome(ctx, view, sheet, {
    tool: state.tool, drag, hover, selectedFrameId: sheet ? (sheetSelection(sheet).frameId ?? null) : null,
  });
}
```

### Step 10: `js/modes/sprites/presentation/frames-panel.js`

Add an import and a module-level helper:

```js
import { state, on, emit, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
```

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Replace the `breakApartButton` click handler:
```js
  breakApartButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripForFrame(sheet, state.selectedFrameId);
    if (strip) dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: strip.id });
  });
```
with:
```js
  breakApartButton.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    const frameId = getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null;
    if (!frameId) return;
    const strip = stripForFrame(sheet, frameId);
    if (strip) dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: strip.id });
  });
```

In `render()`, replace:
```js
    const sheet = activeSheet();
    const frame = sheet?.frames.find(candidate => candidate.id === state.selectedFrameId) ?? null;
    if (!sheet) return;
```
with:
```js
    const sheet = activeSheet();
    const selectedFrameId = sheet ? (getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null) : null;
    const frame = sheet?.frames.find(candidate => candidate.id === selectedFrameId) ?? null;
    if (!sheet) return;
```

### Step 11: `js/modes/sprites/presentation/timeline-presenter.js`

`getEditorHost` is already imported. Add a module-level helper after the `dispatch()` helper:

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Inside `mountTimeline(el)`, right after the `invalidateFlat()` function and before `currentAnim()`, add:

```js
  function currentSelection() {
    const sheet = activeSheet();
    return sheet ? (getEditorHost().selections.get(sheetDocument(sheet)) ?? {}) : {};
  }
  function setSelection(patch) {
    const sheet = activeSheet();
    if (sheet) getEditorHost().selections.set({ ...currentSelection(), ...patch }, sheetDocument(sheet));
  }
```

Replace `currentAnim()`:
```js
  function currentAnim() {
    const sheet = activeSheet();
    if (!sheet) return null;
    return sheet.animations.find(a => a.id === state.selectedAnimationId) ?? null;
  }
```
with:
```js
  function currentAnim() {
    const sheet = activeSheet();
    if (!sheet) return null;
    return sheet.animations.find(a => a.id === currentSelection().animationId) ?? null;
  }
```

Replace the `animSelect` change handler:
```js
  animSelect.addEventListener('change', () => {
    const sheet = activeSheet();
    state.selectedAnimationId = animSelect.value || null;
    stopPlaying();
    position = 0; acc = 0;
    // Keep the active layer inside whatever context is now on screen -- see
    // commitNewStripFromFrame's matching comment in frames.js. Only reassign
    // when the current active layer doesn't already belong to the newly selected
    // context, so a deliberate in-context choice survives switching away and
    // back. contextLayers(sheet, null) (deselecting to "(none)") returns
    // every layer in the sheet, matching how a null selection is already
    // treated everywhere else -- so an in-context layer stays active rather
    // than being forced back to a root layer.
    if (sheet) {
      const layers = contextLayers(sheet, state.selectedAnimationId);
      if (!layers.some(l => l.id === state.activeLayerId)) state.activeLayerId = layers[0]?.id ?? null;
    }
    render();
    emit('selection');
  });
```
with:
```js
  animSelect.addEventListener('change', () => {
    const sheet = activeSheet();
    const animationId = animSelect.value || null;
    stopPlaying();
    position = 0; acc = 0;
    // Keep the active layer inside whatever context is now on screen -- see
    // commitNewStripFromFrame's matching comment in frames.js. Only reassign
    // when the current active layer doesn't already belong to the newly selected
    // context, so a deliberate in-context choice survives switching away and
    // back. contextLayers(sheet, null) (deselecting to "(none)") returns
    // every layer in the sheet, matching how a null selection is already
    // treated everywhere else -- so an in-context layer stays active rather
    // than being forced back to a root layer.
    if (sheet) {
      const layers = contextLayers(sheet, animationId);
      const layerId = currentSelection().layerId ?? null;
      const nextLayerId = layers.some(l => l.id === layerId) ? layerId : (layers[0]?.id ?? null);
      setSelection({ animationId, layerId: nextLayerId });
    }
    render();
    emit('selection');
  });
```

Replace `btnAddFrame`'s click handler:
```js
  btnAddFrame.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim || !state.selectedFrameId) return;
    dispatch('sprites.addAnimationFrame', { sheetId: sheet.id, animationId: anim.id, frameId: state.selectedFrameId });
  });
```
with:
```js
  btnAddFrame.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    const frameId = currentSelection().frameId ?? null;
    if (!sheet || !anim || !frameId) return;
    dispatch('sprites.addAnimationFrame', { sheetId: sheet.id, animationId: anim.id, frameId });
  });
```

Replace the strip cell's click handler:
```js
    cell.addEventListener('click', () => {
      scrubTo(index);
      // Clicking a cell also makes it the app-wide "current frame" (the
      // same selection the sprite sheet/Frames panel use), not just the
      // preview-playhead position -- so e.g. the Frames panel and the
      // sprite-sheet highlight follow along with a single click. It also
      // opens the frame editor directly on that frame (previously required
      // a double-click) -- one click both selects and jumps in.
      if (frame && state.selectedFrameId !== frame.id) {
        state.selectedFrameId = frame.id;
        emit('selection');
      }
      if (frame) {
        state.editingFrameId = frame.id;
        state.view = 'frame';
        emit('view');
      }
    });
```
with:
```js
    cell.addEventListener('click', () => {
      scrubTo(index);
      // Clicking a cell also makes it the app-wide "current frame" (the
      // same selection the sprite sheet/Frames panel use), not just the
      // preview-playhead position -- so e.g. the Frames panel and the
      // sprite-sheet highlight follow along with a single click. It also
      // opens the frame editor directly on that frame (previously required
      // a double-click) -- one click both selects and jumps in.
      if (frame && currentSelection().frameId !== frame.id) {
        setSelection({ frameId: frame.id });
        emit('selection');
      }
      if (frame) {
        state.editingFrameId = frame.id;
        state.view = 'frame';
        emit('view');
      }
    });
```

Replace `renderAnimSelect`'s tail:
```js
    // Only clear a STALE id (pointing at a deleted animation) -- never force
    // a selection just because it's null, or "(none)" could never stick:
    // render() runs after every project/selection event, so forcing a pick
    // here would snap back to animations[0] on the very next render.
    if (state.selectedAnimationId && !sheet.animations.find(a => a.id === state.selectedAnimationId))
      state.selectedAnimationId = null;
    animSelect.value = state.selectedAnimationId ?? '';
  }
```
with:
```js
    // Only clear a STALE id (pointing at a deleted animation) -- never force
    // a selection just because it's null, or "(none)" could never stick:
    // render() runs after every project/selection event, so forcing a pick
    // here would snap back to animations[0] on the very next render.
    const selectedAnimationId = currentSelection().animationId ?? null;
    if (selectedAnimationId && !sheet.animations.find(a => a.id === selectedAnimationId))
      setSelection({ animationId: null });
    animSelect.value = currentSelection().animationId ?? '';
  }
```

In `render()`, replace:
```js
    btnAddFrame.disabled = !anim || !state.selectedFrameId || !!anim.strip;
```
with:
```js
    btnAddFrame.disabled = !anim || !currentSelection().frameId || !!anim.strip;
```

### Step 12: `js/modes/sprites/presentation/animations-panel.js`

Add an import and a module-level helper:

```js
import { state, on, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
```

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

In `render()`, replace:
```js
    const sheet = activeSheet();
    currentAnim = sheet?.animations.find(a => a.id === state.selectedAnimationId) ?? null;
```
with:
```js
    const sheet = activeSheet();
    const animationId = sheet ? (getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null) : null;
    currentAnim = sheet?.animations.find(a => a.id === animationId) ?? null;
```

### Step 13: `js/modes/sprites/presentation/frame-editor-presenter.js`

Verify `getEditorHost` is already imported (it dispatches commands via it elsewhere in this file); if not, add `import { getEditorHost } from '../../../host/runtime.js';`. Add a module-level helper near the file's other small helpers:

```js
function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}
```

Replace, in `paintOnion(ctx, sheet, f)`:
```js
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId);
```
with:
```js
    const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
    const anim = sheet.animations.find(a => a.id === animationId);
```

Replace the neighbor-frame lookup:
```js
    const anim = sheet.animations.find(a => a.id === state.selectedAnimationId) ?? null;
```
with:
```js
    const animationId = getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null;
    const anim = sheet.animations.find(a => a.id === animationId) ?? null;
```

### Step 14: `js/modes/sprites/preview.js`

Replace the whole file:

```js
import { state, activeSheet, currentContextLayers } from '../../app/state.js';
import { flattenSheetLayers } from '../../core/model.js';
import { copyRegion } from '../../core/pixels.js';
import { getEditorHost } from '../../host/runtime.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function renderSpritePreview({ overrideLayers = null } = {}) {
  const sheet = activeSheet();
  if (!sheet) return { bitmap: null };
  const selection = getEditorHost().selections.get(sheetDocument(sheet)) ?? {};
  if (selection.animationId) return { managed: true };
  const layers = overrideLayers ?? currentContextLayers();
  const flat = flattenSheetLayers(layers, sheet.width, sheet.height, state.floating, sheet.id);
  const frameId = state.editingFrameId ?? selection.frameId ?? null;
  const frame = sheet.frames.find(candidate => candidate.id === frameId);
  return { bitmap: frame ? copyRegion(flat, frame.x, frame.y, frame.w, frame.h) : flat };
}
```

(`renderSpritePreview` is only ever registered for `sprites.preview`, gated to `modeId === 'sprites'` in `contributions.js`, so `activeSheet()` returning a real sprite sheet whenever this runs is guaranteed — reordering the `!sheet` check ahead of the `animationId` check is safe.)

### Step 15: `js/modes/sprites/contributions.js`

Replace:
```js
function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history }; }
```
with:
```js
function services() { const host = getEditorHost(); return { projects: host.projects, history: host.history, selections: host.selections }; }
```

### Step 16: `js/modes/sprites/application/commands/frame-commands.js`

Replace the whole file:

```js
import { addFrame, removeFrame } from '../../../../core/model.js';
import { sliceGrid } from '../../../../core/slicing.js';
import { blitRegion } from '../../../../core/pixels.js';
import { emit, markDirty } from '../../../../app/state.js';
import { stripLayersOf, buildMovePatches } from '../frame-pixel-motion.js';

export function findSpriteSheet(project, sheetId) {
  return project?.sheets.find(sheet => sheet.id === sheetId) ?? null;
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

// Every history step re-enters projects.mutate() so the host store gets a
// fresh transaction + dirty flag on do AND undo; markDirty() keeps the legacy
// title-bar/unsaved-changes guard in sync until Phase 4 unifies them.
export function runSheetCommand(services, sheetId, label, apply, revert) {
  const command = {
    label,
    do: () => services.projects.mutate(label, project => apply(findSpriteSheet(project, sheetId), project)),
    undo: () => services.projects.mutate(label, project => revert(findSpriteSheet(project, sheetId), project)),
  };
  services.history.execute(command);
  markDirty();
}

export function createFrame(services, sheetId, rect) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const doc = sheetDocument(sheet);
  const name = `frame_${sheet.frames.length}`;
  let created = null;
  runSheetCommand(services, sheetId, 'add frame',
    target => {
      if (!created) created = addFrame(target, { name, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      else if (!target.frames.includes(created)) target.frames.push(created);
      services.selections.set({ ...services.selections.get(doc), frameId: created.id }, doc);
    },
    target => {
      target.frames = target.frames.filter(f => f !== created);
      if (services.selections.get(doc)?.frameId === created.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    });
  emit('selection');
}

// Shared by the keyboard Delete handler and the frames panel's Delete button.
export function deleteFrame(services, sheetId, frameId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!frame) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.frames.indexOf(frame);
  // removeFrame rewrites EVERY animation's entries/breaks, so undo needs a
  // snapshot of all of them, not just the ones referencing this frame.
  const animSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = services.selections.get(doc)?.frameId === frameId;
  runSheetCommand(services, sheetId, 'delete frame',
    target => {
      removeFrame(target, frame.id);
      if (services.selections.get(doc)?.frameId === frame.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    },
    target => {
      target.frames.splice(Math.min(idx, target.frames.length), 0, frame);
      for (const snap of animSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), frameId: frame.id }, doc);
    });
  emit('selection');
}

export function resizeFrame(services, sheetId, frameId, before, after) {
  const frame = findSpriteSheet(services.projects.project, sheetId)?.frames.find(f => f.id === frameId);
  if (!frame) return;
  runSheetCommand(services, sheetId, 'resize frame',
    () => { frame.x = after.x; frame.y = after.y; frame.w = after.w; frame.h = after.h; },
    () => { frame.x = before.x; frame.y = before.y; frame.w = before.w; frame.h = before.h; });
}

// Frames are viewports onto the sheet, so dragging a PLAIN frame or a still-
// FLOATING strip is metadata-only. An ACCEPTED strip owns its own layers, so
// its frames carry their pixels with them instead of leaving them behind.
export function moveFrames(services, sheetId, frameIds, dx, dy, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet || (dx === 0 && dy === 0)) return;
  const frames = frameIds.map(id => sheet.frames.find(f => f.id === id)).filter(Boolean);
  if (!frames.length) return;
  const anim = animationId ? sheet.animations.find(a => a.id === animationId) ?? null : null;
  const label = frames.length > 1 ? 'move strip' : 'move frame';
  const layers = stripLayersOf(sheet, anim);

  if (!layers) {
    const coords = frames.map(f => ({ frame: f, x: f.x, y: f.y }));
    runSheetCommand(services, sheetId, label,
      () => { for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; } },
      () => { for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; } });
    return;
  }

  const { patches, ur, beforeCoords, afterCoords } = buildMovePatches(frames, dx, dy, layers);
  runSheetCommand(services, sheetId, label,
    () => {
      for (const p of patches) blitRegion(p.layer.bitmap, p.after, ur.x, ur.y);
      for (const c of afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    },
    () => {
      for (const p of patches) blitRegion(p.layer.bitmap, p.before, ur.x, ur.y);
      for (const c of beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
    });
}

// Slice-grid dialog's Create action, minus the DOM reads. `options` carries
// cellW/cellH/marginX/marginY/spacingX/spacingY/namePrefix already clamped by
// the dialog; sheetWidth/sheetHeight come from the sheet itself.
export function sliceSheetIntoFrames(services, sheetId, options, replace) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const newFrames = sliceGrid({ sheetWidth: sheet.width, sheetHeight: sheet.height, ...options });

  const beforeFrames = sheet.frames.slice();
  const beforeAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));
  if (replace) {
    sheet.frames = [];
    for (const a of sheet.animations) { a.frames = []; a.breaks = []; }
  }
  for (const nf of newFrames) addFrame(sheet, nf);
  const afterFrames = sheet.frames.slice();
  const afterAnimSnapshots = sheet.animations.map(a => ({ anim: a, frames: a.frames.slice(), breaks: (a.breaks ?? []).slice() }));

  runSheetCommand(services, sheetId, 'slice grid',
    target => {
      target.frames = afterFrames.slice();
      for (const snap of afterAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
    },
    target => {
      target.frames = beforeFrames.slice();
      for (const snap of beforeAnimSnapshots) { snap.anim.frames = snap.frames.slice(); snap.anim.breaks = snap.breaks.slice(); }
    });
}
```

### Step 17: `js/modes/sprites/application/commands/animation-commands.js`

Replace the whole file:

```js
import { acceptAnimation as acceptAnimationOnSheet } from '../../../../core/model.js';
import { emit, activeSheet } from '../../../../app/state.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function findAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  return { sheet, animation: sheet?.animations.find(a => a.id === animationId) ?? null };
}

// Break apart = the animation keeps its frame entries but stops owning frame
// geometry: members move individually and become resizable again.
export function breakApartStrip(services, sheetId, animationId) {
  const { animation } = findAnimation(services, sheetId, animationId);
  if (!animation) return;
  const beforeBreaks = (animation.breaks ?? []).slice();
  runSheetCommand(services, sheetId, 'break apart strip',
    () => { animation.strip = false; animation.breaks = []; },
    () => { animation.strip = true; animation.breaks = beforeBreaks.slice(); });
}

// Promotes a floating animation into a committed one by freezing whatever is
// currently visible under its own frames into a brand-new layer group.
// core/model.js's acceptAnimation runs eagerly here; the pushed command's
// do() re-applies it idempotently.
export function acceptAnimation(services, sheetId, animationId) {
  const { sheet, animation } = findAnimation(services, sheetId, animationId);
  if (!sheet || !animation) return;
  if (animation.layerGroupId) return;
  const doc = sheetDocument(sheet);
  const beforeActiveLayerId = services.selections.get(doc)?.layerId ?? null;
  const group = acceptAnimationOnSheet(sheet, animation);
  const animationLayerId = group.children[0].id;
  const groupIndex = sheet.layerTree.children.indexOf(group);

  runSheetCommand(services, sheetId, 'accept animation',
    target => {
      animation.layerGroupId = group.id;
      if (!target.layerTree.children.includes(group)) {
        target.layerTree.children.splice(Math.min(groupIndex, target.layerTree.children.length), 0, group);
      }
      if (target === activeSheet()) services.selections.set({ ...services.selections.get(doc), layerId: animationLayerId }, doc);
    },
    target => {
      animation.layerGroupId = null;
      target.layerTree.children = target.layerTree.children.filter(child => child !== group);
      if (services.selections.get(doc)?.layerId === animationLayerId) services.selections.set({ ...services.selections.get(doc), layerId: beforeActiveLayerId }, doc);
    });
  emit('selection');
}
```

### Step 18: `js/modes/sprites/application/commands/animation-lifecycle-commands.js`

Replace the whole file:

```js
// js/modes/sprites/application/commands/animation-lifecycle-commands.js
import { addAnimation, renameAnimation as renameAnimationOnSheet, findParent } from '../../../../core/model.js';
import { activeSheet } from '../../../../app/state.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

// A new animation starts FLOATING (see addAnimation/acceptAnimation in
// core/model.js) -- no layer group until accepted, and it has zero frames at
// creation. Mirrors strip-commands.js's newStripFromFrame: "only touch
// selection while this command's own sheet is the one on screen" (state.commands
// is a single global stack shared by every sheet), and the idx-remembered-at-
// undo-time bookkeeping so a later redo reinserts at the same spot.
export function newAnimation(services, sheetId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const doc = sheetDocument(sheet);
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  runSheetCommand(services, sheetId, 'new animation',
    target => {
      if (!anim) { anim = addAnimation(target, name, false, services.projects.project?.settings); idx = target.animations.indexOf(anim); }
      else if (!target.animations.includes(anim)) target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (target === activeSheet()) services.selections.set({ ...services.selections.get(doc), animationId: anim.id }, doc);
    },
    target => {
      idx = target.animations.indexOf(anim);
      target.animations = target.animations.filter(a => a !== anim);
      if (services.selections.get(doc)?.animationId === anim.id) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    });
}

// Deleting an animation also tears down its layer group (if it was accepted)
// -- captured once outside the command so undo can restore both the
// animation and the group at their original positions.
export function deleteAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const doc = sheetDocument(sheet);
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = services.selections.get(doc)?.animationId === animationId;
  const groupLoc = anim.layerGroupId ? findParent(sheet.layerTree, anim.layerGroupId) : null;
  const group = groupLoc ? groupLoc.parent.children[groupLoc.index] : null;
  const groupParent = groupLoc ? groupLoc.parent : null;
  const groupIdx = groupLoc ? groupLoc.index : -1;
  runSheetCommand(services, sheetId, 'delete animation',
    target => {
      target.animations = target.animations.filter(a => a.id !== animationId);
      if (groupParent) groupParent.children = groupParent.children.filter(c => c.id !== anim.layerGroupId);
      anim.layerGroupId = null;
      if (services.selections.get(doc)?.animationId === animationId) services.selections.set({ ...services.selections.get(doc), animationId: null }, doc);
    },
    target => {
      target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (groupParent) groupParent.children.splice(Math.min(groupIdx, groupParent.children.length), 0, group);
      anim.layerGroupId = group.id;
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), animationId }, doc);
    });
}

export function renameAnimation(services, sheetId, animationId, name) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const before = anim.name;
  if (before === name) return;
  runSheetCommand(services, sheetId, 'rename animation',
    target => renameAnimationOnSheet(target, animationId, name),
    target => renameAnimationOnSheet(target, animationId, before));
}

export function toggleAnimationLoop(services, sheetId, animationId, loop) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const before = anim.loop;
  if (before === loop) return;
  runSheetCommand(services, sheetId, 'toggle animation loop',
    () => { anim.loop = loop; },
    () => { anim.loop = before; });
}

// No before/after equality guard here -- matches js/ui/animpanel.js's
// commitBaseDuration exactly, which always pushes a command even when
// nothing actually changed (buildBaseDurationControl only calls setValue on
// a real user commit, so this hasn't needed a guard in practice).
export function setAnimationBaseDuration(services, sheetId, animationId, before, after) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  runSheetCommand(services, sheetId, 'edit base duration',
    () => { anim.baseDuration = after.durationMs; anim.baseFps = after.baseFps; anim.baseStep = after.baseStep; },
    () => { anim.baseDuration = before.durationMs; anim.baseFps = before.baseFps; anim.baseStep = before.baseStep; });
}
```

### Step 19: `js/modes/sprites/application/commands/strip-commands.js`

Replace the whole file:

```js
import { addFrame, removeFrame, addAnimation, animationGroup } from '../../../../core/model.js';
import { createBitmap, copyRegion, blitRegion } from '../../../../core/pixels.js';
import {
  segmentsOf, segmentOfFrame, segmentMembers,
  insertEntry, removeEntry, mergeSegments, transferSegment, normalizeBreaks,
} from '../../../../core/strips.js';
import { frameBounds } from '../../../../domain/sprites/frames.js';
import { emit, activeSheet, currentContextLayers } from '../../../../app/state.js';
import { stripLayersOf, buildMovePatches } from '../frame-pixel-motion.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function resolve(services, sheetId, animationId, runIndex) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId) ?? null;
  const run = anim && runIndex != null ? segmentsOf(anim)[runIndex] ?? null : null;
  return { sheet, anim, run };
}

function defaultDuration(services) {
  return services.projects.project?.settings?.durationMs ?? 100;
}

// Word-style insert-column at boundary k of a segment (0=before first,
// n=after last): the tail shifts right one frame width (pixel-carrying), a
// blank frame fills the gap, an animation entry lands at the matching order
// index with its neighbor's duration.
export function insertStripFrame(services, sheetId, animationId, runIndex, k) {
  const { sheet, anim, run } = resolve(services, sheetId, animationId, runIndex);
  if (!sheet || !anim || !run) return;
  const doc = sheetDocument(sheet);
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const fw = members[0].w, fh = members[0].h;
  const b = frameBounds(members);
  if (b.x + b.w + fw > sheet.width) return;
  const index = run.start + k;
  const attachLeft = k === members.length;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();

  const tail = members.slice(k);
  // ASSUMES sheetId === state.activeSheetId -- currentContextLayers() reads
  // the ACTIVE sheet, not the sheetId this handler was dispatched with.
  // Callers must ensure they match; see final-review finding for context.
  const mv = tail.length ? buildMovePatches(tail, fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
  const frame = addFrame(sheet, {
    name: `${anim.name}_${anim.frames.length}`,
    x: b.x + k * fw, y: b.y, w: fw, h: fh,
  });
  const duration = beforeEntries[index - 1]?.duration ?? beforeEntries[index]?.duration ?? defaultDuration(services);
  const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, attachLeft);
  anim.frames = r.entries;
  anim.breaks = r.breaks;

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();

  runSheetCommand(services, sheetId, 'insert frame',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      services.selections.set({ ...services.selections.get(doc), frameId: frame.id }, doc);
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      if (services.selections.get(doc)?.frameId === frame.id) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    });
  emit('selection');
}

// Split = add a break. Nothing moves; the dashed separator marks the cut
// until one side is dragged away.
export function splitStrip(services, sheetId, animationId, index) {
  const { anim } = resolve(services, sheetId, animationId, null);
  if (!anim) return;
  const before = (anim.breaks ?? []).slice();
  const after = normalizeBreaks([...before, index], anim.frames.length);
  if (after.length === before.length) return;
  runSheetCommand(services, sheetId, 'split strip',
    () => { anim.breaks = after.slice(); },
    () => { anim.breaks = before.slice(); });
}

// Resize = add/remove whole frames at the dragged end. Grow appends blank
// frames (right: rightward; left: leftward, prepended in order) -- always a
// pure array operation, no pixel effects. Shrink removes frames + entries
// from that end and, once the strip is accepted (has its own layer), also
// clears the removed frame's own pixels from it: each strip owns its own
// layer, so there's no shared underlying sheet art left to preserve for a
// future regrow. A floating strip has no layer yet, so shrink stays
// pixel-free too. Neighbor's duration is copied.
export function resizeStripSegment(services, sheetId, animationId, runIndex, side, count) {
  const { sheet, anim, run } = resolve(services, sheetId, animationId, runIndex);
  if (!sheet || !anim || !run) return;
  const doc = sheetDocument(sheet);
  const members = segmentMembers(sheet, anim, run);
  if (!members.length) return;
  const count0 = members.length;
  if (count === count0) return;
  const fw = members[0].w, fh = members[0].h;
  const bbox = frameBounds(members);
  let delta = count - count0;
  if (delta > 0) {
    // Bounds-clamp the grow: mirrors insertStripFrame's sheet.width refusal
    // guard, but clamps to what fits rather than refusing outright (this is
    // a variable-count drag-driven grow, unlike insertStripFrame's fixed
    // single-frame insert, so partial fulfillment is meaningful). Strips are
    // horizontal-only here (no sheet.height counterpart exists in this file).
    const room = side === 'right' ? sheet.width - (bbox.x + bbox.w) : bbox.x;
    const maxGrow = Math.max(0, Math.floor(room / fw));
    if (maxGrow === 0) return;
    delta = Math.min(delta, maxGrow);
  }

  const beforeSheetFrames = sheet.frames.slice();
  const beforeEntries = anim.frames.map(e => ({ ...e }));
  const beforeBreaks = (anim.breaks ?? []).slice();
  const beforeSelected = services.selections.get(doc)?.frameId ?? null;
  const neighbor = side === 'right' ? anim.frames[run.end - 1] : anim.frames[run.start];
  const duration = neighbor?.duration ?? defaultDuration(services);

  const group = anim.layerGroupId ? animationGroup(sheet, anim.id) : null;
  const layer = group ? group.children[0] : null;
  const clearPatches = [];

  if (delta > 0) {
    for (let j = 0; j < delta; j++) {
      const x = side === 'right' ? bbox.x + bbox.w + j * fw : bbox.x - (j + 1) * fw;
      const frame = addFrame(sheet, {
        name: `${anim.name}_${anim.frames.length}`, x, y: bbox.y, w: fw, h: fh,
      });
      const index = side === 'right' ? run.end + j : run.start;
      const r = insertEntry(anim.frames, anim.breaks, index, { frameId: frame.id, duration }, side === 'right');
      anim.frames = r.entries;
      anim.breaks = r.breaks;
    }
  } else {
    for (let j = 0; j < -delta; j++) {
      const index = side === 'right' ? run.end - 1 - j : run.start;
      const frameId = anim.frames[index].frameId;
      const frame = sheet.frames.find(f => f.id === frameId);
      if (layer && frame) {
        clearPatches.push({ x: frame.x, y: frame.y, before: copyRegion(layer.bitmap, frame.x, frame.y, fw, fh) });
      }
      sheet.frames = sheet.frames.filter(f => f.id !== frameId);
      const r = removeEntry(anim.frames, anim.breaks, index);
      anim.frames = r.entries;
      anim.breaks = r.breaks;
      if (services.selections.get(doc)?.frameId === frameId) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    }
    if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
  }

  const afterSheetFrames = sheet.frames.slice();
  const afterEntries = anim.frames.map(e => ({ ...e }));
  const afterBreaks = anim.breaks.slice();
  const afterSelected = services.selections.get(doc)?.frameId ?? null;

  runSheetCommand(services, sheetId, 'resize strip',
    target => {
      target.frames = afterSheetFrames.slice();
      anim.frames = afterEntries.map(e => ({ ...e }));
      anim.breaks = afterBreaks.slice();
      services.selections.set({ ...services.selections.get(doc), frameId: afterSelected }, doc);
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, createBitmap(fw, fh), p.x, p.y);
    },
    target => {
      target.frames = beforeSheetFrames.slice();
      anim.frames = beforeEntries.map(e => ({ ...e }));
      anim.breaks = beforeBreaks.slice();
      services.selections.set({ ...services.selections.get(doc), frameId: beforeSelected }, doc);
      if (layer) for (const p of clearPatches) blitRegion(layer.bitmap, p.before, p.x, p.y);
    });
  emit('selection');
}

// Delete on a strip member removes the frame AND closes the gap: the rest of
// its segment shifts left one frame width. removeFrame keeps every
// animation's entries/breaks consistent; snapshots cover them all for undo.
export function removeStripMember(services, sheetId, animationId, frameId) {
  const { sheet, anim } = resolve(services, sheetId, animationId, null);
  if (!sheet || !anim) return;
  const doc = sheetDocument(sheet);
  const run = segmentOfFrame(anim, frameId);
  if (!run) return;
  const members = segmentMembers(sheet, anim, run);
  const index = anim.frames.findIndex(e => e.frameId === frameId);
  const k = index - run.start;
  const fw = members[0].w;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));
  const wasSelected = services.selections.get(doc)?.frameId === frameId;

  const tail = members.slice(k + 1);
  // ASSUMES sheetId === state.activeSheetId -- currentContextLayers() reads
  // the ACTIVE sheet, not the sheetId this handler was dispatched with.
  // Callers must ensure they match; see final-review finding for context.
  const mv = tail.length ? buildMovePatches(tail, -fw, 0, stripLayersOf(sheet, anim) ?? currentContextLayers()) : null;
  removeFrame(sheet, frameId);

  const afterSheetFrames = sheet.frames.slice();
  const afterAnims = sheet.animations.map(a => ({ anim: a, frames: a.frames.map(e => ({ ...e })), breaks: (a.breaks ?? []).slice() }));

  runSheetCommand(services, sheetId, 'remove strip frame',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = afterSheetFrames.slice();
      for (const s of afterAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (services.selections.get(doc)?.frameId === frameId) services.selections.set({ ...services.selections.get(doc), frameId: null }, doc);
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      target.frames = beforeSheetFrames.slice();
      for (const s of beforeAnims) { s.anim.frames = s.frames.map(e => ({ ...e })); s.anim.breaks = s.breaks.slice(); }
      if (wasSelected) services.selections.set({ ...services.selections.get(doc), frameId }, doc);
    });
  emit('selection');
}

// Snap-merge: one undoable command = reposition of the dragged members +
// order/breaks rewrite (+ possible source-animation deletion). Whole-array
// snapshots keep do()/undo() idempotent per the codebase idiom.
export function mergeStripSegments(services, sheetId, animationId, runIndex, targetAnimationId, targetRunIndex, side, dx, dy) {
  const { sheet, anim: srcAnim, run: srcRun } = resolve(services, sheetId, animationId, runIndex);
  const { anim: dstAnim, run: dstRun } = resolve(services, sheetId, targetAnimationId, targetRunIndex);
  if (!sheet || !srcAnim || !dstAnim || !srcRun || !dstRun) return;
  const doc = sheetDocument(sheet);
  const members = segmentMembers(sheet, srcAnim, srcRun);
  if (!members.length) return;
  const sameAnim = srcAnim === dstAnim;
  const before = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: (srcAnim.breaks ?? []).slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: (dstAnim.breaks ?? []).slice(),
    animations: sheet.animations.slice(),
    selectedAnimationId: services.selections.get(doc)?.animationId ?? null,
  };
  // findSnap only ever offers same-strip targets now (cross-animation
  // merging is disabled), so this is always same-strip pixel motion when the
  // strip is accepted; stripLayersOf returns null for a floating strip,
  // falling back to a metadata-only reposition.
  const layers = stripLayersOf(sheet, srcAnim);
  const mv = layers ? buildMovePatches(members, dx, dy, layers) : null;
  const coords = mv ? null : members.map(f => ({ frame: f, x: f.x, y: f.y }));
  if (!mv) for (const f of members) { f.x += dx; f.y += dy; }
  if (sameAnim) {
    const r = mergeSegments(srcAnim, srcRun.index, dstRun.index, side);
    srcAnim.frames = r.frames; srcAnim.breaks = r.breaks;
  } else {
    const r = transferSegment(srcAnim, dstAnim, srcRun.index, dstRun.index, side);
    srcAnim.frames = r.src.frames; srcAnim.breaks = r.src.breaks;
    dstAnim.frames = r.dst.frames; dstAnim.breaks = r.dst.breaks;
    if (srcAnim.frames.length === 0)
      sheet.animations = sheet.animations.filter(a => a !== srcAnim);
  }
  const after = {
    srcFrames: srcAnim.frames.map(e => ({ ...e })), srcBreaks: srcAnim.breaks.slice(),
    dstFrames: dstAnim.frames.map(e => ({ ...e })), dstBreaks: dstAnim.breaks.slice(),
    animations: sheet.animations.slice(),
  };

  runSheetCommand(services, sheetId, 'merge strips',
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.after, mv.ur.x, mv.ur.y);
        for (const c of mv.afterCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x + dx; c.frame.y = c.y + dy; }
      }
      srcAnim.frames = after.srcFrames.map(e => ({ ...e })); srcAnim.breaks = after.srcBreaks.slice();
      dstAnim.frames = after.dstFrames.map(e => ({ ...e })); dstAnim.breaks = after.dstBreaks.slice();
      target.animations = after.animations.slice();
      services.selections.set({ ...services.selections.get(doc), animationId: dstAnim.id }, doc);
    },
    target => {
      if (mv) {
        for (const p of mv.patches) blitRegion(p.layer.bitmap, p.before, mv.ur.x, mv.ur.y);
        for (const c of mv.beforeCoords) { c.frame.x = c.x; c.frame.y = c.y; }
      } else {
        for (const c of coords) { c.frame.x = c.x; c.frame.y = c.y; }
      }
      srcAnim.frames = before.srcFrames.map(e => ({ ...e })); srcAnim.breaks = before.srcBreaks.slice();
      dstAnim.frames = before.dstFrames.map(e => ({ ...e })); dstAnim.breaks = before.dstBreaks.slice();
      target.animations = before.animations.slice();
      services.selections.set({ ...services.selections.get(doc), animationId: before.selectedAnimationId }, doc);
    });
  emit('selection');
}

// Dragging a standalone (non-strip) frame's own edge grip promotes it into a
// brand-new intact-strip animation: the frame itself becomes member 0 (kept
// at its own id/position -- never duplicated), renamed to match the new
// strip, and `count - 1` additional blank frames are appended in the dragged
// direction, exactly like growing an existing strip via the grip.
export function newStripFromFrame(services, sheetId, frameId, side, count) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const frame = sheet?.frames.find(f => f.id === frameId);
  if (!sheet || !frame) return;
  const doc = sheetDocument(sheet);
  let extra = count - 1;
  if (extra <= 0) return;
  const fw = frame.w, fh = frame.h;
  // Bounds-clamp the grow: mirrors resizeStripSegment's grow-side clamp (see
  // that comment for rationale) so a promoted strip never places frames off
  // the sheet edge. Horizontal-only, like the rest of this file.
  const room = side === 'right' ? sheet.width - (frame.x + fw) : frame.x;
  const maxExtra = Math.max(0, Math.floor(room / fw));
  if (maxExtra === 0) return;
  extra = Math.min(extra, maxExtra);
  const duration = defaultDuration(services);
  const name = `strip_${sheet.animations.length}`;

  const beforeSheetFrames = sheet.frames.slice();
  const beforeAnimations = sheet.animations.slice();
  const beforeFrameName = frame.name;
  const beforeSelectedAnimationId = services.selections.get(doc)?.animationId ?? null;

  const anim = addAnimation(sheet, name, true, services.projects.project?.settings);
  frame.name = `${name}_0`;
  const entries = [{ frameId: frame.id, duration }];
  for (let j = 0; j < extra; j++) {
    const x = side === 'right' ? frame.x + (j + 1) * fw : frame.x - (j + 1) * fw;
    const nf = addFrame(sheet, { name: `${name}_${j + 1}`, x, y: frame.y, w: fw, h: fh });
    if (side === 'right') entries.push({ frameId: nf.id, duration });
    else entries.unshift({ frameId: nf.id, duration });
  }
  anim.frames = entries;

  const afterSheetFrames = sheet.frames.slice();
  const afterAnimations = sheet.animations.slice();
  const afterAnimFrames = anim.frames.map(e => ({ ...e }));
  const afterFrameName = frame.name;
  const animId = anim.id;

  runSheetCommand(services, sheetId, 'new strip from frame',
    target => {
      target.frames = afterSheetFrames.slice();
      target.animations = afterAnimations.slice();
      anim.frames = afterAnimFrames.map(e => ({ ...e }));
      frame.name = afterFrameName;
      if (target === activeSheet()) {
        services.selections.set({ ...services.selections.get(doc), frameId, animationId: animId }, doc);
      }
    },
    target => {
      target.frames = beforeSheetFrames.slice();
      target.animations = beforeAnimations.slice();
      frame.name = beforeFrameName;
      services.selections.set({ ...services.selections.get(doc), frameId, animationId: beforeSelectedAnimationId }, doc);
    });
  emit('selection');
}
```

### Step 20: Update the 4 sprite command test files

Each of these 4 files needs the same two changes: (1) `makeServices()` gains `selections: new SelectionService(store)`, requiring a new import; (2) every assertion against `state.selectedFrameId`/`state.activeLayerId`/`state.selectedAnimationId` is rewritten to read `services.selections.get({ kind: 'sprite-sheet', id: 'sheet1' })?.<field>` instead (all 4 files use `'sheet1'` as their sole sheet id).

**`tests/sprite-frame-commands.test.mjs`**: add `import { SelectionService } from '../js/host/selection-service.js';` after the existing imports; change `makeServices`:
```js
function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }), selections: new SelectionService(store), stack };
}
```
change `reset()`:
```js
function reset() { state.commands = new CommandStack(); state.dirty = false; }
```
In the `'createFrame adds a frame...'` test, replace:
```js
  const id = sheet.frames[0].id;
  assert.equal(state.selectedFrameId, id);
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.frames.length, 0);
  assert.equal(state.selectedFrameId, null);

  services.history.redo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, id);
  assert.equal(state.selectedFrameId, id);
```
with:
```js
  const id = sheet.frames[0].id;
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  assert.equal(services.selections.get(doc)?.frameId, id);
  assert.equal(services.store.getState().project.dirty, true);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.frames.length, 0);
  assert.equal(services.selections.get(doc)?.frameId, null);

  services.history.redo();
  assert.equal(sheet.frames.length, 1);
  assert.equal(sheet.frames[0].id, id);
  assert.equal(services.selections.get(doc)?.frameId, id);
```

**`tests/sprite-animation-commands.test.mjs`**: add the `SelectionService` import; change `makeServices`:
```js
function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }), selections: new SelectionService(store) };
}
```
change `reset(project)`:
```js
function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
}
```
In the `'acceptAnimation gives a floating animation...'` test, replace:
```js
  acceptAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.layerTree.children.length, 1);
  const group = sheet.layerTree.children[0];
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(group.animationId, 'an1');
  assert.equal(state.activeLayerId, group.children[0].id);

  services.history.undo();
  assert.equal(anim.layerGroupId, null);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(state.activeLayerId, null);

  services.history.redo();
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(sheet.layerTree.children[0], group);
```
with:
```js
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  acceptAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.layerTree.children.length, 1);
  const group = sheet.layerTree.children[0];
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(group.animationId, 'an1');
  assert.equal(services.selections.get(doc)?.layerId, group.children[0].id);

  services.history.undo();
  assert.equal(anim.layerGroupId, null);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(services.selections.get(doc)?.layerId, null);

  services.history.redo();
  assert.equal(anim.layerGroupId, group.id);
  assert.equal(sheet.layerTree.children[0], group);
```

**`tests/sprite-animation-lifecycle-commands.test.mjs`**: add the `SelectionService` import; change `makeServices`:
```js
function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }), selections: new SelectionService(store) };
}
```
change `reset(project)`:
```js
function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
}
```
(drops the `state.selectedAnimationId = null;` line — nothing seeds it now, `services.selections.get(doc)` naturally returns `null` until something sets it).

In `'newAnimation names by animation count...'`, replace:
```js
  newAnimation(services, 'sheet1');
  assert.equal(sheet.animations.length, 2);
  const created = sheet.animations[1];
  assert.equal(created.name, 'anim_1');
  assert.equal(state.selectedAnimationId, created.id);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(state.selectedAnimationId, null);
```
with:
```js
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  newAnimation(services, 'sheet1');
  assert.equal(sheet.animations.length, 2);
  const created = sheet.animations[1];
  assert.equal(created.name, 'anim_1');
  assert.equal(services.selections.get(doc)?.animationId, created.id);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(services.selections.get(doc)?.animationId, null);
```

In `'deleteAnimation removes the animation...'`, replace:
```js
  const group = { id: 'g1', type: 'group', name: 'walk', animationId: 'an1', open: true, children: [] };
  sheet.layerTree.children.push(group);
  sheet.animations[0].layerGroupId = 'g1';
  state.selectedAnimationId = 'an1';

  deleteAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.animations.length, 0);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(state.selectedAnimationId, null);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(sheet.animations[0].id, 'an1');
  assert.equal(sheet.animations[0].layerGroupId, 'g1');
  assert.equal(sheet.layerTree.children[0].id, 'g1');
  assert.equal(state.selectedAnimationId, 'an1');
```
with:
```js
  const doc = { kind: 'sprite-sheet', id: 'sheet1' };
  const group = { id: 'g1', type: 'group', name: 'walk', animationId: 'an1', open: true, children: [] };
  sheet.layerTree.children.push(group);
  sheet.animations[0].layerGroupId = 'g1';
  services.selections.set({ animationId: 'an1' }, doc);

  deleteAnimation(services, 'sheet1', 'an1');
  assert.equal(sheet.animations.length, 0);
  assert.equal(sheet.layerTree.children.length, 0);
  assert.equal(services.selections.get(doc)?.animationId, null);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(sheet.animations[0].id, 'an1');
  assert.equal(sheet.animations[0].layerGroupId, 'g1');
  assert.equal(sheet.layerTree.children[0].id, 'g1');
  assert.equal(services.selections.get(doc)?.animationId, 'an1');
```

**`tests/sprite-strip-commands.test.mjs`**: add the `SelectionService` import; change `makeServices`:
```js
function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }), selections: new SelectionService(store) };
}
```
change `reset(project)`:
```js
function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
}
```
In `'insertStripFrame inserts a blank frame...'`, replace:
```js
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 32);
  assert.equal(state.selectedFrameId, inserted.id);
```
with:
```js
  assert.equal(sheet.frames.find(f => f.id === 'b').x, 32);
  assert.equal(services.selections.get({ kind: 'sprite-sheet', id: 'sheet1' })?.frameId, inserted.id);
```
In `'mergeStripSegments fuses two segments...'`, replace:
```js
  assert.equal(sheet.frames.find(f => f.id === 'a').x, 24);
  assert.equal(state.selectedAnimationId, 'an1');
```
with:
```js
  assert.equal(sheet.frames.find(f => f.id === 'a').x, 24);
  assert.equal(services.selections.get({ kind: 'sprite-sheet', id: 'sheet1' })?.animationId, 'an1');
```
In `'newStripFromFrame promotes a standalone frame into a strip and renames it'`, replace:
```js
  assert.deepEqual(frameIds(anim), ['f1', sheet.frames[1].id, sheet.frames[2].id]);
  assert.equal(state.selectedAnimationId, anim.id);
```
with:
```js
  assert.deepEqual(frameIds(anim), ['f1', sheet.frames[1].id, sheet.frames[2].id]);
  assert.equal(services.selections.get({ kind: 'sprite-sheet', id: 'sheet1' })?.animationId, anim.id);
```
In `'newStripFromFrame promotes a standalone frame growing to the left...'`, replace:
```js
  assert.equal(ids[ids.length - 1], 'f1');
  assert.equal(state.selectedAnimationId, anim.id);
```
with:
```js
  assert.equal(ids[ids.length - 1], 'f1');
  assert.equal(services.selections.get({ kind: 'sprite-sheet', id: 'sheet1' })?.animationId, anim.id);
```

### Step 21: Run the full suite and self-review

Run `npm test`. Every test in the repo must pass, including the 4 rewritten sprite command test files, `tests/floatsession.test.mjs` (unmodified), `tests/architecture.test.mjs` (unmodified — none of these changes touch a banned import direction: command files gained no DOM/browser globals, presentation files still dispatch by id only), and `tests/builtinmodes.test.mjs` (unmodified — the registered command id list is unchanged).

Grep the whole `js/` tree for `state\.(activeLayerId|selectedFrameId|selectedAnimationId)` afterward — every remaining hit must be inside `js/app/state.js` itself (the field declarations, `activeLayer()`'s and `currentContextLayers()`'s null-host fallback branches) or inside `js/features/project/document-controller.js`'s untouched maps-mode branch. Any other hit means a site was missed.

Commit this task's work as one or more commits on the plan's branch.

---

## Task 2: Remove dead selection fields and update the manual QA checklist

By the end of Task 1, nothing in `js/` reads or writes `state.selectedFrameId` or `state.selectedAnimationId` any more — every production site now goes through `SelectionService` (directly via `getEditorHost().selections` or, in command handlers, via `services.selections`), and all 4 sprite command test files were rewritten to match. `state.activeLayerId` is the one exception: `js/app/state.js`'s `activeLayer()` still reads it as a null-host fallback (for `tests/floatsession.test.mjs`), and `setProject()`'s host-present branch no longer writes it, so it stays permanently `null` in production — but the field must stay declared for that fallback to have something to read. This task removes the two fully-dead field declarations and brings the manual QA checklist's internal-implementation references up to date.

**Files:**
- Modify: `js/app/state.js`
- Modify: `tests/smoke.md`

**Interfaces:**
- Consumes: Task 1's completed migration — every read/write site must already be gone before this task's grep-based Step 1 will show a clean result.
- Produces: nothing new; this is pure deletion/documentation cleanup, no other task depends on it.

### Step 1: Confirm Task 1 fully migrated the two fields

Before touching anything, grep the whole repo (both `js/` and `tests/`) for `selectedFrameId` and `selectedAnimationId`:

```
grep -rn "selectedFrameId" js tests
grep -rn "selectedAnimationId" js tests
```

Every hit MUST be one of:
- `js/app/state.js`'s own `state` object literal (the declaration this task is about to remove)
- prose inside `tests/smoke.md` (which this task's Step 3 updates)

If any hit shows an actual code read/write outside those two files, STOP — Task 1 missed a site. Do not proceed with this task until that is resolved (fix the missed site the same way Task 1's matching step handled its file, then re-run this grep).

### Step 2: Remove the two dead fields from `js/app/state.js`

Replace:
```js
  activeSheetId: null,        // per current mode
  activeLayerId: null,
  tool: 'pencil',
  brushSize: 1,
  primary: [0, 0, 0, 255], secondary: [255, 255, 255, 255],
  selectedFrameId: null, selectedAnimationId: null,
  selectedTileId: null,       // tile tool selection (tile mode)
```
with:
```js
  activeSheetId: null,        // per current mode
  // activeLayerId is written only by tests (see activeLayer()'s null-host
  // fallback below) -- production code goes through SelectionService
  // exclusively once a host is configured.
  activeLayerId: null,
  tool: 'pencil',
  brushSize: 1,
  primary: [0, 0, 0, 255], secondary: [255, 255, 255, 255],
  selectedTileId: null,       // tile tool selection (tile mode)
```

Do not touch `activeLayer()`, `currentContextLayers()`, or `setProject()` — Task 1 already left them in their final form; this step only removes the now-unread field declarations.

### Step 3: Update `tests/smoke.md`'s stale internal-field references

Four checklist items reference the old bare `state.*` fields as the way a manual tester verifies something non-visually. Update each to reference the new `SelectionService` document shape instead.

Replace (item 27):
```
27. [A] Clicking a timeline cell once: scrubs the preview playhead to it,
    sets `state.selectedFrameId` to its frame (so the Frames panel and the
    sprite-sheet highlight follow), AND opens the frame editor on that
    frame directly — no double-click needed.
```
with:
```
27. [A] Clicking a timeline cell once: scrubs the preview playhead to it,
    sets the active sheet's selected frame (via SelectionService — check
    with `getEditorHost().selections.get({ kind: 'sprite-sheet', id })`,
    so the Frames panel and the sprite-sheet highlight follow), AND opens
    the frame editor on that frame directly — no double-click needed.
```

Replace (item 29b):
```
29b. [A] The Preview panel is general-purpose, not animation-only: with no
    animation selected, selecting/editing a frame (sprites) or a tile
    (tile mode) shows it there instead — verify by setting
    `state.selectedFrameId`/`state.selectedTileId` and checking the
    panel's canvas updates. Its own `−`/`+`/Fit controls (bottom-right
```
with:
```
29b. [A] The Preview panel is general-purpose, not animation-only: with no
    animation selected, selecting/editing a frame (sprites) or a tile
    (tile mode) shows it there instead — verify by setting the sprite
    sheet's selected frame via `getEditorHost().selections.set({ frameId },
    { kind: 'sprite-sheet', id })` (or `state.selectedTileId` for tile
    mode, still legacy) and checking the panel's canvas updates. Its own
    `−`/`+`/Fit controls (bottom-right
```

Replace (item 31's trailing clause):
```
    Selecting something with no owning animation (a plain layer/group, a
    standalone frame, or empty canvas space) clears the animation selection
    to "(none)" in all three rather than leaving a stale one selected
    (verify via `state.selectedAnimationId`, not just visually).
```
with:
```
    Selecting something with no owning animation (a plain layer/group, a
    standalone frame, or empty canvas space) clears the animation selection
    to "(none)" in all three rather than leaving a stale one selected
    (verify via `getEditorHost().selections.get({ kind: 'sprite-sheet', id
    }).animationId`, not just visually).
```

Replace (item 90's trailing clause):
```
90. [A] With the frame tool, an intact strip's SELECTED segment always
    shows its chrome (topmost, above label overlays): "+" insert call-outs
    above each frame boundary and "✂" split call-outs below each interior
    boundary; hovering a part highlights it; clicking "+" inserts a blank
    frame there (pixel-carrying tail shift), one undo step. Chrome only
    ever appears for the segment containing `state.selectedFrameId` —
    a non-selected strip shows no chrome until a member of it is clicked.
```
with:
```
90. [A] With the frame tool, an intact strip's SELECTED segment always
    shows its chrome (topmost, above label overlays): "+" insert call-outs
    above each frame boundary and "✂" split call-outs below each interior
    boundary; hovering a part highlights it; clicking "+" inserts a blank
    frame there (pixel-carrying tail shift), one undo step. Chrome only
    ever appears for the segment containing the active sheet's selected
    frame (per SelectionService) — a non-selected strip shows no chrome
    until a member of it is clicked.
```

### Step 4: Run the full suite

Run `npm test`. Every test must still pass — this task touches no code paths any test exercises directly (the removed fields already had zero readers/writers after Task 1), so a failure here means Step 1's grep missed something; go back and investigate rather than editing around it.

### Step 5: Commit

Commit this task's work as one commit on the plan's branch.

---
