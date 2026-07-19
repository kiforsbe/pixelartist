// Sidebar panel for the currently-SELECTED ANIMATION (as opposed to
// frames.js's Frames panel, which is scoped to the selected frame/strip's
// geometry). Follows the timeline's selection (state.selectedAnimationId),
// so it stays populated even when the Frames panel shows "no frame
// selected". Mirrors the mount/render-on-emit pattern every other panel
// uses (see frames.js's mountFramesPanel). See
// docs/superpowers/specs/2026-07-19-animation-panel-design.md.
import { state, on, activeSheet, markDirty } from '../app/state.js';
import { renameAnimation } from '../core/model.js';
import { buildBaseDurationControl } from './baseDurationControl.js';

function commitRenameAnim(sheet, anim, name) {
  const before = anim.name;
  if (before === name) return;
  state.commands.push({
    label: 'rename animation',
    do() { renameAnimation(sheet, anim.id, name); },
    undo() { renameAnimation(sheet, anim.id, before); },
  });
  markDirty();
}

function commitToggleLoop(anim, loop) {
  const before = anim.loop;
  if (before === loop) return;
  state.commands.push({
    label: 'toggle animation loop',
    do() { anim.loop = loop; },
    undo() { anim.loop = before; },
  });
  markDirty();
}

function commitBaseDuration(anim, before, after) {
  state.commands.push({
    label: 'edit base duration',
    do() { anim.baseDuration = after.durationMs; anim.baseFps = after.baseFps; anim.baseStep = after.baseStep; },
    undo() { anim.baseDuration = before.durationMs; anim.baseFps = before.baseFps; anim.baseStep = before.baseStep; },
  });
  markDirty();
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
      if (!currentAnim) return;
      const before = { durationMs: currentAnim.baseDuration, baseFps: currentAnim.baseFps, baseStep: currentAnim.baseStep };
      commitBaseDuration(currentAnim, before, after);
    },
  });

  body.append(nameRow, durationControl.el);
  el.append(hint, body);

  nameInput.addEventListener('change', () => {
    const sheet = activeSheet();
    if (!sheet || !currentAnim) return;
    const v = nameInput.value.trim();
    if (v) commitRenameAnim(sheet, currentAnim, v);
    else nameInput.value = currentAnim.name;
  });

  loopCheckbox.addEventListener('change', () => {
    if (!currentAnim) return;
    commitToggleLoop(currentAnim, loopCheckbox.checked);
  });

  function render() {
    if (state.mode !== 'sprites') { el.hidden = true; return; }
    el.hidden = false;
    const sheet = activeSheet();
    currentAnim = sheet?.animations.find(a => a.id === state.selectedAnimationId) ?? null;
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

  on('project', scheduleRender);
  on('history', scheduleRender);
  on('view', scheduleRender);
  on('selection', scheduleRender);
  render();
}
