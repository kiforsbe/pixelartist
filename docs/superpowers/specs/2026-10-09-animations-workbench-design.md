# Animations workbench — design

Date: 2026-10-09
Status: approved in conversation; awaiting written-spec review.

## Goal

Today animation work is sheet-first: you start from a packed sprite sheet,
mark frame rects on it, assemble animations out of those rects, and adjust.
Strips, segments, `breaks`, floating/accepted animations and per-animation
layer groups all exist to manage *placement*, because placement and animation
are the same thing in that model.

Add a second, animation-first workbench next to the Sprite Sheets one. In it
you author a character as a timeline on a fixed-size canvas, and the packed
sheet is laid out for you. Both workbenches edit the **same stored data**, so
every edit in one is immediately visible in the other.

Aseprite is the reference for the interaction model (a layers × frames
timeline, cels, tags over frame ranges). Its UI, file format and terminology
are not copied.

## Decisions

| # | Decision |
|---|---|
| D1 | Two-way linked, implemented as **one stored model, two views**. The sprite sheet (layers + frame rects + animations) stays the stored data; the Animations workbench is a new view over it. No sync layer. |
| D2 | Auto layout: **one band of rows per animation, sheet order always mirrors timeline order.** Inserting, deleting or reordering frames moves pixels on the sheet. |
| D3 | Animations are **auto** or **manual** layout. Auto frames are pinned in the Sprite Sheets workbench; "Make manual" releases them. Strips, segments, breaks and the floating/accept step are retired. |
| D4 | Implementation: a new `animations` **mode** sharing the `sprite-sheet` document kind (third mode tab), not a view inside sprites mode. |
| D5 | **One timeline per sheet.** All animations share the sheet's single layer tree; animations are **tags** over the timeline's columns. The timeline also *is* the layer panel (layers and folders as rows). |
| D6 | Pixels that v3 strips hid are **moved** into a hidden layer on conversion, never deleted and never revealed. |

## 1. Data model

### Animation

`strip` and `breaks` are removed. New fields:

```js
anim.layout = 'auto' | 'manual'
anim.cell   = { w, h } | null   // auto only: the canvas size all its frames share
```

Kept unchanged: `id, name, loop, frames: [{frameId, duration, step}],
baseDuration, baseFps, baseStep`. `layerGroupId` is removed (see below).

### Frames

Unchanged shape: `{ id, name, x, y, w, h, pivotX, pivotY }`. Every exporter,
the maps mode and Frames JSON keep reading them as today.

For a frame belonging to an **auto** animation:

- `x, y` are written only by the layout engine (§2).
- `w, h` equal the animation's `cell`.
- `pivotX, pivotY` are identical across the animation's frames; commands set
  them together.
- A frame belongs to at most one auto animation.

An animation's timeline may list the same frame more than once (a held or
reused frame, shown as **linked** in the timeline). The frame exists once on
the sheet.

### Layers

- Animations no longer own layer groups. Every frame on a sheet is drawn from
  the sheet's whole layer tree.
- Removed: `group.animationId`, `animationGroup`, `contextLayers`,
  `layerAnimationContext`, and the accepted-strip exclusive pass in
  `flattenSheet`. Every caller of `contextLayers` reads `sheetLayers(sheet)`.
- Layer nodes gain `locked: false`. Paint tools, fills, floats and the layout
  engine never write to a locked layer.

### Project settings

New numeric setting `sheetMaxWidth` (default: `spriteSheetW`, range
1..`MAX_DIM`). Settings validation expects 10 keys for v4; v2/v3 loads fill
the default.

### File format: version 4

`PROJECT_VERSION` becomes 4. The loader accepts 2, 3 and 4 and converts older
files in memory:

| v3 animation | v4 result |
|---|---|
| accepted strip, no `breaks`, all frames equal size, frames contiguous in one row, ordered left→right as the timeline | `layout: 'auto'`, `cell` from the frames |
| any other strip (has breaks, floating, mixed sizes, gaps, wrong order) | `layout: 'manual'` |
| non-strip animation | `layout: 'manual'` |

Layer conversion for each sheet:

1. Every group with an `animationId` becomes a plain folder (`animationId`
   dropped). Nothing is deleted.
