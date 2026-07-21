// Checkerboard-background remover: some sources (AI image generators in
// particular) bake the "transparent" checker pattern into opaque RGB
// pixels instead of emitting real alpha. The pattern is rarely on a
// perfectly regular pixel grid once it's passed through generation/resize
// (see estimateCheckerCellSize's own note), so this does NOT assume a rigid
// global cell size/offset the way a synthetic checkerboard would allow.
// Instead it classifies each pixel locally: a checker pixel sits inside a
// small neighborhood that also contains a meaningful share of the OTHER
// checker color (that's what "checkered" means -- fine alternation), while
// real art of the same flat grey/white only ever sees itself in that
// neighborhood.

function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
function chroma(r, g, b) { return Math.max(r, g, b) - Math.min(r, g, b); }

// Chebyshev (max-channel) distance -- cheap, and matches how tolerance
// already reads intuitively for a near-grey color ("every channel within
// N of the target").
function channelDist(r, g, b, color) {
  return Math.max(Math.abs(r - color[0]), Math.abs(g - color[1]), Math.abs(b - color[2]));
}

// Scans opaque, near-neutral (low chroma) pixels across the given bitmaps
// and finds the two most common luma levels, provided they're far enough
// apart to plausibly be a light/dark checker pair rather than noise around
// one flat color. Returns { colorA, colorB } (colorA the lighter one) or
// null if no confident pair was found -- callers should fall back to
// letting the user pick both colors by hand (mirrors chroma key's own
// key-color picker).
export function detectCheckerboardColors(bitmaps, { chromaMax = 14, minSeparation = 30, binSize = 4 } = {}) {
  const bins = new Map();
  for (const bmp of bitmaps) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (chroma(r, g, b) > chromaMax) continue;
      const bin = Math.min(255, Math.round(luma(r, g, b) / binSize) * binSize);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
  }
  const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return null;
  const [lumaA] = sorted[0];
  const second = sorted.find(([l]) => Math.abs(l - lumaA) >= minSeparation);
  if (!second) return null;
  const lumaB = second[0];
  const lo = Math.min(lumaA, lumaB), hi = Math.max(lumaA, lumaB);
  return { colorA: [hi, hi, hi], colorB: [lo, lo, lo] };
}

// Estimates the checker cell size in pixels by measuring run-lengths of
// consecutive same-color (colorA-ish or colorB-ish) pixels along sampled
// rows and columns -- a true checker cell of size N produces runs of ~N
// pixels every time the scan crosses a cell boundary, and that run length
// is by far the most common one wherever the checkerboard covers much of
// the image, so the mode of the run-length histogram is a robust estimate
// even with the wobble real-world (non-pixel-perfect) checkers show. This
// exists because checkerboardRemoveBitmap's windowRadius must reach at
// least half a cell's width to see the OTHER color from a cell's own
// center -- a fixed radius tuned for one file's cell size silently leaves
// islands of un-removed checker at the center of another file's larger
// cells (that's exactly what motivated this function, see the dedicated
// test below). Returns null if no confident estimate could be made.
export function estimateCheckerCellSize(bitmaps, colorA, colorB, { tolerance = 18, sampleStride = 7 } = {}) {
  const runLengths = new Map();
  const record = (len) => { if (len >= 2) runLengths.set(len, (runLengths.get(len) ?? 0) + 1); };
  const classify = (r, g, b) => {
    if (channelDist(r, g, b, colorA) <= tolerance) return 1;
    if (channelDist(r, g, b, colorB) <= tolerance) return 2;
    return 0;
  };
  for (const bmp of bitmaps) {
    const { width: w, height: h, data: d } = bmp;
    for (let y = 0; y < h; y += sampleStride) {
      let runClass = 0, runLen = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const cls = d[i + 3] === 0 ? 0 : classify(d[i], d[i + 1], d[i + 2]);
        if (cls !== 0 && cls === runClass) runLen++;
        else { record(runLen); runClass = cls; runLen = cls === 0 ? 0 : 1; }
      }
      record(runLen);
    }
    for (let x = 0; x < w; x += sampleStride) {
      let runClass = 0, runLen = 0;
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        const cls = d[i + 3] === 0 ? 0 : classify(d[i], d[i + 1], d[i + 2]);
        if (cls !== 0 && cls === runClass) runLen++;
        else { record(runLen); runClass = cls; runLen = cls === 0 ? 0 : 1; }
      }
      record(runLen);
    }
  }
  if (runLengths.size === 0) return null;
  let bestLen = 0, bestCount = 0;
  for (const [len, count] of runLengths) if (count > bestCount) { bestCount = count; bestLen = len; }
  return bestLen;
}

// Builds a 2D summed-area table (1-indexed, (w+1)x(h+1)) from a boolean
// mask so any axis-aligned box's pixel count is 4 lookups + O(1) math.
function buildIntegral(mask, w, h) {
  const sat = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += mask[y * w + x];
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return sat;
}

function boxSum(sat, w, h, cx, cy, radius) {
  const x0 = Math.max(0, cx - radius), y0 = Math.max(0, cy - radius);
  const x1 = Math.min(w, cx + radius + 1), y1 = Math.min(h, cy + radius + 1);
  return sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
}

