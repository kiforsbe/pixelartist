// The duration control of one animation entry, shared by the Sprites and
// Animations timelines. An fps-primary animation edits a whole-frame hold
// ("Frames", a step count) with the resulting ms as a caption, never a raw
// ms value -- see the Animation-panel design doc; any other animation edits
// the entry's ms duration. Each change is one dispatched (undoable) command.

import { effectiveDuration } from '../../core/model.js';

function numberInput(value, title, onValue) {
  const input = document.createElement('input');
  input.type = 'number'; input.min = '1';
  if (title) input.title = title;
  input.value = String(value);
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('change', () => {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 1) v = 1;
    input.value = String(v);
    onValue(v);
  });
  return input;
}

// The controls for entry `index` of `anim`, to append into a container.
export function buildFrameDurationInput(sheet, anim, entry, index, dispatch) {
  const target = { sheetId: sheet.id, animationId: anim.id, index };
  if (anim.baseFps != null) {
    const stepInput = numberInput(entry.step ?? anim.baseStep ?? 1, "Frames to hold (overrides the animation's base step)",
      step => dispatch('sprites.setAnimationFrameStep', { ...target, step }));
    const msCaption = document.createElement('span');
    msCaption.className = 'timeline-cell-ms-caption';
    msCaption.textContent = `${effectiveDuration(anim, entry)}ms`;
    return [stepInput, msCaption];
  }
  return [numberInput(effectiveDuration(anim, entry), '',
    duration => dispatch('sprites.setAnimationFrameDuration', { ...target, duration }))];
}
