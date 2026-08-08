# Phase 2b (Sprites Mode — Timeline + Animations Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the Timeline dock and Animations panel — `js/ui/timeline.js` (642 lines) and `js/ui/animpanel.js` (131 lines) — onto the Application/Presentation split defined in `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`, exactly mirroring the shape Phase 2a established for the sprites frame/strip tool. Every `state.commands.push(...)` site becomes a registered Command Handler under `js/modes/sprites/application/commands/`, the playback-advance timing math becomes a pure, unit-tested Application function, and both DOM-facing files move into `js/modes/sprites/presentation/` dispatching commands **by id only**.

**Architecture:** This is sub-phase **2b of 4** (Sprites is phase 2 overall — see the design doc's migration table). 2a covered the frame/strip tool core. 2b covers only `js/ui/timeline.js` and `js/ui/animpanel.js`. Sub-phase 2c (`js/ui/frameeditor.js` + onion skin) and 2d (shared-UI wiring + migrating `selectedFrameId`/`selectedAnimationId`/`activeLayerId` onto `SelectionService`) are explicitly **out of scope here**. Legacy state fields (`state.selectedAnimationId`, `state.selectedFrameId`, `state.activeLayerId`, `state.mode`, `state.view`, `state.editingFrameId`) stay exactly as they are — the new commands and Presenters read/write them in precisely the places today's code does.

**Tech Stack:** Vanilla JS, ES modules, `node --test` (no jsdom — only `application/` code is unit-tested; `presentation/` pointer/DOM behavior, including playback/scrub/drag-reorder, is verified manually per project convention).

## Global Constraints

- No build step, no dependencies, no TypeScript, no UI framework (per `docs/superpowers/specs/2026-08-08-ddd-target-architecture-design.md`).
- Domain never imports upward; Application never touches DOM/Canvas (enforced by `tests/architecture.test.mjs`'s banned-globals scan, already covering every `js/modes/*/application/**` file generically); Presentation dispatches by id only, never imports command-handler modules directly (already enforced generically for every `js/modes/*/presentation/**` file); no mode imports another mode's application/presentation (already enforced generically). Adding new files under `js/modes/sprites/application/` and `js/modes/sprites/presentation/` brings all of these enforcements online for free — no new generic tests needed.
- `js/host/*` (`ProjectService.mutate(reason, fn)` + its read-only `.project` getter, `HistoryService.execute(command)`, `getEditorHost()` from `js/host/runtime.js`, `CommandRegistry.execute(id, context, args)` from `js/host/contributions/commands.js`) already exists and is proven by Phases 1 and 2a.
- **Reuse `findSpriteSheet` and `runSheetCommand` from `js/modes/sprites/application/commands/frame-commands.js`** for every new Command Handler — every existing sprites command file already does this (`strip-commands.js`, `frame-metadata-commands.js`, `animation-commands.js`). `runSheetCommand(services, sheetId, label, apply, revert)` re-enters `services.projects.mutate()` on both `do()` and `undo()` (host-side transaction + dirty flag) **and** calls legacy `markDirty()` internally — handlers never call `markDirty()` themselves, they call `runSheetCommand`.
- **Register every command via `api.commands.register({id, when, execute})` in `contributions.js` — including ones only shared UI calls.** `js/ui/panels.js` (the Layers panel — out of scope for rewrite here) calls `commitDeleteAnimation`, which must still work via a façade export (see Task 6); `js/ui/tools.js` calls `commitAcceptAnimation`, already registered and façaded since Phase 2a and untouched by this plan.
- **Undo bookkeeping lives in closures, never as stashed properties on domain objects.** No `__`-prefixed fields. Capture "before" state via `services.projects.project` (read-only getter) *before* building the command and close over it — exactly like `deleteFrame`/`deleteAnimation` below do for the layer-group cleanup fields.
- **Command semantics must match the pre-migration code exactly, not be reinvented.** Every command below quotes the real current implementation of any non-obvious semantic (no-op guards, idempotency, the exact idx/undo bookkeeping for structural array edits) and pins it with a test.
- **Consolidate exact duplicates.** `js/ui/timeline.js`'s `commitRenameAnimation` and `js/ui/animpanel.js`'s `commitRenameAnim` are byte-for-byte identical logic — they become one Command Handler (`renameAnimation`), used by both Presenters.
- **Domain-function name collisions get the `as` treatment already established in `animation-commands.js`** (`import { acceptAnimation as acceptAnimationOnSheet } from '../../../../core/model.js';`). This plan's `renameAnimation` Command Handler shadows `core/model.js`'s `renameAnimation` the same way: `import { renameAnimation as renameAnimationOnSheet } from '../../../../core/model.js';`.
- Tasks are ordered so `npm test` stays green after every task: pure Application code first (Tasks 1-3), then new Presentation files that exist alongside the still-active old ones (Tasks 4-5), then the `contributions.js` cutover + old-file deletion + façade/test updates (Task 6). Playback/scrub/drag-reorder gestures are verified by hand, never simulated in Playwright (project convention).
- Out of scope, do not touch: `js/ui/frameeditor.js`, `js/ui/tools.js`, `js/ui/previewpanel.js`, `js/ui/baseDurationControl.js` (stays in `js/ui/` — it's explicitly shared with `js/app/main.js`'s dialogs per its own header comment, not sprites-specific), `js/features/project/*`, `js/app/state.js`, `js/modes/sprites/presentation/frame-tool-presenter.js`, `js/modes/sprites/presentation/frames-panel.js`, `js/modes/sprites/application/commands/frame-commands.js` / `strip-commands.js` / `frame-metadata-commands.js` / `animation-commands.js` (read from, never modified).

---

## Behavior-preservation notes (read before starting)

Two deliberate, behavior-neutral changes are made while moving code:

1. **Playback-advance math is extracted into a pure function** (`application/timeline-playback.js`'s `advancePlayback`). `js/ui/timeline.js`'s `tick()` inlines this math directly in the rAF callback; the Presenter version calls the pure function and applies the result. Every branch (loop-wrap, non-loop clamp-and-stop, multi-boundary catch-up) is preserved exactly — see Task 3's tests, hand-traced against the original `tick()` logic.
2. **Command Handlers take ids** (`sheetId`, `animationId`) instead of live object references, so Presenters dispatch through `CommandRegistry.execute(id, context, args)` with plain data — matching every Phase 2a command exactly.

Two things this plan intentionally does **not** change:

- `js/features/animations/commands.js` (the façade `js/ui/tools.js` and `js/ui/panels.js` depend on) is **not deleted**. Task 6 removes its now-unused `commitBreakApartStrip` export (its only caller, `timeline.js`, is deleted and its replacement dispatches `'sprites.breakApartStrip'` directly) and adds a `commitDeleteAnimation` export (`js/ui/panels.js`'s only remaining need from this file's old home in `timeline.js`). `commitAcceptAnimation` is untouched — `js/ui/tools.js` keeps importing it.
- Legacy selection fields (`state.selectedAnimationId`, `state.selectedFrameId`, `state.activeLayerId`) are read/written in exactly the same places as today. Selection unification onto `SelectionService` is sub-phase 2d's job, not this one.

---

### Task 1: Animation lifecycle commands (`application/commands/animation-lifecycle-commands.js`)

**Files:**
- Create: `js/modes/sprites/application/commands/animation-lifecycle-commands.js`
- Test: `tests/sprite-animation-lifecycle-commands.test.mjs`

**Interfaces:**
- Consumes: `findSpriteSheet`, `runSheetCommand` from `./frame-commands.js` (both already exist, unmodified).
- Produces: `newAnimation(services, sheetId)`, `deleteAnimation(services, sheetId, animationId)`, `renameAnimation(services, sheetId, animationId, name)`, `toggleAnimationLoop(services, sheetId, animationId, loop)`, `setAnimationBaseDuration(services, sheetId, animationId, before, after)` — all consumed by Task 6's `contributions.js` registration and by Tasks 4/5's Presenters (dispatched by id, never imported directly).

This is a straight port of `js/ui/timeline.js`'s `commitNewAnimation`/`commitDeleteAnimation` and the byte-identical `commitRenameAnimation` (timeline.js) / `commitRenameAnim` (animpanel.js), plus `js/ui/animpanel.js`'s `commitToggleLoop`/`commitBaseDuration`, onto the `runSheetCommand` pattern.

- [ ] **Step 1: Write the implementation**

```js
// js/modes/sprites/application/commands/animation-lifecycle-commands.js
import { addAnimation, renameAnimation as renameAnimationOnSheet, findParent } from '../../../../core/model.js';
import { state, activeSheet } from '../../../../app/state.js';
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

// A new animation starts FLOATING (see addAnimation/acceptAnimation in
// core/model.js) -- no layer group until accepted, and it has zero frames at
// creation. Mirrors strip-commands.js's newStripFromFrame: "only touch
// selection while this command's own sheet is the one on screen" (state.commands
// is a single global stack shared by every sheet), and the idx-remembered-at-
// undo-time bookkeeping so a later redo reinserts at the same spot.
export function newAnimation(services, sheetId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  if (!sheet) return;
  const name = `anim_${sheet.animations.length}`;
  let anim = null;
  let idx = -1;
  runSheetCommand(services, sheetId, 'new animation',
    target => {
      if (!anim) { anim = addAnimation(target, name, false, services.projects.project?.settings); idx = target.animations.indexOf(anim); }
      else if (!target.animations.includes(anim)) target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (target === activeSheet()) state.selectedAnimationId = anim.id;
    },
    target => {
      idx = target.animations.indexOf(anim);
      target.animations = target.animations.filter(a => a !== anim);
      if (state.selectedAnimationId === anim.id) state.selectedAnimationId = null;
    });
}

// Deleting an animation also tears down its layer group (if it was accepted)
// -- captured once outside the command so undo can restore both the
// animation and the group at their original positions.
export function deleteAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  const anim = sheet?.animations.find(a => a.id === animationId);
  if (!anim) return;
  const idx = sheet.animations.indexOf(anim);
  const wasSelected = state.selectedAnimationId === animationId;
  const groupLoc = anim.layerGroupId ? findParent(sheet.layerTree, anim.layerGroupId) : null;
  const group = groupLoc ? groupLoc.parent.children[groupLoc.index] : null;
  const groupParent = groupLoc ? groupLoc.parent : null;
  const groupIdx = groupLoc ? groupLoc.index : -1;
  runSheetCommand(services, sheetId, 'delete animation',
    target => {
      target.animations = target.animations.filter(a => a.id !== animationId);
      if (groupParent) groupParent.children = groupParent.children.filter(c => c.id !== anim.layerGroupId);
      anim.layerGroupId = null;
      if (state.selectedAnimationId === animationId) state.selectedAnimationId = null;
    },
    target => {
      target.animations.splice(Math.min(idx, target.animations.length), 0, anim);
      if (groupParent) groupParent.children.splice(Math.min(groupIdx, groupParent.children.length), 0, group);
      anim.layerGroupId = group.id;
      if (wasSelected) state.selectedAnimationId = animationId;
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

- [ ] **Step 2: Write the test**

```js
// tests/sprite-animation-lifecycle-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  newAnimation, deleteAnimation, renameAnimation, toggleAnimationLoop, setAnimationBaseDuration,
} from '../js/modes/sprites/application/commands/animation-lifecycle-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [{ id: 'f0', name: 'f0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 }],
    animations: [{
      id: 'an1', name: 'walk', loop: true, strip: false, breaks: [],
      frames: [{ frameId: 'f0', duration: 100, step: null }], layerGroupId: null,
      baseDuration: 100, baseFps: undefined, baseStep: undefined,
    }],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

