// js/modes/maps/application/commands/palette-commands.js
//
// Ports color-panel.js's editIndexedEntry (the two branches it used to push
// onto state.commands: a plain palette-entry edit, and a remap that also
// patches every affected layer's bitmap) into standalone Command Handlers,
// registered under the maps.* command ids so editing an indexed palette
// swatch keeps working while parked in Maps mode too. Palettes are
// project-level, not sheet-scoped, so resolve = project => project.
//
// This file is intentionally identical to the sprites-mode and tiles-mode
// copies of the same two functions: editIndexedEntry itself never branches
// on which mode (or even which sheet kind) is active, only on "does the
// active sheet have this color", so there is no maps-specific behavior to
// diverge here -- a third copy exists only so contributions.js can register
// its own command id gated to Maps mode.
import { runEntityCommand } from '../../../../host/command-helpers.js';
import { cloneBitmap, blitRegion, colorsEqual } from '../../../../core/pixels.js';
import { sheetLayers } from '../../../../core/model.js';
import { setEntry, remapColor } from '../../../../core/palettes.js';
import { activeSheet } from '../../../../app/state.js';

function currentPalette(project) {
  return project?.palettes.find(p => p.id === project.activePaletteId) ?? null;
}

export function editPaletteColor(services, index, color) {
  const pal = currentPalette(services.projects.project);
  if (!pal) return;
  const before = pal.colors[index];
  if (colorsEqual(before, color)) return;
  runEntityCommand(services, 'edit palette color', project => project,
    project => { setEntry(currentPalette(project), index, color); },
    project => { setEntry(currentPalette(project), index, before); });
}

// The palette-entry mutation lives INSIDE the command so undo restores both
// the pixels AND the palette color, exactly like editIndexedEntry's own
// remap branch. layerPatches is collected once, up front, over every layer
// of the CURRENT active sheet (activeSheet(), matching editIndexedEntry's
// own scope -- not every sheet in the project), regardless of whether that
// layer's bitmap actually contains the old color.
export function remapPaletteColor(services, index, color) {
  const pal = currentPalette(services.projects.project);
  if (!pal) return;
  const old = pal.colors[index];
  if (colorsEqual(old, color)) return;
  const sheet = activeSheet();
  const layerPatches = (sheet ? sheetLayers(sheet) : []).map(layer => {
    const before = cloneBitmap(layer.bitmap);
    const after = cloneBitmap(layer.bitmap);
    remapColor(after, old, color);
    return { bitmap: layer.bitmap, before, after };
  });
  runEntityCommand(services, 'remap palette color', project => project,
    project => {
      setEntry(currentPalette(project), index, color);
      for (const lp of layerPatches) blitRegion(lp.bitmap, lp.after, 0, 0);
    },
    project => {
      setEntry(currentPalette(project), index, old);
      for (const lp of layerPatches) blitRegion(lp.bitmap, lp.before, 0, 0);
    });
}
