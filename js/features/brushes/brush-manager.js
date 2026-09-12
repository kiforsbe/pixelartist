// The brush manager dialog.
//
// Non-modal (.show(), not .showModal()) on purpose -- same reasoning as the
// palette manager: trying a brush out on the canvas while the manager is
// open has to keep the canvas reachable. Task 14 built the shell (the
// read-only grid and the window-scoped undo stack). Task 15a added
// selection, the editing controls, and the live stroke preview. Task 15b
// (this diff) adds Make Brush From Selection and the footer's import/export
// buttons -- the tool-palette picker strip itself lives in tool-palette.js,
// which reuses this file's drawBrushIcon rather than duplicating it.
import { getEditorHost } from '../../host/runtime.js';
import { defineAction } from '../shell/actions.js';
import { makeDialogMovable, centerDialog, closeOnEscape } from '../../components/dialogs.js';
import { isTextEntryTarget } from '../../components/dom-utils.js';
import { CommandStack } from '../../core/commands.js';
import {
  rasterizeMask, maskGridFor, validateBrush, brushesEqual,
  MASK_KINDS, INK_KINDS, PRESSURE_TARGETS, PRESSURE_CURVES, PRESSURE_RANGES,
  MAX_MASK_SIZE, MAX_CUSTOM_BITMAP_DIM,
} from '../../core/brushes.js';
import { opacityLevel, PATTERNS } from '../../core/dither.js';
import { strokeStamps } from '../../core/brush-stroke.js';
import { makeInk } from '../../core/brush-ink.js';
import { createBitmap, stamp } from '../../core/pixels.js';
import { brushFromSelection, boundedBrushRegion } from '../../core/brush-io.js';
import { flattenSheet } from '../../core/model.js';
import { getBrushLibrary, mergeIncoming } from './brush-library.js';
import { exportBrush, importBrush } from './brush-files.js';
import { commitFloatIfAny, currentEditRegion, hasSelection } from '../../components/canvas/float-session.js';
import { activeSheet } from '../../host/document-helpers.js';

function host() { return getEditorHost(); }

function activePalette() {
  const p = host().projects.project;
  if (!p) return null;
  return p.palettes.find(pl => pl.id === p.activePaletteId) ?? null;
}

// Brush edits undo HERE, never in project history. Brushes are editor
// configuration; palettes and pixels are project content. Mixing the two
// would mean undoing a sprite edit could silently resize a brush, and
// undoing a brush rename could resurrect deleted pixels.
//
// CommandStack performs the command itself and names that method `do`
// (push/redo both call it). Brush commands are authored as
// {label, redo, undo} -- the shape Task 15's editing controls are written
// against, and the shape these tests lock in -- so translate at this one
// boundary instead of leaking `do` outward or double-executing by calling
// cmd.redo() AND handing the same object to stack.push().
//
// `onChange` is optional and does not touch the {run,undo,redo,canUndo,
// canRedo,clear} contract above: passing it lets a caller (the dialog)
// keep its Undo/Redo buttons in sync from one place -- CommandStack's own
// onChange hook -- instead of calling a manual refresh after every run(),
// undo(), redo() and clear() call site.
export function createBrushHistory(onChange) {
  const stack = new CommandStack(100);
  if (onChange) stack.onChange = onChange;
  return {
    run(cmd) { stack.push({ label: cmd.label, do: cmd.redo, undo: cmd.undo }); },
    undo() { stack.undo(); },
    redo() { stack.redo(); },
    canUndo: () => stack.canUndo(),
    canRedo: () => stack.canRedo(),
    clear: () => stack.clear(),
  };
}

