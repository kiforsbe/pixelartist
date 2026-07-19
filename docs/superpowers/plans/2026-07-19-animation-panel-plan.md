# Animation Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split animation-level concerns (name, export loop, base framerate)
out of the Frames panel into a new Animation panel; add an inheritable
per-frame duration model (ms or fps+step, with per-frame overrides); extend
the same base-duration model to the project level (New Project dialog +
new Project Settings dialog + Edit menu entry).

**Architecture:** Pure data/logic lives in `js/core/model.js`
(`effectiveDuration`, `fpsStepToMs`/`msToFps`, `addAnimation`'s new
`defaults` param) and is unit-tested. All UI changes are plain DOM-building
modules with zero unit-test coverage (matching this codebase's existing
convention — `frames.js`/`timeline.js` have none either), verified instead
via `?autotest` Playwright smoke passes.

**Tech Stack:** Vanilla ES modules, no build step, `node --test` for units,
Playwright MCP for smoke (see `tests/smoke.md`).

## Global Constraints

- No `PROJECT_VERSION` bump (stays `2`) — every new field is optional and
  either passes through the existing `{ ...a }`/`{ ...project.settings }`
  spreads in `serializeProject`/`deserializeProject`, or is read with a `??`
  fallback at the point of use.
- Never simulate pointer drags in Playwright smoke steps for this repo
  (project convention) — every smoke step below uses clicks, typed input,
  `change` events, and `browser_evaluate` state checks only.
- Run `npm test` (`node --test tests/*.mjs`) after every task; all existing
  tests must keep passing alongside the new ones.
- Spec: `docs/superpowers/specs/2026-07-19-animation-panel-design.md` — read
  it first; this plan implements it exactly, with a couple of corrections
  found while grounding in the actual code (noted inline where they occur).

---

### Task 1: Core model — `effectiveDuration`, fps/step math, `addAnimation` defaults

**Files:**
- Modify: `js/core/model.js`
- Modify: `js/ui/timeline.js:121` (one-line call-site update)
- Modify: `js/ui/frames.js:1379`, `js/ui/frames.js:1437` (one-line call-site updates)
- Test: `tests/model.test.mjs`

**Interfaces:**
- Produces: `effectiveDuration(anim, entry)`, `fpsStepToMs(fps, step)`,
  `msToFps(ms)`, `addAnimation(sheet, name, strip = false, defaults = {})`
  (new 4th param) — all exported from `js/core/model.js`, consumed by every
  later task in this plan.

- [ ] **Step 1: Write the failing tests**

Add to `tests/model.test.mjs` (extend the existing import line at the top
first — add `effectiveDuration, fpsStepToMs, msToFps` to the destructured
import from `'../js/core/model.js'`), then append these tests at the end of
the file:

```js
test('effectiveDuration: ms-primary falls back through duration -> baseDuration -> 100', () => {
  const anim = { baseDuration: 80 };
  assert.equal(effectiveDuration(anim, { duration: null }), 80);
  assert.equal(effectiveDuration(anim, { duration: 40 }), 40);
  assert.equal(effectiveDuration({}, { duration: null }), 100);
});

test('effectiveDuration: fps-primary falls back through step -> baseStep -> 1, computed via baseFps', () => {
  const anim = { baseFps: 24, baseStep: 2 };
  assert.equal(effectiveDuration(anim, { step: null }), 83); // round(1000/24*2)
  assert.equal(effectiveDuration(anim, { step: 1 }), 42); // round(1000/24*1)
  assert.equal(effectiveDuration({ baseFps: 24 }, { step: null }), 42); // baseStep missing -> 1
});

test('effectiveDuration: dormant field is ignored -- only the field matching the current primary unit is honored', () => {
  const fpsAnim = { baseFps: 24, baseStep: 1 };
  assert.equal(effectiveDuration(fpsAnim, { duration: 5, step: null }), 42, 'fps-primary: duration override is dormant');
  const msAnim = { baseDuration: 50 };
  assert.equal(effectiveDuration(msAnim, { duration: null, step: 99 }), 50, 'ms-primary: step override is dormant');
});

test('fpsStepToMs computes rounded ms; msToFps is its exact inverse for whole-ms cases', () => {
  assert.equal(fpsStepToMs(24, 2), 83); // 1000/24*2 = 83.33.. -> 83
  assert.equal(fpsStepToMs(10, 1), 100);
  assert.equal(msToFps(1000), 1);
  assert.equal(msToFps(250), 4);
});

test('addAnimation seeds base duration from an optional defaults argument, falling back to ms-100', () => {
  const { s } = (() => { const p = createProject('t'); return { s: createSheet(p, { name: 'S', width: 8, height: 8, kind: 'sprite' }) }; })();
  const a1 = addAnimation(s, 'walk');
  assert.equal(a1.baseDuration, 100);
  assert.equal(a1.baseFps, undefined);
  assert.equal(a1.baseStep, undefined);

  const a2 = addAnimation(s, 'run', false, { durationMs: 80 });
  assert.equal(a2.baseDuration, 80);

  const a3 = addAnimation(s, 'jump', false, { durationMs: 83, baseFps: 24, baseStep: 2 });
  assert.equal(a3.baseDuration, 83);
  assert.equal(a3.baseFps, 24);
  assert.equal(a3.baseStep, 2);
});

test('serializeProject/deserializeProject round-trip anim base-duration fields and settings.baseFps/baseStep via the existing spreads -- no explicit per-field code needed', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'S', width: 16, height: 16, kind: 'sprite' });
  addAnimation(s, 'walk', false, { durationMs: 83, baseFps: 24, baseStep: 2 });
  p.settings.baseFps = 12;
  p.settings.baseStep = 3;
  const { json, images } = serializeProject(p);
  assert.equal(json.sheets[0].animations[0].baseDuration, 83);
  assert.equal(json.sheets[0].animations[0].baseFps, 24);
  assert.equal(json.settings.baseFps, 12);
  const p2 = deserializeProject(json, new Map(images.map(i => [i.path, i.bitmap])));
  assert.equal(p2.sheets[0].animations[0].baseDuration, 83);
  assert.equal(p2.sheets[0].animations[0].baseStep, 2);
  assert.equal(p2.settings.baseFps, 12);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/model.test.mjs`
Expected: FAIL — `effectiveDuration`/`fpsStepToMs`/`msToFps` are not exported
yet, and `addAnimation`'s 3-arg calls above don't yet accept/use a 4th
argument (the last two tests fail on wrong `baseDuration`/missing fields).

- [ ] **Step 3: Implement in `js/core/model.js`**

Replace the `addAnimation` function (currently at line 327):

