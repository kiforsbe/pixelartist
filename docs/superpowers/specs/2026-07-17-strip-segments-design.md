# Strip Segments — insert, split, snap-merge, resize

Date: 2026-07-17
Status: approved

## Goal

Make animation strips directly editable on the sheet canvas:

- Insert a frame anywhere in a strip via a Word-style "+" call-out (before the
  first frame, between frames, after the last).
- Split a strip into **segments** (sub-strips) via an in-strip "✂" call-out;
  each segment then moves independently.
- Snap segments back together by dragging either end of one segment to the
  opposite end of another. Snapping merges and **reorders**: dropping C's right
  end at A's left end yields C0…Cn, A0…An.
- Resizing a segment (edge grips) adds/removes frames in whole-frame steps.
- Every frame in a strip is always the same size.
- Double-clicking a frame with the frame tool opens the frame editor and
  selects the frame's animation.

## Data model

One schema addition. A strip animation (`strip: true`) gains:

```js
breaks: number[]   // sorted indices into anim.frames where a new segment starts
```

- 8 frames + `breaks: [3]` → segments [0..2] and [3..7]. Empty/absent = one
  segment (today's intact strip).
- Playback is unaffected: the animation always plays its full `frames` order
  regardless of segmentation. Segments are purely spatial.
- `serializeProject` writes `breaks` (cloned); `deserializeProject` defaults it
  to `[]`. `PROJECT_VERSION` stays 2 (older files load fine; the field is
  optional).
- `commitBreakApartStrip` (full dissolve) also clears `breaks`.

### Invariant

Every strip operation maintains, per segment:

1. Members are spatially contiguous left-to-right: frame k+1 sits at
   `(prev.x + prev.w, prev.y)`.
2. Spatial order equals animation order within the segment's run.
3. All members share the same `w`/`h`.

### Core helpers (js/core/strips.js)

Pure functions, no DOM:

- `segmentsOf(anim)` → array of `{ start, end }` index runs derived from
  `breaks` and `anim.frames.length`.
- `segmentOfFrame(anim, frameId)` → the run containing that frame, or null.
- Splice math for merge/insert/delete lives here where practical so it can be
  reasoned about without the canvas.

## In-strip UI (frame tool, canvas overlay)

All chrome is drawn on the CanvasView overlay and hit-tested in the frame
tool's pointer-down handler (before frame hit-testing), matching how all other
in-canvas UI works. Callouts appear when the frame tool is active, no drag is
in progress, and the pointer hovers a strip segment (hover tracked from move
events; re-render on hover change).

### "+" insert call-outs

- One above each frame boundary of the hovered segment: start, every interior
  boundary, end.
- Click → insert a blank frame at that boundary:
  - Members from the boundary rightward shift right by `frameW`
    (pixel-carrying, same copy-all-then-clear-then-blit discipline as
    `commitMoveFrames`).
  - A new frame (`addFrame`) fills the gap; an animation entry is inserted at
    the matching order index. Duration copies the previous entry's (else the
    next's, else `settings.durationMs`).
  - `breaks` at or after the insertion index shift by +1.
- Hidden/disabled when the rightward shift would push any member past the
  sheet edge.

### "✂" split call-outs

- Below each *interior* boundary of the hovered segment.
- Click → add the boundary's animation index to `breaks`. Nothing moves.
- Segments that are split but still adjacent render a dashed separator line at
  the break so the split is visible.

### Delete = remove column

With the frame tool, Delete on a strip member removes the frame **and** closes
the gap: members after it in the segment shift left by `frameW`
(pixel-carrying). Animation entry removed; `breaks` after it shift by −1; a
break that becomes degenerate (empty segment) is dropped. Loose frames keep
today's delete behavior.

## Segment move + snap-merge

- Dragging a member moves its whole segment (today's strip move, scoped to the
  segment's members). Bounding-box clamp to sheet bounds as today.
- **Snap detection** during the drag: if the dragged segment's left (or right)
  edge is within a snap threshold (~10 screen px) of a compatible segment's
  right (or left) edge — same frame `w` and `h` — the ghost snaps to exact
  adjacency (x abutting, y aligned) and both edges highlight in the accent
  color. Only the two geometrically possible pairings exist (right→left =
  dragged frames come first; left→right = dragged frames come last).
- **Release while snapped** commits one undoable merge command:
  - Pixel-carrying move of the dragged members to the snapped position.
  - *Same animation*: splice the dragged segment's entries out of
    `anim.frames` and reinsert immediately before/after the target segment's
    run; remove the break at the junction, keep others (recomputed).
  - *Different animations*: transfer the dragged segment's entries into the
    target animation before/after the target run (durations carried); adjust
    both `breaks` arrays; the stationary animation keeps its name/id; if the
    source animation ends up with zero frames it is deleted
    (`sheet.animations` snapshot in the command). Whole-strip merges (the
    A/B/C example) are the single-segment case.
- Release while not snapped = plain segment move.

## Resize = add/remove frames

- Segments get **edge grips** drawn at the left and right edges of the segment
  bbox (strips still have no corner resize handles).
- Dragging a grip quantizes to whole-`frameW` steps; ghost + CAD dimension
  chain shows the resulting frame count/widths.
- On release:
  - Grow right: append N blank frames after the segment's last entry,
    positioned rightward. Grow left: prepend N blank frames, positioned
    leftward (segment start moves left).
  - Shrink: remove N frames from that end — frame metadata + animation entries
    only; **pixels stay on the sheet** (growing back re-adopts the art).
  - New entries copy the nearest neighbor's duration.
- Clamps: minimum 1 frame per segment; growth clamps to sheet bounds.
- All one undoable command (frames + entries + breaks + selection snapshots).

## Double-click → edit mode

Frame tool double-click on any frame (detected in the tool's pointer handler:
two downs on the same frame within ~350 ms and small movement):

- `state.editingFrameId = frame.id`, `state.view = 'frame'`, emit `view`.
- If the frame belongs to an animation, also set `state.selectedAnimationId`
  and emit `selection` so the timeline follows.

The stray move-drag from the first click commits nothing (zero delta).

## Timeline changes

For intact strips (`strip === true`):

- Drag-reorder and per-cell remove (✕) are disabled — the sheet layout *is*
  the order; reorder by snapping, remove via Delete/resize.
- Duration editing, scrubbing, playback, double-click-to-edit, and Break apart
  all remain.

## Error handling

- Insert with no room: call-out hidden (no dead click, no alert).
- Merge candidates with mismatched frame sizes simply never snap.
- All commands use the existing before/after whole-array snapshot idiom so
  undo/redo restores frames, entries, breaks, pixels, and selection together.
- `removeFrame`/slice-grid-replace paths that touch a strip animation's
  `frames` must keep `breaks` consistent (clamp/drop out-of-range breaks).

## Testing

- Unit-testable pure logic (segment runs, splice math) lives in
  `js/core/strips.js`.
- Playwright smoke (with `?autotest`): create strip → insert middle/start/end →
  split → move segment → snap same-animation (order changes) → snap
  cross-animation (A/B/C scenario, source animation deleted) → resize grow and
  shrink → Delete member closes gap → double-click opens frame editor → undo
  chain walks all the way back.
- Update `tests/smoke.md` with the new items (only flows this change affects).