// --- the edit-command shape, factored out of the DOM ------------------
//
// Exported as a factory -- taking `library`/`history`/`getCurrentId`/
// `refresh` as arguments rather than closing over a mounted dialog's own
// variables -- so the edit-command shape (the plan's `editBrush`) and the
// no-dead-step guard are unit-testable without a DOM: `node --test` has no
// `document`, so mountBrushManager itself cannot run in a test, but the
// logic it delegates to here can. mountBrushManager below is a thin DOM
// adapter over this.
//
// Returns `{ ok: true, reason: '' }` on a committed edit OR a guarded no-op
// (both are "nothing went wrong"), `{ ok: false, reason }` when
// `validateBrush` rejected the result (nothing is written), and `null` when
// there is no current brush to edit at all.
export function createBrushEditor(library, history, getCurrentId, refresh) {
  return function editBrush(label, mutate) {
    const id = getCurrentId();
    const brush = id ? library.get(id) : null;
    if (!brush) return null;
    // structuredClone, never a JSON round-trip: a custom mask's
    // mask.bitmap.bits is a Uint8Array, which JSON.stringify turns into a
    // plain {"0":1,...} object -- and Uint8Array.from on THAT (brush-io.js's
    // fromPlain) comes back EMPTY, because a plain object with no `.length`
    // is treated as zero-length array-like. This branch has shipped that bug
    // once already.
    const before = structuredClone(brush);
    const after = mutate(structuredClone(before));
    // A <select> or a number input fires `change` even when it merely
    // re-confirms the value it already had. Recording that as a step would
    // put a no-op onto the undo stack -- palette-commands.js's
    // setPaletteLock and nameRamp guard the identical case for the identical
    // reason.
    if (brushesEqual(before, after)) return { ok: true, reason: '' };
    const check = validateBrush(after);
    if (!check.ok) return check;
    history.run({
      label,
      redo: () => { library.update(after); refresh(); },
      undo: () => { library.update(before); refresh(); },
    });
    return { ok: true, reason: '' };
  };
}

// --- coercing a free-typed field, consistently with a rejected one -------
//
// HTML min/max attributes are advisory (a user can type 9999 straight past
// them), and normalizeBrush's own clampInt (via library.update, inside
// editBrush above) is the real safety net -- but it clamps SILENTLY.
// Picking `stamp` on a square mask gets an explicit reason and a reverted
// control (validateBrush); typing 9999 into spacing used to just reappear
// as 64 with nothing said. That inconsistency, not the clamping itself
// (which normalizeBrush already does correctly), is the defect.
//
// Both exported, taking the already-committing `editBrush` as an argument
// rather than an <input> element, for the same DOM-independence reason
// createBrushEditor itself is a factory: a node:test file can commit a
// value and inspect both the RESULT (does the library actually hold the
// clamped number?) and the MESSAGE (would the user have been told?)
// without a document. mountBrushManager's commitNumberField/commitName
// below are the only DOM-touching callers, reading `min`/`max` off the
// input's own attributes rather than a second, divergent copy of any bound
// (MAX_MASK_SIZE, the HTML literals, or -- for the pressure pair --
// PRESSURE_RANGES, already wired onto those two inputs by refreshControls).
//
// A rejected edit (validateBrush) already explains itself via editBrush's
// own return value; `message` here is null whenever that path fired (no
// separate value was actually committed to compare against), so a caller
// showing both never shows two contradictory explanations at once.
export function commitCoercedNumber(editBrush, label, typed, min, max, apply) {
  const n = Number(typed);
  const clamped = Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min;
  const result = editBrush(label, b => { apply(b, clamped); return b; });
  const changed = result && result.ok && clamped !== n;
  const shown = String(typed).trim() === '' ? '(blank)' : `"${typed}"`;
  return { result, value: clamped, message: changed ? `${shown} is out of range -- used ${clamped} instead.` : null };
}

// The same inconsistency, one field over: an emptied name silently becomes
// "Brush" via normalizeBrush's own fallback. Same shape, same treatment.
export function commitCoercedName(editBrush, label, typed) {
  const trimmed = typed.trim();
  const value = trimmed || 'Brush';
  const result = editBrush(label, b => { b.name = value; return b; });
  const changed = result && result.ok && !trimmed;
  return { result, value, message: changed ? `Name can't be empty -- used "Brush" instead.` : null };
}

// --- the live preview, also factored out of the DOM --------------------
//
// A short, deterministic S-curve: flat-ish at both ends and steep through
// the middle (a tanh, not a sine) so the path is monotonic in x and covers
// a good spread of y -- enough for spacing/scatter/rotate-jitter to have
// somewhere to show themselves, and short enough to read at a glance.
function sCurvePoints(width, height) {
  const marginX = Math.max(3, Math.round(width * 0.12));
  const marginY = Math.max(3, Math.round(height * 0.15));
  const x0 = marginX, x1 = width - marginX;
  const midY = height / 2;
  const amp = midY - marginY;
  const steps = Math.max(2, x1 - x0);
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: Math.round(x0 + t * (x1 - x0)),
      y: Math.round(midY - amp * Math.tanh((t - 0.5) * 6)),
    });
  }
  return points;
}

