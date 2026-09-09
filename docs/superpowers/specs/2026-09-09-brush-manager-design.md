# Brush Manager — Design

Date: 2026-09-09

## Purpose

Replace the app's single-integer brush with a real brush engine and a managed
brush library: user-definable brushes combining a **mask** (which pixels a
stroke touches) and an **ink** (what value is written there), stored in an
app-level library that follows the artist between projects.

The design goal is a large expansion of creative range that stays inside
retro pixel-art constraints. Every brush in this system is incapable of
producing a half-pixel, a soft edge, or a color outside the active palette.

## Current state

The entire brush model is one integer:

```js
// js/host/editor-store.js:26
drawing: { primary, secondary, brushSize: 1 }
```

`brushSize` is clamped 1–8 by a number input in `js/components/tool-palette.js`
and by `[` / `]` shortcuts in `js/features/workbench/editor-workbench.js`.

All painting funnels through one private function:

```js
// js/core/pixels.js:25
function stamp(bmp, x, y, rgba, size) {
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) setPixel(bmp, x + dx, y + dy, rgba);
}
```

`drawLine` calls `stamp`; pencil, eraser and line call `drawLine`.
`drawRect`, `drawEllipse`, `floodFill` and `softFloodFill` call `setPixel`
directly.

Every paint call site in the app lives in one file,
`js/components/canvas/drawing-engine.js:283-373` (seven calls). The other
`setPixel` callers — `js/core/model.js:327` (layer compositing) and
`js/core/pixelSnapper.js:455-484` (snapping) — are **not** painting and must
never be routed through an ink.

## Model

### Brush

```js
Brush {
  id, name,
  mask: {
    kind: 'square' | 'circle' | 'custom',
    size,           // 1..16, for square|circle
    bitmap,         // for custom: 1-bit mask, {width, height, bits}
    colors,         // for custom: optional RGBA payload, used by 'stamp' ink
    spacing,        // integer px between stamps along a stroke; 1 = every px
    scatter,        // integer px max random offset per stamp; 0 = none
    rotate,         // 0 | 90 | 180 | 270 -- lossless quarter turns only
    flipH, flipV,   // booleans, lossless mirrors
    rotateJitter,   // boolean: random quarter turn per stamp (seeded)
  },
  pressure: {
    target: 'none' | 'size' | 'opacity' | 'shade-step',
    min, max,       // output range; integers for 'size' and 'shade-step'
    curve,          // 'linear' | 'soft' | 'hard'
  },
  ink: {
    kind: 'solid' | 'ramp-shade' | 'dither' | 'stamp' | 'lock-alpha' | 'replace',
    opacity,        // 0..100, applied as dither density (see below)
    trueAlpha,      // boolean, default false; real alpha blend instead of density
    jitter,         // 0..N, random ramp-index deviation per stamp
    pattern,        // for 'dither': a named or custom 2-color threshold pattern
    rampName,       // for 'ramp-shade': optional named-ramp override
    replaceColor,   // for 'replace': the only color this ink overwrites
  }
}
```

**Masks are 1-bit.** There is no feathering, no alpha ramp, no anti-aliasing.
A mask pixel is covered or it is not.

**`spacing` and `scatter` are integers in pixels**, never percentages of brush
size. Fractional spacing would put stamps at non-integer positions.

**`stamp` ink requires a `custom` mask**, since it paints that mask's `colors`
payload. Pairing `stamp` ink with a `square` or `circle` mask has no payload
to draw, so it falls back to `solid`. The manager disables the combination
rather than letting it be saved.

### Rotation and flipping — quarter turns only

`rotate` is restricted to 0/90/180/270 and the flips are plain mirrors. These
are **lossless permutations** of the mask bitmap: every source pixel lands on
exactly one destination pixel.

Arbitrary-angle rotation is deliberately excluded. Rotating a 1-bit mask by,
say, 37° requires resampling, which either drops pixels or invents partial
coverage — the mask stops being a crisp pixel shape and starts being a blurry
approximation of one. That is the precise failure mode this tool exists to
avoid, and it cannot be fixed by a better resampler.

