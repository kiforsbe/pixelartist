// The one undoable palette command family, shared by every mode.
//
// This replaces three byte-identical per-mode modules
// (js/modes/{sprites,tiles,maps}/application/commands/palette-commands.js).
// Nothing about editing a palette is mode-specific -- sprites, tiles and
// maps all share one project-level palette list -- so per-mode registration
// bought nothing and cost a real bug: maps mode registered neither command,
// which made editing a swatch there a silent no-op.
//
// Every command runs at PROJECT_SCOPE (see js/host/history-service.js): a
// palette belongs to the project, not to whichever sheet or map is open, so
// scoping one to the active document would strand it the moment the user
// switched away.
//
// No browser globals here. Prompts and confirmations -- "remap N pixels?",
// "truncate this palette?" -- belong to the caller, which is why
// setSwatchColor and remapSwatchColor stay two commands and countSwatchPixels
// is a plain query rather than a command.
import { PROJECT_SCOPE } from '../../host/history-service.js';
import { sheetLayers } from '../../core/model.js';
import { cloneBitmap, blitRegion, colorsEqual } from '../../core/pixels.js';
import { remapColor, setEntry, clearEntry, addSwatch, removeSwatch, moveSwatch,
  setEmptyColor, setLock, sortOrder, applyOrder, countPaletteUsage } from '../../core/palettes.js';

function project(services) { return services.projects.project; }

function paletteById(services, id) {
  return project(services)?.palettes.find(p => p.id === id) ?? null;
}

function activeSheet(services) {
  const doc = services.store?.getState().session.activeDocument;
  if (!doc || (doc.kind !== 'sprite-sheet' && doc.kind !== 'tile-sheet')) return null;
  return project(services)?.sheets.find(sheet => sheet.id === doc.id) ?? null;
}

function activeBitmaps(services) {
  const sheet = activeSheet(services);
  return sheet ? sheetLayers(sheet).map(layer => layer.bitmap) : [];
}

// Every command re-resolves the palette by id inside do() and undo() rather
// than closing over the object: the project can be replaced wholesale (file
// load, autosave restore) between a do and its undo.
function run(services, label, apply, revert) {
  services.history.execute({
    label,
    do: () => services.projects.mutate(label, apply),
    undo: () => services.projects.mutate(label, revert),
  }, { scope: PROJECT_SCOPE });
}

function runOnPalette(services, paletteId, label, apply, revert) {
  run(services,
    label,
    proj => { const p = proj.palettes.find(x => x.id === paletteId); if (p) apply(p, proj); },
    proj => { const p = proj.palettes.find(x => x.id === paletteId); if (p) revert(p, proj); });
}

// Snapshot/restore of the two paired arrays plus the lock -- the honest way
// to undo anything that changes length or order, and short enough that
// per-operation inverse logic would only be a way to get it subtly wrong.
function snapshot(p) {
  return { colors: p.colors.map(c => [...c]), empty: [...p.empty], emptyColor: [...p.emptyColor], lock: p.lock ? { ...p.lock } : null };
}
function restore(p, snap) {
  p.colors = snap.colors.map(c => [...c]);
  p.empty = [...snap.empty];
  p.emptyColor = [...snap.emptyColor];
  p.lock = snap.lock ? { ...snap.lock } : null;
}

// ---- palette lifecycle ----

// Takes an already-built palette (from createPalette, clonePalette, an
// import, or artwork) so the caller owns naming and shape; this only makes
// adding it undoable. Selecting it is part of the same step: undo has to put
// the previous selection back or the user lands on a palette that is gone.
export function createNewPalette(services, palette) {
  const previousActiveId = project(services)?.activePaletteId ?? null;
  run(services, 'new palette',
    proj => {
      if (!proj.palettes.some(p => p.id === palette.id)) proj.palettes.push(palette);
      proj.activePaletteId = palette.id;
    },
    proj => {
      proj.palettes = proj.palettes.filter(p => p.id !== palette.id);
      proj.activePaletteId = previousActiveId;
    });
}

