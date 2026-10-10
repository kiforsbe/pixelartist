// js/modes/animations/presentation/panel-controls.js
// Small DOM builders shared by the Animations workbench's side panels
// (animation-list-panel.js, animation-inspector-panel.js).
import { getEditorHost } from '../../../host/runtime.js';

export function dispatch(id, args) {
  const host = getEditorHost();
  return host.registries.commands.execute(id, { modeId: host.store.getState().session.activeModeId }, args);
}

export function sheetDocument(sheet) { return { kind: 'sprite-sheet', id: sheet.id }; }

export function textButton(text, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  if (title) button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

export function numberInput(title) {
  const input = document.createElement('input');
  input.type = 'number'; input.min = '1'; input.title = title;
  return input;
}

export function labelled(text, input) {
  const label = document.createElement('label');
  label.className = 'frame-field';
  label.append(document.createTextNode(text), input);
  return label;
}
