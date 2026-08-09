// Sidebar panel for the currently-SELECTED ANIMATION (as opposed to
// frames.js's Frames panel, which is scoped to the selected frame/strip's
// geometry). Follows the timeline's selection (via SelectionService),
// so it stays populated even when the Frames panel shows "no frame
// selected". Mirrors the mount/render-on-emit pattern every other panel
// uses (see frames.js's mountFramesPanel). See
// docs/superpowers/specs/2026-07-19-animation-panel-design.md.
import { state, on, activeSheet } from '../../../app/state.js';
import { getEditorHost } from '../../../host/runtime.js';
import { buildBaseDurationControl } from '../../../ui/baseDurationControl.js';

// Dispatches a Command Handler by id (registered in contributions.js) rather
// than importing it directly -- this file lives under presentation/, and
// tests/architecture.test.mjs bans presentation-layer code from importing
// anything under application/commands/.
function dispatch(id, args) {
  return getEditorHost().registries.commands.execute(id, { modeId: state.mode }, args);
}

function sheetDocument(sheet) {
  return { kind: sheet.kind === 'sprite' ? 'sprite-sheet' : 'tile-sheet', id: sheet.id };
}

export function mountAnimationsPanel(el) {
  el.innerHTML = '';
  const h3 = document.createElement('h3');
  h3.textContent = 'Animation';
  el.appendChild(h3);

  const hint = document.createElement('div');
  hint.className = 'frame-field';
  hint.textContent = 'No animation selected — pick one in the timeline.';

  const body = document.createElement('div');
  body.className = 'frame-row active';

  const nameLabel = document.createElement('span');
  nameLabel.textContent = 'Name';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'frame-name';
  nameInput.style.flex = '1';

  const loopLabel = document.createElement('label');
  loopLabel.className = 'timeline-loop';
  loopLabel.title = 'Whether the exported animation loops (see the timeline\'s separate Preview Loop for playback-only looping).';
  const loopCheckbox = document.createElement('input');
  loopCheckbox.type = 'checkbox';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));

  const nameRow = document.createElement('div');
  nameRow.className = 'row';
  nameRow.append(nameLabel, nameInput, loopLabel);

  let currentAnim = null;

  const durationControl = buildBaseDurationControl({
    getValue: () => ({
      durationMs: currentAnim?.baseDuration ?? 100,
      baseFps: currentAnim?.baseFps,
      baseStep: currentAnim?.baseStep,
    }),
    setValue: (after) => {
      const sheet = activeSheet();
      if (!sheet || !currentAnim) return;
      const before = { durationMs: currentAnim.baseDuration, baseFps: currentAnim.baseFps, baseStep: currentAnim.baseStep };
      dispatch('sprites.setAnimationBaseDuration', { sheetId: sheet.id, animationId: currentAnim.id, before, after });
    },
  });

  body.append(nameRow, durationControl.el);
  el.append(hint, body);

  nameInput.addEventListener('change', () => {
    const sheet = activeSheet();
    if (!sheet || !currentAnim) return;
    const v = nameInput.value.trim();
    if (v) dispatch('sprites.renameAnimation', { sheetId: sheet.id, animationId: currentAnim.id, name: v });
    else nameInput.value = currentAnim.name;
  });

  loopCheckbox.addEventListener('change', () => {
    const sheet = activeSheet();
    if (!sheet || !currentAnim) return;
    dispatch('sprites.toggleAnimationLoop', { sheetId: sheet.id, animationId: currentAnim.id, loop: loopCheckbox.checked });
  });

  function render() {
    if (state.mode !== 'sprites') { el.hidden = true; return; }
    el.hidden = false;
    const sheet = activeSheet();
    const animationId = sheet ? (getEditorHost().selections.get(sheetDocument(sheet))?.animationId ?? null) : null;
    currentAnim = sheet?.animations.find(a => a.id === animationId) ?? null;
    hint.hidden = !!currentAnim;
    body.hidden = !currentAnim;
    if (!currentAnim) return;
    nameInput.value = currentAnim.name;
    loopCheckbox.checked = !!currentAnim.loop;
    durationControl.refresh();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(() => { renderQueued = false; render(); });
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
