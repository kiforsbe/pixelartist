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
