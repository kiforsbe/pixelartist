// Chroma-key filter: removes or recolors pixels close to a chosen key
// color. Pure/immutable like quantize.js -- returns a new bitmap, never
// mutates its input, so callers can diff before/after for undo and reuse
// the same call for a live preview.

const MAX_DISTANCE = Math.sqrt(3 * 255 * 255);

function colorDistance(r, g, b, key) {
  const dr = r - key[0], dg = g - key[1], db = b - key[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

// 1 inside `tolerance` (percent of MAX_DISTANCE), 0 beyond
// `tolerance + softness`, linear falloff between the two -- softness === 0
// collapses this to a hard cutoff at `tolerance`.
function matchStrength(r, g, b, keyColor, tolerance, softness) {
  const dist = colorDistance(r, g, b, keyColor);
  const matchDist = (tolerance / 100) * MAX_DISTANCE;
  if (dist <= matchDist) return 1;
  const softDist = (softness / 100) * MAX_DISTANCE;
  if (softDist <= 0) return 0;
  const edge = matchDist + softDist;
  if (dist >= edge) return 0;
  return (edge - dist) / softDist;
}

// mode 'transparent': full-strength match becomes [0,0,0,0] (mirrors the
// eraser tool's own zero-everything convention, see js/ui/tools.js); a
// partial-strength match scales alpha down by (1 - strength), RGB
// untouched. mode 'replace': RGB is lerped toward replacementColor by
// strength; alpha is left untouched (a recolor, not a transparency op).
// Pixels already fully transparent are skipped -- nothing to key out,
// same alpha===0 skip convention as quantize.js.
export function chromaKeyBitmap(bmp, { keyColor, tolerance, softness, mode, replacementColor }) {
  const data = new Uint8ClampedArray(bmp.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const strength = matchStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness);
    if (strength <= 0) continue;
    if (mode === 'transparent') {
      if (strength >= 1) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
      else data[i + 3] = Math.round(data[i + 3] * (1 - strength));
    } else {
      data[i] = Math.round(data[i] + (replacementColor[0] - data[i]) * strength);
      data[i + 1] = Math.round(data[i + 1] + (replacementColor[1] - data[i + 1]) * strength);
      data[i + 2] = Math.round(data[i + 2] + (replacementColor[2] - data[i + 2]) * strength);
    }
  }
  return { width: bmp.width, height: bmp.height, data };
}