2. For every **accepted strip**, pixels in layers *outside* its group that lie
   inside its frame rects were hidden in v3 (the strip composited
   exclusively). They are moved — copied, then cleared from their source layer
   — into one layer per sheet named **"Covered by strips (converted)"**,
   created hidden at the bottom of the root. The layer is created only when
   at least one such pixel exists. The converted sheet renders identically.

Conversion never runs the layout engine: a converted auto animation stays
exactly where it was until a layout-changing command runs.

## 2. Layout engine

### `planLayout` — `js/domain/sprites/auto-layout.js`

Pure; no DOM, no store.

```js
planLayout(sheet, { maxWidth, maxHeight }) -> {
  ok: true,
  rects: Map<frameId, { x, y }>,   // target origin of every auto frame
  size:  { w, h },                 // sheet size required (>= current; never smaller)
  moves: [{ frameId, from: { x, y }, to: { x, y } }],  // only frames that change
} | { ok: false, reason }
```

- **Deterministic**, recomputed from scratch every call. No layout state is
  stored beyond the frames' own `x, y`.
- **Distinct frames** of an animation, in order of first appearance in its
  timeline, are the cells it needs.
- **Band shape**: `cols = max(1, floor(maxWidth / cell.w))`,
  `rows = ceil(distinct / cols)`, band = `cols·cell.w × rows·cell.h` (the last
  row may be short; the band reserves the full rectangle).
- **Placement**: auto animations in `sheet.animations` order. Each band is
  placed at `x = 0` and the smallest `y ≥ 0` where its rectangle overlaps no
  obstacle and no band already placed.
- **Obstacles**: every manual frame's rect, plus the bounding boxes of
  connected non-empty pixel regions (across all layers) that lie outside every
  frame rect. A band therefore never lands on pixels that belong to no frame.
- **Size**: the bounding box of everything placed, maxed with the current
  sheet size. The sheet never shrinks automatically.
