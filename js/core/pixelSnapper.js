// Port of Sprite Fusion's pixel-snapper (github.com/Hugo-Dz/spritefusion-
// pixel-snapper, src/lib.rs) -- detects the implicit pixel grid of a
// downscaled-with-artifacts or photographed pixel-art image and snaps it
// back to its true resolution. Used for pasted/imported images (see
// document-controller.js's document.importSheet and components/canvas/float-session.js's
// pasteSystemImage), both DOM-free/pure like the rest of js/core/.
//
// Pipeline (mirrors process_image_common in the Rust source):
//   1. quantizeKMeans  -- reduce to `kColors` clusters (k-means++ init,
//      Lloyd's iteration) so gradient edges used for grid detection aren't
//      swamped by photographic noise/anti-aliasing.
//   2. computeProfiles -- per-column/per-row gradient-magnitude projections
//      of the quantized image (candidate grid-line positions spike here).
//   3. estimateStepSize -- median spacing between clean profile peaks, per
//      axis.
//   4. resolveStepSizes -- reconcile the two axes (average, or fall back to
//      one axis / a size-based default if they disagree or are missing).
//   5. walk -- an elastic walker: starting at 0, step by the estimated
//      size each time, snapping to the strongest nearby gradient peak
//      within a search window (falls back to the raw step position when no
//      peak is strong enough).
//   6. stabilizeBothAxes -- cross-validates each axis's cut spacing against
//      its sibling axis, re-snapping to a uniform grid when an axis has too
//      few cuts or its step size is wildly different from the other axis's.
//   7. resample -- one output pixel per grid cell, the majority ("mode")
//      color of the quantized image's pixels within that cell.
//   8. applyPalette (optional) -- remaps every resampled pixel to its
//      nearest color in a target palette (this app defaults that palette to
//      the project's current active palette; see js/core/model.js's
//      activePaletteColors()).
//
// Deliberately NOT ported: pixel_size_override validation, CLI/batch/WASM
// plumbing, palette hex parsing (this app already has real palette objects,
// not hex strings) -- none of that applies once this app is calling in
// directly with decoded bitmaps.
//
// The k-means++ centroid seeding uses a seeded PRNG (mulberry32) for
// deterministic-but-reproducible results -- it is NOT bit-compatible with
// the reference implementation's ChaCha8Rng; only the k-means++ ALGORITHM
// (D²-weighted centroid sampling) is ported, not RNG output parity.

import { getPixel, setPixel, createBitmap } from './pixels.js';

// Matches the reference implementation's MAX_PALETTE_COLORS -- a
// deliberately generous quantization budget for "no target palette
// selected" callers (see core/project-pixel-snapper.js), so the
// snapped output keeps close to full RGB fidelity instead of being forced
// through the default 16-cluster budget meant for pre-palette noise
// smoothing.
export const MAX_PALETTE_COLORS = 256;

