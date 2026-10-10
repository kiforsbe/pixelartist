# Resizable docks, standard drag-and-drop, Aseprite-style timeline — design

Date: 2026-10-10
Status: decided by Claude on the owner's instruction ("implement your design,
plan and everything without asking me"). Builds on
`2026-10-09-animations-workbench-design.md` (its decisions D1–D6 stand).

## Goal

Three complaints from the owner:

1. The bottom dock holding the Animations timeline cannot be made tall enough
   to show the whole timeline.
2. Drag-and-drop for layers (and every other reorderable list) is unreliable
   and inconsistent.
3. Timeline and animation editing should work more like Aseprite's.

## Findings

- **Dock.** `#anim-timeline-dock` is `height: 140px` with no handle. The
  Sprites timeline has an inline, Sprites-only handle (clamped 100–400 px,
  raw `localStorage`, no keyboard, never re-clamped). `.timeline-main` lacks
  `min-height: 0`, so the grid inside cannot scroll vertically and lower
  layer rows are clipped.
- **Drag-and-drop.** Five call sites, four separate HTML5-DnD
  implementations, two indicator vocabularies, duplicated slot→index maths.
  The layer tree's before/after is **inverted** (rows show the last child on
  top, the drop maths assumes the first), a drop on the dragged row's own
  position throws the node to the top of the root, the 2 px row gap counts as
  empty space, outside text/file drags are accepted, and the animations list
  shows no indicator at all. Map layers cannot be dragged.
- **Aseprite** (research summary): layers × frames grid; tags with colour,
  direction (forward/reverse/ping-pong/ping-pong-reverse); range selection of
  frames with Shift-click; drag a range to move, Ctrl/Alt-drag to copy;
  context menus on frames, cels, layers, tags; double-click a frame for its
  duration, a tag for its properties; keyboard: Enter play, `,`/`.` previous/
  next frame in the tag, Alt+N new frame, Alt+B new empty frame, Alt+M linked
  frame, Alt+C delete frame, Alt+I reverse; Ctrl+wheel zooms the timeline;
  Alt-click an eye solos a layer, dragging over eyes paints visibility.

## Decisions

| # | Decision |
|---|---|
| E1 | One reusable **dock resizer** component for every bottom dock; size persisted per panel id through `host.preferences`. |
| E2 | One reusable **pointer-event drag-reorder** module replaces every HTML5-DnD reorder. Hit-testing and index maths are pure functions. |
| E3 | Our **animation = Aseprite tag** (one lane, never overlapping — D5 stands). Tags gain **direction** and **colour**. `loop` stays a boolean (no repeat count). |
| E4 | Timeline gains **range selection** of columns within one animation, range commands, **context menus**, **keyboard shortcuts**, durations shown in the grid. |
| E5 | Drag modifiers: plain = move, **Ctrl = linked use** (unchanged from Phase 3), **Alt = copy**. Ctrl is kept for link rather than Aseprite's copy because link already shipped on it. |
| E6 | Context-menu items are **actions** (`defineAction`), never ad-hoc closures. Right-click first selects what it hits, then the menu acts on the selection — as Aseprite does. |

## 1. Dock resizer — `js/components/dock-resizer.js`

```js
createDockResizer({ target, edge: 'top', min = 100, max: () => number,
  measureContent?: () => number, prefs, prefKey, label, onResize? })
  -> { element, setSize(px), size(), dispose() }
export function clampSize(px, min, max)
export function keyStep(size, key, shiftKey, { min, max }) // -> new size | null
```

- Handle element `.dock-resizer` (5 px, `cursor: ns-resize`), `role=separator`,
  `aria-orientation=horizontal`, `aria-valuenow/min/max`, `tabIndex=0`.
- Pointer drag with capture; live `target.style.height`; saved on release.
- Keys: ArrowUp/Down ±16 (Shift ±64), Home/End = min/max.
- **Double-click or Enter = fit content** (`measureContent()`, clamped); a
  second fit while already fitted restores the previous size.
- `max()` is the workspace height minus 120 px of canvas; re-clamped on
  window resize.
- Persisted with `prefs.set(prefKey, px)`; keys `dock.sprites.timeline.height`
  and `dock.animations.timeline.height`. The old
  `timelineDockHeight` value is read once as the Sprites default.
- CSS: `.timeline-main { min-height: 0 }`; the Animations tag and frame-number
  rows become `position: sticky; top: 0` so they stay visible while the layer
  rows scroll.

Both timelines prepend the handle after each render's `innerHTML = ''`
(or mount it outside the re-rendered element).

## 2. Drag-reorder — `js/components/drag-reorder.js`

