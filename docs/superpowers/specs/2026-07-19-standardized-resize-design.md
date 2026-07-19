# Standardized Resize/Transform Design

## Goal

Unify how corner/edge-handle dragging works across the four places this app
lets you resize something — sprite frame resize, tile resize, the selection
marquee, and the floating-selection/Move-tool scale — so that grabbing a
handle behaves the same way everywhere, using the modifier-key conventions
established by Photoshop and Affinity: Alt anchors the resize at the shape's
center instead of the opposite corner/edge, and Shift toggles proportional
(aspect-locked) vs. free resizing.

## Current state (why this needs unifying)

Four independent implementations exist today, each with its own quirks:

- **Frames** (`js/ui/frames.js`): 4 corner handles only (`nw/ne/sw/se`).
  Always anchored at the opposite corner. No modifiers. Own copy of
  `HANDLES`/`oppositeCorner`/`hitHandle`.
- **Tiles** (`js/ui/tilemode.js`): identical corner-only pattern, byte-for-byte
  duplicated from frames.js, applying only to standalone (non-grid) tiles.
  Grid-owned tiles use the separate grip-based grow/shrink feature (adds/
  removes cells) — untouched by this work.
- **Selection marquee** (`js/ui/tools.js` + `js/core/resizerect.js`): 8
  handles (corners + edge midpoints), independent per-axis resize, anchored
  at the opposite edge/corner, with `target`-rect clamping. No modifiers.
- **Float scale** (`js/ui/tools.js`, the Move tool's `scale` drag kind): 8
  handles, rotation-aware (the float carries a full `{tx,ty,sx,sy,rot}`
  affine transform), but **always** anchored at the float's center —
  hardcoded, no way to get corner-anchored scaling today.

None of the four read `Shift`/`Alt` for resize purposes today (Alt is
already used elsewhere for an unrelated purpose — capturing all layers when
*starting* a new float drag — which is a different code path and doesn't
conflict).

## Scope

**In scope:** the resize/scale gesture in all four systems above.

**Out of scope:**
- Grid-tile cell grow/shrink (`gridresize` drag kind) and sprite-strip
  grow/shrink (`stripresize` drag kind) — these add/remove cells or frames,
  a fundamentally different operation from scaling existing content.
- Adding edge (mid-side) handles to frame/tile resize — they stay
  corner-only; only the anchor/proportional *behavior* on those 4 corners
  is standardized.
- Float rotation (the separate rotation-knob gesture) — untouched.
- Any settings/preferences UI for remapping the modifier keys — see
  "Configurability" below for what *is* in scope on that front.
- Simulating the actual pointer-drag gesture in Playwright, per this
  project's standing convention — manual verification only.

## Modifier semantics

| Modifier | Corner handle | Edge handle |
|---|---|---|
| *(none)* | Resize proportionally, anchored at the **opposite corner** | Resize that axis, anchored at the **opposite edge** |
| Shift | Resize freely (aspect unlocked), anchored at opposite corner | Resize that axis, **and** scale the other axis to match (aspect locked), anchored at opposite edge |
| Alt | Resize proportionally, anchored at the **center** | Resize that axis, anchored at the **center** (opposite edge moves too, symmetrically) |
| Shift+Alt | Resize freely, anchored at center | Resize that axis **and** the other axis to match, anchored at center |

Notes:
- This flips today's default: corner-drag becomes proportional-by-default
  (matching modern Photoshop 2019+), where every resize in this app is
  currently free/non-proportional.
- Float scale changes from *always* center-anchored today to
  opposite-corner-anchored by default, matching the other three — Alt is
  now required to get today's always-center behavior.
- Both modifiers are read **live on every pointer-move event**, not latched
  at drag-start: toggling Alt/Shift mid-drag updates the anchor/lock in
  real time. This falls out naturally from recomputing the new rect/transform
  fresh from the immutable pre-drag snapshot (`orig` rect, or `t0` transform
  for floats) every move event, rather than accumulating incremental deltas
  — no extra state, no drift.
- Frames/tiles only ever expose corner handles, so they're fully covered by
  the "Corner handle" column.
- **Edge handle + Shift, the secondary axis's anchor:** an edge handle has
  no dragged point on the axis it doesn't normally touch (e.g. the
  right-middle handle only ever drives width). This falls out of
  `resolveAnchor`'s definition without any special-casing: for an edge
  handle, the anchor is the **midpoint** of the opposite edge (not just a
  point on it), which is already centered on the secondary axis. So when
  Shift promotes that axis into the resize, growing/shrinking it around the
  anchor's existing (already-centered) coordinate on that axis naturally
  produces symmetric growth — no extra rule needed beyond "anchor = opposite
  edge midpoint," which the table's plain `(none)`/`Shift` rows already say.

