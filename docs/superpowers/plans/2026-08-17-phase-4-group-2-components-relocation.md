# Phase 4 Group 2: js/ui → js/components Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate all 10 files in `js/ui/` into the existing `js/components/` library (some split into two focused files each), with zero behavior change, and retire `js/ui/` entirely. This is Group 2 of Phase 4 — it gates every group after it, since maps/sprites/tiles/shell all currently import from `js/ui/`.

**Architecture:** Pure Presentation-layer relocation. `js/components/` already exists (`canvas/`, `panels/`, `dom-utils.js`, `panel-mount.js`); this group extends it, no new top-level directory. Two files (`tools.js`, `panels.js`) bundle two separate concerns each and split along their existing internal boundary. No consumer's behavior changes — only import paths and (for two files) which of two new sibling modules a given export lives in.

**Tech Stack:** Vanilla ES modules, no build step, no bundler. `node --test tests/*.mjs`.

**Spec:** [2026-08-10-phase-4-shell-legacy-retirement-design.md](../specs/2026-08-10-phase-4-shell-legacy-retirement-design.md) — see "File relocation" → "`js/ui/` → `js/components/`" and "Biggest structural risk".

## Global Constraints

- No user-facing behavior change — every mode must work identically after this group, same as prior phases.
- Full suite (`npm test`) stays green after every task.
- This group's relocation is a big-bang unit per file/split, not a file-by-file strangler-fig, but is broken into 4 tasks below because Task 1's leaf-file moves must land before Tasks 2–3 can split the two files that import them.
- Every relative import in a file that moves from `js/ui/X.js` (depth: one directory under `js/`) into a **top-level** `js/components/` file (`dialogs.js`, `menubar.js`, `tool-palette.js`, `color-utils.js`) keeps the exact same `../` depth it had before — `js/ui/` and `js/components/` are sibling directories at the same depth.
- Every relative import in a file that moves from `js/ui/X.js` into a file under `js/components/canvas/` or `js/components/panels/` (one directory deeper) needs exactly **one additional `../`** prepended to every path that pointed outside `js/ui/` (e.g. `../app/state.js` → `../../app/state.js`). This plan gives the exact resulting import block for every file that needs this — do not compute it ad hoc.
- Imports that point at another file *also relocating in this same task* use the exact new path given in that file's entry below, not the general depth rule (the target's own new location matters, not just the importer's).
- No file outside the ones named in each task should be touched.
- `Delete:` a file only after every consumer of it (including sibling `js/ui/` files not yet relocated in the same task) has been updated to the new path, and the full suite passes.

---

## Task 1: Relocate the 8 leaf files (no internal split) + fix the pre-existing `isTypingTarget` bug

**Files:**
- Move: `js/ui/canvasview.js` → `js/components/canvas/canvas-view.js`
- Move: `js/ui/dimlabels.js` → `js/components/canvas/dim-labels.js`
- Move: `js/ui/overlays.js` → `js/components/canvas/sheet-overlays.js`
- Move: `js/ui/floatsession.js` → `js/components/canvas/float-session.js` (+ bug fix)
- Move: `js/ui/dialogs.js` → `js/components/dialogs.js`
- Move: `js/ui/menubar.js` → `js/components/menubar.js`
- Move: `js/ui/baseDurationControl.js` → `js/components/panels/base-duration-control.js`
- Move: `js/ui/previewpanel.js` → `js/components/panels/preview-panel.js`
- Modify (import paths only, files stay in place): `js/ui/tools.js`, `js/ui/panels.js`
- Modify (importers of the 8 moved files, listed per-file below)
- Modify (stale comments): `js/core/pixelSnapper.js:5`, `css/app.css:77`

**Interfaces:**
- Consumes: nothing new — every export name and signature of the 8 files is unchanged, only file location and (for `float-session.js` only) the `isTypingTarget` re-export mechanism.
- Produces: the new file paths below, which Task 2 (tools.js split) and Task 3 (panels.js split) import from.