```js
attachDragReorder(container, {
  axis: 'y' | 'x',
  itemSelector,                    // rows/columns, each with data-drag-key
  handleSelector = null,           // only start from this part of an item
  ignoreSelector = 'button,input,select,textarea,[data-no-drag]',
  threshold = 4,
  tree = null,                     // { depth(el), isGroup(el), isOpen(el) }
  canDrop = () => true,            // (sourceKey, target) -> boolean
  modifiers = e => ({}),           // e.g. { link: e.ctrlKey, copy: e.altKey }
  onDrop,                          // ({ sourceKey, targetKey, place, modifiers }) -> void
  scroller = nearest scrolling ancestor,
}) -> dispose()

// pure
export function computePlacement(rects, point, axis, tree)  // -> { index, place: 'before'|'after'|'into' }
export function slotToFinalIndex(from, slot)
export function isNoOpDrop(sourceIndex, placement)
```

- Pointer events with capture; a drag starts only past `threshold`, so
  clicks, double-click-to-rename and selection still work. The click after a
  drag is suppressed.
- One indicator element `.dr-line` (horizontal or vertical, indented to the
  target depth for trees) plus `.dr-into` on a group row; `.dr-invalid` and a
  not-allowed cursor when `canDrop` is false; `.dr-lifted` on the source.
- Hit-testing uses item rects captured at drag start (re-measured after
  scrolling); the gaps between items snap to the nearest item, so the
  indicator never flickers.
- Tree rows: top third = before, bottom third = after, middle = into (groups
  only; leaves split at half).
- Auto-scrolls the scroller when the pointer is within 24 px of its edge.
- Escape, `pointercancel`, lost capture, or the source leaving the DOM
  cancel the drag. Dropping where the item already is does nothing.
- Modifier changes during the drag update the indicator (`.dr-copy`,
  `.dr-link`).

**Layer tree** maps a visual placement to `{ destParentId, destIndex }` in
one helper that accounts for the reversed display order (fixes the
inversion). A drop on itself is a no-op. A group cannot be dropped into its
own descendant (`.dr-invalid`).

Call sites: layer tree (Layers panel and timeline rows), map layers (new,
via `maps.moveLayer` delta), animations list, Sprites timeline strip,
Animations timeline frame numbers.

## 3. Animation model additions

```js
anim.direction = 'forward' | 'reverse' | 'pingpong' | 'pingpong-reverse'  // default 'forward'
anim.color     = '#rrggbb' | null                                       // default null
```

- Loader fills defaults; saver writes both. No version bump (optional
  fields with defaults, v4 files without them load unchanged).
- `domain/sprites/playback.js`: `playbackSequence(count, direction)` returns
  the entry-index order of one cycle (ping-pong does not repeat the end
  frames); playback, the Preview panel and animated exports (GIF/APNG, any
  exporter that plays an animation as a sequence) use it. Onion skin keeps
  timeline order.
- Commands (both layouts, one history step each, `sprites.*` registered for
  both modes): `sprites.setAnimationDirection`, `sprites.setAnimationColor`.

## 4. Range commands

Registered with the other `animations.*` ids. Each is one history step and
handles **both** layouts: on a manual animation they edit only the entry list
(no pixels move); on an auto animation they run the layout engine as the
single-frame commands do. Commands that create frames (`duplicateFrames`,
`copyFrames`, `unlinkFrame`) refuse manual animations with the existing
"Auto-layout this animation first" message (the timeline offers the
auto-layout first, as for inserts).

| Command | Args | Effect |
|---|---|---|
| `animations.moveFrames` | `from, to, at` | Moves entries `[from..to]` to slot `at` (pre-removal slot). |
| `animations.copyFrames` | `from, to, at` | Inserts independent copies of `[from..to]` at slot `at`. |
| `animations.duplicateFrames` | `from, to` | `copyFrames` at `to + 1`. |
| `animations.deleteFrames` | `from, to` | Removes entries; frames deleted only when unreferenced (existing rule). |
| `animations.reverseFrames` | `from, to` | Reverses entry order in the range. |
| `animations.setFrameDurations` | `from, to, duration` | Same duration for every entry (step rules as the single-entry command). |
| `animations.unlinkFrame` | `index` | Gives the entry a new frame with a copy of the pixels (inverse of a linked use). |
| `animations.clearCel` | `frameId, layerId` | Clears one layer's pixels inside one frame rect; refuses locked layers. |

## 5. Timeline (Animations workbench)

