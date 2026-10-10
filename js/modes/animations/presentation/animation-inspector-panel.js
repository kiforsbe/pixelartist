// js/modes/animations/presentation/animation-inspector-panel.js
// The Animations workbench's Animation panel, below the Animations list:
// the selected animation's name, loop, direction, colour, base duration and
// Auto-layout / Make manual. Layout changes go through dispatchLayout
// (settles a float, explains a refusal); a needsSize refusal (frame pivots
// differ) opens a confirmation to align them at the sprite size.
import { getEditorHost } from '../../../host/runtime.js';
import { activeSheet } from '../../../host/document-helpers.js';
import { dispatchLayout } from '../../../components/layout-dispatch.js';
import { buildBaseDurationControl } from '../../../components/panels/base-duration-control.js';
import { mountStorePanel } from '../../../components/panel-mount.js';
import { dispatch, sheetDocument, textButton, labelled } from './panel-controls.js';

const DIRECTIONS = [['forward', 'Forward'], ['reverse', 'Reverse'], ['pingpong', 'Ping-pong'], ['pingpong-reverse', 'Ping-pong reverse']];
const DEFAULT_TAG_COLOR = '#4f8cff'; // css/app.css --accent, the tag colour when none is set

export function mountAnimationInspectorPanel(el) {
  el.innerHTML = '';
  const heading = document.createElement('h3');
  heading.textContent = 'Animation';

  const host = getEditorHost();
  const sheet = () => activeSheet('sprite');
  const selection = () => { const s = sheet(); return s ? (host.selections.get(sheetDocument(s)) ?? {}) : {}; };
  const selectedAnim = () => sheet()?.animations.find(a => a.id === selection().animationId) ?? null;

  const details = document.createElement('div');
  details.className = 'frame-row active anim-details';
  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'frame-name';
  nameInput.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const v = nameInput.value.trim();
    if (v) dispatch('sprites.renameAnimation', { sheetId: s.id, animationId: anim.id, name: v });
    else nameInput.value = anim.name;
  });
  const loopCheckbox = document.createElement('input');
  loopCheckbox.type = 'checkbox';
  loopCheckbox.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.toggleAnimationLoop', { sheetId: s.id, animationId: anim.id, loop: loopCheckbox.checked });
  });
  const loopLabel = document.createElement('label');
  loopLabel.className = 'timeline-loop';
  loopLabel.title = 'Whether the exported animation loops';
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));
  const nameRow = document.createElement('div');
  nameRow.className = 'row';
  nameRow.append(nameInput, loopLabel);

  // Direction (how playback walks the frames) and tag colour (timeline tag,
  // row thumbnail border). The colour picker cannot show "none", so a null
  // colour shows the accent and marks the picker unset.
  const directionSelect = document.createElement('select');
  directionSelect.title = 'Playback direction';
  for (const [value, text] of DIRECTIONS) {
    const opt = document.createElement('option');
    opt.value = value; opt.textContent = text;
    directionSelect.appendChild(opt);
  }
  directionSelect.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationDirection', { sheetId: s.id, animationId: anim.id, direction: directionSelect.value });
  });
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'anim-color';
  colorInput.title = 'Tag colour';
  colorInput.addEventListener('change', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationColor', { sheetId: s.id, animationId: anim.id, color: colorInput.value.toLowerCase() });
  });
  const btnNoColor = textButton('None', 'Use the default tag colour', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('sprites.setAnimationColor', { sheetId: s.id, animationId: anim.id, color: null });
  });
  const styleRow = document.createElement('div');
  styleRow.className = 'row';
  styleRow.append(labelled('Direction', directionSelect), labelled('Colour', colorInput), btnNoColor);

  const durationControl = buildBaseDurationControl({
    getValue: () => { const a = selectedAnim(); return { durationMs: a?.baseDuration ?? 100, baseFps: a?.baseFps, baseStep: a?.baseStep }; },
    setValue: (after) => {
      const s = sheet(), anim = selectedAnim();
      if (!s || !anim) return;
      const before = { durationMs: anim.baseDuration, baseFps: anim.baseFps, baseStep: anim.baseStep };
      dispatch('sprites.setAnimationBaseDuration', { sheetId: s.id, animationId: anim.id, before, after });
    },
  });

  // ---- Auto-layout / Make manual, and the align confirmation ----
  const layoutRow = document.createElement('div');
  layoutRow.className = 'row';
  const alignForm = document.createElement('div');
  alignForm.className = 'anim-form anim-align-form';
  alignForm.hidden = true;
  const alignText = document.createElement('div');
  alignText.className = 'frame-field';
  let alignSize = null;
  alignForm.append(alignText, textButton('Apply', '', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim || !alignSize) return;
    const result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id, size: alignSize });
    if (result?.ok) alignForm.hidden = true;
  }), textButton('Cancel', '', () => { alignForm.hidden = true; }));

  const btnAutoLayout = textButton('Auto-layout', 'Lay this animation\'s frames out on the sheet automatically', () => {
    const s = sheet(), anim = selectedAnim();
    if (!s || !anim) return;
    const result = dispatchLayout('animations.autoLayout', { sheetId: s.id, animationId: anim.id });
    if (!result?.needsSize) return;
    alignSize = { ...result.suggested };
    alignText.textContent = `Frame pivots differ: align them on one pivot at ${alignSize.w}×${alignSize.h}`;
    alignForm.hidden = false;
  });
  const btnMakeManual = textButton('Make manual', 'Stop auto-laying-out this animation; its frames stay where they are', () => {
    const s = sheet(), anim = selectedAnim();
    if (s && anim) dispatch('animations.makeManual', { sheetId: s.id, animationId: anim.id });
  });
  layoutRow.append(btnAutoLayout, btnMakeManual);

  details.append(nameRow, styleRow, durationControl.el, layoutRow, alignForm);

  const hint = document.createElement('div');
  hint.className = 'frame-field';
  el.append(heading, hint, details);

  let lastAnimationId = null;
  function render() {
    if (host.store.getState().session.activeModeId !== 'animations') { el.hidden = true; return; }
    el.hidden = false;
    const s = sheet();
    const anim = selectedAnim();
    // The align confirmation belongs to the animation it was opened for.
    if ((anim?.id ?? null) !== lastAnimationId) alignForm.hidden = true;
    lastAnimationId = anim?.id ?? null;
    hint.hidden = !!anim;
    hint.textContent = s ? 'Select an animation.' : 'No sprite sheet.';
    details.hidden = !anim;
    if (!anim) return;
    nameInput.value = anim.name;
    loopCheckbox.checked = !!anim.loop;
    directionSelect.value = anim.direction ?? 'forward';
    colorInput.value = anim.color ?? DEFAULT_TAG_COLOR;
    colorInput.classList.toggle('unset', !anim.color);
    btnNoColor.disabled = !anim.color;
    durationControl.refresh();
    const auto = anim.layout === 'auto';
    btnAutoLayout.hidden = auto;
    btnMakeManual.hidden = !auto;
  }

  const panel = mountStorePanel(host.store, [
    s => s.project.model,
    s => s.session.activeModeId,
    s => s.session.activeDocument,
    s => { const doc = s.session.activeDocument; return doc ? s.session.selectionsByDocument[`${doc.kind}:${doc.id}`] : null; },
  ], render);
  const disposeHistory = host.history.subscribe(() => panel.scheduleRender());
  return { ...panel, dispose() { disposeHistory(); panel.dispose(); } };
}
