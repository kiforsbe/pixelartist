# Phase 4, Group 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the host-side groundwork Phase 4's later groups depend on — a
new session-only `workspace.overlays` field, a merge-safe selection-write
helper, and host-primary reads for `activeSheet()`/`activeMap()` — with zero
behavior change and zero call-site edits in any mode or shell file.

**Architecture:** Three small, independent, additive changes to
`js/host/editor-store.js`, `js/host/selection-service.js`, and
`js/app/state.js`. Each is backward compatible on its own: nothing currently
reads the new `overlays` field, `SelectionService.patch()` is a new method
alongside the existing ones, and `activeSheet()`/`activeMap()` keep their
existing legacy-id fallback for when no `EditorHost` is configured (all
current unit tests exercise that no-host path and must keep passing
unmodified).

**Tech Stack:** Vanilla ES modules, `node --test` (Node's built-in test
runner, no framework), no build step.

**Spec:** [docs/superpowers/specs/2026-08-10-phase-4-shell-legacy-retirement-design.md](../specs/2026-08-10-phase-4-shell-legacy-retirement-design.md)

## Deviation from the design doc's Foundation section — read this first

The spec's "Foundation group" section lists 5 items. Investigating the
actual current source (done while writing this plan, 2026-08-17) found that
2 of the 5 cannot land yet without breaking things, and 1 needs a smaller
form than described:

- **Design item 1** ("`HistoryService` constructs its own `CommandStack`")
  — `bootstrap.js` currently does inject `legacyState.commands` into
  `EditorHost`, but `js/features/project/document-controller.js`,
  `js/features/project/project-controller.js`, and
  `js/features/transforms/filter-controller.js` all still call
  `state.commands.push(...)` / `.undo()` / `.redo()` / `.canUndo()` /
  `.canRedo()` **directly on the legacy stack**, bypassing
  `host.history` entirely. If `bootstrap.js` stopped injecting
  `legacyState.commands` today, those three shell files would end up
  pushing onto a *different* stack instance than the one `host.history`
  wraps, silently breaking undo/redo for every command they push. This
  item is deferred to the **Shell rewrite group**, where those three
  files' call sites actually change.
