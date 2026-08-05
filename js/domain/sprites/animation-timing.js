export function fpsStepToMs(fps, step) {
  return Math.round(1000 / fps * step);
}

export function msToFps(ms) {
  return 1000 / ms;
}

export function effectiveDuration(animation, entry) {
  if (animation.baseFps) {
    const step = entry.step ?? animation.baseStep ?? 1;
    return fpsStepToMs(animation.baseFps, step);
  }
  return entry.duration ?? animation.baseDuration ?? 100;
}