- **Selection**: click a frame number or cel selects that column (and the
  cel's layer); **Shift-click** extends a range within the same animation
  (anchor = previous click). The range is drawn highlighted on numbers and
  cells. Presenter-local state; cleared on animation change.
- **Frame numbers** show the duration under the number (`100ms` or `×2`
  held frames). **Double-click** a number focuses the duration input; with a
  range selected the input sets the whole range (`setFrameDurations`).
- **Drag** frame numbers with the drag-reorder module: dragging a column
  inside the selected range moves the whole range; Alt = copy, Ctrl = linked
  use (single column). Drops stay inside the animation.
- **Tags**: drawn in the animation's colour (default accent), with a
  direction glyph (→ ← ⇄ ⇆). Click selects the animation; **double-click
  renames inline**.
- **Context menus** (component `js/components/context-menu.js`, items are
  action ids):
  - Frame: Duration…, Insert blank frame, Duplicate, Insert linked frame,
    Unlink, Reverse, Delete.
  - Cel: Clear cel, Unlink, plus the frame items.
  - Tag: Rename, Direction ▸ (four), Colour…, Loop, Duplicate, Auto-layout /
    Make manual, Delete.
  - Layer row (Layers panel and timeline): Rename, Add layer, Add folder,
    Duplicate?, Merge down, Delete — whichever layer actions exist.
- **Shortcuts** (Animations mode only, never on a typing target, never with
  a dialog open):

  | Keys | Action |
  |---|---|
  | Enter | Play / stop (not when focus is on a button) |
  | `,` / `.` | Previous / next frame within the animation (wraps) |
  | Alt+N | Duplicate selected frames after the range |
  | Alt+B | Insert blank frame after the selection |
  | Alt+M | Insert a linked use after the selection |
  | Alt+C / Delete (grid) | Delete selected frames |
  | Alt+I | Reverse selected frames |
  | Left / Right / Up / Down (grid) | Column / layer navigation (unchanged); Shift extends the range |

- **Ctrl+wheel** over the grid changes the column width (same setting as
  the slider).
- Hidden-on-load layer rows scroll; the dock resizer (§1) fits the whole
  timeline on double-click.

## 6. Layer rows (shared layer tree)

- Drag via §2 (fixes inversion, self-drop, gap flicker, foreign drags).
- **Alt-click an eye** solos that layer (hides all others; Alt-click again
  restores the previous visibility). **Drag across eyes or locks** paints the
  first toggled state onto every row passed. Each gesture is one history
  step.
- Right-click a row: the layer context menu (§5).

## 7. Animations list panel

- Drag via §2 with an insertion line.
- Per-animation **direction** select and **colour** swatch (the colour also
  borders the row thumbnail).

## Testing

- Pure: `clampSize`, `keyStep`, `computePlacement`, `slotToFinalIndex`,
  `isNoOpDrop`, the tree destination mapping (including the inverted-order
  regression), `playbackSequence`.
- Components on the fake DOM (extended: per-element rects, `closest`,
  `parentElement`, bubbling `fire`, attribute storage, `isConnected`):
  resizer drag/keys/fit/persistence; drag-reorder start threshold, drop,
  Escape cancel, no-op, canDrop.
- Every new command: effect, undo/redo, both layouts where relevant.
- Presenters: range selection, context-menu actions, shortcuts gating.
- Browser check without drag simulation: dock fit by double-click, context
  menu opens and runs, shortcuts work. **Drags are checked by the owner.**

## Out of scope

Overlapping tags, per-layer linked cels, repeat counts, onion-skin range
handles in the header, tag-edge dragging to resize ranges, resizable side
docks.

## Implementation notes

Decided while building (see `docs/superpowers/plans/2026-10-10-timeline-dock-dragdrop.md`):

1. **Dock fit** sums the handle, header and visible rows instead of the
   grid's `scrollHeight`: a `flex: 1` grid never reports less than its own
   height, so a fit could never shrink the dock. The Sprites strip fits to
   its largest thumbnail size. The maximum is the workspace height minus
   120 px; the old fixed 400 px is gone.
2. **Drag payload** is `{ sourceKey, targetKey, sourceIndex, index, place,
   slot, modifiers }`; `placementSlot` turns a placement into the
   pre-removal slot. A tree row's open state comes from the next row's
   depth, so the tree option needs no `isOpen`.
3. **Root bottom.** The drag module only hit-tests items, so the Layers
   panel adds a 16 px end item (`.layer-tree-end`) below the rows; a drop
   there goes to the bottom of the root. The timeline's layer rows end with
   the same item (8 px there): with the Layers panel hidden in Animations,
   it is the only way to the root bottom when the last row is in a folder.
4. **Context-menu submenus** are actions with a `submenu`, as in the menu
   bar; there are no `{ label, submenu }` literal items. Because labels and
   checks do not depend on `args`, the Direction submenu uses one action per
   direction (`animations.timeline.direction.<name>`).
5. **`setFrameDurations`** takes `duration` and/or `step`, since fps-based
   animations edit held steps.
6. **Exports.** GIF and image-sequence exports follow the direction; the
   per-animation sprite sheet and Frames JSON keep timeline order (a packed
   sheet is not a played sequence).
7. **Manual animations.** A plain reorder still offers the auto-layout once
   (declining is remembered); either way it is one `animations.moveFrames`.
   Copy, link, duplicate, unlink and the insert shortcuts use the offer
   flow. The header's + Frame / Duplicate stay disabled on a manual
   animation; the shortcuts and menus offer the auto-layout instead.
8. **Solo and paint** apply to sprite-sheet layers; map-layer visibility
   stays an unrecorded toggle as before. There is no Duplicate layer (no
   command exists); Rename was added.
9. **Agent worktrees** were created from `origin/main`, three commits behind
   local `main`; every branch was moved onto local `main` before merging.
