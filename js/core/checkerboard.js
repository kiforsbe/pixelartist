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

// Every colorA/colorB parameter below accepts either a single [r,g,b] or a
// list of them ([[r,g,b], ...]) -- real checkerboards are often not one flat
// pair: a sheet assembled from several separately-exported sprites can bake
// in a different light/dark shade per sprite (confirmed against a real
// asset: distinct flat regions at both #080807 and #272727, both "the dark
// checker color", never a smooth gradient between them). A single anchor +
// tolerance radius can't cover that without widening the radius enough to
// also risk swallowing real dark artwork that never appears in the
// checkerboard at all. Accepting several exact samples per role instead
// lets each one keep a tight tolerance while the role as a whole covers
// every shade the user has actually pointed at.
function toColorList(color) {
  return Array.isArray(color[0]) ? color : [color];
}

function minChannelDist(r, g, b, colors) {
  let best = Infinity;
  for (const c of colors) {
    const d = channelDist(r, g, b, c);
    if (d < best) best = d;
  }
  return best;
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
  const colorsA = toColorList(colorA);
  const colorsB = toColorList(colorB);
  const runLengths = new Map();
  const record = (len) => { if (len >= 2) runLengths.set(len, (runLengths.get(len) ?? 0) + 1); };
  const classify = (r, g, b) => {
    if (minChannelDist(r, g, b, colorsA) <= tolerance) return 1;
    if (minChannelDist(r, g, b, colorsB) <= tolerance) return 2;
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
// two checker cells -- fade out gracefully instead of surviving at full
// opacity as a stray pixel.
function matchStrength(r, g, b, color, tolerance, softness) {
  const dist = channelDist(r, g, b, color);
  if (dist <= tolerance) return 1;
  if (softness <= 0) return 0;
  const edge = tolerance + softness;
  if (dist >= edge) return 0;
  return (edge - dist) / softness;
}

// Best (strongest) match against any color in a role's sample list --
// a pixel only needs to sit close to ONE sampled shade to count as that role.
function maxMatchStrength(r, g, b, colors, tolerance, softness) {
  let best = 0;
  for (const c of colors) {
    const s = matchStrength(r, g, b, c, tolerance, softness);
    if (s > best) best = s;
  }
  return best;
}

// Labels 4-connected components of a boolean mask (iterative flood fill,
// no recursion so it's safe on large bitmaps). Returns { labels, sizes }:
// labels[p] is the component id for a set pixel (-1 if unset), sizes[id] is
// that component's pixel count.
function labelComponents(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack.push(p + w); }
    }
    sizes.push(size);
  }
  return { labels, sizes };
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
// enough to also sweep up anti-aliasing seams that sit between the two
// checker colors: point protectColor at the sprites' own outline/fill
// color and those pixels get shielded instead of eaten alongside the
// background. (Distinct, periodic design-grid guide lines are a separate
// concern -- see detectGuideLines/removeGuideLines below; they're not a
// color near colorA/colorB at all, so widening tolerance/softness here
// can't reach them, and shouldn't try to.)
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
//
// minRegionSize (connectivity gate): a pixel is only removal-eligible if
// the 4-connected blob of checker-colored pixels (isA or isB, either role)
// it belongs to has at least this many pixels. The real background is
// always one sprawling blob spanning much of the sheet; a small enclosed
// detail that merely happens to share a checker shade -- a coal chunk
// inside a grey rock, a shadowed doorway inside a house wall -- forms its
// OWN tiny, isolated blob, walled off on every side by the surrounding
// sprite's non-matching material. No tolerance/windowRadius/minMixFraction
// combination can tell those apart by color+local-neighborhood alone
// (confirmed against a real asset: widening tolerance enough to fully
// clear the checkerboard also swept up ~40% of a coal chunk's pixels, and
// no windowRadius/minMixFraction setting recovered the coal without also
// leaving large patches of real background behind) -- but the enclosed
// detail's blob is reliably much smaller than the background's, so gating
// on component size protects it regardless of how closely its color
// matches. Defaults to an area tied to windowRadius (the size of the
// neighborhood already being trusted to judge "real checkerboard"), so it
// requires no separate tuning in the common case; pass 0 to disable.
export function checkerboardRemoveBitmap(bmp, { colorA, colorB, tolerance = 18, softness = 0, windowRadius = 12, minMixFraction = 0.12, minRegionSize = (windowRadius * 2 + 1) ** 2, mode = 'transparent', replacementColor = [255, 255, 255], protectColor = null, protectTolerance = 0, protectSoftness = 0 }) {
  const colorsA = toColorList(colorA);
  const colorsB = toColorList(colorB);
  const { width: w, height: h } = bmp;
  const src = bmp.data;
  const edge = tolerance + softness;
  const isA = new Uint8Array(w * h);
  const isB = new Uint8Array(w * h);
  const isChecker = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (src[i + 3] === 0) continue;
    const r = src[i], g = src[i + 1], b = src[i + 2];
    if (minChannelDist(r, g, b, colorsA) <= edge) { isA[p] = 1; isChecker[p] = 1; }
    else if (minChannelDist(r, g, b, colorsB) <= edge) { isB[p] = 1; isChecker[p] = 1; }
  }
  const satA = buildIntegral(isA, w, h);
  const satB = buildIntegral(isB, w, h);
  let componentLabels = null, componentSizes = null;
  if (minRegionSize > 0) ({ labels: componentLabels, sizes: componentSizes } = labelComponents(isChecker, w, h));
  const data = new Uint8ClampedArray(src);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (!isA[p] && !isB[p]) continue;
    if (componentLabels && componentSizes[componentLabels[p]] < minRegionSize) continue;
    const x = p % w, y = (p / w) | 0;
    const countA = boxSum(satA, w, h, x, y, windowRadius);
    const countB = boxSum(satB, w, h, x, y, windowRadius);
    const total = countA + countB;
    const minorityCount = isA[p] ? countB : countA;
    if (total === 0 || minorityCount / total < minMixFraction) continue;

    const r = data[i], g = data[i + 1], b = data[i + 2];
    let strength = Math.max(maxMatchStrength(r, g, b, colorsA, tolerance, softness), maxMatchStrength(r, g, b, colorsB, tolerance, softness));
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