### Step 1: Move the 4 files with zero import-path changes needed

These 3 have no imports at all, or import only from files that are not moving in this task:

- [ ] `git mv js/ui/canvasview.js js/components/canvas/canvas-view.js`, then change its only import line:
  ```js
  import { stepZoom, snapFitZoom } from '../../core/zoom.js';
  ```
  (was `from '../core/zoom.js'`)

- [ ] `git mv js/ui/dimlabels.js js/components/canvas/dim-labels.js` — no import lines exist in this file; no changes needed beyond the move.

- [ ] `git mv js/ui/overlays.js js/components/canvas/sheet-overlays.js`, then change its 3 import lines to:
  ```js
  import { state, activeSheet } from '../../app/state.js';
  import { getEditorHost } from '../../host/runtime.js';
  import { classifySlots } from '../../core/blob47.js';
  ```

- [ ] `git mv js/ui/baseDurationControl.js js/components/panels/base-duration-control.js`, then change its only import line to:
  ```js
  import { fpsStepToMs, msToFps } from '../../core/model.js';
  ```

- [ ] `git mv js/ui/previewpanel.js js/components/panels/preview-panel.js`, then change its 3 import lines to:
  ```js
  import { state, on } from '../../app/state.js';
  import { stepZoom, snapFitZoom } from '../../core/zoom.js';
  import { getEditorHost } from '../../host/runtime.js';
  ```

- [ ] `git mv js/ui/dialogs.js js/components/dialogs.js` — no import lines exist in this file; no changes needed beyond the move.

- [ ] `git mv js/ui/menubar.js js/components/menubar.js` — its one import line (`import { getAction, runAction } from '../app/actions.js';`) is unchanged (top-level → top-level, same depth).

### Step 2: Move `floatsession.js`, fixing the pre-existing `isTypingTarget` re-export bug

- [ ] `git mv js/ui/floatsession.js js/components/canvas/float-session.js`

- [ ] Replace the file's import block (originally lines 7–14) with:
  ```js
  import { state, on, emit, activeSheet, activeLayer, markDirty, activeLayerScope, maybeSnapPixels } from '../../app/state.js';
  import { copyRegion, fillRegion, blitRegion, blitOver, cloneBitmap, createBitmap } from '../../core/pixels.js';
  import { findLayer } from '../../core/model.js';
  import { makeTransform, isIdentity, rasterizeFloat, floatBounds } from '../../core/floating.js';
  import { decodePng } from '../../app/pngcodec.js';
  import { exportPngBlob } from '../../app/io.js';
  import { isTypingTarget } from '../dom-utils.js';

  export { isTypingTarget };
  ```
  This is the bug fix: the original `export { isTypingTarget } from '../components/dom-utils.js';` (a re-export-from statement) creates no local binding, so the bare reference to `isTypingTarget` inside this file's own `onKeydown` (originally line 452) throws `ReferenceError` on every keydown. Importing it first, then re-exporting the now-bound local name, fixes both: the local reference works, and external importers (`js/ui/tools.js`, soon `drawing-engine.js`/`tool-palette.js`) keep working unchanged since `isTypingTarget` is still part of this module's export surface.

### Step 3: Update every importer of the 8 moved files (exact old → new import line per file)

- [ ] `js/features/workbench/editor-workbench.js` — 4 of this file's import lines change:
  - line 7: `'../../ui/canvasview.js'` → `'../../components/canvas/canvas-view.js'`
  - line 10: `'../../ui/overlays.js'` → `'../../components/canvas/sheet-overlays.js'`
  - line 11: `'../../ui/previewpanel.js'` → `'../../components/panels/preview-panel.js'`
  - line 12: `'../../ui/floatsession.js'` → `'../../components/canvas/float-session.js'`
  - (lines 8–9, importing `tools.js`/`panels.js`, are untouched in this task — they change in Tasks 2–3)

