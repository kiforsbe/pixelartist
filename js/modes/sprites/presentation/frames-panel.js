// js/modes/sprites/presentation/frames-panel.js
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { autoAnimationOf, PINNED_HINT, spriteSizeHint } from '../../../domain/sprites/auto-layout.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- tests/architecture.test.mjs bans
// presentation-layer code from importing anything under application/commands/.
function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

function numericField(labelText, value, { step, disabled = false, title = '', onCommit }) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  if (title) label.title = title;
  label.appendChild(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.type = 'number';
  if (step != null) input.step = String(step);
  input.value = String(value);
  input.disabled = disabled;
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => onCommit(Number(input.value)));
  label.appendChild(input);
  return label;
}

function iconButton(text, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-icon-md';
  button.textContent = text;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
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

  function actionsRow(sheet, frame, auto) {
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.append(
      iconButton('✎', 'Edit', () => {
        const host = getEditorHost();
        host.selections.patch({ editingFrameId: frame.id }, sheetDocument(sheet));
        host.store.updateSession({ activeViewId: 'sprites.frame' }, 'view');
      }),
      // contributions.js routes a pinned frame's delete through the layout.
      iconButton('🗑', 'Delete', () => dispatchLayout('sprites.deleteFrame', { sheetId: sheet.id, frameId: frame.id })),
    );
    if (auto) {
      const makeManual = document.createElement('button');
      makeManual.type = 'button';
      makeManual.textContent = 'Make manual';
      makeManual.title = `Stop auto-laying-out "${auto.name}"; its frames stay where they are`;
      makeManual.addEventListener('click', () => dispatch('animations.makeManual', { sheetId: sheet.id, animationId: auto.id }));
      actions.appendChild(makeManual);
    }
    return actions;
  }

  function renderFrameDetail(sheet, frame) {
    const auto = autoAnimationOf(sheet, frame.id);
    const row = document.createElement('div');
    row.className = 'frame-row active';

    const setField = (key, value) => dispatch('sprites.setFrameField', { sheetId: sheet.id, frameId: frame.id, key, value });
    // A pinned frame's pivot is its animation's shared pivot.
    const setPivot = (key, value) => (auto
      ? dispatch('animations.setPivot', {
        sheetId: sheet.id, animationId: auto.id,
        pivotX: key === 'pivotX' ? value : frame.pivotX, pivotY: key === 'pivotY' ? value : frame.pivotY,
      })
      : setField(key, value));

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'frame-name';
    nameInput.value = frame.name;
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (value) setField('name', value);
      else nameInput.value = frame.name;
    });

    const pinned = !!auto;
    // Every frame on a sprite sheet is the sheet's sprite size.
    const sized = !!sheet.spriteSize;
    const sizeTitle = sized ? spriteSizeHint(sheet.spriteSize) : '';
    const fields = document.createElement('div');
    fields.className = 'frame-fields';
    fields.append(
      numericField('X', frame.x, { disabled: pinned, onCommit: value => setField('x', Math.round(value)) }),
      numericField('Y', frame.y, { disabled: pinned, onCommit: value => setField('y', Math.round(value)) }),
      numericField('W', frame.w, { disabled: pinned || sized, title: sizeTitle, onCommit: value => setField('w', Math.max(1, Math.round(value))) }),
      numericField('H', frame.h, { disabled: pinned || sized, title: sizeTitle, onCommit: value => setField('h', Math.max(1, Math.round(value))) }),
      numericField('PivotX', frame.pivotX, { step: 0.5, onCommit: value => setPivot('pivotX', value) }),
      numericField('PivotY', frame.pivotY, { step: 0.5, onCommit: value => setPivot('pivotY', value) }),
    );

    row.append(nameInput, fields);
    if (pinned) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = PINNED_HINT;
      row.appendChild(hint);
    }
    row.appendChild(actionsRow(sheet, frame, auto));
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
    if (!sheet) return;
    const selectedFrameId = getEditorHost().selections.get(sheetDocument(sheet))?.frameId ?? null;
    const frame = sheet.frames.find(candidate => candidate.id === selectedFrameId) ?? null;
    if (!frame) {
      const hint = document.createElement('div');
      hint.className = 'frame-field';
      hint.textContent = 'No frame selected — click one with the frame tool.';
      list.appendChild(hint);
      return;
    }
    renderFrameDetail(sheet, frame);
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
