// js/modes/sprites/presentation/frames-panel.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { segmentsOf } from '../../../core/strips.js';
import { stripForFrame } from '../../../domain/sprites/strips.js';
import { frameBounds } from '../../../domain/sprites/frames.js';
import { stripMembers } from '../application/frame-geometry.js';
import { mountStorePanel } from '../../../components/panel-mount.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly — this panel lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function numericField(labelText, value, { step, onCommit }) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  if (step != null) input.step = String(step);
  input.value = String(value);
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => onCommit(Number(input.value)));
  label.appendChild(input);
  return label;
}

export function mountFramesPanel(element) {
  const panel = document.createElement('div');
  element.appendChild(panel);

  const heading = document.createElement('h3');
  heading.textContent = 'Frames';
  panel.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'frame-list';
  panel.appendChild(list);

  const breakApartButton = document.createElement('button');
  breakApartButton.type = 'button';
  breakApartButton.className = 'btn-icon-md';
  breakApartButton.textContent = '✂';
  breakApartButton.title = 'Break apart';
  breakApartButton.addEventListener('click', () => {
    const sheet = activeSheet('sprite');
    if (!sheet) return;
    const frameId = getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null;
    if (!frameId) return;
    const strip = stripForFrame(sheet, frameId);
    if (strip) dispatch('sprites.breakApartStrip', { sheetId: sheet.id, animationId: strip.id });
  });

  function actionsRow(sheet, frame, inStrip) {
    const actions = document.createElement('div');
    actions.className = 'row';

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'btn-icon-md';
    editButton.textContent = '✎';
    editButton.title = 'Edit';
    editButton.addEventListener('click', () => {
      const host = getEditorHost();
      host.selections.patch({ editingFrameId: frame.id }, sheetDocument(sheet));
      host.store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn-icon-md';
    deleteButton.textContent = '🗑';
    deleteButton.title = inStrip ? 'Delete frame' : 'Delete';
    deleteButton.addEventListener('click', () => {
      const strip = stripForFrame(sheet, frame.id);
      if (strip) dispatch('sprites.removeStripMember', { sheetId: sheet.id, animationId: strip.id, frameId: frame.id });
      else dispatch('sprites.deleteFrame', { sheetId: sheet.id, frameId: frame.id });
    });

    actions.append(editButton, deleteButton);
    if (inStrip) actions.appendChild(breakApartButton);
    return actions;
  }

  function renderFrameDetail(sheet, frame) {
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const setField = (key, value) => dispatch('sprites.setFrameField', { sheetId: sheet.id, frameId: frame.id, key, value });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = frame.name;
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (value) setField('name', value);
      else nameInput.value = frame.name;
    });

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', frame.x, { onCommit: value => setField('x', Math.round(value)) }),
      numericField('Y', frame.y, { onCommit: value => setField('y', Math.round(value)) }),
      numericField('W', frame.w, { onCommit: value => setField('w', Math.max(1, Math.round(value))) }),
      numericField('H', frame.h, { onCommit: value => setField('h', Math.max(1, Math.round(value))) }),
      numericField('PivotX', frame.pivotX, { step: 0.5, onCommit: value => setField('pivotX', value) }),
      numericField('PivotY', frame.pivotY, { step: 0.5, onCommit: value => setField('pivotY', value) }),
    );

    row.append(nameInput, fields, actionsRow(sheet, frame, false));
    list.appendChild(row);
  }

  function renderStripDetail(sheet, animation, selectedFrame) {
    const members = stripMembers(sheet, animation);
    if (!members.length) return;
    const bounds = frameBounds(members);
    const segmentCount = segmentsOf(animation).length;
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const title = document.createElement('div');
    title.className = 'frame-field';
    title.textContent = `Strip · ${members.length} frames${segmentCount > 1 ? ` · ${segmentCount} sub-strips` : ''}`;

    const args = extra => ({ sheetId: sheet.id, animationId: animation.id, ...extra });
    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', bounds.x, { onCommit: value => dispatch('sprites.moveStripTo', args({ x: value, y: bounds.y })) }),
      numericField('Y', bounds.y, { onCommit: value => dispatch('sprites.moveStripTo', args({ x: bounds.x, y: value })) }),
      numericField('W', members[0].w, { onCommit: value => dispatch('sprites.setStripFrameSize', args({ key: 'w', value })) }),
      numericField('H', members[0].h, { onCommit: value => dispatch('sprites.setStripFrameSize', args({ key: 'h', value })) }),
      numericField('PivotX', members[0].pivotX, { step: 0.5, onCommit: value => dispatch('sprites.setStripPivot', args({ key: 'pivotX', value })) }),
      numericField('PivotY', members[0].pivotY, { step: 0.5, onCommit: value => dispatch('sprites.setStripPivot', args({ key: 'pivotY', value })) }),
    );

    row.append(title, fields, actionsRow(sheet, selectedFrame, true));
    list.appendChild(row);
  }

  function render() {
    if (getEditorHost().store.getState().session.activeModeId !== 'sprites') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    list.innerHTML = '';
    const sheet = activeSheet('sprite');
    const selectedFrameId = sheet ? (getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null) : null;
    const frame = sheet?.frames.find(candidate => candidate.id === selectedFrameId) ?? null;
    if (!sheet) return;
    if (!frame) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = 'No frame selected — click one with the frame tool.';
      list.appendChild(hint);
      return;
    }
    const strip = stripForFrame(sheet, frame.id);
    if (strip) renderStripDetail(sheet, strip, frame);
    else renderFrameDetail(sheet, frame);
  }

  const host = getEditorHost();
  const panelMount = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeViewId,
    s => s.session.activeDocument,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render);
  const disposeHistory = host.history.subscribe(() => panelMount.scheduleRender());
  return { ...panelMount, dispose() { disposeHistory(); panelMount.dispose(); } };
}