// activeSheet() (js/app/state.js) reads the legacy global `state`, not
// `services.projects.project` -- newAnimation's `target === activeSheet()`
// check only resolves true if state.project/state.activeSheetId point at
// the same sheet object these tests construct. Mirrors
// sprite-animation-commands.test.mjs's reset(project) exactly.
function reset(project) {
  state.commands = new CommandStack();
  state.dirty = false;
  state.project = project;
  state.activeSheetId = 'sheet1';
  state.selectedAnimationId = null;
}

test('newAnimation names by animation count, selects it when the sheet is active, and undo/redo restore the same object at the same index', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  newAnimation(services, 'sheet1');
  assert.equal(sheet.animations.length, 2);
  const created = sheet.animations[1];
  assert.equal(created.name, 'anim_1');
  assert.equal(state.selectedAnimationId, created.id);
  assert.equal(state.dirty, true);

  services.history.undo();
  assert.equal(sheet.animations.length, 1);
  assert.equal(state.selectedAnimationId, null);

  services.history.redo();
  assert.equal(sheet.animations.length, 2);
  assert.equal(sheet.animations[1].id, created.id);
  assert.equal(sheet.animations[1].name, 'anim_1');
});

test('deleteAnimation removes the animation and tears down its layer group; undo restores both at their original positions', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];
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
});

test('renameAnimation renames and is undoable; no-ops (no history entry) when the name is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  renameAnimation(services, 'sheet1', 'an1', 'walk');
  assert.equal(services.history.canUndo(), false);

  renameAnimation(services, 'sheet1', 'an1', 'run');
  assert.equal(sheet.animations[0].name, 'run');
  services.history.undo();
  assert.equal(sheet.animations[0].name, 'walk');
});

test('toggleAnimationLoop toggles and is undoable; no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  toggleAnimationLoop(services, 'sheet1', 'an1', true);
  assert.equal(services.history.canUndo(), false);

  toggleAnimationLoop(services, 'sheet1', 'an1', false);
  assert.equal(sheet.animations[0].loop, false);
  services.history.undo();
  assert.equal(sheet.animations[0].loop, true);
});

