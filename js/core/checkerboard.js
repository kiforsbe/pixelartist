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
// the strict tolerance fade out gracefully instead of surviving at full
// opacity as a stray pixel. NOTE: softness alone cannot fully clear a
// pixel whose distance exceeds tolerance -- the falloff is asymptotic, it
// only approaches 0 as softness grows, never reaches it exactly (confirmed
// against a real asset: pushing softness far past what any reasonable UI
// slider would offer still left the worst anti-aliased seam pixels at
// dozens of alpha levels, and widened how much of the image was touched
// along the way). See blendMatchStrength below for what actually clears
// that case.
function fadeFromDistance(dist, tolerance, softness) {
  if (dist <= tolerance) return 1;
  if (softness <= 0) return 0;
  const edge = tolerance + softness;
  if (dist >= edge) return 0;
  return (edge - dist) / softness;
}

function matchStrength(r, g, b, color, tolerance, softness) {
  return fadeFromDistance(channelDist(r, g, b, color), tolerance, softness);
}

// Perpendicular (Euclidean) distance from (r,g,b) to the infinite line
// through endA/endB, plus how far along the endA->endB segment the
// projection falls (0 at endA, 1 at endB, outside [0,1] means the
// projection overshoots past one of the two real checker colors).
function segmentProjection(r, g, b, endA, endB) {
  const ex = endB[0] - endA[0], ey = endB[1] - endA[1], ez = endB[2] - endA[2];
  const len2 = ex * ex + ey * ey + ez * ez;
  if (len2 === 0) return { t: 0, perp: channelDist(r, g, b, endA) };
  const vx = r - endA[0], vy = g - endA[1], vz = b - endA[2];
  const t = (vx * ex + vy * ey + vz * ez) / len2;
  const px = endA[0] + t * ex, py = endA[1] + t * ey, pz = endA[2] + t * ez;
  const perp = Math.sqrt((r - px) ** 2 + (g - py) ** 2 + (b - pz) ** 2);
  return { t, perp };
}

// Catches the anti-aliased blend BETWEEN a colorA sample and a colorB
// sample -- distinct from matchStrength, which only measures distance to
// one endpoint on its own. A checker's own cell-to-cell antialiasing seam
// is, by construction, a linear mix of its two colors, so it sits almost
// exactly ON the segment between them (confirmed against a real asset: a
// seam pixel that measured 17 away from the nearest single color sample --
// well outside a safe tolerance -- measured under 5 perpendicular from the
// A-B segment itself). Raising tolerance/softness far enough to absorb
// that 17 independently reintroduced edge-nibbling on real content
// (coal/ore icons, rock, a lizard figure) that doesn't lie on this line at
// all; restricting the check to the segment itself is far more targeted,
// since real content of a different hue is nowhere near the (near-)grey
// line between two checker colors, while genuine checker anti-aliasing
// always is. t is clamped to [0,1] (no extrapolation past either real
// checker color -- that would just be tolerance by another name), and
// perp uses its own tight tolerance/softness, independent of the caller's
// main tolerance/softness.
function blendMatchStrength(r, g, b, colorsA, colorsB, blendTolerance, blendSoftness) {
  if (blendTolerance <= 0) return { strength: 0, closerToA: true };
  let best = 0, closerToA = true;
  for (const a of colorsA) {
    for (const bCol of colorsB) {
      const { t, perp } = segmentProjection(r, g, b, a, bCol);
      if (t < 0 || t > 1) continue;
      const s = fadeFromDistance(perp, blendTolerance, blendSoftness);
      if (s > best) { best = s; closerToA = t < 0.5; }
    }
  }
  return { strength: best, closerToA };
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

// Dilates a boolean mask by `radius` (box dilation: a pixel is set if any
// pixel within `radius` in either axis is set). Used only to decide which
// pixels count as one CONNECTED region for minRegionSize -- never to expand
// which pixels are actually removal-eligible (that stays gated by isA/isB
// alone). Bridges thin (a few px) notches a jagged real-content silhouette
// cuts into the checkerboard -- without it, minRegionSize sees each sliver
// the notch pinches off as its own tiny isolated island and wrongly
// protects it as if it were enclosed content, leaving a visible stair-step
// of un-removed background tracing the silhouette (confirmed against a
// real asset: a diagonal grass edge's jagged 1-2px notches fragmented the
// background into dozens of small protected pockets). A real wall around
// genuinely enclosed content (rock around a coal chunk, a house wall
// around a window) is many pixels thick, far wider than this radius, so it
// still isolates that content correctly.
function dilateMask(mask, w, h, radius) {
  if (radius <= 0) return mask;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { out[y * w + x] = 1; continue; }
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) { hit = true; break; }
        }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
  }
  return out;
}

