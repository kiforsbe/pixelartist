import { resolvePixelSnapperPalette } from './model.js';
import { snapPixels } from './pixelSnapper.js';

export function snapProjectPixels(project, bitmap) {
  const settings = project?.settings;
  if (!settings?.pixelSnapperEnabled) return bitmap;
  return snapPixels(bitmap, {
    palette: resolvePixelSnapperPalette(project),
    kColors: settings.pixelSnapperKColors,
    pixelSizeOverride: settings.pixelSnapperPixelSizeOverride,
    config: {
      maxKmeansIterations: settings.pixelSnapperMaxIterations,
      peakThresholdMultiplier: settings.pixelSnapperPeakThreshold,
      peakDistanceFilter: settings.pixelSnapperPeakDistanceFilter,
      walkerSearchWindowRatio: settings.pixelSnapperSearchWindowRatio,
      walkerMinSearchWindow: settings.pixelSnapperMinSearchWindow,
      walkerStrengthThreshold: settings.pixelSnapperStrengthThreshold,
      minCutsPerAxis: settings.pixelSnapperMinCutsPerAxis,
      fallbackTargetSegments: settings.pixelSnapperFallbackSegments,
      maxStepRatio: settings.pixelSnapperMaxStepRatio,
    },
  }).bitmap;
}
