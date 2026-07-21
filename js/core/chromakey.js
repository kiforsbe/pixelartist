// Chroma-key filter: removes or recolors pixels close to a chosen key
// color, matched by CHROMINANCE rather than raw RGB -- that's what
// "chroma" in "chroma key" actually refers to. Converts to YCbCr and
// measures distance mostly in the Cb/Cr (color) plane, so different
// shades of the SAME background hue (a lighting gradient, JPEG
// artifacts, anti-aliasing) all read as close without having to re-pick
// the key color for every shade. Luminance (Y) still contributes, but
// weighted by how saturated the KEY color itself is: chrominance carries
// ~0 discriminating information for a near-gray key (black/white/every
// gray in between all sit at Cb=Cr=0), so a neutral key falls back
// toward luminance-driven matching instead of treating every gray as
// "the same color" as every other gray.

const MAX_DISTANCE = 300; // calibration reference for percentToRadius, see its own note

function rgbToYCbCr(r, g, b) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b,
  };
}

// Euclidean distance in YCbCr space, with Y (luminance) scaled down by
// lumaWeight before squaring -- lumaWeight is 1 for a fully neutral key
// (grays can only be told apart by luminance, so it needs full weight,
// which also makes this degrade gracefully toward a plain-RGB-ish
// distance for a black/white background) down to 0.15 for a fully
// saturated key (brightness of that hue should barely matter -- Cb/Cr
// alone already discriminates it from other hues well). chromaMagnitude
// (0 for any gray, ~135 for a fully saturated primary/secondary color)
// is what decides where a given key falls on that scale.
function colorDistance(r, g, b, keyColor) {
  const p = rgbToYCbCr(r, g, b);
  const k = rgbToYCbCr(keyColor[0], keyColor[1], keyColor[2]);
  const keySaturation = Math.min(1, Math.sqrt(k.cb * k.cb + k.cr * k.cr) / 100);
  const lumaWeight = 1 - 0.85 * keySaturation;
  const dCb = p.cb - k.cb, dCr = p.cr - k.cr, dY = (p.y - k.y) * lumaWeight;
  return Math.sqrt(dCb * dCb + dCr * dCr + dY * dY);
}

// Percent (0-100) -> a radius in the same units as colorDistance. Eased
// with a square curve (not linear) so the low end of the slider -- where
// nearly all practical use happens -- gets much finer control: the count
// of colors within radius R of a point grows roughly with R^3, so a
// linear percent-to-radius mapping made even a modest softness bump sweep
// in a hugely disproportionate share of colors. Squaring the percent
// still reaches full coverage at 100% (same fixed point a linear mapping
// would have), but compresses everything below it.
function percentToRadius(percent) {
  const t = Math.max(0, Math.min(100, percent)) / 100;
  return t * t * MAX_DISTANCE;
}

// 1 inside `tolerance`, 0 beyond `tolerance + softness`, linear falloff
// between the two -- softness === 0 collapses this to a hard cutoff at
// `tolerance`. Both bounds go through percentToRadius, see its own note.
function matchStrength(r, g, b, keyColor, tolerance, softness) {
  const dist = colorDistance(r, g, b, keyColor);
  const matchDist = percentToRadius(tolerance);
  if (dist <= matchDist) return 1;
  const softDist = percentToRadius(softness);
  if (softDist <= 0) return 0;
  const edge = matchDist + softDist;
  if (dist >= edge) return 0;
  return (edge - dist) / softDist;
}

// mode 'transparent': full-strength match becomes [0,0,0,0] (mirrors the
// eraser tool's own zero-everything convention, see js/ui/tools.js); a
// partial-strength match scales alpha down by (1 - strength) AND
// desaturates the pixel toward its own luminance by that same fraction --
// an edge pixel in the soft band is usually itself a blend of real
// content and key-color bleed-through (anti-aliasing against the
// original background, from before the art was imported here), so
// leaving its RGB untouched would keep a visible tint/halo of the key
// color once composited over something else. Pushing it toward luma
// (spill suppression) removes that colorfulness without needing to know
// which specific hue the key was. mode 'replace': RGB is lerped toward
// replacementColor by strength instead (no separate desaturation needed,
// since replacing already overwrites whatever tint was there); alpha is
// left untouched (a recolor, not a transparency op). Pixels already fully
// transparent are skipped -- nothing to key out, same alpha===0 skip
// convention as quantize.js.
export function chromaKeyBitmap(bmp, { keyColor, tolerance, softness, mode, replacementColor }) {
  const data = new Uint8ClampedArray(bmp.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const strength = matchStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness);
    if (strength <= 0) continue;
    if (mode === 'transparent') {
      if (strength >= 1) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
      else {
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i] = Math.round(data[i] + (luma - data[i]) * strength);
        data[i + 1] = Math.round(data[i + 1] + (luma - data[i + 1]) * strength);
        data[i + 2] = Math.round(data[i + 2] + (luma - data[i + 2]) * strength);
        data[i + 3] = Math.round(data[i + 3] * (1 - strength));
      }
    } else {
      data[i] = Math.round(data[i] + (replacementColor[0] - data[i]) * strength);
      data[i + 1] = Math.round(data[i + 1] + (replacementColor[1] - data[i + 1]) * strength);
      data[i + 2] = Math.round(data[i + 2] + (replacementColor[2] - data[i + 2]) * strength);
    }
  }
  return { width: bmp.width, height: bmp.height, data };
}
