# Floating strips — deferred layer commit, exclusive compositing, layers-panel sync

Date: 2026-07-18
Status: approved

## Goal

Let a user drop a new animation strip (or plain animation) onto the sprite
sheet and freely reposition/resize it to align with existing imported artwork
*before* committing to a dedicated layer — so importing existing art into a
strip doesn't require pre-cropping it elsewhere first. Once accepted, a strip
exclusively owns its rectangle on the sheet (nothing underneath bleeds
through, even where the strip itself is transparent), and shrinking it
discards the removed area instead of preserving it for a future regrow.

Also: two small layers-panel/timeline consistency fixes that surfaced while
scoping this (deleting/selecting an animation's group node in the layers
panel didn't sync with the timeline dock).

## Scope

- Floating → accept lifecycle: **both** strip and plain animations.
- Exclusive/opaque compositing over the owned rectangle: **strips only**
  (plain animations' frames can be scattered/shared, so there's no single
  well-defined "owned rectangle" the way a strip's contiguous frames form
  one).
- Content-clearing resize: strips only (plain animations have no edge-grip
  resize).

## Data model

No new field. An animation is **floating** exactly when `layerGroupId ===
null`. `animationGroup(sheet, animId)` already returns `null` in that case,
so most existing call sites treat a floating animation the same as "no
layers" for free.

`addAnimation(sheet, name, strip)` (`core/model.js`) stops creating the group
and seed layer. It becomes:

```js
export function addAnimation(sheet, name, strip = false) {
  const anim = { id: newId('an'), name, loop: true, strip, breaks: [], frames: [], layerGroupId: null };
  sheet.animations.push(anim);
  return anim;
}
```

New function, same file:

```js
export function acceptAnimation(sheet, anim) {
  // Freezes whatever is currently visible under this animation's own frames
  // into a brand-new private layer, then wires the group in. Called once,
  // synchronously, by the accept command below -- never called on an already
  // -accepted animation.
}
```

It creates a group node (as the old `addAnimation` did), creates one layer
sized to the sheet, and for each entry in `anim.frames` copies the
corresponding rectangle out of `flattenSheet(sheet)` into the new layer at
that frame's `(x, y)`. Zero frames (a brand-new plain animation before any
frame is assigned) yields a blank layer — same shape as today's "no root
layers" branch in the old `addAnimation`. Sets `anim.layerGroupId =
group.id`.

Freezing from `flattenSheet(sheet)` (not just root layers) means: whatever
the user currently sees under the strip's frames — including content that
happens to sit under another already-accepted strip's exclusive region — is
what gets copied. The source pixels are **left untouched** wherever they came
from; nothing is cleared out of the layer(s) they were copied from. This
keeps accept trivially reversible by simply deleting the animation, and
avoids destructive surprises to unrelated layers.

## Creation call sites

`commitNewStrip`, `commitNewStripFromFrame` (`frames.js`) and
`commitNewAnimation` (`timeline.js`) all lose their "look up the seeded
layer" step (`animationGroup(...)`/`group.children[0].id`) — there is nothing
to look up yet. They keep pushing their existing commands (frame/animation
array snapshots), just without any `activeLayerId`/layer-group bookkeeping.
`state.selectedAnimationId` is still set as today so the new (floating)
animation becomes the one shown in the timeline.

## Accept mechanics

Two triggers, both funnelling into one new command-producing function,
`commitAcceptAnimation(sheet, anim)`, exported from `frames.js` (alongside
`commitNewStrip`/`commitBreakApartStrip`, which it's adjacent to) and
imported by `tools.js` for the auto-accept hook. The Enter-key trigger lives
in `frames.js` itself (`registerFrameTool()`) and works for plain animations
too, since it keys off `state.selectedAnimationId` generically rather than
anything strip-specific:

- **Explicit — Enter/Return.** New `keydown` listener registered alongside
  the existing Delete-key one in `registerFrameTool()`
  (`frames.js:registerFrameTool`). Fires when: not a typing target,
  `state.tool === 'frametool'`, `state.mode === 'sprites'`,
  `state.selectedAnimationId` is set and floating. Operates on "whatever's
  currently selected in the timeline," matching how Rename/Delete/Loop
  already work — not on `state.selectedFrameId`, since a plain animation's
  frames aren't reliably discoverable via `stripOf()` (which requires
  `strip: true`).
- **Automatic — first write.** A single hook at the top of `tools.js`'s
  `handleDown` and `handleSelectDown` (the two places that resolve
  `activeLayer()` before a write): if the active context's animation is
  floating, accept it first, then continue normally. Read-only tools
  (eyedropper) are untouched — they already read through `flattenSheet`,
  which shows floating strips' content unchanged (see Compositing below).

`commitAcceptAnimation` pushes its own undo command: `do()` calls
`acceptAnimation` (idempotent-guarded — no-op if already accepted, matching
the codebase's existing `if (!X)` idempotent-redo idiom used elsewhere) and
sets `state.activeLayerId` to the new layer when the animation's sheet is
still the active one (same cross-sheet redo guard already used by
`commitNewStrip`); `undo()` clears `layerGroupId` back to `null`, removes the
group from `sheet.layerTree`, and restores `state.activeLayerId`. This makes
an auto-accepted first stroke two undo steps: undo the stroke, then undo the
accept.

## Compositing (strips only)

`flattenSheet`/`flattenSheetLayers` (`core/model.js`) is the single choke
point used by the main canvas view, PNG/frame export, and the eyedropper —
fixing it there covers every consumer. (`currentContextLayers()`-based
per-animation previews in `timeline.js`/`frameeditor.js` already only see one
context's own layers and are unaffected.)

New `flattenSheet` shape:

1. `base` = alpha-composite of every sheet layer **except** those belonging
   to an accepted strip's group (root layers + any plain animation's private
   layers) — unchanged `compositeOver` logic, just a filtered layer list.
2. For each accepted strip (`anim.strip && anim.layerGroupId`), compute its
   own flattened composite from `flattenLayers(group)` (its own layers only,
   alpha-blended among themselves).
3. For each of that strip's own frame rects, `blitRegion` (literal replace,
   not alpha-blend — already used elsewhere for pixel-carrying moves) that
   rectangle from the strip's own composite onto `base`. This is what makes
   a strip's rectangle opaque to whatever's underneath while still showing
   its own genuine transparency (not a peek-through) where it has none of
   its own content.

Floating strips have no group, so steps 2/3 skip them — their frame rects
keep showing whatever's normally composited there, which is exactly the
"preview alignment over existing artwork" behavior wanted pre-accept, with no
extra code.

## Resize (strips only)

`commitResizeSegment` (`frames.js`) currently documents "PIXELS STAY on the
sheet by design (growing back re-adopts the art)" for a shrink. New behavior
for an **accepted** strip: the removed end frame's rectangle is cleared
(blitted blank) from the strip's own layer as part of the same command,
using the existing before/after bitmap-patch snapshot idiom already in this
function so it stays cleanly undoable. Remaining frames are **not**
repositioned — only the removed slot's pixels are discarded. Growing still
just adds blank canvas (unchanged). A **floating** strip has no layer, so
shrink/grow stays a pure frame/entry array operation with no pixel effects,
same as today.

## Layers panel ↔ timeline sync

- **Delete**: `panels.js`'s `doDelete`, group-node branch — when
  `g.animationId` is set, call the (newly exported) `commitDeleteAnimation`
  from `timeline.js` instead of just detaching the group
  (`anim.layerGroupId = null`) and leaving the animation alive. Confirm-dialog
  wording updated to reflect that this now deletes the whole animation, not
  just its layer group.
- **Select**: the group row click handler in `panels.js` also sets
  `state.selectedAnimationId = group.animationId` and emits `'selection'`
  when `group.animationId` is set, so the timeline dock's dropdown follows
  the layers-panel selection. `state.activeLayerId` still clears to `null` on
  a group click (unchanged) — you clicked the group, not a layer inside it.

## "≥1 layer" guard (already shipped)

No new work. The existing per-group delete guard in `panels.js` (`Cannot
delete the last layer in this group`) already enforces this for any group,
strip or not. The only new implication: a floating animation has *zero*
layers, not one, and doesn't appear in the layers panel at all until
accepted — so the guard simply has nothing to apply to until then.

## Out of scope

- Repositioning a floating strip over different artwork before accepting
  reuses the existing frame-tool move (already "pixel-carrying" for
  committed frames; a no-op-on-pixels move for a floating one, which is
  exactly "just look at a different part of the canvas") — no new UI.
- Overlapping accepted strips (z-order when two strips' frame rects overlap
  spatially): whichever comes later in `sheet.layerTree.children` wins the
  overlap, same as normal layer stacking today. Not a new edge case this
  design needs to solve for.
