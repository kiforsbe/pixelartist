// Pure onion-skin math for the frame editor: which ghost frames to draw, at
// what tint, and the edge-detection trace behind Outline mode. Everything
// here takes plain data (no legacy `state`, no Canvas/DOM), so it unit-tests
// with plain object literals; `traceOutline` returns a plain {width, height,
// data} bitmap rather than a real ImageData (unavailable outside a browser),
// matching core/pixels.js's convention -- callers wrap it in `new
// ImageData(...)` at the point of canvas use.

function wrapIndex(idx, len) { return ((idx % len) + len) % len; }

// Ghost descriptors to draw for editing frame `frameId` of `animation`,
// walking back/ahead by onion.back/onion.ahead steps with loop-wrap when the
// animation loops. Returns [] when onion skin is off, the animation is
// missing/empty, or `frameId` isn't a member of it.
export function computeOnionGhosts(animation, frameId, onion) {
  if (!onion.enabled || (!onion.mask && !onion.outline)) return [];
  if (!animation || !animation.frames.length) return [];
  const pos = animation.frames.findIndex(af => af.frameId === frameId);
  if (pos === -1) return [];
  const len = animation.frames.length;
  const ghosts = [];
  for (let k = 1; k <= onion.back; k++) {
    let idx = pos - k;
    if (idx < 0) { if (!animation.loop) break; idx = wrapIndex(idx, len); }
    ghosts.push({ frameId: animation.frames[idx].frameId, k, dir: 'back' });
  }
  for (let k = 1; k <= onion.ahead; k++) {
    let idx = pos + k;
    if (idx >= len) { if (!animation.loop) break; idx = wrapIndex(idx, len); }
    ghosts.push({ frameId: animation.frames[idx].frameId, k, dir: 'ahead' });
  }
  return ghosts;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Resolves the tint for ghost step `k` (1-based distance) in direction `dir`
// ('back' or 'ahead'): a per-step override wins, else the direction's base
// color.
export function resolveStepColor(onion, dir, k) {
  const override = onion.stepColors[dir][k];
  return hexToRgb(override ?? (dir === 'back' ? onion.backColor : onion.aheadColor));
}

// 1px-thick edge trace of `region`'s alpha silhouette: a pixel is an edge
// pixel if it's opaque and at least one of its 4-neighbors (off-canvas counts
// as transparent) is not. Interior/exterior pixels stay fully transparent, so
// this composites as an outline rather than a fill. `region` is a plain
// {width, height, data: Uint8ClampedArray} RGBA bitmap (e.g. core/pixels.js's
// copyRegion() output).
export function traceOutline(region, [r, g, b]) {
  const { width: w, height: h, data: src } = region;
  const out = new Uint8ClampedArray(src.length);
  const alphaAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : src[(y * w + x) * 4 + 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alphaAt(x, y) === 0) continue;
      const isEdge = alphaAt(x - 1, y) === 0 || alphaAt(x + 1, y) === 0 || alphaAt(x, y - 1) === 0 || alphaAt(x, y + 1) === 0;
      if (!isEdge) continue;
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