test('setAnimationBaseDuration sets ms/fps/step together and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset(project);
  const sheet = project.sheets[0];

  setAnimationBaseDuration(services, 'sheet1', 'an1',
    { durationMs: 100, baseFps: undefined, baseStep: undefined },
    { durationMs: 200, baseFps: 5, baseStep: 2 });
  assert.equal(sheet.animations[0].baseDuration, 200);
  assert.equal(sheet.animations[0].baseFps, 5);
  assert.equal(sheet.animations[0].baseStep, 2);

  services.history.undo();
  assert.equal(sheet.animations[0].baseDuration, 100);
  assert.equal(sheet.animations[0].baseFps, undefined);
  assert.equal(sheet.animations[0].baseStep, undefined);
});
```

- [ ] **Step 3: Run the test**

Run: `node --test tests/sprite-animation-lifecycle-commands.test.mjs`
Expected: all 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add js/modes/sprites/application/commands/animation-lifecycle-commands.js tests/sprite-animation-lifecycle-commands.test.mjs
git commit -m "feat(sprites): add animation lifecycle command handlers"
```

---

### Task 2: Animation frame-entry commands (`application/commands/animation-frame-commands.js`)

**Files:**
- Create: `js/modes/sprites/application/commands/animation-frame-commands.js`
- Test: `tests/sprite-animation-frame-commands.test.mjs`

**Interfaces:**
- Consumes: `findSpriteSheet`, `runSheetCommand` from `./frame-commands.js`.
- Produces: `addAnimationFrame(services, sheetId, animationId, frameId)`, `removeAnimationFrame(services, sheetId, animationId, index)`, `reorderAnimationFrame(services, sheetId, animationId, fromIndex, toIndex)`, `setAnimationFrameDuration(services, sheetId, animationId, index, duration)`, `setAnimationFrameStep(services, sheetId, animationId, index, step)` — consumed by Task 6's registration and Task 4's Presenter.

Direct port of `js/ui/timeline.js`'s `commitFramesChange` + its five callers (`addFrameToAnimation`, `removeFrameEntry`, `reorderFrameEntry`, `changeDuration`, `changeStep`) — every structural edit to `anim.frames` clones the whole array for `do()`/`undo()`, exactly as today.

- [ ] **Step 1: Write the implementation**

```js
// js/modes/sprites/application/commands/animation-frame-commands.js
import { findSpriteSheet, runSheetCommand } from './frame-commands.js';

// Shared shape for every structural edit to an animation's `frames` array:
// clone before/after arrays of {frameId, duration, step} entries so do()/undo()
// just swap the whole array. `anim` is a stable object reference (never
// replaced by these commands), so do()/undo() mutate it directly and don't
// need runSheetCommand's `target` parameter -- runSheetCommand is still used
// for the store transaction + dirty flag + history push.
function commitFramesChange(services, sheetId, anim, label, beforeFrames, afterFrames) {
  runSheetCommand(services, sheetId, label,
    () => { anim.frames = afterFrames.map(f => ({ ...f })); },
    () => { anim.frames = beforeFrames.map(f => ({ ...f })); });
}

function findAnimation(services, sheetId, animationId) {
  const sheet = findSpriteSheet(services.projects.project, sheetId);
  return sheet?.animations.find(a => a.id === animationId) ?? null;
}

export function addAnimationFrame(services, sheetId, animationId, frameId) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  const after = [...before, { frameId, duration: null, step: null }];
  commitFramesChange(services, sheetId, anim, 'add frame to animation', before, after);
}

export function removeAnimationFrame(services, sheetId, animationId, index) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  const after = before.filter((_, i) => i !== index);
  commitFramesChange(services, sheetId, anim, 'remove frame from animation', before, after);
}

export function reorderAnimationFrame(services, sheetId, animationId, fromIndex, toIndex) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  const after = before.slice();
  const [item] = after.splice(fromIndex, 1);
  after.splice(Math.max(0, Math.min(after.length, toIndex)), 0, item);
  commitFramesChange(services, sheetId, anim, 'reorder animation frame', before, after);
}

export function setAnimationFrameDuration(services, sheetId, animationId, index, duration) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].duration === duration) return;
  const after = before.map((f, i) => (i === index ? { ...f, duration } : f));
  commitFramesChange(services, sheetId, anim, 'edit frame duration', before, after);
}

export function setAnimationFrameStep(services, sheetId, animationId, index, step) {
  const anim = findAnimation(services, sheetId, animationId);
  if (!anim) return;
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].step === step) return;
  const after = before.map((f, i) => (i === index ? { ...f, step } : f));
  commitFramesChange(services, sheetId, anim, 'edit frame step', before, after);
}
```

- [ ] **Step 2: Write the test**

```js
// tests/sprite-animation-frame-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorStore } from '../js/host/editor-store.js';
import { ProjectService } from '../js/host/project-service.js';
import { HistoryService } from '../js/host/history-service.js';
import { CommandStack } from '../js/core/commands.js';
import { state } from '../js/app/state.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration, setAnimationFrameStep,
} from '../js/modes/sprites/application/commands/animation-frame-commands.js';

function makeServices(project) {
  const store = new EditorStore();
  store.setProject(project, { dirty: false });
  const stack = new CommandStack();
  return { store, projects: new ProjectService(store, null), history: new HistoryService({ store, stack }) };
}

function makeProject() {
  const sheet = {
    id: 'sheet1', kind: 'sprite', name: 'Sprites', width: 64, height: 64,
    frames: [
      { id: 'f0', name: 'f0', x: 0, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 },
      { id: 'f1', name: 'f1', x: 16, y: 0, w: 16, h: 16, pivotX: 0, pivotY: 0 },
    ],
    animations: [{
      id: 'an1', name: 'walk', loop: true, strip: false, breaks: [],
      frames: [
        { frameId: 'f0', duration: 100, step: null },
        { frameId: 'f1', duration: 150, step: null },
      ],
      layerGroupId: null, baseDuration: 100, baseFps: undefined, baseStep: undefined,
    }],
    layerTree: { id: 'root', type: 'group', name: 'root', animationId: null, open: true, children: [] },
  };
  return { version: 6, name: 'test', settings: { durationMs: 100 }, sheets: [sheet], maps: [], palettes: [], activePaletteId: null };
}

function reset() { state.commands = new CommandStack(); state.dirty = false; }

test('addAnimationFrame appends a null-duration/step entry and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];

  addAnimationFrame(services, 'sheet1', 'an1', 'f0');
  assert.equal(sheet.animations[0].frames.length, 3);
  assert.deepEqual(sheet.animations[0].frames[2], { frameId: 'f0', duration: null, step: null });

  services.history.undo();
  assert.equal(sheet.animations[0].frames.length, 2);
});

test('removeAnimationFrame drops the entry at index and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];

  removeAnimationFrame(services, 'sheet1', 'an1', 0);
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f1']);

  services.history.undo();
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f0', 'f1']);
});

test('reorderAnimationFrame moves an entry to a new index, clamping to the array bounds, and is undoable', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];

  reorderAnimationFrame(services, 'sheet1', 'an1', 0, 2);
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f1', 'f0']);
  services.history.undo();
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f0', 'f1']);

  // toIndex beyond the array clamps to the end (Math.min(after.length, toIndex))
  reorderAnimationFrame(services, 'sheet1', 'an1', 0, 99);
  assert.deepEqual(sheet.animations[0].frames.map(f => f.frameId), ['f1', 'f0']);
});

test('setAnimationFrameDuration edits one entry, is undoable, and no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];

  setAnimationFrameDuration(services, 'sheet1', 'an1', 1, 150);
  assert.equal(services.history.canUndo(), false);

  setAnimationFrameDuration(services, 'sheet1', 'an1', 1, 300);
  assert.equal(sheet.animations[0].frames[1].duration, 300);
  services.history.undo();
  assert.equal(sheet.animations[0].frames[1].duration, 150);
});

test('setAnimationFrameStep edits one entry, is undoable, and no-ops when the value is unchanged', () => {
  const project = makeProject();
  const services = makeServices(project);
  reset();
  const sheet = project.sheets[0];

  setAnimationFrameStep(services, 'sheet1', 'an1', 0, null);
  assert.equal(services.history.canUndo(), false);

  setAnimationFrameStep(services, 'sheet1', 'an1', 0, 2);
  assert.equal(sheet.animations[0].frames[0].step, 2);
  services.history.undo();
  assert.equal(sheet.animations[0].frames[0].step, null);
});
```

