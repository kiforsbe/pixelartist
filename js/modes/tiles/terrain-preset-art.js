// js/modes/tiles/terrain-preset-art.js
import { emit } from '../../app/state.js';
import { getEditorHost } from '../../host/runtime.js';
import { activeLayer } from '../../host/document-helpers.js';
import { confirmOrAuto } from '../../platform/browser/autotest.js';
import { copyRegion, blitRegion, scaleBitmap } from '../../core/pixels.js';
import { makePixelPatch } from '../../core/commands.js';
import { decodePng } from '../../app/pngcodec.js';

// Paints preset.sourceImage's reference art onto the active paint layer, one
// crop per cell, at the freshly-created sourceTiles' sheet coordinates --
// gives a terrain set real, recognizable slot art immediately instead of
// blank tiles the user has to hand-draw one by one. Only wired into the "Add
// terrain set" creation flow (fresh, definitely-blank tiles); never into
// "import layout" onto an existing grid, which could carry real user art.
// Pushes a raw pixel-patch undo entry directly through
// getEditorHost().history.execute() (bypassing the registries.commands id/
// context layer entirely, the same way drawing-engine.js's stroke finalize
// does) rather than going through a resolve-by-id Command Handler -- out of
// scope for this migration, see docs/superpowers/specs/
// 2026-08-10-phase-3c-tiles-terrain-set-editor-design.md. Lives outside
// presentation/ and application/ specifically because of that: it imports
// core/commands.js directly, which tests/architecture.test.mjs's
// presentation-layer scan forbids inside presentation/ (and is the one
// tracked exception that same test's own outside-application/presentation
// scan allows -- see 'only the tracked terrain-preset-art.js exception...').
export async function importPresetArtOntoLayer(sheet, preset, sourceTiles, cols) {
  if (!preset.sourceImage || !sourceTiles.length) return;
  const layer = activeLayer();
  if (!layer) return;

  let refBitmap;
  try {
    const res = await fetch(preset.sourceImage);
    refBitmap = await decodePng(new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    console.warn(`Could not import template art from ${preset.sourceImage}: ${e.message}`);
    return;
  }

  const cellSize = preset.sourceCellSize ?? 32;
  const minX = Math.min(...sourceTiles.map(t => t.x));
  const minY = Math.min(...sourceTiles.map(t => t.y));
  const maxX = Math.max(...sourceTiles.map(t => t.x + t.w));
  const maxY = Math.max(...sourceTiles.map(t => t.y + t.h));
  const rect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  const before = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);

  const alreadyPainted = before.data.some((v, i) => i % 4 === 3 && v !== 0);
  if (alreadyPainted && !confirmOrAuto(
    `"${layer.name}" already has pixels where this grid lands. Overwrite them with the "${preset.name}" reference art?`
  )) return;

  for (const cell of preset.cells) {
    const tile = sourceTiles[cell.row * cols + cell.col];
    if (!tile) continue;
    const cropped = copyRegion(refBitmap, cell.col * cellSize, cell.row * cellSize, cellSize, cellSize);
    const painted = (tile.w === cellSize && tile.h === cellSize) ? cropped : scaleBitmap(cropped, tile.w, tile.h);
    blitRegion(layer.bitmap, painted, tile.x, tile.y);
  }

  const after = copyRegion(layer.bitmap, rect.x, rect.y, rect.w, rect.h);
  // Direct history.execute(), no separate markDirty() call: HistoryService's
  // own onChange wrapper already marks the project dirty on every push.
  getEditorHost().history.execute(makePixelPatch(layer.bitmap, rect, before, after, 'import terrain layout art'));
  emit('pixels');
}
