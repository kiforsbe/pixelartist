# CAD Dimension Lines v2 — Design

Date: 2026-07-16
Status: approved

## Summary

Upgrade the dimension indicators from plain text labels to true CAD-style
dimension lines: extension lines normal to the measured edge, an arrowed
dimension line between them, and the value in a pill centered on the line.
Dimension lines sit at stacked offsets so sub-part chains (strip members,
grid cells) and the overall dimension coexist. Frame-blue theming.

## Decisions (from brainstorming)

- **Geometry:** extension lines perpendicular to the measured edge at the
  span's start/end; dimension line parallel to the edge between them;
  arrowheads at both ends touching the extension lines; value pill centered
  ON the dimension line.
- **Dynamic offset:** dimension rows stack outward — level 0 (innermost) for
  sub-part chains, level 1 for the overall dimension. Single rects use
  level 0.
- **Too-small case:** when the pill doesn't fit between the arrows, flip the
  arrows to the outside (pointing inward) and stick the pill out past the
  far extension line, on the dimension line's axis — classic CAD.
- **Sub-part chains:** intact strips (frame tool) and a NEW live slice-grid
  preview. Every cell gets its own dimension ("dimension each cell"), but
  chains run only along the edges of the strip/grid: top edge = one dim per
  column width, left edge = one dim per row height (not per interior cell).
  Cells are uniform in practice; the chain still shows each one.
- **Spacing/margin gaps** in the slice grid are left undimensioned.
- **Pill style:** dark chip background `rgba(20,20,24,.85)`, 1px `#4f8cff`
  border, light-blue `#a9c7ff` text, 11px monospace, rounded corners.
- **Origin indicator:** small `#4f8cff` right-angle corner marker at the
  rect's top-left + a `(x, y)` pill beside it; `(+dx, +dy)` appended during
  move drags.
- **Theme:** all lines/arrows/extension lines/markers `#4f8cff` (the frame
  overlay blue); light blue `#a9c7ff` for pill text.
- **Δ display** stays inline in the pill text: `44 (+16)`.
- **Quiet variant** (idle): same geometry at 70% alpha, no Δ (unchanged
  semantics from v1).

## Architecture

### 1. `js/ui/dimlabels.js` — rewritten around a dimension engine

Pure drawing, no app-state imports (unchanged constraint). Internally split
into a pure LAYOUT step (node-testable) and a draw step:

- `layoutDimension({ a, b, axis, level, textW })` → placement record:
  `{ dimA, dimB, extA: [p,p], extB: [p,p], arrows: 'in'|'out', pill: {x, y}, }`
  where `a`/`b` are SCREEN-space span endpoints on the shape edge, `axis`
  is `'h'` (measuring width, line drawn below) or `'v'` (measuring height,
  line drawn right), `level` picks the offset row
  (`offset = 14 + level * 20` screen px), `textW` decides the too-small
  flip. Exported for tests.
