# Phase 4 Group 4 (Shell Rewrite) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the legacy `js/app/state.js` mutable-object + `on()`/`emit()` event bus from the 6 shell-controller files (plus the `float-session.js` co-dependency), making `EditorStore`/`HistoryService`/`ProjectService`/`DocumentService` the sole owners of project identity, mode/document/tool/view session state, and undo history. This unblocks Group 3 (per-mode cleanup), which cannot proceed until this lands — see the design doc's 2026-08-17 amendment.

**Architecture:** No new host-layer surface is needed — `EditorStore`, `HistoryService`, `ProjectService`, `DocumentService`, `SelectionService` already exist and already have every method this plan needs (`host.activateMode()`, `host.documents.setActive()`, `host.projects.replace()`/`host.setProject()`, `host.history.execute()`/`.undo()`/`.redo()`/`.clear()`, `EditorStore.subscribe()`, `EditorStore.workspace.overlays`). This is a consumer-side rewrite: 6 controller files + `float-session.js` stop reading/writing `state.*` and stop using `on()`/`emit()`, and instead call host methods directly and subscribe to `EditorStore`/`HistoryService`. `legacy-state-adapter.js` is deleted once nothing drives it. `bootstrap.js` absorbs `main.js`'s 6 `mount*` calls and stops handing `HistoryService` a pre-built `CommandStack`.

**Tech Stack:** Vanilla JS ES modules, no build step, no framework. `node --test` for the test suite (`npm test`).

**Spec:** [docs/superpowers/specs/2026-08-10-phase-4-shell-legacy-retirement-design.md](../specs/2026-08-10-phase-4-shell-legacy-retirement-design.md) — read the "Current state," "Target architecture," and both amendments (Foundation group, Group sequence) before starting. This plan cites exact line numbers against HEAD `ab60570` (after 3 hotfix commits landed the same day this plan was written — `dd8f9ef`, `f56dcea`, `ab60570` — which fixed pre-existing missing-import bugs in `file-controller.js`, `filter-controller.js`, and `project-controller.js` unrelated to this migration).

## Global Constraints