export function duplicatePalette(services, paletteId) {
  const source = paletteById(services, paletteId);
  if (!source) return;
  const copy = {
    ...source,
    id: `${source.id}-copy-${Date.now().toString(36)}`,
    name: `${source.name} copy`,
    colors: source.colors.map(c => [...c]),
    empty: [...source.empty],
    emptyColor: [...source.emptyColor],
    lock: source.lock ? { ...source.lock } : null,
  };
  createNewPalette(services, copy);
}

export function renamePalette(services, paletteId, name) {
  const target = paletteById(services, paletteId);
  if (!target || target.name === name) return;
  const before = target.name;
  runOnPalette(services, paletteId, 'rename palette',
    p => { p.name = name; },
    p => { p.name = before; });
}

export function deletePalette(services, paletteId) {
  const proj = project(services);
  const at = proj?.palettes.findIndex(p => p.id === paletteId) ?? -1;
  if (at === -1) return;
  const removed = proj.palettes[at];
  const previousActiveId = proj.activePaletteId;
  run(services, 'delete palette',
    target => {
      target.palettes.splice(at, 1);
      if (target.activePaletteId === paletteId) target.activePaletteId = target.palettes[0]?.id ?? null;
    },
    target => {
      target.palettes.splice(at, 0, removed);
      target.activePaletteId = previousActiveId;
    });
}

// ---- swatch edits ----

export function addPaletteSwatch(services, paletteId, color) {
  const target = paletteById(services, paletteId);
  // A full locked palette has nowhere to put it: record nothing, so the
  // user's undo stack does not fill with steps that changed nothing.
  if (!target || (target.lock && !target.empty.includes(true))) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'add swatch',
    p => { addSwatch(p, color); },
    p => restore(p, before));
}

export function setSwatchColor(services, paletteId, index, color) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = [...target.colors[index]];
  const wasEmpty = target.empty[index];
  if (colorsEqual(before, color) && !wasEmpty) return;
  runOnPalette(services, paletteId, 'edit palette color',
    p => { setEntry(p, index, color); },
    p => { p.colors[index] = [...before]; p.empty[index] = wasEmpty; });
}

// The palette entry AND the pixels move in one command, so undo restores
// both -- splitting them would let a half-undo leave the artwork referring
// to a color the palette no longer has. layerPatches is collected up front
// over the active sheet's layers only, matching what the user was told the
// remap would touch.
export function remapSwatchColor(services, paletteId, index, color) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = [...target.colors[index]];
  const wasEmpty = target.empty[index];
  if (colorsEqual(before, color) && !wasEmpty) return;
  const layerPatches = activeBitmaps(services).map(bitmap => {
    const after = cloneBitmap(bitmap);
    remapColor(after, before, color);
    return { bitmap, before: cloneBitmap(bitmap), after };
  });
  runOnPalette(services, paletteId, 'remap palette color',
    p => {
      setEntry(p, index, color);
      for (const lp of layerPatches) blitRegion(lp.bitmap, lp.after, 0, 0);
    },
    p => {
      p.colors[index] = [...before]; p.empty[index] = wasEmpty;
      for (const lp of layerPatches) blitRegion(lp.bitmap, lp.before, 0, 0);
    });
}

// Not a command: a query the UI runs to decide whether to offer the remap.
export function countSwatchPixels(services, color) {
  let n = 0;
  for (const bmp of activeBitmaps(services)) {
    const d = bmp.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === color[0] && d[i + 1] === color[1] && d[i + 2] === color[2] && d[i + 3] === color[3]) n++;
    }
  }
  return n;
}

export function clearSwatch(services, paletteId, index) {
  const target = paletteById(services, paletteId);
  if (!target || target.empty[index]) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'clear swatch',
    p => clearEntry(p, index),
    p => restore(p, before));
}

export function removePaletteSwatch(services, paletteId, index) {
  const target = paletteById(services, paletteId);
  if (!target || index < 0 || index >= target.colors.length) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'remove swatch',
    p => removeSwatch(p, index),
    p => restore(p, before));
}

export function movePaletteSwatch(services, paletteId, from, to) {
  const target = paletteById(services, paletteId);
  if (!target || from === to) return;
  if (to < 0 || to >= target.colors.length) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'move swatch',
    p => moveSwatch(p, from, to),
    p => restore(p, before));
}