- `drawDimension(ctx, view, a, b, { axis, level, text, alpha })` — draws
  extension lines (2px gap from the shape, 4px overshoot past the dimension
  line), the dimension line, filled triangular arrowheads (~6px), and the
  pill via `layoutDimension`. Everything clamps into the CSS-pixel viewport
  (keeping v1's transform-derived clamping and text-extent awareness).
- `drawRectDims(ctx, view, rect, opts)` — SAME signature as v1
  (`{dw, dh, dx, dy, quiet, wOverride, hOverride, level}`); orchestrates:
  width dimension below the rect, height dimension right of it, origin
  marker + `(x, y)` pill at top-left. Existing callers (marquee, frames,
  float) get the new visuals without call-site changes; `level` defaults 0.
- `drawChainDims(ctx, view, spans, { axis, level, alpha })` — one
  dimension per span (`spans = [{a, b, text}]` in image-space coords along
  one edge); used for strip members and grid columns/rows.
- `drawAngleLabel(ctx, x, y, radians)` — same signature, restyled to the
  pill look.
- Pill rendering helper shared by all of the above (rounded rect, border,
  text), replacing v1's outlined-text `drawLabel`.

### 2. Consumers

- **tools.js (marquee, float):** no call-site changes; visuals update via
  the rewritten `drawRectDims`/`drawAngleLabel`.
- **frames.js (single frame):** existing `drawRectDims` calls unchanged.
- **frames.js (intact strips):** when the frame tool has a strip member
  selected — idle or during a strip move — draw:
  - level-0 width CHAIN below the strip bbox: one dimension per member (in
    x order), each measuring that member's width;
  - level-1 overall bbox width below the chain;
  - a single level-0 height dimension right of the bbox (members share
    height); no level-1 height (it would duplicate).
  - During the move drag the rects are the ghost positions (bbox + delta)
    and the origin pill carries `(+dx, +dy)`. The existing single-frame
    label calls are skipped for strip members (the chain replaces them).
- **frames.js (slice-grid live preview, NEW):** while `#dlg-slicegrid` is
  open, the sheet view draws a ghost grid computed from the dialog's
  CURRENT input values (cell w/h, margin, spacing, live via `input`
  listeners → `view.requestRender()`):
  - ghost cell outlines in the existing dashed-white ghost style;
  - level-0 chain along the TOP edge: each column's cell width;
  - level-0 chain along the LEFT edge: each row's cell height;
  - level-1 overall dimensions of the sliced region (from margin to the
    last cell edge);
  - invalid/degenerate inputs (nonpositive cell size, zero columns/rows)
    draw nothing. Preview clears when the dialog closes (OK or Cancel).

### 3. Layout details

- Offsets are measured from the SHAPE edge in screen px: extension lines
  start 2px outside the edge and end 4px past the dimension line; the
  dimension line for level L sits at `14 + 20·L` px.
- Arrowheads: filled triangles, ~6px long, base on the dimension line.
- Too-small rule: pill fits iff `span ≥ textW + 2·arrow + 4`; otherwise
  arrows flip outside and the pill anchors just past the b-side extension
  line (or a-side if b would leave the viewport).
- Chains reuse one shared dimension-line row (same level/offset); each
  span gets its own extension lines and arrows. Adjacent spans in a
  contiguous strip share the extension line between them visually (two
  lines drawn at the same position is acceptable — no dedup required).
- Viewport clamping: pills stay fully visible (v1 behavior); dimension and
  extension LINES may clip at the canvas edge naturally.

## Edge cases

- Very small rects at low zoom: the too-small rule kicks in per dimension
  independently (width may fit while height sticks out).
- Strip of 1 member: chain degenerates to the plain single-frame case
  (no level-1 row).
- Slice preview larger than the sheet: cells are computed exactly as
  `sliceGrid` would create them (same math), so the preview always matches
  the eventual result; region clamped to the sheet like the slicer does.
- dpr scaling: all sizes in CSS px via the ctx transform (v1 fix retained).

## Testing

- Node (`tests/dimlayout.test.mjs`): `layoutDimension` — offsets per level,
  extension line endpoints, arrow direction flip at the too-small
  threshold, pill centering, stick-out placement side.
- Browser (changed flows only): marquee resize (new visuals + Δ pill),
  single frame create/resize/move, strip selected → chain + overall rows,
  strip move ghost dims, slice-grid dialog live preview (change inputs →
  preview updates; cancel → gone), float scale/rotate pills. Zero console
  errors. No re-run of unrelated smoke items.

## Docs

- tests/smoke.md: amend the existing dimension-label wording in items
  10/21/66 (pill/dimension-line phrasing), add a slice-grid-preview
  sentence to item 23. No renumbering.
- README: one sentence in the frame-tool/select-tool rows mentioning
  CAD-style dimension lines (replacing "CAD-style size/origin labels").