`flipBitmap(bmp, flipH, flipV)` already exists at `js/core/pixels.js:217` and
is reused directly. Quarter turns are a transpose plus a flip.

**`rotateJitter` picks a random quarter turn per stamp**, drawn from the
stroke's seeded PRNG. Combined with `scatter` and a custom mask this is the
foliage/gravel/rubble brush: organic-looking variation that is still composed
entirely of lossless permutations of one authored stamp.

### Ink semantics

| Ink | Behavior |
|---|---|
| `solid` | writes the primary color. Today's behavior. |
| `ramp-shade` | reads the destination pixel, resolves the ramp containing it, steps one entry toward light. Alt-drag steps toward dark. |
| `dither` | writes primary/secondary according to a threshold pattern indexed by **bitmap** coordinates. |
| `stamp` | writes the custom mask's own `colors` payload, ignoring primary. |
| `lock-alpha` | writes only where the destination pixel is already non-transparent. |
| `replace` | writes only where the destination pixel equals `replaceColor`. |

### Retro guarantees

These are model invariants, asserted by tests, not user discipline:

1. **No sub-pixel output.** Masks are 1-bit; stamp positions are integers.
2. **Palette closure.** When the active palette is `indexed`, every value an
   ink writes is an entry of that palette. Inks route their final write
   through the existing `nearestColor` path in `js/core/palettes.js`.
3. **`ramp-shade` never interpolates.** It moves between existing palette
   entries only. A ramp of 4 entries has exactly 4 reachable values.
4. **Dither uses two palette entries**, never a blend of them.
5. **Opacity does not invent colors** in its default mode (see below).

### Opacity as dither density

Naive alpha blending over an indexed palette invents colors and destroys the
palette discipline the tool exists to protect. So `opacity` maps to a **Bayer
threshold pattern**: opacity 50 writes through a 50% pattern, opacity 25
through a 25% pattern. Visually this reads as translucency; every written
pixel remains a real palette entry. This is how pre-alpha paint programs did
translucency on indexed hardware.

`trueAlpha: true` opts into real alpha blending for non-indexed work. It is
off by default.

**Opacity quantizes to the pattern's levels.** A 4×4 Bayer matrix offers 17
distinct densities, so the 0–100 slider snaps to the nearest achievable level;
opacity 30 and 31 render identically. The manager shows the snapped value so
this is visible rather than surprising.

**Composition note:** a `dither` ink at opacity 50 composes two patterns and
yields roughly 25% coverage. This is predictable but surprising the first
time, so the brush preview renders the *composed* result.

### Ramp auto-detection

`ramp-shade` stores no colors. At paint time it resolves a ramp from the
active palette and the destination pixel, so one "Shade" brush works in every
project against every palette.

A **ramp** is a maximal run of contiguous palette indices where:

- luminance is strictly monotonic across the run, and
- adjacent entries differ in hue by no more than 45°, and
- no entry in the run is flagged `empty`.

Empty slots and non-monotonic steps break runs. This matches how artists
actually author palettes — ramps as contiguous blocks — and it is fully
deterministic and explainable.

Resolution order for a stroke:

1. If `ink.rampName` is set and the palette defines that named ramp, use it.
2. Otherwise detect the maximal run containing the destination pixel's color.
3. If the color is in no run (an isolated entry), the stroke is a no-op for
   that pixel rather than guessing.

**Named-ramp override** requires a small additive change to the palette shape
committed in `660f3ef`:

```js
Palette { ..., ramps: [{ name, indices }] }   // new, defaults to []
```

`normalizePalette` gains `ramps: []`, and the palette manager grid gains a
"name this selection as a ramp" action. This is additive; existing files load
unchanged.

### Determinism

`scatter`, `jitter` and `rotateJitter` are random, and that randomness has to
be pinned — but **not for the reason it first appears.**

