# Accepted strips own their area — paint constraint + pixel-carrying moves

Date: 2026-07-18
Status: approved

## Goal

Once a strip is accepted (has its own layer — see
`docs/superpowers/specs/2026-07-18-floating-strips-design.md`), its own layer
should never carry pixel content outside the area its own frames currently
occupy. Two gaps let that happen today:

1. **Painting is unconstrained.** Every tool (pencil, eraser, fill, line,
   rect, ellipse) writes anywhere on the active layer, including well outside
   an accepted strip's own frames.
2. **Moving a strip's frames doesn't move its pixels.** The frame tool's own
   drag-to-reposition is explicitly metadata-only; the move tool's
   drag-to-reposition *does* move pixels but resolves which layer to move
   from whatever's ambiently selected in the timeline, not necessarily the
   strip actually being dragged.

This closes both gaps for **accepted strips only** (see Scope). Floating
strips and plain animations are unaffected.

## Scope

- Painting constraint and pixel-carrying moves: **accepted strips only**.
  Matches the existing precedent that exclusive compositing is strips-only —
  a strip's frames form one (or more, see below) well-defined rectangle(s);
  a plain animation's frames can be scattered anywhere on the sheet, so "its
  area" isn't well-defined the same way.
- A strip can be split into multiple independently-positioned **segments**
  (via `anim.breaks`) while remaining one `strip: true` animation. "The
  strip's area" is therefore evaluated **per segment**, not as one bounding
  box across the whole animation.
