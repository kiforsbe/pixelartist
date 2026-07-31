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

export const MAX_DISTANCE = 300; // calibration reference for percentToRadius, see its own note

function rgbToYCbCr(r, g, b) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b,
  };
}

function yCbCrToRgb(y, cb, cr) {
  return [
    y + 1.402 * cr,
    y - 0.344136 * cb - 0.714136 * cr,
    y + 1.772 * cb,
  ];
}

// Euclidean distance in YCbCr space, with Y (luminance) scaled down by
// lumaWeight before squaring -- lumaWeight is 1 for a fully neutral key
// (grays can only be told apart by luminance, so it needs full weight,
// which also makes this degrade gracefully toward a plain-RGB-ish
// distance for a black/white background) down to 0.35 for a fully
// saturated key. This retains enough brightness discrimination to avoid
// consuming differently-lit art that happens to share the backdrop hue.
// chromaMagnitude
// (0 for any gray, ~135 for a fully saturated primary/secondary color)
// is what decides where a given key falls on that scale.
export function colorDistance(r, g, b, keyColor) {
  const p = rgbToYCbCr(r, g, b);
  const k = rgbToYCbCr(keyColor[0], keyColor[1], keyColor[2]);
  const keySaturation = Math.min(1, Math.sqrt(k.cb * k.cb + k.cr * k.cr) / 100);
  const lumaWeight = 1 - 0.65 * keySaturation;
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
export function percentToRadius(percent) {
  const t = Math.max(0, Math.min(100, percent)) / 100;
  return t * t * MAX_DISTANCE;
}

// 1 inside `tolerance`, 0 beyond `tolerance + softness`, linear falloff
// between the two -- softness === 0 collapses this to a hard cutoff at
// `tolerance`. Both bounds go through percentToRadius, see its own note.
function strengthAtDistance(dist, tolerance, softness) {
  const matchDist = percentToRadius(tolerance);
  if (dist <= matchDist) return 1;
  const softDist = percentToRadius(softness);
  if (softDist <= 0) return 0;
  const edge = matchDist + softDist;
  if (dist >= edge) return 0;
  return (edge - dist) / softDist;
}

function matchStrength(r, g, b, keyColor, tolerance, softness) {
  return strengthAtDistance(colorDistance(r, g, b, keyColor), tolerance, softness);
}

function shadowHueStrength(r, g, b, keyColor, _tolerance, softness) {
  const p = rgbToYCbCr(r, g, b);
  const k = rgbToYCbCr(keyColor[0], keyColor[1], keyColor[2]);
  const pMagnitude = Math.hypot(p.cb, p.cr);
  const kMagnitude = Math.hypot(k.cb, k.cr);
  // A dark shadow has less chroma magnitude than the bright backdrop but
  // points in the same Cb/Cr direction.  Compare that direction, not its
  // magnitude; otherwise the useful softness band vanishes as the shadow
  // darkens.  Near-neutral pixels carry no dependable hue and stay out.
  if (pMagnitude < 4 || kMagnitude < 4) return 0;
  const unitDistance = Math.hypot(p.cb / pMagnitude - k.cb / kMagnitude, p.cr / pMagnitude - k.cr / kMagnitude);
  return strengthAtDistance(unitDistance * (MAX_DISTANCE / 2), 0, softness);
}

// Estimate how much of a soft, key-hued pixel is still background.  This is
// deliberately separate from hue similarity: a dark magenta shadow may point
// exactly along the key hue, yet contain only a small share of the bright
// magenta backdrop.  Removing that estimated share leaves a translucent dark
// shadow instead of an opaque grey stain.
function shadowBackgroundShare(r, g, b, keyColor, hueStrength) {
  const keyEnergy = keyColor[0] ** 2 + keyColor[1] ** 2 + keyColor[2] ** 2;
  if (keyEnergy === 0) return 0;
  const projection = (r * keyColor[0] + g * keyColor[1] + b * keyColor[2]) / keyEnergy;
  return Math.max(0, Math.min(1, projection * hueStrength));
}

// Buckets pixel counts by distance-to-referenceColor across one or more
// bitmaps (opaque pixels only, mirrors chromaKeyBitmap's own alpha===0
// skip) -- feeds the Chroma Key dialog's live distance histogram, which
// shows where the region's actual colors sit relative to the current
// tolerance/softness band instead of leaving that to guesswork. `buckets`
// spans evenly over 0..MAX_DISTANCE.
export function distanceHistogram(bitmaps, referenceColor, buckets = 64) {
  const counts = new Uint32Array(buckets);
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const dist = colorDistance(d[i], d[i + 1], d[i + 2], referenceColor);
      const bucket = Math.min(buckets - 1, Math.floor((dist / MAX_DISTANCE) * buckets));
      counts[bucket]++;
    }
  }
  return { counts, maxDistance: MAX_DISTANCE };
}