// ---- checkerboard lattice --------------------------------------------
//
// Everything above classifies a pixel by COLOUR, which is why a sprite
// detail that happens to share a checker shade -- coal inside a rock, dark
// speckles in a slate icon slot, a white highlight on a pearl, a white
// spiderweb drawn straight over the background, the sheet's own black-on-
// white row labels -- cannot be told apart from real background no matter
// how tolerance, windowRadius or minMixFraction are tuned (measured against
// a real 512x512 sheet: ~13,600 pixels of real artwork destroyed).
//
// A checkerboard has one thing real artwork does not: a rigid GRID, on which
// every background pixel is bit-exactly the one shade its own cell carries.
// So a checker-coloured pixel that is the WRONG SHADE FOR ITS CELL cannot be
// background at all. That is an exact constraint rather than a heuristic,
// and it is what recovers artwork drawn in a checker colour directly over
// the pattern -- black digits on a white cell, a white web strand over a
// dark one, a sprite's dark outline crossing a light cell.
//
// Using it needs the grid, and a packed sheet is the awkward case: it is
// assembled from several separately-exported sprites, each baking in its own
// checker PHASE, so no single global parity ("cell (i,j) is light exactly
// when i+j is even") describes the whole image -- on the sheet above, the
// best global parity explains only 94.7% of checker-coloured pixels, and the
// 5% it gets wrong are whole regions of ordinary background.
//
// The fix is to fit only the cell GRID (period + offset) globally, and then
// let EACH CELL vote for its own background shade from the pixels inside it.
// Phase inversion then costs nothing, because no cell depends on a global
// parity: the same sheet's cells explain 95.8% of checker-coloured pixels,
// and what now disagrees is overwhelmingly real artwork rather than whole
// mis-phased background regions.
//
// Wrong-shade pixels are only half the problem. A checker-coloured pixel
// inside an object that happens to land on a MATCHING shade is still
// ambiguous by colour, so that half is decided per REGION, not per pixel: a
// region counts as genuine checkerboard only when a whole connected run of
// matching-shade pixels contains both shades. An object's interior fails
// that -- its checker-coloured pixels match the grid only at chance rate, so
// they shatter into tiny single-shade fragments.

// Cell period by autocorrelation of the role signal. Background obeys
// role(x + C) = 1 - role(x) exactly, so it ANTI-agrees with itself one cell
// over and agrees again two cells over. Anti-aliased seams can't corrupt
// this: a blend sits near neither checker colour, so it has no role and is
// skipped. role: 0 = light, 1 = dark, -1 = not a checker colour.
//
// Scored as agree(2d) - agree(d) rather than just "wherever agreement
// bottoms out". That bare minimum is far too fragile to pick a period with:
// on a real 512x512 sheet the true 16px cell scored 0.0679 while 17px scored
// 0.0651, so the wrong period won by a hair, its cells came out mixed-shade,
// and the trust check below then silently disengaged the whole gate. The
// two-term score separates them properly, because a near-miss period slips
// by one pixel per cell and so fails to line back up at 2d, and it also
// rejects harmonics for free: d = C/2 agrees about half the time at d and
// anti-agrees at 2d (a strongly negative score), while d = 2C agrees at both
// (about zero).
function fitCheckerPeriod(role, w, h, minCell, maxCell, subsample) {
  const scan = (horiz) => {
    const agree = new Float64Array(2 * maxCell + 1).fill(NaN);
    for (let d = minCell; d <= 2 * maxCell; d++) {
      let same = 0, total = 0;
      const yEnd = horiz ? h : h - d;
      const xEnd = horiz ? w - d : w;
      for (let y = 0; y < yEnd; y += subsample) {
        const base = y * w, otherBase = horiz ? base : base + d * w;
        for (let x = 0; x < xEnd; x += subsample) {
          const a = role[base + x];
          if (a < 0) continue;
          const b = role[otherBase + (horiz ? x + d : x)];
          if (b < 0) continue;
          total++;
          if (a === b) same++;
        }
      }
      if (total) agree[d] = same / total;
    }
    let bestCell = 0, bestScore = -Infinity, bestAgree = 1;
    for (let d = minCell; d <= maxCell; d++) {
      if (Number.isNaN(agree[d]) || Number.isNaN(agree[2 * d])) continue;
      const score = agree[2 * d] - agree[d];
      if (score > bestScore) { bestScore = score; bestCell = d; bestAgree = agree[d]; }
    }
    return { cell: bestCell, agree: bestAgree, score: bestScore };
  };
  return { x: scan(true), y: scan(false) };
}

