# CAD-Style Dimension Indicators + Marquee Resize Handles — Design

Date: 2026-07-16
Status: approved

## Summary

Rectangular interactions (marquee selections, frames, floating selections)
get CAD-style dimension indicators: actual size, the change (Δ) during a
resize/move, and an origin pixel-position label at the top-left. The select
tool's marquee additionally gains 8 resize handles.

## Decisions (from brainstorming)

- **Scope:** marquee selections, frames, and the move tool's float overlay
  (scale/resize, rotation, translate). Tiles are skipped — they have no
  rect-drag interaction.
- **Visibility:** live indicators (with Δ) during any create/resize/move
  drag; a quieter persistent origin + W×H label while the rect exists and
  its owning tool is active.
- **Layout:** classic CAD edge labels — width centered below the bottom
  edge, height right of the right edge, origin `(x, y)` at the top-left
  corner. Δ inline next to the affected value, e.g. `32 (+8)`.
- **Marquee handles:** 8 (4 corners + 4 edge midpoints), same visual style
  as the float transform handles.
- **Marquee resize/move stay un-undoable** (marquee state has never been on
  the undo stack).

## Architecture

### 1. `js/ui/dimlabels.js` (new)

Shared screen-space label renderer used by all three overlays.

- `drawRectDims(ctx, view, rect, opts = {})` — `rect` is an image-space
  `{x, y, w, h}`; converts through `view.imageToScreen` (every view's
  implementation accepts sheet-global coords). Draws:
  - width label centered below the bottom edge: `"${rect.w}"`, plus
    `" (+n)"`/`" (−n)"` when `opts.dw` is a nonzero number;
  - height label just right of the right edge, vertically centered:
    `"${rect.h}"` + Δ via `opts.dh`;
  - origin label just above the top-left corner: `"(x, y)"`, plus
    `" (+dx, +dy)"` when `opts.dx`/`opts.dy` are nonzero (move drags).
  - `opts.quiet: true` → persistent variant: origin + W×H only, dimmer
    (e.g. 70% alpha), no Δ.
  - `opts.wOverride`/`opts.hOverride` — display these numbers instead of
    `rect.w/h` (the float overlay passes the scaled content size while
    `rect` is the axis-aligned bounds used for placement).
- `drawAngleLabel(ctx, x, y, radians)` — degrees with one decimal
  (`"45.0°"`, normalized to (−180, 180]), drawn at a screen position (used
  next to the rotation knob).
- Text style: small monospace (11px), white fill with 3px black outline
  (`strokeText` then `fillText`) so labels read on any pixel content.
  Labels are clamped into the canvas viewport when the rect edge is
  off-screen so they never disappear mid-drag.
- Pure canvas drawing — no state imports; fully driven by arguments.

### 2. Marquee resize handles + indicators (`js/ui/tools.js`)

- New handle set for the select tool, drawn in the overlay whenever
  `state.tool === 'select'` and a selection exists: 8 white squares
  (corners + edge midpoints of the axis-aligned selection rect), same
  size/style constants as the float handles.
- Pointer-down hit-test order (select tool): handle → `selStroke = {mode:
  'resize', handle, anchor}` where `anchor` is the opposite corner/edge
  (corner handles resize both axes; edge handles one axis); inside →
  existing `moverect`; outside → existing `new`.
- Resize drag recomputes the rect from anchor + pointer (clamped to the
  target rect, min 1×1, normalized when dragged through the anchor). The
  resize-rect math lives in a small exported pure helper
  (`resizeRect(orig, handle, px, py, target)`) so node tests cover it.
- Indicators in the overlay:
  - `new` drag: live origin + W×H (no Δ — the size is the change);
  - `resize` drag: origin + W×H with `dw/dh` vs the pre-drag rect;
  - `moverect` drag: W×H + origin with `dx/dy` vs the pre-drag position;
  - idle (selection exists, select tool active): quiet variant.

### 3. Frame indicators (`js/ui/frames.js`)

Interactions unchanged (4 corner handles, create ghost, pixel-carrying
move). The frame-tool overlay adds `drawRectDims` calls:

- create drag: ghost rect with origin + W×H;
- resize drag: ghost rect with origin + W×H, `dw/dh` vs the pre-drag frame;
- move drag: origin with `dx/dy` vs the pre-drag position, plus W×H;
- idle: quiet label on the SELECTED frame only (existing name/sequence
  overlays untouched).

### 4. Float overlay indicators (`js/ui/tools.js`, move tool)

Placement rect = `floatBounds(state.floating)` (axis-aligned bounds).
Displayed size = scaled content size: `round(srcRect.w * |sx|)` ×
`round(srcRect.h * |sy|)` via `wOverride`/`hOverride` (a rotated float's
bbox would misreport the content size).

- translate drag: origin at bounds top-left with `dx/dy` (= tx − tx₀,
  ty − ty₀), W×H quiet-style;
- scale drag: W×H with Δ vs the drag-start scaled size, origin label;
- rotate drag: `drawAngleLabel` next to the rotation knob showing the
  current angle; bounds labels in quiet style;
- idle float (move tool active): quiet origin + scaled W×H, plus the angle
  label when `rot ≠ 0`.

## Edge cases

- Rect at/beyond viewport edges: labels clamp into the visible canvas.
- 1×1 or tiny rects at low zoom: labels may overlap the rect — acceptable;
  they remain readable (outlined text).
- Marquee resize handles vs tiny selections: handles may cover the
  interior; hit-test priority (handles first) matches the float tool's
  existing convention.
- Float `sx/sy` sign: displayed size uses absolute values; flips don't show
  negative sizes.

## Testing

- Node (`tests/resizerect.test.mjs`): `resizeRect` — each of the 8 handles,
  clamp to target, min 1×1, drag-through-anchor normalization.
- Browser (scoped to these flows only): marquee create/resize/move show
  correct labels and handles work end-to-end; frame create/resize/move
  labels; float scale Δ and rotation angle label; zero console errors.
  No re-running of unrelated smoke items.

## Docs

- README: select tool row mentions resize handles; short note about
  dimension indicators in the Floating selections section or tools docs.
- tests/smoke.md: extend the existing select/move/frame items minimally
  (no renumbering).