export const DEFAULT_PIXEL_SNAPPER_CONFIG = {
  kColors: 16,
  maxKmeansIterations: 15,
  peakThresholdMultiplier: 0.2,
  peakDistanceFilter: 4,
  walkerSearchWindowRatio: 0.35,
  walkerMinSearchWindow: 2.0,
  walkerStrengthThreshold: 0.5,
  minCutsPerAxis: 4,
  fallbackTargetSegments: 64,
  maxStepRatio: 1.8,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distSq3(p, c) {
  const dr = p[0] - c[0], dg = p[1] - c[1], db = p[2] - c[2];
  return dr * dr + dg * dg + db * db;
}

// K-means clustering (k-means++ seeded init + Lloyd's iteration) over a
// bitmap's opaque pixels, quantizing every pixel to its nearest final
// centroid. Fully-transparent pixels pass through unchanged. Mirrors
// quantize_image.
export function quantizeKMeans(bmp, kColorsWanted, seed = 42, maxIterations = DEFAULT_PIXEL_SNAPPER_CONFIG.maxKmeansIterations) {
  const { width, height, data } = bmp;
  const opaque = [];
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0) continue;
    opaque.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }
  const n = opaque.length;
  if (n === 0) return { width, height, data: new Uint8ClampedArray(data) };

  const rand = mulberry32(seed);
  const k = Math.min(kColorsWanted, n);

  const centroids = [[...opaque[Math.floor(rand() * n)]]];
  const distances = new Float64Array(n).fill(Infinity);

  for (let ci = 1; ci < k; ci++) {
    const last = centroids[centroids.length - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = distSq3(opaque[i], last);
      if (d < distances[i]) distances[i] = d;
      sum += distances[i];
    }
    if (sum <= 0) {
      centroids.push([...opaque[Math.floor(rand() * n)]]);
    } else {
      let r = rand() * sum;
      let idx = n - 1;
      for (let i = 0; i < n; i++) {
        r -= distances[i];
        if (r <= 0) { idx = i; break; }
      }
      centroids.push([...opaque[idx]]);
    }
  }

  let prev = centroids.map(c => [...c]);
  for (let iter = 0; iter < maxIterations; iter++) {
    const sums = Array.from({ length: k }, () => [0, 0, 0]);
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) {
      let bestK = 0, bestD = Infinity;
      for (let ci = 0; ci < k; ci++) {
        const d = distSq3(opaque[i], centroids[ci]);
        if (d < bestD) { bestD = d; bestK = ci; }
      }
      sums[bestK][0] += opaque[i][0]; sums[bestK][1] += opaque[i][1]; sums[bestK][2] += opaque[i][2];
      counts[bestK]++;
    }
    for (let ci = 0; ci < k; ci++) {
      if (counts[ci] > 0) {
        centroids[ci] = [sums[ci][0] / counts[ci], sums[ci][1] / counts[ci], sums[ci][2] / counts[ci]];
      }
    }
    if (iter > 0) {
      let maxMove = 0;
      for (let ci = 0; ci < k; ci++) {
        const m = distSq3(centroids[ci], prev[ci]);
        if (m > maxMove) maxMove = m;
      }
      if (maxMove < 0.01) break;
    }
    prev = centroids.map(c => [...c]);
  }

  const out = createBitmap(width, height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    if (a === 0) {
      out.data[i * 4] = data[i * 4]; out.data[i * 4 + 1] = data[i * 4 + 1];
      out.data[i * 4 + 2] = data[i * 4 + 2]; out.data[i * 4 + 3] = 0;
      continue;
    }
    const p = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    let bestD = Infinity, bestC = p;
    for (const c of centroids) {
      const d = distSq3(p, c);
      if (d < bestD) { bestD = d; bestC = c; }
    }
    out.data[i * 4] = Math.round(bestC[0]);
    out.data[i * 4 + 1] = Math.round(bestC[1]);
    out.data[i * 4 + 2] = Math.round(bestC[2]);
    out.data[i * 4 + 3] = a;
  }
  return out;
}

// Per-column/per-row gradient-magnitude projections ([-1,0,1] kernel over
// the grayscale image, 0.299/0.587/0.114 luma weights). Transparent pixels
// read as grayscale 0. Mirrors compute_profiles.
export function computeProfiles(bmp) {
  const { width: w, height: h, data } = bmp;
  if (w < 3 || h < 3) throw new Error('Image too small (minimum 3x3)');
  const colProj = new Array(w).fill(0);
  const rowProj = new Array(h).fill(0);
  const gray = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i + 3] === 0 ? 0 : 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w - 1; x++) colProj[x] += Math.abs(gray(x + 1, y) - gray(x - 1, y));
  }
  for (let x = 0; x < w; x++) {
    for (let y = 1; y < h - 1; y++) rowProj[y] += Math.abs(gray(x, y + 1) - gray(x, y - 1));
  }
  return { colProj, rowProj };
}

