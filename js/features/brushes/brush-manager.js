// The brush manager dialog.
//
// Non-modal (.show(), not .showModal()) on purpose -- same reasoning as the
// palette manager: trying a brush out on the canvas while the manager is
// open has to keep the canvas reachable. Task 15 adds the editing controls
// (rename, mask/ink fields) and the mask editor; Task 16 adds import/export.
// This task is the shell, the read-only grid, and the window-scoped undo
// stack those later tasks will run their commands through.
import { getEditorHost } from '../../host/runtime.js';
import { defineAction } from '../shell/actions.js';
import { makeDialogMovable, centerDialog, closeOnEscape } from '../../components/dialogs.js';
import { isTextEntryTarget } from '../../components/dom-utils.js';
import { CommandStack } from '../../core/commands.js';
import { rasterizeMask } from '../../core/brushes.js';
import { getBrushLibrary } from './brush-library.js';

function host() { return getEditorHost(); }

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

// A small read-only preview of the mask, the same "canvas thumbnail inside a
// swatch button" idiom the maps mode brush picker uses (map-assets-panel.js)
// -- drawn from rasterizeMask's 1-bit grid rather than sampled from a sheet.
// Downscaling (a 256x256 custom mask) and upscaling (a 1x1 square) both go
// through the same drawImage call, centered and unsmoothed, so neither
// extreme has a special case.
const ICON_SIZE = 40;
function drawBrushIcon(canvas, brush) {
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

// Module-scoped so a future toolbar entry point and the Edit-menu action
// open the same dialog instance rather than each finding it themselves --
// same pattern as palette-manager.js's openManager/openPaletteManager.
let openManager = () => {};
export function openBrushManager() { openManager(); }

export function mountBrushManager() {
  const dlg = document.getElementById('dlg-brushes');
  if (!dlg) return;

  const grid = dlg.querySelector('#bm-grid');
  const btnUndo = dlg.querySelector('#bm-undo');
  const btnRedo = dlg.querySelector('#bm-redo');
  const btnClose = dlg.querySelector('#bm-close');

  // The shared instance, not a private createBrushLibrary() closure -- Task
  // 15's tool-palette brush picker will call getBrushLibrary() too, and must
  // see this dialog's edits (and vice versa) without a page reload.
  const lib = getBrushLibrary(host().preferences);

  function refreshGrid() {
    grid.innerHTML = '';
    for (const brush of lib.list()) {
      const card = document.createElement('div');
      card.className = 'bm-card';
      card.title = `${brush.name} — ${brush.mask.kind} mask, ${brush.ink.kind} ink`;
      const icon = document.createElement('canvas');
      icon.className = 'bm-icon';
      drawBrushIcon(icon, brush);
      const label = document.createElement('span');
      label.className = 'bm-name';
      label.textContent = brush.name;
      card.append(icon, label);
      grid.appendChild(card);
    }
  }

  function updateHistoryButtons() {
    btnUndo.disabled = !history.canUndo();
    btnRedo.disabled = !history.canRedo();
  }

  const history = createBrushHistory(updateHistoryButtons);
  updateHistoryButtons();

  // Re-render whenever the library mutates, from any source (a Task 15
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
  // guard: this dialog has a brush-name input (Task 15), and without the
  // guard, typing a name and pressing Ctrl+Z would undo a brush command
  // instead of the text edit, swallowing the native undo the user expects.
  dlg.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (isTextEntryTarget(e.target) || isTextEntryTarget(document.activeElement)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); history.undo(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); history.redo(); }
  });

  // One listener on `close` (not the Close button's click handler) covers
  // Escape, the button, and any programmatic close alike -- a native
  // <dialog> fires `close` on all three. Clearing only from the button
  // would leave the stack live after Escape, so the next open would inherit
  // the previous session's undo history: exactly the window-scoping this
  // task exists to provide.
  dlg.addEventListener('close', () => history.clear());

  makeDialogMovable(dlg, dlg.querySelector('h3'));
  closeOnEscape(dlg, () => dlg.close());
  btnClose.addEventListener('click', () => dlg.close());

  openManager = () => {
    if (dlg.open) return;
    refreshGrid();
    dlg.show();
    if (!dlg.style.left) centerDialog(dlg);
  };

  defineAction('edit.brushes', {
    label: 'Brushes…',
    run: openBrushManager,
  });
}
