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
import { passesOpacity, patternPicksSecondary } from './dither.js';
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

  // `keepAlpha` pins the destination's own alpha through the write. lock-alpha
  // paints colour only, so without it a blend would recompute the alpha channel
  // and erode precisely the soft edges that ink exists to protect.
  // `effOpacity` is the per-write opacity computed in `write` below -- the
  // brush's static opacity unless pressure target 'opacity' overrides it.
  function commit(bitmap, x, y, rgba, keepAlpha = false, effOpacity = opacity) {
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

      // Opacity is density: the pattern is indexed by bitmap coordinates so
      // separate strokes over one region stay aligned. When `blends` is on,
      // opacity is honored by the alpha blend in `commit` instead.
      if (!blends && !passesOpacity(px, py, effOpacity)) return;

      const dest = getPixel(bitmap, x, y);
      if (!dest) return;

      // The source colour, for the inks that paint one. `??` and not `||`:
      // a caller may legitimately pass [0,0,0,0] (the eraser does), which is
      // falsy-adjacent only if you test the array wrong.
      const src = srcColor ?? primary;

      switch (kind) {
        case 'lock-alpha':
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

        case 'dither':
          // A two-colour ink: the source colour takes the PRIMARY slot and the
          // secondary swatch stays the secondary. Substituting src for both
          // would make every dithered fill solid, which is the opposite of
          // what this ink is for.
          // Falls back to the source colour without a secondary, the way stamp
          // falls back to solid, rather than throwing on an unset swatch.
          commit(bitmap, x, y, patternPicksSecondary(pattern, px, py) ? (secondary ?? src) : src, false, effOpacity);
          return;

        case 'ramp-shade': {
          // `src` is deliberately unused: this ink writes a NEIGHBOUR of the
          // destination pixel along a palette ramp. There is no sense in which
          // a caller-supplied colour could be that neighbour, so honouring one
          // here would mean abandoning the ramp.
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