// Exported so the composed preview is testable without a DOM -- no <canvas>
// is touched here, only the real engine primitives (strokeStamps,
// maskGridFor, makeInk, createBitmap, stamp), which is the whole point: a
// preview that approximated the engine (e.g. drew a solid line at reduced
// alpha) would hide exactly the dither-opacity-is-density interaction it
// exists to reveal. mountBrushManager's drawPreview() blits the returned
// bitmap onto a canvas; that step is the only DOM-touching part.
export function renderBrushPreview(brush, context, { width = 64, height = 64 } = {}) {
  const bmp = createBitmap(width, height);
  const seed = context.seed ?? 1;
  const ink = makeInk(brush, { ...context, seed });
  for (const s of strokeStamps(sCurvePoints(width, height), brush.mask, seed)) {
    const grid = maskGridFor(brush.mask, { rotate: s.rotate });
    stamp(bmp, s.x, s.y, context.primary, brush.mask.size, ink, grid);
  }
  return bmp;
}

// --- import: the whole flow minus the file picker (fix round 1) ---------
//
// Exported, taking `pickImport` (importBrush from brush-files.js, in
// production) as an argument rather than calling it directly -- the same
// DOM-independence reason createBrushEditor/commitCoercedNumber above are
// factories: `node --test` has no `window`/`document`/File System Access,
// so importBrush() itself cannot run in a test, but the try/catch, the
// mergeIncoming accounting, and the resulting user-facing message all can.
// mountBrushManager's click handler below is the thin DOM adapter.
//
// importBrush() throws from decodePng (a corrupt PNG), from
// parseBrushJson/parseLibraryJson via parseImportedBrushJson ('Not a brush
// file' / 'Not a brush library file'), and from assertSaneCustomBitmap
// (Task 11's hostile-custom-bitmap guard) -- all three deliberately, rather
// than degrading to a garbage brush. Catching but swallowing that here would
// hand back exactly the silence Task 11 exists to prevent, so every failure
// comes back as `{ ok: false, message }` instead of escaping this function.
export async function performBrushImport(lib, pickImport) {
  let result;
  try {
    result = await pickImport();
  } catch (e) {
    return { ok: false, message: e.message };
  }
  if (!result) return { ok: true, message: null }; // cancelled picker
  // importBrush() returns a single Brush for a .png or a single-brush
  // .json, or an ARRAY for a whole-library .json (serializeLibraryJson's
  // own shape) -- mergeIncoming wants a list either way.
  const incoming = Array.isArray(result) ? result : [result];
  // mergeIncoming only REPORTS which ids are new (brush-library.js) -- it
  // never mutates, so a re-imported brush that already exists (matched by
  // id) is left alone here rather than silently overwritten. Both counts
  // are reported: an import that adds nothing because everything already
  // existed must not look, from the user's side, identical to one that
  // silently failed.
  const { added, existing } = mergeIncoming(lib, incoming);
  for (const brush of added) lib.add(brush);
  const addedLabel = `${added.length} brush${added.length === 1 ? '' : 'es'}`;
  const message = existing.length
    ? `Imported ${addedLabel} (${existing.length} already in your library).`
    : `Imported ${addedLabel}.`;
  return { ok: true, message, added, existing };
}