```js
// A new animation starts FLOATING: no group, no layer, layerGroupId null.
// It previews whatever's already on the sheet under its own frames (see
// contextLayers()'s null-group fallback and flattenSheet()'s exclusive-
// compositing skip for floating strips below) until acceptAnimation() is
// called -- explicitly (Enter key, frames.js) or automatically (first
// paint stroke, tools.js). This lets a strip be freely repositioned/resized
// to align with existing imported artwork before committing to a layer.
//
// `defaults` seeds the new animation's base-duration fields from the
// project's own default (project.settings, see the Animation-panel design
// doc) instead of a hardcoded value -- callers that create a user-visible
// animation should pass `state.project?.settings`; omitting it (e.g. direct
// unit-test calls) falls back to ms-100/unset, same as before this field existed.
export function addAnimation(sheet, name, strip = false, defaults = {}) {
  const anim = {
    id: newId('an'), name, loop: true, strip, breaks: [], frames: [], layerGroupId: null,
    baseDuration: defaults.durationMs ?? 100,
    baseFps: defaults.baseFps,
    baseStep: defaults.baseStep,
  };
  sheet.animations.push(anim);
  return anim;
}
```

Add two new exports right after `addAnimation` (before `acceptAnimation`):

```js
// fps/step -> ms conversion for the "animate on Ns" base-duration model (see
// the Animation-panel design doc). Pure math, shared by js/ui/baseDurationControl.js
// and anything else that needs to seed/redisplay a base duration from fps+step.
export function fpsStepToMs(fps, step) {
  return Math.round(1000 / fps * step);
}
export function msToFps(ms) {
  return 1000 / ms;
}

// Resolves a per-frame animation entry's actual playback/export duration
// (ms), honoring the "inherit until edited" model: an entry's own field is
// read only when it matches the animation's current primary unit
// (anim.baseFps set = fps-primary, reads entry.step; unset = ms-primary,
// reads entry.duration) -- the OTHER field on the entry, if any, is dormant
// and ignored, not deleted (see the design doc's non-destructive note).
export function effectiveDuration(anim, entry) {
  if (anim.baseFps) {
    const step = entry.step ?? anim.baseStep ?? 1;
    return fpsStepToMs(anim.baseFps, step);
  }
  return entry.duration ?? anim.baseDuration ?? 100;
}
```

- [ ] **Step 4: Update the three `addAnimation` call sites**

In `js/ui/timeline.js`, `commitNewAnimation`'s `do()` (currently line 121):
```js
      if (!anim) { anim = addAnimation(sheet, name); idx = sheet.animations.indexOf(anim); }
```
becomes:
```js
      if (!anim) { anim = addAnimation(sheet, name, false, state.project?.settings); idx = sheet.animations.indexOf(anim); }
```

In `js/ui/frames.js`, `commitNewStrip` (currently line 1379):
```js
  const anim = addAnimation(sheet, name, true);
```
becomes:
```js
  const anim = addAnimation(sheet, name, true, state.project?.settings);
```