// mode: 'hue' | 'luminance' | 'usage'. Usage counts come from the active
// sheet, so sorting by usage in maps mode simply leaves the order alone.
export function sortPalette(services, paletteId, mode) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const usage = mode === 'usage' ? countPaletteUsage(target, activeBitmaps(services)) : null;
  const order = sortOrder(target.colors, mode, usage);
  if (order.every((v, i) => v === i)) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, `sort palette by ${mode}`,
    p => applyOrder(p, order),
    p => restore(p, before));
}

// ---- palette-level settings ----

// size === null unlocks. A lossy truncate is the CALLER's to confirm first.
export function setPaletteLock(services, paletteId, size, reason = '') {
  const target = paletteById(services, paletteId);
  if (!target) return;
  // Re-picking the size the palette already has must not record a step: the
  // manager's dropdown fires on every change, including the one that merely
  // re-selects the current value, and a dead undo step is worse than none.
  const unchanged = size === null
    ? target.lock === null
    : target.lock?.size === size && target.lock.reason === reason && target.colors.length === size;
  if (unchanged) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, size === null ? 'unlock palette' : 'lock palette size',
    p => setLock(p, size, reason),
    p => restore(p, before));
}

export function setPaletteEmptyColor(services, paletteId, color) {
  const target = paletteById(services, paletteId);
  if (!target || colorsEqual(target.emptyColor, color)) return;
  const before = snapshot(target);
  runOnPalette(services, paletteId, 'set unset color',
    p => setEmptyColor(p, color),
    p => restore(p, before));
}

export function setPaletteIndexed(services, paletteId, indexed) {
  const target = paletteById(services, paletteId);
  if (!target || target.indexed === !!indexed) return;
  runOnPalette(services, paletteId, indexed ? 'make palette indexed' : 'make palette free',
    p => { p.indexed = !!indexed; },
    p => { p.indexed = !indexed; });
}

// ---- named ramps ----
//
// Ramps are palette state (js/core/ramps.js's rampContaining/stepAlongRamp
// read them by name, and brush-ink.js threads a brush's rampName through to
// stepAlongRamp), so unlike brush edits these commands ARE undoable at
// PROJECT_SCOPE. Brushes are configuration; palettes are content.

function cloneRamps(ramps) {
  return (ramps ?? []).map(r => ({ name: r.name, indices: [...r.indices] }));
}

function sameIndices(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// A single out-of-range index does not just leave a gap in the ramp: it
// derails stepAlongRamp for every step near it, because clamping there is
// against the stored array's length, not the count of indices that actually
// resolve. Filtering at write time is what keeps a ramp usable for every
// entry it claims to have.
function usableIndices(palette, indices) {
  return indices.filter(i => Number.isInteger(i) && i >= 0 && i < palette.colors.length);
}

export function nameRamp(services, paletteId, name, indices) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const usable = usableIndices(target, indices);
  // Fewer than two entries is not a ramp -- refuse rather than store
  // something that would silently do nothing (see usableIndices above).
  if (usable.length < 2) return;
  const before = cloneRamps(target.ramps);
  const existing = before.find(r => r.name === name);
  // Re-naming a ramp to the same name and (post-filter) the same indices is
  // not a change. The manager's UI fires on every selection, including one
  // that merely re-confirms the current ramp, so this mirrors the guard
  // setPaletteLock already keeps for the same reason: a dead undo step is
  // worse than none.
  if (existing && sameIndices(existing.indices, usable)) return;
  const after = before.filter(r => r.name !== name).concat([{ name, indices: [...usable] }]);
  runOnPalette(services, paletteId, 'name ramp',
    p => { p.ramps = cloneRamps(after); },
    p => { p.ramps = cloneRamps(before); });
}

export function deleteRamp(services, paletteId, name) {
  const target = paletteById(services, paletteId);
  if (!target) return;
  const before = cloneRamps(target.ramps);
  if (!before.some(r => r.name === name)) return;
  const after = before.filter(r => r.name !== name);
  runOnPalette(services, paletteId, 'delete ramp',
    p => { p.ramps = cloneRamps(after); },
    p => { p.ramps = cloneRamps(before); });
}
