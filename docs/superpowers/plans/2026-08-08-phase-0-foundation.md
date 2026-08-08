# Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `js/application` into `js/host` (Application layer consolidation), add a store-write transaction path for future Command Handlers, and land the layer-boundary enforcement tests — with zero behavior change to any mode.

**Architecture:** This is Phase 0 of [docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md](../specs/2026-08-08-ddd-target-architecture-design.md). It's pure scaffolding: no mode's runtime behavior changes. It moves 7 files, adds one new method, and adds two new architecture tests that are currently vacuous (0 files match their scope) but will start enforcing real rules the moment Phase 1 creates `js/modes/maps/application/` and `js/modes/maps/presentation/`.

**Tech Stack:** Plain ES modules (no build step, no TypeScript, no framework), Node's built-in `node --test` runner.

## Global Constraints

- No build step, no dependencies, no TypeScript, no UI framework — plain hand-written ES modules only (spec's Non-goals/constraints section).
- No behavior change to any mode in this phase — this is scaffolding only (spec's Phase 0 row).
- Every phase must leave the app fully working; `project.json` save/load round-trips must keep passing unchanged (spec's Testing section).
- `js/host/workbench/**` is explicitly out of scope for the "Application never touches DOM" rule in this phase — `panel-manager.js` legitimately touches `document` today (DOM reconciliation for panel mounting) and is not being rewritten in Phase 0.

---

### Task 1: Merge `js/application` into `js/host`

**Files:**
- Move: `js/application/editor-store.js` → `js/host/editor-store.js`
- Move: `js/application/document-service.js` → `js/host/document-service.js`
- Move: `js/application/history-service.js` → `js/host/history-service.js`
- Move: `js/application/project-service.js` → `js/host/project-service.js`
- Move: `js/application/selection-service.js` → `js/host/selection-service.js`
- Move: `js/application/export-service.js` → `js/host/export-service.js`
- Move: `js/application/ports.js` → `js/host/ports.js`
- Modify: `js/host/editor-host.js:1-6`
- Modify: `tests/editorstore.test.mjs:3`
- Modify: `tests/historyservice.test.mjs:3-4`
- Modify: `docs/ARCHITECTURE.md` (5 spots, listed in steps below)

**Interfaces:**
- Consumes: nothing new — this is a pure relocation, no signature changes.
- Produces: `EditorStore`, `documentKey`, `DocumentService`, `HistoryService`, `ProjectService`, `SelectionService`, `ExportService` are now importable from `js/host/*.js` instead of `js/application/*.js`. Every later task in this plan, and every future phase, imports these from `js/host/`.

- [ ] **Step 1: Move the 7 files with `git mv`**

Run:
```bash
git mv js/application/editor-store.js js/host/editor-store.js
git mv js/application/document-service.js js/host/document-service.js
git mv js/application/history-service.js js/host/history-service.js
git mv js/application/project-service.js js/host/project-service.js
git mv js/application/selection-service.js js/host/selection-service.js
git mv js/application/export-service.js js/host/export-service.js
git mv js/application/ports.js js/host/ports.js
```

None of these 7 files import each other except `document-service.js`, which does `import { documentKey } from './editor-store.js';` — a same-directory relative import that stays correct since both files move into `js/host/` together. `history-service.js` imports `../core/commands.js`, which also stays correct: `js/host/` is the same depth under `js/` as `js/application/` was.

- [ ] **Step 2: Confirm the source directory is empty, then remove it**

Run: `git status` — `js/application/` should show no remaining tracked files.

Run: `rmdir js/application` (fails harmlessly if it's not actually empty — investigate before forcing if so).

- [ ] **Step 3: Update `js/host/editor-host.js`'s imports**

In `js/host/editor-host.js`, replace lines 1–6:

```js
import { EditorStore } from '../application/editor-store.js';
import { DocumentService } from '../application/document-service.js';
import { HistoryService } from '../application/history-service.js';
import { ProjectService } from '../application/project-service.js';
import { SelectionService } from '../application/selection-service.js';
import { ExportService } from '../application/export-service.js';
```

with:

```js
import { EditorStore } from './editor-store.js';
import { DocumentService } from './document-service.js';
import { HistoryService } from './history-service.js';
import { ProjectService } from './project-service.js';
import { SelectionService } from './selection-service.js';
import { ExportService } from './export-service.js';
```

- [ ] **Step 4: Update the two test files that import from the old path**

In `tests/editorstore.test.mjs`, replace line 3:

```js
import { EditorStore, documentKey } from '../js/application/editor-store.js';
```

with:

```js
import { EditorStore, documentKey } from '../js/host/editor-store.js';
```

In `tests/historyservice.test.mjs`, replace lines 3–4:

```js
import { EditorStore } from '../js/application/editor-store.js';
import { HistoryService } from '../js/application/history-service.js';
```

with:

```js
import { EditorStore } from '../js/host/editor-store.js';
import { HistoryService } from '../js/host/history-service.js';
```

- [ ] **Step 5: Run the full test suite and confirm no regressions**

Run: `npm test`
Expected: all tests pass, including `tests/editorstore.test.mjs`, `tests/historyservice.test.mjs`, `tests/host.test.mjs`, `tests/contributions.test.mjs`, `tests/builtinmodes.test.mjs`, `tests/actions.test.mjs`, and `tests/architecture.test.mjs`. This is a full-suite run (not a targeted one) because the moved files are shared foundation imported by most of the app — a targeted subset wouldn't catch a stray reference elsewhere.

- [ ] **Step 6: Update `docs/ARCHITECTURE.md` to reflect the merge**

Five spots need updating. In `docs/ARCHITECTURE.md`:

**(a)** Replace:

```
This document describes the code as it exists *today*. It is mid-migration:
a legacy globally-mutable app (`js/app`, `js/ui`) is being incrementally
wrapped by a newer host/registry framework (`js/host`, `js/application`,
`js/modes`, `js/features`). Both are live at once, bridged explicitly — see
[State model](#state-model).
```

with:

```
This document describes the code as it exists *today*. It is mid-migration:
a legacy globally-mutable app (`js/app`, `js/ui`) is being incrementally
wrapped by a newer host/registry framework (`js/host`, `js/modes`,
`js/features`). Both are live at once, bridged explicitly — see
[State model](#state-model).
```

**(b)** Replace:

```
js/host        framework: EditorHost, contribution registries, workbench
               primitives — knows nothing app-specific
js/application services on EditorStore: documents, history, selection,
               project, export
js/platform    concrete adapters (preferences, file-system, clipboard,
```

with:

```
js/host        framework: EditorHost, contribution registries, workbench
               primitives, and application services on EditorStore
               (documents, history, selection, project, export)
js/platform    concrete adapters (preferences, file-system, clipboard,
```

**(c)** In the layering `mermaid` block, replace:

```
    UI["js/ui<br/>(legacy panels/dialogs)"]
    APP["js/app<br/>(legacy state + actions)"]
    FEATURES["js/features<br/>(shell: workbench, menu, file I/O)"]
    MODES["js/modes<br/>(sprites, tiles, maps)"]
    PLATFORM["js/platform<br/>(browser adapters)"]
    APPLICATION["js/application<br/>(services on EditorStore)"]
    HOST["js/host<br/>(EditorHost, registries)"]
    CORE["js/core<br/>(engine: model, undo, palettes)"]
    DOMAIN["js/domain<br/>(pure doc-kind logic)"]

    FEATURES --> MODES
    FEATURES --> HOST
    FEATURES --> APP
    FEATURES --> UI
    MODES --> HOST
    MODES --> CORE
    MODES --> UI
    UI --> APP
    APP --> CORE
    HOST --> APPLICATION
    APPLICATION --> CORE
    PLATFORM --> HOST
    CORE --> DOMAIN
```

with:

```
    UI["js/ui<br/>(legacy panels/dialogs)"]
    APP["js/app<br/>(legacy state + actions)"]
    FEATURES["js/features<br/>(shell: workbench, menu, file I/O)"]
    MODES["js/modes<br/>(sprites, tiles, maps)"]
    PLATFORM["js/platform<br/>(browser adapters)"]
    HOST["js/host<br/>(EditorHost, registries, application services)"]
    CORE["js/core<br/>(engine: model, undo, palettes)"]
    DOMAIN["js/domain<br/>(pure doc-kind logic)"]

    FEATURES --> MODES
    FEATURES --> HOST
    FEATURES --> APP
    FEATURES --> UI
    MODES --> HOST
    MODES --> CORE
    MODES --> UI
    UI --> APP
    APP --> CORE
    HOST --> CORE
    PLATFORM --> HOST
    CORE --> DOMAIN
```

**(d)** Replace:

```
- `documents/history/projects/selections/exports/focus` — the application
  services from `js/application/*`, exposed individually and bundled as
  `services`
```

with:

```
- `documents/history/projects/selections/exports/focus` — the application
  services (now colocated in `js/host/*`), exposed individually and
  bundled as `services`
```

**(e)** Replace:

```
2. **New** — `js/application/editor-store.js`'s `EditorStore`: a small
```

with:

```
2. **New** — `js/host/editor-store.js`'s `EditorStore`: a small
```

- [ ] **Step 7: Commit**

```bash
git add js/host docs/ARCHITECTURE.md tests/editorstore.test.mjs tests/historyservice.test.mjs
git commit -m "Merge js/application into js/host (DDD Application layer consolidation)"
```

(`js/application` deletion is captured automatically by `git add js/host` picking up the `git mv` renames.)

---

### Task 2: Add `ProjectService.mutate()` — the store-write transaction path

**Files:**
- Modify: `js/host/project-service.js`
- Test: `tests/project-service.test.mjs` (new file)

**Interfaces:**
- Consumes: `EditorStore` from `js/host/editor-store.js` (Task 1) — specifically `getState()` and `transaction(reason, mutate)`.
- Produces: `ProjectService.prototype.mutate(reason, mutateFn)` — `mutateFn(project)` is called with the live `state.project.model` inside a single `store.transaction`, `state.project.dirty` is set to `true` automatically, and `mutate()` returns whatever `mutateFn` returned. Future Command Handlers (Phase 1+) call `context.services.projects.mutate('some.command.id', project => { /* core/model.js mutation */ })` instead of touching `store.transaction` directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/project-service.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';

test('ProjectService.mutate applies a callback to the live project model and marks dirty', () => {
  const store = new EditorStore();
  store.setProject({ sheets: [] }, { dirty: false });
  const projects = new ProjectService(store, null);

  const result = projects.mutate('sheets.add', project => {
    project.sheets.push({ id: 'sheet-1' });
    return project.sheets.length;
  });

  assert.equal(result, 1);
  assert.deepEqual(store.getState().project.model.sheets, [{ id: 'sheet-1' }]);
  assert.equal(store.getState().project.dirty, true);
});

test('ProjectService.mutate batches store notifications into a single transaction', () => {
  const store = new EditorStore();
  store.setProject({ sheets: [] }, { dirty: false });
  const projects = new ProjectService(store, null);
  let notifications = 0;
  store.subscribe(state => state.project.model.sheets.length, () => { notifications++; });

  projects.mutate('sheets.add', project => {
    project.sheets.push({ id: 'a' });
    project.sheets.push({ id: 'b' });
  });

  assert.equal(notifications, 1);
});

test('ProjectService.mutate throws when no project is loaded', () => {
  const store = new EditorStore();
  const projects = new ProjectService(store, null);
  assert.throws(() => projects.mutate('noop', () => {}), /no project is loaded/);
});

test('ProjectService.mutate throws when given a non-function callback', () => {
  const store = new EditorStore();
  store.setProject({ sheets: [] });
  const projects = new ProjectService(store, null);
  assert.throws(() => projects.mutate('noop', null), TypeError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/project-service.test.mjs`
Expected: FAIL — `projects.mutate is not a function` (the method doesn't exist yet).

- [ ] **Step 3: Implement `mutate()`**

In `js/host/project-service.js`, replace:

```js
  markDirty() { this.#store.markDirty(true); }
  markSaved() { this.#store.markDirty(false); }
}
```

with:

```js
  markDirty() { this.#store.markDirty(true); }
  markSaved() { this.#store.markDirty(false); }

  mutate(reason, mutateFn) {
    if (typeof mutateFn !== 'function') throw new TypeError('ProjectService.mutate requires a mutation callback');
    if (!this.#store.getState().project.model) throw new Error('Cannot mutate: no project is loaded');
    let result;
    this.#store.transaction(reason, state => {
      result = mutateFn(state.project.model);
      state.project.dirty = true;
    });
    return result;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/project-service.test.mjs`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add js/host/project-service.js tests/project-service.test.mjs
git commit -m "Add ProjectService.mutate() as the Command Handler write path"
```

---

### Task 3: Layer-boundary enforcement tests

**Files:**
- Modify: `tests/architecture.test.mjs`

**Interfaces:**
- Consumes: the existing `jsFiles(directory)` helper already defined at the top of `tests/architecture.test.mjs` (recursive `.js` file lister), and `join`/`readFile` already imported there.
- Produces: two new tests. Both currently pass vacuously (0 files match their scope, since no mode has an `application/` or `presentation/` folder yet) — they become real gates the moment Phase 1 creates `js/modes/maps/application/` and `js/modes/maps/presentation/`. This is intentional: the point of landing them in Phase 0 is that Phase 1's new files are TDD'd against a pre-existing rule instead of the rule being retrofitted afterward.

These are assertion-of-absence tests, the same shape as the existing `tests/architecture.test.mjs` tests (e.g. "pure core modules do not depend on application, UI, host, platform, or modes"). There's no failing-first cycle to demonstrate for an invariant that already holds — consistent with how every other test in this file works, the verification step is running the test and confirming it currently passes.

- [ ] **Step 1: Add `sep` to the existing `node:path` import**

In `tests/architecture.test.mjs`, replace line 4:

```js
import { join } from 'node:path';
```

with:

```js
import { join, sep } from 'node:path';
```

- [ ] **Step 2: Add the two new tests**

Append to the end of `tests/architecture.test.mjs`:

> **Note (found during execution):** a bare-word regex (`\bdocument\b`) false-positives
> on `js/host/document-service.js`, which legitimately uses `document` as a local
> variable/parameter name throughout (it's a *document* provider). The regex below
> matches concrete DOM/Canvas API surface (`document.getElementById(`, `.getContext(`,
> etc.) instead of the bare identifier, confirmed by testing it against
> `js/host/workbench/panel-manager.js`'s real `document.getElementById`/
> `document.createElement` calls (still correctly flagged — just excluded from this
> test's scope via the `workbench` filter, not because the regex fails to catch it).

```js
test('application-layer code (js/host, excluding workbench, and any mode application/ folders) never touches DOM or Canvas rendering', async () => {
  // Matches concrete DOM/Canvas API surface, not the word "document"/"window" used
  // as an ordinary identifier (this file's own domain vocabulary is "documents").
  const bannedGlobals = /document\.(?:getElementById|querySelector|querySelectorAll|createElement|createElementNS|createTextNode|createDocumentFragment|body|documentElement|activeElement|addEventListener|removeEventListener|dispatchEvent)\b|window\.(?:innerWidth|innerHeight|devicePixelRatio|requestAnimationFrame|cancelAnimationFrame|localStorage|sessionStorage|location|navigator|matchMedia|addEventListener|removeEventListener)\b|\balert\(|\bconfirm\(|\bprompt\(|CanvasRenderingContext2D|OffscreenCanvas|\.getContext\(/;

  const hostFiles = (await jsFiles(join(root, 'js/host')))
    .filter(file => !file.includes(`${sep}workbench${sep}`));
  const modeApplicationFiles = (await jsFiles(join(root, 'js/modes')))
    .filter(file => file.includes(`${sep}application${sep}`));

  for (const file of [...hostFiles, ...modeApplicationFiles]) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, bannedGlobals, file);
  }
});

test('presentation-layer mode code dispatches commands by id only, never imports command handlers directly', async () => {
  const presentationFiles = (await jsFiles(join(root, 'js/modes')))
    .filter(file => file.includes(`${sep}presentation${sep}`));

  for (const file of presentationFiles) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from\s+['"][^'"]*application[\\/]commands[\\/]/, file);
    assert.doesNotMatch(source, /from\s+['"][^'"]*core[\\/]commands\.js['"]/, file);
  }
});
```

- [ ] **Step 3: Run the new tests to verify they pass**

Run: `node --test tests/architecture.test.mjs`
Expected: PASS, all tests including the 2 new ones. The new tests iterate 0 files today (`js/host/workbench` is excluded, and no `application/`/`presentation/` mode subfolders exist yet), so they pass trivially — that's the expected, correct state for Phase 0.

- [ ] **Step 4: Run the full suite one more time**

Run: `npm test`
Expected: all tests pass. This closes out Phase 0 — confirm nothing elsewhere regressed from the combination of Tasks 1–3.

- [ ] **Step 5: Commit**

```bash
git add tests/architecture.test.mjs
git commit -m "Add layer-boundary enforcement tests for the Application/Presentation split"
```

---

## Self-Review

**Spec coverage:** Phase 0's row in the spec lists three deliverables — "Merge `js/application` → `js/host`" (Task 1), "add the store-write transaction path for Command Handlers" (Task 2), "land the layer-boundary tests" (Task 3). All three are covered. "No behavior change" is upheld — no mode file is touched by this plan.

**Placeholder scan:** No TBD/TODO. Every step has literal code, not a description of code.

**Type consistency:** `ProjectService.mutate(reason, mutateFn)` is used identically in its own definition (Task 2, Step 3) and its tests (Task 2, Step 1) — same parameter order, same behavior (mutateFn receives `project`, returns `result`). The two new architecture tests (Task 3) both reuse the exact `jsFiles`/`join`/`readFile`/`assert.doesNotMatch` names already established at the top of `tests/architecture.test.mjs` — no new helper names invented that could drift.

**Scope check:** Single phase, ~15 files touched total, no sub-decomposition needed.