// ---- design-grid guide lines -----------------------------------------
//
// Some sheets have thin slot/grid guide lines baked in ON TOP of the
// checkerboard, at a regular pixel interval (e.g. every 57px, marking
// sprite-cell boundaries) -- visually a "grid", but NOT one flat color:
// a guide line is itself semi-transparent/blended over whichever checker
// cell happens to sit underneath at that point, so its apparent color
// varies with the checker phase and can range broadly (confirmed against
// a real file: neighboring guide pixels measured anywhere from ~90 to
// ~190 in luma). Matching it by color at all -- even with a wide
// tolerance -- either misses most of the line or starts eating real
// content of a similar shade. What actually identifies a guide line has
// nothing to do with its color: it's a thin band that recurs at a
// consistent spacing. So this detects PURELY by position: which rows/
// columns are anomalously non-checker, and among those, which ones repeat
// at a regular interval -- then removal only touches near-neutral pixels
// inside the confirmed bands, leaving everything else in the image
// (including the checkerboard's own ordinary per-cell antialiasing noise,
// and all real content) untouched.

// Fraction, per row (axis='row') or column (axis='col'), of near-neutral
// opaque pixels that DON'T match colorA or colorB -- i.e. how much of that
// row/column looks like "not the checkerboard" among the pixels where
// that comparison is meaningful (colorful real content is excluded from
// both the numerator and denominator, so a row through dense, colorful
// art doesn't read as deviant just for being colorful). Positions with
// too little near-neutral coverage to judge (mostly transparent, or
// mostly colorful content) get -1, treated as "not deviant" everywhere
// this is consumed.
function axisDeviation(bitmaps, colorA, colorB, axis, { tolerance = 18, chromaMax = 14, minCoverage = 0.5 } = {}) {
  const colorsA = toColorList(colorA);
  const colorsB = toColorList(colorB);
  const { width: w, height: h } = bitmaps[0];
  const length = axis === 'row' ? h : w;
  const span = axis === 'row' ? w : h;
  const dev = new Float64Array(length).fill(-1);
  for (let pos = 0; pos < length; pos++) {
    let neutral = 0, deviant = 0;
    for (const bmp of bitmaps) {
      const d = bmp.data;
      for (let o = 0; o < span; o++) {
        const x = axis === 'row' ? o : pos, y = axis === 'row' ? pos : o;
        const i = (y * w + x) * 4;
        if (d[i + 3] === 0) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (chroma(r, g, b) > chromaMax) continue;
        neutral++;
        if (minChannelDist(r, g, b, colorsA) > tolerance && minChannelDist(r, g, b, colorsB) > tolerance) deviant++;
      }
    }
    if (neutral >= span * minCoverage) dev[pos] = deviant / neutral;
  }
  return dev;
}

