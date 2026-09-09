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

`scatter` and `jitter` are random, and randomness breaks undo — a redo must
paint exactly what the original stroke painted.

Every stroke therefore carries a **seed**, stored in its command. All
randomness draws from a seeded PRNG (mulberry32) initialized from that seed.
The mask phase generates all stamp positions up front from the seed, so a
stroke is reproducible by construction rather than by bookkeeping.

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

**Consequence: there is no brush command family and no brush undo.** Brush
definitions are editor configuration, like preferences, not project content.
Deleting a library brush asks for confirmation via `confirmOrAuto` instead.
This is a deliberate simplification over the palette design, where palettes
*are* project content and therefore *are* undoable at `PROJECT_SCOPE`.

**The one exception is named ramps.** Ramps live on the palette, which is
project content, so naming or deleting a ramp *is* an undoable palette command
at `PROJECT_SCOPE`, added to the existing family in
`js/features/palettes/palette-commands.js`. The rule is consistent once stated
as: *brushes are configuration and are not undoable; palettes and their ramps
are project content and are.*

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
  output across two runs, for scatter and jitter.

Two **invariant tests** carry most of the safety value:

1. **Palette closure** — for every ink, every opacity, and a fuzz of random
   strokes over an indexed palette, assert every written pixel is an entry of
   that palette.
2. **Step-once** — a stroke that crosses one pixel N times moves it exactly
   one ramp entry.

## Out of scope

- Brush rotation and flipping. Worth adding later; not needed for a first cut.
- Pressure sensitivity. No tablet input path exists in the app today.
- Per-brush blend modes beyond the inks listed here.
- Animated or multi-frame brushes.
