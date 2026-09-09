// js/core/ramps.js
// Ramp detection over a palette. Pure; no DOM.
//
// A ramp is a maximal run of CONTIGUOUS palette indices where luminance is
// strictly monotonic and adjacent hues stay close. That matches how artists
// actually author palettes -- ramps as contiguous blocks -- and it means a
// shade brush needs to store nothing at all: it re-detects the ramp from the
// pixel under the cursor, so one brush works in every project.

const HUE_TOLERANCE = 45;

export function luminance(c) {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function hue(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return null; // achromatic: matches any hue
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueClose(a, b) {
  const ha = hue(a), hb = hue(b);
  if (ha === null || hb === null) return true; // greys join any ramp
  const d = Math.abs(ha - hb);
  return Math.min(d, 360 - d) <= HUE_TOLERANCE;
}

// Adjacent entries continue a run when luminance keeps moving the same way
// and the hue has not jumped.
function continues(palette, i, direction) {
  if (palette.empty[i] || palette.empty[i - 1]) return false;
  const prev = palette.colors[i - 1], cur = palette.colors[i];
  const delta = luminance(cur) - luminance(prev);
  if (delta === 0) return false;
  if (direction !== 0 && Math.sign(delta) !== direction) return false;
  return hueClose(prev, cur);
}

export function detectRamps(palette) {
  const ramps = [];
  const n = palette.colors.length;
  let start = 0, direction = 0;
  for (let i = 1; i <= n; i++) {
    const ok = i < n && continues(palette, i, direction);
    if (ok) {
      if (direction === 0) {
        direction = Math.sign(luminance(palette.colors[i]) - luminance(palette.colors[i - 1]));
      }
      continue;
    }
    // A ramp needs at least two entries; a lone color is not a ramp.
    if (i - start >= 2) ramps.push(Array.from({ length: i - start }, (_, k) => start + k));
    start = i;
    direction = 0;
  }
  return ramps;
}

function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function rampContaining(palette, rgba, rampName = null) {
  if (rampName) {
    const named = (palette.ramps ?? []).find(r => r.name === rampName);
    if (named) return named.indices;
  }
  for (const ramp of detectRamps(palette)) {
    if (ramp.some(i => sameColor(palette.colors[i], rgba))) return ramp;
  }
  return null;
}

// Moves BETWEEN existing palette entries. It never interpolates, so a ramp
// of four entries has exactly four reachable values.
export function stepAlongRamp(palette, rgba, delta, rampName = null) {
  const ramp = rampContaining(palette, rgba, rampName);
  if (!ramp) return null;
  const at = ramp.findIndex(i => sameColor(palette.colors[i], rgba));
  if (at === -1) return null;
  const next = Math.max(0, Math.min(ramp.length - 1, at + delta));
  const c = palette.colors[ramp[next]];
  return [c[0], c[1], c[2], rgba[3]];
}