// Groups consecutive positions whose deviation clears `threshold` into
// [start,end] bands (inclusive), skipping the -1 "not enough coverage"
// sentinel same as anything below threshold.
function bandsFromDeviation(dev, threshold) {
  const bands = [];
  let start = null;
  for (let i = 0; i < dev.length; i++) {
    const hit = dev[i] >= threshold;
    if (hit && start === null) start = i;
    if (!hit && start !== null) { bands.push([start, i - 1]); start = null; }
  }
  if (start !== null) bands.push([start, dev.length - 1]);
  return bands;
}

// Finds the most common spacing between EVERY pair of band centers (not
// just consecutive ones) -- a true period shows up far more often than
// any incidental spacing, because it also matches every multiple of
// itself (period, 2x, 3x, ...), whereas one-off content-heavy bands only
// contribute noise scattered across many different spacing values. Ties
// are broken toward the SMALLEST spacing bin (found first, since bins
// are scanned in increasing order below), which favors the base period
// over its own harmonics when both happen to tie. Requires at least 2
// pairs agreeing to avoid calling a single coincidence a "period".
function estimatePeriod(centers, minPeriod) {
  const bins = new Map();
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const d = centers[j] - centers[i];
      if (d < minPeriod) continue;
      const bin = Math.round(d / 3) * 3;
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
    }
  }
  let bestBin = null, bestCount = 0;
  for (const bin of [...bins.keys()].sort((a, b) => a - b)) {
    const count = bins.get(bin);
    if (count > bestCount) { bestCount = count; bestBin = bin; }
  }
  return bestCount >= 2 ? bestBin : null;
}

// Finds the phase offset (0..period-1) that the most band centers sit
// closest to, modulo period -- i.e. where the grid "starts".
function snapPhase(centers, period) {
  let bestOffset = 0, bestScore = -1;
  for (let offset = 0; offset < period; offset++) {
    let score = 0;
    for (const c of centers) {
      const rem = ((c - offset) % period + period) % period;
      if (Math.min(rem, period - rem) <= 3) score++;
    }
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  return bestOffset;
}

// Filters raw deviation bands down to only the ones consistent with a
// confidently-detected period -- rejects one-off rows/columns that just
// happen to be non-checker (e.g. a row that cuts through dense real
// content) without a repeating partner. Requires at least 3 raw bands to
// even attempt a period estimate (two points always trivially "agree").
function confirmPeriodicBands(bandsRaw, minPeriod) {
  if (bandsRaw.length < 3) return [];
  const centers = bandsRaw.map(([a, b]) => (a + b) / 2);
  const period = estimatePeriod(centers, minPeriod);
  if (!period) return [];
  const offset = snapPhase(centers, period);
  const tolerance = Math.max(3, period * 0.15);
  return bandsRaw.filter(([a, b]) => {
    const c = (a + b) / 2;
    const rem = ((c - offset) % period + period) % period;
    return Math.min(rem, period - rem) <= tolerance;
  });
}

// Detects periodic design-grid guide lines independently on each axis.
// windowRadius isn't used here (guide lines don't need a checker-cell-
// sized search window, unlike the main removal pass) -- minPeriod is the
// shortest spacing worth considering a "grid" rather than checkerboard-
// scale noise, and should generally stay well above the checker's own
// cell size. Returns { rowBands, colBands }, each a (possibly empty)
// array of [start,end] pixel ranges.
export function detectGuideLines(bitmaps, colorA, colorB, { tolerance = 18, chromaMax = 14, threshold = 0.7, minCoverage = 0.5, minPeriod = 20 } = {}) {
  const rowDev = axisDeviation(bitmaps, colorA, colorB, 'row', { tolerance, chromaMax, minCoverage });
  const colDev = axisDeviation(bitmaps, colorA, colorB, 'col', { tolerance, chromaMax, minCoverage });
  return {
    rowBands: confirmPeriodicBands(bandsFromDeviation(rowDev, threshold), minPeriod),
    colBands: confirmPeriodicBands(bandsFromDeviation(colDev, threshold), minPeriod),
  };
}

function lerpPixel(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
    Math.round(a[3] + (b[3] - a[3]) * t),
  ];
}