- **No user-facing behavior change.** Every mode/dialog/shortcut must work identically after each task, verified by the full test suite plus a manual check (the user does all live/e2e verification personally — do not attempt Playwright automation for this, per established project policy; NEVER simulate pointer drags either way).
- **`HistoryService.execute(command)` accepts the exact same `{label, do, undo}` object shape `state.commands.push(cmd)` did** (`js/host/history-service.js:26`, `validateCommand` only requires `do`/`undo` functions — extra properties like `label` are ignored, not rejected). Every `state.commands.push(cmd)` site converts to `editorHost.history.execute(cmd)` with the **cmd object body unchanged**, not restructured.
- **`state.commands.clear()` (legacy `setProject()`'s internal call, `js/app/state.js:137`) has no equivalent unless explicitly added.** Every legacy `setProject()` replacement must be paired with an explicit `editorHost.history.clear({markDirty: false})` in the same change, or the previous project's undo stack survives New/Open — a real functional regression, not a naming-only change.
- **`state.onion` is a live alias into `project.settings.onion`,** re-pointed only inside legacy `setProject()` (`state.js:129`). Once `setProject()` stops being called, every remaining `state.onion.*` read/write must be rewritten to `host.projects.project.settings.onion.*` in the same change, or it silently reads/writes an orphaned object.
- **`EditorStore.subscribe(selector, listener, opts)` has never been called anywhere in this codebase before this plan** (`js/host/editor-store.js:78`) — treat it as unproven, not an established pattern. Prefer `fireImmediately: true` where a listener needs its own initial render, matching the shape `ContextKeys.subscribe`/`HistoryService.subscribe` already use elsewhere in this codebase for that same need.
- **Every file this plan touches keeps passing `tests/architecture.test.mjs`** unmodified until Task 5, which is the only task that edits that file.
- Run `npm test` after every task; all 631 tests (or more, if a task adds any) must pass before moving to the next task.

> **Amendment (2026-08-17, added during Task 2 execution):** legacy `setProject()` turned out to be the *only* remaining writer of `state.project`/`state.activeSheetId`/`state.activeMapId` anywhere in the codebase, not just of `state.dirty`/`state.onion`/`state.commands` as originally scoped. Per the design doc's own 29-file survey (the same finding that justified reordering Group 3 after Group 4), those three fields still have real, load-bearing readers outside this plan's files until Group 3 lands. Task 2 Step 2 (below) is amended to add a second host→legacy mirror, alongside the `state.dirty` one, covering `state.project`/`state.activeSheetId`/`state.activeMapId`. **Unlike the `state.dirty` mirror, this one is NOT removed by Task 5** — it must survive past this entire plan and stay load-bearing until Group 3 migrates those 29 files off direct `state.project` reads. Task 5 Step 4 only ever touches the `state.dirty` mirror; do not fold this one into that cleanup.
>
> **Second amendment (2026-08-17, added during Task 4 verification):** `state.mode` has the identical problem, at far larger scale. Task 1's rewrite of `document-controller.js`'s `switchMode()` stopped writing `state.mode` (moving to `editorHost.store.updateSession(...)`/`activateMode()` instead) without providing any replacement mirror — and `state.mode` turned out to have 40+ read sites across `js/components/tool-palette.js`, `js/components/panels/{layers,preview}-panel.js`, `js/components/canvas/sheet-overlays.js`, and nearly every presentation file under `js/modes/{tiles,sprites,maps}/presentation/`, gating tool availability, panel visibility, and the `modeId` tag passed to `getEditorHost().registries.commands.execute(id, {modeId: state.mode}, args)`. Frozen at its `'sprites'` default (`js/app/state.js:19`), this silently breaks tile/map tool availability, panel show/hide, and command-dispatch mode-tagging the instant a user leaves Sprites mode. Fixed by folding a fourth tracked field, `s.session.activeModeId`, into the same tuple-selector mirror in `file-controller.js` that Task 2 already established for `project.model`/`activeDocument`/`onion` — see Task 2 Step 2 below for the updated, final code. Same lifecycle as the other three: not removed by Task 5, persists until Group 3.

---

### Task 1: `editor-workbench.js` + `document-controller.js` — mode/document/undo state machine

These two files are not independently rewritable (see design doc investigation): `document-controller.js` owns mode/document switching and is the sole caller of `legacy-state-adapter.js`; `editor-workbench.js`'s `contextKeys.subscribe` handler carries a `queueMicrotask` workaround (lines 232-243) specifically compensating for `document-controller.js`'s adapter-replay timing gap. Fixing the root cause in `document-controller.js` lets the workaround in `editor-workbench.js` be deleted in the same task.

**Files:**
- Modify: `js/features/project/document-controller.js` (currently 421 lines)
- Modify: `js/features/workbench/editor-workbench.js` (currently 291 lines)
- Test: `tests/architecture.test.mjs` (read-only check this task — verify it still passes, no edits)

**Interfaces:**
- Consumes: `EditorHost.activateMode(modeId)` (`js/host/editor-host.js:99`, synchronous, returns mode's `activate()` return value); `EditorHost.documents.setActive(reference, {modeId, allowMissing})` (`js/host/document-service.js:60`); `EditorHost.history.execute(command)`/`.undo()`/`.redo()`/`.canUndo()`/`.canRedo()`/`.subscribe(listener, {fireImmediately})` (`js/host/history-service.js:26-47`); `EditorStore.getState().session.activeModeId`/`.activeDocument`/`.activeToolId`/`.activeViewId` (`js/host/editor-store.js:9-16`); `EditorStore.workspace.overlays` (already exists, `editor-store.js:18`, shape `{labels: true, sequences: true}`); `EditorStore.subscribe(selector, listener, opts)` (`editor-store.js:78`).
- Produces: `editor-workbench.js`'s returned API (`pushCanvasPreview`, `clearCanvasPreview`, `focusMap`, `fitSheet`, `activeCanvasView`) is unchanged in shape — Task 2's `file-controller.js`/`project-controller.js` and Task 3's `filter-controller.js` consume it exactly as today. `document-controller.js`'s exported behavior (mount function signature `mountDocumentController({editorHost, workbench})`) is unchanged.

#### Step 1: Read current mode/document state directly from the host instead of `state.mode`/`state.activeSheetId`/`state.activeMapId`

In `document-controller.js`, replace `switchMode()` (lines 40-81) with a version that calls `editorHost.activateMode()`/`editorHost.documents.setActive()` **synchronously in the same call**, not via the adapter's reactive replay. The function keeps its two responsibilities (updating tab UI classes, and seeding sheet/map selection) but drives them from the host's own state, not `state.*`.

Replace lines 40-81 (`function switchMode...` through the closing `}`) with:

```js
  function switchMode(mode, { fromHost = false } = {}) {
    if (!fromHost && editorHost && editorHost.activeModeId !== mode) {
      editorHost.activateMode(mode);
      return;
    }
    const previousMode = editorHost.store.getState().session.activeModeId;
    if (previousMode === mode) return;
    tabSprites.classList.toggle('active', mode === 'sprites');
    tabTiles.classList.toggle('active', mode === 'tiles');
    tabMaps.classList.toggle('active', mode === 'maps');
    if (mode === 'maps') {
      const map = editorHost.projects.project?.maps?.[0] ?? null;
      editorHost.documents.setActive(map ? { kind: 'map', id: map.id } : null, { modeId: mode, allowMissing: true });
      editorHost.store.updateSession({ activeViewId: 'maps.canvas' }, 'view');
      const tool = editorHost.store.getState().session.activeToolId;
      if (!['select', 'move', 'maptile', 'mapsprite'].includes(tool)) editorHost.store.updateSession({ activeToolId: 'select' }, 'tool');
      workbench.focusMap();
      return;
    }
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheet = editorHost.projects.project?.sheets.find(s => s.kind === kind) ?? null;
    editorHost.documents.setActive(sheet ? sheetDocument(sheet) : null, { modeId: mode, allowMissing: true });
    // Selections (layer/frame/animation/tile) are per-sheet; a stale id
    // surviving an active-sheet change lets e.g. timeline's "Add selected
    // frame" insert one sheet's frameId into another sheet's animation
    // (blank timeline cell, `"frame": null` on export). Reseed on every path
    // that reassigns the active document.
    seedSheetSelection(sheet, sheet ? (sheetLayers(sheet)[0]?.id ?? null) : null);
    editorHost.store.updateSession({ activeViewId: `${mode}.sheet` }, 'view');
    // frame/tile tools are mode-exclusive (their palette buttons hide via
    // isAvailable()); fall back to pencil so leaving their mode doesn't strand
    // pointer routing on a tool with nothing to dispatch to.
    const tool = editorHost.store.getState().session.activeToolId;
    if (mode !== 'sprites' && tool === 'frametool') editorHost.store.updateSession({ activeToolId: 'pencil' }, 'tool');
    if (mode !== 'tiles' && tool === 'tiletool') editorHost.store.updateSession({ activeToolId: 'pencil' }, 'tool');
    if (mode !== 'maps' && ['maptile', 'mapsprite'].includes(tool)) editorHost.store.updateSession({ activeToolId: 'pencil' }, 'tool');
    // Maps uses a deliberately distant, centred infinite-workspace camera.
    // Returning to a finite sheet must recenter it; otherwise the sheet is
    // still rendered but entirely outside the viewport (as in the reported
    // blank Tile Sheets canvas).
    if (previousMode === 'maps') workbench.fitSheet();
  }
```

Note: `state.selectedTileId = null;` from the original `switchMode()` (line 67) is dropped here — `selectedTileId` is legacy-owned per the design doc's field-mapping table and out of scope for this migration (tiles mode still reads/writes it directly; Group 3c will handle it). Leaving it alone here is correct, not an oversight — the original clear was resetting a field only tiles-mode UI reads, and `seedSheetSelection` already reseeds the fields this task does own (layer/frame/animation).

#### Step 2: Delete the legacy-adapter trigger wiring

Delete lines 87-97 entirely (the `// Transitional bridge...` comment through `syncEditorHost();`):

```js
  // Transitional bridge: the host is authoritative for mode activation while
  // legacy feature controllers still write the existing state object. Mirroring
  // the remaining state into the new service store lets features migrate one at
  // a time without maintaining two independent application states.
  const syncEditorHost = () => syncLegacyStateToHost(editorHost, state);
  on('project', syncEditorHost);
  on('view', syncEditorHost);
  on('selection', syncEditorHost);
  on('tool', syncEditorHost);
  on('history', syncEditorHost);
  syncEditorHost();
```

Remove the now-unused import at line 8: delete `import { syncLegacyStateToHost } from './legacy-state-adapter.js';`.

#### Step 3: Rewrite the sheet selector to read from the host and subscribe to `EditorStore`

Replace `refreshSheetSelect()` (lines 100-118) with a version reading `editorHost.projects.project` and `editorHost.documents` instead of `state.project`/`state.activeSheetId`/`state.activeMapId`:

```js
  function refreshSheetSelect() {
    const mode = editorHost.store.getState().session.activeModeId;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    if (mode === 'maps') {
      const maps = editorHost.projects.project?.maps ?? [];
      sheetSelect.innerHTML = '';
      for (const m of maps) { const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.name; sheetSelect.appendChild(opt); }
      sheetSelect.value = activeDoc?.kind === 'map' ? activeDoc.id : '';
      return;
    }
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheets = editorHost.projects.project?.sheets.filter(s => s.kind === kind) ?? [];
    sheetSelect.innerHTML = '';
    for (const s of sheets) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      sheetSelect.appendChild(opt);
    }
    sheetSelect.value = activeDoc ? activeDoc.id : '';
  }
```

Replace lines 119-127 (the `sheetSelectQueued`/`scheduleSheetSelectRefresh`/`on('project', ...)`/`on('view', ...)`/`refreshSheetSelect();` block) with an `EditorStore.subscribe()` covering the same two triggers (project replaced, and mode/document/dirty changes — the store fields `refreshSheetSelect` actually depends on):

```js
  editorHost.store.subscribe(
    state => [state.project.model, state.session.activeModeId, state.session.activeDocument],
    () => refreshSheetSelect(),
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2], fireImmediately: true },
  );
```

This drops the microtask-batching `scheduleSheetSelectRefresh` had — `EditorStore.transaction()` already batches to one flush per outermost transaction (`editor-store.js:38-48`), so a raw `subscribe()` listener already fires at most once per transaction; the extra `queueMicrotask` layer was compensating for the legacy bus firing multiple non-batched `emit()` calls per logical change, which no longer happens once this file stops calling `emit()`.

#### Step 4: Rewrite the sheet-select change handler

Replace lines 129-139 with:

```js
  sheetSelect.addEventListener('change', () => {
    const mode = editorHost.store.getState().session.activeModeId;
    if (mode === 'maps') {
      const map = editorHost.projects.project?.maps?.find(m => m.id === sheetSelect.value);
      if (!map) return;
      editorHost.documents.setActive({ kind: 'map', id: map.id }, { modeId: mode });
      workbench.focusMap();
      return;
    }
    const sheet = editorHost.projects.project?.sheets.find(s => s.id === sheetSelect.value);
    if (!sheet) return;
    editorHost.documents.setActive(sheetDocument(sheet), { modeId: mode });
    // See switchMode's comment above: selections are per-sheet, reseed here too.
    seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
  });
```

#### Step 5: Rewrite `commitAddSheet` to use `editorHost.history.execute()` and host-based document activation

Replace lines 147-177 with:

```js
  function commitAddSheet(sheet) {
    const project = editorHost.projects.project;
    const prevDoc = editorHost.store.getState().session.activeDocument;
    const prevSheet = activeSheet();
    const prevActiveLayerId = prevSheet ? (editorHost.selections.get(sheetDocument(prevSheet))?.layerId ?? null) : null;
    const insertIndex = project.sheets.indexOf(sheet);
    const mode = editorHost.store.getState().session.activeModeId;
    const cmd = {
      label: 'new sheet',
      do() {
        if (!project.sheets.includes(sheet)) project.sheets.splice(insertIndex, 0, sheet);
        editorHost.documents.setActive(sheetDocument(sheet), { modeId: mode });
        // See switchMode's comment above: selections are per-sheet, reseed them too.
        seedSheetSelection(sheet, sheetLayers(sheet)[0]?.id ?? null);
      },
      undo() {
        const i = project.sheets.indexOf(sheet);
        if (i !== -1) project.sheets.splice(i, 1);
        editorHost.documents.setActive(prevDoc, { modeId: mode, allowMissing: true });
        if (prevSheet) seedSheetSelection(prevSheet, prevActiveLayerId);
      },
    };
    editorHost.history.execute(cmd);
    editorHost.projects.markDirty();
  }
```

#### Step 6: Rewrite `document.newSheet`/`document.importSheet` actions

In the `document.newSheet` action's `run` (lines 180-194), replace the body:

```js
    run: () => {
      const project = editorHost.projects.project;
      if (!project) return;
      const mode = editorHost.store.getState().session.activeModeId;
      if (mode === 'maps') {
        const map = createMap(project, { name: `Map ${project.maps.length}`, gridW: project.settings.tileW, gridH: project.settings.tileH });
        editorHost.documents.setActive({ kind: 'map', id: map.id }, { modeId: mode });
        editorHost.projects.markDirty();
        return;
      }
      const kind = mode === 'sprites' ? 'sprite' : 'tile';
      const settings = project.settings;
      const n = project.sheets.filter(s => s.kind === kind).length + 1;
      nsName.value = `sheet_${n}`;
      nsW.value = kind === 'sprite' ? settings.spriteSheetW : settings.tileSheetW;
      nsH.value = kind === 'sprite' ? settings.spriteSheetH : settings.tileSheetH;
      dlgNewSheet.showModal();
    },
    isEnabled: () => !!editorHost.projects.project,
```

In `nsCreate`'s click handler (lines 197-216), replace `state.project`/`state.mode` reads:

```js
  nsCreate.addEventListener('click', () => {
    const project = editorHost.projects.project;
    if (!project) return;
    const mode = editorHost.store.getState().session.activeModeId;
    const kind = mode === 'sprites' ? 'sprite' : 'tile';
    const sheetDim = (el) => {
      const v = parseInt(el.value, 10);
      return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
    };
    const width = sheetDim(nsW);
    const height = sheetDim(nsH);
    if (width == null || height == null) {
      alert('Please enter valid positive numbers for all fields.');
      return;
    }
    const name = nsName.value.trim() || `sheet_${project.sheets.filter(s => s.kind === kind).length + 1}`;

    const sheet = createSheet(project, { name, width, height, kind });
    commitAddSheet(sheet);
    dlgNewSheet.close();
  });
```

In `document.importSheet`'s `run` (lines 219-254), replace `state.project`/`state.mode` reads (keep the file-picker/decode logic at lines 224-242 unchanged):

```js
    run: async () => {
      const mode = editorHost.store.getState().session.activeModeId;
      if (!editorHost.projects.project || mode === 'maps') return;
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
      bitmap = maybeSnapPixels(bitmap);
      const project = editorHost.projects.project;
      const kind = mode === 'sprites' ? 'sprite' : 'tile';
      const name = file.name.replace(/\.[^.]+$/, '') || 'imported';
      const sheet = createSheet(project, {
        name, width: bitmap.width, height: bitmap.height, kind,
      });
      sheetLayers(sheet)[0].bitmap = bitmap;
      commitAddSheet(sheet);
    },
    isEnabled: () => !!editorHost.projects.project && editorHost.store.getState().session.activeModeId !== 'maps',
```

#### Step 7: Rewrite rename/delete sheet-or-map commands

In `document.renameSheet`'s `run`/`isEnabled` (lines 266-277), replace `state.mode` reads with `editorHost.store.getState().session.activeModeId`. In `rsOk`'s click handler (lines 281-296), replace `state.commands.push(...)` with `editorHost.history.execute(...)` and `markDirty()` with `editorHost.projects.markDirty()`:

```js
  rsOk.addEventListener('click', () => {
    const target = renameTarget;
    if (!target) { dlgRenameSheet.close(); return; }
    const v = rsName.value.trim();
    if (!v) { alert('Name cannot be empty.'); return; }
    const old = target.name, kind = renameTargetKind;
    editorHost.history.execute({
      label: `rename ${kind}`,
      do() { target.name = v; editorHost.projects.markDirty(); },
      undo() { target.name = old; editorHost.projects.markDirty(); },
    });
    renameTarget = null;
    dlgRenameSheet.close();
  });
```

Replace `commitDeleteMap` (lines 305-326) and `commitDeleteSheet` (lines 327-365) to activate/restore documents via `editorHost.documents.setActive()` instead of writing `state.activeMapId`/`state.activeSheetId`, and to push through `editorHost.history.execute()`:

```js
  function commitDeleteMap(map) {
    const project = editorHost.projects.project, index = project.maps.indexOf(map);
    if (index === -1) return;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    const wasActive = activeDoc?.kind === 'map' && activeDoc.id === map.id;
    const mode = editorHost.store.getState().session.activeModeId;
    editorHost.history.execute({
      label: 'delete map',
      do() {
        const current = project.maps.indexOf(map); if (current !== -1) project.maps.splice(current, 1);
        if (wasActive) {
          const next = project.maps[Math.min(index, project.maps.length - 1)] ?? null;
          editorHost.documents.setActive(next ? { kind: 'map', id: next.id } : null, { modeId: mode, allowMissing: true });
        }
        editorHost.projects.markDirty();
      },
      undo() {
        if (!project.maps.includes(map)) project.maps.splice(index, 0, map);
        if (wasActive) editorHost.documents.setActive({ kind: 'map', id: map.id }, { modeId: mode });
        editorHost.projects.markDirty();
      },
    });
  }
  function commitDeleteSheet(sheet) {
    const project = editorHost.projects.project;
    const index = project.sheets.indexOf(sheet);
    if (index === -1) return;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    const wasActive = activeDoc?.kind === sheetDocument(sheet).kind && activeDoc.id === sheet.id;
    const mode = editorHost.store.getState().session.activeModeId;
    const cmd = {
      label: 'delete sheet',
      do() {
        removeSheet(project, sheet.id);
        if (state.floating?.sheetId === sheet.id) state.floating = null;
        if (wasActive) {
          const siblings = project.sheets.filter(s => s.kind === sheet.kind);
          const next = siblings[Math.min(index, siblings.length - 1)] ?? null;
          editorHost.documents.setActive(next ? sheetDocument(next) : null, { modeId: mode, allowMissing: true });
          if (next) seedSheetSelection(next, next ? (sheetLayers(next)[0]?.id ?? null) : null);
        }
        editorHost.projects.markDirty();
      },
      undo() {
        project.sheets.splice(index, 0, sheet);
        if (wasActive) editorHost.documents.setActive(sheetDocument(sheet), { modeId: mode });
        editorHost.projects.markDirty();
      },
    };
    editorHost.history.execute(cmd);
  }
```

Note: `state.floating` is untouched here deliberately — `float-session.js`'s own state is out of this task's scope (Task 3 handles it); `commitDeleteSheet`'s `do()` still needs to drop a floating selection anchored to the deleted sheet, so this one `state.floating` read/write stays as the single remaining cross-reference between this task and Task 3's work. Also dropped from the original: the `prev` object's `selectedTileId`/`selectedTerrainSetId`/`editingFrameId`/`editingTileId`/`view` restore-on-undo fields — these are legacy-owned fields out of this migration's scope (same reasoning as Step 1's dropped `state.selectedTileId = null`), so undo no longer attempts to restore them; this is an accepted, minor undo-fidelity narrowing for out-of-scope fields, not a regression in anything this task owns.

Update `document.deleteSheet`'s `run`/`isEnabled` (lines 366-380) to read mode from the host:

```js
  defineAction('document.deleteSheet', {
    label: 'Delete',
    run: () => {
      const mode = editorHost.store.getState().session.activeModeId;
      if (mode === 'maps') {
        const map = activeMap(); if (!map) return;
        if (confirmOrAuto(`Delete map "${map.name}" and all of its layers and placements?`)) commitDeleteMap(map);
        return;
      }
      const sheet = activeSheet();
      if (!sheet) return;
      if (!confirmOrAuto(`Delete sheet "${sheet.name}" and everything in it (layers, frames, animations${sheet.kind === 'tile' ? ', tiles, autotile sets' : ''})?`)) return;
      commitDeleteSheet(sheet);
    },
    isEnabled: () => editorHost.store.getState().session.activeModeId === 'maps' ? !!activeMap() : !!activeSheet(),
  });
```

#### Step 8: Rewrite `refreshDocumentControlTitles` to subscribe to `EditorStore`

Replace lines 382-390:

```js
  function refreshDocumentControlTitles() {
    const maps = editorHost.store.getState().session.activeModeId === 'maps';
    btnNewSheet.title = maps ? 'New map' : 'New sheet';
    btnRenameSheet.title = maps ? 'Rename map' : 'Rename sheet';
    btnDeleteSheet.title = maps ? 'Delete map' : 'Delete sheet';
  }
  editorHost.store.subscribe(
    state => state.session.activeModeId,
    () => refreshDocumentControlTitles(),
    { fireImmediately: true },
  );
```

#### Step 9: Rewrite undo/redo/cut/copy/paste actions to use `editorHost.history`

Replace lines 393-406:

```js
  defineAction('edit.undo', {
    label: 'Undo', shortcut: 'Ctrl+Z',
    run: () => editorHost.history.undo(),
    isEnabled: () => editorHost.history.canUndo(),
  });
  defineAction('edit.redo', {
    label: 'Redo', shortcut: 'Ctrl+Y',
    run: () => editorHost.history.redo(),
    isEnabled: () => editorHost.history.canRedo(),
  });
  defineAction('edit.cut', { label: 'Cut', shortcut: 'Ctrl+X', run: () => cutSelection(false), isEnabled: hasSelection });
  defineAction('edit.copy', { label: 'Copy', shortcut: 'Ctrl+C', run: () => copySelection(false), isEnabled: hasSelection });
  defineAction('edit.paste', { label: 'Paste', shortcut: 'Ctrl+V', run: paste });
```

`editorHost.history.subscribe(() => emit('history'))` (the old line 393, the reverse host→legacy bridge) is deleted outright — nothing needs it once nothing listens for `'history'` on the legacy bus anymore (this task removes every `on('history', ...)` site across both files it touches; Tasks 2-3 remove the rest project-wide).

#### Step 10: Update `document-controller.js`'s import line

Replace line 1:

```js
import { activeSheet, activeMap, confirmOrAuto, maybeSnapPixels } from '../../app/state.js';
```

`state`, `on`, `emit`, `markDirty` are no longer used anywhere in this file after Steps 1-9 — drop them from the import. `activeSheet`/`activeMap`/`confirmOrAuto`/`maybeSnapPixels` are still used as-is (they're read-only helpers/pure functions unaffected by this task; `activeSheet`/`activeMap` still read via `state.activeSheetId`/`state.activeMapId` internally today, which is fine — those helpers themselves aren't part of Foundation item 3's deferred scope for this task, only this file's own direct `state.*` access is).

**`state` itself must stay unused in this file after this task** — grep `document-controller.js` for a bare `state.` or `state\b` reference after Steps 1-9 land; if any remain, they were missed in the steps above and must be converted too (the only two intentional exceptions are `state.floating` in `commitDeleteSheet`, called out explicitly in Step 7, and the `state.commands.push` sites, all of which are already converted in Steps 5-9 — there should be zero remaining `state.commands.*`/`state.mode`/`state.tool`/`state.view`/`state.activeSheetId`/`state.activeMapId`/`state.project`/`state.selectedTileId` references).

#### Step 11: `editor-workbench.js` — move overlay toggles onto `EditorStore.workspace.overlays`

Replace `view.toggleLabels`/`view.toggleSequences` (lines 53-62):

```js
  defineAction('view.toggleLabels', {
    label: 'Show Labels',
    run: () => editorHost.store.transaction('overlays', s => { s.workspace.overlays.labels = !s.workspace.overlays.labels; }),
    isChecked: () => editorHost.store.getState().workspace.overlays.labels,
  });
  defineAction('view.toggleSequences', {
    label: 'Show Sequences',
    run: () => editorHost.store.transaction('overlays', s => { s.workspace.overlays.sequences = !s.workspace.overlays.sequences; }),
    isChecked: () => editorHost.store.getState().workspace.overlays.sequences,
  });
```

This is the first real consumer of `EditorStore.workspace.overlays`, which has existed unused since Group 1's Foundation work landed it.

#### Step 12: `editor-workbench.js` — rewrite status bar to subscribe to `EditorStore`/`HistoryService`

Replace `updateStatusTool`/`on('tool', updateStatusTool)`/`updateStatusTool();` (lines 65-67):

```js
  function updateStatusTool() { statusTool.textContent = `Tool: ${editorHost.store.getState().session.activeToolId}`; }
  editorHost.store.subscribe(s => s.session.activeToolId, updateStatusTool, { fireImmediately: true });
```

Replace `updateStatusPlatform` (lines 75-92) and its five `on(...)` wirings (lines 93-98) — the function body's internal reads change from `state.project`/`state.view`/`state.editingFrameId`/`state.editingTileId` to host-based reads, and the five `on()` triggers ('pixels', 'history', 'selection', 'project', 'view') become one `EditorStore.subscribe` plus one `HistoryService.subscribe` (there is no `EditorStore` equivalent for 'pixels' or 'selection' — those two still fire via `emit('pixels')`/`emit('selection')` from other not-yet-migrated call sites in other files, e.g. `drawing-engine.js`, `layers-panel.js`; this task keeps `on('pixels', ...)`/`on('selection', ...)` for THIS function only, since retiring those two legacy events project-wide is out of this plan's scope — see the plan's "Explicitly out of scope" section below):

```js
  function updateStatusPlatform() {
    const project = editorHost.projects.project;
    const sheet = activeSheet();
    const platformId = project?.settings?.targetPlatform ?? 'none';
    const view = editorHost.store.getState().session.activeViewId;
    const activeDoc = editorHost.store.getState().session.activeDocument;
    const selection = activeDoc ? editorHost.selections.get(activeDoc) : null;
    const rect = platformId === 'none' || !sheet ? null
      : view === 'sprites.frame' ? sheet.frames?.find(f => f.id === selection?.frameId)
      : view === 'tiles.tile' ? sheet.tiles?.find(t => t.id === selection?.tileId)
      : null;
    if (!rect) { statusPlatform.textContent = ''; statusPlatform.title = ''; return; }

    const bitmap = copyRegion(flattenSheet(sheet), rect.x, rect.y, rect.w, rect.h);
    const kind = view === 'tiles.tile' ? 'tile' : 'sprite';
    const warnings = checkItemAgainstPlatform(platformId, { colors: colorFrequency([bitmap]), w: rect.w, h: rect.h, kind });
    const label = PLATFORMS[platformId].label;
    statusPlatform.textContent = warnings.length ? `${label} ⚠ ${warnings.length}` : `${label} ✓`;
    statusPlatform.title = warnings.join('\n');
    statusPlatform.classList.toggle('status-platform-warn', warnings.length > 0);
  }
  on('pixels', updateStatusPlatform);
  on('selection', updateStatusPlatform);
  editorHost.history.subscribe(updateStatusPlatform);
  editorHost.store.subscribe(
    s => [s.project.model, s.session.activeViewId, s.session.activeDocument],
    updateStatusPlatform,
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2], fireImmediately: true },
  );
```

Note: `view === 'frame'`/`view === 'tile'` string comparisons become `view === 'sprites.frame'`/`view === 'tiles.tile'` — `activeViewId`'s value space is the mode-qualified view ids `legacy-state-adapter.js` used to map to (`'sprites.frame'`, `'tiles.tile'`, `'maps.canvas'`, `'${modeId}.sheet'`, see the deleted adapter's line 14-17), not the legacy `state.view`'s bare `'sheet'`/`'frame'`/`'tile'` strings. Every place in this task's two files that compares against `activeViewId` must use the mode-qualified form.

#### Step 13: `editor-workbench.js` — rewrite canvas invalidation, `getScratchCanvas`, `refreshCanvasView`

Replace the `on('project', ...)`, `on('view', refreshCanvasView)`, `on('pixels', ...)`, `on('history', ...)`, `on('selection', ...)` block (lines 170-180) — keep `'pixels'`/`'selection'` as legacy `on()` calls (same out-of-scope reasoning as Step 12), convert `'project'`/`'view'`/`'history'`:

```js
  editorHost.store.subscribe(
    s => s.project.model,
    () => { invalidateScratch(); refreshCanvasView(); },
    { fireImmediately: true },
  );
  editorHost.store.subscribe(s => s.session.activeViewId, refreshCanvasView, { fireImmediately: true });
  // 'pixels': lightweight bitmap-changed-mid-stroke signal from drawing-engine.js/layers-panel.js
  // (in-progress drawing preview, live opacity drag) — just re-flatten + repaint,
  // skip the heavier setContent/dirty-flag work that a project-model change does.
  on('pixels', () => { invalidateScratch(); canvasView.requestRender(); });
  // undo/redo can touch pixels, layer structure, or both — repaint on every change.
  editorHost.history.subscribe(() => { invalidateScratch(); refreshCanvasView(); });
  // frame/tile selection changed (no pixel or structural change) — cheap repaint
  // so the label-overlay highlight tracks the selected frame immediately.
  on('selection', () => canvasView.requestRender());
```

Update `getScratchCanvas` (lines 138-155) and `refreshCanvasView` (lines 161-169) internal reads: replace `state.mode` with `editorHost.store.getState().session.activeModeId`, and `state.floating` stays as-is (out of scope, same as Step 7's note — `float-session.js` is Task 3's file).

#### Step 14: `editor-workbench.js` — rewrite `sheetTargetRect`, `activeCanvasView`, `applyView`

In `sheetTargetRect` (lines 192-204), no `state.*` reads need to change (it already uses `editorHost.selections.get(...)` at line 199 — leave as-is).

Replace `activeCanvasView` (line 255) and `applyView` (lines 266-283)'s internal reads:

```js
  function activeCanvasView() {
    const s = editorHost.store.getState().session;
    return s.activeModeId === 'maps' ? mapEditor.view : s.activeViewId === 'sprites.frame' ? frameEditor.view : s.activeViewId === 'tiles.tile' ? tileEditor.view : canvasView;
  }
```

```js
  function applyView() {
    const view = editorHost.store.getState().session.activeViewId;
    if (view === 'sprites.sheet' || view === 'tiles.sheet' || view === 'maps.canvas') {
      canvasView.canvas.style.display = '';
      frameEditor.hide();
      tileEditor.hide();
    } else if (view === 'sprites.frame') {
      canvasView.canvas.style.display = 'none';
      frameEditor.show();
      tileEditor.hide();
    } else {
      // 'tiles.tile'
      canvasView.canvas.style.display = 'none';
      frameEditor.hide();
      tileEditor.show();
    }
  }
  editorHost.store.subscribe(s => s.session.activeViewId, applyView, { fireImmediately: true });
```

Delete the old `on('view', applyView); applyView();` (lines 282-283) — replaced by the `subscribe(..., {fireImmediately: true})` above.

#### Step 15: `editor-workbench.js` — delete the `contextKeys.subscribe` microtask workaround

Replace lines 231-243 (`let panelReconcileQueued = false;` through the closing of the `queueMicrotask` callback):

```js
  editorHost.contextKeys.subscribe(() => panelManager.reconcile(contributionContext));
```

This is safe now specifically because Steps 1-4 made `document-controller.js`'s `switchMode()`/sheet-select handler call `host.activateMode()`/`host.documents.setActive()` **synchronously**, in the same tick as the mode/document change — the timing gap the microtask was compensating for (context keys changing before the "transitional legacy-state listener" finished switching the active document) no longer exists, because there is no more legacy-state listener in the mode-switch path.

#### Step 16: `editor-workbench.js` — update import line

Replace line 1:

```js
import { on, emit, activeSheet, activeLayer } from '../../app/state.js';
```

`state` itself is dropped (no more bare `state.*` reads remain after Steps 11-15 — the brush-size/color-swap keydown handler at lines 34-50 still uses `state.brushSize`/`state.primary`/`state.secondary`, which stay untouched: those are tool-config fields explicitly out of this migration's scope per the design doc's field-mapping table, "Local state in the relocated tool-palette/color-panel widgets"). **Keep `emit`** — the keydown handler still calls `emit('brushSize')`/`emit('colors')`, both out of scope. `on` stays for the two remaining `'pixels'`/`'selection'` legacy listeners from Steps 12-13.

Add: `import { getEditorHost } from '../../host/runtime.js';` — already present at line 16, no change needed (this file already imports it for its own `mountEditorWorkbench()` top-level `const editorHost = getEditorHost();`).

#### Step 17: Verify

Run: `npm test`
Expected: 631/631 passing, 0 failures (this task adds no new tests — it's a pure behavior-preserving rewrite; Task 5 is where the architecture-test guard gets added).

Grep both files for stray `state.` / `on(` / `emit(` references (excluding the deliberately-kept ones documented above: `document-controller.js`'s `state.floating`; `editor-workbench.js`'s `state.brushSize`/`state.primary`/`state.secondary`, `emit('brushSize')`/`emit('colors')`, and `on('pixels', ...)`/`on('selection', ...)`) — any other match means a step above was missed.

#### Step 18: Commit

```bash
git add js/features/project/document-controller.js js/features/workbench/editor-workbench.js
git commit -m "refactor: move mode/document/undo state machine off legacy state.js in document-controller.js + editor-workbench.js"
```

---

### Task 2: `file-controller.js` + `project-controller.js` — `setProject()` retirement + onion alias fix

Both files call legacy `setProject()` (4 sites total) and both need the `editorHost.history.clear({markDirty: false})` pairing in the same change (per Global Constraints). `project-controller.js` additionally needs its 5 `state.onion.*` references redirected to `host.projects.project.settings.onion.*` in the same change, since the alias only exists because legacy `setProject()` re-points it.

**Files:**
- Modify: `js/features/project/file-controller.js` (currently 547 lines, after the Save/Export hotfix)
- Modify: `js/features/project/project-controller.js` (currently 444 lines, after the `MAX_PALETTE_COLORS` hotfix)

**Interfaces:**
- Consumes: `EditorHost.setProject(project, {dirty})` (`js/host/editor-host.js:152-158` — does the project replace AND re-activates the current mode's document AND updates `contextKeys.documentKind`, strictly more complete than calling `host.projects.replace()` alone); `EditorHost.history.clear({markDirty})` (`history-service.js:29-33`).
- Produces: nothing new — both files' `defineAction`-registered action ids (`file.open`, `file.save`, `file.saveAs`, `file.export`, `file.new`, `edit.projectSettings`, `edit.onionStepColors`) are unchanged, consumed by Task 4's `menu-controller.js` verification pass.

#### Step 1: `file-controller.js` — replace the 3 legacy `setProject()` calls

Replace `file.open`'s `run` (lines 44-59, note: line numbers shifted +2 from the hotfix's 2 added import lines — re-anchor against the file's current `defineAction('file.open', ...)` block, not a hardcoded line range):

```js
  defineAction('file.open', {
    label: 'Open',
    run: async () => {
      if (state.dirty && !confirmOrAuto('Discard unsaved changes and open another project?')) return;
      try {
        const { project, handle } = await io.openPacked();
        state.fileHandle = handle;
        state.dirHandle = null;
        state.saveMode = handle ? 'packed' : null;
        getEditorHost().history.clear({ markDirty: false });
        getEditorHost().setProject(project, { dirty: false });
      } catch (e) {
        if (isCancel(e)) return;
        alert(e.message);
      }
    },
  });
```

Note: `getEditorHost` must be imported — see Step 3 below. Clear history **before** `setProject`, matching legacy `setProject()`'s own internal ordering (`state.js:137-138` clears `commands` before the final `dirty = false`), so no stray undo entries from the outgoing project are ever reachable even transiently.

Replace `boot()`'s two `setProject()` calls (near the end of the file, inside `(async function boot() {...})()`):

```js
  (async function boot() {
    let restored = null;
    try {
      restored = AUTOTEST ? null : await io.loadAutosave();
    } catch (e) {
      restored = null;
    }
    getEditorHost().history.clear({ markDirty: false });
    if (restored && confirm('An autosaved project was found. Restore it?')) {
      getEditorHost().setProject(restored, { dirty: false });
    } else {
      getEditorHost().setProject(newDefaultProject(), { dirty: false });
    }
  })();
```

#### Step 2: `file-controller.js` — verify `state.dirty` reads stay correct

`state.dirty` is still read at `file.open`'s guard (`state.dirty && !confirmOrAuto(...)`), `beforeunload`'s guard, and the autosave interval's guard. **Leave these as `state.dirty`** — legacy `setProject()`'s `state.dirty = false` (line 138 of `state.js`) is NOT called anymore after Step 1 (this task's rewritten `setProject`-replacement calls `getEditorHost().setProject()` instead, which never touches `state.dirty`). This means **`state.dirty` will go stale** (stuck at whatever it was before the last Open/boot) unless something else keeps it in sync.

Since `legacy-state-adapter.js` is still alive at this point in the plan (Task 5 deletes it) and its `syncLegacyStateToHost` (`host.store.setProject(legacyState.project, {dirty: !!legacyState.dirty, ...})`, line 7) only flows legacy→host, not host→legacy, `state.dirty` has no path to receive `EditorStore`'s dirty flag after this task. **This task must also add**, right after `mountFileController`'s existing top-of-function setup (near where `dlgExportProject`/`epSheets` etc. are resolved), a one-way host→legacy dirty mirror:

```js
  getEditorHost().store.subscribe(
    s => s.project.dirty,
    dirty => { state.dirty = dirty; },
    { fireImmediately: true },
  );
```

This is a deliberate, narrowly-scoped exception to "stop using the legacy bus" for this task only: `state.dirty` is read by 3 places in this same file (the guards above) plus `document-controller.js` no longer reads it (Task 1 already removed every `state.*` reference there) — grep confirms this file is the only remaining reader after Task 1. Task 5, which deletes `legacy-state-adapter.js` and every remaining `state.*` reference project-wide, is where this mirror and the 3 `state.dirty` reads it feeds get removed together, once `state.dirty` has no readers left at all.

**Amended (2026-08-17, final form after 3 rounds of findings): add a second mirror alongside the dirty mirror, covering `state.project`/`state.activeSheetId`/`state.activeMapId`/`state.onion`/`state.mode`.** Legacy `setProject()` and the old `switchMode()` were the *only* remaining writers of these fields anywhere in the codebase. ~29 not-yet-migrated mode-layer files (Group 3's scope, deliberately deferred until after this Group per the design doc's amendment) read them directly; without a mirror, retiring their writers leaves them frozen — confirmed empirically to blank the sprite/tile editor (project/activeSheetId/activeMapId), stale the onion-skin overlay (onion), and break tool availability/panel visibility/command mode-tagging across all 3 modes (mode). Add, alongside the dirty mirror above:

```js
  getEditorHost().store.subscribe(
    s => [s.project.model, s.session.activeDocument, s.session.activeModeId],
    ([project, doc, mode]) => {
      state.project = project;
      state.activeSheetId = doc && doc.kind !== 'map' ? doc.id : null;
      state.activeMapId = doc && doc.kind === 'map' ? doc.id : null;
      state.onion = project?.settings?.onion ?? state.onion;
      state.mode = mode;
      emit('project');
      emit('view');
    },
    { equals: (a, b) => a[0] === b[0] && a[1]?.id === b[1]?.id && a[1]?.kind === b[1]?.kind && a[2] === b[2], fireImmediately: true },
  );
```

Things this final form fixes over earlier drafts (found during implementation across 3 rounds, not obvious up front): (1) **`project`, `activeDocument`, and `activeModeId` must be combined into ONE tuple-selector subscribe, not independent ones.** `EditorHost.setProject()`/`activateMode()` each perform multi-step internal updates across separate store transactions — with independent subscribes, a mirror listener can fire while a sibling field still holds the *previous* value for one flush, so `activeSheet()`/mode-gated checks resolve against a stale value transiently. (Verified harmless in review: no paint/microtask boundary between the flushes, so nothing user-visible renders the inconsistent intermediate state — but it's cleaner to combine than to rely on that.) (2) **the mirror must call `emit('project')`/`emit('view')` after updating the fields**, not just assign them silently — roughly 8 not-yet-migrated files refresh by listening for these legacy events, not by reactively re-deriving from `state.project`; without the emit, the fields become correct but nothing repaints. (3) **`state.onion`** is a live alias with the identical staleness failure mode as `state.project` — `frame-editor-presenter.js` reads/writes it at 26 sites. (4) **`state.mode`** has by far the widest blast radius of the five fields — 40+ read sites gating tool availability (`tool-palette.js`), panel visibility (nearly every `js/modes/*/presentation/*.js` file), and the `modeId` tag on every `getEditorHost().registries.commands.execute(id, {modeId: state.mode}, args)` call — frozen at its `'sprites'` default, it silently disables tiles/maps-mode tools and panels and mistags command dispatch the instant a user leaves Sprites mode.

**Unlike the `state.dirty` mirror, none of these five fields are removed by Task 5** — see the Global Constraints amendment above. They stay load-bearing until Group 3 lands.

#### Step 3: `file-controller.js` — add `getEditorHost` import, keep `setProject`/`newDefaultProject` imports

Update the import line (post-hotfix, currently line 1):

```js
import { state, on, emit, activeSheet, activeMap, newDefaultProject, AUTOTEST, confirmOrAuto } from '../../app/state.js';
```

`setProject` (the legacy free function) is dropped from this import — nothing in this file calls it anymore after Step 1. `newDefaultProject` stays (still called, now as an argument to `getEditorHost().setProject()` rather than to legacy `setProject()`). `getEditorHost` is already imported at line 2 (`import { getEditorHost } from '../../host/runtime.js';`) — no new import line needed, Steps 1-2 just call it more.

#### Step 4: `project-controller.js` — replace the 1 legacy `setProject()` call

Replace `npCreate`'s click handler body (the `state.fileHandle = null; ... setProject(newDefaultProject(settings)); dlgNewProject.close();` block):

```js
  npCreate.addEventListener('click', () => {
    const dims = {
      spriteSheetW: sheetDimField(npSpriteW), spriteSheetH: sheetDimField(npSpriteH),
      tileSheetW: sheetDimField(npTileSheetW), tileSheetH: sheetDimField(npTileSheetH),
      tileW: positiveIntField(npTileW), tileH: positiveIntField(npTileH),
      frameW: positiveIntField(npFrameW), frameH: positiveIntField(npFrameH),
    };
    if (Object.values(dims).some(v => v == null)) {
      alert('Please enter valid positive numbers for all fields.');
      return;
    }
    const settings = {
      ...dims, durationMs: npDurationValue.durationMs,
      ...(npDurationValue.baseFps != null ? { baseFps: npDurationValue.baseFps, baseStep: npDurationValue.baseStep } : {}),
    };
    state.fileHandle = null; state.dirHandle = null; state.saveMode = null;
    getEditorHost().history.clear({ markDirty: false });
    getEditorHost().setProject(newDefaultProject(settings), { dirty: false });
    dlgNewProject.close();
  });
```

(Note: `state.fileHandle`/`state.dirHandle`/`state.saveMode` stay as legacy `state.*` writes here — these three fields are explicitly out of scope for this migration per the design doc's field-mapping table, "Local module state in the rewritten file-controller.js — single-consumer." They only happen to be written from `project-controller.js` too because New Project logically also clears the current file association; this is pre-existing cross-file coupling, not something this task changes.)

#### Step 5: `project-controller.js` — redirect the 5 `state.onion.*` references to `host.projects.project.settings.onion.*`

Replace the two reads inside `openProjectSettings` (in the `for (const r of onionStepRows) {...}` loop):

```js
    const onion = getEditorHost().projects.project.settings.onion;
    for (const r of onionStepRows) {
      const backOverride = onion.stepColors.back[r.k];
      r.backDefault.checked = backOverride == null;
      r.backColor.value = backOverride ?? onion.backColor;
      syncOnionStepActive(r.backDefault, r.backColor);
      const aheadOverride = onion.stepColors.ahead[r.k];
      r.aheadDefault.checked = aheadOverride == null;
      r.aheadColor.value = aheadOverride ?? onion.aheadColor;
      syncOnionStepActive(r.aheadDefault, r.aheadColor);
    }
```

Replace the one write inside `psOk`'s click handler (`state.onion.stepColors = stepColors;`):

```js
    getEditorHost().projects.project.settings.onion.stepColors = stepColors;
```

Replace `openProjectSettings`'s guard (`const project = state.project; if (!project) return;`) and the two `isEnabled: () => !!state.project` checks (on `edit.projectSettings`/`edit.onionStepColors`) with `getEditorHost().projects.project`.

#### Step 6: `project-controller.js` — replace remaining `state.dirty`/`state.commands.push` reads

`file.new`'s `run` reads `state.dirty` (`if (state.dirty && !confirmOrAuto(...))`) — **leave as-is**, fed by Step 2's new dirty-mirror subscription in `file-controller.js` (both files mount at app start, order doesn't matter since the mirror only needs to exist by the time a user interacts with the UI, and `mountFileController()` runs before any user input is possible).

Replace `psOk`'s `state.commands.push({...})` with `getEditorHost().history.execute({...})` (cmd body unchanged, per Global Constraints) and `markDirty()` calls with `getEditorHost().projects.markDirty()`:

```js
    getEditorHost().history.execute({
      label: 'edit project settings',
      do() { project.name = afterName; project.settings = { ...afterSettings }; },
      undo() { project.name = beforeName; project.settings = { ...beforeSettings }; },
    });
```

(`project`/`afterName`/`afterSettings`/`beforeName`/`beforeSettings` are already resolved as local `const`s earlier in `psOk`'s handler — only the `state.commands.push(...)` call itself changes, not its argument object.) Below that, replace the trailing `markDirty();` (after the onion `stepColors` write) with `getEditorHost().projects.markDirty();`.

#### Step 7: `project-controller.js` — update import line and add `getEditorHost`

Replace the import line:

```js
import { state, confirmOrAuto } from '../../app/state.js';
import { DEFAULT_SETTINGS } from '../../core/model.js';
import { PLATFORMS } from '../../core/platforms.js';
import { MAX_PALETTE_COLORS } from '../../core/pixelSnapper.js';
import { buildBaseDurationControl } from '../../components/panels/base-duration-control.js';
import { defineAction } from '../../app/actions.js';
import { markDefaultAction } from '../../components/dialogs.js';
import { getEditorHost } from '../../host/runtime.js';
```

`setProject`/`newDefaultProject`/`markDirty` are dropped (no longer called directly — `newDefaultProject` is still called, but now as an argument, same reasoning as file-controller.js's Step 3 — actually note `newDefaultProject` IS still used, in `npCreate`'s handler at Step 4 — **keep it in the import**, only `setProject` and `markDirty` are truly gone). Corrected import line:

```js
import { state, newDefaultProject, confirmOrAuto } from '../../app/state.js';
```

#### Step 8: Verify

Run: `npm test`
Expected: 631/631 passing.

Grep `file-controller.js` and `project-controller.js` for `state.commands`/`markDirty(` (bare, not `.markDirty(`)/`state.onion`/`setProject(` (bare legacy call, not `.setProject(`) — none should remain except the documented exceptions (`state.dirty`/`state.fileHandle`/`state.dirHandle`/`state.saveMode` reads/writes, explicitly out of scope per Steps 2/4).

#### Step 9: Commit

```bash
git add js/features/project/file-controller.js js/features/project/project-controller.js
git commit -m "refactor: retire legacy setProject()/state.commands/state.onion in file-controller.js + project-controller.js"
```

---

### Task 3: `filter-controller.js` + `float-session.js` — undo-stack retirement

`float-session.js` is not one of the design doc's named 6 files but is a hard co-dependency (`document-controller.js`'s cut/copy/paste actions and `filter-controller.js`'s `commitFloatIfAny()` calls both reach into it; it has 6 of its own `state.commands.push` sites). Both files move their command dispatch onto `editorHost.history.execute()` in this task.

**Files:**
- Modify: `js/features/transforms/filter-controller.js` (currently 745 lines, after the emit/commitFloatIfAny/currentEditRegion hotfix)
- Modify: `js/components/canvas/float-session.js` (currently 490 lines)

**Interfaces:**
- Consumes: `EditorHost.history.execute(command)` (same as Tasks 1-2).
- Produces: `float-session.js`'s exported API (`registerFloatView`, `currentEditRegion`, `createFloat`, `commitFloatIfAny`, `cancelFloatIfAny`, `syncFrameFloat`, `pushTransformCommand`, `cutSelection`, `copySelection`, `hasSelection`, `pasteClipboard`, `paste`, `initFloatSession`, `isTypingTarget`) is unchanged in shape — consumed by Task 1's `document-controller.js` (already done) and by every mode's move-tool presenter (untouched by this plan, out of scope — Group 3's job).

#### Step 1: `float-session.js` — replace all 6 `state.commands.push` sites with `editorHost.history.execute`

Every site pushes a `{label, do, undo}` object identical in body to before — only the call itself changes. Sites (by their function): `createFloat` (`state.commands.push({label: 'float selection', ...})`), `commitFloatIfAny` (`state.commands.push({label: 'commit float', ...})`), `cancelFloatIfAny` (`state.commands.push({label: 'cancel float', ...})`), `pushTransformCommand` (`state.commands.push({label: 'transform float', ...})`), `clipboardCapture` (`state.commands.push({label: 'cut', ...})`), `installPastedFloat` (`state.commands.push({label: 'paste', ...})`).

Replace each bare `state.commands.push(` with `getEditorHost().history.execute(` — the cmd object literal that follows is unchanged in every case. Example (`createFloat`'s site):

```js
  getEditorHost().history.execute({
    label: 'float selection',
    do() {
      for (const { layerId } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) fillRegion(l.bitmap, reg.x, reg.y, reg.w, reg.h, [0, 0, 0, 0]);
      }
      state.floating = float;
      floatCtx = ctx;
      views.get(ctx.viewKind)?.setSelection(null); // float outline replaces the marquee
      emit('pixels');
    },
    undo() {
      for (const { layerId, buffer } of captured) {
        const l = layerIn(sheet, layerId);
        if (l) blitRegion(l.bitmap, buffer, reg.x, reg.y);
      }
      state.floating = null;
      floatCtx = null;
      views.get(ctx.viewKind)?.setSelection(prevSelection ? { ...prevSelection } : null);
      emit('pixels');
    },
  });
```

Apply the identical mechanical transform (`state.commands.push(` → `getEditorHost().history.execute(`, body untouched) to the other 5 sites.

`state.floating`/`floatCtx`/`emit('pixels')`/`views.get(...)` inside every `do()`/`undo()` stay exactly as-is — `state.floating` (the float buffer itself) and `'pixels'`/`'selection'`-adjacent view-selection sync are explicitly out of scope for this migration (design doc field mapping: `floating` → "Local module state in the relocated float-session.js — ephemeral interaction state"), same reasoning as Task 1 Steps 12-13's kept `on('pixels', ...)`/`on('selection', ...)`.

`markDirty()` calls (5 sites: `createFloat`, `commitFloatIfAny`, `cancelFloatIfAny`, `clipboardCapture`, `installPastedFloat` — `pushTransformCommand` deliberately has none, per its own comment "no markDirty: bitmaps unchanged") become `getEditorHost().projects.markDirty()`.

#### Step 2: `float-session.js` — add `getEditorHost` import

Add to the import block (currently 7 lines):

```js
import { state, on, emit, activeSheet, activeLayer, activeLayerScope, maybeSnapPixels } from '../../app/state.js';
import { copyRegion, fillRegion, blitRegion, blitOver, cloneBitmap, createBitmap } from '../../core/pixels.js';
import { findLayer } from '../../core/model.js';
import { makeTransform, isIdentity, rasterizeFloat, floatBounds } from '../../core/floating.js';
import { decodePng } from '../../app/pngcodec.js';
import { exportPngBlob } from '../../app/io.js';
import { isTypingTarget } from '../dom-utils.js';
import { getEditorHost } from '../../host/runtime.js';
```

`markDirty` is dropped from the `state.js` import (no longer called directly, per Step 1's mechanical replacement).

#### Step 3: `float-session.js` — `initFloatSession`'s `on('project', ...)` listener stays on the legacy bus

`initFloatSession()`'s `on('project', () => { if (state.project === lastProject) return; ...})` (near the end of the file) detects a project REPLACEMENT (New/Open) to drop any in-flight float without pushing a command (since the command stack was just cleared). This is **left unchanged** — it's driven by `state.project` identity, and `state.project` itself is legacy-owned and out of scope for this whole plan (it's `EditorStore.project.model` that's now authoritative; `state.project`'s only remaining writer after this whole plan is `legacy-state-adapter.js`, which is still alive until Task 5). This one `on('project', ...)` site is intentionally NOT touched by this task — Task 5, which deletes the adapter and every remaining `state.*` write, is where this listener's fate gets decided (likely: redirect to `editorHost.store.subscribe(s => s.project.model, ...)`, matching Task 1 Step 13's pattern — but that redirect belongs to Task 5, not this task, since until Task 5 the adapter is still the only thing keeping `state.project` in sync with reality at all).

#### Step 4: `filter-controller.js` — replace all 3 `state.commands.push` sites

Sites: `quantizeToPalette`, `commitChromaKey`, `commitCheckerboard` — each already calls `markDirty()` right after. Replace both:

```js
  function quantizeToPalette(mode, param, allLayers, preferOpaque = false) {
    commitFloatIfAny();
    const result = computeQuantizePatches(mode, param, allLayers, preferOpaque);
    if (!result || !result.patches.length) return;
    const { region, patches } = result;
    getEditorHost().history.execute({
      label: 'quantize to palette',
      do() { for (const p of patches) blitRegion(p.layer.bitmap, p.after, region.x, region.y); emit('pixels'); },
      undo() { for (const p of patches) blitRegion(p.layer.bitmap, p.before, region.x, region.y); emit('pixels'); },
    });
    getEditorHost().projects.markDirty();
  }
```

Apply the identical transform to `commitChromaKey` (`label: 'chroma key'`) and `commitCheckerboard` (`label: 'remove checkerboard'`).

#### Step 5: `filter-controller.js` — add `getEditorHost` import, drop `markDirty` from `state.js` import

Update the import line (post-hotfix, currently line 1 plus the new line 4 float-session import):

```js
import { state, on, emit, activeSheet, activeLayer, activeLayerScope, currentContextLayers } from '../../app/state.js';
import { MAX_PALETTE_COLORS } from '../../core/pixelSnapper.js';
import { copyRegion, cloneBitmap, blitRegion } from '../../core/pixels.js';
import { commitFloatIfAny, currentEditRegion } from '../../components/canvas/float-session.js';
```

(`markDirty` dropped — replaced by `getEditorHost().projects.markDirty()` per Step 4.) Add `import { getEditorHost } from '../../host/runtime.js';` as a new import line.

#### Step 6: Verify

Run: `npm test`
Expected: 631/631 passing.

Grep both files for bare `state.commands`/`markDirty(` (not `.markDirty(`) — none should remain.

#### Step 7: Commit

```bash
git add js/features/transforms/filter-controller.js js/components/canvas/float-session.js
git commit -m "refactor: retire legacy state.commands undo-stack calls in filter-controller.js + float-session.js"
```

---

### Task 4: `menu-controller.js` — verification pass (no legacy coupling to remove)

This file has zero `state`/`on`/`emit` imports (confirmed by direct read) — its only risk is indirect: if Tasks 1-3 renamed or removed an action id its `MENUS` array references, menu items silently vanish rather than erroring (per `menubar.js`'s own "skips any item whose action id isn't registered yet" behavior, referenced in this file's own comment at the top of the `MENUS` array).

**Files:**
- Verify only: `js/features/shell/menu-controller.js` (no edits expected)

**Interfaces:**
- Consumes: every action id in `MENUS` (`file.new`, `file.open`, `file.save`, `file.saveAs`, `file.export`, `document.newSheet`, `document.importSheet`, `document.renameSheet`, `document.deleteSheet`, `document.exportSheet`, `document.exportAnimation`, `document.exportMap`, `layer.add`, `layer.addGroup`, `layer.delete`, `layer.mergeDown`, `edit.undo`, `edit.redo`, `edit.cut`, `edit.copy`, `edit.paste`, `edit.filters`, `edit.projectSettings`, `view.toggleLabels`, `view.toggleSequences`, `view.zoomIn`, `view.zoomOut`, `view.actualSize`, `view.zoomToFit`, `help.shortcuts`, `help.about`) — Tasks 1-3 register or leave unchanged every one of these except `edit.onionStepColors`, which `MENUS` never references (it's reached only via Project Settings' own dialog tab switcher, not the menu bar — confirmed by grep, no action needed).

#### Step 1: Grep-verify every `MENUS` action id still has a `defineAction` call after Tasks 1-3

```bash
grep -oE "action: '[a-zA-Z.]+'" js/features/shell/menu-controller.js | sed "s/action: '//;s/'$//" | sort -u > /tmp/menu-ids.txt
grep -rhoE "defineAction\('[a-zA-Z.]+'" js/features/ | sed "s/defineAction('//" | sort -u > /tmp/defined-ids.txt
comm -23 /tmp/menu-ids.txt /tmp/defined-ids.txt
```

Expected: empty output (every `MENUS` id has a matching `defineAction` call somewhere under `js/features/`). If any id appears in the `comm` output, one of Tasks 1-3 renamed or dropped an action `menu-controller.js` still expects — go back and fix the task that owns it before proceeding (do not edit `menu-controller.js` itself to work around it; the fix belongs in whichever task's rewrite broke the action id).

#### Step 2: Manual spot-check (no automated coverage for menu clicks)

Since this step needs a live app, and per established project policy the user does all live/e2e verification personally: note in the task report that File/Document/Layer/Edit/View/Help menus should each be opened once and visually confirmed to show all their expected items (none silently missing) — this is a line item for the plan's overall manual checklist (see "Manual verification checklist" below), not something this task's implementer does themselves.

#### Step 3: Commit (only if Step 1 required a fix elsewhere; otherwise this task produces no diff)

If Step 1 was clean, there is nothing to commit for this task — record in the SDD ledger that Task 4 was a verification-only pass with zero findings, matching Group 2's Task 4 precedent (`a49e1f7`, "zero findings" recorded in that group's ledger).

---

### Task 5: Delete `legacy-state-adapter.js`, consolidate `bootstrap.js`/`main.js`, add the architecture-test guard

**Files:**
- Delete: `js/features/project/legacy-state-adapter.js`
- Delete: `js/app/main.js`
- Modify: `js/bootstrap.js` (currently 36 lines)
- Modify: `js/components/canvas/float-session.js` (the one remaining `on('project', ...)` site from Task 3 Step 3)
- Modify: `js/features/project/file-controller.js` (remove Task 2 Step 2's dirty-mirror subscription, now redundant)
- Modify: `tests/architecture.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task is pure deletion/consolidation once nothing references the deleted files.

#### Step 1: Confirm `document-controller.js` is the only remaining importer of `legacy-state-adapter.js`

```bash
grep -rl "legacy-state-adapter" js/
```

Expected: no matches (Task 1 Step 2 already removed `document-controller.js`'s import and call). If any match remains, stop — Task 1 was not actually completed correctly; fix it there, not here.

#### Step 2: Delete `legacy-state-adapter.js`

```bash
rm js/features/project/legacy-state-adapter.js
```

#### Step 3: `float-session.js` — redirect the one remaining `on('project', ...)` listener (from Task 3 Step 3) to `EditorStore`

Replace `initFloatSession`'s project-replacement detector:

```js
export function initFloatSession() {
  on('tool', () => { if (state.tool !== 'move') commitFloatIfAny(); });
  on('view', () => {
    if (!state.floating || !floatCtx) return;
    if (state.activeSheetId !== state.floating.sheetId || state.view !== floatCtx.viewKind) commitFloatIfAny();
  });
  // project REPLACEMENT (New/Open) drops the float without a command — the
  // command stack was cleared and the old bitmaps are gone
  getEditorHost().store.subscribe(
    s => s.project.model,
    () => { state.floating = null; floatCtx = null; },
    { equals: () => false },
  );
  window.addEventListener('keydown', onKeydown, true);
}
```

Note `{ equals: () => false }` — this subscription must fire on EVERY project-model change, not just identity-diff ones (the original used a hand-rolled `lastProject` identity tracker; `EditorStore.subscribe`'s default `equals: Object.is` would already give the same identity-diff behavior for a `project.model` selector, since `Object.is` on two different object references is always `false` — so actually the default equals is sufficient and `{equals: () => false}` is unnecessary noise; use the default, no `equals` option needed:

```js
  getEditorHost().store.subscribe(
    s => s.project.model,
    () => { state.floating = null; floatCtx = null; },
  );
```

`on('tool', ...)`/`on('view', ...)` (the other two listeners in `initFloatSession`) stay on the legacy bus — they read `state.floating`/`state.activeSheetId`/`state.view`, all explicitly out of scope for this whole plan (ephemeral float state, and `activeSheetId`/`view` are the exact two fields Task 1 stopped writing to `state.*` for `document-controller.js`'s own purposes but did NOT stop `legacy-state-adapter.js` from writing during Tasks 1-4 — wait: **`legacy-state-adapter.js` is deleted in this same task (Step 2, above)**, so by the time Step 3 runs, nothing writes `state.activeSheetId`/`state.view` anymore at all. This makes the `on('view', ...)` listener's `state.activeSheetId !== state.floating.sheetId || state.view !== floatCtx.viewKind` check permanently stale/frozen at whatever value they last held before Task 5 deleted the adapter — a real behavior gap this task must close, not defer further (there is no Task 6 to defer to).

**Corrected Step 3** — replace the entire `on('tool', ...)`/`on('view', ...)`/adapter-detector block together, since `state.mode`/`state.activeSheetId`/`state.view`/`state.tool` all go stale in the same moment (right when Step 2 deletes the adapter that was their only remaining writer):

```js
export function initFloatSession() {
  const editorHost = getEditorHost();
  editorHost.store.subscribe(s => s.session.activeToolId, toolId => { if (toolId !== 'move') commitFloatIfAny(); });
  editorHost.store.subscribe(
    s => [s.session.activeDocument, s.session.activeViewId],
    ([activeDocument, activeViewId]) => {
      if (!state.floating || !floatCtx) return;
      const floatDoc = { kind: sheetKindOf(state.floating.sheetId)?.kind, id: state.floating.sheetId };
      if (!activeDocument || activeDocument.id !== state.floating.sheetId || activeViewId !== floatCtx.viewKind) commitFloatIfAny();
    },
    { equals: (a, b) => a[0]?.id === b[0]?.id && a[0]?.kind === b[0]?.kind && a[1] === b[1] },
  );
  editorHost.store.subscribe(s => s.project.model, () => { state.floating = null; floatCtx = null; });
  window.addEventListener('keydown', onKeydown, true);
}
```

This needs a small helper `sheetKindOf` to resolve a sheet id back to its document kind (`sheet-document` shape needs both `kind` and `id`, but `float.sheetId` only stores the id) — add above `initFloatSession`:

```js
function sheetKindOf(sheetId) {
  return sheetById(sheetId) ? { kind: undefined } : null; // placeholder — see note below
}
```

**This helper is a placeholder that must NOT ship as-is** — flag this exact spot for the task's own reviewer: the cleanest real fix is to store `viewKind`/`kind` alongside `sheetId` in `float.sheetId`'s existing container (`floatCtx.viewKind` already exists, but there is no `floatCtx.documentKind`). The simplest correct fix, avoiding the placeholder above entirely, is to compare using `floatCtx` alone (which already carries everything needed) instead of re-deriving a document reference from `state.floating.sheetId`:

```js
  editorHost.store.subscribe(
    s => [s.session.activeDocument, s.session.activeViewId],
    ([activeDocument, activeViewId]) => {
      if (!state.floating || !floatCtx) return;
      if (activeDocument?.id !== state.floating.sheetId || activeViewId !== floatCtx.viewKind) commitFloatIfAny();
    },
    { equals: (a, b) => a[0]?.id === b[0]?.id && a[1] === b[1] },
  );
```

This drops the `sheetKindOf` helper entirely — `activeDocument?.id !== state.floating.sheetId` is exactly as precise as the original `state.activeSheetId !== state.floating.sheetId` check (both compare bare ids), and doesn't need the document's `kind` at all (the original legacy check didn't compare kind either). Use this version, not the placeholder above.

#### Step 4: `file-controller.js` — remove Task 2's dirty-mirror subscription

**Scope note:** this step removes ONLY the `state.dirty` mirror. Task 2 also added two more mirrors in the same location, for `state.project`/`state.activeSheetId`/`state.activeMapId` (see Task 2 Step 2's 2026-08-17 amendment and the plan's Global Constraints amendment) — those two are deliberately NOT removed here. They stay load-bearing past this entire plan, until Group 3 migrates its ~29 files off direct `state.project` reads. Do not touch them in this step.

Now that nothing but `file-controller.js` itself reads `state.dirty` (Task 2 Step 2 confirmed this), and now that the adapter is gone, decide: does anything still need `state.dirty` to exist at all? Grep:

```bash
grep -rn "state\.dirty" js/
```

If the only remaining matches are inside `file-controller.js` itself (the `file.open`/`file.new`/`beforeunload`/autosave guards) and `project-controller.js`'s `file.new` guard, **replace all of them** with direct `getEditorHost().projects.dirty` reads, and delete Task 2 Step 2's mirror subscription entirely:

```js
// file-controller.js: replace every `state.dirty` read with:
getEditorHost().projects.dirty
```

```js
// project-controller.js's file.new guard: replace `state.dirty` with:
getEditorHost().projects.dirty
```

Delete the `getEditorHost().store.subscribe(s => s.project.dirty, dirty => { state.dirty = dirty; }, {fireImmediately: true});` block Task 2 Step 2 added — it has no remaining purpose once nothing reads `state.dirty`.

#### Step 5: Confirm zero remaining `state.*`/`on(`/`emit(` references anywhere in the 6 controller files + `float-session.js`

```bash
grep -n "from '.*app/state.js'" js/features/project/document-controller.js js/features/project/file-controller.js js/features/project/project-controller.js js/features/transforms/filter-controller.js js/features/shell/menu-controller.js js/features/workbench/editor-workbench.js js/components/canvas/float-session.js
```

Every remaining import from `app/state.js` across these 7 files should only list genuinely-out-of-scope names per this plan's documented exceptions: `activeSheet`, `activeMap`, `activeLayer`, `confirmOrAuto`, `maybeSnapPixels`, `AUTOTEST`, `newDefaultProject`, and the bare `state` object itself **only** where used for `state.floating`/`state.brushSize`/`state.primary`/`state.secondary`/`state.fileHandle`/`state.dirHandle`/`state.saveMode`/`state.tool` (the last one only inside `float-session.js`'s `installPastedFloat`, setting `state.tool = 'move'` — also out of scope, tool-config field) — plus `on`/`emit` only in `editor-workbench.js` (brushSize/colors/pixels/selection) and `float-session.js`'s `on('tool', ...)`... wait, Step 3 above already converted `float-session.js`'s `on('tool', ...)` to `store.subscribe` — **re-verify Step 3 landed correctly here**: after Step 3, `float-session.js` should have ZERO remaining `on(`/`emit(` calls except `emit('pixels')` inside command `do()`/`undo()` bodies (Task 3 Step 1 explicitly kept these) and `emit('tool')` inside `installPastedFloat` (also kept, tool-config field write). If `on('tool', ...)` or `on('view', ...)` (the bare event-subscription form, not `emit(...)`) still appear in `float-session.js` after this task, Step 3 was not applied correctly.

If `state.js`'s `setProject`/`markDirty`/`on`/`emit` (the free functions, not property access) appear as an IMPORT anywhere in these 7 files, that import is dead and must be removed.

#### Step 6: `bootstrap.js` — absorb `main.js`'s 6 `mount*` calls, stop injecting `historyStack`

Replace the whole file:

```js
import { EditorHost } from './host/editor-host.js';
import { setEditorHost, getEditorHost } from './host/runtime.js';
import { BrowserPreferences } from './platform/browser/preferences.js';
import { BrowserFileSystem } from './platform/browser/file-system.js';
import { BrowserAutosave } from './platform/browser/autosave.js';
import { BrowserClipboard } from './platform/browser/clipboard.js';
import { BrowserImageCodec } from './platform/browser/image-codec.js';
import { spriteMode } from './modes/sprites/index.js';
import { tileMode } from './modes/tiles/index.js';
import { mapMode } from './modes/maps/index.js';
import { mountEditorWorkbench } from './features/workbench/editor-workbench.js';
import { mountFilterController } from './features/transforms/filter-controller.js';
import { mountProjectController } from './features/project/project-controller.js';
import { mountDocumentController } from './features/project/document-controller.js';
import { mountApplicationMenu } from './features/shell/menu-controller.js';
import { mountFileController } from './features/project/file-controller.js';

export const editorHost = new EditorHost({
  preferences: new BrowserPreferences(),
  platform: {
    files: new BrowserFileSystem(),
    autosave: new BrowserAutosave(),
    clipboard: new BrowserClipboard(),
    imageCodec: new BrowserImageCodec(),
  },
});

editorHost.registerMode(spriteMode);
editorHost.registerMode(tileMode);
editorHost.registerMode(mapMode);
editorHost.start('sprites');
setEditorHost(editorHost);

const workbench = mountEditorWorkbench();
mountFilterController(workbench);
mountProjectController();
mountDocumentController({ editorHost, workbench });
mountApplicationMenu();
mountFileController();
```

`historyStack: legacyState.commands` is dropped from the `EditorHost` constructor call — `HistoryService`'s constructor already defaults to `new CommandStack()` when `stack` is undefined (`history-service.js:15`), so omitting the option is sufficient; no explicit replacement value needed. `import { state as legacyState } from './app/state.js';` and the trailing `import('./app/main.js').catch(...)` dynamic import are both dropped — nothing in this file needs `js/app/state.js` anymore, and `main.js` is deleted in the next step.

#### Step 7: Delete `main.js`

```bash
rm js/app/main.js
```

#### Step 8: `tests/architecture.test.mjs` — add the Group 4 regression guard, repoint the retired `main.js` cap

Find the existing test asserting `js/app/main.js` stays ≤30 lines (per the design doc's citation, "architecture.test.mjs already caps main.js at ≤30 lines") — this test now fails differently: the file no longer exists. Replace that assertion with two things: (1) a guard that nothing imports `js/app/state.js` from the 6 files this plan touched, matching the exact pattern Group 2's `a49e1f7` used for `js/ui`; (2) removal of the now-meaningless line-count cap (there is no more `main.js` to cap).

Add (mirroring Group 2's `'nothing imports the retired js/ui directory'` test structure — same file, same helper functions for walking `js/` and reading each file):

```js
test('nothing in the shell controllers imports the legacy js/app/state.js event bus', () => {
  const SHELL_FILES = [
    'js/features/project/document-controller.js',
    'js/features/project/file-controller.js',
    'js/features/project/project-controller.js',
    'js/features/transforms/filter-controller.js',
    'js/features/shell/menu-controller.js',
    'js/features/workbench/editor-workbench.js',
    'js/components/canvas/float-session.js',
  ];
  const offenders = [];
  for (const relPath of SHELL_FILES) {
    const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    const importMatch = text.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*app\/state\.js['"]/);
    if (!importMatch) continue;
    const names = importMatch[1].split(',').map(n => n.trim()).filter(Boolean);
    const banned = names.filter(n => ['on', 'emit', 'setProject', 'markDirty'].includes(n));
    if (banned.length) offenders.push(`${relPath}: ${banned.join(', ')}`);
  }
  assert.deepStrictEqual(offenders, [], `these shell files still import banned legacy state.js exports:\n${offenders.join('\n')}`);
});
```

(This mirrors the exact non-vacuous-verification discipline Group 2's final review applied to its own architecture-test addition: before trusting this test, run the same regex over the pre-Task-1 baseline commit — it should find `on`/`emit`/`setProject`/`markDirty` imports in multiple of the 7 files — and over the post-Task-5 HEAD — it should find zero — exactly as Group 2's reviewer did for the `js/ui` guard. Do this verification as part of this task's own step, not deferred to a later review.)

Remove or update whatever existing test asserted `js/app/main.js`'s line count — search `tests/architecture.test.mjs` for `main.js` and delete that test block entirely (the file no longer exists, so the assertion is meaningless, not just outdated).

Also grep `tests/architecture.test.mjs` and every other file under `tests/` for any reference to `legacy-state-adapter.js` or `js/app/main.js` by path string — if the test suite imports either file directly anywhere (unlikely, but verify), that import breaks now and needs removing too.

#### Step 9: Verify

Run: `npm test`
Expected: all previous 631 tests pass, plus this task's 1 new test = 632 passing, 0 failures.

Run the pre/post regex check described in Step 8's parenthetical by hand against `git show <Task-1-base-commit>:js/features/project/document-controller.js` etc., to confirm the new test is non-vacuous (mirrors Group 2's final-review verification of its own `js/ui` guard).

#### Step 10: Commit

```bash
git add -A js/features/project/legacy-state-adapter.js js/app/main.js js/bootstrap.js js/components/canvas/float-session.js js/features/project/file-controller.js tests/architecture.test.mjs
git commit -m "chore: delete legacy-state-adapter.js + js/app/main.js, absorb mount calls into bootstrap.js, guard against legacy state.js re-imports"
```

---

## Explicitly out of scope for this plan

Named here so implementers and reviewers don't treat these as missed work:

- **`state.selectedTileId`, `state.selectedTerrainSetId`, `state.editingFrameId`, `state.editingTileId`** stay legacy-owned throughout this whole plan — they're written by tiles/sprites mode files this plan never touches (Group 3's job, per the design doc's field-mapping table).
- **`state.floating`, `state.brushSize`, `state.primary`, `state.secondary`, `state.fileHandle`, `state.dirHandle`, `state.saveMode`, `state.tool`'s writes from `installPastedFloat`** stay as direct `state.*` reads/writes throughout — all explicitly named in the design doc's field-mapping table as staying local/module-level, not `EditorStore`-owned.
- **`on('pixels', ...)`/`emit('pixels')` and `on('selection', ...)`/`emit('selection')`** stay on the legacy bus everywhere in this plan — retiring these two events project-wide requires migrating every mode file that still emits them (`drawing-engine.js`, `layers-panel.js`, every mode's Command Handlers), which is Group 3's scope, not Group 4's.
- **`js/app/state.js` itself is NOT deleted by this plan** — it still exports `state`, `on`, `emit`, `activeSheet`, `activeMap`, `activeLayer`, `currentContextLayers`, `activeLayerScope`, `maybeSnapPixels`, `confirmOrAuto`, `AUTOTEST`, `newDefaultProject`, and (unused after this plan, but still exported and used by the ~29 not-yet-migrated mode files) `setProject`/`markDirty`. Deleting `state.js` is Group 5's job, once Group 3 finishes migrating the mode files that still depend on it.
- **The 3 pre-existing missing-import bugs found and fixed while researching this plan** (`file-controller.js`'s `commitFloatIfAny`/`copyRegion`, `filter-controller.js`'s `emit`/`commitFloatIfAny`/`currentEditRegion`, `project-controller.js`'s `MAX_PALETTE_COLORS`) were already fixed as standalone hotfixes (`dd8f9ef`, `f56dcea`, `ab60570`) before this plan was written — this plan's line-number citations are against that already-fixed HEAD (`ab60570`), not the original broken state.

## Manual verification checklist

Per established project policy, the user performs all live/e2e verification personally — no Playwright automation for this plan. After each task lands, spot-check:

- **Task 1:** switch between Sprites/Tiles/Maps tabs repeatedly (including from Maps back to a sheet — the `fitSheet()` recenter path); use the sheet/map dropdown selector; toggle View → Show Labels / Show Sequences; Ctrl+Z/Ctrl+Y repeatedly after several edits; the status bar's tool name and platform-compatibility indicator while switching frame/tile editors.
- **Task 2:** New Project; Open an existing `.pixelproj`; confirm the title bar / dirty indicator (however it's surfaced in the UI) correctly reflects unsaved changes and clears after Save; Project Settings dialog — especially the Onion Steps tab (per-step color overrides, Default checkboxes) — open it, change a step color, OK, reopen and confirm it stuck; confirm autosave-restore prompt still offers correctly on next load after a crash-simulated close (or skip if impractical to simulate).
- **Task 3:** Quantize to Palette, Chroma Key, and Remove Checkerboard — open each, adjust sliders (confirm live preview updates), OK, then Ctrl+Z/Ctrl+Y the result; Cut/Copy/Paste (internal clipboard and OS-clipboard image paste); float-selection commit (Enter) and cancel (Escape) with granular undo/redo afterward.
- **Task 4:** open every one of the 6 menus (File/Document/Layer/Edit/View/Help) and visually confirm every expected item is present, none silently missing.
- **Task 5:** full fresh page load (confirms `bootstrap.js`'s consolidated mount sequence works end-to-end); confirm no console errors on load in any of the 3 modes; general smoke pass across a few actions from each of Tasks 1-3's checklists once more, since Task 5 is where the last remaining legacy plumbing (the adapter) disappears and any silent breakage would first surface here.

## Self-Review

**1. Spec coverage:** Foundation items 1 (HistoryService's own CommandStack — Task 5 Step 6, dropping `historyStack: legacyState.commands`), 2 (EditorStore.project sole ownership — Task 2's `setProject()` retirement), and 3 (activeSheet/activeMap/activeLayer legacy-fallback removal — NOT attempted by this plan; see note below) are addressed except item 3. All 6 named shell-controller files (Task 1: 2 files, Task 2: 2 files, Task 3: 1 file + float-session.js, Task 4: 1 file verification) plus `legacy-state-adapter.js`/`bootstrap.js`/`main.js` (Task 5) are covered.

**Note on Foundation item 3:** this plan does NOT attempt to remove `activeSheet()`/`activeMap()`/`activeLayer()`'s legacy-fallback branches (`state.js`'s own functions, e.g. `activeLayer()`'s `host ? host.selections.get(...) : state.activeLayerId`) — the design doc's amendment says this was already attempted once, reverted after 2 live regressions, and its root cause (adapter-replay timing) is what Task 1 Steps 1-4/15 fix. Once this plan lands, item 3 becomes safe to re-attempt (the timing gap is closed), but re-attempting it is NOT part of this plan — it would touch `state.js` itself, which every task above explicitly leaves alone (`state.js` deletion is Group 5's job). Flag this as a natural, low-risk follow-up once this plan's Task 5 is verified stable, but do not fold it into this plan's scope.

**2. Placeholder scan:** the one true placeholder in this plan (Task 5 Step 3's first-draft `sheetKindOf` helper) is explicitly called out as NOT-to-ship, with the actual correct replacement code given immediately after it — this is intentional plan content (showing the wrong path and the right one, since the wrong one was a real dead-end discovered while drafting this plan), not an unresolved gap. No other placeholders found.

**3. Type consistency:** `getEditorHost()` is used consistently as the accessor across all 5 tasks (never `editorHost` as a bare unimported identifier except inside `document-controller.js`/`editor-workbench.js`, which already receive/create it locally). `{label, do, undo}` command-object shape is identical everywhere `editorHost.history.execute()` is called. `EditorStore.subscribe`'s `(selector, listener, {equals, fireImmediately})` signature is used consistently.
