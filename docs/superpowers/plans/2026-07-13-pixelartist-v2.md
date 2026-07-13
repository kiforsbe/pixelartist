# PixelArtist v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add project settings + New Project dialog, multi-sheet management, animation strips, zoom/checkerboard/dialog fixes, and layer thumbnails to the shipped v1 app.

**Architecture:** Extend the existing layers: pure additions in `js/core/` (settings in model, strip helpers, zoom table math) with node tests; UI wiring in `js/app/main.js` and `js/ui/` following the established command/event patterns.

**Tech Stack:** Vanilla ES modules, Canvas 2D, Node built-in test runner. Zero dependencies, no build step.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-pixelartist-v2-design.md`. When ambiguous, the spec wins.
- No npm dependencies, no build step. Core modules (`js/core/**`) never reference document/window/navigator/canvas.
- `PROJECT_VERSION = 2`; `project.settings` is REQUIRED (no v1 backward compatibility — v1 files rejected by validation).
- `DEFAULT_SETTINGS = { spriteSheetW: 256, spriteSheetH: 256, tileSheetW: 256, tileSheetH: 256, tileW: 16, tileH: 16, frameW: 16, frameH: 16, durationMs: 100 }`.
- Zoom table: `[0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]`; one wheel notch = one table step.
- All structural edits are undoable commands on `state.commands` following the existing idiom (`push()` executes `do()`; commands are snapshot-based and idempotent).
- Tests: `npm test` green at every commit (45 tests at start; grows during this plan — each task states the expected count).
- Commit after every task (conventional commits).
- ENVIRONMENT: Windows 11 — PowerShell syntax for all shell commands (never bash). Browser verification via Playwright MCP, ALWAYS loading `http://localhost:8080/?autotest` (serve with `npx --yes serve -l 8080 .` in background).
- Existing event model: `emit('project')` = data mutated or replaced; `'view'` = mode/view/active-sheet changed; `'pixels'` = bitmap changed mid-stroke; `'history'` = undo/redo; `'selection'`. Panels coalesce re-renders with a `queueMicrotask` guard (see `js/ui/frames.js` `scheduleRender`).

## File Structure

```
js/core/model.js        MODIFY: version 2, required settings, strip flag, createSheet tile size args
js/core/strips.js       NEW: findFreeRect, buildStripFrames (pure)
js/core/zoom.js         NEW: ZOOM_STEPS, stepZoom, snapFitZoom (pure)
js/ui/canvasview.js     MODIFY: zoom stepping, centerFit snap, checkerboard phase
css/app.css             MODIFY: dialog { margin: auto }, thumbnail styles
index.html              MODIFY: #dlg-newproject, #sheet-select, #btn-new-sheet, #dlg-newsheet
js/app/state.js         MODIFY: newDemoProject uses DEFAULT_SETTINGS/settings
js/app/main.js          MODIFY: New Project dialog, sheet selector, New Sheet dialog
js/ui/frames.js         MODIFY: strip create dialog + move-as-unit + break apart + no-resize
js/ui/timeline.js       MODIFY: Break apart button in header
js/ui/panels.js         MODIFY: layer thumbnails
tests/model.test.mjs    MODIFY; tests/bundle.test.mjs MODIFY; tests/strips.test.mjs NEW; tests/zoom.test.mjs NEW
tests/smoke.md, README.md  MODIFY (Task 7)
```

---

### Task 1: Model v2 — required settings, version 2, strip flag

**Files:**
- Modify: `js/core/model.js`, `js/app/state.js`, `tests/model.test.mjs`, `tests/bundle.test.mjs`

**Interfaces:**
- Consumes: existing model API.
- Produces:
  - `PROJECT_VERSION = 2`; `DEFAULT_SETTINGS` (exact object from Global Constraints).
  - `createProject(name, settings = { ...DEFAULT_SETTINGS }) -> project` — project gains required `settings` (shallow-copied).
  - `createSheet(project, {name, width, height, kind, tileW, tileH})` — for `kind==='tile'`, `sheet.tile.tileWidth/Height` initialize from `tileW ?? 16` / `tileH ?? 16`.
  - `addAnimation(sheet, name, strip = false)` — animation gains `strip` boolean field.
  - `serializeProject` includes `settings`; `deserializeProject` copies it and defaults `a.strip ?? false`; `validateProjectJson` requires `version === 2` AND `settings` being an object with all 9 numeric fields (else `{ok:false, error}` naming the problem).
  - `state.js`: `newDemoProject()` becomes `newDefaultProject(settings = DEFAULT_SETTINGS)` — creates `createProject('untitled', settings)` + one sprite sheet (`settings.spriteSheetW/H`) + one tile sheet (`settings.tileSheetW/H`, `tileW/H`). Export keeps the old name as an alias is NOT needed — update the two call sites in `main.js` (New button, boot) to `newDefaultProject()`.

- [ ] **Step 1: Update tests (failing first)**

In `tests/model.test.mjs` add:

```js
import { DEFAULT_SETTINGS } from '../js/core/model.js';

test('project carries required settings; version 2', () => {
  const p = createProject('s');
  assert.equal(p.version, 2);
  assert.deepEqual(p.settings, DEFAULT_SETTINGS);
  const p2 = createProject('s2', { ...DEFAULT_SETTINGS, tileW: 8 });
  assert.equal(p2.settings.tileW, 8);
});

test('createSheet tile kind honors tileW/tileH', () => {
  const p = createProject('t');
  const s = createSheet(p, { name: 'x', width: 64, height: 64, kind: 'tile', tileW: 8, tileH: 8 });
  assert.equal(s.tile.tileWidth, 8);
});

test('animations carry strip flag; serialize round-trips settings and strip', () => {
  const p = createProject('a');
  const s = createSheet(p, { name: 'sh', width: 32, height: 32, kind: 'sprite' });
  const an = addAnimation(s, 'walk', true);
  assert.equal(an.strip, true);
  const { json, images } = serializeProject(p);
  assert.equal(json.version, 2);
  assert.deepEqual(json.settings, DEFAULT_SETTINGS);
  const map = new Map(images.map(i => [i.path, i.bitmap]));
  const p2 = deserializeProject(structuredClone(json), map);
  assert.deepEqual(p2.settings, DEFAULT_SETTINGS);
  assert.equal(p2.sheets[0].animations[0].strip, true);
});

test('validateProjectJson rejects version 1 and missing/invalid settings', () => {
  assert.equal(validateProjectJson({ version: 1, sheets: [], settings: DEFAULT_SETTINGS }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [] }).ok, false);
  assert.equal(validateProjectJson({ version: 2, sheets: [], settings: { tileW: 16 } }).ok, false);
});
```

Also update existing assertions: `tests/model.test.mjs` `json.version === PROJECT_VERSION` still passes; `tests/bundle.test.mjs` has `assert.equal(json.version, 1)` → change to `2`, and its bad-version test uses 42 (still fails validation — but it must now also carry no settings; keep as-is, message regex `/version/` still matches).

- [ ] **Step 2: Run tests, verify new ones fail** — `npm test` → FAIL (DEFAULT_SETTINGS not exported etc.).

- [ ] **Step 3: Implement in `js/core/model.js`**

```js
export const PROJECT_VERSION = 2;
export const DEFAULT_SETTINGS = {
  spriteSheetW: 256, spriteSheetH: 256,
  tileSheetW: 256, tileSheetH: 256,
  tileW: 16, tileH: 16,
  frameW: 16, frameH: 16,
  durationMs: 100,
};

export function createProject(name, settings = { ...DEFAULT_SETTINGS }) {
  return { version: PROJECT_VERSION, name, settings: { ...settings },
    sheets: [], palettes: [], activePaletteId: null };
}
```

`createSheet`: in the tile branch use `{ tileWidth: opts.tileW ?? 16, tileHeight: opts.tileH ?? 16, names: {}, neighbors: {} }` (destructure `tileW, tileH` from the options object). `addAnimation(sheet, name, strip = false)` adds `strip` to the object. `serializeProject`: add `settings: { ...project.settings }` to json. `deserializeProject`: add `settings: { ...json.settings }`, and in the animations map ensure `strip: a.strip ?? false`. `validateProjectJson`:

```js
const SETTINGS_KEYS = ['spriteSheetW','spriteSheetH','tileSheetW','tileSheetH','tileW','tileH','frameW','frameH','durationMs'];
// after the version check:
if (!json.settings || typeof json.settings !== 'object')
  return { ok: false, error: 'missing settings' };
for (const k of SETTINGS_KEYS)
  if (typeof json.settings[k] !== 'number')
    return { ok: false, error: `settings.${k} missing or not a number` };
```

`js/app/state.js`: rename `newDemoProject` → `newDefaultProject(settings = DEFAULT_SETTINGS)` (import `DEFAULT_SETTINGS`), creating sheets sized from settings (sprite: `spriteSheetW/H`; tile: `tileSheetW/H` + `tileW/H` passed to createSheet). Update both `main.js` call sites.

- [ ] **Step 4: Run tests, verify pass** — `npm test` → 49/49 (45 + 4 new).
- [ ] **Step 5: Browser sanity** — app boots (?autotest), demo project now 256×256 sheets, draw works, no console errors.
- [ ] **Step 6: Commit** — `git add -A; git commit -m "feat: project format v2 with required settings and strip flag"`

---

### Task 2: Strip helpers (`js/core/strips.js`)

**Files:**
- Create: `js/core/strips.js`
- Test: `tests/strips.test.mjs`

**Interfaces:**
- Produces:
  - `findFreeRect(sheet, w, h) -> {x, y} | null` — first free position (scan candidate ys top-to-bottom, then xs left-to-right; candidates are 0 plus existing frame right/bottom edges) where a `w×h` rect fits inside the sheet without overlapping any existing frame.
  - `buildStripFrames(name, x, y, frameW, frameH, count) -> [{name, x, y, w, h, pivotX:0, pivotY:0}]` — contiguous row, names `<name>_0…_(count-1)`.

- [ ] **Step 1: Write failing tests**

`tests/strips.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFreeRect, buildStripFrames } from '../js/core/strips.js';

const sheet = (w, h, frames = []) => ({ width: w, height: h, frames });

test('empty sheet places at origin', () => {
  assert.deepEqual(findFreeRect(sheet(64, 64), 48, 16), { x: 0, y: 0 });
});

test('skips occupied space, places right of frames then next row', () => {
  const s = sheet(64, 64, [{ x: 0, y: 0, w: 32, h: 16 }]);
  assert.deepEqual(findFreeRect(s, 32, 16), { x: 32, y: 0 });
  assert.deepEqual(findFreeRect(s, 48, 16), { x: 0, y: 16 });
});

test('returns null when nothing fits', () => {
  assert.equal(findFreeRect(sheet(64, 64), 65, 16), null);
  const full = sheet(32, 16, [{ x: 0, y: 0, w: 32, h: 16 }]);
  assert.equal(findFreeRect(full, 16, 16), null);
});

test('buildStripFrames lays out a contiguous named row', () => {
  const fr = buildStripFrames('walk', 8, 4, 16, 16, 3);
  assert.deepEqual(fr.map(f => [f.name, f.x, f.y]), [
    ['walk_0', 8, 4], ['walk_1', 24, 4], ['walk_2', 40, 4],
  ]);
  assert.deepEqual(fr[0], { name: 'walk_0', x: 8, y: 4, w: 16, h: 16, pivotX: 0, pivotY: 0 });
});
```

- [ ] **Step 2: Run, verify fail** — `npm test` → FAIL (module missing).

- [ ] **Step 3: Implement `js/core/strips.js`**

```js
// Free-space finder for auto-placing animation strips. Candidate positions are
// the sheet origin plus every existing frame's right/bottom edge — the only
// places a first-fit rectangle can start.
export function findFreeRect(sheet, w, h) {
  if (w > sheet.width || h > sheet.height) return null;
  const frames = sheet.frames;
  const xs = [...new Set([0, ...frames.map(f => f.x + f.w)])]
    .filter(x => x >= 0 && x + w <= sheet.width).sort((a, b) => a - b);
  const ys = [...new Set([0, ...frames.map(f => f.y + f.h)])]
    .filter(y => y >= 0 && y + h <= sheet.height).sort((a, b) => a - b);
  for (const y of ys)
    for (const x of xs)
      if (!frames.some(f => x < f.x + f.w && f.x < x + w && y < f.y + f.h && f.y < y + h))
        return { x, y };
  return null;
}

export function buildStripFrames(name, x, y, frameW, frameH, count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `${name}_${i}`, x: x + i * frameW, y, w: frameW, h: frameH,
    pivotX: 0, pivotY: 0,
  }));
}
```

- [ ] **Step 4: Run, verify pass** — `npm test` → 53/53.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: strip placement helpers"`

---

### Task 3: Zoom stepping + checkerboard anchor (`js/core/zoom.js`, canvasview)

**Files:**
- Create: `js/core/zoom.js`
- Modify: `js/ui/canvasview.js`
- Test: `tests/zoom.test.mjs`

**Interfaces:**
- Produces:
  - `ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]`
  - `stepZoom(zoom, dir) -> number` — nearest table index, then `+dir` (±1), clamped to table ends.
  - `snapFitZoom(fit) -> number` — largest table entry ≤ fit, min `ZOOM_STEPS[0]`.
- CanvasView behavior change: wheel = one table step (cursor-anchored pan math unchanged); `centerFit()` uses `snapFitZoom` (drop the `Math.max(1, floor(...))`); checkerboard squares' parity computed from screen coords MINUS pan (phase locked to image origin).

- [ ] **Step 1: Write failing tests**

`tests/zoom.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZOOM_STEPS, stepZoom, snapFitZoom } from '../js/core/zoom.js';

test('table matches spec', () => {
  assert.deepEqual(ZOOM_STEPS, [0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]);
});

test('stepZoom advances one entry from every entry (no sticky levels)', () => {
  for (let i = 0; i < ZOOM_STEPS.length - 1; i++)
    assert.equal(stepZoom(ZOOM_STEPS[i], 1), ZOOM_STEPS[i + 1], `up from ${ZOOM_STEPS[i]}`);
  for (let i = 1; i < ZOOM_STEPS.length; i++)
    assert.equal(stepZoom(ZOOM_STEPS[i], -1), ZOOM_STEPS[i - 1], `down from ${ZOOM_STEPS[i]}`);
});

test('stepZoom clamps at ends and snaps off-table values first', () => {
  assert.equal(stepZoom(0.25, -1), 0.25);
  assert.equal(stepZoom(64, 1), 64);
  assert.equal(stepZoom(5, 1), 6);   // nearest to 5 is 4 or 6 -> 4 (tie: lower index? no: |5-4|=1,|5-6|=1 -> first found = 4) then +1 -> 6
  assert.equal(stepZoom(5, -1), 3);  // nearest 4, -1 -> 3
});

test('snapFitZoom takes largest entry <= fit, floors at 0.25', () => {
  assert.equal(snapFitZoom(5.7), 4);
  assert.equal(snapFitZoom(1), 1);
  assert.equal(snapFitZoom(0.4), 0.25);
  assert.equal(snapFitZoom(0.01), 0.25);
  assert.equal(snapFitZoom(100), 64);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `js/core/zoom.js`**

```js
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

export function stepZoom(zoom, dir) {
  let idx = 0, best = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - zoom);
    if (d < best) { best = d; idx = i; }
  }
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir))];
}

export function snapFitZoom(fit) {
  let out = ZOOM_STEPS[0];
  for (const z of ZOOM_STEPS) if (z <= fit) out = z;
  return out;
}
```

- [ ] **Step 4: Integrate in `js/ui/canvasview.js`**
  - Import `{ stepZoom, snapFitZoom }` (a UI module importing core is the established direction).
  - Wheel handler: replace the `2^±0.25`-multiply-and-snap block with `const newZoom = stepZoom(this.zoom, e.deltaY < 0 ? 1 : -1);` keeping the existing cursor-anchor pan recompute (`panX = sx - imgX * newZoom` with the unfloored image point).
  - Remove the old inline steps table / clamp constants.
  - `centerFit()`: `this.zoom = snapFitZoom(Math.min(availW / w, availH / h));` (keep the 24px margin math and centering).
  - Checkerboard: wherever square parity is computed from screen coords (`Math.floor(sx / 8)` etc.), subtract the pan first: `Math.floor((sx - this.panX) / 8)`, `Math.floor((sy - this.panY) / 8)` so the phase is locked to image (0,0). Keep 8px screen-space squares and content-rect clipping.

- [ ] **Step 5: Run tests + browser verify** — `npm test` → 58/58. Browser (?autotest): wheel up/down from default zoom walks distinct levels smoothly through the whole range (verify by dispatching WheelEvents and reading back zoom via the status bar text `#status-zoom` — expect e.g. 0.25x reachable and 16x reachable); pan the view and confirm the checker pattern moves WITH the content (screenshot before/after pan, or sample pixel parity adjacent to the content origin). No console errors.

- [ ] **Step 6: Commit** — `git add -A; git commit -m "fix: table-stepped zoom (0.25x-64x) and origin-anchored checkerboard"`

---

### Task 4: Dialog centering + New Project dialog

**Files:**
- Modify: `css/app.css`, `index.html`, `js/app/main.js`

**Interfaces:**
- Consumes: `createProject`, `createSheet`, `DEFAULT_SETTINGS` (model), `setProject`, `newDefaultProject`, `confirmOrAuto` (state).
- Produces: `#dlg-newproject` with inputs `#np-sprite-w/#np-sprite-h/#np-tile-sheet-w/#np-tile-sheet-h/#np-tile-w/#np-tile-h/#np-frame-w/#np-frame-h/#np-duration`, buttons `#np-create/#np-cancel`. The New button opens this dialog (after dirty confirm).

- [ ] **Step 1: CSS fix** — in `css/app.css` add to the existing `dialog` rule: `margin: auto;` (the global `* { margin: 0 }` reset removed the UA centering). Also add `.dlg-grid { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 6px 8px; align-items: center; margin-bottom: 10px; }` for the dialog form layout.

- [ ] **Step 2: Dialog markup** — in `index.html` next to the existing dialogs:

```html
<dialog id="dlg-newproject">
  <h3>New Project</h3>
  <div class="dlg-grid">
    <span>Sprite sheet</span><input id="np-sprite-w" type="number" min="1" max="4096" value="256">
    <span>×</span><input id="np-sprite-h" type="number" min="1" max="4096" value="256">
    <span>Tile sheet</span><input id="np-tile-sheet-w" type="number" min="1" max="4096" value="256">
    <span>×</span><input id="np-tile-sheet-h" type="number" min="1" max="4096" value="256">
    <span>Tile size</span><input id="np-tile-w" type="number" min="1" max="256" value="16">
    <span>×</span><input id="np-tile-h" type="number" min="1" max="256" value="16">
    <span>Frame size</span><input id="np-frame-w" type="number" min="1" max="1024" value="16">
    <span>×</span><input id="np-frame-h" type="number" min="1" max="1024" value="16">
    <span>Frame time</span><input id="np-duration" type="number" min="1" value="100">
    <span>ms</span><span></span>
  </div>
  <div class="row"><button id="np-create">Create</button><button id="np-cancel">Cancel</button></div>
</dialog>
```

- [ ] **Step 3: Wire in `main.js`** — replace the New button handler body: after the existing dirty `confirmOrAuto` check, `dlgNewProject.showModal()`. `#np-create` reads the 9 inputs (`parseInt`, clamp 1..4096 for sheet dims; alert + abort on NaN), builds `settings`, `setProject` a project built like `newDefaultProject(settings)` (reuse it — give `newDefaultProject` the settings argument), clears handles/saveMode, closes dialog. `#np-cancel` closes. Boot's autosave-miss path keeps plain `newDefaultProject()`.

- [ ] **Step 4: Verify in browser** — (?autotest) New opens a CENTERED dialog (screenshot); create with sprite sheet 128×64 → canvas content is 128×64 (status bar / sheet select later); all other dialogs (Save As, Export) also now centered — open each and screenshot one; no console errors. `npm test` still 58/58.

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: new project dialog with settings; fix: center all dialogs"`

---

### Task 5: Sheet selector + New Sheet dialog

**Files:**
- Modify: `index.html`, `js/app/main.js`, `css/app.css` (only if needed for top-bar fit)

**Interfaces:**
- Consumes: `createSheet`, `state`, `emit`, `activeSheet`, `markDirty`, `confirmOrAuto`, `project.settings`.
- Produces: `#sheet-select` (top bar, next to mode tabs), `#btn-new-sheet` ("+"), `#dlg-newsheet` with `#ns-name/#ns-w/#ns-h/#ns-tile-w/#ns-tile-h` (tile-size row hidden in sprite mode) and `#ns-create/#ns-cancel`.

Behavior:
- `refreshSheetSelect()`: options = project sheets of current mode kind (label = sheet name, value = id), selected = `state.activeSheetId`; called on 'project'/'view' (coalesced with the same microtask-guard pattern as the panels).
- `change` on `#sheet-select`: set `state.activeSheetId`, `state.activeLayerId` = first layer id, `state.view = 'sheet'`, `emit('view')`.
- `#btn-new-sheet` opens `#dlg-newsheet` with defaults from `project.settings` (sprite mode: `spriteSheetW/H`, name `sheet_${n}`; tile mode: `tileSheetW/H` + `tileW/H`, tile-size row visible).
- Create = ONE undoable command: build the sheet with `createSheet(project, {...})` — NOTE `createSheet` pushes into `project.sheets` immediately, so follow the existing eager-mutate-then-snapshot idiom: capture `prevActiveSheetId`/`prevActiveLayerId` before, then `cmd.do()` re-inserts the (already-built) sheet if absent and selects it; `cmd.undo()` removes it from `project.sheets` and restores the previous selection; after push: `markDirty()`, `emit('view')`. Validate dims 1..4096 (alert + abort).

- [ ] **Step 1: Add markup** (selector + button into `#mode-tabs`'s parent flow in the top bar; dialog next to the others; reuse `.dlg-grid`).
- [ ] **Step 2: Implement wiring in `main.js`** per behavior above.
- [ ] **Step 3: Verify in browser** — (?autotest) selector lists "sheet1" (sprite mode); create second sprite sheet 64×64 via dialog → selector shows it selected, canvas is 64×64, layers panel shows its Layer 1; draw on it; switch back to first sheet via selector → drawing intact per sheet; undo removes the new sheet and reselects the previous one; tile mode selector lists only tile sheets; new tile sheet honors tile size defaults. No console errors. `npm test` 58/58.
- [ ] **Step 4: Commit** — `git add -A; git commit -m "feat: sheet selector and new-sheet dialog per mode"`

---

### Task 6: Animation strips

**Files:**
- Modify: `js/ui/frames.js`, `js/ui/timeline.js`, `index.html` (strip dialog), `js/app/main.js` (only if a mount hook is needed)

**Interfaces:**
- Consumes: `findFreeRect`, `buildStripFrames` (strips.js), `addFrame`, `addAnimation` (model), `project.settings.frameW/frameH/durationMs`, existing frame-tool internals in `frames.js` (`commitMove`, drag routing, `registerFrameTool`).
- Produces:
  - "New strip…" button in the frames panel header → `#dlg-newstrip` (`#strip-name/#strip-frame-w/#strip-frame-h/#strip-count/#strip-duration`, `#strip-create/#strip-cancel`), defaults from settings, count default 4 min 1.
  - `stripOf(sheet, frameId) -> animation | null` — the intact-strip animation (`strip === true`) containing the frame (helper in frames.js, exported for timeline use if handy).
  - "Break apart" buttons: frames panel (visible when selected frame is in an intact strip) and timeline header (visible when the selected animation has `strip === true`). Both push a command toggling `anim.strip` false (undo restores true).

Behavior details:
- **Create strip** (ONE command): validate inputs; `findFreeRect(sheet, count*frameW, frameH)`; null → `alert('No free space on the sheet for this strip.')`, abort. Otherwise build frame descriptors via `buildStripFrames`, then construct: frames array entries (use `addFrame` per descriptor to get ids — eager mutation per codebase idiom), one `addAnimation(sheet, name, true)` with `frames: [{frameId, duration}]` in order; snapshot before/after of `sheet.frames` and `sheet.animations` arrays (`.map(o => ({...o}))` where nested, animations need `frames` arrays cloned) so `do()`/`undo()` restore exactly; select the first frame + the animation (`state.selectedFrameId`, `state.selectedAnimationId`); `markDirty()`.
- **Move-as-unit**: in the frame-tool drag start path, if the hit frame is in an intact strip (`stripOf`), the drag targets ALL member frames: ghost outline covers the strip's bounding box; on drop, clamp the common delta so every member stays inside the sheet; commit ONE command that (per layer) captures the union rect (old ∪ new positions of all members) before/after, moves every member's pixels (copy all regions first, then clear all, then blit all — copy-before-clear avoids overlap corruption for adjacent frames), and updates every member's x/y. Undo restores all pixels + all coords (extend the existing `commitMove` machinery — generalize it to take a list of frames + a delta rather than duplicating it).
- **No resize on strip members**: skip corner-handle hit detection when the frame is in an intact strip.
- **Break apart**: command `{do: () => { anim.strip = false; }, undo: () => { anim.strip = true; }}` + `markDirty()`-style emit via the push (label 'break apart strip'). Buttons re-render with their panels (existing coalesced renders).

- [ ] **Step 1: Implement per behavior above.**
- [ ] **Step 2: Verify in browser** — (?autotest, sprite mode):
  - New strip "walk", 16×16 × 4 frames, 100ms → 4 contiguous frames appear at a free spot with overlay labels `walk 1/4…4/4`; timeline shows the animation with 4 cells; ONE undo removes frames + animation together; redo restores.
  - Draw distinct pixels in two member frames; drag the strip by its 3rd frame → ALL frames move together, pixels carried (verify bitmap bytes), coords all shifted by same delta; one undo restores everything.
  - Resize handles: none appear on strip frames; a non-strip frame still resizes.
  - Break apart (frames panel button): flag flips; now a single member drags alone; undo of break-apart restores unit movement.
  - Second strip auto-places below/beside the first without overlap; a strip too big for remaining space alerts and creates nothing.
  - Timeline header shows Break apart for the strip animation; works.
  - No console errors. `npm test` 58/58.
- [ ] **Step 3: Commit** — `git add -A; git commit -m "feat: animation strips (create, unit move, break apart)"`

---

### Task 7: Layer thumbnails + docs

**Files:**
- Modify: `js/ui/panels.js`, `css/app.css`, `tests/smoke.md`, `README.md`

**Interfaces:**
- Consumes: layer bitmaps, panels' existing `renderList` + event subscriptions.

Behavior:
- Each layer row gains a `<canvas class="layer-thumb" width=40 height=40>` at the row start: dark background (`--bg`), the layer's own bitmap drawn aspect-fit with `imageSmoothingEnabled = false` (reuse the scratch-canvas draw pattern from `js/ui/timeline.js`'s `drawFit`/`getScratchCanvas` — extract or mirror it; do NOT allocate a canvas per row per render: one shared module-level scratch is fine since draws are synchronous).
- Refresh: layers panel currently re-renders on 'project'/'history'/'view'; ADD a 'pixels' subscription that only redraws the thumbnail canvases (not the whole list) — coalesced with a microtask guard so stroke previews don't thrash.
- CSS: `.layer-thumb { width: 40px; height: 40px; flex: none; border: 1px solid var(--border); image-rendering: pixelated; }` and adjust the row layout to fit.

- [ ] **Step 1: Implement thumbnails.**
- [ ] **Step 2: Update `tests/smoke.md`** — add numbered items: New Project dialog (custom sizes land), dialog centering, sheet selector + new sheet (+undo), strip create/move/break-apart (+undo), zoom range 0.25x–16x reachable via wheel, checkerboard follows pan, layer thumbnails live-update while drawing. Mark automatable [A]/manual [M] consistent with the existing file.
- [ ] **Step 3: Update `README.md`** — File format section: version 2 + `settings` field (list the 9 keys); mention strips (`strip` flag on animations) in the frames JSON note if applicable (export shape unchanged — animations already export name/loop/frames; add `strip` to the export? NO — spec doesn't ask; leave export shapes untouched and document that `strip` is project-internal).
- [ ] **Step 4: Verify in browser** — (?autotest) thumbnails show per-layer content (draw on layer 1, add layer 2, draw different pixels → two distinct thumbs, both live while drawing); run the NEW smoke items end-to-end [A] ones via Playwright; no console errors. `npm test` 58/58.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: live layer thumbnails; docs for v2 format and smoke items"`

---

## Self-Review Notes

- Spec coverage: §1 New Project dialog + settings (T1, T4), §2 selector + new sheet (T5), §3 strips incl. auto-place/unit-move/break-apart/no-resize (T2, T6), §4 zoom + checkerboard + dialog centering (T3, T4), §5 layer thumbnails (T7); error handling (validation/alerts in T1/T4/T5/T6); testing (new node tests T1/T2/T3, smoke T7); v1 rejection (T1 validation test).
- Type consistency: `DEFAULT_SETTINGS` keys match spec exactly; `newDefaultProject(settings)` used in T1/T4; `stepZoom/snapFitZoom` names consistent T3; `findFreeRect/buildStripFrames` consistent T2/T6; `addAnimation(sheet, name, strip)` consistent T1/T6.
- Expected test counts: 45 → 49 (T1) → 53 (T2) → 58 (T3), stable thereafter.
- Note: stepZoom test comment documents the tie-break (nearest scan keeps the FIRST/lower entry on exact ties), matching the implementation's strict `<`.
