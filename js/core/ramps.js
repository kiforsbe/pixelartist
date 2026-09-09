// js/core/ramps.js
// Ramp detection over a palette. Pure; no DOM.
//
// A ramp is a maximal run of CONTIGUOUS palette indices where luminance is
// strictly monotonic and adjacent hues stay close. That matches how artists
// actually author palettes -- ramps as contiguous blocks -- and it means a
// shade brush needs to store nothing at all: it re-detects the ramp from the
// pixel under the cursor, so one brush works in every project.

import { lumaOf } from './palettes.js';

const HUE_TOLERANCE = 45;

// hue() deliberately does NOT reuse palettes.js's hueOf: hueOf returns -1 for
// an achromatic color (a sentinel that sorts greys first), but the anchor and
// adjacent-hue checks below need to tell "no real hue" apart from "a hue of
// -1 degrees" -- treating grey as -1 would compute a nonsense ~200 degree
// distance against, say, a hue near 180, when the correct answer is that a
// grey is compatible with every hue. `null` makes that "matches anything"
// case explicit instead of an arbitrary angle.
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

function hueDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

function hueClose(a, b) {
  const ha = hue(a), hb = hue(b);
  if (ha === null || hb === null) return true; // greys join any ramp
  return hueDistance(ha, hb) <= HUE_TOLERANCE;
}

// Adjacent entries continue a run when luminance keeps moving the same way
// and the hue has not jumped from the entry right before it (hueClose) NOR
// drifted from the run's own anchor hue (see detectRamps). The anchor check
// is what stops 45 degrees of per-step tolerance from compounding: a chain
// of small adjacent steps can still walk a hue all the way around a wheel,
// so every chromatic entry is also pinned to the hue that opened the run.
function continues(palette, i, direction, anchor) {
  if (palette.empty[i] || palette.empty[i - 1]) return false;
  const prev = palette.colors[i - 1], cur = palette.colors[i];
  const delta = lumaOf(cur) - lumaOf(prev);
  if (delta === 0) return false;
  if (direction !== 0 && Math.sign(delta) !== direction) return false;
  if (!hueClose(prev, cur)) return false;
  const curHue = hue(cur);
  if (curHue !== null && anchor !== null && hueDistance(curHue, anchor) > HUE_TOLERANCE) return false;
  return true;
}

function anchorHue(palette, i) {
  return i < palette.colors.length ? hue(palette.colors[i]) : null;
}

// A run of two grey<->hue entries (or any run with exactly one chromatic
// entry) is not a shading ramp: the "shade" step would jump from a color
// straight to a colorless grey, destroying the hue. A genuine ramp is either
// two or more entries that share a hue family, or a run that is entirely
// achromatic (a real greyscale ramp).
function keepRun(palette, indices) {
  let chromatic = 0;
  for (const i of indices) if (hue(palette.colors[i]) !== null) chromatic++;
  return chromatic === 0 || chromatic >= 2;
}

export function detectRamps(palette) {
  const ramps = [];
  const n = palette.colors.length;
  let start = 0, direction = 0, anchor = anchorHue(palette, 0);
  for (let i = 1; i <= n; i++) {
    const ok = i < n && continues(palette, i, direction, anchor);
    if (ok) {
      if (direction === 0) {
        direction = Math.sign(lumaOf(palette.colors[i]) - lumaOf(palette.colors[i - 1]));
      }
      if (anchor === null) anchor = hue(palette.colors[i]);
      continue;
    }
    // A ramp needs at least two entries; a lone color is not a ramp.
    if (i - start >= 2) {
      const indices = Array.from({ length: i - start }, (_, k) => start + k);
      if (keepRun(palette, indices)) ramps.push(indices);
    }
    start = i;
    direction = 0;
    anchor = anchorHue(palette, start);
  }
  return ramps;
}

function sameColor(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Bounds-checked read: a named ramp's indices can outlive the palette they
// were recorded against (a corrupted save, or a swatch deleted after the
// ramp was created) even though normalizePalette bounds-checks on load --
// this guards the same invariant against in-memory drift so a stale index
// degrades to "not found" rather than throwing.
function colorAt(palette, i) {
  return Number.isInteger(i) && i >= 0 && i < palette.colors.length ? palette.colors[i] : undefined;
}

export function rampContaining(palette, rgba, rampName = null) {
  if (rampName) {
    const named = (palette.ramps ?? []).find(r => r.name === rampName);
    if (named) {
      const isMember = named.indices.some(i => {
        const c = colorAt(palette, i);
        return c !== undefined && sameColor(c, rgba);
      });
      return isMember ? named.indices : null;
    }
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
  const at = ramp.findIndex(i => {
    const c = colorAt(palette, i);
    return c !== undefined && sameColor(c, rgba);
  });
  if (at === -1) return null;
  const next = Math.max(0, Math.min(ramp.length - 1, at + delta));
  const c = colorAt(palette, ramp[next]);
  if (!c) return null;
  return [c[0], c[1], c[2], rgba[3]];
}