- [ ] **Step 3: Run the test**

Run: `node --test tests/sprite-animation-frame-commands.test.mjs`
Expected: all 5 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add js/modes/sprites/application/commands/animation-frame-commands.js tests/sprite-animation-frame-commands.test.mjs
git commit -m "feat(sprites): add animation frame-entry command handlers"
```

---

### Task 3: Pure playback-advance math (`application/timeline-playback.js`)

**Files:**
- Create: `js/modes/sprites/application/timeline-playback.js`
- Test: `tests/timeline-playback.test.mjs`

**Interfaces:**
- Consumes: `effectiveDuration` from `../../../core/model.js` (already exists, re-exported from `js/domain/sprites/animation-timing.js`).
- Produces: `advancePlayback(anim, position, acc, elapsedMs, loop) -> { position, acc, stopped }`, consumed by Task 4's `timeline-presenter.js`.

Extracts the decision-making loop from `js/ui/timeline.js`'s `tick()` (lines 366-393) into a pure, DOM-free function — the Humble Object split the design doc calls for. `elapsedMs` is the caller's `dt * speed` (already speed-scaled); this function only does frame-boundary math.

- [ ] **Step 1: Write the implementation**

```js
// js/modes/sprites/application/timeline-playback.js
import { effectiveDuration } from '../../../core/model.js';

// Pure step function for the timeline's playback loop: given how much time
// elapsed since the last tick (already scaled by the playback-speed
// multiplier), advances `position`/`acc` across as many frame boundaries as
// `elapsedMs` covers -- a slow tab can lag several frames behind in one rAF
// tick, hence the while loop rather than a single step. Mirrors
// js/ui/timeline.js's tick() exactly, minus the DOM/rAF/preview side
// effects, which stay in the Presenter (js/modes/sprites/presentation/
// timeline-presenter.js).
export function advancePlayback(anim, position, acc, elapsedMs, loop) {
  let nextPosition = position;
  let nextAcc = acc + elapsedMs;
  let stopped = false;
  let entry = anim.frames[nextPosition];
  while (entry && nextAcc >= effectiveDuration(anim, entry)) {
    nextAcc -= effectiveDuration(anim, entry);
    nextPosition += 1;
    if (nextPosition >= anim.frames.length) {
      if (loop) {
        nextPosition = 0;
      } else {
        nextPosition = anim.frames.length - 1;
        stopped = true;
        break;
      }
    }
    entry = anim.frames[nextPosition];
  }
  return { position: nextPosition, acc: nextAcc, stopped };
}
```

- [ ] **Step 2: Write the test**

```js
// tests/timeline-playback.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advancePlayback } from '../js/modes/sprites/application/timeline-playback.js';

function makeAnim(overrides = {}) {
  return {
    baseDuration: 100, baseFps: undefined, baseStep: undefined,
    frames: [
      { frameId: 'a', duration: 100, step: null },
      { frameId: 'b', duration: 100, step: null },
      { frameId: 'c', duration: 100, step: null },
    ],
    ...overrides,
  };
}

test('advancePlayback holds position when elapsed time is under the current frame duration', () => {
  const result = advancePlayback(makeAnim(), 0, 0, 40, true);
  assert.deepEqual(result, { position: 0, acc: 40, stopped: false });
});

test('advancePlayback advances one frame and carries the remainder', () => {
  // 90ms already accumulated + 30ms elapsed = 120ms against a 100ms frame:
  // one boundary crossed, 20ms left over.
  const result = advancePlayback(makeAnim(), 0, 90, 30, true);
  assert.deepEqual(result, { position: 1, acc: 20, stopped: false });
});

test('advancePlayback can cross multiple frame boundaries in one call', () => {
  // 250ms / 100ms per frame: 0->1 (150 left), 1->2 (50 left), 50 < 100 so it stops there.
  const result = advancePlayback(makeAnim(), 0, 0, 250, true);
  assert.deepEqual(result, { position: 2, acc: 50, stopped: false });
});

test('advancePlayback loops back to frame 0 when loop is true and playback runs past the last frame', () => {
  const result = advancePlayback(makeAnim(), 2, 90, 30, true);
  assert.deepEqual(result, { position: 0, acc: 20, stopped: false });
});

test('advancePlayback clamps to the last frame and reports stopped when loop is false', () => {
  const result = advancePlayback(makeAnim(), 2, 90, 30, false);
  assert.deepEqual(result, { position: 2, acc: 20, stopped: true });
});

test('advancePlayback uses fps/step timing when the animation is fps-primary', () => {
  // baseFps 10, step 1 -> fpsStepToMs(10, 1) = 100ms/frame, same cadence as the ms-primary cases above.
  const anim = makeAnim({ baseDuration: undefined, baseFps: 10, baseStep: 1 });
  const result = advancePlayback(anim, 0, 90, 30, true);
  assert.deepEqual(result, { position: 1, acc: 20, stopped: false });
});
```

- [ ] **Step 3: Run the test**

Run: `node --test tests/timeline-playback.test.mjs`
Expected: all 6 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add js/modes/sprites/application/timeline-playback.js tests/timeline-playback.test.mjs
git commit -m "feat(sprites): extract pure timeline playback-advance math"
```

