# One sprite size per sprite sheet — design

## Goal

A sprite sheet is one sprite: its animations are different states of the
same sprite, so every frame on the sheet has the same pixel size. (A later
"rigging" workbench will compose several sprites into in-game objects —
parts like weapons or swappable clothes — with the same kind of timeline,
the way maps compose tile sheets. It is out of scope here.)

## Decisions (user)

- **Every frame on a sprite sheet** has the sheet's size — not only frames
  used by animations. A static prop of another size is its own sheet.
- **Existing projects are unified automatically on load.**

## Model

- `sheet.spriteSize = { w, h }` on sprite sheets (`null` on tile sheets).
  `createSheet` takes it from `project.settings.frameW/frameH` unless given.
  Serialized with the sheet.
- Invariant: every frame on a sprite sheet is `spriteSize`; every auto
  animation's `cell` equals it. `cell` stays in the format (the planner and
  saved files use it) but is never set independently.

## Load migration — `js/domain/sprites/unify-sprite-size.js`

`unifySpriteSizes(project, settings)` runs from `core/bundle.js`
`loadEntries` after `deserializeProject` (core may import domain; model.js
cannot, since the planner imports model.js).

Per sprite sheet:
- No frames: `spriteSize` = saved value, else the project frame size.
- All frames one size (and `spriteSize` missing or equal): adopt it; no
  pixel changes.
- Mixed: the common pivot P = (max pivotX, max pivotY); W = max(P.x −
  pivotX + w), H likewise — the smallest canvas that holds every frame
  pivot-aligned, so nothing is cropped. Every frame is re-framed to W×H with
  its pivot at P. Manual animations become auto when none of their frames
  is already laid out by another auto animation (else they stay manual;
  their frames are now W×H anyway). Loose frames (in no auto animation) are
  packed as one extra band after the animations. The auto layout plans
  everything fresh (old rects ignored and cleared; stray pixels stay
  obstacles); the max sheet width is raised to W if needed. Locked layers
  are unlocked for the duration and re-locked. A plan that cannot fit
  leaves the sheet as loaded.

## Commands

- `animations.new { sheetId, name? }` — one blank frame of `spriteSize`.
- `animations.resizeCanvas { sheetId, w, h, anchor }` — **sheet-wide**
  (Sprite size…): every frame re-framed to w×h around the 3×3 anchor;
  auto animations re-plan; manual and loose frames are re-framed in place
  (their rect grows/shrinks around the anchor, content cropped/padded).
  Refused, naming the frame, when an in-place frame would leave the sheet
  or overlap another frame. Sets `spriteSize` and every auto `cell`. One
  undo step.
- `animations.autoLayout` — a `size` other than `spriteSize` is refused;
  the pivot-alignment prompt stays (its suggested size is `spriteSize`).
- `sprites.createFrame { sheetId, rect }` — the frame is `spriteSize` at
  the rect's top-left (refused when it would leave the sheet).
- `sprites.resizeFrame` / `sprites.setFrameField` — a w/h change is
  refused ("Every frame on this sheet is W×H — change it with Sprite
  size…"); moves still work.
- `sprites.sliceGrid` — the cell must be `spriteSize`, unless `replace`
  (or the sheet has no frames), which adopts the cell as the new
  `spriteSize` (and every auto cell).

## UI

- Sprite Sheets frame tool: a click stamps a `spriteSize` frame at the
  (snapped) pointer; the preview box follows the pointer; no resize
  handles. Frames still move by dragging.
- Frames panel: W/H read-only, titled with the reason.
- Slice dialog: cell W/H default to `spriteSize`.
- Animations panel: the New form has a name only; per-animation
  Canvas size… becomes sheet-wide **Sprite size…**.
- Animations timeline: New Animation uses `spriteSize`.

## Testing

Unit tests per command (refusals, one undo step, byte-exact undo where
layout runs), the migration (uniform, mixed with pivots, manual→auto,
loose frames, locked layers, no-fit), and presenter tests for the stamp
tool, read-only fields and the panel changes.