- **Design item 2** ("`EditorStore.project.model` becomes true sole
  owner") — the host-side mechanism for this already exists today
  (`EditorHost.setProject()` → `ProjectService.replace()` →
  `store.setProject()`, verified in `js/host/editor-host.js:151-157` and
  `js/host/project-service.js:13-17`). What's missing is call sites: new
  project / open file / import-sheet-from-image still go through
  `js/app/state.js`'s own `setProject()` global, and those call sites
  live in `project-controller.js` / `file-controller.js` (shell,
  untouched until Group 4) and `document-controller.js`'s
  `document.importSheet` path. Deferred to **Shell rewrite** (and
  finished off in **Final deletion**, alongside removing `state.js`'s
  own `setProject()`).
- **Design item 3** ("`activeSheet()`/`activeMap()`/`activeLayer()`-style
  helpers drop their legacy-fallback branch") — turns out only
  `activeLayer()` and `currentContextLayers()` currently have a
  host-vs-fallback branch at all; `activeSheet()` and `activeMap()`
  **always** read the raw `state.activeSheetId`/`state.activeMapId`
  today, with no host branch whatsoever. And dropping the fallback
  entirely (as the design describes) would break 4+ existing unit test
  files that exercise these helpers without ever calling
  `setEditorHost()` — confirmed by grep: no test file in the whole suite
  currently calls `setEditorHost()`. This plan does the safe, additive
  half only: give `activeSheet()`/`activeMap()` a host-primary branch
  (matching `activeLayer()`'s existing ternary pattern) while **keeping**
  every existing fallback branch untouched. Actually dropping the
  fallbacks is deferred to **Final deletion**, where `state.js` itself
  goes away and the test suite necessarily gets a broader look at host
  configuration in tests anyway.
- **Design item 4** ("`selectionsByDocument` extends to cover
  tile/terrain-set/frame/tile-editing selection") — the store side needs
  no schema change at all (the per-document selection object is already
  freeform — confirmed in `js/host/editor-store.js:65-71`). The only
  thing worth adding now is a safe way to *write* into it without
  clobbering sibling fields (see the `setSelection`-replaces-not-merges
  footgun in the spec's "Current state" section) — that's this plan's
  Task 2. The actual per-mode writes of `selectedTileId` etc. happen in
  the **tiles cleanup group** (Group 3c), where those presenters are
  touched anyway.
- **Design item 5** ("new `EditorStore.workspace` field for `overlays`")
  — unaffected by the above, lands as designed. This plan's Task 1.

So this plan has 3 tasks, not 5, and none of them touch a shell or mode
file. That's intentional — it keeps this group's blast radius to exactly
`js/host/editor-store.js`, `js/host/selection-service.js`, and
`js/app/state.js`, each independently reviewable and revertible.

## Global Constraints

- No user-facing behavior change — every mode must work identically
  after this group, same as every phase before it.
- Full suite (`npm test`, i.e. `node --test tests/*.mjs`) must stay green
  after every task.
- No Playwright/browser smoke check is needed for this group — none of
  its 3 tasks touch DOM, presenters, or any file a UI interaction runs
  through. (Per project policy, browser smoke checks are reserved for
  UI-visible changes; this group has none.)
- Every new/changed function keeps its existing call signature where one
  already exists (`activeSheet()`, `activeMap()` take no arguments, same
  as today).

---

### Task 1: `EditorStore.workspace.overlays`

**Files:**
- Modify: `js/host/editor-store.js:18`
- Test: `tests/host.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `store.getState().workspace.overlays` — shape
  `{ labels: boolean, sequences: boolean }`, default
  `{ labels: true, sequences: true }` (matches `js/app/state.js`'s current
  `overlays` default exactly, so a later group can swap the read source
  without changing the value). Readable via `getState()`, writable via
  `store.transaction(reason, state => { state.workspace.overlays.labels = ...; })`
  same as every other workspace field — no new dedicated method is added,
  consistent with how `focusedSurfaceId` (the only existing `workspace`
  field) is read/written today.

- [ ] **Step 1: Write the failing test**

Append to `tests/host.test.mjs` (it already imports `EditorHost` and
`node:test`/`node:assert/strict` — no new imports needed):

```js
test('EditorStore starts with a default overlays workspace field, mutable via transaction', () => {
  const host = new EditorHost();
  assert.deepEqual(host.store.getState().workspace.overlays, { labels: true, sequences: true });

  let notified = null;
  const dispose = host.store.subscribe(
    state => state.workspace.overlays,
    value => { notified = value; },
  );
  host.store.transaction('overlays', next => { next.workspace.overlays.sequences = false; });
  assert.deepEqual(notified, { labels: true, sequences: false });
  dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/host.test.mjs`
Expected: FAIL — `assert.deepEqual(host.store.getState().workspace.overlays, ...)` throws because `workspace.overlays` is `undefined`.

- [ ] **Step 3: Add the field**

In `js/host/editor-store.js`, change line 18 from:

```js
    workspace: { focusedSurfaceId: null, ...(initial.workspace ?? {}) },
```

to:

```js
    workspace: { focusedSurfaceId: null, overlays: { labels: true, sequences: true }, ...(initial.workspace ?? {}) },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/host.test.mjs`
Expected: PASS, all tests in the file green (existing 4 tests + this new one).

- [ ] **Step 5: Commit**

```bash
git add js/host/editor-store.js tests/host.test.mjs
git commit -m "feat: add workspace.overlays field to EditorStore"
```

---

### Task 2: `SelectionService.patch()`

**Files:**
- Modify: `js/host/selection-service.js`
- Test: `tests/host.test.mjs` (append)

**Interfaces:**
- Consumes: `EditorStore.getSelection(document)` / `EditorStore.setSelection(document, selection)` (existing, unchanged — see `js/host/editor-store.js:65-76`).
- Produces: `SelectionService.patch(partial, document = store.getState().session.activeDocument)` — merges `partial` into the document's existing selection object (shallow spread: existing fields not present in `partial` are preserved; fields present in `partial` overwrite). Mirrors `SelectionService.set(selection, document)`'s existing `(value, document)` argument order — **not** `(document, selection)`, which is the raw store method's order; this asymmetry already exists between `SelectionService.set` and `EditorStore.setSelection` today, so `patch` follows the service's own convention, not the store's.

- [ ] **Step 1: Write the failing test**

Append to `tests/host.test.mjs`:

```js
test('SelectionService.patch merges into the existing selection; .set still replaces wholesale', () => {
  const host = new EditorHost();
  const document = { kind: 'sprite-sheet', id: 'sheet-1' };

  host.selections.set({ layerId: 'layer-1', frameId: 'frame-1' }, document);
  host.selections.patch({ frameId: 'frame-2' }, document);
  assert.deepEqual(host.selections.get(document), { layerId: 'layer-1', frameId: 'frame-2' });

  host.selections.set({ layerId: 'layer-9' }, document);
  assert.deepEqual(host.selections.get(document), { layerId: 'layer-9' });
});

test('SelectionService.patch defaults to the active document, same as .get/.set', () => {
  const host = new EditorHost();
  host.store.transaction('test-setup', next => { next.session.activeDocument = { kind: 'sprite-sheet', id: 'active-sheet' }; });
  host.selections.set({ layerId: 'layer-1' });
  host.selections.patch({ tileId: 42 });
  assert.deepEqual(host.selections.get({ kind: 'sprite-sheet', id: 'active-sheet' }), { layerId: 'layer-1', tileId: 42 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/host.test.mjs`
Expected: FAIL with `TypeError: host.selections.patch is not a function`.

- [ ] **Step 3: Implement `patch()`**

In `js/host/selection-service.js`, add a method after the existing `set()`
(full file becomes):

```js
export class SelectionService {
  #store;
  constructor(store) { this.#store = store; }
  get(document = this.#store.getState().session.activeDocument) { return this.#store.getSelection(document); }
  set(selection, document = this.#store.getState().session.activeDocument) { this.#store.setSelection(document, selection); }
  patch(partial, document = this.#store.getState().session.activeDocument) {
    this.set({ ...(this.get(document) ?? {}), ...partial }, document);
  }
  clear(document = this.#store.getState().session.activeDocument) { this.#store.setSelection(document, {}); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/host.test.mjs`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add js/host/selection-service.js tests/host.test.mjs
git commit -m "feat: add merge-safe SelectionService.patch()"
```

---

### Task 3: `activeSheet()`/`activeMap()` host-primary reads

**Files:**
- Modify: `js/app/state.js:58-63`
- Create: `tests/state.test.mjs`

**Interfaces:**
- Consumes: `getEditorHost()` (`js/host/runtime.js`, existing), `host.store.getState().session.activeDocument` (existing shape `{kind, id} | null`, populated today by `legacy-state-adapter.js`'s call to `host.documents.setActive()` — see the spec's "Current state" section).
- Produces: `activeSheet()` / `activeMap()` — same zero-argument signature and same return shape (`Sheet | null`, `MapDocument | null`) as today. No other file's call sites change.

- [ ] **Step 1: Write the failing tests**

Create `tests/state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, activeSheet, activeMap } from '../js/app/state.js';
import { createProject, createSheet, createMap } from '../js/core/model.js';
import { EditorHost } from '../js/host/editor-host.js';
import { setEditorHost } from '../js/host/runtime.js';

function testProject() {
  const project = createProject('test');
  const sheet = createSheet(project, { name: 'sprites', width: 8, height: 8, kind: 'sprite' });
  const map = createMap(project, { name: 'world' });
  return { project, sheet, map };
}

test('activeSheet/activeMap fall back to legacy ids when no EditorHost is configured', () => {
  const { project, sheet, map } = testProject();
  state.project = project;
  state.activeSheetId = sheet.id;
  state.activeMapId = map.id;
  assert.equal(activeSheet(), sheet);
  assert.equal(activeMap(), map);
});

test('activeSheet/activeMap read from the EditorHost session when one is configured', () => {
  const { project, sheet, map } = testProject();
  state.project = project;
  // Legacy ids intentionally left null/stale to prove the host path is
  // actually driving the result, not falling through to these.
  state.activeSheetId = null;
  state.activeMapId = null;

  const host = new EditorHost();
  host.store.transaction('test-setup', next => { next.session.activeDocument = { kind: 'sprite-sheet', id: sheet.id }; });
  setEditorHost(host);

  assert.equal(activeSheet(), sheet);

  host.store.transaction('test-setup', next => { next.session.activeDocument = { kind: 'map', id: map.id }; });
  assert.equal(activeMap(), map);
});
```

Note: `setEditorHost()` throws if called twice with two *different* hosts
and has no reset function (`js/host/runtime.js:3-6`), and it is a
module-level singleton shared by every test in this file. That's why the
no-host test runs first (`node:test` runs top-level tests in a file
sequentially, in source order, by default) — once the second test calls
`setEditorHost()`, this file can never go back to a no-host state. Do not
reorder these two tests or add a third test after them that assumes no
host is configured.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/state.test.mjs`
Expected: FAIL on the second test — `activeSheet()`/`activeMap()` still read
`state.activeSheetId`/`state.activeMapId` unconditionally, which were set
to `null`, so both assertions fail (`null` vs the expected sheet/map).

- [ ] **Step 3: Add the host-primary branch**

In `js/app/state.js`, replace lines 58-63:

```js
export function activeSheet() {
  return state.project?.sheets.find(s => s.id === state.activeSheetId) ?? null;
}
export function activeMap() {
  return state.project?.maps?.find(m => m.id === state.activeMapId) ?? null;
}
```

with:

```js
export function activeSheet() {
  const host = getEditorHost();
  const id = host ? (host.store.getState().session.activeDocument?.id ?? null) : state.activeSheetId;
  return state.project?.sheets.find(s => s.id === id) ?? null;
}
export function activeMap() {
  const host = getEditorHost();
  const id = host ? (host.store.getState().session.activeDocument?.id ?? null) : state.activeMapId;
  return state.project?.maps?.find(m => m.id === id) ?? null;
}
```

(`getEditorHost` is already imported at the top of this file — line 4 —
for `activeLayer()`'s existing host branch, so no new import is needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/state.test.mjs`
Expected: PASS, both tests green.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: all tests green, including the 4 existing files that exercise
`activeSheet()`/`activeMap()`/`activeLayer()` without a configured host
(`tests/sprite-strip-commands.test.mjs`,
`tests/sprite-animation-lifecycle-commands.test.mjs`,
`tests/sprite-animation-commands.test.mjs`, `tests/floatsession.test.mjs`)
— their no-host fallback path must be byte-for-byte unchanged.

- [ ] **Step 6: Commit**

```bash
git add js/app/state.js tests/state.test.mjs
git commit -m "feat: activeSheet/activeMap read from EditorHost session when configured"
```

---

## Self-Review

**1. Spec coverage:** Design item 5 → Task 1. Design item 4's store-side
prerequisite (safe merge-write) → Task 2. Design item 3's safe half →
Task 3. Design items 1 and 2 are explicitly deferred with the reasoning
recorded above, not silently dropped — they're picked up by the Shell
rewrite group's plan.

**2. Placeholder scan:** No TBD/TODO; every step has real code and real
commands.

**3. Type consistency:** `SelectionService.patch(partial, document)`
matches `.set(selection, document)`'s existing argument order (value
first, document second) — checked directly against the current source in
`js/host/selection-service.js:5`, not assumed. `activeSheet()`/
`activeMap()` keep their existing zero-argument signatures.

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/2026-08-17-phase-4-group-1-foundation.md`. Two
execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per
task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using
executing-plans, batch execution with checkpoints

**Which approach?**