### Configurability

Every call site reads the modifiers through two named predicates instead of
inlining `ev.altKey`/`ev.shiftKey`, so the binding is a one-place edit later
(a different key, Affinity's Ctrl-for-center, or eventually a user setting):

```js
// js/core/resizeAnchor.js
export function isCenterAnchorModifier(ev) { return ev.altKey; }
export function isProportionalModifier(ev) { return ev.shiftKey; }
```

No settings UI is being built now — this is purely about not scattering raw
modifier checks across 4 files.

## Architecture

One new pure module, `js/core/resizeAnchor.js` — no DOM/app-state imports,
node-testable, matching `dimlabels.js`'s convention:

```js
export const HANDLES_CORNER; // ['nw','ne','sw','se']
export const HANDLES_ALL;    // ['nw','n','ne','e','se','s','sw','w']

export function isCenterAnchorModifier(ev);
export function isProportionalModifier(ev);

// The point that stays fixed during the drag: opposite corner/edge
// midpoint by default, or rect's center when useCenter is true.
export function resolveAnchor(rect, handle, useCenter);

// orig: the rect BEFORE this drag started (immutable snapshot).
// px, py: current raw pointer position, image-space.
// opts: { useCenter, shiftHeld, target } — target is an optional {x,y,w,h}
// to clamp the pointer into first (mirrors resizerect.js's existing
// clamp-to-layer-bounds behavior).
//
// shiftHeld is the RAW modifier state (isProportionalModifier(ev)), not a
// pre-resolved "is this proportional" boolean -- whether Shift LOCKS or
// UNLOCKS the aspect ratio depends on the handle type (see Modifier
// semantics table: corner defaults to locked, Shift frees it; edge
// defaults to free, Shift locks it), so that flip is resolved once, inside
// this function, via `const locked = HANDLES_CORNER.includes(handle) ? !shiftHeld : shiftHeld`.
// Callers always pass the raw key state through unchanged.
//
// Returns the new {x,y,w,h}.
export function resizeRectFromHandle(orig, handle, px, py, opts);

// Local (u,v) buffer-space pivot for the float-scale case — same concept
// as resolveAnchor but in a 0..w / 0..h local coordinate space rather than
// sheet-global, since the float's own math (forwardPoint/inversePoint)
// works in that space.
export function localAnchorPoint(w, h, handle, useCenter);
```

This module replaces:
- `js/core/resizerect.js`'s `resizeRect` (selection marquee) — that file is
  retired once its one caller migrates, after confirming no other importers.
- frames.js's local `oppositeCorner` + the raw `rectBetween` call in its
  `resize` drag branch.
- tilemode.js's local `oppositeCorner` + its `resize` drag branch.

The float scale can't reuse `resizeRectFromHandle` directly (it solves an
affine transform in rotated space, not an axis-aligned rect), but reuses
`localAnchorPoint` and the same modifier predicates; its own rotation-aware
solve is described below.

## Per-system integration

- **frames.js**: `handleDown`'s `resize` branch drops `oppositeCorner`.
  `handleMove`'s `resize` branch calls
  `resizeRectFromHandle(drag.before, drag.handle, ev.x, ev.y, { useCenter: isCenterAnchorModifier(ev), shiftHeld: isProportionalModifier(ev) })`
  every move event instead of raw `rectBetween`. `snapRect` still applies
  afterward, unchanged. The local `HANDLES`/`oppositeCorner` are deleted in
  favor of the shared module's exports.
- **tilemode.js**: identical swap in its `resize` branch (standalone tiles
  only — untouched for grid-owned tiles, which never reach this branch).
- **tools.js selection marquee**: `handleSelectMove`'s `resize` mode calls
  the same `resizeRectFromHandle`, passing `target` through for the
  existing bounds-clamp behavior. `resizerect.js` retired as noted above.