// mode 'transparent': full-strength match becomes [0,0,0,0] (mirrors the
// eraser tool's own zero-everything convention, see js/ui/tools.js); a
// partial-strength match treats `strength` as the estimated background
// share: alpha retains only the remaining foreground share, and RGB is
// un-mixed from the key color. This removes key-colored fringe in a single
// pass instead of merely desaturating it and requiring repeat filtering.
// mode 'replace': RGB is lerped toward replacementColor by strength instead.
// mode 'despill' subtracts only the selected key hue's chroma component while
// retaining alpha, luminance, and chroma unrelated to the key. This keeps a
// useful dark/soft shadow without its colored contamination. Pixels already
// fully transparent are skipped -- nothing to key out, same alpha===0 skip
// convention as quantize.js.
//
// protectColor (optional): a second reference color whose own match
// strength (same tolerance/softness-style matching, via
// protectTolerance/protectSoftness) SCALES DOWN the key's effect before
// it's applied, instead of overriding it outright -- a pixel that's
// close to both the key and the protect color (a classic case: an
// anti-aliased edge between a colored background and a black outline,
// which is itself a blend of the two) gets proportionally shielded
// rather than either fully keyed or left with a hard, visible boundary.
// Left out (null/undefined) entirely skips this, unchanged from before
// protect-color existed.
//
// backgroundOnly limits keying to matching pixels connected (4-way) to the
// bitmap edge. It protects same-colored art enclosed by the subject, while
// global matching remains available for enclosed background holes.
function edgeConnectedMatches(bmp, keyColor, tolerance, softness, includeSoftShadows) {
  const { width, height, data } = bmp;
  const matches = new Uint8Array(width * height);
  const traversable = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Existing transparency is already known background, so it must bridge
    // from the image edge to a detached colored halo around the artwork.
    if (data[i + 3] === 0) { traversable[p] = 1; continue; }
    const matchesKey = matchStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness) > 0;
    const matchesShadow = includeSoftShadows && shadowHueStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness) > 0;
    if (matchesKey || matchesShadow) {
      matches[p] = 1;
      traversable[p] = 1;
    }
  }

  const connected = new Uint8Array(matches.length);
  const queue = new Int32Array(matches.length);
  let head = 0, tail = 0;
  const add = (p) => {
    if (!traversable[p] || connected[p]) return;
    connected[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width, y = Math.floor(p / width);
    if (x > 0) add(p - 1);
    if (x + 1 < width) add(p + 1);
    if (y > 0) add(p - width);
    if (y + 1 < height) add(p + width);
  }
  // Transparent pixels are traversed only as bridges; only actual key matches
  // are eligible for modification by the caller.
  for (let p = 0; p < connected.length; p++) connected[p] &= matches[p];
  return connected;
}

export function chromaKeyBitmap(bmp, { keyColor, tolerance, softness, mode, replacementColor, protectColor = null, protectTolerance = 0, protectSoftness = 0, backgroundOnly = false, preserveSoftShadows = false }) {
  const data = new Uint8ClampedArray(bmp.data);
  const keepSoftShadows = mode === 'transparent' && backgroundOnly && preserveSoftShadows;
  const connected = backgroundOnly ? edgeConnectedMatches(bmp, keyColor, tolerance, softness, keepSoftShadows) : null;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    if (connected && !connected[i / 4]) continue;
    let strength = matchStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness);
    const softShadowStrength = keepSoftShadows
      ? shadowHueStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, softness)
      : 0;
    const softShadow = keepSoftShadows
      && matchStrength(data[i], data[i + 1], data[i + 2], keyColor, tolerance, 0) === 0
      && softShadowStrength > 0;
    // The normal soft match may be weak solely because brightness changed.
    // For a preserved shadow, estimate its actual background share from its
    // key-hue projection so it becomes a translucent shadow, not opaque grey.
    if (softShadow) strength = shadowBackgroundShare(data[i], data[i + 1], data[i + 2], keyColor, softShadowStrength);
    if (strength <= 0) continue;
    if (protectColor) {
      const protectStrength = matchStrength(data[i], data[i + 1], data[i + 2], protectColor, protectTolerance, protectSoftness);
      strength *= (1 - protectStrength);
      if (strength <= 0) continue;
    }
    // In background-only matte mode, the soft band represents a colored
    // shadow/fringe rather than solid background. Neutralize it without
    // thinning its alpha; only the hard tolerance core becomes transparent.
    if (mode === 'transparent') {
      if (strength >= 1) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
      else {
        const foregroundShare = 1 - strength;
        const unmix = (channel, keyChannel) => Math.max(0, Math.min(255,
          Math.round((channel - strength * keyChannel) / foregroundShare)));
        data[i] = unmix(data[i], keyColor[0]);
        data[i + 1] = unmix(data[i + 1], keyColor[1]);
        data[i + 2] = unmix(data[i + 2], keyColor[2]);
        data[i + 3] = Math.round(data[i + 3] * foregroundShare);
      }
    } else if (mode === 'replace') {
      data[i] = Math.round(data[i] + (replacementColor[0] - data[i]) * strength);
      data[i + 1] = Math.round(data[i + 1] + (replacementColor[1] - data[i + 1]) * strength);
      data[i + 2] = Math.round(data[i + 2] + (replacementColor[2] - data[i + 2]) * strength);
    } else { // 'despill' or a preserved soft shadow
      const pixel = rgbToYCbCr(data[i], data[i + 1], data[i + 2]);
      const key = rgbToYCbCr(keyColor[0], keyColor[1], keyColor[2]);
      const keyChromaSquared = key.cb * key.cb + key.cr * key.cr;
      if (keyChromaSquared > 0) {
        // Remove only the component pointing in the key hue's chroma
        // direction; a red/gold foreground near a magenta shadow retains the
        // chroma orthogonal to that magenta direction instead of going grey.
        const projection = Math.max(0, (pixel.cb * key.cb + pixel.cr * key.cr) / keyChromaSquared) * strength;
        const rgb = yCbCrToRgb(pixel.y, pixel.cb - key.cb * projection, pixel.cr - key.cr * projection);
        data[i] = Math.round(Math.max(0, Math.min(255, rgb[0])));
        data[i + 1] = Math.round(Math.max(0, Math.min(255, rgb[1])));
        data[i + 2] = Math.round(Math.max(0, Math.min(255, rgb[2])));
      }
    }
  }
  return { width: bmp.width, height: bmp.height, data };
}
