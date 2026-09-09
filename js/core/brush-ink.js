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

export function makeInk(brush, context) {
  const { kind, opacity, jitter, pattern, rampName, replaceColor } = brush.ink;
  const { primary, secondary, palette, seed, alt } = context;
  // Pixels this stroke has already inked, keyed "x,y". This is what makes a
  // stroke idempotent per pixel.
  const touched = new Set();
  let writeIndex = 0;

  function commit(bitmap, x, y, rgba) {
    setPixel(bitmap, x, y, applyPaletteClosure(palette, rgba));
  }

  return {
    write(bitmap, x, y) {
      const key = `${x},${y}`;
      if (touched.has(key)) return;
      touched.add(key);
      const index = writeIndex++;

      // Opacity is density: the pattern is indexed by bitmap coordinates so
      // separate strokes over one region stay aligned.
      if (!brush.ink.trueAlpha && !passesOpacity(x, y, opacity)) return;

      const dest = getPixel(bitmap, x, y);
      if (!dest) return;

      switch (kind) {
        case 'lock-alpha':
          if (dest[3] === 0) return;
          commit(bitmap, x, y, [primary[0], primary[1], primary[2], dest[3]]);
          return;

        case 'replace':
          if (!replaceColor) return;
          if (dest[0] !== replaceColor[0] || dest[1] !== replaceColor[1] || dest[2] !== replaceColor[2]) return;
          commit(bitmap, x, y, primary);
          return;

        case 'dither':
          commit(bitmap, x, y, patternPicksSecondary(pattern, x, y) ? secondary : primary);
          return;

        case 'ramp-shade': {
          if (!palette) return;
          let delta = alt ? -1 : 1;
          if (jitter > 0) {
            const r = stampRandom(seed, index, 'jit');
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
