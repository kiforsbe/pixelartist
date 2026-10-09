// js/core/brush-ink.js
// The inks. Pure; no DOM.
//
// An ink is created PER STROKE, not per pixel, because two behaviors need
// stroke-lifetime state:
//   - ramp-shade must step a pixel exactly once per stroke, or dragging back
//     and forth over one pixel would run it up the whole ramp;
//   - jitter draws from the stroke seed.

import { getPixel, setPixel } from './pixels.js';
import { nearestColor } from './palettes.js';
import { stepAlongRamp } from './ramps.js';
import { passesOpacity, passesPatternOpacity, patternPicksSecondary } from './dither.js';
import { stampRandom } from './brush-stroke.js';
import { pressureValue } from './brushes.js';

// The retro guarantee, in one place: when the palette is indexed, every value
// an ink writes is snapped to a real palette entry.
export function applyPaletteClosure(palette, rgba) {
  if (!palette || !palette.indexed) return rgba;
  return nearestColor(palette, rgba);
}

// The single choke point every ink's write passes through, which is exactly
// why the transparency guard lives here rather than in each ink arm.
//
// A fully transparent pixel has no colour. The eraser writes [0,0,0,0], but
// applyPaletteClosure's nearestColor replaces RGB while PRESERVING alpha, so
// on an indexed palette an erased pixel came back as a palette entry under
// alpha 0 -- a transparent *red*. Two things break on that: floodFill's
// region test is `colorsEqual`, so [255,0,0,0] and a never-drawn [0,0,0,0]
// read as different colours and a bucket fill stops dead at an erase
// boundary; and transparent pixels carrying stale RGB fringe when the sheet
// is exported or scaled.
function writePixel(bitmap, x, y, rgba) {
  setPixel(bitmap, x, y, rgba[3] === 0 ? [0, 0, 0, 0] : rgba);
}