// Median spacing between clean (distance-filtered) local-maxima peaks of a
// profile; null when there aren't at least 2 usable peaks. Mirrors
// estimate_step_size, with one deliberate deviation: peaks are detected as
// PLATEAUS (a maximal run of equal values strictly higher than the values
// immediately outside the run), not single points requiring strict `>` on
// both immediate neighbors. The reference implementation's literal
// single-point check misses a very common case for this app specifically:
// a cleanly nearest-neighbor-scaled (no anti-aliasing) pixel-art image --
// exactly what re-pasting/re-importing already-exported pixel art looks
// like -- produces an EXACT tie between the two samples straddling every
// sharp edge (the [-1,0,1] kernel responds identically on both sides of a
// flat step), so the strict version finds zero peaks and the whole
// pipeline falls back to step=1 (no snapping at all). Plateau detection
// still finds the single-point peaks the original algorithm found
// (a plateau of width 1 behaves identically), so this only ADDS detection
// for the tied case, it never removes a peak the original would have kept.
export function estimateStepSize(profile, config) {
  if (profile.length === 0) return null;
  let maxVal = 0;
  for (const v of profile) if (v > maxVal) maxVal = v;
  if (maxVal === 0) return null;
  const threshold = maxVal * config.peakThresholdMultiplier;

  const peaks = [];
  let i = 1;
  while (i < profile.length - 1) {
    if (profile[i] <= threshold || profile[i] < profile[i - 1]) { i++; continue; }
    let j = i;
    while (j + 1 < profile.length && profile[j + 1] === profile[i]) j++;
    // valid only if the plateau doesn't run off the right edge -- mirrors
    // the original's `i in 1..len-2` bound, which always has a real
    // profile[i+1] to compare against.
    if (j < profile.length - 1 && profile[i] > profile[i - 1] && profile[i] > profile[j + 1]) {
      peaks.push(Math.floor((i + j) / 2));
    }
    i = j + 1;
  }
  if (peaks.length < 2) return null;

  const cleanPeaks = [peaks[0]];
  for (let j = 1; j < peaks.length; j++) {
    if (peaks[j] - cleanPeaks[cleanPeaks.length - 1] > config.peakDistanceFilter - 1) cleanPeaks.push(peaks[j]);
  }
  if (cleanPeaks.length < 2) return null;

  const diffs = [];
  for (let j = 1; j < cleanPeaks.length; j++) diffs.push(cleanPeaks[j] - cleanPeaks[j - 1]);
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

// Reconciles the two axes' estimated step sizes into one shared (stepX,
// stepY) pair -- an explicit override wins outright; two disagreeing
// estimates average (or fall back to the smaller one if they're wildly
// skewed); a missing axis borrows its sibling's; both missing falls back to
// a size-based default. Mirrors resolve_step_sizes.
export function resolveStepSizes(stepX, stepY, width, height, config, pixelSizeOverride = null) {
  if (pixelSizeOverride != null) return [pixelSizeOverride, pixelSizeOverride];
  if (stepX != null && stepY != null) {
    const ratio = stepX > stepY ? stepX / stepY : stepY / stepX;
    if (ratio > config.maxStepRatio) { const s = Math.min(stepX, stepY); return [s, s]; }
    const avg = (stepX + stepY) / 2;
    return [avg, avg];
  }
  if (stepX != null) return [stepX, stepX];
  if (stepY != null) return [stepY, stepY];
  const fallback = Math.max(Math.min(width, height) / config.fallbackTargetSegments, 1.0);
  return [fallback, fallback];
}

// Elastic walk along a profile: step by `stepSize` from 0, snapping each
// step to the strongest gradient peak within a search window when that
// peak clears the mean-based strength threshold, else keeping the raw
// stepped position. Mirrors walk.
export function walk(profile, stepSize, limit, config) {
  if (profile.length === 0) throw new Error('Cannot walk on empty profile');
  const cuts = [0];
  let currentPos = 0;
  const searchWindow = Math.max(stepSize * config.walkerSearchWindowRatio, config.walkerMinSearchWindow);
  let sum = 0; for (const v of profile) sum += v;
  const meanVal = sum / profile.length;

  while (currentPos < limit) {
    const target = currentPos + stepSize;
    if (target >= limit) { cuts.push(limit); break; }

    const startSearch = Math.max(Math.trunc(target - searchWindow), Math.trunc(currentPos + 1));
    const endSearch = Math.min(Math.trunc(target + searchWindow), limit);
    if (endSearch <= startSearch) { currentPos = target; continue; }

    let maxVal = -1, maxIdx = startSearch;
    for (let i = startSearch; i < endSearch; i++) {
      if (profile[i] > maxVal) { maxVal = profile[i]; maxIdx = i; }
    }

    if (maxVal > meanVal * config.walkerStrengthThreshold) {
      cuts.push(maxIdx); currentPos = maxIdx;
    } else {
      cuts.push(Math.trunc(target)); currentPos = target;
    }
  }
  return cuts;
}

// Ensures cuts starts at 0 and ends at `limit`, sorted and deduped. Mirrors
// sanitize_cuts.
export function sanitizeCuts(cutsIn, limit) {
  if (limit === 0) return [0];
  const cuts = cutsIn.slice();
  let hasZero = false, hasLimit = false;
  for (let i = 0; i < cuts.length; i++) {
    if (cuts[i] === 0) hasZero = true;
    if (cuts[i] >= limit) cuts[i] = limit;
    if (cuts[i] === limit) hasLimit = true;
  }
  if (!hasZero) cuts.push(0);
  if (!hasLimit) cuts.push(limit);
  cuts.sort((a, b) => a - b);
  const out = [];
  for (const c of cuts) if (out.length === 0 || out[out.length - 1] !== c) out.push(c);
  return out;
}

// Re-snaps `limit` into `desiredCells` (from `targetStep`) uniformly-spaced
// cuts, nudging each toward the strongest nearby gradient peak the same way
// `walk` does. Mirrors snap_uniform_cuts.
export function snapUniformCuts(profile, limit, targetStep, config, minRequired) {
  if (limit === 0) return [0];
  if (limit === 1) return [0, 1];

  let desiredCells = (Number.isFinite(targetStep) && targetStep > 0) ? Math.round(limit / targetStep) : 0;
  desiredCells = Math.min(Math.max(desiredCells, Math.max(minRequired - 1, 0), 1), limit);

  const cellWidth = limit / desiredCells;
  const searchWindow = Math.max(cellWidth * config.walkerSearchWindowRatio, config.walkerMinSearchWindow);
  const meanVal = profile.length === 0 ? 0 : profile.reduce((a, b) => a + b, 0) / profile.length;

  const cuts = [0];
  for (let idx = 1; idx < desiredCells; idx++) {
    const target = cellWidth * idx;
    const prev = cuts[cuts.length - 1];
    if (prev + 1 >= limit) break;

    let start = Math.max(Math.floor(target - searchWindow), prev + 1, 0);
    let end = Math.min(Math.ceil(target + searchWindow), limit - 1);
    if (end < start) { start = prev + 1; end = start; }

    const upper = Math.min(end, Math.max(profile.length - 1, 0));
    let bestIdx = Math.min(start, Math.max(profile.length - 1, 0));
    let bestVal = -1;
    for (let i = start; i <= upper; i++) {
      const v = profile[i] ?? 0;
      if (v > bestVal) { bestVal = v; bestIdx = i; }
    }

    const strengthThreshold = meanVal * config.walkerStrengthThreshold;
    if (bestVal < strengthThreshold) {
      let fallbackIdx = Math.round(target);
      if (fallbackIdx <= prev) fallbackIdx = prev + 1;
      if (fallbackIdx >= limit) fallbackIdx = Math.max(limit - 1, prev + 1);
      bestIdx = fallbackIdx;
    }
    cuts.push(bestIdx);
  }
  if (cuts[cuts.length - 1] !== limit) cuts.push(limit);
  return sanitizeCuts(cuts, limit);
}

// One axis's cuts: kept as-is if there are already enough of them and their
// spacing isn't wildly skewed relative to the sibling axis's grid; snapped
// to a uniform target grid (borrowed from the sibling axis's cell size when
// available) otherwise. Mirrors stabilize_cuts.
export function stabilizeCuts(profile, cutsIn, limit, siblingCuts, siblingLimit, config) {
  if (limit === 0) return [0];
  const cuts = sanitizeCuts(cutsIn, limit);
  const minRequired = Math.min(Math.max(config.minCutsPerAxis, 2), limit + 1);
  const axisCells = Math.max(cuts.length - 1, 0);
  const siblingCells = Math.max(siblingCuts.length - 1, 0);
  const siblingHasGrid = siblingLimit > 0 && siblingCells >= Math.max(minRequired - 1, 0) && siblingCells > 0;

  let stepsSkewed = false;
  if (siblingHasGrid && axisCells > 0) {
    const axisStep = limit / axisCells;
    const siblingStep = siblingLimit / siblingCells;
    const stepRatio = axisStep / siblingStep;
    stepsSkewed = stepRatio > config.maxStepRatio || stepRatio < 1 / config.maxStepRatio;
  }

  if (cuts.length >= minRequired && !stepsSkewed) return cuts;

  let targetStep;
  if (siblingHasGrid) targetStep = siblingLimit / siblingCells;
  else if (config.fallbackTargetSegments > 1) targetStep = limit / config.fallbackTargetSegments;
  else if (axisCells > 0) targetStep = limit / axisCells;
  else targetStep = limit;
  if (!Number.isFinite(targetStep) || targetStep <= 0) targetStep = 1;

  return snapUniformCuts(profile, limit, targetStep, config, minRequired);
}

// Two-pass stabilization: each axis is cross-validated against the OTHER
// axis's raw cuts, then (if the two axes still disagree wildly on cell
// size) the coarser axis is re-snapped to match the finer one. Mirrors
// stabilize_both_axes.
export function stabilizeBothAxes(profileX, profileY, rawColCuts, rawRowCuts, width, height, config) {
  const colCutsPass1 = stabilizeCuts(profileX, rawColCuts, width, rawRowCuts, height, config);
  const rowCutsPass1 = stabilizeCuts(profileY, rawRowCuts, height, rawColCuts, width, config);

  const colCells = Math.max(colCutsPass1.length - 1, 1);
  const rowCells = Math.max(rowCutsPass1.length - 1, 1);
  const colStep = width / colCells;
  const rowStep = height / rowCells;
  const stepRatio = colStep > rowStep ? colStep / rowStep : rowStep / colStep;

  if (stepRatio <= config.maxStepRatio) return [colCutsPass1, rowCutsPass1];

  const targetStep = Math.min(colStep, rowStep);
  const finalColCuts = colStep > targetStep * 1.2
    ? snapUniformCuts(profileX, width, targetStep, config, config.minCutsPerAxis)
    : colCutsPass1;
  const finalRowCuts = rowStep > targetStep * 1.2
    ? snapUniformCuts(profileY, height, targetStep, config, config.minCutsPerAxis)
    : rowCutsPass1;
  return [finalColCuts, finalRowCuts];
}

function comparePixelTuple(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// One output pixel per (cols[i]..cols[i+1]) x (rows[j]..rows[j+1]) cell: the
// majority ("mode") RGBA value among that cell's source pixels, ties broken
// by lexicographic [r,g,b,a] order (matches the reference's BTree-style tie
// break, for fully deterministic output). Mirrors resample.
export function resample(bmp, cols, rows) {
  if (cols.length < 2 || rows.length < 2) throw new Error('Insufficient grid cuts for resampling');
  const outW = Math.max(cols.length - 1, 1);
  const outH = Math.max(rows.length - 1, 1);
  const out = createBitmap(outW, outH);

  for (let yi = 0; yi < rows.length - 1; yi++) {
    const ys = rows[yi], ye = rows[yi + 1];
    for (let xi = 0; xi < cols.length - 1; xi++) {
      const xs = cols[xi], xe = cols[xi + 1];
      if (xe <= xs || ye <= ys) continue;

      const counts = new Map();
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          if (x >= bmp.width || y >= bmp.height) continue;
          const p = getPixel(bmp, x, y);
          const key = p.join(',');
          const entry = counts.get(key);
          if (entry) entry.n++; else counts.set(key, { p, n: 1 });
        }
      }

      let best = null;
      for (const cand of counts.values()) {
        if (!best || cand.n > best.n || (cand.n === best.n && comparePixelTuple(cand.p, best.p) < 0)) best = cand;
      }
      setPixel(out, xi, yi, best ? best.p : [0, 0, 0, 0]);
    }
  }
  return out;
}