- **tools.js float scale**: `handleMoveDown` starts storing the grabbed
  handle's *name* (e.g. `'se'`), not just its raw `{u,v}` — today's
  `handleAnchors(float)` returns unlabeled points, so it gains handle names.
  `handleMoveMove`'s `scale` branch is rewritten per the math below.

## Float-scale math

Given the float's transform `{tx, ty, sx, sy, rot}`, `srcRect {x,y,w,h}`,
center `c = (w/2, h/2)`, and `t0` = the transform snapshotted at drag-start:

Every move event, recompute fresh from `t0` (never from the previous
frame's live transform — avoids drift):

1. `pivotUV = localAnchorPoint(w, h, handle, isCenterAnchorModifier(ev))` —
   center `c` if Alt held, else the opposite corner/edge from the grabbed
   handle.
2. `pivotWorld = forwardPoint({srcRect, transform: t0}, pivotUV.u, pivotUV.v)`
   — this point must stay visually fixed on screen for the rest of the drag.
3. Un-rotate the live mouse position around `pivotWorld` using `t0.rot`,
   giving `(px, py)` in local, unrotated units — same technique as today's
   center-relative code, just recentered on `pivotWorld` instead of the
   buffer center.
4. `handleOffset = (handleUV.u - pivotUV.u, handleUV.v - pivotUV.v)` (raw
   local units, relative to the pivot instead of center).
5. `sx = px / handleOffset.u`, `sy = py / handleOffset.v` (skip an axis
   whose offset is 0 — dragging an edge handle only ever drives one axis
   here).
6. Resolve `locked = HANDLES_CORNER.includes(handle) ? !isProportionalModifier(ev) : isProportionalModifier(ev)`
   — same flip as the rect case (corner defaults locked, Shift frees it;
   edge defaults free, Shift locks it). If `locked`: corner handle →
   `sx = sy` = whichever of `|sx|, |sy|` is larger (sign preserved per axis,
   matching the rect case's larger-axis rule below); edge handle → copy the
   driven axis's factor onto the other axis.
7. Solve `tx, ty` so that `(sx, sy, t0.rot)` reproduces `pivotWorld` at
   `pivotUV` exactly: since `forwardPoint` maps the buffer center via
   translation alone (rotation/scale only affect the offset from center),
   `centerWorld = pivotWorld - R(t0.rot)·S(sx,sy)·(pivotUV.u - cx, pivotUV.v - cy)`,
   then `tx = centerWorld.x - srcRect.x - cx`, `ty = centerWorld.y - srcRect.y - cy`.

`rot` is untouched by a scale drag — unchanged from `t0.rot`; rotation only
happens via the separate knob gesture (out of scope here).

This rotation-aware solve is extracted into its own pure function (living
in `js/core/floating.js` alongside `forwardPoint`/`inversePoint`, or a
sibling pure module) specifically so it's node-testable rather than living
inline in `tools.js`'s drag handler.

## Proportional-lock algorithm (corner handles, both rect and float cases)

Given the anchor point and the raw (unconstrained) target point, compute
per-axis ratios `kx = |px - anchor.x| / origW`, `ky = |py - anchor.y| / origH`
(rect case; the float case's `sx`/`sy` from step 5 above serve as the
equivalent per-axis ratios), then use `k = max(kx, ky)` for both axes —
whichever axis moved further (proportionally) drives the size, ensuring
the shape reaches at least as far as the cursor on its dominant axis. This
is the same rule the two reference apps' corner-drag proportional scaling
produces in practice.

## Rendering

No changes needed to the ghost-preview/dimension-label drawing code in any
of the four systems — they all already just take a `{x,y,w,h}` rect (or, for
floats, redraw from the live `transform`) and render it; only the *values*
feeding into them change.

## Testing

- `resizeAnchor.js`'s `resolveAnchor`/`resizeRectFromHandle` are pure
  geometry → full `node --test` coverage: each handle × each modifier
  combination × a couple of aspect ratios, plus the `target`-clamp behavior
  carried over from `resizerect.js`'s existing tests (that test file's
  cases move over rather than getting dropped).
- The float-scale rotation math (step-by-step function above) is pure and
  node-testable: same per-handle × per-modifier matrix, plus at least one
  case with `t0.rot !== 0` to confirm the pivot stays fixed under rotation.
- The actual pointer-drag gesture in the browser is not simulated in
  Playwright, per this project's standing convention — manual verification
  only, same as every other drag feature in this app.