Undo is already safe. Strokes commit through
`makePixelPatch(bitmap, rect, before, after, label)` at
`js/components/canvas/drawing-engine.js:248`, which records before/after pixel
regions. Undo and redo replay **bytes**, not the stroke, so a redo reproduces
a random stroke exactly no matter what the PRNG does.

The real reason is **preview stability while dragging.** Shape tools restore
and fully re-rasterize on every pointer move:

```js
// drawing-engine.js:360 -- runs on EVERY move event
blitRegion(layer.bitmap, before, 0, 0);
drawLine(layer.bitmap, a.x, a.y, p.x, p.y, color, brushSize);
```

Without a fixed seed, a scattered or rotation-jittered line would reshuffle
its entire appearance on every mouse move — the shape would shimmer and boil
under the cursor, and the result you finally released on would be unrelated to
what you were aiming at.

So every stroke carries a **seed**, fixed at pointer-down and held for the
stroke's life. All randomness draws from a seeded PRNG (mulberry32)
initialized from it, and the mask phase derives each stamp's offset and
rotation from `(seed, stampIndex)` rather than from call order — so
re-rasterizing a prefix of the stroke reproduces it identically.

Freehand tools do not re-rasterize, but they use the same mechanism for
consistency and testability.

### Pressure sensitivity

The browser already delivers pressure; the app currently throws it away.
`js/components/canvas/canvas-view.js:187` receives a real `PointerEvent` and
normalizes it down to:

```js
this.onPointer({ type, x, y, sx, sy, buttons, shiftKey, altKey });
```

`e.pressure` and `e.pointerType` are dropped at that boundary. Adding them to
the payload in the three handlers (`_onPointerDown`, `_onPointerMove`,
`_onPointerUp`) is the entire input-path change. No new device layer, no
library.

**Pressure is honored only when `pointerType === 'pen'`.** This guard is not
optional. A mouse reports a constant `pressure` of 0.5 (or 1.0 while a button
is down), and touch input reports wildly inconsistent values across devices.
Without the guard, every mouse user silently gets a brush behaving as though
it were held at half pressure forever.

`pressure.target` selects what pressure drives:

| Target | Effect |
|---|---|
| `none` | **default** — pressure ignored entirely |
| `size` | mask size interpolates `min`..`max`, **rounded to an integer** |
| `opacity` | dither density interpolates, snapped to the pattern's levels |
| `shade-step` | how many ramp entries a `ramp-shade` stamp advances |

Every target quantizes to integers. There is no fractional brush size and no
continuous opacity, so pressure cannot smuggle sub-pixel or off-palette
output past the retro guarantees.

`curve` shapes the response: `linear`, `soft` (ease-in, more control at low
pressure), `hard` (ease-out, reaches max sooner).

The default is `target: 'none'`, so behavior is unchanged for existing users
and for anyone on a mouse.

## Architecture

### Pipeline: stroke mask, then ink pass

A stroke runs in two phases, mirroring the mask × ink model literally:

```
  pointer path
       |
       v
  [ MASK PHASE ]   spacing, scatter, mask rasterization
       |           -> a 1-bit coverage mask + dirty rect
       v
  [ INK PASS ]     ink applied once per newly-covered pixel
       |           -> writes to the layer bitmap
       v
  existing paint command (undo/dirty-rect unchanged)
```

Two properties fall out of this structure rather than needing discipline:

- **Each pixel is inked once per stroke.** Dragging a shade brush back and
  forth over one pixel steps it one entry, not five. The coverage mask is the
  record of what has already been inked.
- **Patterns anchor to bitmap coordinates**, not to stroke start, so two
  separate strokes across one region produce a continuous dither.

### Modules

Following the structure of the palette manager in `660f3ef`:

