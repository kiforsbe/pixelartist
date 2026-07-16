# Floating Selection Engine — Design

Date: 2026-07-16
Status: approved

## Summary

Rework content moving around a floating-selection engine. Moving selected
pixels cuts them out of the layer into a floating buffer that is rendered
live at its layer's z-position but does not touch any layer bitmap until the
user accepts it. The move tool gains transform functions (move, scale,
rotate). An internal clipboard (cut/copy/paste) produces floats the same
way. The select tool becomes selection-only.

## Decisions (from brainstorming)

- **Float rendering:** true floating buffer — layer bitmaps stay clean while
  floating; every renderer composites the float at its layer's z-position.
- **Commit:** `Enter` commits explicitly. Any tool switch, sheet switch,
  mode switch, or entering/leaving the frame/tile editor **auto-commits**
  first (Affinity behavior). `Escape` cancels and restores source pixels.
- **Select tool:** selection-only. Dragging inside the marquee moves the
  marquee **rect** (shape preserved); it never moves contents. The move tool
  is the only content mover.
- **Multi-layer:** `Alt` held at drag start (or `Ctrl+Alt+X`/`Ctrl+Alt+C`)
  floats **all layers**, one buffer per layer. Default is active layer only.
  The "All layers" checkbox is removed.
- **Transforms:** free scale (8 handles) and free rotation (stalk handle),
  resampled **nearest-neighbor from the original float buffer** on every
  re-render — no cumulative degradation.
- **Undo:** stepwise. Float creation, each completed transform drag, commit,
  cancel, cut, and paste are each one command on the main `CommandStack`
  (closure-based do/undo — redo works throughout).
- **Clipboard:** full internal clipboard. `Ctrl+X` cut, `Ctrl+C` copy,
  `Ctrl+V` paste-as-new-float.
- **Identity commit degenerates to cancel:** committing a float whose
  transform is still identity restores the source exactly and pushes no
  pixel change beyond reversing the cut (net no-op history entry is fine).
- **Autosave is skipped while a float is pending** (avoids persisting the
  cut-out source hole without its float). Explicit Save / Save As / Export
  auto-commit first.
- **Project New/Open drops the float** without committing (the bitmaps the
  float belongs to are being discarded).

## Architecture

### 1. `js/core/floating.js` (new, pure)

```js
// Float shape (held in state.floating, exactly 0 or 1 at a time):
{
  sheetId,                       // owning sheet
  srcRect: {x, y, w, h},         // where the pixels were cut from
  cut: bool,                     // false for paste-origin floats (no source hole)
  layers: [{ layerId, buffer }], // buffer = Bitmap snapshot, srcRect-sized, immutable
  transform: { tx, ty, sx, sy, rot }, // translation (sheet px), scale, rotation
                                 // (radians) about the buffer center
}
```

Functions (all pure):
- `makeIdentityTransform()`
- `floatBounds(transform, w, h)` → axis-aligned integer bbox of the
  transformed rect in sheet space (marquee, handle placement, dirty rects).
- `rasterizeFloat(float)` → `[{ layerId, bitmap, x, y }]`: for each layer
  buffer, inverse-map each destination pixel in the bbox through the
  transform and nearest-neighbor sample the original buffer. Deterministic
  and unit-testable.

### 2. State & rendering integration

- `state.floating` (app/state.js): the single active float or null.
- `flattenSheet(sheet, floating = null)` (core/model.js): when a layer has a
  float buffer (and `floating.sheetId === sheet.id`), composite the
  rasterized float **source-over** immediately after that layer, honoring
  layer opacity/visibility. Rasterization is cached keyed by
  (float identity, transform values) so pan/zoom repaints don't resample.
- Call sites updated to pass `state.floating`: main.js sheet scratch +
  PNG export, frameeditor.js, tileeditor.js, timeline.js preview,
  tools.js eyedropper.
- Layer thumbnails (panels.js): when the layer has a float buffer,
  `drawFit` a temp composite (layer bitmap + rasterized float) instead of
  the raw bitmap.
- CanvasView pointer events gain `altKey` (alongside existing `shiftKey`).

### 3. Move tool (tools.js)

Pointer-down routing, in order:
1. **Float pending, hit on a handle** (screen-space hit test, constant-size
   handles): start a scale drag (corner/edge handle) or rotate drag (stalk).
2. **Float pending, inside transformed bbox:** start a move drag.
3. **Float pending, outside:** auto-commit, then fall through as if no
   float existed (the same click may start a new float grab).
4. **No float:** region = current selection rect clamped to the target rect,
   or the whole target rect when no selection. `Alt` → all layers, else
   active layer. Push a **float command**:
   - `do()`: snapshot buffers, clear `srcRect` on the source layer(s)
     (`cut: true`), set `state.floating`.
   - `undo()`: restore source pixels, clear `state.floating`.
   Then the drag becomes a move drag.

Drags update `state.floating.transform` live and `emit('pixels')`
(renderers re-flatten). Pointer-up pushes a **transform command**
(before/after transform snapshots; do/undo assign them). A drag that ends
with an unchanged transform pushes nothing.