In `js/ui/frames.js`, `commitNewStripFromFrame` (currently line 1437):
```js
  const anim = addAnimation(sheet, name, true);
```
becomes:
```js
  const anim = addAnimation(sheet, name, true, state.project?.settings);
```
(`state` is already imported in both files — no new imports needed for this step.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/model.test.mjs`
Expected: PASS, all tests including the 5 new ones.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, no regressions in any other file.

- [ ] **Step 7: Commit**

```bash
git add js/core/model.js js/ui/timeline.js js/ui/frames.js tests/model.test.mjs
git commit -m "feat: add effectiveDuration/fps-step model, seed addAnimation from project defaults"
```

---

### Task 2: Export uses `effectiveDuration`

**Files:**
- Modify: `js/app/exports.js`
- Test: `tests/exports.test.mjs`

**Interfaces:**
- Consumes: `effectiveDuration(anim, entry)` from Task 1.

- [ ] **Step 1: Write the failing test**

In `tests/exports.test.mjs`, extend the existing first test (`buildFramesJson:
shape, indices, and animation frames-by-name`) to include one inherited and
one overridden entry. Replace:

```js
  const anim = addAnimation(sheet, 'idle');
  anim.loop = true;
  anim.frames.push({ frameId: f0.id, duration: 100 });
  anim.frames.push({ frameId: f1.id, duration: 120 });
```

with:

```js
  const anim = addAnimation(sheet, 'idle');
  anim.loop = true;
  anim.baseDuration = 100;
  anim.frames.push({ frameId: f0.id, duration: null }); // inherited
  anim.frames.push({ frameId: f1.id, duration: 120 });  // overridden
```

and the assertion:

```js
  assert.deepEqual(json.animations, [
    {
      name: 'idle', loop: true,
      frames: [
        { frame: 'idle_0', duration: 100 },
        { frame: 'idle_1', duration: 120 },
      ],
    },
  ]);
```

stays textually identical (still asserts real numbers) — the point of this
test is that `duration: null` on `f0`'s entry still exports as `100`, not
`null`.

Also append a new, separate test:

```js
test('buildFramesJson: fps-primary animation exports computed ms, honoring a per-frame step override', () => {
  const project = createProject('demo');
  const sheet = createSheet(project, { name: 'Hero', width: 32, height: 16, kind: 'sprite' });
  const f0 = addFrame(sheet, { name: 'run_0', x: 0, y: 0, w: 16, h: 16 });
  const f1 = addFrame(sheet, { name: 'run_1', x: 16, y: 0, w: 16, h: 16 });
  const anim = addAnimation(sheet, 'run', false, { durationMs: 42, baseFps: 24, baseStep: 1 });
  anim.frames.push({ frameId: f0.id, duration: null, step: null }); // inherits baseStep 1 -> 42ms
  anim.frames.push({ frameId: f1.id, duration: null, step: 3 });    // overrides to 3 ticks -> 125ms

  const json = buildFramesJson(sheet);
  assert.deepEqual(json.animations[0].frames, [
    { frame: 'run_0', duration: 42 },
    { frame: 'run_1', duration: 125 },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/exports.test.mjs`
Expected: FAIL — `buildFramesJson` still reads raw `af.duration` (`null` for
the inherited entry, wrong value/no step support for the fps case).

- [ ] **Step 3: Implement**

In `js/app/exports.js`, add `effectiveDuration` to the existing model import:

```js
import { getPreset, NEIGHBOR_DIRS } from '../core/neighbors.js';
import { blobIndexToMask, resolveTerrainSlot } from '../core/blob47.js';
import { effectiveDuration } from '../core/model.js';
```

In `buildFramesJson`, change:
```js
      frames: a.frames.map(af => ({
        frame: nameById.get(af.frameId) ?? null,
        duration: af.duration,
      })),
```
to:
```js
      frames: a.frames.map(af => ({
        frame: nameById.get(af.frameId) ?? null,
        duration: effectiveDuration(a, af),
      })),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/exports.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add js/app/exports.js tests/exports.test.mjs
git commit -m "feat: buildFramesJson exports effectiveDuration instead of raw entry.duration"
```

---

### Task 3: Timeline — Preview Loop, per-frame ms/Frames input switch, inherit-by-default

**Files:**
- Modify: `js/ui/timeline.js`
- Modify: `css/app.css`

**Interfaces:**
- Consumes: `effectiveDuration` from Task 1 (`js/core/model.js`).
- No exports change — this is a leaf UI module.

**Note on the spec:** `docs/superpowers/specs/2026-07-19-animation-panel-design.md`
attributes the `{ frameId, duration: 100 }` push to `frames.js`. Grounding in
the actual code shows it's `js/ui/timeline.js`'s `addFrameToAnimation`
(line 79) — the "Add selected frame" button's handler. This task fixes it
there; `frames.js` has no such push.

- [ ] **Step 1: Add the `effectiveDuration` import**

In `js/ui/timeline.js`, change:
```js
import { addAnimation, contextLayers, flattenSheetLayers, findParent, renameAnimation } from '../core/model.js';
```
to:
```js
import { addAnimation, contextLayers, flattenSheetLayers, findParent, renameAnimation, effectiveDuration } from '../core/model.js';
```

- [ ] **Step 2: New frames inherit by default**

Change `addFrameToAnimation` (currently line 77-81):
```js
function addFrameToAnimation(anim, frameId) {
  const before = anim.frames.map(f => ({ ...f }));
  const after = [...before, { frameId, duration: 100 }];
  commitFramesChange(anim, 'add frame to animation', before, after);
}
```
to:
```js
function addFrameToAnimation(anim, frameId) {
  const before = anim.frames.map(f => ({ ...f }));
  const after = [...before, { frameId, duration: null, step: null }];
  commitFramesChange(anim, 'add frame to animation', before, after);
}
```

- [ ] **Step 3: Add a `changeStep` counterpart to `changeDuration`**

Right after `changeDuration` (currently lines 97-102), add:
```js
function changeStep(anim, index, newStep) {
  const before = anim.frames.map(f => ({ ...f }));
  if (before[index].step === newStep) return;
  const after = before.map((f, i) => (i === index ? { ...f, step: newStep } : f));
  commitFramesChange(anim, 'edit frame step', before, after);
}
```

- [ ] **Step 4: Replace the Loop checkbox with Preview Loop**

Change the header element declarations (currently lines 201-203):
```js
  const loopCheckbox = document.createElement('input'); loopCheckbox.type = 'checkbox';
  const loopLabel = document.createElement('label'); loopLabel.className = 'timeline-loop';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));
```
to:
```js
  const previewLoopCheckbox = document.createElement('input');
  previewLoopCheckbox.type = 'checkbox'; previewLoopCheckbox.checked = true;
  const previewLoopLabel = document.createElement('label'); previewLoopLabel.className = 'timeline-loop';
  previewLoopLabel.title = "Loops the preview playback only -- doesn't affect the exported animation's Loop flag (set that in the Animation panel).";
  previewLoopLabel.append(previewLoopCheckbox, document.createTextNode('Preview Loop'));
```

Update the `header.append(...)` call (currently lines 219-222) to reference
`previewLoopLabel` instead of `loopLabel`:
```js
  header.append(
    animSelect, btnNewAnim, btnRenameAnim, btnDeleteAnim, previewLoopLabel, btnAddFrame, btnBreakApart,
    btnFirst, btnPlay, btnLast, speedSelect,
  );
```

Add a session-only local flag near the other player-state locals (currently
lines 242-246, right after `let position = 0;`):
```js
  let previewLoop = true; // session-only UI state -- never read from/written to anim or state
```

- [ ] **Step 5: Delete `commitToggleLoop` and its listener**

Delete the whole `commitToggleLoop` function (currently lines 177-186):
```js
function commitToggleLoop(anim, loop) {
  const before = anim.loop;
  if (before === loop) return;
  state.commands.push({
    label: 'toggle animation loop',
    do() { anim.loop = loop; },
    undo() { anim.loop = before; },
  });
  markDirty();
}
```

Delete the old listener (currently lines 397-401):
```js
  loopCheckbox.addEventListener('change', () => {
    const anim = currentAnim();
    if (!anim) return;
    commitToggleLoop(anim, loopCheckbox.checked);
  });
```

Add its replacement in the same spot:
```js
  previewLoopCheckbox.addEventListener('change', () => {
    previewLoop = previewLoopCheckbox.checked;
  });
```

- [ ] **Step 6: `tick()` reads `previewLoop`, and uses `effectiveDuration`**

Change `tick()` (currently lines 306-334):
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
    while (entry && acc >= entry.duration) {
      acc -= entry.duration;
      position += 1;
      if (position >= anim.frames.length) {
        if (anim.loop) {
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
to:
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

- [ ] **Step 7: `buildCell` — ms input vs Frames input, depending on `anim.baseFps`**

Replace the duration-input block inside `buildCell` (currently lines
427-445):
```js
    const durationInput = document.createElement('input');
    durationInput.type = 'number'; durationInput.min = '1';
    durationInput.value = String(entry.duration);
    durationInput.addEventListener('click', (e) => e.stopPropagation());
    durationInput.addEventListener('change', () => {
      let v = parseInt(durationInput.value, 10);
      if (!Number.isFinite(v) || v < 1) v = 1;
      durationInput.value = String(v);
      changeDuration(anim, index, v);
    });

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button'; btnRemove.textContent = '✕'; btnRemove.className = 'timeline-remove';
    btnRemove.addEventListener('click', (e) => { e.stopPropagation(); removeFrameEntry(anim, index); });

    const controls = document.createElement('div');
    controls.className = 'timeline-cell-controls';
    controls.append(durationInput);
    if (!anim.strip) controls.append(btnRemove);
```
with:
```js
    const controls = document.createElement('div');
    controls.className = 'timeline-cell-controls';

    if (anim.baseFps != null) {
      // fps-primary: per-frame override is a whole-frame "Frames" (step)
      // count, never a raw ms value -- see the Animation-panel design doc.
      const stepInput = document.createElement('input');
      stepInput.type = 'number'; stepInput.min = '1';
      stepInput.title = "Frames to hold (overrides the animation's base step)";
      stepInput.value = String(entry.step ?? anim.baseStep ?? 1);
      stepInput.addEventListener('click', (e) => e.stopPropagation());
      stepInput.addEventListener('change', () => {
        let v = parseInt(stepInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        stepInput.value = String(v);
        changeStep(anim, index, v);
      });
      const msCaption = document.createElement('span');
      msCaption.className = 'timeline-cell-ms-caption';
      msCaption.textContent = `${effectiveDuration(anim, entry)}ms`;
      controls.append(stepInput, msCaption);
    } else {
      const durationInput = document.createElement('input');
      durationInput.type = 'number'; durationInput.min = '1';
      durationInput.value = String(effectiveDuration(anim, entry));
      durationInput.addEventListener('click', (e) => e.stopPropagation());
      durationInput.addEventListener('change', () => {
        let v = parseInt(durationInput.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        durationInput.value = String(v);
        changeDuration(anim, index, v);
      });
      controls.append(durationInput);
    }

    const btnRemove = document.createElement('button');
    btnRemove.type = 'button'; btnRemove.textContent = '✕'; btnRemove.className = 'timeline-remove';
    btnRemove.addEventListener('click', (e) => { e.stopPropagation(); removeFrameEntry(anim, index); });
    if (!anim.strip) controls.append(btnRemove);
```

- [ ] **Step 8: Drop the old Loop checkbox lines from `render()`**

In `render()` (currently lines 517-518), delete:
```js
    loopCheckbox.checked = !!anim?.loop;
    loopCheckbox.disabled = !anim;
```
(no replacement needed — Preview Loop is not tied to `anim` selection).

- [ ] **Step 9: CSS for the ms caption**

Append to `css/app.css` (near the existing `.timeline-loop` rule at line
173):
```css
.timeline-cell-ms-caption { font-size: 9px; color: #9a9ca8; }
```

- [ ] **Step 10: Run the full suite**

Run: `npm test`
Expected: PASS (no unit tests target `timeline.js` directly, so this step is
a regression check on everything else, particularly `tests/model.test.mjs`
and `tests/exports.test.mjs` from Tasks 1-2).

- [ ] **Step 11: Playwright smoke**

Serve the app (`npx http-server -p 8123 -c-1` from the repo root or reuse a
running instance) and drive `http://localhost:8123/?autotest` via the
Playwright MCP tools — no pointer drags, per project convention:

1. Timeline: click "New" to create an animation, select a frame with the
   frame tool, click "Add selected frame". Confirm the new cell's duration
   input shows `100` (the animation's inherited default, ms-primary since
   `baseFps` is unset for a plain `addAnimation` call with no project
   defaults set).
2. Toggle "Preview Loop" off, then via `browser_evaluate` read
   `state.project.sheets[...].animations[...].loop` — confirm it is
   unchanged (still whatever it was, since Preview Loop never touches it).
3. Via `browser_evaluate`, set the selected animation's
   `baseFps = 24; baseStep = 2; baseDuration = 83;` directly on the state
   object, then trigger a re-render (`import('/js/app/state.js').then(m => m.emit('project'))`
   or equivalent). Confirm the timeline cell's ms input is replaced by a
   "Frames" input showing `2` with an `83ms` caption next to it.
4. Change that Frames input to `1`, confirm the caption updates to `42ms`
   and `browser_evaluate` shows the entry's `step` is now `1` (`duration`
   untouched/dormant).
5. Check the browser console — zero errors/warnings.

Update `tests/smoke.md` item 28 (section "6. Animation", currently: `[A]
Toggle "Loop"; Play (▶) advances the preview canvas through frames, wrapping
if looped; Pause stops it. First/Last transport buttons jump to the ends.
Speed selector changes playback rate.`) to:
```
28. [A] Toggle "Preview Loop"; Play (▶) advances the preview canvas through
    frames, wrapping if Preview Loop is on; Pause stops it. First/Last
    transport buttons jump to the ends. Speed selector changes playback
    rate. Preview Loop never touches the animation's export `loop` flag
    (checked via `browser_evaluate`, not visually).
```

- [ ] **Step 12: Commit**

```bash
git add js/ui/timeline.js css/app.css tests/smoke.md
git commit -m "feat: timeline gets Preview Loop (decoupled from export loop) and fps-mode per-frame step input"
```

---

### Task 4: Frames panel — drop the strip name field

**Files:**
- Modify: `js/ui/frames.js`

**Interfaces:** none (leaf UI cleanup).

- [ ] **Step 1: Remove `nameInput` from `renderStripDetail`**

Change (currently lines 1671-1706):
```js
  function renderStripDetail(sheet, anim, selected) {
    const members = stripMembers(sheet, anim);
    if (!members.length) return;
    const b = boundingBoxOf(members);
    const segs = segmentsOf(anim).length;
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const title = document.createElement('div');
    title.className = 'frame-field';
    title.textContent = `Strip · ${members.length} frames${segs > 1 ? ` · ${segs} sub-strips` : ''}`;

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = anim.name;
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v && v !== anim.name) commitRenameStrip(sheet, anim, members, v);
      else nameInput.value = anim.name;
    });

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      fieldRow('X', b.x, { onCommit: (v) => moveStripTo(sheet, members, v, b.y) }),
      fieldRow('Y', b.y, { onCommit: (v) => moveStripTo(sheet, members, b.x, v) }),
      fieldRow('W', members[0].w, { onCommit: (v) => setStripFrameSize(sheet, anim, members, 'w', v) }),
      fieldRow('H', members[0].h, { onCommit: (v) => setStripFrameSize(sheet, anim, members, 'h', v) }),
      fieldRow('PivotX', members[0].pivotX, { step: 0.5, onCommit: (v) => setStripPivot(members, 'pivotX', v) }),
      fieldRow('PivotY', members[0].pivotY, { step: 0.5, onCommit: (v) => setStripPivot(members, 'pivotY', v) }),
    );

    row.append(title, nameInput, fields, actionsRow(sheet, selected, true));
    list.appendChild(row);
  }
```
to:
```js
  function renderStripDetail(sheet, anim, selected) {
    const members = stripMembers(sheet, anim);
    if (!members.length) return;
    const b = boundingBoxOf(members);
    const segs = segmentsOf(anim).length;
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const title = document.createElement('div');
    title.className = 'frame-field';
    title.textContent = `Strip · ${members.length} frames${segs > 1 ? ` · ${segs} sub-strips` : ''}`;

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      fieldRow('X', b.x, { onCommit: (v) => moveStripTo(sheet, members, v, b.y) }),
      fieldRow('Y', b.y, { onCommit: (v) => moveStripTo(sheet, members, b.x, v) }),
      fieldRow('W', members[0].w, { onCommit: (v) => setStripFrameSize(sheet, anim, members, 'w', v) }),
      fieldRow('H', members[0].h, { onCommit: (v) => setStripFrameSize(sheet, anim, members, 'h', v) }),
      fieldRow('PivotX', members[0].pivotX, { step: 0.5, onCommit: (v) => setStripPivot(members, 'pivotX', v) }),
      fieldRow('PivotY', members[0].pivotY, { step: 0.5, onCommit: (v) => setStripPivot(members, 'pivotY', v) }),
    );

    row.append(title, fields, actionsRow(sheet, selected, true));
    list.appendChild(row);
  }
```

- [ ] **Step 2: Delete the now-dead `commitRenameStrip`**

Delete (currently lines 1223-1233):
```js
// Renames the animation, its layer group, AND its member frames (`name_0`, `name_1`, …).
function commitRenameStrip(sheet, anim, members, newName) {
  const beforeAnim = anim.name;
  const beforeNames = members.map(f => f.name);
  state.commands.push({
    label: 'rename strip',
    do() { renameAnimation(sheet, anim.id, newName); members.forEach((f, i) => { f.name = `${newName}_${i}`; }); },
    undo() { renameAnimation(sheet, anim.id, beforeAnim); members.forEach((f, i) => { f.name = beforeNames[i]; }); },
  });
  markDirty();
}
```
(Confirmed via grep this is the only definition and only call site — safe to
delete outright, no dead references left behind.)

- [ ] **Step 3: Drop the now-unused `renameAnimation` import**

Change the model import line (currently line 16):
```js
import { addFrame, removeFrame, addAnimation, renameAnimation, animationGroup, acceptAnimation, flattenLayers } from '../core/model.js';
```
to:
```js
import { addFrame, removeFrame, addAnimation, animationGroup, acceptAnimation, flattenLayers } from '../core/model.js';
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Playwright smoke**

Against `http://localhost:8123/?autotest`:
1. Create a strip (Frames panel "New strip…"). Select one of its frames.
   Confirm the Frames panel's strip-detail block shows the title and X/Y/W/H/
   Pivot fields but no name `<input>`.
2. Rename the animation via the timeline's ✎ button (still present per
   Task 3 — unchanged). Confirm the rename applies (timeline's animSelect
   option label updates).
3. Console: zero errors/warnings.

- [ ] **Step 6: Commit**

```bash
git add js/ui/frames.js
git commit -m "refactor: drop strip name field from Frames panel (moves to Animation panel), delete dead commitRenameStrip"
```

---

### Task 5: Animation panel (shared duration control + new panel)

**Files:**
- Create: `js/ui/baseDurationControl.js`
- Create: `js/ui/animpanel.js`
- Modify: `index.html`
- Modify: `js/app/main.js`
- Modify: `css/app.css`

**Interfaces:**
- Consumes: `fpsStepToMs`/`msToFps` (Task 1), `renameAnimation` (existing,
  `js/core/model.js`).
- Produces: `buildBaseDurationControl({ getValue, setValue })` → `{ el,
  refresh() }`, reused by Task 6's two dialogs. `mountAnimationsPanel(el)`,
  called once from `main.js`.

- [ ] **Step 1: `js/ui/baseDurationControl.js`**

```js
// Shared ms/fps(+step) control for a "base duration" value -- reused by the
// Animation panel (js/ui/animpanel.js) and, in the next task, the New
// Project and Project Settings dialogs (js/app/main.js). One unit is
// "primary" (editable) at a time; the other is shown read-only, live-
// converted, for reference. fps-primary additionally shows a "Step" field
// ("animate on Ns"). See
// docs/superpowers/specs/2026-07-19-animation-panel-design.md.
import { fpsStepToMs, msToFps } from '../core/model.js';

// getValue() -> { durationMs, baseFps, baseStep } (baseFps/baseStep may be
//   undefined -- that's what makes ms the primary unit).
// setValue(next) -> called with a full { durationMs, baseFps, baseStep }
//   replacement on every commit; caller decides how to persist it.
export function buildBaseDurationControl({ getValue, setValue }) {
  const wrap = document.createElement('div');
  wrap.className = 'duration-control';

  const toggle = document.createElement('div');
  toggle.className = 'duration-control-toggle';
  const btnMs = document.createElement('button');
  btnMs.type = 'button'; btnMs.textContent = 'ms'; btnMs.className = 'btn-sm';
  const btnFps = document.createElement('button');
  btnFps.type = 'button'; btnFps.textContent = 'fps'; btnFps.className = 'btn-sm';
  toggle.append(btnMs, btnFps);

  const msRow = document.createElement('label');
  msRow.className = 'duration-control-row';
  msRow.append(document.createTextNode('ms/frame'));
  const msInput = document.createElement('input');
  msInput.type = 'number'; msInput.min = '1';
  msRow.appendChild(msInput);

  const fpsRow = document.createElement('label');
  fpsRow.className = 'duration-control-row';
  fpsRow.append(document.createTextNode('fps'));
  const fpsInput = document.createElement('input');
  fpsInput.type = 'number'; fpsInput.min = '0.1'; fpsInput.step = '0.1';
  fpsRow.appendChild(fpsInput);

  const stepRow = document.createElement('label');
  stepRow.className = 'duration-control-row';
  stepRow.append(document.createTextNode('animate on Ns'));
  const stepInput = document.createElement('input');
  stepInput.type = 'number'; stepInput.min = '1'; stepInput.step = '1';
  stepRow.appendChild(stepInput);

  wrap.append(toggle, msRow, fpsRow, stepRow);

  function isFpsPrimary() { return getValue().baseFps != null; }

  function refresh() {
    const v = getValue();
    const fpsPrimary = v.baseFps != null;
    btnMs.classList.toggle('active', !fpsPrimary);
    btnFps.classList.toggle('active', fpsPrimary);
    stepRow.hidden = !fpsPrimary;

    msInput.disabled = fpsPrimary;
    fpsInput.disabled = !fpsPrimary;
    stepInput.disabled = !fpsPrimary;

    msInput.value = String(v.durationMs);
    fpsInput.value = String(fpsPrimary ? v.baseFps : Math.round(msToFps(v.durationMs) * 100) / 100);
    stepInput.value = String(fpsPrimary ? (v.baseStep ?? 1) : 1);
  }

  btnMs.addEventListener('click', () => {
    if (!isFpsPrimary()) return;
    setValue({ durationMs: getValue().durationMs, baseFps: undefined, baseStep: undefined });
    refresh();
  });
  btnFps.addEventListener('click', () => {
    if (isFpsPrimary()) return;
    const fps = Math.round(msToFps(getValue().durationMs) * 100) / 100;
    const step = 1;
    setValue({ durationMs: fpsStepToMs(fps, step), baseFps: fps, baseStep: step });
    refresh();
  });

  msInput.addEventListener('change', () => {
    let v = parseInt(msInput.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    setValue({ durationMs: v, baseFps: undefined, baseStep: undefined });
    refresh();
  });

  function commitFpsStep() {
    let fps = parseFloat(fpsInput.value);
    if (!Number.isFinite(fps) || fps <= 0) fps = 1;
    let step = parseInt(stepInput.value, 10);
    if (!Number.isFinite(step) || step < 1) step = 1;
    setValue({ durationMs: fpsStepToMs(fps, step), baseFps: fps, baseStep: step });
    refresh();
  }
  fpsInput.addEventListener('change', commitFpsStep);
  stepInput.addEventListener('change', commitFpsStep);

  refresh();
  return { el: wrap, refresh };
}
```

- [ ] **Step 2: `js/ui/animpanel.js`**

```js
// Sidebar panel for the currently-SELECTED ANIMATION (as opposed to
// frames.js's Frames panel, which is scoped to the selected frame/strip's
// geometry). Follows the timeline's selection (state.selectedAnimationId),
// so it stays populated even when the Frames panel shows "no frame
// selected". Mirrors the mount/render-on-emit pattern every other panel
// uses (see frames.js's mountFramesPanel). See
// docs/superpowers/specs/2026-07-19-animation-panel-design.md.
import { state, on, activeSheet, markDirty } from '../app/state.js';
import { renameAnimation } from '../core/model.js';
import { buildBaseDurationControl } from './baseDurationControl.js';

function commitRenameAnim(sheet, anim, name) {
  const before = anim.name;
  if (before === name) return;
  state.commands.push({
    label: 'rename animation',
    do() { renameAnimation(sheet, anim.id, name); },
    undo() { renameAnimation(sheet, anim.id, before); },
  });
  markDirty();
}

function commitToggleLoop(anim, loop) {
  const before = anim.loop;
  if (before === loop) return;
  state.commands.push({
    label: 'toggle animation loop',
    do() { anim.loop = loop; },
    undo() { anim.loop = before; },
  });
  markDirty();
}

function commitBaseDuration(anim, before, after) {
  state.commands.push({
    label: 'edit base duration',
    do() { anim.baseDuration = after.durationMs; anim.baseFps = after.baseFps; anim.baseStep = after.baseStep; },
    undo() { anim.baseDuration = before.durationMs; anim.baseFps = before.baseFps; anim.baseStep = before.baseStep; },
  });
  markDirty();
}

export function mountAnimationsPanel(el) {
  el.innerHTML = '';
  const h3 = document.createElement('h3');
  h3.textContent = 'Animation';
  el.appendChild(h3);

  const hint = document.createElement('div');
  hint.className = 'frame-field';
  hint.textContent = 'No animation selected — pick one in the timeline.';

  const body = document.createElement('div');
  body.className = 'frame-row active';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'frame-name';

  const loopLabel = document.createElement('label');
  loopLabel.className = 'timeline-loop';
  loopLabel.title = 'Whether the exported animation loops (see the timeline\'s separate Preview Loop for playback-only looping).';
  const loopCheckbox = document.createElement('input');
  loopCheckbox.type = 'checkbox';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));

  let currentAnim = null;

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

  body.append(nameInput, loopLabel, durationControl.el);
  el.append(hint, body);

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

  function render() {
    if (state.mode !== 'sprites') { el.hidden = true; return; }
    el.hidden = false;
    const sheet = activeSheet();
    currentAnim = sheet?.animations.find(a => a.id === state.selectedAnimationId) ?? null;
    hint.hidden = !!currentAnim;
    body.hidden = !currentAnim;
    if (!currentAnim) return;
    nameInput.value = currentAnim.name;
    loopCheckbox.checked = !!currentAnim.loop;
    durationControl.refresh();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; render(); });
  }

  on('project', scheduleRender);
  on('history', scheduleRender);
  on('view', scheduleRender);
  on('selection', scheduleRender);
  render();
}
```

- [ ] **Step 3: Mount point in `index.html`**

Change (currently lines 34-39):
```html
  <aside id="side-panels">
    <div id="panel-layers" class="panel"><h3>Layers</h3></div>
    <div id="panel-context" class="panel"></div>
    <div id="panel-autotiles" class="panel"></div>
    <div id="panel-tilelayers" class="panel"></div>
  </aside>
```
to:
```html
  <aside id="side-panels">
    <div id="panel-layers" class="panel"><h3>Layers</h3></div>
    <div id="panel-context" class="panel"></div>
    <div id="panel-animation" class="panel"></div>
    <div id="panel-autotiles" class="panel"></div>
    <div id="panel-tilelayers" class="panel"></div>
  </aside>
```

- [ ] **Step 4: Mount it in `js/app/main.js`**

Add the import (near the other `frames.js`/panel imports, e.g. right after
the `mountTimeline` import):
```js
import { mountAnimationsPanel } from '../ui/animpanel.js';
```

Change (currently line 526):
```js
mountFramesPanel(document.getElementById('panel-context'));
```
to:
```js
mountFramesPanel(document.getElementById('panel-context'));
mountAnimationsPanel(document.getElementById('panel-animation'));
```

- [ ] **Step 5: CSS**

Append to `css/app.css`:
```css
.duration-control { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.duration-control-toggle { display: flex; gap: 4px; }
.duration-control-toggle button { flex: 1; }
.duration-control-row { display: flex; align-items: center; gap: 4px; font-size: 11px; color: #9a9ca8; }
.duration-control-row input { width: 60px; }
.duration-control-row input:disabled { opacity: .6; }
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (no unit tests target these new UI files).

- [ ] **Step 7: Playwright smoke**

Against `http://localhost:8123/?autotest`:
1. Select an animation in the timeline. Confirm the new Animation panel
   (below Frames) shows its name, a Loop checkbox, and the ms/fps duration
   control (ms-primary by default).
2. Rename via the panel's name field; confirm the timeline's animSelect
   option label updates (shared re-render).
3. Rename via the timeline's ✎ button instead; confirm the panel's name
   field updates too (same `anim.name`, both listen to `project`/`history`).
4. Toggle Loop in the panel; via `browser_evaluate` confirm `anim.loop`
   changed AND the timeline's Preview Loop checkbox state is untouched.
5. Click the "fps" toggle button in the panel; confirm the ms field becomes
   disabled/read-only and Step appears; set fps=24, Step=2; via
   `browser_evaluate` confirm `anim.baseDuration === 83`,
   `anim.baseFps === 24`, `anim.baseStep === 2`.
6. Add a new frame to this (now fps-primary) animation via "Add selected
   frame"; confirm its timeline cell shows a Frames input (from Task 3) with
   value `2` and an `83ms` caption.
7. Click "ms" to switch back to ms-primary; confirm the panel's ms field
   becomes editable again showing `83`, and the timeline cell for that same
   frame switches back to a plain ms input showing `83`.
8. No animation selected (deselect): panel shows the "No animation selected"
   hint, no crash.
9. Console: zero errors/warnings.

Update `tests/smoke.md`: add a new item after item 28 in section "6.
Animation":
```
29. [A] Animation panel (below Frames): shows name/Loop/duration for the
    timeline's selected animation, independent of the Frames panel's own
    selection. Renaming via the panel and via the timeline's ✎ button both
    update the same animation name. Loop here is the export flag, distinct
    from the timeline's Preview Loop. Switching the duration control between
    ms and fps+Step changes what the timeline's per-frame cells accept
    (plain ms vs a Frames/step count with a read-only ms caption).
```

- [ ] **Step 8: Commit**

```bash
git add js/ui/baseDurationControl.js js/ui/animpanel.js index.html js/app/main.js css/app.css tests/smoke.md
git commit -m "feat: add Animation panel (name, export Loop, ms/fps base duration) below the Frames panel"
```

---

### Task 6: Project-level default duration (New Project dialog, Project Settings dialog, Edit menu)

**Files:**
- Modify: `index.html`
- Modify: `js/app/main.js`

**Interfaces:**
- Consumes: `buildBaseDurationControl` (Task 5), `DEFAULT_SETTINGS` (existing,
  `js/core/model.js`), `addAnimation`'s `defaults` param (Task 1, already
  wired to `state.project?.settings` at every call site — this task is what
  actually gets non-default `baseFps`/`baseStep` values into
  `state.project.settings` in the first place).

- [ ] **Step 1: New Project dialog markup — swap the plain ms field for a mount point**

In `index.html`, change (currently lines 63-64, inside `#dlg-newproject`):
```html
    <span>Frame time</span><input id="np-duration" type="number" min="1" value="100">
    <span>ms</span><span></span>
```
to:
```html
    <span>Frame time</span><div id="np-duration-control" style="grid-column: 2 / span 3"></div>
```

- [ ] **Step 2: New `dlg-projectsettings` dialog markup**

In `index.html`, add right after `#dlg-newproject`'s closing `</dialog>`
(currently line 67), before `#dlg-newsheet`:
```html
<dialog id="dlg-projectsettings">
  <h3>Project Settings</h3>
  <div class="dlg-grid">
    <span>Sprite sheet</span><input id="ps-sprite-w" type="number" min="1" max="4096" value="256">
    <span>×</span><input id="ps-sprite-h" type="number" min="1" max="4096" value="256">
    <span>Tile sheet</span><input id="ps-tile-sheet-w" type="number" min="1" max="4096" value="256">
    <span>×</span><input id="ps-tile-sheet-h" type="number" min="1" max="4096" value="256">
    <span>Tile size</span><input id="ps-tile-w" type="number" min="1" max="256" value="16">
    <span>×</span><input id="ps-tile-h" type="number" min="1" max="256" value="16">
    <span>Frame size</span><input id="ps-frame-w" type="number" min="1" max="1024" value="16">
    <span>×</span><input id="ps-frame-h" type="number" min="1" max="1024" value="16">
    <span>Frame time</span><div id="ps-duration-control" style="grid-column: 2 / span 3"></div>
  </div>
  <div class="row"><button id="ps-ok" class="btn-sm">OK</button><button id="ps-cancel" class="btn-sm">Cancel</button></div>
</dialog>
```
Note: these dimension fields set defaults for *future* new sheets/frames —
they never resize any existing sheet (matches `DEFAULT_SETTINGS`'s existing
role; see the spec's "Error handling" note for this dialog).

- [ ] **Step 3: `main.js` — imports and shared field-coercion helpers**

Extend the existing model import (currently line 4):
```js
import { flattenSheet, createSheet, removeSheet, sheetLayers, layerAnimationContext } from '../core/model.js';
```
to:
```js
import { flattenSheet, createSheet, removeSheet, sheetLayers, layerAnimationContext, DEFAULT_SETTINGS } from '../core/model.js';
```

Add a new import (near the other `../ui/*` imports, e.g. after the
`mountAnimationsPanel` import added in Task 5):
```js
import { buildBaseDurationControl } from '../ui/baseDurationControl.js';
```

Add two module-level helpers right after `isTypingTarget` (currently ends
around line 30), replacing the need for `npCreate`'s previously-local
`sheetDim`/`positiveInt` closures — both the New Project and the new Project
Settings handlers will call these:
```js
// Shared field coercion for the New Project / Project Settings dialogs.
function sheetDimField(el) {
  const v = parseInt(el.value, 10);
  return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
}
function positiveIntField(el) {
  const v = parseInt(el.value, 10);
  return (Number.isNaN(v) || v < 1) ? null : v;
}
```

- [ ] **Step 4: New Project dialog — wire the shared duration control**

Change (currently line 65):
```js
const npDuration = document.getElementById('np-duration');
```
to:
```js
const npDurationMount = document.getElementById('np-duration-control');
let npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
const npDurationControl = buildBaseDurationControl({
  getValue: () => npDurationValue,
  setValue: (v) => { npDurationValue = v; },
});
npDurationMount.appendChild(npDurationControl.el);
```

In `defineAction('file.new', ...)` (currently lines 658-664), reset the
control before opening the dialog:
```js
defineAction('file.new', {
  label: 'New',
  run: () => {
    if (state.dirty && !confirmOrAuto('Discard unsaved changes and start a new project?')) return;
    npDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
    npDurationControl.refresh();
    dlgNewProject.showModal();
  },
});
```

- [ ] **Step 5: `npCreate`'s handler uses `sheetDimField`/`positiveIntField`/`npDurationValue`**

Replace the whole handler (currently lines 666-696):
```js
npCreate.addEventListener('click', () => {
  // Sheet dims (sprite/tile sheet W/H) are clamped to the 1..4096 range;
  // everything else (tile size, frame size, duration) just needs to be a
  // positive integer. Any NaN or sub-1 value aborts with an alert rather
  // than silently coercing, so e.g. a blank or 0 sprite width is rejected.
  const sheetDim = (el) => {
    const v = parseInt(el.value, 10);
    return (Number.isNaN(v) || v < 1) ? null : Math.min(4096, v);
  };
  const positiveInt = (el) => {
    const v = parseInt(el.value, 10);
    return (Number.isNaN(v) || v < 1) ? null : v;
  };
  const spriteSheetW = sheetDim(npSpriteW);
  const spriteSheetH = sheetDim(npSpriteH);
  const tileSheetW = sheetDim(npTileSheetW);
  const tileSheetH = sheetDim(npTileSheetH);
  const tileW = positiveInt(npTileW);
  const tileH = positiveInt(npTileH);
  const frameW = positiveInt(npFrameW);
  const frameH = positiveInt(npFrameH);
  const durationMs = positiveInt(npDuration);
  const settings = { spriteSheetW, spriteSheetH, tileSheetW, tileSheetH, tileW, tileH, frameW, frameH, durationMs };
  if (Object.values(settings).some(v => v == null)) {
    alert('Please enter valid positive numbers for all fields.');
    return;
  }
  state.fileHandle = null; state.dirHandle = null; state.saveMode = null;
  setProject(newDefaultProject(settings));
  dlgNewProject.close();
});
```
with:
```js
npCreate.addEventListener('click', () => {
  // Sheet dims (sprite/tile sheet W/H) are clamped to the 1..4096 range;
  // everything else (tile size, frame size) just needs to be a positive
  // integer. Any NaN or sub-1 value aborts with an alert rather than
  // silently coercing, so e.g. a blank or 0 sprite width is rejected.
  // Frame time comes from npDurationControl, which always self-coerces to a
  // valid positive value -- it never needs this validation pass.
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
  setProject(newDefaultProject(settings));
  dlgNewProject.close();
});
```

- [ ] **Step 6: Project Settings dialog wiring**

Add this block right after the `npCreate` handler above (still before the
`// ---- file: Open ----` comment):
```js
// ---- Project Settings ----
const dlgProjectSettings = document.getElementById('dlg-projectsettings');
const psSpriteW = document.getElementById('ps-sprite-w');
const psSpriteH = document.getElementById('ps-sprite-h');
const psTileSheetW = document.getElementById('ps-tile-sheet-w');
const psTileSheetH = document.getElementById('ps-tile-sheet-h');
const psTileW = document.getElementById('ps-tile-w');
const psTileH = document.getElementById('ps-tile-h');
const psFrameW = document.getElementById('ps-frame-w');
const psFrameH = document.getElementById('ps-frame-h');
const psDurationMount = document.getElementById('ps-duration-control');
const psOk = document.getElementById('ps-ok');
const psCancel = document.getElementById('ps-cancel');

let psDurationValue = { durationMs: DEFAULT_SETTINGS.durationMs, baseFps: undefined, baseStep: undefined };
const psDurationControl = buildBaseDurationControl({
  getValue: () => psDurationValue,
  setValue: (v) => { psDurationValue = v; },
});
psDurationMount.appendChild(psDurationControl.el);

defineAction('edit.projectSettings', {
  label: 'Project Settings…',
  run: () => {
    const settings = state.project?.settings;
    if (!settings) return;
    psSpriteW.value = String(settings.spriteSheetW);
    psSpriteH.value = String(settings.spriteSheetH);
    psTileSheetW.value = String(settings.tileSheetW);
    psTileSheetH.value = String(settings.tileSheetH);
    psTileW.value = String(settings.tileW);
    psTileH.value = String(settings.tileH);
    psFrameW.value = String(settings.frameW);
    psFrameH.value = String(settings.frameH);
    psDurationValue = { durationMs: settings.durationMs, baseFps: settings.baseFps, baseStep: settings.baseStep };
    psDurationControl.refresh();
    dlgProjectSettings.showModal();
  },
  isEnabled: () => !!state.project,
});
psCancel.addEventListener('click', () => dlgProjectSettings.close());
psOk.addEventListener('click', () => {
  const project = state.project;
  if (!project) { dlgProjectSettings.close(); return; }
  const dims = {
    spriteSheetW: sheetDimField(psSpriteW), spriteSheetH: sheetDimField(psSpriteH),
    tileSheetW: sheetDimField(psTileSheetW), tileSheetH: sheetDimField(psTileSheetH),
    tileW: positiveIntField(psTileW), tileH: positiveIntField(psTileH),
    frameW: positiveIntField(psFrameW), frameH: positiveIntField(psFrameH),
  };
  if (Object.values(dims).some(v => v == null)) {
    alert('Please enter valid positive numbers for all fields.');
    return;
  }
  const before = { ...project.settings };
  const after = {
    ...dims, durationMs: psDurationValue.durationMs,
    ...(psDurationValue.baseFps != null ? { baseFps: psDurationValue.baseFps, baseStep: psDurationValue.baseStep } : {}),
  };
  state.commands.push({
    label: 'edit project settings',
    do() { project.settings = { ...after }; },
    undo() { project.settings = { ...before }; },
  });
  markDirty();
  dlgProjectSettings.close();
});
```

- [ ] **Step 7: Edit menu entry**

In the `MENUS` array (currently lines 620-623), change:
```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' },
  ] },
```
to:
```js
  { label: 'Edit', items: [
    { action: 'edit.undo' }, { action: 'edit.redo' }, { separator: true },
    { action: 'edit.cut' }, { action: 'edit.copy' }, { action: 'edit.paste' }, { separator: true },
    { action: 'edit.projectSettings' },
  ] },
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Playwright smoke**

Against `http://localhost:8123/?autotest`:
1. File > New: confirm the New Project dialog shows the ms/fps duration
   control (ms-primary, `100` by default) in place of the old plain ms
   field. Switch it to fps-primary (24 fps, Step 1), fill the rest, Create.
2. Via `browser_evaluate`, confirm `state.project.settings.baseFps === 24`
   and `settings.baseStep === 1` and `settings.durationMs === 42`.
3. Timeline: create a new animation. Via `browser_evaluate`, confirm its
   `baseFps`/`baseStep`/`baseDuration` match the project defaults from step
   2 (not ms-100) — this exercises `addAnimation`'s `defaults` param from
   Task 1 end-to-end for the first time.
4. Edit menu > Project Settings: confirm it opens pre-filled with the
   current project's settings, including the duration control already
   showing fps-primary (24/1). Switch it to ms-primary at `60`, OK.
5. Via `browser_evaluate`, confirm `state.project.settings.durationMs ===
   60` and `baseFps`/`baseStep` are now `undefined` (cleared by the ms-mode
   commit). Create a new animation and confirm it now seeds at ms-primary,
   `baseDuration: 60`.
6. Undo (Ctrl+Z): confirm `state.project.settings` reverts to the prior
   (fps-primary) values.
7. Console: zero errors/warnings.

Update `tests/smoke.md`: add a new item after item 75 in section "15. v2:
New Project, sheets, strips, zoom, thumbnails":
```
76. [A] New Project dialog's Frame time field is the shared ms/fps duration
    control (same as the Animation panel); creating a project with fps
    values set round-trips `settings.baseFps`/`baseStep`. Edit menu >
    Project Settings opens the same fields pre-filled from the current
    project, edits apply as one undoable command, and new animations
    created afterward seed their base duration from the updated settings.
```

- [ ] **Step 10: Commit**

```bash
git add index.html js/app/main.js tests/smoke.md
git commit -m "feat: New Project dialog + new Project Settings dialog (Edit menu) share the ms/fps base-duration control"
```

---

## Final verification

After Task 6, run the full `tests/smoke.md` "6. Animation" and "15. v2"
sections end-to-end once more in a single Playwright pass (not per-task) to
catch any cross-task interaction the individual smoke passes above might
have missed, then hand off to `superpowers:finishing-a-development-branch`.