// Removes (or heals) confirmed guide-line bands (see detectGuideLines) --
// ONLY near-neutral pixels (chroma <= chromaMax) inside a row band (full
// width, at those y's) or column band (full height, at those x's) are
// affected; colorful real content is left alone regardless of position,
// and everything outside the confirmed bands is untouched no matter its
// color.
//
// action 'heal' (default): for each affected pixel, look at the nearest
// opaque pixel just OUTSIDE the band on either side (above/below for a
// row band, left/right for a column band -- from `bmp` as passed in, i.e.
// already past the main checkerboard-removal pass) and linearly
// interpolate across the gap. This only fires when BOTH sides are
// TRUSTED opaque content -- exactly the case a plain erase used to leave
// as a visible scratch through a near-neutral icon the guide line
// happened to cross. Where a guide line crosses the checkerboard
// background instead, the main pass has already made those flanking
// pixels transparent, so there's nothing to heal from and it falls back
// to the same erase/replace behavior as action 'erase'.
//
// "Trusted" (pass 1 only, see below) excludes near-neutral pixels that
// are themselves inside a row OR column band -- at a horizontal/vertical
// guide crossing, the pixel just outside one band can still be sitting on
// the OTHER band's own not-yet-resolved raw guide color rather than real
// background/content, since neither pass has resolved it yet. Trusting it
// there would blend two guide-line pixels together into a small colored
// patch instead of leaving what's actually empty checkerboard as
// transparent. A colorful pixel is always trusted regardless of band
// membership, since colorful content is never itself guide-line material
// (see the chromaMax check below).
//
// A genuine intersection over real content would then wrongly fall back
// to erase too, though -- both its row-heal and column-heal neighbors are
// themselves band pixels, so pass 1 can't tell "background under the
// other line" apart from "content under the other line" yet. A second
// pass fixes exactly that ambiguity: it re-attempts healing ONLY for
// pixels pass 1 left un-healed, this time reading neighbors from pass 1's
// OWN output instead of the original pixels -- which by now correctly
// shows either real reconstructed content (if that neighbor turned out to
// sit over content) or transparency (if it turned out to sit over
// background), resolving the ambiguity for free.
//
// action 'erase': the original behavior, unconditionally -- every
// affected pixel is erased/replaced regardless of what's on either side.
// Useful if healing ever guesses wrong, or the guide line's own footprint
// should just become a hole rather than a reconstruction.
//
// protectColor works exactly as in checkerboardRemoveBitmap, scaling how
// much of whichever result (healed or erased) actually gets applied.
//
// healStrength (0-1, default 1): how much of the healed reconstruction to
// use versus the plain erase/replace result, for pixels that DID find a
// heal. A linear 2-point interpolation across a short gap can look
// noticeably smoother/flatter than the dithered or noisy texture of real
// surrounding content -- visible as a faint clean "seam" right where the
// guide line was, even though the color itself matches. Turning this down
// blends that reconstruction toward transparency/replacement instead of
// forcing it to fully commit, which can read as less conspicuous than a
// perfectly clean but slightly-too-smooth patch. 1 = full heal (default,
// same as before this existed); 0 = identical to action 'erase', but only
// for pixels that found a heal (background-crossing pixels that never had
// one to begin with are unaffected either way).
export function removeGuideLines(bmp, { rowBands = [], colBands = [], chromaMax = 14, action = 'heal', healStrength = 1, mode = 'transparent', replacementColor = [255, 255, 255], protectColor = null, protectTolerance = 0, protectSoftness = 0 }) {
  const { width: w, height: h } = bmp;
  const src = bmp.data;
  const rowHit = new Uint8Array(h);
  const rowBandFor = new Int32Array(h).fill(-1);
  rowBands.forEach(([a, b], idx) => { for (let y = a; y <= b; y++) { rowHit[y] = 1; rowBandFor[y] = idx; } });
  const colHit = new Uint8Array(w);
  const colBandFor = new Int32Array(w).fill(-1);
  colBands.forEach(([a, b], idx) => { for (let x = a; x <= b; x++) { colHit[x] = 1; colBandFor[x] = idx; } });

  const pixelAt = (source, x, y) => { const i = (y * w + x) * 4; return [source[i], source[i + 1], source[i + 2], source[i + 3]]; };
  const trustedPass1 = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const px = pixelAt(src, x, y);
    if (px[3] === 0) return null;
    if (chroma(px[0], px[1], px[2]) > chromaMax) return px;
    return (rowHit[y] || colHit[x]) ? null : px;
  };

  function healAttempt(x, y, trustFn) {
    if (rowHit[y]) {
      const [a, bEnd] = rowBands[rowBandFor[y]];
      const above = trustFn(x, a - 1), below = trustFn(x, bEnd + 1);
      if (above && below) return lerpPixel(above, below, (y - a + 1) / (bEnd - a + 2));
    }
    if (colHit[x]) {
      const [a, bEnd] = colBands[colBandFor[x]];
      const left = trustFn(a - 1, y), right = trustFn(bEnd + 1, y);
      if (left && right) return lerpPixel(left, right, (x - a + 1) / (bEnd - a + 2));
    }
    return null;
  }

  const data = new Uint8ClampedArray(src);
  // The plain erase/replace result at the given protectColor strength --
  // used directly when there's no heal, and as the blend-toward target
  // when healStrength < 1 for a pixel that DID find one.
  function fallbackTarget(r, g, b, a, strength) {
    if (mode === 'transparent') {
      if (strength >= 1) return [0, 0, 0, 0];
      const l = luma(r, g, b);
      return [Math.round(r + (l - r) * strength), Math.round(g + (l - g) * strength), Math.round(b + (l - b) * strength), Math.round(a * (1 - strength))];
    }
    return [Math.round(r + (replacementColor[0] - r) * strength), Math.round(g + (replacementColor[1] - g) * strength), Math.round(b + (replacementColor[2] - b) * strength), a];
  }
  function applyResult(x, y, r, g, b, a, strength, healed) {
    const i = (y * w + x) * 4;
    const fallback = fallbackTarget(r, g, b, a, strength);
    if (!healed) { data[i] = fallback[0]; data[i + 1] = fallback[1]; data[i + 2] = fallback[2]; data[i + 3] = fallback[3]; return; }
    const healedApplied = [
      Math.round(r + (healed[0] - r) * strength),
      Math.round(g + (healed[1] - g) * strength),
      Math.round(b + (healed[2] - b) * strength),
      Math.round(a + (healed[3] - a) * strength),
    ];
    const out = healStrength >= 1 ? healedApplied : lerpPixel(fallback, healedApplied, healStrength);
    data[i] = out[0]; data[i + 1] = out[1]; data[i + 2] = out[2]; data[i + 3] = out[3];
  }

  const stillNeedsHeal = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!rowHit[y] && !colHit[x]) continue;
      const i = (y * w + x) * 4;
      const a = src[i + 3];
      if (a === 0) continue;
      const r = src[i], g = src[i + 1], b = src[i + 2];
      if (chroma(r, g, b) > chromaMax) continue;
      let strength = 1;
      if (protectColor) {
        strength = 1 - matchStrength(r, g, b, protectColor, protectTolerance, protectSoftness);
        if (strength <= 0) continue;
      }
      const healed = action === 'heal' ? healAttempt(x, y, trustedPass1) : null;
      applyResult(x, y, r, g, b, a, strength, healed);
      if (action === 'heal' && !healed) stillNeedsHeal.push([x, y, r, g, b, a, strength]);
    }
  }

  if (stillNeedsHeal.length) {
    const trustedPass2 = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const px = pixelAt(data, x, y);
      return px[3] === 0 ? null : px;
    };
    for (const [x, y, r, g, b, a, strength] of stillNeedsHeal) {
      const healed = healAttempt(x, y, trustedPass2);
      if (healed) applyResult(x, y, r, g, b, a, strength, healed);
    }
  }

  return { width: w, height: h, data };
}