function nearestPaletteColor(rgb, palette) {
  let bestColor = palette[0], bestDistance = Infinity;
  for (const color of palette) {
    const dr = rgb[0] - color[0], dg = rgb[1] - color[1], db = rgb[2] - color[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) { bestDistance = distance; bestColor = color; }
  }
  return bestColor;
}

// Remaps every opaque pixel to its nearest [r,g,b] entry in `palette`;
// transparent pixels pass through unchanged. Mirrors apply_palette.
export function applyPalette(bmp, palette) {
  if (!palette || palette.length === 0) throw new Error('Palette must contain at least one RGB color');
  const cache = new Map();
  const out = createBitmap(bmp.width, bmp.height);
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const p = getPixel(bmp, x, y);
      if (p[3] === 0) { setPixel(out, x, y, p); continue; }
      const key = `${p[0]},${p[1]},${p[2]}`;
      let color = cache.get(key);
      if (!color) { color = nearestPaletteColor(p, palette); cache.set(key, color); }
      setPixel(out, x, y, [color[0], color[1], color[2], p[3]]);
    }
  }
  return out;
}

// Full pipeline entry point. `palette`, if given, is an array of [r,g,b]
// triples the final image is snapped to (this app defaults it to the
// project's active/selected palette -- see js/core/model.js's
// resolvePixelSnapperPalette()); omit/null to keep the raw k-means-
// quantized colors. `pixelSizeOverride`, if given, skips auto-detection
// entirely and forces this exact pixel size (this app exposes it as
// project.settings.pixelSnapperPixelSizeOverride). Images smaller than 3x3
// are returned unchanged (the reference implementation errors here; a
// silent no-op is friendlier for interactive paste/import than blocking on
// a tiny sprite). Mirrors process_image_common.
export function snapPixels(bmp, options = {}) {
  const { kColors = DEFAULT_PIXEL_SNAPPER_CONFIG.kColors, seed = 42, palette = null, pixelSizeOverride = null, config: userConfig = {} } = options;
  const config = { ...DEFAULT_PIXEL_SNAPPER_CONFIG, ...userConfig };
  const { width, height } = bmp;
  if (width < 3 || height < 3) return { bitmap: bmp, pixelSize: 1, outputWidth: width, outputHeight: height };

  const analysisImg = quantizeKMeans(bmp, kColors, seed, config.maxKmeansIterations);
  const { colProj, rowProj } = computeProfiles(analysisImg);

  const stepXOpt = estimateStepSize(colProj, config);
  const stepYOpt = estimateStepSize(rowProj, config);
  const [stepX, stepY] = resolveStepSizes(stepXOpt, stepYOpt, width, height, config, pixelSizeOverride);

  const rawColCuts = walk(colProj, stepX, width, config);
  const rawRowCuts = walk(rowProj, stepY, height, config);

  const [colCuts, rowCuts] = stabilizeBothAxes(colProj, rowProj, rawColCuts, rawRowCuts, width, height, config);

  const snappedImg = resample(analysisImg, colCuts, rowCuts);
  const outputImg = palette && palette.length ? applyPalette(snappedImg, palette) : snappedImg;

  return {
    bitmap: outputImg,
    pixelSize: stepX,
    outputWidth: colCuts.length - 1,
    outputHeight: rowCuts.length - 1,
  };
}