// 1 inside `tolerance`, 0 beyond `tolerance + softness`, linear falloff
// between the two -- softness === 0 collapses this to a hard cutoff at
// `tolerance` (mirrors chromaKeyBitmap's own matchStrength). Feathering
// this instead of using a hard cutoff is what lets a pixel just outside
// the strict tolerance -- a common spot for the anti-aliased seam between
// two checker cells, or between a checker cell and a design grid line --
// fade out gracefully instead of surviving at full opacity as a stray
// pixel.
function matchStrength(r, g, b, color, tolerance, softness) {
  const dist = channelDist(r, g, b, color);
  if (dist <= tolerance) return 1;
  if (softness <= 0) return 0;
  const edge = tolerance + softness;
  if (dist >= edge) return 0;
  return (edge - dist) / softness;
}

// Removes (or recolors) checkerboard-background pixels. A pixel's removal
// strength comes from how closely it matches colorA/colorB (tolerance +
// feathered softness, see matchStrength), but it's only applied at all
// when the pixel's local windowRadius neighborhood also contains at least
// minMixFraction of the OTHER checker color -- that mix requirement is
// what lets a real flat white/grey/black UI element or outline survive
// untouched, since a solid fill never sees the other checker shade nearby.
// Neighborhood membership (isA/isB) uses the full tolerance+softness band
// so a stray pixel just past tolerance still counts as "part of the
// checkerboard region" for the mix test, even though its own removal
// strength (via matchStrength) fades out gradually rather than snapping
// straight to full removal at that same edge.
//
// protectColor (optional): a second reference color whose own match
// strength (protectTolerance/protectSoftness) SCALES DOWN the removal
// strength before it's applied, instead of overriding it outright -- the
// same shielding mechanism chromaKeyBitmap uses for outline protection.
// This is what makes it safe to push tolerance/softness aggressively
// enough to also sweep up stray design-grid lines or anti-aliasing seams
// that sit between the two checker colors: point protectColor at the
// sprites' own outline/fill color and those pixels get shielded instead of
// eaten alongside the background.
//
// mode 'transparent': full-strength match zeroes RGBA (mirrors the eraser
// tool's convention); a partial match scales alpha down by (1 - strength)
// and desaturates the pixel toward its own luminance by that same fraction
// (spill suppression, exactly as chromaKeyBitmap does, for the same
// reason: a partially-matched pixel is itself a color blend with the
// checker, and leaving its RGB alone would keep a visible checker-color
// tint once composited over something else). mode 'replace': RGB is
// lerped toward replacementColor by strength instead, alpha left
// untouched.
export function checkerboardRemoveBitmap(bmp, { colorA, colorB, tolerance = 18, softness = 0, windowRadius = 12, minMixFraction = 0.12, mode = 'transparent', replacementColor = [255, 255, 255], protectColor = null, protectTolerance = 0, protectSoftness = 0 }) {
  const { width: w, height: h } = bmp;
  const src = bmp.data;
  const edge = tolerance + softness;
  const isA = new Uint8Array(w * h);
  const isB = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (src[i + 3] === 0) continue;
    const r = src[i], g = src[i + 1], b = src[i + 2];
    if (channelDist(r, g, b, colorA) <= edge) isA[p] = 1;
    else if (channelDist(r, g, b, colorB) <= edge) isB[p] = 1;
  }
  const satA = buildIntegral(isA, w, h);
  const satB = buildIntegral(isB, w, h);
  const data = new Uint8ClampedArray(src);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (!isA[p] && !isB[p]) continue;
    const x = p % w, y = (p / w) | 0;
    const countA = boxSum(satA, w, h, x, y, windowRadius);
    const countB = boxSum(satB, w, h, x, y, windowRadius);
    const total = countA + countB;
    const minorityCount = isA[p] ? countB : countA;
    if (total === 0 || minorityCount / total < minMixFraction) continue;

    const r = data[i], g = data[i + 1], b = data[i + 2];
    let strength = Math.max(matchStrength(r, g, b, colorA, tolerance, softness), matchStrength(r, g, b, colorB, tolerance, softness));
    if (strength <= 0) continue;
    if (protectColor) {
      const protectStrength = matchStrength(r, g, b, protectColor, protectTolerance, protectSoftness);
      strength *= (1 - protectStrength);
      if (strength <= 0) continue;
    }

    if (mode === 'transparent') {
      if (strength >= 1) { data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 0; }
      else {
        const l = luma(r, g, b);
        data[i] = Math.round(r + (l - r) * strength);
        data[i + 1] = Math.round(g + (l - g) * strength);
        data[i + 2] = Math.round(b + (l - b) * strength);
        data[i + 3] = Math.round(data[i + 3] * (1 - strength));
      }
    } else {
      data[i] = Math.round(r + (replacementColor[0] - r) * strength);
      data[i + 1] = Math.round(g + (replacementColor[1] - g) * strength);
      data[i + 2] = Math.round(b + (replacementColor[2] - b) * strength);
    }
  }
  return { width: w, height: h, data };
}