- [ ] `js/modes/tiles/presentation/tile-editor-presenter.js`:
  - line 45: `'../../../ui/canvasview.js'` → `'../../../components/canvas/canvas-view.js'`
  - line 50: `'../../../ui/dialogs.js'` → `'../../../components/dialogs.js'`
  - (line 46, importing `tools.js`'s `bindDrawing`, is untouched in this task — changes in Task 2)

- [ ] `js/modes/sprites/presentation/frame-editor-presenter.js`:
  - line 35: `'../../../ui/canvasview.js'` → `'../../../components/canvas/canvas-view.js'`
  - line 37: `'../../../ui/floatsession.js'` → `'../../../components/canvas/float-session.js'`
  - (line 36, importing `tools.js`'s `bindDrawing`, is untouched in this task — changes in Task 2)

- [ ] `tests/dimlayout.test.mjs` line 3: `'../js/ui/dimlabels.js'` → `'../js/components/canvas/dim-labels.js'`

- [ ] `js/modes/sprites/presentation/frame-overlay-renderer.js` line 12: `'../../../ui/dimlabels.js'` → `'../../../components/canvas/dim-labels.js'`

- [ ] `js/modes/tiles/presentation/tile-tool-presenter.js`:
  - line 14: `'../../../ui/dimlabels.js'` → `'../../../components/canvas/dim-labels.js'`
  - (line 8, importing `tools.js`'s `registerTool`, is untouched in this task — changes in Task 2)

- [ ] `tests/floatsession.test.mjs` line 4: `'../js/ui/floatsession.js'` → `'../js/components/canvas/float-session.js'`

- [ ] `js/features/project/document-controller.js`:
  - line 5: `'../../ui/floatsession.js'` → `'../../components/canvas/float-session.js'`
  - line 7: `'../../ui/dialogs.js'` → `'../../components/dialogs.js'`

- [ ] `js/features/transforms/filter-controller.js` — 3 of this file's import lines change:
  - line 10: `'../../ui/previewpanel.js'` → `'../../components/panels/preview-panel.js'`
  - line 12: `'../../ui/dialogs.js'` → `'../../components/dialogs.js'`
  - (line 8, importing `panels.js`'s `rgbaToHex`/`hexToRgb`, is untouched in this task — changes in Task 3)

- [ ] `js/modes/sprites/presentation/timeline-presenter.js` line 22: `'../../../ui/previewpanel.js'` → `'../../../components/panels/preview-panel.js'`

- [ ] `js/features/shell/menu-controller.js`:
  - line 2: `'../../ui/dialogs.js'` → `'../../components/dialogs.js'`
  - line 3: `'../../ui/menubar.js'` → `'../../components/menubar.js'`

- [ ] `js/features/project/file-controller.js` line 21: `'../../ui/dialogs.js'` → `'../../components/dialogs.js'`

- [ ] `js/features/project/project-controller.js`:
  - line 4: `'../../ui/baseDurationControl.js'` → `'../../components/panels/base-duration-control.js'`
  - line 6: `'../../ui/dialogs.js'` → `'../../components/dialogs.js'`

- [ ] `js/modes/tiles/presentation/terrain-set-editor.js` line 6: `'../../../ui/dialogs.js'` → `'../../../components/dialogs.js'`

- [ ] `js/modes/sprites/presentation/slice-grid-dialog.js` line 4: `'../../../ui/dialogs.js'` → `'../../../components/dialogs.js'`

- [ ] `js/modes/sprites/presentation/animations-panel.js` line 10: `'../../../ui/baseDurationControl.js'` → `'../../../components/panels/base-duration-control.js'`

- [ ] `tests/architecture.test.mjs` line 56 — hardcoded path string (not an ESM import), inside the `'shared preview delegates rendering to mode providers'` test:
  ```js
  const source = await readFile(join(root, 'js/components/panels/preview-panel.js'), 'utf8');
  ```
  (was `'js/ui/previewpanel.js'`)

### Step 4: Fix the two remaining-in-place files (`js/ui/tools.js`, `js/ui/panels.js`) so they still resolve

These two files are NOT moving in this task (they split in Tasks 2–3), but they import 3 of the files that just moved. Update only their import lines, nothing else:

- [ ] `js/ui/tools.js` line 25: `'./floatsession.js'` → `'../components/canvas/float-session.js'`
- [ ] `js/ui/tools.js` line 29: `'./dimlabels.js'` → `'../components/canvas/dim-labels.js'`
- [ ] `js/ui/panels.js` line 11: `'./dialogs.js'` → `'../components/dialogs.js'`

### Step 5: Sweep the two stale comments naming moved files

- [ ] `js/core/pixelSnapper.js` line 5 — comment currently reads `...js/ui/floatsession.js's pasteSystemImage)...`; update to `...js/components/canvas/float-session.js's pasteSystemImage)...`.
- [ ] `css/app.css` line 77 — comment currently reads `...triggers it (see js/ui/dialogs.js's markDefaultAction). */`; update to `...triggers it (see js/components/dialogs.js's markDefaultAction). */`.

### Step 6: Verify and commit

- [ ] Run `npm test`. Expect all tests green, in particular: `tests/dimlayout.test.mjs`, `tests/floatsession.test.mjs`, `tests/architecture.test.mjs`.
- [ ] Confirm `js/ui/` now contains exactly 2 files: `tools.js`, `panels.js`.
- [ ] `git add` the moved/modified files and commit:
  ```bash
  git commit -m "refactor: relocate 8 js/ui leaf files into js/components, fix isTypingTarget re-export bug"
  ```

---

## Task 2: Split `js/ui/tools.js` into `components/tool-palette.js` + `components/canvas/drawing-engine.js`

This is the group's highest structural risk (per the design doc): `bindDrawing` is the shared pointer-drag engine every drawing tool in every mode runs through, and drag interactions have no automated test coverage in this codebase (Playwright never simulates drags here). Get a clean per-task review on this task before moving to Task 3, and flag the drag-drawing paths for the user's own manual verification before this group is considered done (see Task 4's closing note).

**Files:**
- Create: `js/components/tool-palette.js`
- Create: `js/components/canvas/drawing-engine.js`
- Delete: `js/ui/tools.js`
- Modify: 7 importers (listed in Step 3)

**Interfaces:**
- Consumes: `js/components/canvas/float-session.js`'s `isTypingTarget`, `registerFloatView`, `createFloat`, `commitFloatIfAny`, `pushTransformCommand`, `syncFrameFloat` (from Task 1); `js/components/canvas/dim-labels.js`'s `drawRectDims`, `drawAngleLabel` (from Task 1).
- Produces: `tool-palette.js` exports `TOOLS`, `toolOptions`, `BRUSH_TOOLS`, `SHAPE_TOOLS`, `registerTool`, `mountToolPalette` — the last two are the only ones with external consumers (`mountToolPalette` from `editor-workbench.js`; `registerTool` from mode presenters). `BRUSH_TOOLS`/`SHAPE_TOOLS`/`toolOptions` are exported specifically so `drawing-engine.js` can import them as shared mutable state — no other file should need them. `drawing-engine.js` exports only `bindDrawing`.

### Step 1: Read the current file for reference

- [ ] Open `js/ui/tools.js` (947 lines) — this task moves it in two pieces; every line of its body is preserved verbatim in one of the two new files below except for import statements and the addition of `export` keywords on `BRUSH_TOOLS`/`SHAPE_TOOLS`.

### Step 2: Create `js/components/tool-palette.js`

- [ ] Create the file with this exact import block:
  ```js
  import { state, on, emit } from '../app/state.js';
  import { isTypingTarget } from './canvas/float-session.js';
  ```
- [ ] Copy the following from `js/ui/tools.js` **verbatim** (same code, same order), with the two `const` → `export const` changes noted:
  - Lines 35–47 (`export const TOOLS = [...]`) — unchanged, already exported.
  - Lines 49–50 (`const BRUSH_TOOLS = ...`, `const SHAPE_TOOLS = ...`) — change both to `export const` (drawing-engine.js needs to import them).
  - Lines 52–58 (`export const toolOptions = {...}`) — unchanged, already exported.
  - Lines 60–72 (`SOFT_FLOOD_DISTANCE_CURVE`, `SOFT_FLOOD_DISTANCE_SCALE`, `softFloodDistanceFromSlider`, `softFloodDistanceToSlider`) — verbatim, not exported (used only within this file).
  - Lines 91–98 (`extraTools`, `paletteApi`, `export function registerTool`) — verbatim.
  - Lines 108–293 (`export function mountToolPalette(el) { ... }`) — verbatim, including its internal `window.addEventListener('keydown', ...)` block that references `isTypingTarget` (now the imported binding from `./canvas/float-session.js`).
  - Do **not** copy: the `sheetDocument` helper (lines 31–33), `activePalette()` (lines 100–104), or `bindDrawing` (lines 306–947) — these belong in `drawing-engine.js` (see Step 3; `activePalette` is textually positioned near the palette code in the original file but is only ever called from inside `bindDrawing`).

### Step 3: Create `js/components/canvas/drawing-engine.js`

- [ ] Create the file with this exact import block:
  ```js
  import { state, on, emit, activeSheet, activeLayer, markDirty } from '../../app/state.js';
  import { getEditorHost } from '../../host/runtime.js';
  import {
    cloneBitmap, drawLine, drawRect, drawEllipse, floodFill, softFloodFill,
    copyRegion, blitRegion, fillRegion, getPixel,
  } from '../../core/pixels.js';
  import { makePixelPatch } from '../../core/commands.js';
  import { forwardPoint, inversePoint, floatBounds, solveScaleTransform } from '../../core/floating.js';
  import { nearestColor } from '../../core/palettes.js';
  import { flattenSheet, animationGroup, flattenLayers } from '../../core/model.js';
  import { segmentAt } from '../../core/strips.js';
  import { registerFloatView, isTypingTarget, createFloat, commitFloatIfAny, pushTransformCommand, syncFrameFloat } from './float-session.js';
  import { commitAcceptAnimation } from '../../features/animations/commands.js';
  import { stripForFrame as stripOf } from '../../domain/sprites/strips.js';
  import { HANDLES_ALL, handlePoint, isCenterAnchorModifier, isProportionalModifier, resizeRectFromHandle } from '../../core/resizeAnchor.js';
  import { drawRectDims, drawAngleLabel } from './dim-labels.js';
  import { BRUSH_TOOLS, SHAPE_TOOLS, toolOptions } from '../tool-palette.js';
  ```
- [ ] Copy the following from `js/ui/tools.js` **verbatim**:
  - Lines 31–33 (`sheetDocument` helper).
  - Lines 100–104 (`activePalette()`).
  - Lines 306–947 (`export function bindDrawing(view, getTargetRect, mapPoint, viewKind = 'sheet') { ... }`), including its closing brace at line 947. Every reference inside this block to `toolOptions.*`, `BRUSH_TOOLS.has(...)`, `SHAPE_TOOLS.has(...)` now resolves through the imported bindings from `tool-palette.js` — since `toolOptions` is a plain object (never reassigned, only its properties are mutated by `mountToolPalette`'s checkbox/slider handlers) and `BRUSH_TOOLS`/`SHAPE_TOOLS` are `Set`s that are only ever read here, importing them is sufficient to share live state between the two files — no other wiring is needed.
- [ ] In this new file's header comment (adapted from the original file's lines 1–12), update the reference from "main.js" and rendering notes as needed to stay accurate, and specifically fix the now-stale cross-reference inside `float-session.js`'s own header comment (originally lines 4–6: "Pointer GESTURES (drag/scale/rotate) live in tools.js's move tool... This module must never import tools.js") — edit `js/components/canvas/float-session.js`'s header comment to say `drawing-engine.js` in both places instead of `tools.js`.

### Step 4: Delete the old file and update its 7 importers

- [ ] `rm js/ui/tools.js` (or `git rm`).

- [ ] `js/features/workbench/editor-workbench.js` line 8 — was one import line for both names; split into two:
  ```js
  import { mountToolPalette } from '../../components/tool-palette.js';
  import { bindDrawing } from '../../components/canvas/drawing-engine.js';
  ```

- [ ] `js/modes/tiles/presentation/autotile-paint-presenter.js` line 9: `'../../../ui/tools.js'` (uses `registerTool`) → `'../../../components/tool-palette.js'`

- [ ] `js/modes/tiles/presentation/tile-editor-presenter.js` line 46: `'../../../ui/tools.js'` (uses `bindDrawing`) → `'../../../components/canvas/drawing-engine.js'`

- [ ] `js/modes/tiles/presentation/tile-tool-presenter.js` line 8: `'../../../ui/tools.js'` (uses `registerTool`) → `'../../../components/tool-palette.js'`

- [ ] `js/modes/sprites/presentation/frame-editor-presenter.js` line 36: `'../../../ui/tools.js'` (uses `bindDrawing`) → `'../../../components/canvas/drawing-engine.js'`

- [ ] `js/modes/sprites/presentation/frame-tool-presenter.js` line 14: `'../../../ui/tools.js'` (uses `registerTool`) → `'../../../components/tool-palette.js'`

- [ ] `js/modes/maps/presentation/map-tool-presenter.js` line 4: `'../../../ui/tools.js'` (uses `registerTool`) → `'../../../components/tool-palette.js'`

### Step 5: Verify and commit

- [ ] Run `npm test`. Expect all tests green.
- [ ] Serve the app (`serve.ps1`) and, loaded with `?autotest` (per established policy — disables blocking dialogs), do a non-drag Playwright smoke pass personally (not delegated, per the established policy that subagent-reported browser evidence is unreliable): open each of the 3 modes (sprites, tiles, maps where applicable), confirm the tool palette renders with all buttons, confirm clicking a tool selects it (button gets `.active`), confirm the options row (brush size, contiguous/filled checkboxes, soft-flood sliders) shows/hides correctly per selected tool, and confirm zero new console errors (the floatsession `isTypingTarget` error from Task 1 should now be gone — verify that too). Do not simulate drag gestures.
- [ ] `git add` and commit:
  ```bash
  git commit -m "refactor: split js/ui/tools.js into components/tool-palette.js + components/canvas/drawing-engine.js"
  ```

---

## Task 3: Split `js/ui/panels.js` into `components/panels/color-panel.js` + `components/panels/layers-panel.js` + `components/color-utils.js`

**Files:**
- Create: `js/components/color-utils.js`
- Create: `js/components/panels/color-panel.js`
- Create: `js/components/panels/layers-panel.js`
- Delete: `js/ui/panels.js`
- Modify: 3 importers (listed in Step 4)

**Interfaces:**
- Consumes: `js/components/dialogs.js`'s `markDefaultAction` (from Task 1).
- Produces: `color-utils.js` exports `rgbaToHex`, `hexToRgb` (pure, no imports). `color-panel.js` exports `mountColorPanel`. `layers-panel.js` exports `mountLayersPanel`.

### Step 1: Create `js/components/color-utils.js`

- [ ] Create with this exact content (moved verbatim from `js/ui/panels.js` lines 14–20):
  ```js
  export function rgbaToHex([r, g, b]) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  export function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  ```

### Step 2: Create `js/components/panels/color-panel.js`

- [ ] Create the file with this exact import block:
  ```js
  import { state, on, emit, activeSheet, markDirty, confirmOrAuto } from '../../app/state.js';
  import { cloneBitmap, blitRegion } from '../../core/pixels.js';
  import { sheetLayers } from '../../core/model.js';
  import { createPalette, addSwatch, setEntry, remapColor, INDEXED_SIZE_PRESETS } from '../../core/palettes.js';
  import { SYSTEM_PALETTES, clonePalette } from '../../core/systempalettes.js';
  import { markDefaultAction } from '../dialogs.js';
  import { rgbaToHex, hexToRgb } from '../color-utils.js';
  ```
  Note this is a subset of the original file's combined import list: `activeLayer`, `activeMap`, `commitDeleteAnimation`, most of `core/model.js`'s names, `compositeFloatOnLayer`, `defineAction`/`bindAction`, `getEditorHost` are NOT used anywhere in the color-panel section (verified against the original file's lines 89–382) and belong in `layers-panel.js` instead (Step 3). `sheetLayers` is used by both `allSheetLayers()` and `editIndexedEntry()` inside the color-panel section, so it's imported here independently of layers-panel.js's own copy.
- [ ] Copy from `js/ui/panels.js` **verbatim**:
  - Lines 21–23 (`cssColor` helper) — color-panel-only.
  - Lines 24–31 (`hiddenColorInput` helper) — color-panel-only.
  - Lines 32–37 (`resetBody` helper) — duplicated here (it's also used by `layers-panel.js`; at 4 lines, duplicating this trivial DOM helper is simpler and lower-risk for a pure relocation than inventing a new shared module neither the design doc nor the original codebase calls for).
  - Lines 89–382 (`export function mountColorPanel(el) { ... }`) — verbatim body. Every internal call to `rgbaToHex(...)`/`hexToRgb(...)` now resolves through the imported bindings from `../color-utils.js`.

### Step 3: Create `js/components/panels/layers-panel.js`

- [ ] Create the file with this exact import block:
  ```js
  import { state, on, emit, activeSheet, activeLayer, activeMap, markDirty, confirmOrAuto } from '../../app/state.js';
  import { commitDeleteAnimation } from '../../features/animations/commands.js';
  import { cloneBitmap, blitRegion } from '../../core/pixels.js';
  import { addLayer, addGroup, removeLayer, removeGroup, moveLayer, mergeDown, findNode, findParent, sheetLayers, flattenLayers, findGroup, findLayer, createLayerNode, createGroupNode, createMapLayer, refreshMapBounds, moveNode, animationGroup, layerAnimationContext } from '../../core/model.js';
  import { compositeFloatOnLayer } from '../../core/floating.js';
  import { defineAction, bindAction } from '../../app/actions.js';
  import { getEditorHost } from '../../host/runtime.js';
  ```
  This is the original file's full `core/model.js` import list, carried over verbatim rather than individually re-verified name-by-name — a handful of these names (e.g. `addLayer`, `addGroup`) may not be directly called in the layers-panel section (the file builds nodes via `createLayerNode`/`createGroupNode` and mutates `.children` arrays directly), but preserving the exact original import list keeps this a pure, zero-risk relocation; trimming genuinely-unused imports is a separate cleanup, out of scope here.
- [ ] Copy from `js/ui/panels.js` **verbatim**:
  - Lines 32–37 (`resetBody` helper) — duplicated from color-panel.js, see Step 2's note.
  - Lines 39–85 (the "shared thumb drawing" section: `LAYER_THUMB_SIZE`, `scratchCanvas`/`scratchCtx`, `getScratchCanvas`, `drawFit`) — these are layers-panel-only despite sitting textually above the "color panel"/"layers panel" comment split in the original file.
  - Lines 384–1151 (from the `// ------ layers panel` comment through EOF: `sheetDocument` helper, `export function mountLayersPanel(el) { ... }`) — verbatim body, unchanged.

### Step 4: Delete the old file and update its 3 importers

- [ ] `rm js/ui/panels.js` (or `git rm`).

- [ ] `js/features/workbench/editor-workbench.js` line 9 — was one import line for both names; split into two:
  ```js
  import { mountColorPanel } from '../../components/panels/color-panel.js';
  import { mountLayersPanel } from '../../components/panels/layers-panel.js';
  ```

- [ ] `js/features/transforms/filter-controller.js` line 8: `'../../ui/panels.js'` (uses `rgbaToHex`, `hexToRgb`) → `'../../components/color-utils.js'`

- [ ] `tests/panels.test.mjs` line 3: `'../js/ui/panels.js'` (uses `rgbaToHex`, `hexToRgb`) → `'../js/components/color-utils.js'`

### Step 5: Verify and commit

- [ ] Run `npm test`. Expect all tests green, in particular `tests/panels.test.mjs`.
- [ ] Confirm `js/ui/` is now empty.
- [ ] `git add` and commit:
  ```bash
  git commit -m "refactor: split js/ui/panels.js into components/panels/color-panel.js + layers-panel.js + components/color-utils.js"
  ```

---

## Task 4: Retire `js/ui/`, ban future imports of it, close out the group

**Files:**
- Delete: `js/ui/` (should already be empty after Tasks 1–3; this step just removes the now-empty directory)
- Modify: `tests/architecture.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: an architecture-test guarantee that no file under `js/` imports from a `ui/` path segment again.

### Step 1: Confirm and remove the empty directory

- [ ] Confirm `js/ui/` contains no files (Tasks 1–3 should have moved/deleted all 10). If anything unexpected remains, stop and investigate before deleting — do not delete files this plan didn't account for.
- [ ] Remove the now-empty `js/ui/` directory.

### Step 2: Add the architecture-test ban

- [ ] Add this test to `tests/architecture.test.mjs`, placed after the existing `'shared preview delegates rendering to mode providers'` test (around line 59), matching the file's existing style of scanning a directory tree with `jsFiles()` and asserting a regex:
  ```js
  test('nothing imports the retired js/ui directory', async () => {
    for (const file of await jsFiles(join(root, 'js'))) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /from\s+['"][^'"]*[\\/]ui[\\/]/, file);
    }
  });
  ```

### Step 3: Verify, do the final manual check, and commit

- [ ] Run `npm test`. Expect all tests green (this now includes the new architecture-test assertion).
- [ ] Report to the user: Group 2 (the highest-risk group in Phase 4, per the design doc) is code-complete and automated-test-clean. Because this codebase's established policy is that Playwright never simulates pointer drags, ask the user to manually verify drawing/painting (pencil, eraser, line, rect, ellipse, fill, soft-flood, select-marquee resize/move, and the move tool's floating-selection drag/scale/rotate) in at least one mode before this group is considered fully done — this is the one behavior class no automated check in this task can confirm.
- [ ] `git add` and commit:
  ```bash
  git commit -m "chore: retire js/ui, ban future imports of it in architecture tests"
  ```

---

## Self-Review Notes

- **Spec coverage:** every row of the design doc's "`js/ui/` → `js/components/`" table (10 source files, including both splits and the `rgbaToHex`/`hexToRgb` extraction) has a corresponding task/step above. The `isTypingTarget` "bonus fix" is Task 1 Step 2. The architecture-test ban is Task 4, matching the design doc's Testing section ("ban new imports of them the same way `tests/architecture.test.mjs` already bans other legacy paths").
- **Ordering correctness:** Task 1 must land before Tasks 2–3 because `tools.js`/`panels.js` import 3 of the 8 leaf files being moved; Task 1 updates those two files' import paths in place (Step 4) without moving them, so the codebase stays test-green after every task, not just after the whole group.
- **Placeholder scan:** no task defers "handle appropriately" or "similar to Task N" — every import path change is given as an exact old→new string, and every new file's full import block and verbatim source-line range is specified.
- **Type/interface consistency:** `BRUSH_TOOLS`/`SHAPE_TOOLS`/`toolOptions` are the only cross-file shared mutable state introduced by this group's splits (in Task 2); their sharing mechanism (plain ES module import of an object/Set binding, properties mutated but the binding itself never reassigned) is explicitly called out rather than left implicit, since Group 1's Foundation work surfaced how easy it is to get shared-state semantics wrong in this codebase.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-17-phase-4-group-2-components-relocation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
