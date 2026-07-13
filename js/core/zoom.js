// Table-stepped zoom. Fixes wheel zoom sticking at 1x/2x under multiply-then-snap:
// stepping is always by table index, never by multiplying the current zoom.
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

export function stepZoom(zoom, dir) {
  let idx = 0, best = Infinity;
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const d = Math.abs(ZOOM_STEPS[i] - zoom);
    if (d < best) { best = d; idx = i; }
  }
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + dir))];
}

export function snapFitZoom(fit) {
  let out = ZOOM_STEPS[0];
  for (const z of ZOOM_STEPS) if (z <= fit) out = z;
  return out;
}