- **Refusal**: if a band cannot be placed within `maxWidth × maxHeight`
  (`MAX_DIM`), return `{ ok: false, reason }`. The calling command changes
  nothing and shows the reason ("Not enough room on the sheet: raise the
  maximum sheet width or trim the sheet").

### `applyLayout` — core

`applyLayout(sheet, plan)`:

1. Grow the sheet to `plan.size` if larger (all layers resized, content kept
   at its coordinates).
2. For every move: copy each frame rect out of **every** layer first, then
   clear all source rects, then blit every copy to its destination. Doing all
   copies before any write makes swaps and overlapping shifts safe.
3. Write the frames' new `x, y`.

Returns the undo data: the sheet size before, and per layer the before/after
pixel patches of every rect touched (sources and destinations only — never
whole-layer snapshots).

If any moving rect has non-empty pixels in a **locked** layer, the command
refuses before applying, naming the layer.

### Layout-changing commands

All live in the sprites application layer, are registered for the
`animations` mode, and end with plan → apply as one undo step together with
their structural change.

| Command | Structural change |
|---|---|
| `animations.new(sheet, {name, w, h})` | auto animation with one blank frame |
| `animations.addFrame(anim, at, {copyOf?})` | blank frame, or a pixel copy of `copyOf`, inserted at timeline index `at` |
| `animations.linkFrame(anim, at, frameId)` | inserts another use of an existing frame of the same animation; no pixels |
| `animations.deleteFrame(anim, index)` | removes the entry; the frame is removed only when no other entry, animation or map references it |
| `animations.moveFrame(anim, from, to)` | reorders timeline entries |
| `animations.resizeCanvas(anim, w, h, anchor)` | new `cell`; each frame's content cropped/padded around the anchor (9-point) |
| `animations.autoLayout(anim)` | manual → auto. If frame sizes differ, asks for a canvas size and pads/crops around each frame's pivot |
| `animations.makeManual(anim)` | auto → manual. No pixel or rect changes |
| `animations.reorderAnimations(from, to)` | reorders `sheet.animations` (band order) |
| `animations.duplicate(anim)` | auto copy with copied pixels, placed after the source |
| `animations.delete(anim)` | removes the animation and its frames not referenced elsewhere |

Unchanged and shared by both modes: rename, loop, base duration, per-entry
duration/step, and every layer command.

## 3. The Animations workbench

### Mode

`js/modes/animations/` — `id: 'animations'`, label **Animations**, order 15,
`documentKinds: ['sprite-sheet']`, default view `animations.canvas`. It does
not register a document provider (sprites mode owns `sprite-sheet`). Active
sheet, animation, frame and layer selection are already stored per document,
so switching between the two workbenches keeps them.

### Canvas view (`animations.canvas`)

- One canvas the size of the selected column's animation `cell` (manual
  animations: the frame's own size), showing that frame composited from all
  visible layers, over the checkerboard, with onion skin (existing controls,
  settings and step colours).
- Every paint tool and brush works; writes go to the active layer, clipped to
  the frame rect on the sheet. Selection, cut/paste and float transforms work
  as in the Frame Editor.
- The pivot is shown as a crosshair and can be dragged (sets the animation's
  shared pivot).
- Moving to a column of another animation switches the canvas size.

The Frame Editor's canvas, onion-skin, clipping and float handling are
extracted into `js/components/canvas/frame-canvas.js`
(`{ frameRect, layers, onionSource }`); the Frame Editor and this view both
use it.

### Timeline (bottom dock)

The timeline is the sheet's layer panel and its frame sequence in one grid.

- **Header**: playback controls (first, previous, play/stop, next, last,
  loop) at the left. Above the columns: frame numbers, and above those the
  **tags** — one per animation, spanning its columns, labelled with its name.
  Clicking a tag selects that animation.
- **Columns**: every animation's timeline entries, animation after animation
  in `sheet.animations` order. Tags therefore never overlap (one lane). Frames
  that belong to no animation do not appear (they remain in the Sprite Sheets
  workbench).
- **Rows**: the sheet's layer tree. Each row: visibility, lock, folder
  expand/collapse, name (double-click to rename). Drag to reorder or into a
  folder; add layer, add folder, delete, opacity — all existing layer
  commands.
- **Cells**: filled dot = that layer has pixels in that frame; hollow dot =
  empty; a link mark on columns that repeat an earlier frame. Clicking a cell
  selects that frame and that layer.
- **Expanded mode**: a size control widens the columns. Past a threshold the
  cells show per-layer thumbnails of their pixels, and a composite thumbnail
  row appears above the layer rows.
- **Editing gestures** (within the tag the column belongs to): `+` between
  columns inserts a blank frame, Alt+`+` duplicates the frame to its left;
  drag a column header to reorder, Ctrl+drag to insert a linked use; Delete
  removes the selected column; duration and step per column edit as today.
  On a manual animation the first insert/reorder offers "Auto-layout this
  animation".

Visual style is the app's own (existing panel tokens, controls and icons), not
Aseprite's.

### Right panels

- **Animations**: the sheet's animations with thumbnails and their layout
  mode; New (name + canvas size, defaulting to the project frame size),
  Duplicate, Delete, drag to reorder; per-animation name, loop and base
  duration; Auto-layout / Make manual; Canvas size… (anchor grid).
- **Preview**: the existing preview panel, playing the selected animation.

The separate Layers panel is not shown in this workbench.

### Shared presentation

The timeline and animations panels take the mode ids and editor view id they
serve as options instead of hard-coding `'sprites'`, `'sprites.frame'` and
`'sprites.sheet'`. Layout-aware actions dispatch `animations.*` command ids,
which are only registered for the animations mode.

### Cross-workbench actions

- Sprite Sheets: **Edit in Animations** on a selected animation.
- Animations: **Show on sheet** switches modes and selects the frame.

## 4. Sprite Sheets workbench changes

- An auto animation's frames are **pinned**: paint, rename and pivot edits
  work; move and resize are refused with the hint "Auto-laid-out — edit in
  Animations, or Make manual".
- Removed: strip chrome (`+`/`✂` callouts, grips), segment merge/split,
  New strip…, Break apart, Accept animation and auto-accept on first paint,
  and their commands (`strip-commands.js`, `breakApartStrip`,
  `acceptAnimation`, `moveStripTo`, `setStripFrameSize`, `setStripPivot`).
- The Layers panel no longer filters by animation.
- Creating frames, slicing, and assembling a manual animation from existing
  frames are unchanged.

## 5. Edge cases

- **No room**: layout refusals change nothing and explain why (§2).
- **Locked layers**: never painted; layout refuses to move pixels out of them.
- **Shared frames**: deleting an entry only removes that use; the frame is
  deleted only when nothing references it (other entries, other animations,
  map placements, which reference frames by id as `assetId`).
- **Maps**: deleting an animation does not check map placements, exactly as
  `deleteAnimation` does today; maps already tolerate a missing asset. Frames
  a map places directly are kept (rule above).
- **Undo/redo**: every command, including its layout move, is one history
  step. Playback stops before a structural change, as today.
- **Malformed v3 strips** convert to manual; never a load error.
- **Typing targets**: timeline keyboard shortcuts (Delete, arrows) respect
  the existing focus gating.

## 6. Testing

- `planLayout`: placement, wrapping at `maxWidth`, manual-frame and stray-pixel
  obstacles, determinism, never shrinking, refusal.
- `applyLayout`: swap, overlapping shifts, growth, locked-layer refusal,
  byte-exact undo.
- Every `animations.*` command: effect plus undo/redo.
- Conversion: v3→v4 for each strip rule, the covered-pixels layer (only when
  needed; identical render before/after), v4 save→load round trip,
  `sheetMaxWidth` default.
- Timeline logic as pure functions: column list and tag spans, cel state
  (filled/hollow/linked).
- Sprite Sheets: pinned frames refuse move/resize; removed commands are gone
  from the registry.
- Browser check (no drag simulation): the workbench opens, the timeline
  renders, a click-paint plus undo works. Drags are verified manually by the
  owner.

## 7. Build order

Three plans, each leaving the app working:

1. **Model and engine** — v4 format and conversion, `locked`, retire strips
   and animation-owned groups, `planLayout` / `applyLayout`, the
   `animations.*` commands, Sprite Sheets pinning and strip-UI removal.
2. **Workbench shell** — the `animations` mode, `frame-canvas.js` extracted
   from the Frame Editor, the canvas view, Animations panel, Preview, and a
   minimal timeline (one row of frame columns with tags).
3. **Full timeline** — layer rows and folders, cel dots, gestures, expanded
   thumbnail mode.

## Out of scope

- Sharing one layer's pixels between frames at a finer grain than whole
  frames (per-layer linked cels).
- Overlapping tags / frames shared between animations in auto layout.
- Automatic sheet trimming.
- Packing strategies other than one band per animation.

## Implementation notes (Phase 1)

Decided while planning Phase 1 (see `docs/superpowers/plans/2026-10-09-animations-model-engine.md`):

1. **Band width** uses only the columns a band needs: `min(cols, distinct)·cell.w`. Reserving `cols·cell.w` would widen a narrow sheet to `sheetMaxWidth` for a one-frame animation.
2. **Stray-pixel obstacles** are computed exactly, per row, instead of as connected-component bounding boxes. `rowMinX[y]` is the smallest x of a non-empty pixel in row `y` that lies in no frame rect. A band `[0,W)×[y,y+H)` is blocked if `min(rowMinX[y..y+H)) < W`.
3. **Covered pixels** go into a hidden *folder* named `Covered by strips (converted)`, with one hidden layer per source layer. A single layer would lose pixels where two source layers overlap, which D6 forbids.
4. **Command registration:** the `animations.*` ids are registered for both the `sprites` and `animations` modes. The Sprite Sheets workbench needs Make manual, the shared pivot, and deleting an auto frame. The `animations` mode itself arrives in Phase 2; its id is already in the `when` predicate.
5. **`animations.delete` on a manual animation** behaves as `sprites.deleteAnimation` does today: it keeps the frames. Only auto animations delete their unreferenced frames and pixels.
6. **`animations.duplicate`** requires an auto source. A manual source is refused with "Auto-layout this animation first".
7. **`animations.autoLayout`** needs an explicit canvas size when frames differ in size **or pivot**, because equal pivots are an auto invariant. v3 conversion likewise requires equal pivots for `auto`.

## Implementation notes (Phase 2)

Decided while building Phase 2 (see `docs/superpowers/plans/2026-10-09-animations-workbench-shell.md`):

1. **Own presenters, shared helpers.** The Animations panel and timeline are new presenters in `js/modes/animations/presentation/` rather than the sprites ones taking mode/view ids as options (§3 "Shared presentation"). The two workbenches differ in nearly every control, so sharing happens one level down instead: `components/canvas/frame-canvas.js`, `components/canvas/onion-controls.js`, `components/canvas/draw-fit.js`, `components/layout-dispatch.js`, `components/panels/base-duration-control.js`, and `domain/sprites/{onion-skin,playback}.js`.
2. **`frame-canvas.js` signature** is `createFrameCanvas(hostEl, { viewKind, getFrame, getOnionAnimation, onStateChange })` → `{ view, sync, shown, hidden, isVisible }`, not `{ frameRect, layers, onionSource }`. Both callers edit the active sheet's layers, so the canvas resolves the layers itself; the callers only say which frame and which animation's neighbours to ghost.
3. **Pivot editing** is a **Pivot** toggle in the canvas strip. While it is on, an overlay takes the pointer, so a pivot drag never reaches the paint tools. The crosshair is always drawn. A drag is one history step: `animations.setPivot` for an auto animation (shared pivot), or the new `sprites.setFramePivot` for a frame of a manual animation. Pivots snap to half pixels and clamp to the frame.
4. **Selection** gains `entryIndex`, so an animation that uses a frame twice can tell its columns apart. Anything that only patches `frameId` (undo/redo, layout commands) falls back to that frame's first use in the animation.
5. **Minimal timeline editing** is done with header buttons for now: **+ Frame**, **Duplicate** and **✕** act on the selected column, and the add buttons are disabled with the hint "Auto-layout this animation first" on a manual animation. The column gestures in §3 arrive with Phase 3. Removing a column selects its neighbour. The timeline mounts in its own `#anim-timeline-dock`, sharing the Sprite Sheets dock's CSS.
6. **The Layers panel stays visible** in Phase 2, because the timeline has no layer rows yet. In Animations mode its commands map to `sprites.*`, and the lock toggle shows. Phase 3 hides it.
7. **Duplicate** in the Animations panel is disabled for manual animations (Phase 1 note 6).
8. **Edit in Animations** keeps the selected frame when the animation uses it, and otherwise selects the animation's first entry.
9. **View kind:** `animations.canvas` resolves to the float/drawing kind `canvas`, the same as `maps.canvas`. Maps never binds a drawing engine, so the two cannot collide; a test pins that `createFloat` stays refused in Maps.

## Implementation notes (Phase 3)

Decided while building Phase 3 (see `docs/superpowers/plans/2026-10-10-animations-full-timeline.md`):

1. **One layer-tree module.** The Layers panel's sheet rows, selection, rename, add/delete/merge and drag-and-drop moved into `components/panels/layer-tree.js`; the panel and the timeline's layer rows both build from it, so the two trees cannot drift. The Layers panel hides itself in Animations (the timeline's rows replace it).
2. **Folder selection.** The shared selection keeps only a selected folder (`selectedGroupId`); a selected layer stays the sheet selection's `layerId` and wins over the folder, so every path that activates a layer (a cel click, undo, the Frame Editor) reads correctly in both trees.
3. **Drops onto cels.** `attachLayerTreeDrop` takes `{ emptyDropsToRoot }`; the timeline passes `false`, so a row dropped between cels is not moved to the root.
4. **Compact and expanded.** The column-width slider (16–64 px, remembered per browser) shows dots below 40 px, and per-cel thumbnails plus a composite row of whole frames from 40 px up. The playhead marks the frame number (the only column marker when compact) and, expanded, the composite cell.
5. **Gestures need the auto layout, except reorder.** A gap insert or a Ctrl+drop link on a manual animation first offers an auto-layout; frames of different sizes or pivots then need a second yes that names the suggested (largest) size and warns that re-framing around the pivots can crop pixels. Declining either does nothing. A plain reorder that declines the offer still reorders by hand (`sprites.reorderAnimationFrame`). Drops never cross animations.
6. **Keys.** Delete/Left/Right act only on the focused timeline grid and never on a typing target. The drawing engine's window Delete handler skips events already handled (`defaultPrevented`), so a column delete does not also clear a canvas selection.
7. **Pixel edits repaint in place.** A stroke bumps `pixelRevision` on every pointer move; the timeline repaints only the selected frame's cels, composite cells and the preview rather than rebuilding the grid. Structural changes (history, model, selection) still render in full, and a layer-name click defers that render for the double-click grace window so rename still works.
8. **Per-column duration.** The duration control moved into `components/panels/frame-duration-input.js`, which the Sprite Sheets timeline cells and the Animations timeline header (selected column) both use: held frames for an fps-based animation, otherwise ms.