| Module | Responsibility | DOM? |
|---|---|---|
| `js/core/brushes.js` | brush model, `createBrush`, `normalizeBrush`, built-ins, mask rasterization | no |
| `js/core/brush-ink.js` | ink implementations, dither patterns, seeded PRNG | no |
| `js/core/ramps.js` | ramp detection over a palette | no |
| `js/core/brush-io.js` | import/export formats | no |
| `js/core/pixels.js` | primitives gain an optional coverage-mask output and ink hook | no |
| `js/features/brushes/brush-library.js` | localStorage library via `BrowserPreferences` | yes |
| `js/features/brushes/brush-manager.js` | the manager dialog | yes |
| `js/features/brushes/brush-files.js` | file import/export glue | yes |
| `js/components/canvas/drawing-engine.js` | runs mask phase + ink pass | yes |
| `js/components/tool-palette.js` | brush picker strip in tool options | yes |

The four `js/core/` modules are pure and DOM-free, testable under
`node --test` exactly as `palette-io.js` is.

### Changes to `pixels.js`

Minimal and additive. `stamp` becomes mask-aware; `drawLine`, `drawRect`,
`drawEllipse`, `floodFill` and `softFloodFill` accept an optional ink hook and
default to today's `setPixel` behavior when it is absent. Existing signatures
keep working, so the compositing and snapping call sites in `model.js` and
`pixelSnapper.js` are untouched.

### Scatter widens the overflow guard

`maskOutsideTarget` in `js/components/canvas/drawing-engine.js:179-183` is the
safety net that restores pixels written outside the target rect. Its comment
records the current assumption explicitly: *"brush stamps overflow up to
brushSize-1 px past a clamped coordinate."*

**Scatter invalidates that bound.** A scattered stamp can land up to
`scatter` px further out again, so every call site that computes step bounds
from `brushSize - 1` must become `maskSize - 1 + scatter`. The five bound
computations at `drawing-engine.js:320-366` all need updating, and the comment
needs to record the new bound. Missing one lets a scattered stroke bleed
outside the frame or tile being edited — the exact class of bug this guard
exists to prevent.

A test covering it: paint a scattered stroke at the extreme edge of a target
rect and assert no pixel outside the rect changed.

## Storage

### Library + embedded copies

**The library is the single source of truth for editing.** It lives in
`localStorage` under the existing `BrowserPreferences` namespace, key
`brushes.library`. Custom mask bitmaps serialize as base64 PNG via the
existing `encodePng`/`decodePng` in `js/core/pngcodec.js`.

**Project embeds are derived snapshots, not editable state.** On save, every
brush actually used by the project is written into the project file. On open,
brushes in the file that are not in the library trigger a non-blocking offer:

> This file uses 2 brushes you don't have. [Add to library] [Ignore]

This keeps a shared project self-contained without creating a second editable
copy that could drift from the library.

**Brush edits are undoable, but only inside the manager window.** Brush
definitions are editor configuration, not project content, so they must never
enter project history — undoing a sprite edit should not silently resize a
brush, and undoing a brush rename should not resurrect deleted pixels. The two
histories stay completely separate.

The manager owns a private `CommandStack` from `js/core/commands.js:3` — the
same plain do/undo stack the project used before `HistoryService`, and exactly
the right primitive here because it has no scope machinery to get entangled
with. Every brush edit (rename, resize, mask paint, ink change, reorder,
delete) is a small command pushed onto that stack.

**Routing.** The global undo binding lives at
`js/features/project/document-controller.js:442` on `window`, and its guards
deliberately allow non-modal dialogs through so filter dialogs can stay open
while painting. The brush manager is non-modal, so `Ctrl+Z` inside it would
otherwise hit *project* history. The manager therefore listens for
`Ctrl+Z`/`Ctrl+Y` on its own dialog element and calls `stopPropagation()`.
Because the dialog is deeper in the tree than `window`, its listener runs
first and the global handler never sees the event.

The dialog also renders its own **Undo/Redo buttons**, so the scoping is
visible rather than a hidden keybinding whose behavior depends on focus.

**Lifetime: the stack is cleared when the dialog closes.** Its scope is the
window, matching the requirement. Edits are already persisted to the library
by then, so this is not data loss — but it does mean reopening the manager
starts with an empty history, which the buttons make obvious.

