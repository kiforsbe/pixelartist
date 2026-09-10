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

// The retro guarantee, in one place: when the palette is indexed, every value
// an ink writes is snapped to a real palette entry.
export function applyPaletteClosure(palette, rgba) {
  if (!palette || !palette.indexed) return rgba;
  return nearestColor(palette, rgba);
}

// Integer hash of a pixel's absolute bitmap coordinates into a single
// stampRandom index. Coordinates are coerced to int32 first (`| 0`) so
// negative values wrap into a distinct, stable unsigned bit pattern rather
// than behaving oddly under Math.imul; the xor/imul mix keeps neighbouring
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

export function makeInk(brush, context) {
  const { kind, opacity, jitter, pattern, rampName, replaceColor, trueAlpha } = brush.ink;
  const { primary, secondary, palette, seed, alt } = context;
  // Pixels this stroke has already inked, keyed "x,y". This is what makes a
  // stroke idempotent per pixel.
  const touched = new Set();
  // trueAlpha promises real alpha blending for non-indexed work (spec:147).
  // ramp-shade writes a ramp *neighbour* rather than a colour of its own, so
  // there is nothing to blend toward -- opacity keeps its density meaning
  // there and trueAlpha is inert.
  const blends = trueAlpha && kind !== 'ramp-shade';

  // `keepAlpha` pins the destination's own alpha through the write. lock-alpha
  // paints colour only, so without it a blend would recompute the alpha channel
  // and erode precisely the soft edges that ink exists to protect.
  function commit(bitmap, x, y, rgba, keepAlpha = false) {
    const dest = getPixel(bitmap, x, y);
    let out = rgba;
    if (blends) {
      const aSrc = (rgba[3] / 255) * (opacity / 100);
      out = blendOver(out, dest, aSrc);
    }
    if (keepAlpha) out = [out[0], out[1], out[2], dest[3]];
    setPixel(bitmap, x, y, applyPaletteClosure(palette, out));
  }

  return {
    write(bitmap, x, y) {
      const key = `${x},${y}`;
      if (touched.has(key)) return;
      touched.add(key);

      // Opacity is density: the pattern is indexed by bitmap coordinates so
      // separate strokes over one region stay aligned. When `blends` is on,
      // opacity is honored by the alpha blend in `commit` instead.
      if (!blends && !passesOpacity(x, y, opacity)) return;

      const dest = getPixel(bitmap, x, y);
      if (!dest) return;

      switch (kind) {
        case 'lock-alpha':
          if (dest[3] === 0) return;
          // primary's own alpha feeds the blend; keepAlpha restores the pixel's
          // alpha afterwards, so the plain path still writes dest[3] exactly as
          // it did before.
          commit(bitmap, x, y, primary, true);
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
          commit(bitmap, x, y, primary);
          return;

        case 'dither':
          // Falls back to primary without a secondary, the way stamp falls
          // back to solid, rather than throwing on an unset swatch.
          commit(bitmap, x, y, patternPicksSecondary(pattern, x, y) ? (secondary ?? primary) : primary);
          return;

        case 'ramp-shade': {
          if (!palette) return;
          let delta = alt ? -1 : 1;
          if (jitter > 0) {
            // Indexed by absolute position, not by call order: shape tools
            // restore and fully re-rasterize on every pointer move, so a
            // per-write counter would hand the same pixel a different value
            // each frame and the preview would crawl. This matches how
            // opacity and dither are anchored above.
            const r = stampRandom(seed, mixCoords(x, y), 'jit');
            delta += Math.round((r * 2 - 1) * jitter);
          }
          if (delta === 0) return;
          const stepped = stepAlongRamp(palette, dest, delta, rampName);
          // A color in no ramp is left alone rather than guessed at.
          if (!stepped) return;
          setPixel(bitmap, x, y, stepped);
          return;
        }

        case 'stamp':
          // Handled by the stroke layer, which knows the mask's color
          // payload; falls back to solid if it reaches here.
          commit(bitmap, x, y, primary);
          return;

        case 'solid':
        default:
          commit(bitmap, x, y, primary);
      }
    },
  };
}