// Grid offset by cell PURITY: the right (ox, oy) is the one that stops cells
// from straddling a shade boundary. Purity is phase-agnostic -- it never asks
// which shade a cell should be, only that it be one shade -- so a sheet whose
// sprites carry different checker phases still fits cleanly. Reduced through
// per-column strips so the cost is O(cellW*N + cellW*cellH*cols*h) rather
// than re-binning every pixel for all cellW*cellH offset pairs.
function fitCheckerPhase(role, w, h, cellW, cellH) {
  let best = null;
  for (let ox = 0; ox < cellW; ox++) {
    const cols = Math.ceil((w + ox) / cellW);
    const stripLight = new Int32Array(cols * h), stripDark = new Int32Array(cols * h);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        const r = role[base + x];
        if (r < 0) continue;
        const c = ((x + ox) / cellW) | 0;
        if (r === 0) stripLight[c * h + y]++; else stripDark[c * h + y]++;
      }
    }
    for (let oy = 0; oy < cellH; oy++) {
      const rows = Math.ceil((h + oy) / cellH);
      const light = new Int32Array(cols * rows), dark = new Int32Array(cols * rows);
      for (let c = 0; c < cols; c++) {
        for (let y = 0; y < h; y++) {
          const row = ((y + oy) / cellH) | 0;
          light[row * cols + c] += stripLight[c * h + y];
          dark[row * cols + c] += stripDark[c * h + y];
        }
      }
      let pure = 0, total = 0;
      for (let k = 0; k < cols * rows; k++) { pure += Math.max(light[k], dark[k]); total += light[k] + dark[k]; }
      const purity = total > 0 ? pure / total : 0;
      if (!best || purity > best.purity) best = { ox, oy, purity };
    }
  }
  return best;
}

// Returns null when nothing fits well enough to be trusted, in which case
// the caller skips the whole gate and behaves exactly as it did before -- so
// a resized/warped checkerboard that is no longer on a rigid grid is never
// made worse by this.
function fitCheckerGrid(role, w, h, { minCell = 2, maxCell = 64, maxPeriodAgreement = 0.3, minPurity = 0.8 }) {
  // The period scan is the one O(pixels x periods) step here, so it samples a
  // sparse grid on big images -- a 512x512 sheet still leaves ~29k pairs per
  // candidate period, far more than the fit needs -- while small images, where
  // there is little to spare, are scanned whole.
  const subsample = Math.max(1, Math.round(Math.sqrt(w * h) / 200));
  const cap = Math.max(minCell, Math.min(maxCell, Math.floor(Math.min(w, h) / 2)));
  if (cap < minCell) return null;
  const period = fitCheckerPeriod(role, w, h, minCell, cap, subsample);
  if (!period.x.cell || !period.y.cell) return null;
  // A real checkerboard ANTI-agrees with itself one cell over. If the best
  // period still agrees this often there's no alternating pattern here.
  if (period.x.agree > maxPeriodAgreement || period.y.agree > maxPeriodAgreement) return null;
  const phase = fitCheckerPhase(role, w, h, period.x.cell, period.y.cell);
  if (!phase || phase.purity < minPurity) return null;
  return { cellW: period.x.cell, cellH: period.y.cell, ox: phase.ox, oy: phase.oy, purity: phase.purity };
}