// Integer hash of a pixel's absolute bitmap coordinates into a single
// stampRandom index. Coordinates are coerced to int32 first (`| 0`) so
// negative values wrap into a distinct, stable unsigned bit pattern rather
// than behaving oddly under Math.imul; the add/imul mix keeps neighbouring
// pixels from colliding in any structured way. Integer math only -- this
// runs per pixel in the paint loop.
// The two terms are combined with + rather than ^. Math.imul(-x, A) is
// -Math.imul(x, A) mod 2^32, and (-p) ^ (-q) equals p ^ q whenever p and q
// share their lowest set bit -- so an xor here collided mix(x, y) with
// mix(-x, -y) for a third of all coordinate pairs. Addition drops that to
// noise. In-bounds coordinates never reach the negative half today, so this
// is a latent trap rather than a live bug, but it costs nothing to close.
function mixCoords(x, y) {
  let h = (Math.imul(x | 0, 0x27d4eb2f) + Math.imul(y | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  return (h ^ (h >>> 13)) >>> 0;
}

// Standard source-over compositing for a single pixel. `aSrc` is supplied by
// the caller (already folded with opacity, see `commit` below) rather than
// read straight off `src[3]`, so this cannot be `blitOver` from pixels.js:
// blitOver composites whole bitmaps/regions via its own getPixel/setPixel
// loop and derives its alpha only from the source bitmap's own channel, with
// no hook for an separate opacity scalar, and it writes directly rather than
// returning a value for applyPaletteClosure to see.
function blendOver(src, dst, aSrc) {
  const aDst = dst[3] / 255;
  const aOut = aSrc + aDst * (1 - aSrc);
  if (aOut === 0) return [0, 0, 0, 0];
  const mix = (cSrc, cDst) => Math.round((cSrc * aSrc + cDst * aDst * (1 - aSrc)) / aOut);
  return [mix(src[0], dst[0]), mix(src[1], dst[1]), mix(src[2], dst[2]), Math.round(aOut * 255)];
}

// Ink kinds that consume the SECONDARY swatch as a colour of their own.
//
// This lives here, and is exposed on the ink as `usesSecondary`, so that no
// caller ever has to switch on `kind`. Ink taxonomy belongs to this module:
// a caller that sniffed the kind would be silently wrong the moment a seventh
// ink is added, whereas a missing entry here is one obvious place to look.
//
// Verified against every arm of `write`, not assumed:
//   dither      YES -- `patternPicksSecondary(...) ? (secondary ?? src) : src`.
//   solid       no  -- paints the source colour only.
//   stamp       no  -- paints the source colour (a mask's colour payload).
//   replace     no  -- `replaceColor` gates WHICH pixels; the colour is `src`.
//   lock-alpha  no  -- paints `src`, pinning only the destination's alpha.
//   ramp-shade  no  -- its second colour is a RAMP NEIGHBOUR of the
//                      destination pixel (`stepAlongRamp`), which comes from
//                      the palette, not from the swatch. Worth stating
//                      explicitly because "derives a second colour" is easy to
//                      confuse with "reads the secondary swatch".
const SECONDARY_CONSUMING_KINDS = new Set(['dither']);

// Ink kinds that consume a CUSTOM MASK's own per-cell colour payload (the
// `colors` a custom mask's grid may carry -- see brushes.js's rasterizeMask
// and pixels.js's stamp()) instead of the caller's flat source colour.
//
// This lives here, and is exposed on the ink as `usesMaskColors`, for exactly
// the reason SECONDARY_CONSUMING_KINDS does: a caller (pixels.js's stamp())
// must not switch on `kind` to decide whether to honour the payload, because
// that taxonomy rots the moment a seventh ink is added. A brush's mask and
// ink are independent axes (brushes.js's header comment), so the SAME custom
// mask -- payload and all -- can be reused under any ink: `bitmapToBrush`
// itself hands a fresh custom-mask brush `solid` ink by default. Without this
// flag, and with grid.colors carried unconditionally (rasterizeMask does not
// know or care what ink will paint it), stamp() had no way to tell "the
// active ink wants this payload" from "the active ink has never heard of it"
// -- so every ink, `solid` included, painted the embedded palette instead of
// its own colour. Fail-closed by construction: an ink absent from this set
// (including any added later by someone who never reads this comment) simply
// cannot receive the payload.
//
// Verified against every arm of `write`, not assumed:
//   stamp       YES -- this is the whole point of the ink (design doc line
//                      121: "stamp ... writes the custom mask's own colors
//                      payload, ignoring primary").
//   solid       no  -- paints the source colour it is handed by its caller,
//                      never a mask's own stored palette.
//   dither      no  -- alternates the source colour with the secondary swatch;
//                      a mask's per-cell colour is not either of those.
//   replace     no  -- `replaceColor` gates WHICH pixels; the colour is `src`.
//   lock-alpha  no  -- paints `src`, pinning only the destination's alpha.
//   ramp-shade  no  -- its output is a RAMP NEIGHBOUR of the destination
//                      pixel, not a stored colour of any kind.
const MASK_COLOR_CONSUMING_KINDS = new Set(['stamp']);

// THE ERASE RULE, half one: WHICH inks can carry out an erase.
//
// The eraser tool's colour is the fully transparent [0,0,0,0]
// (drawing-engine.js `currentColor`), and every tool now paints through an
// ink, so every ink can be handed it. A fully transparent source colour is
// not a colour: it is an instruction to REMOVE one. So an ink handed an erase
// may erase a pixel or leave it alone, and may never write a coloured or an
// opaque value. Half two -- what an erase actually writes -- is settled once
// in `commit`, which is the only place a value reaches the bitmap.
//
// A set, for the same reason SECONDARY_CONSUMING_KINDS is one: this is ink
// taxonomy, and a seventh ink should have to answer the question here rather
// than inherit whatever answer its branch happens to fall into.
//
// Decided against the code of every arm, not assumed:
//   solid       YES -- writes the source colour, so a transparent one clears.
//   stamp       YES -- same; a mask's colour payload may legitimately be
//                      "nothing", and this is how a stamped erase works.
//   replace     YES -- it gates WHICH pixels are written, never what value
//                      goes down, so an erase removes exactly the pixels
//                      matching replaceColor. (This arm reads as a no-op under
//                      the default replaceColor of null; that is the guard at
//                      the top of the arm, not a property of erasing.)
//   dither      YES -- but on the source-colour phase only. See its arm: with
//                      no second colour to alternate with, the pattern
//                      degrades to a density mask. Without that, a "feathered
//                      erase" removed half the region and PAINTED THE
//                      SECONDARY SWATCH over the other half.
//   lock-alpha  no  -- pinning the destination's alpha and clearing it are
//                      contradictory intents; refusing is more honest than
//                      guessing which one the user meant. Concretely, without
//                      this the erase sentinel's RGB [0,0,0] closed to the
//                      palette's darkest entry under the destination's own
//                      alpha, so the ERASER FILLED THE REGION SOLID BLACK.
//   ramp-shade  no  -- it ignores the source colour entirely and writes a ramp
//                      NEIGHBOUR of the destination, so an erase would come
//                      out as an opaque shade. Worth stating because this arm
//                      LOOKS like a no-op when probed with a colour that lies
//                      in no ramp -- stepAlongRamp returns null and the arm
//                      bails. Over a real ramp it is not a no-op at all: an
//                      eraser would have shaded the region one step lighter.
const ERASE_CAPABLE_KINDS = new Set(['solid', 'stamp', 'replace', 'dither']);

// Ink kinds whose opacity is screened one PATTERN PERIOD at a time
// (dither.js's passesPatternOpacity) rather than one pixel at a time
// (passesOpacity) -- because they ALSO split their admitted pixels between
// two colours using a pattern on the same lattice the density screen uses.
// See passesPatternOpacity's own comment for why those two cannot be allowed
// to partition that lattice independently.
//
// A set, in the same style and for the same reason as the three above: this
// is ink taxonomy, it belongs to this module, and a seventh ink should have
// to answer the question here rather than inherit whichever branch it happens
// to fall into. Fail-closed: an ink absent from this set keeps the finer
// per-pixel screen, which is the correct default for every ink that paints
// ONE colour.
//
// Not exposed on the ink OBJECT (no painting caller needs it), but read by
// the brush dialog through `inkUsesPattern` below, so it can disable the
// Pattern control for the five inks that ignore it.
//
// Decided against the code of every arm, not assumed:
//   dither      YES -- `patternPicksSecondary(pattern, px, py)` splits its
//                      admitted pixels between two colours on a 2x2 lattice
//                      that the Bayer density screen is itself aligned to.
//   solid       no  -- one colour, no pattern; nothing to decorrelate from,
//                      so it keeps the finer screen.
//   stamp       no  -- paints a mask's own per-cell payload, which is indexed
//                      by the MASK's cells, not by a screen-space pattern.
//   replace     no  -- one colour; `replaceColor` gates which pixels, and
//                      that gate is destination content, not a lattice.
//   lock-alpha  no  -- one colour, plus the destination's own alpha.
//   ramp-shade  no  -- one colour per pixel, derived from the destination. It
//                      never reaches this gate on the patterned path anyway,
//                      but the finer screen is still the right answer for it.
const PATTERN_SCREENED_KINDS = new Set(['dither']);

// Ink kinds whose `write` reads `brush.ink.jitter`. Only ramp-shade does: its
// jitter perturbs how far along the ramp a pixel steps, and no other arm has
// a magnitude to perturb -- the five that paint a definite colour would have
// nothing to apply a wobble TO without inventing an off-palette value, which
// is the one thing this editor never does.
//
// Decided against the code of every arm, as above:
//   ramp-shade  YES -- `delta += round((r * 2 - 1) * jitter)`.
//   solid       no  -- writes one colour; a jittered colour would be a colour
//                      the user did not pick.
//   dither      no  -- its randomness is the PATTERN, which is a separate
//                      control; jitter would fight it on the same lattice.
//   stamp       no  -- the payload's colours are the mask's, not ours to move.
//   replace     no  -- same as solid; the gate is destination content.
//   lock-alpha  no  -- same as solid, plus it must not move alpha either.
const JITTER_CONSUMING_KINDS = new Set(['ramp-shade']);

// Both exported as PREDICATES over a kind rather than as the sets themselves:
// a consumer can ask the question but cannot mutate the taxonomy or enumerate
// it for some unrelated purpose. The brush dialog uses them to disable the
// controls an ink ignores, so a Pattern dropdown sitting live next to a
// `solid` brush no longer reads as a setting that does something.
//
// `inkUsesPattern` deliberately reads PATTERN_SCREENED_KINDS rather than
// declaring a fourth set: an ink needs the coarsened screen precisely BECAUSE
// it splits its output on the pattern lattice, and splitting on the pattern
// is what reading `ink.pattern` means -- so the two questions have one answer
// by construction, not by coincidence. An ink that someday reads the pattern
// WITHOUT splitting the density lattice on it would break that identity, and
// must then get its own set rather than being added to this one.
export function inkUsesPattern(kind) { return PATTERN_SCREENED_KINDS.has(kind); }
export function inkUsesJitter(kind) { return JITTER_CONSUMING_KINDS.has(kind); }

// A source colour of "nothing". The eraser's sentinel; see ERASE_CAPABLE_KINDS.
// Alpha alone decides, rather than an exact match against [0,0,0,0]: a
// transparent pixel has no colour, so its RGB carries no information, and a
// source colour that was SAMPLED from a bitmap rather than handed down from a
// swatch can arrive as stale RGB under alpha 0.
function isErase(rgba) {
  return rgba[3] === 0;
}

export function makeInk(brush, context) {
  const { kind, opacity, jitter, pattern, rampName, replaceColor, trueAlpha } = brush.ink;
  const { primary, secondary, palette, seed, alt } = context;
  // Screen anchoring for callers that paint into a DETACHED sub-bitmap. The
  // fill tools copy the target region out to a `sub` whose origin is (0,0),
  // flood that, and blit it back; without an offset the ink would index the
  // Bayer cell and the ramp-shade jitter hash from sub-local coordinates, so
  // the same content filled at an odd x came out with the dither phase
  // inverted relative to a pencil stroke over the same pixels -- the two
  // complementary checkerboards then add up to a solid region.
  //
  // These are added ONLY where a pattern is indexed. Every actual read and
  // write (`touched`, getPixel, commit, setPixel) stays in the bitmap's own
  // coordinates, because that is the bitmap the caller handed us.
  const originX = context.originX ?? 0;
  const originY = context.originY ?? 0;
  // Pixels this stroke has already inked, keyed "x,y". This is what makes a
  // stroke idempotent per pixel.
  const touched = new Set();

  // Pressure changes within a stroke, but the ink must NOT be rebuilt per
  // pointer move -- its `touched` set above is stroke-lifetime state (see the
  // header comment). So pressure lives in mutable closure state instead,
  // seeded from the context and updated in place by setPressure.
  let pressure = context.pressure ?? 1;
  let pointerType = context.pointerType;
  // trueAlpha promises real alpha blending for non-indexed work (spec:147).
  // ramp-shade writes a ramp *neighbour* rather than a colour of its own, so
  // there is nothing to blend toward -- opacity keeps its density meaning
  // there and trueAlpha is inert.
  const blends = trueAlpha && kind !== 'ramp-shade';
  // Resolved once per stroke, not per pixel: the ink's kind cannot change
  // mid-stroke. See PATTERN_SCREENED_KINDS.
  const patternScreened = PATTERN_SCREENED_KINDS.has(kind);

  // `keepAlpha` pins the destination's own alpha through the write. lock-alpha
  // paints colour only, so without it a blend would recompute the alpha channel
  // and erode precisely the soft edges that ink exists to protect.
  // `effOpacity` is the per-write opacity computed in `write` below -- the
  // brush's static opacity unless pressure target 'opacity' overrides it.
  function commit(bitmap, x, y, rgba, keepAlpha = false, effOpacity = opacity) {
    // THE ERASE RULE, half two: what an erase WRITES. Settled here, at the one
    // choke point every value passes through, and ahead of both steps below --
    // each of which destroys the intent in its own way:
    //   - the trueAlpha blend composites TOWARD alpha 0, so aSrc is 0 and
    //     blendOver returns the destination untouched. An erase expressed as a
    //     blend is a no-op by construction; it has to be recognised before it.
    //   - keepAlpha restores the destination's alpha over the result, which is
    //     precisely how lock-alpha turned an erase into an opaque black fill.
    // Palette closure is skipped for the same reason writePixel normalises an
    // alpha-0 result: there is no colour here for nearestColor to snap, only
    // stale RGB for it to invent.
    if (isErase(rgba)) { writePixel(bitmap, x, y, [0, 0, 0, 0]); return; }
    const dest = getPixel(bitmap, x, y);
    let out = rgba;
    if (blends) {
      const aSrc = (rgba[3] / 255) * (effOpacity / 100);
      out = blendOver(out, dest, aSrc);
    }
    if (keepAlpha) out = [out[0], out[1], out[2], dest[3]];
    writePixel(bitmap, x, y, applyPaletteClosure(palette, out));
  }

  return {
    // True when this ink already claims the secondary swatch as one of its own
    // colours. A caller that ALSO wants to spend the secondary on something
    // else -- the shape tools paint a filled shape's interior in it -- has to
    // give way, because there are only two swatches and no third colour to
    // break the tie with. See drawing-engine.js's `fill`.
    usesSecondary: SECONDARY_CONSUMING_KINDS.has(kind),

    // True when this ink claims a custom mask's own per-cell colour payload
    // as one of its own colours -- see MASK_COLOR_CONSUMING_KINDS above.
    // pixels.js's stamp() consults this before ever reading `grid.colors`, so
    // the payload cannot reach an ink that has not claimed it.
    usesMaskColors: MASK_COLOR_CONSUMING_KINDS.has(kind),

    // Pressure changes within a stroke, but the ink must NOT be rebuilt per
    // pointer move -- its `touched` set is stroke-lifetime state (see the
    // header comment).
    // `p ?? pressure` rather than a bare assignment: a mouse/touch pointer
    // event carries no `pressure`, and letting that undefined land here would
    // wipe out makeInk's `?? 1` default and hand pressureValue NaN for the
    // rest of the stroke.
    setPressure(p, type) { pressure = p ?? pressure; pointerType = type; },

    // `srcColor` is the colour the CALLER wants painted at this pixel (see
    // pixels.js `put`). Inks that paint a source colour take it in place of
    // `primary`; ramp-shade, whose output comes from the destination pixel
    // and a palette ramp, ignores it.
    write(bitmap, x, y, srcColor) {
      const key = `${x},${y}`;
      if (touched.has(key)) return;
      touched.add(key);

      // Pattern-space coordinates: bitmap coordinates shifted by the caller's
      // origin, so a dither stays anchored to the sheet even when the ink is
      // painting into a detached sub-bitmap. Used for pattern/jitter indexing
      // ONLY -- never to address a pixel.
      const px = x + originX, py = y + originY;

      // Pressure target 'opacity' overrides the static opacity for this
      // write only; `opacity` itself is a destructured const and is never
      // reassigned. Resolved per write, because pressure may have changed
      // since the last one (via setPressure). Any other target -- including
      // the default 'none' -- leaves effOpacity exactly as it was, so mouse
      // and touch input (pressureValue always null for them) behave
      // precisely as they do today.
      let effOpacity = opacity;
      if (brush.pressure.target === 'opacity') {
        const pv = pressureValue(brush, pressure, pointerType);
        if (pv !== null) effOpacity = Math.max(0, Math.min(100, pv));
      }

      // Opacity is density: the screen is indexed by bitmap coordinates so
      // separate strokes over one region stay aligned. When `blends` is on,
      // opacity is honored by the alpha blend in `commit` instead.
      //
      // A two-colour ink screens a whole pattern period at a time so that its
      // density screen and its colour pattern do not partition the same
      // lattice -- see PATTERN_SCREENED_KINDS and dither.js's
      // passesPatternOpacity. Both screens are pure functions of the absolute
      // pattern-space coordinate, so either way the result is deterministic
      // and screen-anchored, and re-rasterizing a path prefix reproduces it
      // byte for byte.
      if (!blends) {
        const admitted = patternScreened
          ? passesPatternOpacity(pattern, px, py, effOpacity)
          : passesOpacity(px, py, effOpacity);
        if (!admitted) return;
      }

      const dest = getPixel(bitmap, x, y);
      if (!dest) return;

      // The source colour, for the inks that paint one. `??` and not `||`:
      // a caller may legitimately pass [0,0,0,0] (the eraser does), which is
      // falsy-adjacent only if you test the array wrong.
      const src = srcColor ?? primary;

      // THE ERASE RULE, half one (see ERASE_CAPABLE_KINDS): a transparent
      // source colour is an erase, and an ink that cannot express one declines
      // the pixel here rather than inventing a colour for it further down.
      // Leaving the pixel alone is a permitted answer; writing an opaque or
      // coloured value is not.
      const erasing = isErase(src);
      if (erasing && !ERASE_CAPABLE_KINDS.has(kind)) return;

      switch (kind) {
        case 'lock-alpha':
          // Note the two are different rules and both are needed. This one is
          // about a transparent DESTINATION: there is no alpha worth
          // preserving, so there is nothing to paint into. The rule above is
          // about a transparent SOURCE, and this arm declines that outright.
          if (dest[3] === 0) return;
          // lock-alpha paints a source colour like solid does -- it is the
          // ALPHA it refuses to touch, not the colour. src's own alpha feeds
          // the blend; keepAlpha restores the pixel's alpha afterwards, so the
          // plain path still writes dest[3] exactly as it did before.
          commit(bitmap, x, y, src, true, effOpacity);
          return;

        case 'replace':
          if (!replaceColor) return;
          // A fully transparent pixel is never a replace target. createBitmap
          // zero-fills, so every blank pixel is [0,0,0,0]; without this an
          // RGB-only match against black -- the commonest replaceColor there
          // is -- would repaint the whole empty canvas. Alpha is deliberately
          // NOT compared exactly: a visible pixel stays replaceable whatever
          // stray alpha it carries.
          if (dest[3] === 0) return;
          if (dest[0] !== replaceColor[0] || dest[1] !== replaceColor[1] || dest[2] !== replaceColor[2]) return;
          // What replace decides is WHICH pixels get painted, not what colour
          // goes down, so it honours the source colour like solid does.
          commit(bitmap, x, y, src, false, effOpacity);
          return;

        case 'dither': {
          // A two-colour ink: the source colour takes the PRIMARY slot and the
          // secondary swatch stays the secondary. Substituting src for both
          // would make every dithered fill solid, which is the opposite of
          // what this ink is for.
          // Falls back to the source colour without a secondary, the way stamp
          // falls back to solid, rather than throwing on an unset swatch.
          const picksSecondary = patternPicksSecondary(pattern, px, py);
          // The erase rule's one per-kind consequence, and the only thing an
          // arm gets to decide: WHICH pixels an erase touches. There is no
          // second colour to alternate an erase with -- "remove this pixel" has
          // no opposite the secondary swatch could stand in for -- so the
          // pattern stops being a two-colour split and becomes a density mask,
          // exactly as opacity already is. The secondary phase declines.
          // Without this the off-phase went on painting the secondary, so a
          // feathered erase removed half the region and PAINTED the other half.
          if (erasing && picksSecondary) return;
          commit(bitmap, x, y, picksSecondary ? (secondary ?? src) : src, false, effOpacity);
          return;
        }

        case 'ramp-shade': {
          // `src` is deliberately unused: this ink writes a NEIGHBOUR of the
          // destination pixel along a palette ramp. There is no sense in which
          // a caller-supplied colour could be that neighbour, so honouring one
          // here would mean abandoning the ramp. That is also why an erase
          // never reaches this arm (see ERASE_CAPABLE_KINDS): ignoring the
          // source colour is fine when it names a colour and wrong when it
          // means "no colour at all".
          if (!palette) return;
          // Pressure target 'shade-step' scales the step magnitude: a harder
          // press moves further along the ramp in one write. Floored at 1
          // (never 0, which would freeze the brush) and falls back to 1 when
          // pressureValue is null (not a pen, or a different target).
          let step = 1;
          if (brush.pressure.target === 'shade-step') {
            const pv = pressureValue(brush, pressure, pointerType);
            // pressureValue already rounds to an integer, so only the floor
            // at 1 is needed here -- never 0, which would freeze the brush.
            step = pv === null ? 1 : Math.max(1, pv);
          }
          let delta = (alt ? -1 : 1) * step;
          if (jitter > 0) {
            // Indexed by absolute position, not by call order: shape tools
            // restore and fully re-rasterize on every pointer move, so a
            // per-write counter would hand the same pixel a different value
            // each frame and the preview would crawl. This matches how
            // opacity and dither are anchored above.
            const r = stampRandom(seed, mixCoords(px, py), 'jit');
            delta += Math.round((r * 2 - 1) * jitter);
          }
          if (delta === 0) return;
          const stepped = stepAlongRamp(palette, dest, delta, rampName);
          // A color in no ramp is left alone rather than guessed at.
          if (!stepped) return;
          writePixel(bitmap, x, y, stepped);
          return;
        }

        case 'stamp':
          // The stamp ink paints the mask's own per-pixel colour payload, and
          // `srcColor` is precisely how that payload reaches an ink -- so this
          // arm honours it and falls back to primary (solid) when the caller
          // supplies nothing.
          commit(bitmap, x, y, src, false, effOpacity);
          return;

        case 'solid':
        default:
          commit(bitmap, x, y, src, false, effOpacity);
      }
    },
  };
}