// A small read-only preview of the mask, the same "canvas thumbnail inside a
// swatch button" idiom the maps mode brush picker uses (map-assets-panel.js)
// -- drawn from rasterizeMask's 1-bit grid rather than sampled from a sheet.
// Downscaling (a 256x256 custom mask) and upscaling (a 1x1 square) both go
// through the same drawImage call, centered and unsmoothed, so neither
// extreme has a special case.
//
// Exported (Task 15b) so the tool-palette brush picker strip can draw the
// identical thumbnail instead of a second implementation -- see that file's
// own comment on why reusing this, not rewriting it, is the right call.
const ICON_SIZE = 40;
export function drawBrushIcon(canvas, brush) {
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
  const grid = rasterizeMask(brush.mask);
  const off = document.createElement('canvas');
  off.width = grid.width;
  off.height = grid.height;
  const octx = off.getContext('2d');
  const img = octx.createImageData(grid.width, grid.height);
  for (let i = 0; i < grid.bits.length; i++) {
    const p = i * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = 214; // approximates --fg (#d6d7dc), close enough at 40px
    img.data[p + 3] = grid.bits[i] ? 255 : 0;
  }
  octx.putImageData(img, 0, 0);
  const scale = Math.min(ICON_SIZE / grid.width, ICON_SIZE / grid.height);
  const dw = Math.max(1, Math.round(grid.width * scale));
  const dh = Math.max(1, Math.round(grid.height * scale));
  ctx.drawImage(off, 0, 0, grid.width, grid.height,
    Math.floor((ICON_SIZE - dw) / 2), Math.floor((ICON_SIZE - dh) / 2), dw, dh);
}

// Quarter turns only -- MASK_KINDS/INK_KINDS/PRESSURE_TARGETS/
// PRESSURE_CURVES/PATTERNS all come from an exported source of truth so a
// kind added later cannot silently go missing from this dialog, but rotate
// has no such table (it is a structural fact -- rotateMaskGrid only ever
// turns in multiples of 90 -- not a vocabulary that grows), so it is listed
// here rather than invented as a fake export.
const ROTATE_OPTIONS = [0, 90, 180, 270];
const PREVIEW_SIZE = 64;
// Fixed rather than random: the preview exists so a setting's EFFECT is
// visible, and a reshuffling seed on every refresh would make a scatter or
// rotate-jitter brush's preview crawl instead of holding still to look at.
const PREVIEW_SEED = 0x6272756e; // 'brun', arbitrary but stable

// Module-scoped so a future toolbar entry point and the Edit-menu action
// open the same dialog instance rather than each finding it themselves --
// same pattern as palette-manager.js's openManager/openPaletteManager.
let openManager = () => {};
export function openBrushManager() { openManager(); }

