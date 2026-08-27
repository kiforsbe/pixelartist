// js/modes/sprites/presentation/slice-grid-dialog.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { markDefaultAction } from '../../../components/dialogs.js';

// Live Slice-grid preview: the dialog's current values while it is open, else
// null. The sheet view handle lets dialog input events trigger repaints.
let slicePreviewOpts = null;
let sheetViewForPreview = null;

export function slicePreviewOptions() { return slicePreviewOpts; }
export function setSlicePreviewView(view) { sheetViewForPreview = view; }

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it — this file lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host?.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

export function buildSliceDialog() {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h3>Slice grid</h3>
    <div class="row"><label>Cell W <input type="number" id="sg-cellw" min="1" value="16"></label></div>
    <div class="row"><label>Cell H <input type="number" id="sg-cellh" min="1" value="16"></label></div>
    <div class="row"><label>Margin X <input type="number" id="sg-marginx" min="0" value="0"></label></div>
    <div class="row"><label>Margin Y <input type="number" id="sg-marginy" min="0" value="0"></label></div>
    <div class="row"><label>Spacing X <input type="number" id="sg-spacingx" min="0" value="0"></label></div>
    <div class="row"><label>Spacing Y <input type="number" id="sg-spacingy" min="0" value="0"></label></div>
    <div class="row"><label>Prefix <input type="text" id="sg-prefix" value="frame"></label></div>
    <div class="row"><label><input type="checkbox" id="sg-replace"> Replace existing frames</label></div>
    <div class="row dlg-actions"><button type="button" id="sg-create">Create</button><button type="button" id="sg-cancel">Cancel</button></div>
  `;
  document.body.appendChild(dlg);
  const $ = (sel) => dlg.querySelector(sel);
  const intVal = (el, min) => Math.max(min, parseInt(el.value, 10) || min);
  const readPreview = () => ({
    cellW: intVal($('#sg-cellw'), 1), cellH: intVal($('#sg-cellh'), 1),
    marginX: intVal($('#sg-marginx'), 0), marginY: intVal($('#sg-marginy'), 0),
    spacingX: intVal($('#sg-spacingx'), 0), spacingY: intVal($('#sg-spacingy'), 0),
  });
  for (const id of ['#sg-cellw', '#sg-cellh', '#sg-marginx', '#sg-marginy', '#sg-spacingx', '#sg-spacingy'])
    $(id).addEventListener('input', () => {
      if (!slicePreviewOpts) return;
      slicePreviewOpts = readPreview();
      sheetViewForPreview?.requestRender();
    });
  dlg.addEventListener('close', () => {
    slicePreviewOpts = null;
    sheetViewForPreview?.requestRender();
  });
  markDefaultAction(dlg, $('#sg-create'));
  $('#sg-cancel').addEventListener('click', () => dlg.close());
  $('#sg-create').addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    if (!sheet) { dlg.close(); return; }
    const options = { ...readPreview(), namePrefix: $('#sg-prefix').value.trim() || 'frame' };
    dispatch('sprites.sliceGrid', { sheetId: sheet.id, options, replace: $('#sg-replace').checked });
    dlg.close();
  });
  return {
    open() {
      slicePreviewOpts = readPreview();
      dlg.showModal();
      sheetViewForPreview?.requestRender();
    },
  };
}
