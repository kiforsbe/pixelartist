# Brushes

How the brush system works, what every control in the Brushes dialog does, and
which parts don't work yet.

Open it with **Edit → Brushes…**, or the ⚙️ button on the brush picker strip
under the tool palette's Size field.

---

## The mental model: mask × ink

Every brush is two independent halves, and almost all confusion about this
dialog comes from mixing them up.

| | Question it answers | Controls |
|---|---|---|
| **Mask** | *Which pixels does a stroke touch?* | Kind, Size, Spacing, Scatter, Rotate, Flip, Rotate jitter |
| **Ink** | *What value gets written there?* | Kind, Opacity, Pattern, Jitter, True alpha, Target color, Ramp |

A mask is **1-bit** — a pixel is either in the stamp or it isn't. There is no
partial coverage and no anti-aliasing anywhere in the system, by design. Every
edge you paint is hard.

The ink then decides what colour lands on each of those pixels. It can decline
a pixel entirely (that's how opacity works — see below), but it can never write
a colour that isn't in the current palette: every write is snapped to the
nearest palette entry on the way out.

---

## Where brushes live

There are three surfaces, and they do different things:

- **The picker strip** (under Size in the tool palette) — click a swatch to
  make that brush active. This replaces the active brush *wholesale*: mask,
  ink, pressure, size, everything.
- **The Size field** (tool palette) and the <kbd>[</kbd> / <kbd>]</kbd> keys —
  change the size of the brush you're painting with right now, without
  changing the stored brush. This is the one you want while drawing.
- **The Brushes dialog** — edits the stored library. Changes here persist to
  local storage immediately and have their own Undo/Redo (the buttons in the
  dialog footer, separate from the canvas undo stack).

Editing a brush in the dialog updates the canvas immediately if that brush is
the one you're painting with. The reverse is deliberately *not* true: the
tool palette's Size field and <kbd>[</kbd>/<kbd>]</kbd> change only the brush
in your hand, never the stored library entry — so nudging the size mid-drawing
can't permanently resize a built-in behind your back.

---

## Mask options

**Kind**
- `square` — a filled N×N block.
- `circle` — a filled disc. Size 1 and 2 are single pixels and a 2×2; **size 3
  is a plus/cross** (centre + 4 orthogonal neighbours), not a 3×3 block, which
  is what Aseprite and GraphicsGale also do — a "3px round brush" that's a
  solid square isn't round. From size 4 up it's a real disc.
- `custom` — a bitmap mask, from an imported PNG or a selection capture. The
  bitmap owns the shape; Size scales it (see below).

**Size** — 1 to 16.

For `square` and `circle` this is the mask's dimension in pixels. For a
`custom` mask it's a **scale factor**: 1 draws the bitmap at its stored
resolution, 3 replicates every cell into a 3×3 block. Scaling is
nearest-neighbour — a 1-bit mask has no in-between coverage to interpolate,
and a stamp brush's colours must stay on-palette — so a scaled custom brush
stays hard-edged and keeps its own pixels.

The scale is capped so the result never exceeds 256×256; a bitmap already
that large simply paints at its native size.

**Spacing** — pixels of travel **along the stroke** between stamps. `1` stamps
every pixel; `4` stamps every 4 pixels of movement. This is measured in
distance travelled, not in pointer events, so stroke density does not change
when your machine is busy or your mouse polls faster.

**Scatter** — random offset, in pixels, applied to each stamp. Derived from the
stroke's seed and the stamp's ordinal, never from call order, so a stroke
re-renders identically every time.

**Rotate** — fixed rotation of the mask in 90° steps. Only meaningful for masks
that aren't rotationally symmetric, so it does nothing visible on squares and
circles — it's for custom masks.

**Flip H / Flip V** — mirror the mask. Same caveat as Rotate.

**Rotate jitter** — randomise rotation per stamp. Again, custom masks only in
practice.

---

## Which tools use a brush

Seven, in two groups — and the tool palette shows you which by what it
offers.

**Stamped along a path** — pencil, eraser, line, rect, ellipse. These lay the
mask down repeatedly as the stroke travels, so the whole Mask section applies:
size, spacing, scatter, rotation. Rect and ellipse outlines are brush-width
like every other stroke, and a filled shape gets a solid interior with a
stamped border on top, so scatter breaks up the edge without perforating the
fill.

**Inked, not stamped** — fill and soft flood. These fill a region the
algorithm worked out, so there's no stamp to place: the Mask section does
nothing for them and the Size field is hidden. The Ink section applies in
full, which is how you get a dithered or ramp-shaded flood. The picker is
still there, because *which* brush you flood with decides all of that.

Select, move and the eyedropper use no brush and show neither control.

---

## Ink kinds

### `solid`
Writes the active colour. Left button paints primary, right button paints
secondary. This is the one that works exactly as you'd expect.

### `dither`
Writes **two** colours in a pattern: primary where the pattern is on, secondary
where it's off.

**The secondary colour is the right-click swatch in the palette panel** — it is
*not* set anywhere in the Brushes dialog, which is the usual reason this looks
broken. Defaults to white. If your secondary is white and you're painting on
white, you'll see a solid primary stroke and conclude dither is broken.

To actually see it: set a clearly different secondary (right-click a palette
entry), pick `dither`, set Opacity to 100, and paint. At opacity 100 you get a
clean 50/50 checker of the two colours.

**Pattern** picks the lattice: `checker` (50%), `dots25` (25% dot lattice),
`lines` (50% horizontal). It's enabled only while `dither` is selected, since
no other ink reads it.

### `ramp-shade`
Doesn't paint a colour of its own. It moves each pixel you touch **one step
along a palette ramp** — a run of related colours, light to dark. Left button
steps one way, <kbd>Alt</kbd> steps the other. This is how you shade and
highlight without picking colours by hand.

Three things must be true or it does nothing at all, silently:

1. **There must be a palette.**
2. **The palette must contain a ramp** — either one you named, or one the
   auto-detector finds. Auto-detection looks for a run of entries with
   consistent luminance direction and hue within tolerance, and is
   deliberately conservative: it would rather find nothing than find a "ramp"
   that shades brown into grey. Some palettes (CGA, for instance) legitimately
   contain **zero** detectable ramps. **Naming a ramp yourself is the fix for
   those** — see below.
3. **You must paint over a pixel whose colour is already in the ramp.** On
   empty canvas, or over a colour that sits in no ramp, the pixel is left
   alone rather than guessed at.

So: pick a palette with a proper shading run, block in some colour with
`solid` first, *then* switch to `ramp-shade` and paint over it.

**Naming a ramp.** In **Edit → Palettes…**, click the first swatch of a run,
then **shift-click the last one**. The run highlights and the Ramps panel
below shows how many swatches it covers; type a name and press **Name ramp**.
Named ramps are listed with their actual colours, and each can be deleted.
A run must be at least two swatches, and must be contiguous.

Named ramps follow their colours when the palette changes. Sorting, moving or
removing a swatch, and unlocking (which compacts away empty slots), all
renumber the ramp to match, so a "Skin" ramp still walks the same skin tones
after a sort. A swatch that is removed or cleared drops out of the ramp, and a
ramp left with fewer than two entries is deleted. All of this is undone along
with the palette edit that caused it.

**Ramp** (in the brush dialog) then picks which named ramp *this brush* walks.
Leave it on **(auto-detect)** to keep the old behaviour of finding whichever
run the painted colour happens to belong to. If a brush names a ramp the
current palette doesn't have, the dropdown says so rather than silently
falling back.

**Jitter** randomises the step size per pixel, for a broken-up shading edge.
It's enabled only while `ramp-shade` is selected, since no other ink reads it.

Ramps never interpolate. A four-entry ramp has exactly four reachable values,
and stepping past either end clamps.

### `lock-alpha`
Paints colour but **refuses to change any pixel's alpha**. A fully transparent
pixel is left untouched; an opaque one is recoloured and stays exactly as
opaque as it was.

Use it to recolour existing artwork without spilling outside its silhouette —
block in a shape, then scribble over it with lock-alpha and nothing escapes
the edges.

**On an empty layer it does nothing**, which is the usual reason it looks
broken. There has to be something there already.

### `stamp`
Paints a custom mask's **own stored colours** rather than the active colour —
so a captured or imported multi-colour brush stamps its actual pixels.

Greyed out unless the selected brush has a `custom` mask, because it's
meaningless without one.

### `replace`
Repaints only the pixels that already match a specific colour, leaving
everything else alone — a targeted recolour that ignores shape entirely.

**Target color** sets what it matches. Selecting `replace` seeds it from your
current primary swatch, so it starts on something meaningful rather than
refusing to be selected at all.

Matching is on RGB only, and **fully transparent pixels are never targets** —
otherwise a target of black would repaint the whole empty canvas, since blank
pixels are stored as transparent black.

---

## Opacity is dither density, not transparency

This is the most important non-obvious thing in the system.

Opacity does **not** blend colours. It controls **how many pixels get written**
— it's a dither screen. At 50%, half the pixels in the stamp are painted at
full strength and half are skipped entirely. You get a stipple, not a wash.
That's what keeps every stroke on-palette and pixel-crisp.

The readout next to the slider (`≈ level 16/16`) tells you which of the **17
available densities** you actually landed on. A 4×4 threshold matrix has
exactly 17 distinct levels, so the slider snaps; asking for 63% and 65% gets
you the same screen.

The screen is anchored to **absolute canvas coordinates**, not to your stroke.
Two strokes crossing the same area interlock on one grid instead of each
carrying their own offset pattern, and the texture doesn't swim as you drag.

**True alpha** opts out into real alpha blending. It is only meaningful on a
non-indexed palette — with an indexed palette every blended result is snapped
back to the nearest entry on write, so you'll mostly see no difference.

---

## Pressure

For pen/tablet input only. Mouse input reports no pressure and is ignored
entirely, by design — otherwise every mouse stroke would paint at whatever a
synthetic default happened to be.

- **Target** — what pressure drives: `none`, `size`, `opacity`, or
  `shade-step` (how far each `ramp-shade` write moves along the ramp).
- **Min / Max** — the range pressure maps onto. The bounds retarget
  automatically: `size` is 1–16, `opacity` 0–100, `shade-step` 1–3. Switching
  target **resets min/max to that target's defaults** rather than carrying
  stale numbers over, because a brush that kept `2–6` after switching from
  size to opacity would silently mean "opacity swings between 2% and 6%".
- **Curve** — `linear`, `soft` (ease-in: finer control in the light-touch
  range), `hard` (ease-out: reaches maximum sooner).

---

## Managing brushes

**Create from a selection** — make a selection on the canvas, then
**Edit → Make Brush From Selection**. The menu item is disabled without a
selection. It captures the **composite** of all visible layers, not just the
active layer, so you get what you can actually see. The new brush is added to
the library and becomes active immediately.

**Import** — the `Import…` button takes a `.json` brush file, a `.json` brush
*library* file, or a **PNG**. A PNG becomes a custom mask: opaque pixels form
the mask, and their colours are kept as the payload that `stamp` ink paints.
Importing a library adds brushes that aren't already present and skips ones
whose id you already have — it never overwrites a brush you've edited, and it
reports both counts.

**Export** — writes the selected brush, in the format chosen by the dropdown
next to the button.

**Duplicate** copies the selected brush under a new name — "Circle 5" becomes
"Circle 5 copy", then "Circle 5 copy 2". Use it before experimenting on a
built-in, or as the only way to author a brush from scratch.

**Delete** removes the selected brush. The last remaining brush can't be
deleted, since nothing would put one back.

**Reset** restores a built-in to its factory settings, and is enabled only for
a built-in you've actually changed. This is the way out of having turned
"Circle 5" into something that isn't a circle.

All three go on the dialog's own Undo stack, alongside field edits.

**← / →** move the selected brush one place earlier or later in the list.
Order is the library's only organising axis — there are no folders or tags —
and it's the order the picker strip shows, so this is how you put the brushes
you actually use at the front. Each arrow is disabled at its own end of the
list, and moves are undoable like everything else here.

A duplicate is inserted directly after the brush it was copied from, and an
undone Delete returns to the position it was removed from, not to the end.

---

## Known limitations

Verified against the code, not guesses.

1. **A ramp must be a contiguous run of swatches.** You can't hand-pick a
   scattered set. Sort the palette by luminance first if a run isn't adjacent.

2. **True alpha is inert on an indexed palette** — every blended result is
   snapped back to the nearest entry on write, so it will mostly look like
   nothing happened. It's meaningful only on a non-indexed palette.