// Each cell's background shade.
//
// NOT an independent per-cell majority: a cell that a sprite covers most of
// votes for the SPRITE's shade, and the sliver of real background left in it
// is then judged wrong-shade and wrongly protected (seen on a real sheet as
// white patches stranded around the bases of dark trees). Cells are not
// independent -- a checkerboard forces neighbouring cells to be opposite --
// so what gets voted on is the local POLARITY: whether this patch of the grid
// has light where (i + j) is even, or the other way round. Every cell in a
// `smooth`-radius neighbourhood contributes, so one swamped cell is outvoted
// by its neighbours, while a genuine phase change between two packed sprites
// still flips the polarity because it moves whole regions at once.
//
// A cell with no evidence at all in reach stays -1, and its pixels are then
// treated as ambiguous rather than judged, so the shade rule simply does not
// apply there.
function cellBackgroundShades(role, w, h, grid, smooth) {
  const { cellW, cellH, ox, oy } = grid;
  const cols = Math.ceil((w + ox) / cellW), rows = Math.ceil((h + oy) / cellH);
  const light = new Int32Array(cols * rows), dark = new Int32Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const row = ((y + oy) / cellH) | 0, base = y * w;
    for (let x = 0; x < w; x++) {
      const r = role[base + x];
      if (r < 0) continue;
      const c = row * cols + (((x + ox) / cellW) | 0);
      if (r === 0) light[c]++; else dark[c]++;
    }
  }
  // Per cell, how strongly its own pixels favour polarity 0 (light where
  // (i + j) is even) over polarity 1.
  const evidence = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      evidence[c] = ((i + j) & 1) === 0 ? light[c] - dark[c] : dark[c] - light[c];
    }
  }
  const shade = new Int8Array(cols * rows).fill(-1);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let sum = 0;
      const j0 = Math.max(0, j - smooth), j1 = Math.min(rows - 1, j + smooth);
      const i0 = Math.max(0, i - smooth), i1 = Math.min(cols - 1, i + smooth);
      for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) sum += evidence[jj * cols + ii];
      if (sum === 0) continue;                       // nothing to go on -- stay unjudged
      const polarity = sum > 0 ? 0 : 1;
      shade[j * cols + i] = ((i + j) & 1) ^ polarity;
    }
  }
  return { cols, rows, shade, cellW, cellH, ox, oy };
}

// Splits the checkerboard-coloured pixels into the two halves the gate treats
// differently.
//
// wrongShade: strict evidence only -- a pixel confidently one checker colour
// while its cell demands the other. Provably not background.
//
// matches: confidently the shade its cell demands -- still ambiguous, since a
// sprite detail lands on a matching shade about half the time by chance, so
// it goes on to the region test below. Kept strict (a seam blend is NOT a
// member) because that is exactly what fragments a sprite's interior: its
// checker-coloured pixels agree with the grid only at chance rate, so they
// break into tiny single-shade islands that the region test then rejects.
// The 1-2px seam gaps this leaves along real cell boundaries are closed by
// connectivityBridge, which is the same mechanism minRegionSize already uses.
function classifyByCellShade(role, w, h, cells) {
  const matches = new Uint8Array(w * h), wrongShade = new Uint8Array(w * h);
  const { cols, shade, cellW, cellH, ox, oy } = cells;
  for (let y = 0; y < h; y++) {
    const row = ((y + oy) / cellH) | 0, base = y * w;
    for (let x = 0; x < w; x++) {
      const p = base + x, r = role[p];
      if (r < 0) continue;
      const want = shade[row * cols + (((x + ox) / cellW) | 0)];
      if (want < 0) { matches[p] = 1; continue; }   // no evidence either way
      if (r === want) matches[p] = 1; else wrongShade[p] = 1;
    }
  }
  return { matches, wrongShade };
}

