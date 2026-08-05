import { state, on, emit, activeSheet } from '../../app/state.js';
import { segmentsOf } from '../../core/strips.js';
import { stripForFrame } from '../../domain/sprites/strips.js';
import { frameBounds } from '../../domain/sprites/frames.js';
import { commitBreakApartStrip } from '../../features/animations/commands.js';
import {
  commitFrameField, stripMembers, moveStripTo, setStripFrameSize, setStripPivot,
} from '../../features/animations/frame-metadata.js';
import { deleteFrame, commitRemoveMember } from './sprite-sheet-controller.js';

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
    const sheet = activeSheet();
    if (!sheet || !state.selectedFrameId) return;
    const strip = stripForFrame(sheet, state.selectedFrameId);
    if (strip) commitBreakApartStrip(strip);
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
      state.editingFrameId = frame.id;
      state.view = 'frame';
      emit('view');
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn-icon-md';
    deleteButton.textContent = '🗑';
    deleteButton.title = inStrip ? 'Delete frame' : 'Delete';
    deleteButton.addEventListener('click', () => {
      const strip = stripForFrame(sheet, frame.id);
      if (strip) commitRemoveMember(sheet, strip, frame.id);
      else deleteFrame(sheet, frame.id);
    });

    actions.append(editButton, deleteButton);
    if (inStrip) actions.appendChild(breakApartButton);
    return actions;
  }

  function renderFrameDetail(sheet, frame) {
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = frame.name;
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (value) commitFrameField(frame, 'name', value);
      else nameInput.value = frame.name;
    });

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', frame.x, { onCommit: value => commitFrameField(frame, 'x', Math.round(value)) }),
      numericField('Y', frame.y, { onCommit: value => commitFrameField(frame, 'y', Math.round(value)) }),
      numericField('W', frame.w, { onCommit: value => commitFrameField(frame, 'w', Math.max(1, Math.round(value))) }),
      numericField('H', frame.h, { onCommit: value => commitFrameField(frame, 'h', Math.max(1, Math.round(value))) }),
      numericField('PivotX', frame.pivotX, { step: 0.5, onCommit: value => commitFrameField(frame, 'pivotX', value) }),
      numericField('PivotY', frame.pivotY, { step: 0.5, onCommit: value => commitFrameField(frame, 'pivotY', value) }),
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

    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', bounds.x, { onCommit: value => moveStripTo(sheet, members, value, bounds.y) }),
      numericField('Y', bounds.y, { onCommit: value => moveStripTo(sheet, members, bounds.x, value) }),
      numericField('W', members[0].w, { onCommit: value => setStripFrameSize(sheet, animation, members, 'w', value) }),
      numericField('H', members[0].h, { onCommit: value => setStripFrameSize(sheet, animation, members, 'h', value) }),
      numericField('PivotX', members[0].pivotX, { step: 0.5, onCommit: value => setStripPivot(members, 'pivotX', value) }),
      numericField('PivotY', members[0].pivotY, { step: 0.5, onCommit: value => setStripPivot(members, 'pivotY', value) }),
    );

    row.append(title, fields, actionsRow(sheet, selectedFrame, true));
    list.appendChild(row);
  }

  function render() {
    if (state.mode !== 'sprites') {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    list.innerHTML = '';
    const sheet = activeSheet();
    const frame = sheet?.frames.find(candidate => candidate.id === state.selectedFrameId) ?? null;
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

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => {
      renderQueued = false;
      render();
    });
  }

  const subscriptions = [
    on('project', scheduleRender),
    on('history', scheduleRender),
    on('view', scheduleRender),
    on('selection', scheduleRender),
  ];
  render();
  return { dispose() { subscriptions.forEach(dispose => dispose()); } };
}