**Named ramps are the exception that stays in project history.** Ramps live on
the palette, which *is* project content, so naming or deleting a ramp is an
undoable palette command at `PROJECT_SCOPE`, added to the existing family in
`js/features/palettes/palette-commands.js`.

The rule, stated once: *brush edits undo on the manager's local stack;
palettes and their ramps undo in project history; the two never mix.*

### Import / export

`js/core/brush-io.js`, pure functions:

- **PNG** — a custom brush exports as a PNG. Opaque pixels are mask coverage;
  their colors are the `stamp` payload. This makes brushes trivially
  shareable and authorable in the app itself.
- **JSON** — a full brush or a whole library, including ink settings, which
  PNG cannot carry.

## UI

**`Edit ▸ Brushes`** opens a non-modal manager dialog, reusing the same shell
helpers as the palette manager: `makeDialogMovable`, `centerDialog`,
`closeOnEscape`, `markDefaultAction`. The menu item is registered through the
`defineAction` registry as `edit.brushes`, matching the established menu
pattern.

The dialog holds a brush grid, a mask editor (size, spacing, scatter, or a
bitmap preview for custom masks), an ink editor (kind, opacity, jitter,
pattern), and a live preview showing a composed stroke.

**Make Brush From Selection** is the primary authoring path: marquee a region,
invoke the action, and the selection becomes a custom mask with its colors as
the `stamp` payload.

A compact **brush picker strip** sits in the existing tool-options panel so
brushes can be switched without opening the dialog.

## Migration

`workspace.drawing.brushSize` is replaced by `workspace.drawing.brush`, the
full resolved active brush. Migration is mechanical:

```js
brushSize: N  ->  { mask: { kind: 'square', size: N, spacing: 1, scatter: 0 },
                    ink:  { kind: 'solid', opacity: 100, jitter: 0 } }
```

The Size input and the `[` / `]` shortcuts edit `brush.mask.size` when the
mask is `square` or `circle`, and are disabled for `custom` masks. The 1–8
clamp widens to 1–16.

## Testing

Pure-core tests under `node --test`, matching the palette manager's approach:

- **`tests/brushes.test.mjs`** — model shape, normalization, built-ins, mask
  rasterization for square and circle at every size.
- **`tests/ramps.test.mjs`** — ramp detection: monotonic runs, hue breaks,
  empty-slot breaks, isolated entries, named overrides.
- **`tests/brush-ink.test.mjs`** — each ink's write behavior, including
  `lock-alpha` leaving transparent pixels alone and `replace` touching only
  its target color.
- **`tests/brush-io.test.mjs`** — PNG and JSON round-trips.
- **`tests/brush-determinism.test.mjs`** — the same seed produces byte-identical
  output across two runs, for scatter, jitter and `rotateJitter`; and
  re-rasterizing a prefix of a stroke reproduces that prefix exactly, which is
  the property shape-tool previews depend on.
- **`tests/brush-transform.test.mjs`** — quarter turns and flips are lossless:
  rotating a mask four times returns the original bitmap, and every rotation
  preserves the set-pixel count exactly.
- **`tests/brush-pressure.test.mjs`** — pressure maps to integer outputs across
  the range and all three curves, and is **ignored entirely** when
  `pointerType` is not `'pen'`.
- **`tests/brush-manager-history.test.mjs`** — the manager's local
  `CommandStack` undoes and redoes each brush edit kind, and never touches
  project history.

Two **invariant tests** carry most of the safety value:

1. **Palette closure** — for every ink, every opacity, and a fuzz of random
   strokes over an indexed palette, assert every written pixel is an entry of
   that palette.
2. **Step-once** — a stroke that crosses one pixel N times moves it exactly
   one ramp entry.

## Out of scope

- **Arbitrary-angle brush rotation.** Quarter turns and flips are in; free
  rotation is excluded on purpose, because resampling a 1-bit mask destroys
  the crisp pixel shape that is the point of the tool.
- Per-brush blend modes beyond the inks listed here.
- Animated or multi-frame brushes.
- Pressure targets beyond size, opacity and shade-step (e.g. pressure-driven
  scatter or spacing).