- Cross-animation strip-segment merging (snapping one strip's segment onto a
  *different* strip's segment) is disabled — segments may only merge with
  other segments of the **same** overall strip, for now.
- Clipboard paste and float-commit generally: constrained the same way as
  painting, confined to "the active substrip" at commit time (see Move
  mechanisms).

## Painting constraint

`js/ui/tools.js`'s `bindDrawing(view, getTargetRect, mapPoint, viewKind)`
already constrains every paint tool to whatever rectangle `getTargetRect()`
returns (`clampPoint`, `maskOutsideTarget`, `finalize` in tools.js; the frame
editor and tile editor already pass their own narrower rects). The sheet
view's `getTargetRect` (registered in `js/app/main.js`) currently always
returns the whole sheet.

`getTargetRect` gains an optional `(x, y)` parameter — the point of interest,
normally a stroke's down-point. The sheet view's implementation:

1. Resolve `activeLayer()`. If it doesn't belong to an **accepted strip's**
   own group (via `findParent` → `group.animationId` → the owning
   `anim.strip && anim.layerGroupId === group.id`), return the whole sheet —
   unchanged behavior for root layers and plain-animation layers.
2. Otherwise, resolve the **segment** containing `(x, y)` (via
   `segmentAt`/`segmentOfFrame`-style lookup restricted to this animation's
   own frames) and return that segment's bounding box. If `(x, y)` isn't
   inside any of this strip's own segments, return an empty rect (`w: 0, h:
   0`) — the existing "empty target" handling in `clampPoint`/fill's seed
   check/etc. already makes every tool no-op cleanly against that.
3. When called with **no point** (paste — see Move mechanisms), resolve the
   segment from `state.selectedFrameId` if it belongs to this strip,
   otherwise fall back to the strip's first segment.

**Freezing per stroke:** today `clampPoint`/`maskOutsideTarget`/`finalize`
each call `getTargetRect()` fresh on every pointer event. That would let a
strip's multiple segments "flicker" mid-drag if the pointer strays near
another segment. Instead, the target is resolved **once** at gesture-start
(`handleDown`, mirroring how the select tool already freezes `target` once at
`handleSelectDown`) and threaded explicitly through the rest of that
stroke/shape/select gesture, exactly like `selStroke.target` already works.
`clampPoint`/`maskOutsideTarget`/`finalize` gain an optional explicit
`target` parameter, defaulting to a fresh `getTargetRect()` call for callers
that don't freeze one (fill's single-shot seed check).

The select tool (marquee) also starts threading `(ev.x, ev.y)` into its own
`getTargetRect()` call at `handleSelectDown`, so a marquee drawn while an
accepted strip's layer is active is likewise confined to the segment it
started in — free consistency from the same mechanism.

## Move mechanisms

Two existing mechanisms reposition frames, both keyed off `d.anim` (the
strip owning the dragged frame(s), already resolved via `stripOf` at
drag-start in both cases):

1. **Frame tool's own drag** — `commitMoveFrames` in `js/ui/frames.js`.
   Currently, and by explicit design comment, metadata-only ("frames are
   viewports onto the sheet... use the move tool to move the underlying
   content"). For an accepted strip this leaves pixels behind, orphaned
   outside the frame's new position.
2. **Move tool's frame-float** — `handleMoveDown` (`js/ui/tools.js`) detects
   a frame/segment under the pointer via `segmentAt` and calls
   `createFloat({ allLayers: true, region, frameIds })`. This already moves
   pixels, but `captureLayers` (`js/ui/floatsession.js`) resolves layers via
   `currentContextLayers()` — driven by `state.selectedAnimationId`, i.e.
   whatever's selected in the timeline dropdown, **not necessarily the strip
   being dragged**.

Both are unified under one rule: **whenever frames belonging to an accepted
strip are repositioned, resolve pixel layers directly from that strip's own
group** (`flattenLayers(animationGroup(sheet, anim.id))`), never from ambient
UI selection. Concretely:

- `buildMovePatches(sheet, frames, dx, dy)` (already used internally when
  inserting/removing a mid-strip member and shifting the tail) gains an
  explicit `layers` parameter, defaulting to today's `currentContextLayers()`
  for callers outside an accepted-strip context.
- `commitMoveFrames`'s call site (`handleUp`'s `d.kind === 'move'` branch)
  uses `buildMovePatches` with the dragged strip's own layers when
  `d.anim?.strip && d.anim.layerGroupId`; stays metadata-only (today's
  `commitMoveFrames`) otherwise — plain frames and floating strips are
  untouched.
- `createFloat`/`captureLayers` gain an explicit `layers` override, bypassing
  `currentContextLayers()` when provided. `handleMoveDown`'s segment branch
  resolves the segment's owning strip via `stripOf` and, when accepted,
  passes that strip's own layers explicitly instead of `allLayers: true`.

Because `createFloat` already freezes `floatCtx.targetRect` from
`getTargetRect()` at float-creation time, and `commitFloatIfAny` already
confines its blit to `rectIntersect(floatBounds(float), ctx.targetRect)` —
**no new confinement code is needed at commit time**. Making `getTargetRect`
segment-aware (previous section) automatically confines every float commit
— drag, cut, **and paste** — to the resolved segment, once `getTargetRect`
is called with the appropriate point (the drag's down-point) or, for paste,
with no point (falling back to the selected-frame/first-segment resolution
described above).

### Merge restriction

`findSnap` (`js/ui/frames.js`) currently searches **all** `sheet.animations`
for a snap target, allowing a dragged segment to merge into a different
strip's segment (`commitMergeSegments`'s `!sameAnim` / `transferSegment`
branch). This is restricted to `a === drag.anim` only — cross-animation
snap candidates are never found, so cross-animation merges become
unreachable. `commitMergeSegments`'s cross-animation branch is left in place
(unreachable, not deleted) since this is a "for now" restriction.

With that restriction, every reachable merge is same-strip, so it only ever
touches one accepted strip's own layer group — merging becomes
pixel-carrying using the same `buildMovePatches`-with-explicit-layers
approach as the plain move case, folded into `commitMergeSegments`.

## Out of scope

- Cross-animation strip merging (disabled instead, see above).
- Non-strip frames and floating strips: unaffected by any of the above.
- Resolving overlap when a moved strip's frames land on top of another
  accepted strip's current frames: inherits the existing stance (tree order
  decides, not something this change needs to solve).