export function mountBrushManager() {
  const dlg = document.getElementById('dlg-brushes');
  if (!dlg) return;

  const el = id => dlg.querySelector(`#${id}`);
  const grid = el('bm-grid');
  const btnUndo = el('bm-undo');
  const btnRedo = el('bm-redo');
  const btnImport = el('bm-import');
  const exportFormat = el('bm-export-format');
  const btnExport = el('bm-export');
  const btnClose = el('bm-close');
  const errorEl = el('bm-error');
  const controls = el('bm-controls');
  const previewCanvas = el('bm-preview');

  const nameInput = el('bm-name');
  const maskKind = el('bm-mask-kind');
  const maskSize = el('bm-mask-size');
  const maskSpacing = el('bm-mask-spacing');
  const maskScatter = el('bm-mask-scatter');
  const maskRotate = el('bm-mask-rotate');
  const maskFlipH = el('bm-mask-fliph');
  const maskFlipV = el('bm-mask-flipv');
  const maskRotateJitter = el('bm-mask-rotate-jitter');
  const inkKind = el('bm-ink-kind');
  const inkOpacity = el('bm-ink-opacity');
  const inkOpacityLevel = el('bm-ink-opacity-level');
  const inkTrueAlpha = el('bm-ink-truealpha');
  const inkJitter = el('bm-ink-jitter');
  const inkPattern = el('bm-ink-pattern');
  const pressureTarget = el('bm-pressure-target');
  const pressureMin = el('bm-pressure-min');
  const pressureMax = el('bm-pressure-max');
  const pressureCurve = el('bm-pressure-curve');

  // The shared instance, not a private createBrushLibrary() closure -- the
  // tool-palette brush picker (Task 15b) will call getBrushLibrary() too,
  // and must see this dialog's edits (and vice versa) without a page reload.
  const lib = getBrushLibrary(host().preferences);

  // Selected brush id within the current library session; null for none.
  // Not persisted across dialog opens -- the shell's `close` handler already
  // clears the undo stack for the same "window-scoped" reasoning, and a
  // selection is meaningless once that context is gone.
  let selectedId = null;

  function fillOptions(select, values, labelFor = String) {
    select.innerHTML = '';
    for (const v of values) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = labelFor(v);
      select.appendChild(o);
    }
  }
  // Driven from the exported lists (brushes.js, dither.js), never a
  // hand-written option array -- a kind added later shows up here for free.
  fillOptions(maskKind, MASK_KINDS);
  fillOptions(maskRotate, ROTATE_OPTIONS, v => `${v}°`);
  fillOptions(inkKind, INK_KINDS);
  fillOptions(inkPattern, Object.keys(PATTERNS));
  fillOptions(pressureTarget, PRESSURE_TARGETS);
  fillOptions(pressureCurve, PRESSURE_CURVES);
  maskSize.max = String(MAX_MASK_SIZE);

  function refreshGrid() {
    grid.innerHTML = '';
    for (const brush of lib.list()) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'bm-card';
      if (brush.id === selectedId) card.classList.add('is-selected');
      card.title = `${brush.name} — ${brush.mask.kind} mask, ${brush.ink.kind} ink`;
      const icon = document.createElement('canvas');
      icon.className = 'bm-icon';
      drawBrushIcon(icon, brush);
      const label = document.createElement('span');
      label.className = 'bm-name';
      label.textContent = brush.name;
      card.append(icon, label);
      card.addEventListener('click', () => {
        selectedId = brush.id;
        for (const c of grid.children) c.classList.toggle('is-selected', c === card);
        refreshControls();
      });
      grid.appendChild(card);
    }
  }

  function updateHistoryButtons() {
    btnUndo.disabled = !history.canUndo();
    btnRedo.disabled = !history.canRedo();
  }

  const history = createBrushHistory(updateHistoryButtons);
  updateHistoryButtons();

  const editBrush = createBrushEditor(lib, history, () => selectedId, refreshControls);

  // A rejected edit (validateBrush) writes nothing, so the control that
  // triggered it is now showing a value the library never actually took --
  // refreshControls() below puts it back. A guarded no-op or a real commit
  // both leave the library already matching what the controls show, so a
  // refresh there would be redundant (the commit path gets one anyway, via
  // editBrush's own `redo`/`undo`).
  function showEditResult(result) {
    if (!result) return;
    if (!result.ok) {
      // refreshControls() runs FIRST and clears the error banner as part of
      // its own reset -- it also puts the control that triggered this back
      // to the value the library actually holds, since nothing was written.
      // The explicit assignment below has to come after, or the message it
      // sets would be wiped by the very call meant to show it.
      refreshControls();
      errorEl.hidden = false;
      errorEl.textContent = result.reason;
      return;
    }
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  // Bounds come off the input's OWN min/max attributes -- already sourced
  // from MAX_MASK_SIZE, the HTML literals, or PRESSURE_RANGES (for the
  // pressure pair, kept current by refreshControls) -- so this is not a
  // second, divergent copy of any of those numbers. showEditResult still
  // handles a validateBrush rejection (and reverts the control); this only
  // adds a message on the path that does not reject anything, so the two
  // never talk over each other.
  function commitNumberField(input, label, apply) {
    const { result, message } = commitCoercedNumber(editBrush, label, input.value, Number(input.min), Number(input.max), apply);
    showEditResult(result);
    if (message) { errorEl.hidden = false; errorEl.textContent = message; }
  }

  function commitNameField(input, label) {
    const { result, message } = commitCoercedName(editBrush, label, input.value);
    showEditResult(result);
    if (message) { errorEl.hidden = false; errorEl.textContent = message; }
  }

  function drawPreview(brush) {
    const ctx = previewCanvas.getContext('2d');
    previewCanvas.width = PREVIEW_SIZE;
    previewCanvas.height = PREVIEW_SIZE;
    if (!brush) { ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE); return; }
    const drawing = host().store.getState().workspace.drawing;
    const bmp = renderBrushPreview(brush, {
      primary: drawing.primary,
      secondary: drawing.secondary,
      palette: activePalette(),
      seed: PREVIEW_SEED,
    }, { width: PREVIEW_SIZE, height: PREVIEW_SIZE });
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(new ImageData(bmp.data, bmp.width, bmp.height), 0, 0);
  }

  // Controls only. The grid re-renders itself through lib.subscribe below,
  // registered once at mount -- this function must never also touch it, or
  // a single edit repaints the grid twice from two independent paths.
  function refreshControls() {
    const brush = selectedId ? lib.get(selectedId) : null;
    controls.disabled = !brush;
    // Export acts on the SELECTED brush, same gating as the fieldset -- there
    // is nothing to export with no current brush. Import is never gated: it
    // always creates brushes rather than editing the current one.
    btnExport.disabled = !brush;
    errorEl.hidden = true;
    errorEl.textContent = '';
    if (!brush) {
      // Blank every field, not just the name -- with nothing selected, a
      // mask/ink/pressure field still showing the PREVIOUSLY selected
      // brush's values (merely dimmed by the fieldset's own disabled
      // opacity) reads as "these are the current settings" when they are
      // not settings for anything.
      nameInput.value = '';
      maskKind.value = ''; maskSize.value = ''; maskSpacing.value = ''; maskScatter.value = '';
      maskRotate.value = ''; maskFlipH.checked = false; maskFlipV.checked = false; maskRotateJitter.checked = false;
      inkKind.value = ''; inkOpacity.value = ''; inkOpacityLevel.textContent = '';
      inkTrueAlpha.checked = false; inkJitter.value = ''; inkPattern.value = '';
      pressureTarget.value = ''; pressureMin.value = ''; pressureMax.value = ''; pressureCurve.value = '';
      drawPreview(null);
      return;
    }

    nameInput.value = brush.name;

    maskKind.value = brush.mask.kind;
    maskSize.value = String(brush.mask.size);
    // A custom mask's dimensions come from its bitmap, not this field --
    // tool-palette.js:235 disables the canvas-side size input the same way
    // for the same brush.
    maskSize.disabled = brush.mask.kind === 'custom';
    maskSpacing.value = String(brush.mask.spacing);
    maskScatter.value = String(brush.mask.scatter);
    maskRotate.value = String(brush.mask.rotate);
    maskFlipH.checked = brush.mask.flipH;
    maskFlipV.checked = brush.mask.flipV;
    maskRotateJitter.checked = brush.mask.rotateJitter;

    inkKind.value = brush.ink.kind;
    // `stamp` paints a custom mask's own per-cell colors and is meaningless
    // without one -- validateBrush already rejects the combination; this
    // keeps the UI from offering it in the first place.
    const stampOption = inkKind.querySelector('option[value="stamp"]');
    if (stampOption) stampOption.disabled = brush.mask.kind !== 'custom';
    inkOpacity.value = String(brush.ink.opacity);
    inkOpacityLevel.textContent = `≈ level ${opacityLevel(brush.ink.opacity)}/16`;
    inkTrueAlpha.checked = brush.ink.trueAlpha;
    inkJitter.value = String(brush.ink.jitter);
    inkPattern.value = brush.ink.pattern;

    pressureTarget.value = brush.pressure.target;
    // Retargets the min/max inputs' own bounds so a shade-step brush is not
    // left offering a max of 100 just because the target used to be
    // `opacity` -- PRESSURE_RANGES is the same table normalizePressure uses
    // for its own per-target defaults.
    const [rMin, rMax] = PRESSURE_RANGES[brush.pressure.target];
    pressureMin.min = String(rMin); pressureMin.max = String(rMax);
    pressureMax.min = String(rMin); pressureMax.max = String(rMax);
    pressureMin.value = String(brush.pressure.min);
    pressureMax.value = String(brush.pressure.max);
    pressureCurve.value = brush.pressure.curve;

    drawPreview(brush);
  }

  // Re-render the GRID whenever the library mutates, from any source (a
  // command running through `history`, or anything else that touches it
  // while the dialog happens to be open) -- one subscription instead of a
  // refresh() call duplicated at every mutation call site.
  lib.subscribe(() => { if (dlg.open) refreshGrid(); });

  btnUndo.addEventListener('click', () => history.undo());
  btnRedo.addEventListener('click', () => history.redo());

  // The global Ctrl+Z/Y handler (document-controller.js) deliberately lets
  // non-modal dialogs through and only bails on a real `:modal` one, so a
  // non-modal manager must claim the key itself before that handler sees
  // it -- a listener on the dialog element runs first since the dialog is
  // deeper in the tree. isTextEntryTarget mirrors that global handler's own
  // guard: this dialog has a brush-name input and several number inputs, and
  // without the guard, typing a name and pressing Ctrl+Z would undo a brush
  // command instead of the text edit, swallowing the native undo the user
  // expects.
  dlg.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (isTextEntryTarget(e.target) || isTextEntryTarget(document.activeElement)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); history.undo(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); history.redo(); }
  });

  // ---- editing controls ----
  // Every field commits on `change` (blur / Enter / a discrete selection),
  // matching palette-manager.js's own controls -- not `input`, which would
  // push a stack entry per keystroke or per drag tick of a range control.

  nameInput.addEventListener('change', () => {
    commitNameField(nameInput, 'rename brush');
  });

  maskKind.addEventListener('change', () => {
    showEditResult(editBrush('brush mask kind', b => { b.mask.kind = maskKind.value; return b; }));
  });
  maskSize.addEventListener('change', () => {
    commitNumberField(maskSize, 'brush mask size', (b, v) => { b.mask.size = v; });
  });
  maskSpacing.addEventListener('change', () => {
    commitNumberField(maskSpacing, 'brush mask spacing', (b, v) => { b.mask.spacing = v; });
  });
  maskScatter.addEventListener('change', () => {
    commitNumberField(maskScatter, 'brush mask scatter', (b, v) => { b.mask.scatter = v; });
  });
  maskRotate.addEventListener('change', () => {
    showEditResult(editBrush('brush mask rotate', b => { b.mask.rotate = Number(maskRotate.value); return b; }));
  });
  maskFlipH.addEventListener('change', () => {
    showEditResult(editBrush('brush mask flip H', b => { b.mask.flipH = maskFlipH.checked; return b; }));
  });
  maskFlipV.addEventListener('change', () => {
    showEditResult(editBrush('brush mask flip V', b => { b.mask.flipV = maskFlipV.checked; return b; }));
  });
  maskRotateJitter.addEventListener('change', () => {
    showEditResult(editBrush('brush mask rotate jitter', b => { b.mask.rotateJitter = maskRotateJitter.checked; return b; }));
  });

  inkKind.addEventListener('change', () => {
    showEditResult(editBrush('brush ink kind', b => { b.ink.kind = inkKind.value; return b; }));
  });
  inkOpacity.addEventListener('change', () => {
    commitNumberField(inkOpacity, 'brush ink opacity', (b, v) => { b.ink.opacity = v; });
  });
  inkTrueAlpha.addEventListener('change', () => {
    showEditResult(editBrush('brush ink true alpha', b => { b.ink.trueAlpha = inkTrueAlpha.checked; return b; }));
  });
  inkJitter.addEventListener('change', () => {
    commitNumberField(inkJitter, 'brush ink jitter', (b, v) => { b.ink.jitter = v; });
  });
  inkPattern.addEventListener('change', () => {
    showEditResult(editBrush('brush ink pattern', b => { b.ink.pattern = inkPattern.value; return b; }));
  });

  pressureTarget.addEventListener('change', () => {
    showEditResult(editBrush('brush pressure target', b => {
      b.pressure.target = pressureTarget.value;
      // The old min/max were tuned for the PREVIOUS target's units (pixels,
      // percent, ramp steps); carrying them across a target switch is how a
      // shade-step brush ends up with a stored max of 100. Reset to the new
      // target's own sensible default rather than leaving stale numbers the
      // widened min/max attributes above would just be hiding.
      const [defMin, defMax] = PRESSURE_RANGES[b.pressure.target];
      b.pressure.min = defMin;
      b.pressure.max = defMax;
      return b;
    }));
  });
  pressureMin.addEventListener('change', () => {
    commitNumberField(pressureMin, 'brush pressure min', (b, v) => { b.pressure.min = v; });
  });
  pressureMax.addEventListener('change', () => {
    commitNumberField(pressureMax, 'brush pressure max', (b, v) => { b.pressure.max = v; });
  });
  pressureCurve.addEventListener('change', () => {
    showEditResult(editBrush('brush pressure curve', b => { b.pressure.curve = pressureCurve.value; return b; }));
  });

  // ---- import / export (Task 15b; fix round 1 made failures and
  // collisions visible through the same #bm-error banner every other
  // failure in this dialog already uses) ----
  // Mirrors palette-manager.js's own import/export wiring: Import always
  // creates new library entries rather than touching the current selection;
  // Export acts on whichever brush is currently selected. The whole import
  // flow lives in performBrushImport (above) so it's testable without a
  // DOM; this handler is the thin adapter that reports its result.
  // One place that decides WHERE a message goes. The dialog's own controls
  // always have the banner in front of the user; `brush.fromSelection` is
  // also reachable from the menu with the dialog shut, where a banner nobody
  // can see is the same as saying nothing -- so that case falls back to the
  // app's usual alert (layers-panel.js, file-controller.js, document-
  // controller.js all report failures that way).
  function notify(message) {
    if (dlg.open) {
      errorEl.hidden = false;
      errorEl.textContent = message;
      return;
    }
    alert(message);
  }

  btnImport.addEventListener('click', async () => {
    const { message } = await performBrushImport(lib, importBrush);
    if (message == null) return; // cancelled picker -- leave the banner as-is
    errorEl.hidden = false;
    errorEl.textContent = message;
  });

  btnExport.addEventListener('click', async () => {
    const brush = selectedId ? lib.get(selectedId) : null;
    if (!brush) return;
    await exportBrush(brush, exportFormat.value);
  });

  // One listener on `close` (not the Close button's click handler) covers
  // Escape, the button, and any programmatic close alike -- a native
  // <dialog> fires `close` on all three. Clearing only from the button
  // would leave the stack live after Escape, so the next open would inherit
  // the previous session's undo history: exactly the window-scoping this
  // task exists to provide.
  dlg.addEventListener('close', () => {
    history.clear();
    selectedId = null;
  });

  makeDialogMovable(dlg, dlg.querySelector('h3'));
  closeOnEscape(dlg, () => dlg.close());
  btnClose.addEventListener('click', () => dlg.close());

  openManager = () => {
    if (dlg.open) return;
    refreshGrid();
    refreshControls();
    dlg.show();
    if (!dlg.style.left) centerDialog(dlg);
  };

  defineAction('edit.brushes', {
    label: 'Brushes…',
    run: openBrushManager,
  });

  // Make Brush From Selection (Task 15b, plan Step 3). Registered here
  // (the brushes feature module), not menu-controller.js -- palette-
  // manager.js's own edit.palettes registration, right above, is the
  // precedent. commitFloatIfAny() mirrors clipboardCapture's own first line
  // (float-session.js): any not-yet-committed floating selection must land
  // on its layer before flattenSheet reads that layer's bitmap, or the
  // capture would miss whatever the user is still mid-drag on.
  defineAction('brush.fromSelection', {
    label: 'Make Brush From Selection',
    run: () => {
      commitFloatIfAny();
      const sheet = activeSheet();
      const rr = sheet ? currentEditRegion() : null;
      if (!sheet || !rr) return;
      // The composite of every visible layer, not activeLayer().bitmap --
      // see brushFromSelection's own comment (js/core/brush-io.js) for why.
      const composite = flattenSheet(sheet);
      // Bounded BEFORE the pixels are read. A marquee over 256px in either
      // axis produced a mask that lib.add refused (fromPlain's hostile-file
      // guard), and CommandRegistry.execute does not catch, so the whole
      // action died in the console: no brush, no active-brush change, no
      // feedback. Import in this same dialog has had a try/catch and the
      // #bm-error banner since fix round 1 for exactly this reason; capture
      // did not. Now both report, through the same banner when the dialog is
      // open and the app's usual alert when it was run from the menu with the
      // dialog closed.
      const region = boundedBrushRegion(rr.region);
      const cropped = region.w !== rr.region.w || region.h !== rr.region.h;
      try {
        const brush = brushFromSelection(composite, region, 'Selection brush');
        lib.add(brush);
        // Fix round 1, ruling 4: the action exists so the user can draw with
        // what they just captured -- leaving it merely added-but-inactive
        // means opening the picker and hunting for it, exactly the extra step
        // this action was supposed to save. store.updateDrawingSettings, the
        // same path tool-palette.js's own swatch click uses -- never a direct
        // `workspace.drawing.brush =` assignment.
        host().store.updateDrawingSettings({ brush });
        if (cropped) {
          notify(`Selection is larger than the ${MAX_CUSTOM_BITMAP_DIM}px brush limit — captured the top-left ${region.w}×${region.h} instead.`);
        }
      } catch (e) {
        notify(`Could not make a brush from this selection: ${e.message}`);
      }
    },
    isEnabled: () => hasSelection(),
  });
}