// Marks which matching-shade pixels belong to a region that is genuinely
// checkerboard: big enough, and carrying BOTH shades. A sprite's interior
// fails the second test -- an enclosed detail is essentially all one shade.
//
// A jagged sprite edge also pinches hairline-thin slivers off the real
// background, and such a sliver judged on its own is too small to qualify and
// would be wrongly protected. `bridge` handles those, but NOT by grouping
// everything on a dilated mask the way minRegionSize does: inside a busy
// sprite that fuses dozens of unrelated fragments into one blob big and mixed
// enough to qualify, which hands the sprite's own interior straight back to
// the remover (measured on a real sheet: artwork destroyed went from 6,350
// pixels to 9,326). Instead each component is judged strictly on its own, and
// only then are unqualified ones PROMOTED if they sit within `bridge` of a
// component that already qualified. A pinched-off sliver touches the real
// background and gets promoted; a sprite's enclosed detail is walled off by
// material far thicker than the bridge, so it never touches territory and
// stays protected however many fragments surround it.
function checkerTerritory(matches, role, w, h, minRegionSize, minAlternation, bridge) {
  const n = w * h;
  const { labels, sizes } = labelComponents(matches, w, h);
  const light = new Int32Array(sizes.length), dark = new Int32Array(sizes.length);
  for (let p = 0; p < n; p++) {
    const id = labels[p];
    if (id < 0) continue;
    if (role[p] === 0) light[id]++; else if (role[p] === 1) dark[id]++;
  }
  const qualified = new Uint8Array(sizes.length);
  for (let id = 0; id < sizes.length; id++) {
    if (sizes[id] < minRegionSize) continue;
    const total = light[id] + dark[id];
    if (total === 0 || Math.min(light[id], dark[id]) / total < minAlternation) continue;
    qualified[id] = 1;
  }
  const territory = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (labels[p] >= 0 && qualified[labels[p]]) territory[p] = 1;
  if (bridge > 0) {
    // 2*bridge, because dilating a mask by `bridge` before labelling (what
    // minRegionSize does) closes gaps of twice that -- both sides grow toward
    // each other. Promotion only grows the territory side, so it has to cover
    // the whole gap itself to bridge the same hairline.
    const reachable = dilateMask(territory, w, h, 2 * bridge);
    const promoted = new Uint8Array(sizes.length);
    for (let p = 0; p < n; p++) {
      const id = labels[p];
      if (id < 0 || qualified[id] || !reachable[p]) continue;
      promoted[id] = 1;
    }
    for (let p = 0; p < n; p++) if (labels[p] >= 0 && promoted[labels[p]]) territory[p] = 1;
  }
  return territory;
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
// connectivityBridge: dilates the checker mask by this many pixels before
// grouping it into components for minRegionSize (see dilateMask) -- bridges
// thin jagged-silhouette notches so they don't fragment the real
// background into lots of small wrongly-protected pockets, without
// bridging genuinely thick walls around enclosed content.
// blendTolerance/blendSoftness: see blendMatchStrength above -- catches the
// anti-aliased blend BETWEEN colorA and colorB (a real seam between two
// checker cells), independent of tolerance/softness. A pixel caught only
// by this check joins isA/isB (whichever endpoint it's nearer, for the
// window-mix test and connectivity below) exactly as if it had matched by
// distance. Pass blendTolerance: 0 to disable.
//
// latticeGate (see the lattice section above): protects sprite detail that
// merely SHARES a checker colour, which no colour-space test can ever
// separate. It works on the checkerboard's grid rather than its palette, in
// two parts.
//
// shadeGate is the exact half: a checker-coloured pixel carrying the wrong
// shade for the cell it sits in cannot be background, so it is never
// removed. This is what recovers artwork drawn in a checker colour directly
// on top of the pattern -- black-on-white row labels, a white spiderweb over
// dark cells, a sprite's dark outline crossing a light cell -- none of which
// any colour test or region test can reach. Pass shadeGate: false to disable
// just this half (latticeGate: false disables both).
//
// latticeVeto is the ambiguous half, for pixels whose shade DOES match their
// cell: those are only removable inside a region that behaves like real
// checkerboard (big, and carrying both shades). It applies within
// latticeVetoRadius of real (non-checker-coloured) material, because its job
// is protecting sprite interiors -- a stray pixel out in open background is
// not one, and keeps behaving exactly as before.
//
// Both depend on fitCheckerGrid finding a trustworthy grid; if it doesn't,
// the whole gate disengages and behaviour is exactly as it was without it,
// so a resized/warped checkerboard is never made worse. minLatticePurity is
// how cleanly cells must come out single-shaded to be believed;
// latticeSmooth is how many cells out the polarity vote reaches.
// latticeCellSize defaults to windowRadius, which callers already set from
// estimateCheckerCellSize; it only bounds the period search.
export function checkerboardRemoveBitmap(bmp, { colorA, colorB, tolerance = 18, softness = 0, windowRadius = 12, minMixFraction = 0.12, minRegionSize = (windowRadius * 2 + 1) ** 2, connectivityBridge = 2, blendTolerance = 6, blendSoftness = 3, latticeGate = true, shadeGate = true, latticeCellSize = windowRadius, minLatticePurity = 0.8, latticeSmooth = 1, minLatticeRegion = 128, latticeAlternation = 0.05, latticeGrow = 1, latticeBridge = connectivityBridge, blendSeamOnly = true, blendSeamRadius = 1, latticeVetoRadius = latticeCellSize, mode = 'transparent', replacementColor = [255, 255, 255], protectColor = null, protectTolerance = 0, protectSoftness = 0 }) {
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
    if (minChannelDist(r, g, b, colorsA) <= edge) { isA[p] = 1; isChecker[p] = 1; continue; }
    if (minChannelDist(r, g, b, colorsB) <= edge) { isB[p] = 1; isChecker[p] = 1; continue; }
    const blend = blendMatchStrength(r, g, b, colorsA, colorsB, blendTolerance, blendSoftness);
    if (blend.strength > 0) {
      if (blend.closerToA) isA[p] = 1; else isB[p] = 1;
      isChecker[p] = 1;
    }
  }
  const satA = buildIntegral(isA, w, h);
  const satB = buildIntegral(isB, w, h);
  let componentLabels = null, componentSizes = null;
  if (minRegionSize > 0) {
    // Label on the dilated mask (bridges thin notches into one group), but
    // size each group by its REAL isChecker pixel count, not the dilated
    // one -- otherwise a small enclosed island's own dilation halo could
    // inflate its reported size past the threshold and defeat the gate for
    // the exact small islands it exists to protect.
    ({ labels: componentLabels } = labelComponents(dilateMask(isChecker, w, h, connectivityBridge), w, h));
    componentSizes = [];
    for (let p = 0; p < w * h; p++) {
      if (!isChecker[p]) continue;
      const id = componentLabels[p];
      componentSizes[id] = (componentSizes[id] || 0) + 1;
    }
  }
  // Lattice gate, in two parts (see the section comment above):
  //   shadeVeto   -- the exact rule: a checker-coloured pixel carrying the
  //                  wrong shade for its own cell is provably not background.
  //   latticeVeto -- the ambiguous half: a matching-shade pixel that isn't
  //                  part of a region actually behaving like checkerboard,
  //                  and only where there's real material nearby for the veto
  //                  to be protecting in the first place.
  let latticeVeto = null, shadeVeto = null, blendVeto = null;
  if (latticeGate && latticeCellSize >= 2) {
    // Strict membership on purpose -- NOT isA/isB. Those deliberately also
    // take in the softness band and the anti-aliased blends between the two
    // checker colours (see blendMatchStrength), and a seam blend gets filed
    // under whichever endpoint it happens to sit nearer. Those pixels lie
    // exactly ON cell boundaries and split near 50/50, so feeding them to the
    // grid fit drags cell purity down far enough to fail the trust check and
    // silently disengage the whole gate. They are also genuinely ambiguous:
    // a blend is not evidence of a shade, so it must not be judged
    // wrong-shade either. Leaving them unroled keeps them out of both.
    const role = new Int8Array(w * h).fill(-1);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      if (src[i + 3] === 0) continue;
      const r = src[i], g = src[i + 1], b = src[i + 2];
      if (minChannelDist(r, g, b, colorsA) <= tolerance) role[p] = 0;
      else if (minChannelDist(r, g, b, colorsB) <= tolerance) role[p] = 1;
    }
    const grid = fitCheckerGrid(role, w, h, {
      maxCell: Math.max(4, Math.round(latticeCellSize * 2)),
      minPurity: minLatticePurity,
    });
    if (grid) {
      const cells = cellBackgroundShades(role, w, h, grid, latticeSmooth);
      const { matches, wrongShade } = classifyByCellShade(role, w, h, cells);
      if (shadeGate) shadeVeto = wrongShade;
      // A checker cell's own anti-aliased seam is a linear mix of the two
      // checker colours -- but so is the edge of WHITE ARTWORK drawn over a
      // dark cell, or dark artwork over a light one, and blendMatchStrength
      // cannot tell those apart, because in colour space they are the same
      // thing (confirmed on a real sheet: a white spiderweb painted straight
      // over the checkerboard came out shredded, its every anti-aliased edge
      // pixel read as a seam). Position separates them exactly: a real seam
      // lies ON a cell boundary, artwork's edge lies wherever the artwork is.
      // So a pixel that qualifies ONLY as a blend is removable only near a
      // cell boundary.
      if (blendTolerance > 0 && blendSeamOnly) {
        blendVeto = new Uint8Array(w * h);
        const { cellW, cellH, ox, oy } = grid;
        const nearEdge = (v, cellSize) => v <= blendSeamRadius || v >= cellSize - 1 - blendSeamRadius;
        for (let y = 0; y < h; y++) {
          if (nearEdge((y + oy) % cellH, cellH)) continue;   // whole row hugs a boundary
          for (let x = 0; x < w; x++) {
            const p = y * w + x;
            if (role[p] >= 0) continue;                      // a real checker colour, not merely a blend
            if (nearEdge((x + ox) % cellW, cellW)) continue;
            blendVeto[p] = 1;
          }
        }
      }
      const territory = checkerTerritory(matches, role, w, h, minLatticeRegion, latticeAlternation, latticeBridge);
      const reach = dilateMask(territory, w, h, latticeGrow);
      const material = new Uint8Array(w * h);
      for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        if (src[i + 3] !== 0 && !isChecker[p]) material[p] = 1;
      }
      // "is there real material within latticeVetoRadius" is a box query, so
      // a summed-area table answers it in O(1) per pixel instead of paying a
      // full dilation at that radius.
      const satMaterial = buildIntegral(material, w, h);
      latticeVeto = new Uint8Array(w * h);
      for (let p = 0; p < w * h; p++) {
        if (reach[p]) continue;
        const x = p % w, y = (p / w) | 0;
        if (boxSum(satMaterial, w, h, x, y, latticeVetoRadius) > 0) latticeVeto[p] = 1;
      }
    }
  }

  const data = new Uint8ClampedArray(src);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (!isA[p] && !isB[p]) continue;
    if (shadeVeto && shadeVeto[p]) continue;
    if (blendVeto && blendVeto[p]) continue;
    if (componentLabels && componentSizes[componentLabels[p]] < minRegionSize) continue;
    if (latticeVeto && latticeVeto[p]) continue;
    const x = p % w, y = (p / w) | 0;
    const countA = boxSum(satA, w, h, x, y, windowRadius);
    const countB = boxSum(satB, w, h, x, y, windowRadius);
    const total = countA + countB;
    const minorityCount = isA[p] ? countB : countA;
    if (total === 0 || minorityCount / total < minMixFraction) continue;

    const r = data[i], g = data[i + 1], b = data[i + 2];
    let strength = Math.max(
      maxMatchStrength(r, g, b, colorsA, tolerance, softness),
      maxMatchStrength(r, g, b, colorsB, tolerance, softness),
      blendMatchStrength(r, g, b, colorsA, colorsB, blendTolerance, blendSoftness).strength,
    );
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