Keys (window keydown, gated on no dialog / not typing):
- `Enter` → **commit command**: `do()` composites `rasterizeFloat()` output
  into each layer **clamped to the target rect** (frame-editor confinement;
  pixels outside are discarded), clears `state.floating`, sets `selection`
  to the committed bbox (clamped). `undo()` restores the pre-commit pixels
  in the patch rects and restores the float. Identity-transform commit on a
  `cut` float restores source exactly (degenerate cancel).
- `Escape` → **cancel command** when a float is pending: `do()` blits
  buffers back to `srcRect` (for `cut` floats; paste floats just disappear),
  clears `state.floating`. `undo()` recreates the float. Escape with no
  float keeps the existing clear-marquee behavior.

Auto-commit hooks: `'tool'` event, sheet selector change, mode switch,
frame/tile editor enter/exit, Save/Save As/Export handlers. All call one
shared `commitFloatIfAny()` before proceeding. Project New/Open clears
`state.floating` without a command.

### 4. Select tool fix

`handleSelectDown/Move/Up`'s move mode no longer touches pixels: dragging
from inside the marquee translates the rect (dimensions preserved, clamped
inside the target rect). The clip/fill/blit content-move path is deleted.
Rect moves push no command (marquee creation is already un-undoable).

### 5. Clipboard

Module-level singleton `{ srcRect, layers: [{layerId, buffer}] }` — internal
only (no OS clipboard). All bindings gated on no open dialog / not typing;
a pending float auto-commits first.

- `Ctrl+X` (cut): requires a selection. Captures buffers from the active
  layer (`+Alt`: all layers), sets the clipboard, pushes ONE command that
  clears the selection rect on those layers.
- `Ctrl+C` (copy): same capture, no mutation, no command.
- `Ctrl+V` (paste): pushes a **paste command** creating a `cut: false`
  float from the clipboard buffers and switches to the move tool.
  Position: the clipboard's `srcRect` if it intersects the current target
  rect, else centered in the target. Layer mapping: buffers attach to their
  original `layerId`s when present in the active sheet; if none survive,
  buffers are composited together (in captured z-order) and floated onto
  the active layer.

### 6. History hygiene (prerequisite fix)

`bindDrawing`'s `on('project')` cleanup currently resets selection state on
**every** `'project'` emit — `markDirty()` fires it too, which float
commands do constantly. Change it to remember the last seen `state.project`
reference and only reset when the project object identity changed. This
also removes the fragile markDirty-before-push ordering documented in
`handleMoveUp`.

### 7. Overlay UI

Move tool overlay (view.onOverlay): transformed float outline (rotated
rect), 8 filled square scale handles, rotation stalk + knob above top-center
— all constant screen size. The marching-ants marquee continues to render
for `selection` when no float is pending; while floating, the outline
replaces it.

## Error handling / edge cases

- Float creation on an empty region (all transparent) still floats —
  consistent, harmless.
- Selection entirely outside the target rect: move tool no-ops (existing
  behavior preserved).
- Scale through zero: clamp |sx|,|sy| to a minimum (e.g. 0.01) to avoid a
  degenerate matrix; negative scale (flip via handle pull-through) is
  allowed and is how flips are achieved.
- Rasterized bbox may exceed sheet bounds mid-transform: rendering and
  commit both clip (commit additionally clips to the target rect).
- Undo past the float-creation command while the float is pending is legal
  and simply removes the float (its `undo()` does exactly that).
- Sheet deleted / project replaced while floating: float dropped (see
  Decisions).

## Testing

Unit (`tests/floating.test.mjs`):
- `floatBounds`: identity, translate, 90° rotate, 2× scale, combined.
- `rasterizeFloat`: identity round-trip equals buffer; translate; 90°
  rotate of an asymmetric pattern; 2× scale nearest-neighbor duplication;
  resample always from original buffer (apply two transforms, compare
  against single equivalent transform).
- `flattenSheet(sheet, floating)`: float composites at correct z (between
  layers), respects opacity/visibility, null floating unchanged (existing
  tests keep passing).

Browser smoke (scoped to selection/move areas only, per user):
- Select tool: marquee drag-inside moves rect only; pixels untouched.
- Move drag floats (source hole appears, float follows cursor), Enter
  commits, Escape restores; stepwise undo (transform undone, then float
  undone) and redo.
- Scale + rotate via handles; commit renders nearest-neighbor result.
- Alt-drag floats all layers; per-layer commit.
- Ctrl+X/C/V round trip; paste is floating, commits on tool switch.
- Frame editor: committed float clipped to frame rect.

`npm test` green; zero console errors.

## Docs

- README: select tool description (selection-only), move tool (float +
  transform + Enter/Escape), shortcuts table additions
  (`Enter`, `Escape`, `Ctrl+X/C/V`, `Alt` modifier).
- tests/smoke.md: rewrite ONLY the selection/move-related items (section 2
  item 10, section 16 items 64–67) plus new float/clipboard items.