---

### Task 4: Timeline presenter (`presentation/timeline-presenter.js`)

**Files:**
- Create: `js/modes/sprites/presentation/timeline-presenter.js`
- Read (do not modify): `js/ui/timeline.js` (source of truth for this port — stays in place, still wired into `contributions.js`, until Task 6 deletes it)

**Interfaces:**
- Consumes: `advancePlayback` (Task 3), the 5 lifecycle commands (Task 1) and 5 frame-entry commands (Task 2) — all dispatched by id via `getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args)`, plus the already-registered `'sprites.breakApartStrip'` (Phase 2a).
- Produces: `mountTimeline(el) -> { dispose() }`, consumed by Task 6's `contributions.js` (`api.panels.register({ id: 'sprites.timeline', ..., create: mountTimeline })`).

Not unit-tested (DOM/pointer/rAF-driven — same convention as `frame-tool-presenter.js`); Task 6's manual verification checklist covers it.

- [ ] **Step 1: Create the file as a copy of `js/ui/timeline.js`, then apply exactly these changes**

Copy the full contents of `js/ui/timeline.js` (642 lines) to `js/modes/sprites/presentation/timeline-presenter.js`, then apply every change below. Nothing else changes — every DOM element, event listener, and render/scrub/drag-reorder codepath not listed here stays byte-for-byte identical (just re-indented if your editor does that automatically; don't hand-retype working code).

**1a. Update the header comment's file references** (the "Mirrors frames.js's split" paragraph) to describe the new location — cosmetic, no functional requirement, keep it accurate.

**1b. Replace the import block:**

Before:
```js
import { state, on, emit, activeSheet, markDirty, confirmOrAuto, currentContextLayers } from '../app/state.js';
import { addAnimation, contextLayers, flattenSheetLayers, findParent, renameAnimation, effectiveDuration } from '../core/model.js';
import { copyRegion } from '../core/pixels.js';
import { commitBreakApartStrip } from '../features/animations/commands.js';
import { setPreviewBitmap } from './previewpanel.js';
```

After:
```js
import { state, on, emit, activeSheet, confirmOrAuto, currentContextLayers } from '../../../app/state.js';
import { contextLayers, flattenSheetLayers, effectiveDuration } from '../../../core/model.js';
import { copyRegion } from '../../../core/pixels.js';
import { getEditorHost } from '../../../host/runtime.js';
import { advancePlayback } from '../application/timeline-playback.js';
import { setPreviewBitmap } from '../../../ui/previewpanel.js';
```

(`markDirty` is gone — every mutation now goes through a dispatched command, which calls it internally via `runSheetCommand`. `addAnimation`/`findParent`/`renameAnimation` are gone — moved into Task 1's command file. `effectiveDuration` stays — `buildCell` still displays it directly, see 1f. `commitBreakApartStrip` is replaced by direct dispatch, see 1e.)

**1c. Add a `dispatch` helper**, right after the imports, matching `frames-panel.js`'s exact pattern:

```js
// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- this file lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args);
}
```

**1d. Delete these six functions entirely** (their logic now lives in Task 1/2's command handlers): `commitFramesChange`, `addFrameToAnimation`, `removeFrameEntry`, `reorderFrameEntry`, `changeDuration`, `changeStep`, `commitNewAnimation`, `commitDeleteAnimation` (this was `export function commitDeleteAnimation(sheet, animId)` — the export is dropped entirely; `js/ui/panels.js`'s import moves to the façade in Task 6), `commitRenameAnimation`. That's the whole "------- commands -------" section (original lines 82-204).

**1e. Replace every call site that used the deleted functions**, inside `mountTimeline`'s body:

Before (`btnNewAnim` handler):
```js
  btnNewAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    commitNewAnimation(sheet);
  });
```
After:
```js
  btnNewAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    if (!sheet) return;
    dispatch('sprites.newAnimation', { sheetId: sheet.id });
  });
```

Before (`btnRenameAnim` handler):
```js
  btnRenameAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    const name = prompt('Animation name', anim.name);
    if (name == null) return;
    const v = name.trim();
    if (v) commitRenameAnimation(sheet, anim, v);
  });
```
After:
```js
  btnRenameAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    const name = prompt('Animation name', anim.name);
    if (name == null) return;
    const v = name.trim();
    if (v) dispatch('sprites.renameAnimation', { sheetId: sheet.id, animationId: anim.id, name: v });
  });
```

Before (`btnDeleteAnim` handler):
```js
  btnDeleteAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    if (!confirmOrAuto(`Delete animation "${anim.name}"?`)) return;
    stopPlaying();
    commitDeleteAnimation(sheet, anim.id);
  });
```
After:
```js
  btnDeleteAnim.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim) return;
    if (!confirmOrAuto(`Delete animation "${anim.name}"?`)) return;
    stopPlaying();
    dispatch('sprites.deleteAnimation', { sheetId: sheet.id, animationId: anim.id });
  });
```

Before (`btnAddFrame` handler):
```js
  btnAddFrame.addEventListener('click', () => {
    const anim = currentAnim();
    if (!anim || !state.selectedFrameId) return;
    addFrameToAnimation(anim, state.selectedFrameId);
  });
```
After:
```js
  btnAddFrame.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim || !state.selectedFrameId) return;
    dispatch('sprites.addAnimationFrame', { sheetId: sheet.id, animationId: anim.id, frameId: state.selectedFrameId });
  });
```

Before (`btnBreakApart` handler):
```js
  btnBreakApart.addEventListener('click', () => {
    const anim = currentAnim();
    if (!anim || !anim.strip) return;
    commitBreakApartStrip(anim);
  });
```
After:
```js
  btnBreakApart.addEventListener('click', () => {
    const sheet = activeSheet();
    const anim = currentAnim();
    if (!sheet || !anim || !anim.strip) return;
    dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: anim.id });
  });
```

**1f. Inside `buildCell(anim, entry, index, sheet)`** (sheet is already a parameter here, no new lookup needed):

Before (the fps-primary step-input branch):
```js
      stepInput.addEventListener('change', () => {
        let v = parseInt(stepInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        stepInput.value = String(v);
        changeStep(anim, index, v);
      });
```
After:
```js
      stepInput.addEventListener('change', () => {
        let v = parseInt(stepInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        stepInput.value = String(v);
        dispatch('sprites.setAnimationFrameStep', { sheetId: sheet.id, animationId: anim.id, index, step: v });
      });
```

Before (the ms-primary duration-input branch):
```js
      durationInput.addEventListener('change', () => {
        let v = parseInt(durationInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        durationInput.value = String(v);
        changeDuration(anim, index, v);
      });
```
After:
```js
      durationInput.addEventListener('change', () => {
        let v = parseInt(durationInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        durationInput.value = String(v);
        dispatch('sprites.setAnimationFrameDuration', { sheetId: sheet.id, animationId: anim.id, index, duration: v });
      });
```

Before (`btnRemove`):
```js
    btnRemove.addEventListener('click', (e) => { e.stopPropagation(); removeFrameEntry(anim, index); });
```
After:
```js
    btnRemove.addEventListener('click', (e) => { e.stopPropagation(); dispatch('sprites.removeAnimationFrame', { sheetId: sheet.id, animationId: anim.id, index }); });
```

Before (the `drop` handler's last line):
```js
      if (toIndex === fromIndex) return;
      reorderFrameEntry(anim, fromIndex, toIndex);
```
After:
```js
      if (toIndex === fromIndex) return;
      dispatch('sprites.reorderAnimationFrame', { sheetId: sheet.id, animationId: anim.id, fromIndex, toIndex });
```

**1g. Replace `tick()`'s inlined math with `advancePlayback`:**

Before:
```js
  function tick(ts) {
    if (!playing) return;
    const anim = currentAnim();
    if (!anim || !anim.frames.length) { stopPlaying(); return; }
    if (lastTs == null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const speed = parseFloat(speedSelect.value) || 1;
    acc += dt * speed;
    let entry = anim.frames[position];
    while (entry && acc >= effectiveDuration(anim, entry)) {
      acc -= effectiveDuration(anim, entry);
      position += 1;
      if (position >= anim.frames.length) {
        if (previewLoop) {
          position = 0;
        } else {
          position = anim.frames.length - 1;
          stopPlaying();
          break;
        }
      }
      entry = anim.frames[position];
    }
    renderPreview();
    updatePlayheadHighlight();
    emitPlayhead();
    if (playing) rafId = requestAnimationFrame(tick);
  }
```
After:
```js
  function tick(ts) {
    if (!playing) return;
    const anim = currentAnim();
    if (!anim || !anim.frames.length) { stopPlaying(); return; }
    if (lastTs == null) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    const speed = parseFloat(speedSelect.value) || 1;
    const result = advancePlayback(anim, position, acc, dt * speed, previewLoop);
    position = result.position;
    acc = result.acc;
    if (result.stopped) stopPlaying();
    renderPreview();
    updatePlayheadHighlight();
    emitPlayhead();
    if (playing) rafId = requestAnimationFrame(tick);
  }
```

**1h. Return a disposer**, matching `frames-panel.js`'s contract:

Before (the last 5 lines of `mountTimeline`):
```js
  on('project', scheduleRender);
  on('history', scheduleRender);
  on('view', scheduleRender);
  on('selection', scheduleRender);
  render();
}
```
After:
```js
  const subscriptions = [
    on('project', scheduleRender),
    on('history', scheduleRender),
    on('view', scheduleRender),
    on('selection', scheduleRender),
  ];
  render();
  return { dispose() { stopPlaying(); subscriptions.forEach(dispose => dispose()); } };
}
```
(`stopPlaying()` on dispose additionally cancels any in-flight `requestAnimationFrame` — the old file never disposed at all, so this is a strict improvement, not a behavior change for the running app.)

- [ ] **Step 2: Verify by reading, not running** — this file has no automated test (DOM/pointer/rAF, project convention). Re-read the finished file top to bottom and confirm: every function that referenced `commitNewAnimation`/`commitDeleteAnimation`/`commitRenameAnimation`/`addFrameToAnimation`/`removeFrameEntry`/`reorderFrameEntry`/`changeDuration`/`changeStep`/`commitBreakApartStrip` now calls `dispatch(...)` instead, and no reference to any of those eight names remains anywhere in the file.

- [ ] **Step 3: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: same pass count as before this task (this file isn't imported by `contributions.js` yet — Task 6 does that — so nothing exercises it yet, but nothing should regress either).

- [ ] **Step 4: Commit**

```bash
git add js/modes/sprites/presentation/timeline-presenter.js
git commit -m "feat(sprites): add timeline presenter dispatching commands by id"
```

---

### Task 5: Animations panel (`presentation/animations-panel.js`)

**Files:**
- Create: `js/modes/sprites/presentation/animations-panel.js`
- Read (do not modify): `js/ui/animpanel.js` (source of truth for this port — stays in place until Task 6 deletes it)

**Interfaces:**
- Consumes: `renameAnimation`, `toggleAnimationLoop`, `setAnimationBaseDuration` (Task 1) — dispatched by id.
- Produces: `mountAnimationsPanel(el) -> { dispose() }`, consumed by Task 6's `contributions.js`.

Not unit-tested (DOM-driven, project convention).

- [ ] **Step 1: Create the file as a copy of `js/ui/animpanel.js`, then apply exactly these changes**

Copy the full contents of `js/ui/animpanel.js` (131 lines) to `js/modes/sprites/presentation/animations-panel.js`, then apply every change below.

**1a. Replace the import block:**

Before:
```js
import { state, on, activeSheet, markDirty } from '../app/state.js';
import { renameAnimation } from '../core/model.js';
import { buildBaseDurationControl } from './baseDurationControl.js';
```
After:
```js
import { state, on, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { buildBaseDurationControl } from '../../../ui/baseDurationControl.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- this file lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args);
}
```

**1b. Delete these three functions entirely** (moved into Task 1's command file): `commitRenameAnim`, `commitToggleLoop`, `commitBaseDuration`. That's the whole block between the imports and `export function mountAnimationsPanel`.

**1c. Replace the call sites** inside `mountAnimationsPanel`:

Before:
```js
  nameInput.addEventListener('change', () => {
    const sheet = activeSheet();
    if (!sheet || !currentAnim) return;
    const v = nameInput.value.trim();
    if (v) commitRenameAnim(sheet, currentAnim, v);
    else nameInput.value = currentAnim.name;
  });

  loopCheckbox.addEventListener('change', () => {
    if (!currentAnim) return;
    commitToggleLoop(currentAnim, loopCheckbox.checked);
  });
```
After:
```js
  nameInput.addEventListener('change', () => {
    const sheet = activeSheet();
    if (!sheet || !currentAnim) return;
    const v = nameInput.value.trim();
    if (v) dispatch('sprites.renameAnimation', { sheetId: sheet.id, animationId: currentAnim.id, name: v });
    else nameInput.value = currentAnim.name;
  });

  loopCheckbox.addEventListener('change', () => {
    const sheet = activeSheet();
    if (!sheet || !currentAnim) return;
    dispatch('sprites.toggleAnimationLoop', { sheetId: sheet.id, animationId: currentAnim.id, loop: loopCheckbox.checked });
  });
```

Before (the `buildBaseDurationControl` call):
```js
  const durationControl = buildBaseDurationControl({
    getValue: () => ({
      durationMs: currentAnim?.baseDuration ?? 100,
      baseFps: currentAnim?.baseFps,
      baseStep: currentAnim?.baseStep,
    }),
    setValue: (after) => {
      if (!currentAnim) return;
      const before = { durationMs: currentAnim.baseDuration, baseFps: currentAnim.baseFps, baseStep: currentAnim.baseStep };
      commitBaseDuration(currentAnim, before, after);
    },
  });
```
After:
```js
  const durationControl = buildBaseDurationControl({
    getValue: () => ({
      durationMs: currentAnim?.baseDuration ?? 100,
      baseFps: currentAnim?.baseFps,
      baseStep: currentAnim?.baseStep,
    }),
    setValue: (after) => {
      const sheet = activeSheet();
      if (!sheet || !currentAnim) return;
      const before = { durationMs: currentAnim.baseDuration, baseFps: currentAnim.baseFps, baseStep: currentAnim.baseStep };
      dispatch('sprites.setAnimationBaseDuration', { sheetId: sheet.id, animationId: currentAnim.id, before, after });
    },
  });
```

**1d. Return a disposer**, matching `frames-panel.js`'s contract:

Before (the last 5 lines of `mountAnimationsPanel`):
```js
  on('project', scheduleRender);
  on('history', scheduleRender);
  on('view', scheduleRender);
  on('selection', scheduleRender);
  render();
}
```
After:
```js
  const subscriptions = [
    on('project', scheduleRender),
    on('history', scheduleRender),
    on('view', scheduleRender),
    on('selection', scheduleRender),
  ];
  render();
  return { dispose() { subscriptions.forEach(dispose => dispose()); } };
}
```

- [ ] **Step 2: Verify by reading** — confirm no reference to `commitRenameAnim`, `commitToggleLoop`, or `commitBaseDuration` remains, and every one of the three call sites now dispatches by id.

- [ ] **Step 3: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: same pass count as before this task.

- [ ] **Step 4: Commit**

```bash
git add js/modes/sprites/presentation/animations-panel.js
git commit -m "feat(sprites): add animations panel dispatching commands by id"
```

---

### Task 6: Wire contributions.js, retire the old files, update the façade and tests

**Files:**
- Modify: `js/modes/sprites/contributions.js`
- Modify: `js/features/animations/commands.js`
- Modify: `js/ui/panels.js`
- Modify: `tests/builtinmodes.test.mjs`
- Modify: `tests/architecture.test.mjs`
- Delete: `js/ui/timeline.js`
- Delete: `js/ui/animpanel.js`

**Interfaces:**
- Consumes: everything Tasks 1-5 produced.
- Produces: the fully wired, cut-over mode — nothing downstream of this task.

This is the actual cutover: old files still work up to this point (nothing imports Tasks 4/5's new files yet), and this task flips the switch and deletes the old code in one green commit.

- [ ] **Step 1: Update `js/modes/sprites/contributions.js`**

Replace the two old-file imports:
```js
import { mountAnimationsPanel } from '../../ui/animpanel.js';
import { mountTimeline } from '../../ui/timeline.js';
```
with:
```js
import { mountAnimationsPanel } from './presentation/animations-panel.js';
import { mountTimeline } from './presentation/timeline-presenter.js';
```

Add two new import blocks alongside the existing `application/commands/*` imports:
```js
import {
  newAnimation, deleteAnimation, renameAnimation, toggleAnimationLoop, setAnimationBaseDuration,
} from './application/commands/animation-lifecycle-commands.js';
import {
  addAnimationFrame, removeAnimationFrame, reorderAnimationFrame, setAnimationFrameDuration, setAnimationFrameStep,
} from './application/commands/animation-frame-commands.js';
```

Add ten new registration lines inside `registerSpriteCommands(api)`, after the existing `command('sprites.acceptAnimation', ...)` line:
```js
  command('sprites.newAnimation', (_context, { sheetId }) => newAnimation(services(), sheetId));
  command('sprites.deleteAnimation', (_context, { sheetId, animationId }) => deleteAnimation(services(), sheetId, animationId));
  command('sprites.renameAnimation', (_context, { sheetId, animationId, name }) => renameAnimation(services(), sheetId, animationId, name));
  command('sprites.toggleAnimationLoop', (_context, { sheetId, animationId, loop }) => toggleAnimationLoop(services(), sheetId, animationId, loop));
  command('sprites.setAnimationBaseDuration', (_context, { sheetId, animationId, before, after }) => setAnimationBaseDuration(services(), sheetId, animationId, before, after));

  command('sprites.addAnimationFrame', (_context, { sheetId, animationId, frameId }) => addAnimationFrame(services(), sheetId, animationId, frameId));
  command('sprites.removeAnimationFrame', (_context, { sheetId, animationId, index }) => removeAnimationFrame(services(), sheetId, animationId, index));
  command('sprites.reorderAnimationFrame', (_context, { sheetId, animationId, fromIndex, toIndex }) => reorderAnimationFrame(services(), sheetId, animationId, fromIndex, toIndex));
  command('sprites.setAnimationFrameDuration', (_context, { sheetId, animationId, index, duration }) => setAnimationFrameDuration(services(), sheetId, animationId, index, duration));
  command('sprites.setAnimationFrameStep', (_context, { sheetId, animationId, index, step }) => setAnimationFrameStep(services(), sheetId, animationId, index, step));
```

Nothing else in `contributions.js` changes — the `api.panels.register(...)` calls for `'sprites.animations'` and `'sprites.timeline'` already reference `mountAnimationsPanel`/`mountTimeline` by name, and those names are unchanged.

- [ ] **Step 2: Update `js/features/animations/commands.js`**

Before:
```js
// js/features/animations/commands.js
// Legacy façade: js/ui/timeline.js and js/ui/tools.js still call these two by
// import. The handlers themselves now live in js/modes/sprites/application/
// commands/animation-commands.js and are registered as host Commands by
// js/modes/sprites/contributions.js, so this file only dispatches by id —
// shared UI must never import a mode's command handlers directly. Delete this
// file once both callers dispatch for themselves (sub-phase 2b/2c).
import { activeSheet } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';

// Context is pinned to 'sprites' rather than the live state.mode: both of
// these are inherently sprite-sheet operations (the caller already resolved a
// sprite sheet), and the registered commands' `when` predicate requires it.
function dispatch(id, args) {
  return getEditorHost()?.registries.commands.execute(id, { modeId: 'sprites' }, args);
}

export function commitBreakApartStrip(animation) {
  const sheet = activeSheet();
  if (!sheet || !animation) return;
  dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: animation.id });
}

export function commitAcceptAnimation(sheet, animation) {
  if (!sheet || !animation) return;
  dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: animation.id });
}
```

After:
```js
// js/features/animations/commands.js
// Legacy façade: js/ui/tools.js still calls commitAcceptAnimation by import,
// and js/ui/panels.js (the Layers panel) still calls commitDeleteAnimation by
// import. The handlers themselves live in js/modes/sprites/application/
// commands/{animation-commands,animation-lifecycle-commands}.js and are
// registered as host Commands by js/modes/sprites/contributions.js, so this
// file only dispatches by id — shared UI must never import a mode's command
// handlers directly. Delete this file once both remaining callers dispatch
// for themselves.
import { activeSheet } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';

// Context is pinned to 'sprites' rather than the live state.mode: both of
// these are inherently sprite-sheet operations (the caller already resolved a
// sprite sheet), and the registered commands' `when` predicate requires it.
function dispatch(id, args) {
  return getEditorHost()?.registries.commands.execute(id, { modeId: 'sprites' }, args);
}

export function commitAcceptAnimation(sheet, animation) {
  if (!sheet || !animation) return;
  dispatch('sprites.acceptAnimation', { sheetId: sheet.id, animationId: animation.id });
}

export function commitDeleteAnimation(sheet, animId) {
  if (!sheet || !animId) return;
  dispatch('sprites.deleteAnimation', { sheetId: sheet.id, animationId: animId });
}
```

(`commitBreakApartStrip` and its unused `activeSheet`-based derivation are gone — Task 4's `timeline-presenter.js` is now the only caller, and it dispatches `'sprites.breakApartStrip'` directly since it already has `sheet` in scope.)

- [ ] **Step 3: Update `js/ui/panels.js`**

Before (line 4):
```js
import { commitDeleteAnimation } from './timeline.js';
```
After:
```js
import { commitDeleteAnimation } from '../features/animations/commands.js';
```

Also update the comment at the call site (around the original line 552-558) that says "commitDeleteAnimation lives in timeline.js" — change it to reference `js/features/animations/commands.js` instead. The call site itself (`commitDeleteAnimation(sheet, g.animationId);`) is unchanged — the façade's signature matches exactly.

- [ ] **Step 4: Delete the old files**

```bash
git rm js/ui/timeline.js js/ui/animpanel.js
```

- [ ] **Step 5: Update `tests/builtinmodes.test.mjs`**

Replace the `sprites mode registers exactly the expected sprites.* command ids` test's expected array (currently 17 ids) with the full 27-id alphabetical list:

```js
    [
      'sprites.acceptAnimation', 'sprites.addAnimationFrame', 'sprites.breakApartStrip', 'sprites.createFrame',
      'sprites.deleteAnimation', 'sprites.deleteFrame', 'sprites.insertStripFrame', 'sprites.mergeStripSegments',
      'sprites.moveFrames', 'sprites.moveStripTo', 'sprites.newAnimation', 'sprites.newStripFromFrame',
      'sprites.removeAnimationFrame', 'sprites.removeStripMember', 'sprites.renameAnimation', 'sprites.reorderAnimationFrame',
      'sprites.resizeFrame', 'sprites.resizeStripSegment', 'sprites.setAnimationBaseDuration', 'sprites.setAnimationFrameDuration',
      'sprites.setAnimationFrameStep', 'sprites.setFrameField', 'sprites.setStripFrameSize', 'sprites.setStripPivot',
      'sprites.sliceGrid', 'sprites.splitStrip', 'sprites.toggleAnimationLoop',
    ],
```

- [ ] **Step 6: Update `tests/architecture.test.mjs`**

In the `sprite command modules do not access browser UI globals` test, add the two new command files to the array (this list is a belt-and-suspenders duplicate of the generic `application/` banned-globals scan a few tests below it — both should list every sprites command file):

Before:
```js
  for (const file of [
    join(root, 'js/modes/sprites/application/commands/frame-commands.js'),
    join(root, 'js/modes/sprites/application/commands/strip-commands.js'),
    join(root, 'js/modes/sprites/application/commands/frame-metadata-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-commands.js'),
  ]) {
```
After:
```js
  for (const file of [
    join(root, 'js/modes/sprites/application/commands/frame-commands.js'),
    join(root, 'js/modes/sprites/application/commands/strip-commands.js'),
    join(root, 'js/modes/sprites/application/commands/frame-metadata-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-lifecycle-commands.js'),
    join(root, 'js/modes/sprites/application/commands/animation-frame-commands.js'),
  ]) {
```

- [ ] **Step 7: Grep for any remaining reference to the deleted files or functions**

Run: `grep -rn "ui/timeline\.js\|ui/animpanel\.js\|commitBreakApartStrip\|commitNewAnimation\|commitRenameAnim\b\|commitToggleLoop\|commitBaseDuration" js/ tests/`

Expected: no matches (the old comment in `frame-commands.js`'s header or elsewhere referencing "sub-phase 2b" by name is fine to leave — it's historical context, not a functional reference).

- [ ] **Step 8: Run the full test suite**

Run: `npm test`
Expected: all tests PASS, including the two updated files from Steps 5-6 and every test from Tasks 1-3.

- [ ] **Step 9: Commit**

```bash
git add js/modes/sprites/contributions.js js/features/animations/commands.js js/ui/panels.js tests/builtinmodes.test.mjs tests/architecture.test.mjs
git commit -m "feat(sprites): wire timeline/animations panel to the new command handlers, remove the old files"
```

---

## Manual verification checklist (surface to the user after the branch is reviewed and merged — never automated, per project convention)

- **Timeline header:** New/Rename (prompt)/Delete animation buttons; Preview Loop checkbox does not affect the exported Loop flag; "Add selected frame" enabled only when a frame is selected and the current animation isn't a strip; Break apart button appears only for an intact strip and disappears after breaking it apart.
- **Playback:** Play/Pause toggles the button glyph; First/Last jump and clamp at the ends; speed dropdown (0.25x/0.5x/1x/2x) changes playback rate; looping wraps to frame 0 at 1x+ speed; non-looping playback stops and clamps on the last frame; scrubbing by clicking a cell also updates `selectedFrameId` and opens the frame editor (single click, not double).
- **Strip cells:** ms-primary shows a duration input; fps-primary shows a step input + read-only ms caption; dragging a plain (non-strip) animation's cells reorders them; strip cells are not draggable and have no remove button; removing a cell only appears for plain animations.
- **Animations panel:** Name field renames (Enter/blur); re-entering the same name doesn't add an undo step; Loop checkbox toggles; base-duration control's ms/fps toggle and step field work and persist through the timeline's fps-primary strip cells.
- **Dock resize:** Drag handle resizes the timeline dock between its min/max, persists across reload (`localStorage`), and thumbnails re-render sharper in a taller dock.
- **Cross-cutting:** Undo/redo across every action above; deleting an animation whose layer group is selected in the Layers panel (via `js/ui/panels.js`) still works and is undoable; `js/ui/tools.js`'s auto-accept-on-draw (Enter-equivalent) for a floating animation still works; save/reload round-trip with no `__`-prefixed fields.
